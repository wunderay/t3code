// @effect-diagnostics-next-line nodeBuiltinImport:off -- a deliverable's digest is SHA-256 over its exact text.
import * as NodeCrypto from "node:crypto";
import { CoordinatorDeliverableChunk, CoordinatorError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { disableOptionalEgress } from "../../optionalEgress.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as Supervisor from "../Supervisor.ts";
import { type CloudDriver, type CloudSubmit, RemoteRun, git, remoteHead } from "./CloudDriver.ts";
import * as ClaudeCloud from "./claudeCloud.ts";
import * as CodexCloud from "./codexCloud.ts";

const DESTINATIONS = { "cloud:codex": "codex-cloud", "cloud:claude": "claude-cloud" } as const;
// Below Linux's 128 KiB limit for one argument, which `claude --cloud` passes the brief as.
const MAX_BRIEF_BYTES = 100_000;
const SECRET =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-ant-[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}|\bAKIA[0-9A-Z]{16}\b|\bxox[abpr]-[A-Za-z0-9-]{10,}/;
// The Guild's deadline for a run; a pushing run's is moved on by each commit instead.
const DEADLINE_MS = 3_600_000;
const STALL_MS = 3 * 3_600_000;
// A due run its cloud still calls running is lost after this long (the Guild's default).
const LOST_MS = 24 * 3_600_000;

export type CloudOutcome =
  | {
      readonly status: "running";
      /** A pushing run's last commit and when it was first seen, if any. */
      readonly head?: string | null;
      readonly movedAt?: number | null;
    }
  | { readonly status: "completed"; readonly head: string }
  | { readonly status: "failed"; readonly reason: string };

export interface CloudSubmitInput extends Omit<CloudSubmit, "branch"> {
  readonly assignmentId: string;
  readonly destination: string;
}

const decodeRun = Schema.decodeUnknownEffect(Schema.Struct({ run: Schema.NullOr(RemoteRun) }));
const decodeReleased = Schema.decodeUnknownEffect(
  Schema.Struct({ items: Schema.Array(Schema.Struct({ why: Schema.String })) }),
);
const decodeProgress = Schema.decodeUnknownEffect(
  Schema.Struct({
    run: RemoteRun,
    progress: Schema.Literals(["moved", "waiting", "ready", "stalled", "revived", "late"]),
  }),
);
const decodeWait = Schema.decodeUnknownEffect(Schema.Struct({ lost: Schema.Boolean }));
const decodeClosed = Schema.decodeUnknownEffect(Schema.Struct({ closed: Schema.Boolean }));
const decodeEnded = Schema.decodeUnknownEffect(Schema.Struct({ ended: Schema.Boolean }));
const Unresolved = Schema.Struct({
  ...RemoteRun.fields,
  why: Schema.String,
  label: Schema.String,
});
const decodeUnresolved = Schema.decodeUnknownEffect(
  Schema.Struct({ items: Schema.Array(Unresolved), recent: Schema.Array(Schema.String) }),
);

export class CloudRuns extends Context.Service<
  CloudRuns,
  {
    readonly supports: (destination: string) => boolean;
    readonly submit: (input: CloudSubmitInput) => Effect.Effect<RemoteRun, CoordinatorError>;
    /** Collects the run once it is due; until then it reports it running. */
    readonly poll: (assignmentId: string) => Effect.Effect<CloudOutcome, CoordinatorError>;
    readonly get: (assignmentId: string) => Effect.Effect<RemoteRun | null, CoordinatorError>;
    /** Neither cloud can be stopped: returns why each run still out keeps running. */
    readonly release: (
      assignmentId: string,
    ) => Effect.Effect<ReadonlyArray<string>, CoordinatorError>;
    /**
     * For the owner only, never a Coordinator tool: runs nothing collects that may still be
     * running, each with why it cannot be stopped.
     */
    readonly unresolved: Effect.Effect<ReadonlyArray<typeof Unresolved.Type>, CoordinatorError>;
    /** For the owner only: they checked the cloud and this lost or unstopped run ended. */
    readonly ended: (input: {
      readonly assignmentId: string;
      readonly id?: number | undefined;
      readonly actor: "user";
    }) => Effect.Effect<boolean, CoordinatorError>;
    readonly patch: (input: {
      readonly assignmentId: string;
      readonly cursor: number;
      readonly limit: number;
      readonly digest?: string | undefined;
    }) => Effect.Effect<typeof CoordinatorDeliverableChunk.Type, CoordinatorError>;
  }
>()("t3/coordinator/cloud/CloudRuns") {}

const invalid = (operation: string) => (cause: unknown) =>
  new CoordinatorError({ operation, reason: "invalid", cause });

export const make = Effect.gen(function* () {
  const supervisor = yield* Supervisor.Supervisor;
  const runner = yield* ProcessRunner.ProcessRunner;
  const egressDisabled = yield* disableOptionalEgress;
  const drivers: Record<RemoteRun["kind"], CloudDriver> = {
    "codex-cloud": yield* CodexCloud.make,
    "claude-cloud": yield* ClaudeCloud.make,
  };
  const lastPoll = new Map<string, number>();
  // One poll at a time, so two passes never collect and push the same run.
  const pollGate = yield* Semaphore.make(1);

  const get = Effect.fn("CloudRuns.get")(function* (assignmentId: string) {
    const reply = yield* supervisor.request("remote.get", { assignmentId });
    return (yield* decodeRun(reply).pipe(Effect.mapError(invalid("cloud-run")))).run;
  });
  const settled = (run: RemoteRun | null): CloudOutcome =>
    run?.state === "collected" && run.head
      ? { status: "completed", head: run.head }
      : { status: "failed", reason: `The cloud run is ${run?.state ?? "missing"}.` };
  /** Ends the out run; if something else ended it first (a cancel), reports what it became. */
  const close = Effect.fn("CloudRuns.close")(function* (
    assignmentId: string,
    state: "collected" | "abandoned" | "lost",
    outcome: CloudOutcome,
  ) {
    const reply = yield* supervisor.request("remote.close", {
      assignmentId,
      state,
      ...(outcome.status === "completed" ? { head: outcome.head } : {}),
    });
    const { closed } = yield* decodeClosed(reply).pipe(Effect.mapError(invalid("cloud-close")));
    lastPoll.delete(assignmentId);
    return closed ? outcome : settled(yield* get(assignmentId));
  });

  const pollUnsafe = Effect.fn("CloudRuns.pollUnsafe")(function* (assignmentId: string) {
    const run = yield* get(assignmentId);
    if (!run) return yield* new CoordinatorError({ operation: "cloud-poll", reason: "invalid" });
    const driver = drivers[run.kind];
    // A pushing run is still read when lost (it may revive) or collected (late commits).
    if (run.state !== "out" && !(["lost", "collected"].includes(run.state) && !driver.status))
      return settled(run);
    if (!run.handle)
      return yield* close(assignmentId, "lost", {
        status: "failed",
        reason:
          "The cloud was called but its answer was never recorded; the run may still be running.",
      });
    const now = yield* Clock.currentTimeMillis;
    if (!driver.status) {
      // An unread head counts as no movement; a stalled run is lost but may still push.
      const head = yield* remoteHead(runner, run.repository, run.branch).pipe(
        Effect.orElseSucceed(() => ""),
      );
      // Finished only when the provider says the session ended; unread counts as not ended.
      const ended = driver.ended
        ? yield* driver.ended(run).pipe(Effect.orElseSucceed(() => false))
        : false;
      const { run: seen, progress } = yield* supervisor
        .request("remote.progress", { assignmentId, head, stallMs: STALL_MS, ended })
        .pipe(Effect.flatMap(decodeProgress), Effect.mapError(invalid("cloud-progress")));
      if (seen.state === "collected") return settled(seen);
      if (progress === "stalled" || seen.state !== "out")
        return {
          status: "failed" as const,
          reason: `The cloud run ${run.handle} pushed nothing for 3 hours; it may still be running.`,
        };
      if (progress !== "ready")
        return { status: "running" as const, head: seen.branchHead, movedAt: seen.movedAt };
      return yield* collect(seen, now);
    }
    // Status is best effort; an unknown one is still out. The result is checked on collection.
    const status = yield* driver.status(run).pipe(Effect.orElseSucceed(() => "out" as const));
    if (status === "failed" || status === "gone")
      return yield* close(assignmentId, "collected", {
        status: "failed",
        reason: `The cloud run ${run.handle} is ${status}.`,
      });
    if (status === "out") {
      if (now < run.deadlineAt) return { status: "running" as const };
      const step = now - (lastPoll.get(assignmentId) ?? now);
      lastPoll.set(assignmentId, now);
      const { lost } = yield* supervisor
        .request("remote.wait", { assignmentId, stepMs: step, boundMs: LOST_MS })
        .pipe(Effect.flatMap(decodeWait), Effect.mapError(invalid("cloud-wait")));
      if (!lost) return { status: "running" as const };
      return yield* close(assignmentId, "lost", {
        status: "failed",
        reason: `The cloud run ${run.handle} was due for a day and never finished; it may still be running.`,
      });
    }
    return yield* collect(run, now);
  });

  const collect = Effect.fn("CloudRuns.collect")(function* (run: RemoteRun, now: number) {
    const assignmentId = run.assignmentId;
    // Unanswered collection is retried, but never past the run's deadline.
    const collected = yield* drivers[run.kind].collect(run).pipe(
      Effect.catch((cause) =>
        now < run.deadlineAt
          ? Effect.fail(cause)
          : Effect.succeed({
              refused: `The cloud run ${run.handle} could not be collected before its deadline.`,
            }),
      ),
    );
    return yield* close(
      assignmentId,
      "collected",
      "refused" in collected
        ? { status: "failed", reason: collected.refused }
        : { status: "completed", head: collected.head },
    );
  });

  return CloudRuns.of({
    supports: (destination) => destination in DESTINATIONS,
    get,
    submit: Effect.fn("CloudRuns.submit")(function* (input) {
      const kind = DESTINATIONS[input.destination as keyof typeof DESTINATIONS];
      if (!kind || egressDisabled)
        return yield* new CoordinatorError({ operation: "cloud-submit", reason: "policy" });
      if (
        new TextEncoder().encode(input.brief).length > MAX_BRIEF_BYTES ||
        SECRET.test(input.brief)
      )
        return yield* new CoordinatorError({ operation: "cloud-brief", reason: "policy" });
      // Reserved before the cloud is called, so a crash never leaves a started run untracked.
      const reserved = yield* supervisor
        .request("remote.reserve", {
          assignmentId: input.assignmentId,
          kind,
          base: input.base,
          repository: input.repository,
          model: input.model,
          effort: input.effort,
          login: input.login,
          deadlineAt:
            (yield* Clock.currentTimeMillis) + (kind === "claude-cloud" ? STALL_MS : DEADLINE_MS),
        })
        .pipe(
          Effect.flatMap(decodeRun),
          Effect.mapError(invalid("cloud-reserve")),
          Effect.flatMap(({ run }) =>
            run ? Effect.succeed(run) : Effect.fail(invalid("cloud-reserve")(undefined)),
          ),
        );
      const abandon = (cause: CoordinatorError) =>
        supervisor
          .request("remote.close", { assignmentId: input.assignmentId, state: "abandoned" })
          .pipe(Effect.andThen(Effect.fail(cause)));
      // The run's result is whatever reaches its branch, so the branch must not exist yet.
      const existing = yield* remoteHead(runner, input.repository, reserved.branch).pipe(
        Effect.catch(abandon),
      );
      if (existing)
        return yield* abandon(
          new CoordinatorError({ operation: "cloud-branch", reason: "policy" }),
        );
      const handle = yield* drivers[kind].submit({ ...input, branch: reserved.branch }).pipe(
        Effect.catch((cause) =>
          // Refused before anything was sent; any other failure may have started a run.
          cause.reason === "invalid"
            ? abandon(cause)
            : supervisor
                .request("remote.close", { assignmentId: input.assignmentId, state: "lost" })
                .pipe(Effect.andThen(Effect.fail(cause))),
        ),
      );
      const { run } = yield* supervisor
        .request("remote.handle", { id: reserved.id, handle })
        .pipe(Effect.flatMap(decodeRun), Effect.mapError(invalid("cloud-handle")));
      if (!run)
        return yield* new CoordinatorError({ operation: "cloud-handle", reason: "invalid" });
      return run;
    }),
    poll: Effect.fn("CloudRuns.poll")((assignmentId: string) =>
      pollGate.withPermits(1)(pollUnsafe(assignmentId)),
    ),
    unresolved: Effect.gen(function* () {
      const list = supervisor
        .request("remote.unresolved", {})
        .pipe(Effect.flatMap(decodeUnresolved), Effect.mapError(invalid("cloud-unresolved")));
      // Look again before listing: a lost run may have revived, a collected one moved on.
      const before = yield* list;
      for (const assignmentId of [
        ...before.items
          .filter((item) => item.state === "lost" && !drivers[item.kind].status)
          .map((item) => item.assignmentId),
        ...before.recent,
      ])
        yield* pollGate.withPermits(1)(pollUnsafe(assignmentId)).pipe(Effect.ignore);
      return (yield* list).items;
    }),
    ended: Effect.fn("CloudRuns.ended")(function* (input) {
      const reply = yield* supervisor.request("remote.ended", input);
      return (yield* decodeEnded(reply).pipe(Effect.mapError(invalid("cloud-ended")))).ended;
    }),
    release: Effect.fn("CloudRuns.release")(function* (assignmentId) {
      const reply = yield* supervisor.request("remote.release", { assignmentId });
      const { items } = yield* decodeReleased(reply).pipe(
        Effect.mapError(invalid("cloud-release")),
      );
      return items.map((item) => item.why);
    }),
    patch: Effect.fn("CloudRuns.patch")(function* (input) {
      const run = yield* get(input.assignmentId);
      if (!run?.head)
        return yield* new CoordinatorError({
          operation: "cloud-deliverable",
          reason: "unavailable",
        });
      const content = yield* git(runner, run.repository, ["diff", run.base, run.head]);
      const digest = NodeCrypto.createHash("sha256").update(content).digest("hex");
      if (
        input.cursor > content.length ||
        (input.cursor > 0 && !input.digest) ||
        (input.digest !== undefined && input.digest !== digest)
      )
        return yield* new CoordinatorError({ operation: "cloud-deliverable", reason: "invalid" });
      // The chunk bound counts UTF-16 units; never split a surrogate pair.
      let end = Math.min(content.length, input.cursor + input.limit);
      if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1] ?? "")) end -= 1;
      return {
        protocolVersion: 1 as const,
        status: "completed" as const,
        executionId: run.handle,
        kind: "patch" as const,
        digest,
        totalCharacters: content.length,
        chunk: content.slice(input.cursor, end),
        nextCursor: end < content.length ? end : null,
        receipt: { executionId: run.handle, status: "completed", head: run.head },
      };
    }),
  });
});

export const layer = Layer.effect(CloudRuns, make);

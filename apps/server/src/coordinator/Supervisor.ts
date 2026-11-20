import {
  CoordinatorAssignment,
  CoordinatorError,
  CoordinatorLabels,
  coordinatorInText,
  DEFAULT_COORDINATOR_LABELS,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
// @effect-diagnostics nodeBuiltinImport:off -- this scoped stdio adapter owns exactly one native child and its three pipes.
import * as NodeChildProcess from "node:child_process";
import * as ServerConfig from "../config.ts";

const Reply = Schema.Struct({
  id: Schema.String,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(
    Schema.Struct({ code: Schema.Union([Schema.String, Schema.Number]), message: Schema.String }),
  ),
});

export const SupervisorSpawn = Context.Reference<
  (
    executable: string,
    args: ReadonlyArray<string>,
    options: NodeChildProcess.SpawnOptionsWithoutStdio,
  ) => NodeChildProcess.ChildProcessWithoutNullStreams
>("t3/coordinator/SupervisorSpawn", {
  defaultValue: () => (executable, args, options) =>
    NodeChildProcess.spawn(executable, [...args], options),
});

export class Supervisor extends Context.Service<
  Supervisor,
  {
    readonly available: boolean;
    readonly request: (method: string, params: unknown) => Effect.Effect<unknown, CoordinatorError>;
    /**
     * Whether the Coordinator is on, its thread and whether it is paused, from the last snapshot
     * any caller read; null before one. Lets ordinary threads skip the store entirely. Before any
     * read it is off when no store was ever made or the last one seen said so (`<database>.enabled`).
     */
    readonly lastSeen?: Effect.Effect<CoordinatorSeen | null>;
    /** The owner is switching it: the store may be read until a snapshot says it is off again. */
    readonly switching?: Effect.Effect<void>;
  }
>()("t3/coordinator/Supervisor") {}

export interface CoordinatorSeen {
  readonly enabled: boolean;
  readonly coordinatorThreadId: string | null;
  readonly paused: boolean;
}
const decodeSeen = Schema.decodeUnknownOption(
  Schema.Struct({
    configuration: Schema.Struct({
      enabled: Schema.Boolean,
      coordinatorPaused: Schema.Boolean,
      coordinatorThreadId: Schema.optional(Schema.NullOr(Schema.String)),
      labels: Schema.optional(CoordinatorLabels),
    }),
    pause: Schema.Struct({ active: Schema.Boolean }),
  }),
);

const decodeAssignmentPage = Schema.decodeUnknownEffect(
  Schema.Struct({
    items: Schema.Array(CoordinatorAssignment),
    nextCursor: Schema.NullOr(Schema.String),
  }),
);

/** Every open assignment, or every one, page by page; the snapshot holds only its first page. */
export const openAssignments = Effect.fn("Coordinator.openAssignments")(function* (
  supervisor: Supervisor["Service"],
  open = true,
) {
  const items: Array<typeof CoordinatorAssignment.Type> = [];
  let cursor: string | null = null;
  do {
    const raw: unknown = yield* supervisor.request("assignments.list", {
      open,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    const page = yield* decodeAssignmentPage(raw).pipe(
      Effect.mapError(
        (cause) => new CoordinatorError({ operation: "assignments", reason: "invalid", cause }),
      ),
    );
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
});

/** The one request that may reach a store that is off: the owner's switch in Settings. */
const SWITCH = "configure";
const offDetail = (labels: typeof CoordinatorLabels.Type) =>
  `${coordinatorInText(labels, true)} is off; switch it on first.`;

const decodeReply = Schema.decodeUnknownEffect(Schema.fromJsonString(Reply));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const make = Effect.gen(function* () {
  const environment = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;
  const serviceScope = yield* Scope.Scope;
  const spawn = yield* SupervisorSpawn;
  const semaphore = yield* Semaphore.make(1);
  const name = platform === "win32" ? "t3-coordinator.exe" : "t3-coordinator";
  const machine = architecture === "arm64" ? "aarch64" : "x86_64";
  const libc = platform === "linux" ? yield* HostProcess.LinuxLibc : "gnu";
  const target =
    platform === "win32"
      ? `${machine}-pc-windows-msvc`
      : platform === "darwin"
        ? `${machine}-apple-darwin`
        : `${machine}-unknown-linux-${libc}`;
  const resources = (process as NodeJS.Process & { readonly resourcesPath?: string }).resourcesPath;
  const override = environment.T3_COORDINATOR_EXECUTABLE;
  const candidates = override
    ? [override]
    : [
        ...(config.resourceMonitorPath
          ? [path.resolve(path.dirname(config.resourceMonitorPath), "../coordinator", name)]
          : []),
        ...(resources ? [path.join(resources, "coordinator", name)] : []),
        path.resolve(import.meta.dirname, "coordinator", name),
        path.resolve(import.meta.dirname, "../coordinator", name),
        path.resolve(import.meta.dirname, "../../coordinator", name),
        ...["../../../../native/coordinator", "../../../native/coordinator"].flatMap((directory) =>
          [path.join("target", target, "release"), "target/release", "target/debug"].map((output) =>
            path.resolve(import.meta.dirname, directory, output, name),
          ),
        ),
      ];
  let executable: string | undefined;
  for (const candidate of candidates) {
    if (
      path.isAbsolute(candidate) &&
      (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false)))
    ) {
      executable = candidate;
      break;
    }
  }
  const database =
    environment.T3_COORDINATOR_DATABASE ?? path.join(config.stateDir, "coordinator.sqlite");
  // A store never made, or last seen off ("0" exactly), is off: nothing need start to learn it.
  // Anything else, a torn marker included, is unknown, and the store is read once.
  const marker = `${database}.enabled`;
  const marked = yield* fs.readFileString(marker).pipe(
    Effect.map((text) => text.trim()),
    Effect.option,
  );
  const made = yield* fs.exists(database).pipe(Effect.orElseSucceed(() => false));
  const off: CoordinatorSeen = { enabled: false, coordinatorThreadId: null, paused: true };
  // The owner's names, as the last snapshot gave them; the shipped ones before any.
  const labels = yield* Ref.make(DEFAULT_COORDINATOR_LABELS);
  const seen = yield* Ref.make<CoordinatorSeen | null>(
    marked._tag === "Some" ? (marked.value === "0" ? off : null) : made ? null : off,
  );
  let written: boolean | undefined =
    marked._tag === "Some" && ["0", "1"].includes(marked.value) ? marked.value === "1" : undefined;
  // Written whole, by rename. One that cannot be is removed, so the next start reads the store.
  const mark = (enabled: boolean) =>
    enabled === written
      ? Effect.void
      : fs.writeFileString(`${marker}.tmp`, enabled ? "1\n" : "0\n").pipe(
          Effect.andThen(fs.rename(`${marker}.tmp`, marker)),
          Effect.tap(() => Effect.sync(() => (written = enabled))),
          Effect.catch((cause) =>
            Effect.logWarning("Coordinator could not note whether it is on", { cause }).pipe(
              Effect.andThen(fs.remove(marker, { force: true })),
              Effect.ignore,
              Effect.tap(() => Effect.sync(() => (written = undefined))),
            ),
          ),
        );
  const normalize = (value: string) =>
    platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  const available =
    executable !== undefined &&
    path.isAbsolute(database) &&
    normalize(database) !== normalize(config.dbPath);
  let child: NodeChildProcess.ChildProcessWithoutNullStreams | undefined;
  let closed = false;
  // Children lost in a row; the next one starts no sooner than 1 s doubling to 1 min after the last.
  let losses = 0;
  let spawnedAt = 0;
  const lose = (lost: NodeChildProcess.ChildProcessWithoutNullStreams) => {
    if (child !== lost) return;
    child = undefined;
    losses++;
    if (lost.exitCode === null) lost.kill();
  };
  let sequence = 0;
  // Ends the store process without counting it lost; the next request starts another.
  const end = () => {
    const ended = child;
    child = undefined;
    ended?.stdin.end();
    if (ended && ended.exitCode === null) ended.kill();
  };
  yield* Scope.addFinalizer(
    serviceScope,
    Effect.sync(() => {
      closed = true;
      end();
    }),
  );
  const request = Effect.fn("Coordinator.Supervisor.request")(function* (
    method: string,
    params: unknown,
  ) {
    if (!available || !executable || closed)
      return yield* new CoordinatorError({ operation: method, reason: "unavailable" });
    if (!child) {
      const now = yield* Clock.currentTimeMillis;
      if (losses > 0 && now < spawnedAt + Math.min(1_000 * 2 ** (losses - 1), 60_000))
        return yield* new CoordinatorError({ operation: method, reason: "unavailable" });
      spawnedAt = now;
      yield* fs
        .makeDirectory(path.dirname(database), { recursive: true })
        .pipe(
          Effect.mapError(
            (cause) => new CoordinatorError({ operation: method, reason: "transport", cause }),
          ),
        );
      const spawned = yield* Effect.try({
        try: () =>
          spawn(executable!, ["--database", database], {
            env: environment,
            cwd: config.stateDir,
            windowsHide: true,
            shell: false,
          }),
        catch: (cause) => {
          losses++;
          return new CoordinatorError({ operation: method, reason: "transport", cause });
        },
      });
      child = spawned;
      spawned.once("exit", () => lose(spawned));
      // Diagnostics never reach clients or accumulate in memory. No inherited FDs or global process signals.
      spawned.stderr.resume();
      spawned.on("error", () => lose(spawned));
      spawned.stdin.on("error", () => lose(spawned));
      spawned.stdout.on("error", () => lose(spawned));
    }
    const processChild = child;
    const id = `t3-${++sequence}`;
    const encoded = yield* encodeJson({ id, protocolVersion: 1, method, params }).pipe(
      Effect.mapError(
        (cause) => new CoordinatorError({ operation: method, reason: "invalid", cause }),
      ),
    );
    const raw = yield* Effect.callback<string, CoordinatorError>((resume) => {
      const chunks: Array<Buffer> = [];
      let bytes = 0;
      let done = false;
      const finish = (result: Effect.Effect<string, CoordinatorError>) => {
        if (done) return;
        done = true;
        processChild.stdout.off("data", onData);
        processChild.off("exit", onExit);
        processChild.off("error", onError);
        resume(result);
      };
      const onExit = () =>
        finish(Effect.fail(new CoordinatorError({ operation: method, reason: "transport" })));
      const onError = (cause: unknown) =>
        finish(
          Effect.fail(new CoordinatorError({ operation: method, reason: "transport", cause })),
        );
      const onData = (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1_048_576) {
          lose(processChild);
          finish(Effect.fail(new CoordinatorError({ operation: method, reason: "transport" })));
          return;
        }
        const end = chunk.indexOf(10);
        if (end !== -1) {
          if (end !== chunk.length - 1) {
            lose(processChild);
            finish(Effect.fail(new CoordinatorError({ operation: method, reason: "transport" })));
            return;
          }
          chunks.push(chunk.subarray(0, end));
          finish(Effect.succeed(Buffer.concat(chunks).toString("utf8")));
        } else chunks.push(chunk);
      };
      processChild.stdout.on("data", onData);
      processChild.once("exit", onExit);
      processChild.once("error", onError);
      processChild.stdin.write(`${encoded}\n`, (cause) => {
        if (cause) onError(cause);
      });
      return Effect.sync(() => {
        done = true;
        processChild.stdout.off("data", onData);
        processChild.off("exit", onExit);
        processChild.off("error", onError);
      });
    }).pipe(
      Effect.timeoutOption("15 seconds"),
      Effect.flatMap((result) =>
        result._tag === "Some"
          ? Effect.succeed(result.value)
          : Effect.sync(() => lose(processChild)).pipe(
              Effect.andThen(
                Effect.fail(new CoordinatorError({ operation: method, reason: "transport" })),
              ),
            ),
      ),
    );
    const reply = yield* decodeReply(raw).pipe(
      Effect.mapError(
        (cause) => new CoordinatorError({ operation: method, reason: "transport", cause }),
      ),
    );
    if (reply.id === id) losses = 0;
    if (reply.id !== id || reply.error)
      return yield* new CoordinatorError({
        operation: method,
        reason: reply.error ? "policy" : "transport",
        // Kept so a caller can tell a missing record from a refusal.
        ...(reply.error ? { cause: reply.error } : {}),
      });
    return reply.result;
  });
  return Supervisor.of({
    available,
    // One at a time, gate and all: what each answer says about the switch is noted in the order
    // the requests were sent, so an older answer never overrides a newer switch.
    request: Effect.fn("Supervisor.request")((method, params) =>
      semaphore.withPermits(1)(
        Effect.gen(function* () {
          if (method === SWITCH) yield* Ref.set(seen, null);
          // Off, only the switch reaches the store: nothing else starts it or is sent.
          else if ((yield* Ref.get(seen))?.enabled === false)
            return yield* new CoordinatorError({
              operation: method,
              reason: "policy",
              detail: offDetail(yield* Ref.get(labels)),
            });
          const result = yield* request(method, params);
          // The switch answers with the snapshot it leaves, as a snapshot does.
          const found = method === "snapshot" || method === SWITCH ? decodeSeen(result) : undefined;
          if (found?._tag === "Some") {
            const { configuration, pause } = found.value;
            if (configuration.labels) yield* Ref.set(labels, configuration.labels);
            yield* Ref.set(seen, {
              enabled: configuration.enabled,
              coordinatorThreadId: configuration.coordinatorThreadId ?? null,
              paused: !configuration.enabled || configuration.coordinatorPaused || pause.active,
            });
            yield* mark(configuration.enabled);
            // Off in a running server is as off after a restart: no store process stays.
            if (!configuration.enabled) end();
          }
          return result;
        }),
      ),
    ),
    lastSeen: Ref.get(seen),
    switching: semaphore.withPermits(1)(Ref.set(seen, null)),
  });
});
export const layer = Layer.effect(Supervisor, make);

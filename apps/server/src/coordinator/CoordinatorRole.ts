import {
  CoordinatorCard,
  CoordinatorError,
  CoordinatorGoal,
  CoordinatorInboxPage,
  type CoordinatorPlanInput,
  type CoordinatorPlanResult,
  CoordinatorSnapshot,
  type CoordinatorStatusPage,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Supervisor from "./Supervisor.ts";

export interface CoordinatorRoleState {
  readonly enabled: boolean;
  readonly coordinatorThreadId: string | null;
  /** Off, paused by the owner, or all work paused: the role changes nothing and is not woken. */
  readonly paused: boolean;
  readonly ceiling: RuntimeMode;
  /** Ids active goals are scoped to: thread, card, project or environment. */
  readonly scope: ReadonlySet<string>;
  /** The owner's setting: may it change threads it did not start. */
  readonly manageOthers: boolean;
}

export class CoordinatorRole extends Context.Service<
  CoordinatorRole,
  {
    readonly state: Effect.Effect<CoordinatorRoleState, CoordinatorError>;
    /** The Coordinator thread the store last named, for when it cannot be read. */
    readonly lastKnownThreadId: Effect.Effect<string | null>;
    /**
     * Whether the thread holds the role and the Coordinator is paused, from what was last read:
     * an ordinary thread, or any thread while the Coordinator is off, costs no store call.
     */
    readonly holds: (
      threadId: ThreadId,
    ) => Effect.Effect<{ readonly holds: boolean; readonly paused: boolean }, CoordinatorError>;
    /** Whether one of its assignments runs in the thread. */
    readonly started: (threadId: ThreadId) => Effect.Effect<boolean, CoordinatorError>;
    /** Records the latest user message the Coordinator saw when it read a thread, in epoch ms. */
    readonly markRead: (threadId: ThreadId, userWroteAt: number) => Effect.Effect<void>;
    readonly lastRead: (threadId: ThreadId) => Effect.Effect<number>;
    readonly status: (
      cursor: number,
    ) => Effect.Effect<typeof CoordinatorStatusPage.Type, CoordinatorError>;
    /**
     * The inbox's events since `cursor`, or without one since what completed turns read and this
     * `turn` read so far. `completed` says whether an earlier turn of the thread completed.
     */
    readonly inbox: (
      cursor: number | undefined,
      turn?: {
        readonly runId: string;
        readonly completed: (runId: string) => Effect.Effect<boolean>;
      },
    ) => Effect.Effect<typeof CoordinatorInboxPage.Type, CoordinatorError>;
    readonly plan: (
      goals: (typeof CoordinatorPlanInput.Type)["goals"],
    ) => Effect.Effect<typeof CoordinatorPlanResult.Type, CoordinatorError>;
    readonly notes: (notes: string) => Effect.Effect<void, CoordinatorError>;
    /** A line the owner sees among the Coordinator's decisions. */
    readonly record: (decision: {
      readonly id: string;
      readonly summary: string;
      readonly provenance: string;
    }) => Effect.Effect<void, CoordinatorError>;
  }
>()("t3/coordinator/CoordinatorRole") {}

const roleState = (
  snapshot: CoordinatorSnapshot,
  goals: ReadonlyArray<CoordinatorGoal>,
): CoordinatorRoleState => ({
  enabled: snapshot.configuration.enabled,
  coordinatorThreadId: snapshot.configuration.coordinatorThreadId ?? null,
  paused:
    !snapshot.configuration.enabled ||
    snapshot.configuration.coordinatorPaused ||
    snapshot.pause.active,
  ceiling: snapshot.configuration.managedCeiling ?? "auto-accept-edits",
  scope: new Set(
    goals
      .filter((goal) => goal.status !== "completed" && goal.status !== "cancelled")
      .flatMap((goal) => goal.authorizedScope ?? []),
  ),
  manageOthers: snapshot.configuration.manageOtherThreads === true,
});

/** The sessions of the Coordinator's thread carry the role while it is enabled. */
export const holdsRole = (state: CoordinatorRoleState, threadId: ThreadId) =>
  state.enabled && state.coordinatorThreadId === threadId;

const decodeSnapshot = Schema.decodeUnknownEffect(CoordinatorSnapshot);
const isCoordinatorError = Schema.is(CoordinatorError);
const decodeSavedGoal = Schema.decodeUnknownEffect(Schema.Struct({ goal: CoordinatorGoal }));
const decodeGoalPage = Schema.decodeUnknownEffect(
  Schema.Struct({ items: Schema.Array(CoordinatorGoal), nextCursor: Schema.NullOr(Schema.String) }),
);
const decodeCard = Schema.decodeUnknownEffect(Schema.Struct({ card: CoordinatorCard }));
const decodeInbox = Schema.decodeUnknownEffect(CoordinatorInboxPage);
const decodePosition = Schema.decodeUnknownEffect(
  Schema.Struct({ runId: Schema.NullOr(Schema.String) }),
);
const decodeCounts = Schema.decodeUnknownEffect(
  Schema.Struct({ counts: Schema.optional(Schema.Struct({ cards: Schema.Number })) }),
);
// The store's code for a record that does not exist.
const NOT_FOUND = -32004;
const isNotFound = (error: CoordinatorError) =>
  typeof error.cause === "object" &&
  error.cause !== null &&
  "code" in error.cause &&
  error.cause.code === NOT_FOUND;
type CoordinatorGoal = typeof CoordinatorGoal.Type;
interface GoalPage {
  readonly items: ReadonlyArray<CoordinatorGoal>;
  readonly nextCursor: string | null;
}
const PAGE = 20;
const REASON_CHARS = 500;
const RECORD_KEPT_MS = 7 * 24 * 60 * 60_000;

// Where the host records why it blocked a goal: a review's outcome, or the repair allowance.
const BLOCKING = ["review-blocked", "repair-limit", "repair-lineage"];
const blockedGoals = (
  goals: ReadonlyArray<CoordinatorGoal>,
  decisions: NonNullable<CoordinatorSnapshot["decisions"]> = [],
) =>
  goals
    .filter((goal) => goal.status === "blocked")
    .map((goal) => ({
      id: goal.id,
      // The host's latest reason for blocking it; never its purpose, which says nothing of why.
      reason: (
        decisions
          .filter((decision) => BLOCKING.some((marker) => decision.id === `${marker}:${goal.id}`))
          .toSorted((left, right) => (right.revision ?? 0) - (left.revision ?? 0))[0]?.summary ??
        goal.evidence?.at(-1) ??
        "Blocked; the host recorded no reason."
      ).slice(0, REASON_CHARS),
      revision: goal.revision ?? 0,
    }));

const make = Effect.gen(function* () {
  const supervisor = yield* Supervisor.Supervisor;
  // Lost on restart, which only asks the Coordinator to read a thread again.
  const reads = yield* Ref.make<ReadonlyMap<ThreadId, number>>(new Map());
  const lastKnown = yield* Ref.make<string | null>(null);
  const request = (operation: string, method: string, params: unknown) =>
    supervisor.available
      ? supervisor.request(method, params)
      : Effect.fail(new CoordinatorError({ operation, reason: "unavailable" }));
  const raw = request("role", "snapshot", { limit: 100 });
  const snapshot = raw.pipe(
    Effect.flatMap(decodeSnapshot),
    Effect.mapError((cause) =>
      cause._tag === "CoordinatorError"
        ? cause
        : new CoordinatorError({ operation: "role", reason: "invalid", cause }),
    ),
    Effect.tap((current) => Ref.set(lastKnown, current.configuration.coordinatorThreadId ?? null)),
  );
  // The snapshot holds one page of goals; scope and what is blocked need every one.
  const allGoals = Effect.gen(function* () {
    const goals: Array<CoordinatorGoal> = [];
    let cursor: string | null = null;
    do {
      const page: GoalPage = yield* request("role", "goals.list", {
        limit: 100,
        ...(cursor === null ? {} : { cursor }),
      }).pipe(
        Effect.flatMap(decodeGoalPage),
        Effect.mapError((cause) =>
          isCoordinatorError(cause)
            ? cause
            : new CoordinatorError({ operation: "role", reason: "invalid", cause }),
        ),
      );
      goals.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return goals;
  });
  const current = Effect.all({ snapshot, goals: allGoals });
  // Learns the Coordinator's thread before the store can first fail to answer; off, there is none.
  const seen = supervisor.lastSeen ? yield* supervisor.lastSeen : null;
  if (seen?.enabled !== false) yield* snapshot.pipe(Effect.ignore);
  const invalid = (operation: string) => (cause: unknown) =>
    isCoordinatorError(cause)
      ? cause
      : new CoordinatorError({ operation, reason: "invalid", cause });
  return CoordinatorRole.of({
    state: Effect.map(current, ({ snapshot, goals }) => roleState(snapshot, goals)),
    lastKnownThreadId: Ref.get(lastKnown),
    holds: Effect.fn("CoordinatorRole.holds")(function* (threadId) {
      const seen = supervisor.lastSeen ? yield* supervisor.lastSeen : null;
      if (seen)
        return {
          holds: seen.enabled && seen.coordinatorThreadId === threadId,
          paused: seen.paused,
        };
      // Before any snapshot is read: only the thread Settings made can be the Coordinator's.
      if (!threadId.startsWith("coordinator-lead:")) return { holds: false, paused: false };
      const state = yield* Effect.map(current, ({ snapshot, goals }) => roleState(snapshot, goals));
      return { holds: holdsRole(state, threadId), paused: state.paused };
    }),
    started: Effect.fn("CoordinatorRole.started")(function* (threadId) {
      return yield* request("role", "cards.find", { threadId }).pipe(
        Effect.flatMap(decodeCard),
        Effect.map(({ card }) => card.assignmentId !== null),
        Effect.catchIf(
          (cause) => isCoordinatorError(cause) && isNotFound(cause),
          () => Effect.succeed(false),
        ),
        Effect.mapError(invalid("role")),
      );
    }),
    status: Effect.fn("CoordinatorRole.status")(function* (cursor) {
      const { snapshot: latest, goals } = yield* current;
      const counts = yield* raw.pipe(
        Effect.flatMap(decodeCounts),
        Effect.mapError(invalid("status")),
      );
      const assignments = yield* Supervisor.openAssignments(supervisor).pipe(
        Effect.mapError(invalid("status")),
      );
      const blocked = [
        ...blockedGoals(goals, latest.decisions).map(({ id, reason }) => ({
          kind: "goal" as const,
          id,
          reason,
        })),
        // Work held in its thread, as its card and its result check say why.
        ...assignments
          .filter((assignment) => assignment.status === "blocked")
          .map((assignment) => {
            const card = latest.cards.find((item) => item.id === assignment.cardId);
            const check = latest.resultChecks?.find((item) => item.assignmentId === assignment.id);
            return {
              kind: "assignment" as const,
              id: assignment.id,
              reason:
                `${card ? `Thread ${card.threadId}: ` : ""}${card?.blocker ?? (check && !check.passed ? `its result is held for the owner: ${check.blocking.join("; ")}` : "held for the owner; its thread's end says why")}`.slice(
                  0,
                  REASON_CHARS,
                ),
            };
          }),
        ...(latest.routingWaits ?? []).map((wait) => ({
          kind: "routing" as const,
          id: wait.id,
          reason: wait.reason.slice(0, REASON_CHARS),
        })),
      ];
      // Answering proves the instance and model gave the Coordinator's thread its tools.
      const { coordinatorProvider: provider, coordinatorModel: model } = latest.configuration;
      if (!latest.configuration.threadProof?.proved && provider && model)
        yield* request("status", "proof.record", { provider, model, proved: true }).pipe(
          Effect.ignore,
        );
      return {
        paused: roleState(latest, goals).paused,
        counts: {
          goals: goals.length,
          threads: counts.counts?.cards ?? latest.cards.length,
          assignments: assignments.length,
          permissionRequests: latest.permissionRequests?.length ?? 0,
          blocked: blocked.length,
        },
        blocked: blocked.slice(cursor, cursor + PAGE),
        nextCursor: cursor + PAGE < blocked.length ? cursor + PAGE : null,
        // In the store, not the transcript, so a compaction never loses them.
        ...(latest.guidance
          ? {
              instructions: {
                customPrompt: latest.guidance.customPrompt,
                memory: latest.guidance.memory,
                notes: latest.guidance.coordinatorNotes ?? "",
              },
            }
          : {}),
        grants: latest.grants ?? [],
      };
    }),
    inbox: Effect.fn("CoordinatorRole.inbox")(function* (cursor, turn) {
      if (turn) {
        const { runId } = yield* request("inbox", "events.position", {}).pipe(
          Effect.flatMap(decodePosition),
          Effect.mapError(invalid("inbox")),
        );
        // An earlier turn's reads count once it completed, however the host learns of it first.
        if (runId && runId !== turn.runId && (yield* turn.completed(runId)))
          yield* request("inbox", "events.confirm", { runId });
      }
      return yield* request("inbox", "events.read", {
        ...(cursor === undefined ? {} : { cursor }),
        ...(turn ? { runId: turn.runId } : {}),
        limit: PAGE,
      }).pipe(Effect.flatMap(decodeInbox), Effect.mapError(invalid("inbox")));
    }),
    plan: Effect.fn("CoordinatorRole.plan")(
      function* (goals) {
        const saved: Array<(typeof CoordinatorPlanResult.Type)["goals"][number]> = [];
        for (const goal of goals) {
          // Only a goal the store does not have is new; any other error stops the plan, so a
          // failed read can never save over a goal without its revision.
          const stored = yield* request("plan", "goals.get", { id: goal.id }).pipe(
            Effect.flatMap(decodeSavedGoal),
            Effect.map(({ goal }): CoordinatorGoal | undefined => goal),
            Effect.catchIf(
              (cause) => isCoordinatorError(cause) && isNotFound(cause),
              () => Effect.undefined,
            ),
          );
          const next = {
            ...stored,
            id: goal.id,
            purpose: goal.purpose,
            priority: goal.priority ?? stored?.priority,
            dependencies: goal.dependencies ?? stored?.dependencies,
            touches: goal.touches ?? stored?.touches,
            // Criteria the owner or a review set stay; the plan only fills missing ones.
            acceptanceCriteria: stored?.acceptanceCriteria?.length
              ? stored.acceptanceCriteria
              : goal.acceptanceCriteria,
            // Scope is the owner's to give, so a planned goal reaches only what it reached.
            authorizedScope: stored?.authorizedScope ?? [],
          };
          const result = yield* request("plan", "goals.upsert", {
            goal: next,
            actor: "coordinator",
          }).pipe(Effect.flatMap(decodeSavedGoal));
          saved.push({
            id: result.goal.id,
            revision: result.goal.revision ?? 0,
            authorizedScope: result.goal.authorizedScope ?? [],
          });
        }
        return { goals: saved };
      },
      Effect.mapError(invalid("plan")),
    ),
    notes: Effect.fn("CoordinatorRole.notes")(function* (notes) {
      const latest = yield* snapshot;
      const threadId = latest.configuration.coordinatorThreadId;
      if (!latest.guidance || !threadId)
        return yield* new CoordinatorError({ operation: "notes", reason: "unavailable" });
      yield* request("notes", "guidance.notes.save", {
        threadId,
        coordinatorNotes: notes,
        expectedGuidanceRevision: latest.guidance.revision,
      });
    }),
    record: Effect.fn("CoordinatorRole.record")(function* (decision) {
      yield* request("record", "decisions.record", {
        decision: {
          ...decision,
          // The store keeps at most 2,000 characters of a summary.
          summary: Array.from(decision.summary).slice(0, 2_000).join(""),
          cardIds: [],
          goalIds: [],
          expiresAt: (yield* Clock.currentTimeMillis) + RECORD_KEPT_MS,
        },
      });
    }),
    // Per call and in memory, so a span each would cost more than the work.
    markRead: Effect.fnUntraced(function* (threadId, userWroteAt) {
      yield* Ref.update(reads, (seen) =>
        new Map(seen).set(threadId, Math.max(seen.get(threadId) ?? 0, userWroteAt)),
      );
    }),
    lastRead: Effect.fnUntraced(function* (threadId) {
      return (yield* Ref.get(reads)).get(threadId) ?? 0;
    }),
  });
});

export const layerWithoutDependencies = Layer.effect(CoordinatorRole, make);
export const layer = layerWithoutDependencies.pipe(Layer.provide(Supervisor.layer));

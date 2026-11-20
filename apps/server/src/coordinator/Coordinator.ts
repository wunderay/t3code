import { automaticSettlementBlocker } from "./settlement.ts";
import { runtimeModeForGrant } from "./grants.ts";
import { resolvedApprovalBounds, statesOperation } from "./approvalRequest.ts";
import { completedMilestoneMarker } from "./progress.ts";
import { deliverableBlocker } from "./deliverable.ts";
import {
  RESERVATION_MS,
  allowances,
  familyOf,
  holdReason,
  largestThreadMemory,
  machineSlots,
  outcomeRound,
  ownedBy,
  parseBench,
  routeCandidates,
  routeEffort,
  trackBlocked,
  turnTokens,
  workTimes,
} from "./route.ts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- synchronous SHA-256 over bounded in-memory canonical evidence; shared with pure milestone/evidence validation.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import { type ReviewReport, reviewBlocker, reviewRejected, reviewReport } from "./review.ts";
import {
  CommandId,
  EnvironmentId,
  CoordinatorBoard,
  CoordinatorError,
  coordinatorInText,
  coordinatorName,
  CoordinatorDeliverableRead,
  CoordinatorDeliverableChunk,
  CoordinatorSnapshot,
  CoordinatorGrant,
  describeCoordinatorGrant,
  CoordinatorCard,
  CoordinatorRouteSelection,
  CoordinatorAssignment,
  CoordinatorAction,
  CoordinatorConfiguration,
  CoordinatorGoal,
  CoordinatorPolicyPreview,
  DEFAULT_COORDINATOR_LABELS,
  type CoordinatorApprovalInput,
  type CoordinatorCommand,
  type OrchestrationV2ThreadShell,
  CoordinatorDelegateAction,
  MessageId,
  ProjectId,
  ClaudeSettings,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  ProviderRequestKind,
  isProviderAvailable,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Equal from "effect/Equal";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import { resolveUserOverride, userOverrideParameters } from "./userOverrides.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import { ProjectToolkit } from "../mcp/toolkits/project/tools.ts";
import { OrchestratorToolkit } from "../mcp/toolkits/orchestrator/tools.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Projects from "../project/ProjectService.ts";
import * as CloudRuns from "./cloud/CloudRuns.ts";
import * as Merges from "./Merges.ts";
import * as CloudDriver from "./cloud/CloudDriver.ts";
import * as ProcessRunner from "../processRunner.ts";
import { WORKSPACE_GIT_HARDENED_CONFIG_ARGS } from "../vcs/GitVcsDriver.ts";
import { explicitBareRepositoryEnv } from "../vcs/VcsProcess.ts";
import {
  quoted,
  threadState,
  unsettled,
  wakeText,
  type DigestThread,
  type MergeFacts,
} from "./wake.ts";
import { cloudBlocker } from "./cloud/dispatch.ts";
import { FLEET_RESULTS_FILE, passedModels } from "./fleetResults.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import * as Supervisor from "./Supervisor.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerConfig from "../config.ts";
import * as UsageService from "../usage/UsageService.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as ResourceTelemetry from "../resourceTelemetry/ResourceTelemetry.ts";

const unavailable: CoordinatorSnapshot = {
  protocolVersion: 1,
  revision: 0,
  configuration: {
    enabled: false,
    coordinatorPaused: false,
    permissionMode: "ask",
    placement: "automatic",
    coordinatorTitle: null,
    coordinatorProvider: null,
    coordinatorModel: null,
    labels: DEFAULT_COORDINATOR_LABELS,
  },
  pause: { active: false, revision: 0, label: "Pause all" },
  cards: [],
  goals: [],
  pendingActions: [],
  catalog: [],
  overrides: [],
  permissions: [],
  assignments: [],
  availability: {
    available: false,
    reason: "Configure an absolute T3_COORDINATOR_EXECUTABLE path to the packaged Rust supervisor.",
  },
};

function cardStatus(status: string): string {
  if (["preparing", "starting"].includes(status)) return "submitted";
  if (status === "waiting") return "blocked";
  if (["interrupted", "rolled_back"].includes(status)) return "paused";
  return [
    "idle",
    "queued",
    "submitted",
    "running",
    "blocked",
    "completed",
    "verified",
    "failed",
    "cancelled",
    "paused",
    "pausing",
    "unreachable",
  ].includes(status)
    ? status
    : "unknown";
}

export class Coordinator extends Context.Service<
  Coordinator,
  {
    readonly get: Effect.Effect<CoordinatorSnapshot, CoordinatorError>;
    readonly command: (
      input: CoordinatorCommand,
    ) => Effect.Effect<CoordinatorSnapshot, CoordinatorError>;
    readonly deliverable?: (
      scope: McpInvocationScope,
      input: typeof CoordinatorDeliverableRead.Type,
    ) => Effect.Effect<typeof CoordinatorDeliverableChunk.Type, CoordinatorError>;
    /** One delegation by the Coordinator's thread, through the host's checks. */
    readonly delegate?: (
      action: CoordinatorDelegateAction,
    ) => Effect.Effect<CoordinatorSnapshot, CoordinatorError>;
    /** A grant the owner asked for in a message they typed in the Coordinator's thread. */
    readonly grantFromMessage: (input: {
      readonly messageId: string;
      readonly grant: CoordinatorGrant;
    }) => Effect.Effect<
      {
        readonly snapshot: CoordinatorSnapshot;
        /** Not made: what the owner would have to confirm with `grant.set`, and why. */
        readonly proposal?: { readonly grant: CoordinatorGrant; readonly reason: string };
      },
      CoordinatorError
    >;
    /** The Coordinator's model answers an approval the rules left to it, or passes it to the owner. */
    readonly answerApproval?: (
      input: typeof CoordinatorApprovalInput.Type,
    ) => Effect.Effect<CoordinatorSnapshot, CoordinatorError>;
    readonly changes: Stream.Stream<CoordinatorSnapshot, CoordinatorError>;
    /** Read only while the owner's dashboard or settings show it. */
    readonly board: Effect.Effect<CoordinatorBoard, CoordinatorError>;
    readonly start: Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/coordinator/Coordinator") {}

const RoutingIntent = Schema.Struct({
  id: Schema.String,
  goalId: Schema.String,
  cardId: Schema.String,
  intent: Schema.Unknown,
  generation: Schema.Number,
  reservationKey: Schema.optional(Schema.String),
  pauseRevision: Schema.Number,
  grantRevision: Schema.Number,
  instructionRevision: Schema.Number,
});
const decodeRoutingIntent = Schema.decodeUnknownEffect(
  Schema.Struct({ routingIntent: RoutingIntent, claimed: Schema.optional(Schema.Boolean) }),
);
const decodeRoutingReady = Schema.decodeUnknownEffect(
  Schema.Struct({ items: Schema.Array(RoutingIntent) }),
);
const decodeDelegateAction = Schema.decodeUnknownEffect(CoordinatorDelegateAction);
const decodeSettlementAction = Schema.decodeUnknownEffect(
  Schema.Struct({
    goalId: Schema.NullOr(Schema.String),
    // Work that ended without being done: cancelled, replaced or left by a cancelled goal.
    ended: Schema.optional(Schema.String),
    assignmentId: Schema.String,
    cardId: Schema.String,
    expectedRunId: Schema.NullOr(Schema.String),
    cloud: Schema.Boolean,
  }),
);
const decodeSnapshot = Schema.decodeUnknownEffect(CoordinatorSnapshot);
const decodeOwnerBoard = Schema.decodeUnknownEffect(CoordinatorBoard);
/** The board of a Coordinator that is off: nothing set, nothing running. */
const EMPTY_BOARD: CoordinatorBoard = {
  cards: [],
  assignments: [],
  goals: [],
  weights: { use: 1, time: 1 },
  limits: { inFlight: null, perLogin: null, localSlots: null },
  budgets: [],
  today: [],
  dayStartedAt: 0,
  now: 0,
  spend: [],
  costs: [],
  merges: [],
  merged: [],
  reverted: [],
  kept: [],
  runs: [],
  unresolved: [],
  settled: 0,
};
const decodeGrant = Schema.decodeUnknownEffect(
  Schema.Struct({ grant: Schema.NullOr(CoordinatorGrant) }),
);
const decodeResultCheck = Schema.decodeUnknownEffect(
  Schema.Struct({
    resultCheck: Schema.Struct({
      passed: Schema.Boolean,
      base: Schema.String,
      head: Schema.String,
      blocking: Schema.optional(Schema.Array(Schema.String)),
    }),
  }),
);
const decodeClean = Schema.decodeUnknownEffect(Schema.Struct({ clean: Schema.Boolean }));
const decodeKeptNote = Schema.decodeUnknownEffect(
  Schema.Struct({
    decision: Schema.NullOr(
      Schema.Struct({
        summary: Schema.String,
        provenance: Schema.String,
        expiresAt: Schema.optional(Schema.NullOr(Schema.Number)),
        cardIds: Schema.optional(Schema.Array(Schema.String)),
        goalIds: Schema.optional(Schema.Array(Schema.String)),
      }),
    ),
  }),
);
const decodeHeld = Schema.decodeUnknownEffect(Schema.Struct({ held: Schema.Array(Schema.String) }));
/**
 * A thread's request as the store names it. The store keeps an identifier to 256 characters and a
 * provider's request id can be longer, so a long one goes by its digest; the id itself stays
 * beside it as data.
 */
export const storedRequestId = (id: string) =>
  id.length <= 128 ? id : `sha256:${NodeCrypto.createHash("sha256").update(id).digest("hex")}`;
/** Why the store refused, in its own words where it gave any. */
const refusal = (cause: CoordinatorError) => {
  const reply: unknown = cause.cause;
  return typeof reply === "object" &&
    reply !== null &&
    "message" in reply &&
    typeof reply.message === "string"
    ? reply.message
    : cause.message;
};
/** What the owner is shown of a worktree kept at settlement, and what removing it re-checks. */
const heldDigest = (held: ReadonlyArray<string>) =>
  NodeCrypto.createHash("sha256").update(held.join("\n")).digest("hex");
/**
 * What the owner is shown of a worktree kept at settlement. It shows five files but names all of
 * them by digest, so any change to what it holds changes the text the owner confirms.
 */
export const keptSummary = (path: string, held: ReadonlyArray<string>) =>
  `Kept ${path} after settling: it holds ${held.length} file${held.length === 1 ? "" : "s"} git does not track unchanged (${held.slice(0, 5).join(", ")}${held.length > 5 ? ", …" : ""}; contents ${heldDigest(held).slice(0, 12)}).`.slice(
    0,
    2_000,
  );
/** All of what a kept worktree held, by digest: what removing it re-checks. */
export const keptProvenance = (held: ReadonlyArray<string>) =>
  `coordinator-merge:held:${heldDigest(held)}`;
const decodeActionList = Schema.decodeUnknownEffect(
  Schema.Struct({ items: Schema.Array(CoordinatorAction) }),
);
const decodeMerges = Schema.decodeUnknownEffect(
  Schema.Struct({
    items: Schema.Array(
      Schema.Struct({
        goalId: Schema.String,
        assignmentId: Schema.String,
        target: Schema.Struct({
          head: Schema.String,
          target: Schema.String,
          repository: Schema.String,
          projectId: Schema.optional(Schema.NullOr(Schema.String)),
          branch: Schema.optional(Schema.NullOr(Schema.String)),
        }),
        waiting: Schema.optional(
          Schema.NullOr(Schema.Struct({ reason: Schema.String, owner: Schema.Boolean })),
        ),
      }),
    ),
  }),
);
const decodeGrantResult = Schema.decodeUnknownEffect(
  Schema.Struct({
    proposal: Schema.optional(CoordinatorGrant),
    reason: Schema.optional(Schema.String),
  }),
);
const decodeReverts = Schema.decodeUnknownEffect(
  Schema.Struct({
    items: Schema.Array(
      Schema.Struct({
        goalId: Schema.String,
        assignmentId: Schema.String,
        target: Schema.Struct({ head: Schema.String, target: Schema.String }),
        feedback: Schema.Struct({ payload: Schema.Unknown }),
        merged: Schema.Struct({
          // The head that landed, when it was not the reviewed one.
          head: Schema.optional(Schema.String),
          how: Schema.NullOr(
            Schema.Struct({
              pullRequest: Schema.optional(
                Schema.Struct({ repository: Schema.String, number: Schema.Number }),
              ),
            }),
          ),
        }),
      }),
    ),
  }),
);
const decodeBase = Schema.decodeUnknownEffect(
  Schema.Struct({
    base: Schema.String,
    prefix: Schema.String,
    branch: Schema.NullOr(Schema.String),
  }),
);
const LadderSchema = Schema.Struct({
  exclude: Schema.Array(
    Schema.Struct({
      provider: Schema.String,
      model: Schema.String,
      effort: Schema.NullOr(Schema.String),
    }),
  ),
  excludeProfiles: Schema.Array(
    Schema.Struct({ profileId: Schema.String, effort: Schema.NullOr(Schema.String) }),
  ),
  minScore: Schema.NullOr(Schema.Number),
  minTier: Schema.NullOr(Schema.Number),
});
const decodeBoard = Schema.decodeUnknownEffect(
  Schema.Struct({
    next: Schema.Array(Schema.Struct({ goalId: Schema.String, ladder: LadderSchema })),
    waiting: Schema.Array(Schema.Struct({ goalId: Schema.String, reason: Schema.String })),
    capacity: Schema.Struct({
      limits: Schema.Struct({
        perLogin: Schema.NullOr(Schema.Number),
        localSlots: Schema.NullOr(Schema.Number),
      }),
    }),
  }),
);
const decodeScore = Schema.decodeUnknownEffect(
  Schema.Struct({
    pick: Schema.NullOr(
      Schema.Struct({
        instance: Schema.String,
        model: Schema.String,
        effort: Schema.String,
        destination: Schema.String,
      }),
    ),
    scores: Schema.Array(Schema.Struct({ reason: Schema.NullOr(Schema.String) })),
  }),
);
const decodePrepared = Schema.decodeUnknownEffect(
  Schema.Struct({
    blocked: Schema.optional(Schema.Boolean),
    capped: Schema.optional(Schema.Boolean),
    reason: Schema.optional(Schema.String),
  }),
);
/** The store's own words for a refusal, which the supervisor keeps as the error's cause. */
const nativeReason = (error: CoordinatorError) =>
  typeof error.cause === "object" &&
  error.cause !== null &&
  "message" in error.cause &&
  typeof error.cause.message === "string"
    ? error.cause.message
    : error.message;
const decodeAcceptedOutcome = Schema.decodeUnknownEffect(
  Schema.Struct({
    event: Schema.Struct({
      eventId: Schema.String,
      goalId: Schema.String,
      subjects: Schema.Array(
        Schema.Struct({
          assignmentId: Schema.String,
          route: CoordinatorRouteSelection,
          rank: Schema.String,
        }),
      ),
    }),
  }),
);
const decodeEffectivePolicy = Schema.decodeUnknownEffect(
  Schema.Struct({
    effect: Schema.String,
    policyRevision: Schema.Number,
    grantId: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);
const decodePermissionResponse = Schema.decodeUnknownEffect(
  Schema.Struct({
    destinationRequestId: Schema.String,
    decision: Schema.Literals(["approve", "deny"]),
    actor: Schema.optional(Schema.String),
    operation: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);
const decodeAssignmentAction = Schema.decodeUnknownEffect(
  Schema.Struct({
    assignment: CoordinatorAssignment,
    card: CoordinatorCard,
    touches: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  }),
);
const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeSelection = Schema.decodeUnknownEffect(
  Schema.Struct({ selection: CoordinatorRouteSelection }),
);
const decodeActionPage = Schema.decodeUnknownEffect(
  Schema.Struct({
    items: Schema.Array(CoordinatorAction),
    nextCursor: Schema.NullOr(Schema.String),
  }),
);
const decodeRevision = Schema.decodeUnknownEffect(Schema.Struct({ revision: Schema.Number }));
const decodeClaimedAction = Schema.decodeUnknownEffect(
  Schema.Struct({ action: CoordinatorAction, claimed: Schema.optional(Schema.Boolean) }),
);
const decodeAssignment = Schema.decodeUnknownEffect(
  Schema.Struct({ assignment: CoordinatorAssignment }),
);
const CoordinatorCardPage = Schema.Struct({
  items: Schema.Array(CoordinatorCard),
  nextCursor: Schema.NullOr(Schema.String),
});
const decodeCardPage = Schema.decodeUnknownEffect(CoordinatorCardPage);
const decodeCard = Schema.decodeUnknownEffect(Schema.Struct({ card: CoordinatorCard }));
const decodePending = Schema.decodeUnknownEffect(
  Schema.Struct({
    kinds: Schema.Record(Schema.String, Schema.Number),
    through: Schema.Number,
    unread: Schema.Record(Schema.String, Schema.Number),
  }),
);
const LIVE_RUN: ReadonlySet<string> = new Set([
  "queued",
  "preparing",
  "starting",
  "running",
  "waiting",
]);
const decodeRemoteRun = Schema.decodeUnknownEffect(
  Schema.Struct({ run: Schema.NullOr(CloudDriver.RemoteRun) }),
);
// The owner's: "not too infrequently" (2026-11-12); Settings changes it.
const DEFAULT_CHECK_IN_MINUTES = 15;
const decodeSavedGoal = Schema.decodeUnknownEffect(Schema.Struct({ goal: CoordinatorGoal }));
const isApprovalRequestKind = Schema.is(ProviderRequestKind);
const isCoordinatorError = Schema.is(CoordinatorError);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
/**
 * The whole operation an approval asks for, when its thread states it and it fits a stored
 * request (8192 bytes in all, a lone surrogate refused). One that does not fit is never cut:
 * without it, only the thread's own approval can accept.
 */
const approvalOperation = (operation: string | undefined) =>
  operation?.trim() &&
  !/\p{Cs}/u.test(operation) &&
  new TextEncoder().encode(JSON.stringify(operation)).length <= 4096
    ? operation
    : undefined;
const decodeConfiguration = Schema.decodeUnknownEffect(CoordinatorConfiguration);
const isStoreFailure = (cause: CoordinatorError) =>
  cause.reason === "transport" || cause.reason === "unavailable";

const make = Effect.gen(function* () {
  const store = yield* Supervisor.Supervisor;
  const cloud = yield* CloudRuns.CloudRuns;
  const merges = yield* Merges.Merges;
  const runner = yield* ProcessRunner.ProcessRunner;
  const threads = yield* Threads.ThreadManagementService;
  const effectOutbox = yield* EffectOutbox.EffectOutboxV2;
  const threadLaunch = yield* ThreadLaunch.ThreadLaunchService;
  const peers = yield* PeerForwarding.PeerForwarding;
  const remote = yield* RemoteDelegation.RemoteDelegation;
  const backgroundScope = yield* Scope.Scope;
  const orchestrator = yield* OrchestratorMcpService.OrchestratorMcpService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const projects = yield* Projects.ProjectService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const random = yield* SecureRandom.SecureRandom;
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;
  const usage = yield* UsageService.UsageService;
  const hostResources = yield* Effect.serviceOption(HostResources.HostResources);
  const telemetry = yield* Effect.serviceOption(ResourceTelemetry.ResourceTelemetry);
  // Read at each dispatch; a reading that fails or is missing holds no local work.
  const readMachine = Effect.gen(function* () {
    const host = Option.isSome(hostResources) ? yield* hostResources.value.read : undefined;
    const latest = Option.isSome(telemetry) ? yield* telemetry.value.latest : undefined;
    return {
      availableMemory: host?.availableMemoryBytes ?? null,
      largestThread: latest ? largestThreadMemory(latest.processes) : null,
    };
  }).pipe(Effect.catchCause(() => Effect.succeed({ availableMemory: null, largestThread: null })));
  const snapshotRef = yield* Ref.make(unavailable);
  // The owner's name for the Coordinator, for a sentence they read.
  const named = (sentenceStart = false) =>
    Ref.get(snapshotRef).pipe(
      Effect.map((snapshot) => coordinatorInText(snapshot.configuration.labels, sentenceStart)),
    );
  const fleetPassed = yield* Ref.make<ReadonlyArray<string>>([]);
  // Done once a snapshot shows the Coordinator on.
  const switchedOn = yield* Deferred.make<void>();
  const changes = yield* PubSub.sliding<CoordinatorSnapshot>(1);
  const cycleGate = yield* Semaphore.make(1);
  const wakeGate = yield* Semaphore.make(1);
  const drainGate = yield* Semaphore.make(1);
  const drainScheduled = yield* Ref.make(false);
  // Lost on restart, which only brings the next check-in forward.
  const wakes = yield* Ref.make<{
    readonly lastDigestAt: number | null;
    /** A queued compaction, which the next wake lands after. */
    readonly waitingRunId: string | null;
    /** The turn of the last wake, and the events it told once it completes. */
    readonly carrying?: { readonly runId: string; readonly through: number } | undefined;
    /** The id of a wake whose send has not been confirmed. */
    readonly sending?: string | undefined;
    /** Why the next wake goes even with nothing new: its last turn was stopped. */
    readonly reason?: string | undefined;
    /** The token reading the last `/compact` was sent for, and the first after it if not lower. */
    readonly compacted?:
      | { readonly sentFor: string; readonly used: number; readonly unlowered?: string }
      | undefined;
  }>({ lastDigestAt: null, waitingRunId: null });
  const catalogGate = yield* Semaphore.make(1);
  const projectionDigests = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
  // From a request the store could not answer until the next one it answers.
  const storeDownSince = yield* Ref.make<number | undefined>(undefined);
  // The snapshot held may predate the store: set until a load succeeds, and by each unanswered
  // request. Another answered request proves nothing about the snapshot.
  const snapshotStale = yield* Ref.make(true);
  const availability = Effect.gen(function* () {
    const since = yield* Ref.get(storeDownSince);
    if (since !== undefined)
      return { available: false, reason: "The supervisor is not responding.", since };
    return { available: true };
  });
  const publishAvailability = Effect.gen(function* () {
    const current = yield* availability;
    const value = yield* Ref.updateAndGet(snapshotRef, (snapshot) => ({
      ...snapshot,
      availability: current,
    }));
    yield* PubSub.publish(changes, value);
  });
  let running = false;
  // The server listens while start reads the store, then recovers settled work: reads wait for the
  // snapshot rather than answer from the placeholder, and requests that act wait for both.
  let starting = false;
  const started = yield* Deferred.make<void>();
  const recovered = yield* Deferred.make<void>();
  const untilStarted = Effect.suspend(() => (starting ? Deferred.await(started) : Effect.void));
  const untilRecovered = Effect.suspend(() => (starting ? Deferred.await(recovered) : Effect.void));
  // A read missed while not running: the off Coordinator's one waiting fiber reads again.
  const missed = yield* Queue.sliding<void>(1);
  const supervisor = store.available
    ? Supervisor.Supervisor.of({
        available: true,
        // Untraced: it wraps every store request, whose own span already covers it.
        request: Effect.fnUntraced(function* (method: string, params: unknown) {
          const result = yield* store.request(method, params).pipe(Effect.result);
          const answered = result._tag === "Success" || !isStoreFailure(result.failure);
          if (!answered) yield* Ref.set(snapshotStale, true);
          // Not yet running, nothing else reads again: an answer the owner's change went
          // without is read again until the store answers.
          if (!answered && !running) yield* Queue.offer(missed, undefined);
          if (answered !== ((yield* Ref.get(storeDownSince)) === undefined)) {
            yield* Ref.set(
              storeDownSince,
              answered ? undefined : DateTime.toEpochMillis(yield* DateTime.now),
            );
            yield* publishAvailability;
          }
          return yield* Effect.fromResult(result);
        }),
        ...(store.lastSeen ? { lastSeen: store.lastSeen } : {}),
      })
    : store;
  // Known off without asking the store: never made, or last seen off.
  const switchedOff = store.lastSeen
    ? Effect.map(store.lastSeen, (seen) => seen?.enabled === false)
    : Effect.succeed(false);
  const uuid = () => random.uuidV4().pipe(Effect.orDie);
  const mapError = (operation: string) => (cause: unknown) =>
    isCoordinatorError(cause)
      ? cause
      : new CoordinatorError({ operation, reason: "destination", cause });
  // Every active thread's full shell in one read; `listProjectThreads` carries only what listings
  // sort by, and the Coordinator reads run state, model and pending requests.
  const activeShells = (operation: string) =>
    threads.getShellSnapshot({ location: "active" }).pipe(
      Effect.map((snapshot) =>
        snapshot.threads.filter((thread) => thread.lineage.sideChat !== true),
      ),
      Effect.mapError(mapError(operation)),
    );
  const load = Effect.fn("Coordinator.load")(function* () {
    const projectRows = (yield* projects
      .listShells()
      .pipe(Effect.mapError(mapError("projects")))).map((project) => ({
      id: project.id,
      title: project.title,
    }));
    if (!supervisor.available) {
      const value = { ...unavailable, projects: projectRows };
      yield* Ref.set(snapshotRef, value);
      return value;
    }
    const raw = yield* supervisor.request("snapshot", { limit: 100 });
    const snapshot = yield* decodeSnapshot(raw).pipe(
      Effect.mapError(
        (cause) => new CoordinatorError({ operation: "snapshot", reason: "invalid", cause }),
      ),
    );
    // No retry is pending while there is nothing to plan.
    const value = {
      ...snapshot,
      projects: projectRows,
      availability: yield* availability,
      fleetPassed: yield* Ref.get(fleetPassed),
    };
    const previous = yield* Ref.getAndSet(snapshotRef, value);
    yield* Ref.set(snapshotStale, false);
    // Every cycle reads one; clients are sent it only when it changed.
    if (!Equal.equals(previous, value)) yield* PubSub.publish(changes, value);
    // Last, so a waiter it ends never cuts this read short.
    if (value.configuration.enabled) yield* Deferred.succeed(switchedOn, undefined);
    return value;
  });
  const syncCards = Effect.fn("Coordinator.syncCards")(function* () {
    const environmentId = yield* environment.getEnvironmentId;
    const shells = yield* activeShells("cards");
    // A title generated or typed since still gives way to the name set in Settings.
    const { configuration } = yield* Ref.get(snapshotRef);
    const anchor = shells.find((thread) => thread.id === configuration.coordinatorThreadId);
    if (configuration.enabled && anchor && anchor.title !== coordinatorName(configuration))
      yield* threads
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(yield* uuid()),
          threadId: anchor.id,
          title: coordinatorName(configuration),
        })
        .pipe(Effect.mapError(mapError("coordinator-title")));
    // Only metadata belongs in the supervisor. Transcripts remain in T3's execution store.
    const cards = shells.map((thread) => ({
      id: `${environmentId}:${thread.id}`,
      threadId: thread.id,
      environmentId,
      projectId: thread.projectId,
      purpose: thread.title.slice(0, 2_000) || "Untitled thread",
      status: cardStatus(thread.activityRunStatus ?? thread.status),
      instructionRevision: thread.latestUserAuthoredMessageAt
        ? DateTime.toEpochMillis(thread.latestUserAuthoredMessageAt)
        : 0,
      provider: thread.providerInstanceId,
      model: thread.modelSelection.model,
      effort:
        thread.modelSelection.options
          ?.find((option) => option.id === "effort")
          ?.value?.toString() ?? null,
      destination: "local",
      settled: thread.settledOverride === "settled",
      archived: thread.archivedAt !== null,
      blocker: thread.pendingRuntimeRequest
        ? "A destination permission or clarification request needs a response."
        : (thread.lastError?.slice(0, 1_000) ?? null),
      summaryUpdatedAt: DateTime.toEpochMillis(thread.updatedAt),
    }));
    const previous = yield* Ref.get(projectionDigests);
    const changed = [];
    const next = new Map<string, string>();
    for (const card of cards) {
      const digest = yield* encodeJson({ ...card, summaryUpdatedAt: undefined }).pipe(
        Effect.mapError(mapError("card-projection")),
      );
      next.set(card.id, digest);
      if (previous.get(card.id) !== digest) changed.push(card);
    }
    for (let offset = 0; offset < changed.length; offset += 100)
      yield* supervisor.request("cards.sync", {
        projection: true,
        cards: changed.slice(offset, offset + 100),
      });
    yield* Ref.set(projectionDigests, next);
  });
  const refreshCatalogUnsafe = Effect.fn("Coordinator.refreshCatalog")(function* (
    refresh = true,
    manual = false,
  ) {
    const current = yield* load();
    const discover = (sourceId: string) =>
      manual ||
      current.catalogSources?.find((source) => source.id === sourceId)?.automaticDiscovery !==
        false;
    const cached = yield* providers.getProviders;
    const rows =
      refresh && (manual || cached.some((provider) => discover(provider.instanceId)))
        ? yield* providers.refresh()
        : cached;
    const environmentId = yield* environment.getEnvironmentId;
    const efforts = (model: (typeof rows)[number]["models"][number] | undefined) =>
      (model?.capabilities?.optionDescriptors ?? []).flatMap((option) =>
        option.id === "effort" && option.type === "select"
          ? option.options.map((choice) => choice.id)
          : [],
      );
    for (const provider of rows) {
      if (!discover(provider.instanceId)) continue;
      const models = provider.models.map((model) => ({
        id: `${environmentId}:${provider.instanceId}:${model.slug}`,
        sourceId: provider.instanceId,
        provider: provider.instanceId,
        model: model.slug,
        destination: "local",
        account: provider.instanceId,
        compatible: isProviderAvailable(provider),
        accessible:
          provider.enabled && provider.installed && provider.auth.status !== "unauthenticated",
        policyAllowed: provider.enabled,
        identityVerified: true,
        // The registry lists the exact model and efforts this machine runs; the router scores it
        // from the bench, or the default prior until its own outcomes count.
        qualificationVerified: true,
        state: "discovered",
        evidence: ["T3 provider registry"],
        efforts: efforts(model),
      }));
      yield* supervisor.request("catalog.sync", {
        sourceId: provider.instanceId,
        models,
        complete: true,
        success: true,
        // Its approvals are answered by kind alone, so it takes work only once the owner says so;
        // the store keeps the owner's later word over this first one.
        ...(statesOperation(provider.driver) ? {} : { automaticEligibility: false }),
      });
    }
    for (const binding of current.configuration.guildBindings ?? []) {
      if (!binding.cloud || binding.cloud.projectId !== current.configuration.coordinatorProjectId)
        continue;
      const sourceId = `cloud:${binding.id}`;
      if (!discover(sourceId)) continue;
      // A Claude cloud session's model is proven from its metadata; Codex cloud picks its own.
      const proven = binding.cloud.destination === "cloud:claude";
      const model = proven ? binding.cloud.guildModel : "provider-selected";
      yield* supervisor.request("catalog.sync", {
        sourceId,
        complete: true,
        success: true,
        models: [
          {
            id: `${sourceId}:${model}`,
            sourceId,
            provider: binding.providerInstanceId,
            model,
            destination: binding.cloud.destination,
            account: binding.providerInstanceId,
            compatible: cloud.supports(binding.cloud.destination),
            accessible: true,
            policyAllowed: current.configuration.allowUnverifiedCloudModels === true,
            qualificationVerified: proven,
            identityVerified: proven,
            state: "discovered",
            // The cloud session runs the efforts its login offers locally for the same model.
            efforts: proven
              ? efforts(
                  rows
                    .find((provider) => provider.instanceId === binding.providerInstanceId)
                    ?.models.find((item) => item.slug === model),
                )
              : [],
            evidence: [
              proven
                ? "Explicit Claude cloud binding; the session's model and effort are proven before its result is taken."
                : "Explicit Codex cloud binding; runtime model is provider-selected and unverified.",
            ],
          },
        ],
      });
    }
    if (
      current.configuration.coordinatorThreadId &&
      (yield* settings.getSettings.pipe(
        Effect.map((value) => value.linkedEnvironmentsEnabled),
        Effect.orElseSucceed(() => false),
      ))
    ) {
      const scope = yield* scopeFor(current.configuration.coordinatorThreadId);
      const linked = yield* peers.links(scope).pipe(Effect.result);
      if (linked._tag === "Success")
        for (const destination of linked.success.links) {
          const previousSources = new Set(
            current.catalog
              .filter((item) => item.destination === `remote:${destination.environmentId}`)
              .map((item) => item.sourceId),
          );
          if (destination.status !== "reachable") {
            for (const sourceId of previousSources)
              yield* supervisor.request("catalog.sync", { sourceId, success: false });
            continue;
          }
          const pins = current.overrides
            .filter(
              (item) =>
                item.selection.destination === `remote:${destination.environmentId}` &&
                item.selection.model,
            )
            .map((item) => item.selection.model!);
          for (const search of [undefined, ...new Set(pins)]) {
            const result = yield* peers
              .call(
                scope,
                OrchestratorToolkit.tools.orchestrator_capabilities,
                destination.environmentId,
                search ? { search } : {},
              )
              .pipe(Effect.result);
            if (result._tag === "Failure") {
              for (const sourceId of previousSources)
                yield* supervisor.request("catalog.sync", { sourceId, success: false });
              continue;
            }
            for (const provider of result.success.providers) {
              const sourceId = `remote:${destination.environmentId}:${provider.providerInstanceId}`;
              if (!discover(sourceId)) continue;
              yield* supervisor.request("catalog.sync", {
                sourceId,
                success: true,
                complete: search === undefined && (provider.omittedModels ?? 0) === 0,
                models: provider.models.map((model) => ({
                  id: `${sourceId}:${model.id}`,
                  sourceId,
                  provider: provider.providerInstanceId,
                  model: model.id,
                  destination: `remote:${destination.environmentId}`,
                  account: provider.providerInstanceId,
                  compatible: provider.canRunChildTask,
                  accessible: provider.constraints.length === 0,
                  policyAllowed: destination.access !== "read-only",
                  identityVerified: true,
                  qualificationVerified: false,
                  efforts: (model.options ?? [])
                    .filter((option) => option.id === "effort")
                    .flatMap((option) =>
                      option.values.filter((value): value is string => typeof value === "string"),
                    ),
                  evidence: [
                    "Existing authenticated T3 peer capabilities; destination shared admission remains subject to verification.",
                  ],
                })),
              });
            }
          }
        }
    }
  });
  const refreshCatalog = (refresh = true, manual = false) =>
    catalogGate.withPermits(1)(refreshCatalogUnsafe(refresh, manual));
  const syncPermissions = Effect.fn("Coordinator.syncPermissions")(function* () {
    const current = yield* load();
    const localEnvironmentId = yield* environment.getEnvironmentId;
    const cards: Array<typeof CoordinatorCard.Type> = [];
    let cursor: string | null = null;
    do {
      const raw: unknown = yield* supervisor.request("cards.list", {
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      const page = yield* decodeCardPage(raw).pipe(Effect.mapError(mapError("permissions")));
      cards.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    // A thread with no pending request, and none held for it here, has nothing to read: one list
    // instead of a read of every thread each minute.
    const shells = new Map(
      (yield* activeShells("permissions")).map((thread) => [thread.id, thread]),
    );
    const held = new Set(current.permissionRequests?.map((request) => request.cardId));
    let answered = false;
    for (const card of cards) {
      if (card.environmentId !== localEnvironmentId || card.archived || card.settled) continue;
      if (
        shells.get(ThreadId.make(card.threadId))?.pendingRuntimeRequest === null &&
        !held.has(card.id)
      )
        continue;
      const records = yield* threads
        .getThreadRecords(ThreadId.make(card.threadId), ["runtimeRequests"])
        .pipe(Effect.mapError(mapError("permissions")));
      const pendingNodes = records.runtimeRequests
        .filter((request) => request.status === "pending" && isApprovalRequestKind(request.kind))
        .map((request) => request.nodeId);
      const { turnItems } =
        pendingNodes.length === 0
          ? { turnItems: [] }
          : yield* threads
              .getThreadRecords(ThreadId.make(card.threadId), ["turnItems"], {
                turnItemNodeIds: pendingNodes,
              })
              .pipe(Effect.mapError(mapError("permissions")));
      // Paths are read in the project's folder, which in a worktree of a monorepo sits at the
      // prefix its assignment recorded; a sibling project then lies outside it.
      const prefix =
        pendingNodes.length > 0 && card.assignmentId && records.thread.worktreePath
          ? (yield* assignmentById(card.assignmentId)).receipt?.prefix
          : undefined;
      const root =
        pendingNodes.length === 0
          ? undefined
          : records.thread.worktreePath
            ? path.join(records.thread.worktreePath, typeof prefix === "string" ? prefix : "")
            : Option.getOrUndefined(
                yield* projects
                  .getById(records.thread.projectId)
                  .pipe(Effect.mapError(mapError("permissions"))),
              )?.workspaceRoot;
      for (const request of records.runtimeRequests) {
        if (!isApprovalRequestKind(request.kind)) continue;
        const id = `${localEnvironmentId}:${storedRequestId(request.id)}`;
        if (request.status !== "pending") {
          if (current.permissionRequests?.some((item) => item.id === id))
            yield* supervisor
              .request("permissions.decide", {
                requestId: id,
                decision: ["decline", "cancel"].includes(request.decision ?? "")
                  ? "deny"
                  : "approve",
                actor: "user",
                alreadyAnswered: true,
              })
              .pipe(Effect.ignore);
          continue;
        }
        const access =
          records.thread.runtimeMode === "approval-required"
            ? 0
            : records.thread.runtimeMode === "auto-accept-edits"
              ? 1
              : 2;
        const approval = turnItems.flatMap((item) =>
          item.type === "approval_request" && item.requestId === request.id ? [item] : [],
        )[0];
        const detail = approval?.prompt;
        const operation = approvalOperation(approval?.operation);
        // Rules decide on the paths and access the stated operation asks for; without one the
        // request counts as asking for full access.
        const bounds = yield* resolvedApprovalBounds(operation, root).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
        const metadata = {
          id,
          destinationRequestId: request.id,
          cardId: card.id,
          category: request.kind,
          ...bounds,
          currentAccess: access,
          destinationMaxAccess: 2,
          supported: request.responseCapability.type === "live",
          ...(detail ? { detail: Array.from(detail).slice(0, 500).join("") } : {}),
          ...(operation ? { operation } : {}),
        };
        const registration = yield* supervisor
          .request("permissions.request", { request: metadata })
          .pipe(Effect.result);
        // One the store refuses, such as a request first read before its bounds were, stays with
        // the owner and does not hold up the rest.
        if (registration._tag === "Failure") {
          yield* Effect.logWarning("Coordinator could not register an approval", {
            threadId: card.threadId,
            reason: refusal(registration.failure),
          });
          continue;
        }
        const registered = registration.success;
        if (
          typeof registered !== "object" ||
          registered === null ||
          !("status" in registered) ||
          registered.status !== "pending"
        )
          continue;
        const effective = yield* supervisor.request("permissions.effective", {
          ...metadata,
          threadId: card.threadId,
          assignmentId: card.assignmentId,
          projectId: card.projectId,
          environmentId: card.environmentId,
        });
        const policy = yield* decodeEffectivePolicy(effective).pipe(
          Effect.mapError(mapError("permissions")),
        );
        // Only delegated work inside a grant is answered by rule; a person's own thread waits for them.
        if (policy.grantId && ["allow", "deny"].includes(policy.effect)) {
          yield* supervisor.request("permissions.decide", {
            requestId: id,
            decision: policy.effect === "allow" ? "approve" : "deny",
            actor: "coordinator",
            grantRevision: policy.policyRevision,
          });
          answered = true;
        }
      }
    }
    // Sent now: the author waits on it, and the next drain may be a minute away.
    if (answered) yield* drain();
  });
  const scopeFor = Effect.fn("Coordinator.scopeFor")(function* (
    threadId: string,
  ): Effect.fn.Return<McpInvocationScope, CoordinatorError> {
    const shell = yield* threads
      .getThreadShell(ThreadId.make(threadId))
      .pipe(Effect.mapError(mapError("thread")));
    if (shell === null)
      return yield* new CoordinatorError({ operation: "thread", reason: "destination" });
    return {
      environmentId: yield* environment.getEnvironmentId,
      issuedAt: DateTime.toEpochMillis(yield* DateTime.now),
      capabilities: new Set<"orchestration">(["orchestration"]),
      requestNamespace: "coordinator",
      thread: undefined,
      client: {
        sessionId: "coordinator-supervisor",
        label: "Coordinator",
        access: shell.runtimeMode,
        narrowedTo: { runtimeMode: shell.runtimeMode, interactionMode: shell.interactionMode },
      },
      linkedEnvironments: yield* settings.getSettings.pipe(
        Effect.map((value) => value.linkedEnvironmentsEnabled),
        Effect.orElseSucceed(() => false),
      ),
    };
  });
  // After a thread settled: the worktree this host made for it goes, if git finds it clean. Run
  // again by a retried settlement and at start-up, so a crash part way loses nothing.
  const finishSettled = Effect.fn("Coordinator.finishSettled")(function* (input: {
    readonly threadId: ThreadId;
    readonly assignmentId: string;
    readonly cardId: string;
    readonly goalId: string | null;
  }) {
    const threadId = input.threadId;
    const settled = yield* threads
      .getThreadShell(threadId)
      .pipe(Effect.mapError(mapError("settlement")));
    // True once its worktree step is done (removed, kept for the owner, or none to take); false
    // when it failed, so the settlement stays unfinished and start-up recovery tries again.
    if (settled?.settledOverride !== "settled") return true;
    // Only the worktree this host saw made for an author it started goes, and only while git
    // tracks everything in it unchanged; anything else may be someone's.
    const owner = yield* assignmentById(input.assignmentId);
    const project = Option.getOrUndefined(
      yield* projects.getById(settled.projectId).pipe(Effect.mapError(mapError("settlement"))),
    );
    if (
      owner.role !== "reviewer" &&
      threadId.startsWith("coordinator:") &&
      owner.receipt?.threadId === threadId &&
      typeof owner.receipt.worktree === "string" &&
      owner.receipt.worktree === settled.worktreePath &&
      project
    ) {
      const path = owner.receipt.worktree;
      return yield* merges.removeWorktree({ repository: project.workspaceRoot, path }).pipe(
        Effect.flatMap((held) =>
          held.length
            ? supervisor
                .request("decisions.record", {
                  decision: {
                    id: `worktree-kept:${threadId}`,
                    summary: keptSummary(path, held),
                    provenance: keptProvenance(held),
                    cardIds: [input.cardId],
                    goalIds: input.goalId ? [input.goalId] : [],
                  },
                })
                .pipe(
                  Effect.andThen(
                    supervisor.request("events.append", {
                      actor: "host",
                      event: {
                        kind: "worktree",
                        status: "kept",
                        threadId,
                        subject: path,
                        summary: `Kept after settling: it holds ${held.length} file(s) git does not track unchanged.`,
                      },
                    }),
                  ),
                )
            : threads
                .dispatch({
                  type: "thread.metadata.update",
                  commandId: CommandId.make(`coordinator:settled:${threadId}:worktree`),
                  threadId,
                  worktreePath: null,
                  branch: null,
                })
                .pipe(Effect.mapError(mapError("worktree"))),
        ),
        Effect.as(true),
        Effect.catch((cause) =>
          Effect.logWarning("Coordinator kept a settled thread's worktree", {
            threadId,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );
    }
    return true;
  });
  const archiveSettled = (threadId: ThreadId) =>
    threads.getThreadShell(threadId).pipe(
      Effect.flatMap((shell) =>
        shell?.settledOverride === "settled" && shell.archivedAt === null
          ? threads.dispatch({
              type: "thread.archive",
              commandId: CommandId.make(`coordinator:archive:${threadId}`),
              threadId,
            })
          : Effect.void,
      ),
      Effect.as(true),
      Effect.catch((cause) =>
        Effect.logWarning("Coordinator did not archive a settled thread", { cause }).pipe(
          Effect.as(false),
        ),
      ),
    );
  // At start-up, what a crash left undone after a settlement the store took: the worktree this
  // host made and the archive of a thread it started. Both steps are idempotent.
  const recoverSettled = Effect.fn("Coordinator.recoverSettled")(function* () {
    const { items } = yield* supervisor
      .request("settlements.unfinished", {})
      .pipe(Effect.flatMap(decodeActionList), Effect.mapError(mapError("recover-settled")));
    for (const action of items)
      yield* Effect.gen(function* () {
        const payload = yield* decodeSettlementAction(action.payload).pipe(
          Effect.mapError(mapError("recover-settled")),
        );
        if (action.threadId?.startsWith("coordinator:")) {
          const threadId = ThreadId.make(action.threadId);
          const kept = yield* supervisor
            .request("decisions.get", { id: `worktree-kept:${action.threadId}` })
            .pipe(Effect.flatMap(decodeKeptNote), Effect.mapError(mapError("recover-settled")));
          const worktree = kept.decision
            ? true
            : yield* finishSettled({
                threadId,
                assignmentId: payload.assignmentId,
                cardId: payload.cardId,
                goalId: payload.goalId,
              });
          const archived = yield* archiveSettled(threadId);
          // Marked done only once both steps are: a failure is tried again next start.
          if (!worktree || !archived) return;
        }
        yield* supervisor.request("settlements.finished", { id: action.id });
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Coordinator could not finish a settlement", { reason: cause.reason }),
        ),
      );
  });
  const executeAction = Effect.fn("Coordinator.executeAction")(function* (
    action: typeof CoordinatorAction.Type,
  ) {
    if (action.kind === "outcome.accepted") {
      // Recorded once the goal's change merged, or its result was taken when it changed nothing.
      const { event } = yield* decodeAcceptedOutcome(action.payload).pipe(
        Effect.mapError(mapError("outcome")),
      );
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      for (const subject of event.subjects) {
        const round = outcomeRound({
          id: `merged:${subject.assignmentId}`,
          goalId: event.goalId,
          route: subject.route,
          rank: subject.rank,
          startedAt: now,
          endedAt: now,
          usedMicros: 0,
          finish: "merged",
        });
        if (round) yield* supervisor.request("outcomes.record", { round });
      }
      const encoded = yield* encodeJson(action.payload.event).pipe(
        Effect.mapError(mapError("outcome")),
      );
      return {
        status: "completed" as const,
        result: {
          eventId: event.eventId,
          digest: NodeCrypto.createHash("sha256").update(encoded).digest("hex"),
        },
      };
    }
    if (action.kind === "catalog.refresh") {
      yield* refreshCatalog();
      return { status: "completed" as const, result: {} };
    }
    if (action.kind === "thread.settle") {
      const payload = yield* decodeSettlementAction(action.payload).pipe(
        Effect.mapError(mapError("settlement")),
      );
      if (payload.cloud)
        return {
          status: "completed" as const,
          result: {
            settled: true,
            cardId: payload.cardId,
            receipt: "trusted-terminal-cloud-supersession",
          },
        };
      if (!action.threadId || action.environmentId !== (yield* environment.getEnvironmentId))
        return {
          status: "unsupported" as const,
          result: { reason: "Destination automatic-settle support is unavailable." },
        };
      const threadId = ThreadId.make(action.threadId);
      const shell = yield* threads
        .getThreadShell(threadId)
        .pipe(Effect.mapError(mapError("settlement")));
      if (!shell)
        return {
          status: "failed" as const,
          result: { reason: "The reviewed chat no longer exists." },
        };
      const instructionRevision = shell.latestUserAuthoredMessageAt
        ? DateTime.toEpochMillis(shell.latestUserAuthoredMessageAt)
        : 0;
      const commandId = CommandId.make(`coordinator:${action.id}`);
      const committed = yield* threads
        .hasReceipt(commandId)
        .pipe(Effect.mapError(mapError("settlement-receipt")));
      if (
        shell.settledOverride === "settled" &&
        instructionRevision === action.instructionRevision &&
        shell.latestRunId === payload.expectedRunId
      ) {
        // A crash after the settle may have stopped before the worktree went; it goes now.
        const worktreeDone = yield* finishSettled({
          threadId,
          assignmentId: payload.assignmentId,
          cardId: payload.cardId,
          goalId: payload.goalId,
        });
        return {
          status: "completed" as const,
          result: {
            settled: true,
            cardId: payload.cardId,
            commandId,
            receipt: committed ? "durable-auto-settle-command" : "confirmed-existing-settlement",
            worktreeDone,
          },
        };
      }
      if (committed)
        return {
          status: "failed" as const,
          result: {
            reason:
              "The user changed or reopened this chat after settlement; no close was repeated.",
          },
        };
      const blocker = automaticSettlementBlocker({
        expectedInstructionRevision: action.instructionRevision,
        instructionRevision,
        expectedRunId: payload.expectedRunId,
        shell,
      });
      // Cancelled work may still be stopping; it settles once it has.
      if (blocker)
        return {
          status:
            payload.ended && blocker.includes("active work")
              ? ("uncertain" as const)
              : ("failed" as const),
          result: { reason: blocker },
        };
      const records = yield* threads
        .getThreadRecords(threadId, ["runtimeRequests", "turnItems"], {
          turnItemTypes: ["link_request"],
          turnItemStatuses: ["waiting"],
        })
        .pipe(Effect.mapError(mapError("settlement-input")));
      if (
        records.runtimeRequests.some((request) => request.status === "pending") ||
        records.turnItems.length
      )
        return {
          status: "failed" as const,
          result: { reason: "Pending runtime or link input prevents automatic settlement." },
        };
      const receipt = yield* threads
        .dispatch({ type: "thread.auto-settle", commandId, threadId, snapshotAt: shell.updatedAt })
        .pipe(Effect.mapError(mapError("automatic-settlement")));
      const confirmed = yield* threads
        .getThreadShell(threadId)
        .pipe(Effect.mapError(mapError("settlement-confirmation")));
      if (confirmed?.settledOverride !== "settled")
        return {
          status: "failed" as const,
          result: { reason: "Automatic settlement was superseded by a newer chat change." },
        };
      const worktreeDone = yield* finishSettled({
        threadId,
        assignmentId: payload.assignmentId,
        cardId: payload.cardId,
        goalId: payload.goalId,
      });
      return {
        status: "completed" as const,
        result: {
          settled: true,
          cardId: payload.cardId,
          commandId,
          sequence: receipt.sequence,
          worktreeDone,
        },
      };
    }
    if (action.kind === "permission.respond") {
      const payload = yield* decodePermissionResponse(action.payload).pipe(
        Effect.mapError(mapError("permission-response")),
      );
      if (!action.threadId || action.environmentId !== (yield* environment.getEnvironmentId))
        return {
          status: "unsupported" as const,
          result: { reason: "Remote approval authority requires destination support." },
        };
      const threadId = ThreadId.make(action.threadId);
      const records = yield* threads
        .getThreadRecords(threadId, ["runtimeRequests"])
        .pipe(Effect.mapError(mapError("permission-response")));
      const request = records.runtimeRequests.find(
        (item) => item.id === payload.destinationRequestId,
      );
      const shell = yield* threads
        .getThreadShell(threadId)
        .pipe(Effect.mapError(mapError("permission-response")));
      const instructionRevision = shell?.latestUserAuthoredMessageAt
        ? DateTime.toEpochMillis(shell.latestUserAuthoredMessageAt)
        : 0;
      if (
        !request ||
        request.status !== "pending" ||
        request.responseCapability.type !== "live" ||
        instructionRevision !== action.instructionRevision
      )
        return {
          status: "failed" as const,
          result: { reason: "The destination request or direct user instructions changed." },
        };
      if (payload.decision === "approve" && (payload.actor ?? "user") === "user") {
        // A user's approval outside the thread stands only for an operation they could read whole.
        const { turnItems } = yield* threads
          .getThreadRecords(threadId, ["turnItems"], { turnItemNodeIds: [request.nodeId] })
          .pipe(Effect.mapError(mapError("permission-response")));
        const approval = turnItems.find(
          (item) => item.type === "approval_request" && item.requestId === request.id,
        );
        // The operation must also still be the one stored, and so shown, when it was imported.
        if (
          approval?.type !== "approval_request" ||
          !approvalOperation(approval.operation) ||
          approval.operation !== payload.operation
        )
          return {
            status: "failed" as const,
            result: {
              reason: "This request doesn't show its whole operation. Review it in its thread.",
            },
          };
      }
      const commandId = CommandId.make(`coordinator:${action.id}`);
      yield* threads
        .dispatch({
          type: "runtime-request.respond",
          threadId,
          commandId,
          requestId: RuntimeRequestId.make(payload.destinationRequestId),
          decision: payload.decision === "approve" ? "accept" : "decline",
        })
        .pipe(Effect.mapError(mapError("permission-response")));
      const effects = yield* effectOutbox
        .listByCommandId(commandId)
        .pipe(Effect.mapError(mapError("permission-ack")));
      yield* Effect.forEach(effects, (effect) => effectOutbox.awaitSettled(effect.id), {
        discard: true,
      }).pipe(Effect.mapError(mapError("permission-ack")));
      const settled = yield* effectOutbox
        .listByCommandId(commandId)
        .pipe(Effect.mapError(mapError("permission-ack")));
      if (settled.length === 0 || settled.some((effect) => effect.status !== "succeeded"))
        return {
          status: "uncertain" as const,
          result: {
            reason: "The response has no confirmed successful destination effect receipt.",
          },
        };
      return { status: "completed" as const, result: { commandId, destinationAcknowledged: true } };
    }
    const payload = yield* decodeAssignmentAction(action.payload).pipe(
      Effect.mapError(mapError("action")),
    );
    const { assignment, card } = payload;
    // The result is checked against the goal's touches as they were at dispatch.
    const touches = payload.touches?.length ? { touches: payload.touches } : {};
    const scope = yield* scopeFor(
      assignment.receipt && typeof assignment.receipt.parentThreadId === "string"
        ? assignment.receipt.parentThreadId
        : card.threadId,
    );
    const destination = assignment.route.destination ?? "";
    const remoteId = destination.startsWith("remote:")
      ? EnvironmentId.make(destination.slice(7))
      : undefined;
    if (destination.startsWith("cloud:")) {
      if (action.kind === "cancel") {
        const running = yield* cloud.release(assignment.id);
        return {
          status: "unsupported" as const,
          result: {
            reason: running.length
              ? `Still running, not stopped: ${running.join("; ")}.`
              : "No cloud run of this assignment is out.",
          },
        };
      }
      if (action.kind !== "dispatch")
        return {
          status: "unsupported" as const,
          result: {
            reason:
              "Cloud runs support submission and status; pause, resume, and messaging are unavailable.",
          },
        };
      const current = yield* load();
      const binding = current.configuration.guildBindings?.find(
        (item) =>
          item.providerInstanceId === assignment.route.provider &&
          item.cloud?.destination === destination &&
          item.cloud.projectId === card.projectId,
      );
      const resolved = yield* supervisor.request("overrides.resolve", {
        assignmentId: assignment.id,
        threadId: card.threadId,
        projectId: card.projectId,
        environmentId: card.environmentId,
      });
      const { selection } = yield* decodeSelection(resolved).pipe(
        Effect.mapError(mapError("cloud-pin")),
      );
      const proven = destination === "cloud:claude";
      const model = proven
        ? (selection.model ?? assignment.route.model ?? null)
        : (selection.model ?? null);
      const effort = selection.effort ?? assignment.route.effort ?? null;
      const project = binding?.cloud
        ? yield* projects
            .getById(ProjectId.make(card.projectId))
            .pipe(Effect.mapError(mapError("cloud-project")))
        : undefined;
      const blocker = cloudBlocker({
        destination,
        allowed: current.configuration.allowUnverifiedCloudModels === true,
        bound: Boolean(binding?.cloud) && cloud.supports(destination) && project?._tag === "Some",
        routeModel: assignment.route.model,
        model,
        effort,
      });
      if (blocker || !binding?.cloud || project?._tag !== "Some")
        return {
          status: "unsupported" as const,
          result: { status: "not-dispatched", reason: blocker ?? "No cloud binding." },
        };
      // The routed login's own Claude folder; with none configured, the ambient login.
      const loginInstance = assignment.route.account ?? assignment.route.provider;
      const loginConfig =
        proven && loginInstance
          ? decodeClaudeSettings(
              (yield* settings.getSettings.pipe(Effect.mapError(mapError("cloud-login"))))
                .providerInstances[ProviderInstanceId.make(loginInstance)]?.config ?? {},
            )
          : undefined;
      const login =
        loginConfig?._tag === "Some" && loginConfig.value.homePath
          ? yield* resolveClaudeHomePath(loginConfig.value).pipe(
              Effect.provideService(Path.Path, path),
            )
          : null;
      // What comes back is checked against the grant and the base as they are now.
      const { grant } = yield* supervisor
        .request("grants.resolve", {
          projectId: card.projectId,
          environmentId: yield* environment.getEnvironmentId,
          assignmentId: assignment.id,
        })
        .pipe(Effect.flatMap(decodeGrant), Effect.mapError(mapError("grant")));
      const based = yield* supervisor
        .request("results.base", {
          repository: project.value.workspaceRoot,
          ref: binding.cloud.head,
          project: project.value.workspaceRoot,
        })
        .pipe(Effect.flatMap(decodeBase), Effect.result);
      if (based._tag === "Failure")
        return {
          status: "failed" as const,
          result: {
            status: "not-dispatched",
            reason: "The cloud's base commit is not in the project's checkout.",
          },
        };
      const run = yield* cloud
        .submit({
          assignmentId: assignment.id,
          destination,
          repository: project.value.workspaceRoot,
          base: binding.cloud.head,
          sourceBranch: binding.cloud.branch,
          environment: binding.cloud.environment,
          brief: `${assignment.brief}\nReturn your final response and acceptance evidence to ${yield* named()} through ${assignment.returnRoute}.`,
          model: proven ? model : null,
          effort,
          login,
        })
        .pipe(Effect.result);
      if (run._tag === "Failure")
        return {
          // The cloud command ran; without a recorded run it may still have started one.
          status: "uncertain" as const,
          result: { reason: run.failure.message },
        };
      const cardId = `${destination}:${run.success.handle}`;
      yield* supervisor.request("cards.sync", {
        cards: [
          {
            id: cardId,
            threadId: run.success.handle,
            environmentId: destination,
            projectId: card.projectId,
            purpose: assignment.brief.slice(0, 2_000),
            status: "submitted",
            instructionRevision: 0,
            profileId: binding.profileId,
            provider: assignment.route.provider,
            model: proven && model ? model : "provider-selected",
            ...(effort ? { effort } : {}),
            destination,
            assignmentId: assignment.id,
            blocker: "A cloud run cannot be paused, stopped, or messaged.",
          },
        ],
      });
      return {
        status: "completed" as const,
        result: {
          status: "submitted",
          executionId: run.success.handle,
          cardId,
          resumeSupported: false,
          receipt: {
            cloudBinding: binding.cloud,
            projectId: card.projectId,
            base: based.success.base,
            prefix: based.success.prefix,
            target: binding.cloud.branch,
            grant: grant && {
              id: grant.id,
              folders: grant.folders ?? [],
              delete: grant.delete ?? [],
            },
            ...touches,
            parentThreadId: card.threadId,
            cloudTaskId: run.success.handle,
            branch: run.success.branch,
            submissionStatus: "submitted",
            identityVerified: false,
            startedAt: DateTime.toEpochMillis(yield* DateTime.now),
          },
        },
      };
    }
    if (destination !== "local" && remoteId === undefined)
      return {
        status: "unsupported" as const,
        result: {
          status: "not-dispatched",
          reason: "No supported native cloud adapter is registered for this destination.",
        },
      };
    const targetThreadId = ThreadId.make(card.threadId);
    if (action.kind === "dispatch") {
      const live = yield* threads
        .getThreadShell(targetThreadId)
        .pipe(Effect.mapError(mapError("dispatch")));
      if (
        !live ||
        live.archivedAt !== null ||
        (live.latestUserAuthoredMessageAt
          ? DateTime.toEpochMillis(live.latestUserAuthoredMessageAt)
          : 0) !== assignment.instructionRevision
      )
        return {
          status: "failed" as const,
          result: { status: "not-dispatched", reason: "Direct user instructions changed." },
        };
      const provider = assignment.route.provider;
      const model = assignment.route.model;
      if (
        !provider ||
        !model ||
        (assignment.route.account && assignment.route.account !== provider)
      )
        return {
          status: "unsupported" as const,
          result: {
            status: "not-dispatched",
            reason: "Exact provider/account binding is unavailable.",
          },
        };
      const modelSelection = {
        instanceId: ProviderInstanceId.make(provider),
        model,
        options: assignment.route.effort ? [{ id: "effort", value: assignment.route.effort }] : [],
      };
      const key = `coordinator:${assignment.idempotencyKey}`;
      const brief = `${assignment.brief}\n\nReturn the final result and acceptance evidence to ${yield* named()} through T3 thread ${card.threadId}. Submission is not completion. Direct user instructions take precedence.`;
      let base: string | undefined;
      let prefix: string | undefined;
      let target: string | null = null;
      let launched: {
        threadId: ThreadId;
        projectId: ProjectId;
        runId: RunId | null;
        status: string | null;
      };
      const { grant } = yield* supervisor
        .request("grants.resolve", {
          ...(remoteId === undefined ? { threadId: key } : {}),
          projectId: live.projectId,
          environmentId: scope.environmentId,
          assignmentId: assignment.id,
        })
        .pipe(Effect.flatMap(decodeGrant), Effect.mapError(mapError("grant")));
      const startedAt = DateTime.toEpochMillis(yield* DateTime.now);
      const dispatchedWith = () => ({
        parentThreadId: card.threadId,
        idempotencyKey: assignment.idempotencyKey,
        ...(base ? { base, prefix, target } : {}),
        // The result is checked against the grant as it was at dispatch, not as it is later.
        grant: grant && { id: grant.id, folders: grant.folders ?? [], delete: grant.delete ?? [] },
        ...touches,
        startedAt,
      });
      const runtimeMode = runtimeModeForGrant(grant);
      // Each author works in a worktree of its own; a reviewer reads in the one that holds the
      // work it reviews, or it would have to reach out of its folder for the commit.
      const author = assignment.role !== "reviewer";
      const subject = author ? undefined : assignment.reviewSubjects?.[0]?.assignmentId;
      const reviewedThread = subject ? (yield* assignmentById(subject)).receipt?.threadId : null;
      const reviewed =
        typeof reviewedThread === "string"
          ? yield* threads
              .getThreadShell(ThreadId.make(reviewedThread))
              .pipe(Effect.mapError(mapError("dispatch")))
          : null;
      const checkout = reviewed?.worktreePath ? reviewed : live;
      if (remoteId !== undefined) {
        if (!remote.resolveProject)
          return {
            status: "unsupported" as const,
            result: {
              status: "not-dispatched",
              reason: "Destination project resolution is unavailable.",
            },
          };
        const projectId = yield* remote
          .resolveProject(scope, remoteId, live.projectId)
          .pipe(Effect.mapError(mapError("destination-project")));
        launched = yield* peers
          .call(scope, ProjectToolkit.tools.t3_thread_launch, remoteId, {
            projectId,
            // Its own title, as delegated; the parent's only for work stored before it had one.
            title: (assignment.title ?? card.purpose).slice(0, 80),
            message: brief,
            modelSelection,
            runtimeMode,
            interactionMode: live.interactionMode,
            ...(author
              ? { workspaceStrategy: { type: "worktree" as const, baseRef: "HEAD" } }
              : {}),
            clientRequestId: key,
          })
          .pipe(Effect.mapError(mapError("remote-dispatch")));
      } else {
        const providerSnapshot = (yield* providers.getProviders).find(
          (item) => item.instanceId === provider,
        );
        const modelSnapshot = providerSnapshot?.models.find((item) => item.slug === model);
        if (
          !providerSnapshot ||
          !modelSnapshot ||
          !providerSnapshot.enabled ||
          !isProviderAvailable(providerSnapshot)
        )
          return {
            status: "failed" as const,
            result: {
              status: "not-dispatched",
              reason: "Exact model is unavailable; no substitution was made.",
            },
          };
        if (author) {
          const project = Option.getOrUndefined(
            yield* projects.getById(live.projectId).pipe(Effect.mapError(mapError("dispatch"))),
          )?.workspaceRoot;
          if (!project)
            return {
              status: "failed" as const,
              result: { status: "not-dispatched", reason: "The project's checkout is unknown." },
            };
          ({
            base,
            prefix,
            branch: target,
          } = yield* supervisor
            .request("results.base", {
              repository: live.worktreePath ?? project,
              ref: live.branch ?? "HEAD",
              project,
            })
            .pipe(Effect.flatMap(decodeBase), Effect.mapError(mapError("dispatch"))));
        }
        // Stored before launch: recovery from a crash or a failed step after launch keeps it, and
        // the result is checked against it.
        yield* supervisor.request("assignments.update", {
          id: assignment.id,
          receipt: dispatchedWith(),
        });
        const result = yield* threadLaunch
          .launch({
            commandId: CommandId.make(key),
            threadId: ThreadId.make(key),
            projectId: live.projectId,
            // Its own title, as delegated; the parent's only for work stored before it had one.
            title: (assignment.title ?? card.purpose).slice(0, 80),
            modelSelection,
            runtimeMode,
            interactionMode: live.interactionMode,
            workspaceStrategy: base
              ? { type: "worktree", baseRef: base }
              : checkout.worktreePath
                ? {
                    type: "existing_worktree",
                    worktreePath: checkout.worktreePath,
                    ...(checkout.branch ? { branch: checkout.branch } : {}),
                  }
                : { type: "root", ...(live.branch ? { branch: live.branch } : {}) },
            initialMessage: {
              messageId: MessageId.make(key),
              senderThreadId: live.id,
              // The host merges the change; the author only puts it where the host finds it.
              text: target
                ? `${brief}\n\nCommit your change on this thread's branch. If the repository has a pull-request host, push the branch and open a pull request for it against ${target}. Never merge it yourself.`
                : brief,
              attachments: [],
            },
            createdBy: "agent",
            creationSource: "server",
          })
          .pipe(Effect.mapError(mapError("dispatch")));
        launched = {
          threadId: result.threadId,
          projectId: live.projectId,
          runId: result.projection.runs.at(-1)?.id ?? null,
          status: result.projection.runs.at(-1)?.status ?? "submitted",
        };
      }
      const environmentId = remoteId ?? scope.environmentId;
      const cardId = `${environmentId}:${launched.threadId}`;
      yield* supervisor.request("cards.sync", {
        cards: [
          {
            id: cardId,
            threadId: launched.threadId,
            environmentId,
            projectId: launched.projectId,
            purpose: assignment.brief.slice(0, 2_000),
            status: cardStatus(launched.status ?? "submitted"),
            instructionRevision: 0,
            profileId: assignment.route.profileId,
            provider,
            model,
            effort: assignment.route.effort,
            destination,
            assignmentId: assignment.id,
          },
        ],
      });
      const receipt = {
        ...dispatchedWith(),
        threadId: launched.threadId,
        environmentId,
        projectId: launched.projectId,
        runId: launched.runId,
        status: launched.status,
      };
      return {
        status: "completed" as const,
        result: {
          status: "submitted",
          receipt,
          executionId: launched.threadId,
          cardId,
          resumeSupported: true,
        },
      };
    }
    if (action.kind === "inspect") {
      const inspectRead = (afterPosition?: number, limit = 1) =>
        remoteId
          ? peers
              .readThread(scope, remoteId, {
                threadId: targetThreadId,
                view: "activity",
                afterPosition,
                limit,
                runLimit: 1,
                maxCharsPerItem: 512,
              })
              .pipe(Effect.mapError(mapError("inspect")))
          : orchestrator
              .readThread(scope, {
                threadId: targetThreadId,
                view: "activity",
                afterPosition,
                limit,
                runLimit: 1,
                maxCharsPerItem: 512,
              })
              .pipe(Effect.mapError(mapError("inspect")));
      const overview = yield* inspectRead();
      const read =
        overview.thread.itemCount > 1
          ? yield* inspectRead(Math.max(0, overview.thread.itemCount - 9), 8)
          : overview;
      const progressMarker = completedMilestoneMarker(
        read.thread.activeRunId ?? read.thread.latestRunId,
        read.items,
      );
      return {
        status: "completed" as const,
        result: {
          status: cardStatus(read.thread.status),
          meaningfulProgress:
            read.thread.status !== card.status ||
            (progressMarker !== undefined && progressMarker !== assignment.receipt?.progressMarker),
          receipt: { ...assignment.receipt, ...(progressMarker ? { progressMarker } : {}) },
          contactConfirmed: true,
        },
      };
    }
    if (action.kind === "pause" || action.kind === "cancel") {
      const input = { threadId: targetThreadId, stop: true, clientRequestId: action.id };
      if (remoteId)
        yield* peers
          .interruptThread(scope, remoteId, input)
          .pipe(Effect.mapError(mapError("pause")));
      else
        yield* orchestrator.interruptThread(scope, input).pipe(Effect.mapError(mapError("pause")));
      // A stop request alone does not prove the destination stopped.
      const waited = remoteId
        ? yield* peers
            .waitForThread(scope, remoteId, { threadId: targetThreadId, timeoutMs: 30_000 })
            .pipe(Effect.mapError(mapError("pause-ack")))
        : yield* orchestrator
            .waitForThread(scope, { threadId: targetThreadId, timeoutMs: 30_000 })
            .pipe(Effect.mapError(mapError("pause-ack")));
      if (
        waited.timedOut ||
        ["running", "starting", "preparing", "waiting", "queued"].includes(waited.status)
      )
        return {
          status: "uncertain" as const,
          result: { reason: "Destination stop is still awaiting confirmation." },
        };
      return {
        status: "completed" as const,
        result: {
          resumeSupported: true,
          status: action.kind === "cancel" ? "cancelled" : "paused",
        },
      };
    }
    if (action.kind === "resume") {
      const sent = yield* orchestrator
        .sendToThread(scope, {
          threadId: targetThreadId,
          ...(remoteId ? { environmentId: remoteId } : {}),
          message: `Resume the paused assignment within its current instructions and permissions.\n${assignment.brief}\nReturn the final result and acceptance evidence through ${assignment.returnRoute}.`,
          clientRequestId: action.id,
        })
        .pipe(Effect.mapError(mapError("resume")));
      return {
        status: "completed" as const,
        result: {
          status: "running",
          receipt: { ...assignment.receipt, resumedRunId: sent.runId },
          executionId: assignment.executionId,
          resumeSupported: true,
        },
      };
    }
    return {
      status: "unsupported" as const,
      result: { reason: "Destination does not expose safe native resume for this assignment." },
    };
  });
  const drainUnsafe = Effect.fn("Coordinator.drainUnsafe")(function* () {
    let executed = 0;
    let cursor: string | null = null;
    do {
      const page: unknown = yield* supervisor.request("actions.list", {
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      const decoded = yield* decodeActionPage(page).pipe(Effect.mapError(mapError("actions")));
      cursor = decoded.nextCursor;
      for (const action of decoded.items) {
        if (["claimed", "uncertain"].includes(action.status) && action.kind === "dispatch") {
          const payload = yield* decodeAssignmentAction(action.payload).pipe(
            Effect.mapError(mapError("recovery")),
          );
          if (payload.assignment.route.destination === "local") {
            const shell = yield* threads
              .getThreadShell(ThreadId.make(`coordinator:${payload.assignment.idempotencyKey}`))
              .pipe(Effect.mapError(mapError("recovery")));
            if (
              shell &&
              shell.providerInstanceId === payload.assignment.route.provider &&
              shell.modelSelection.model === payload.assignment.route.model
            ) {
              yield* syncCards();
              const environmentId = yield* environment.getEnvironmentId;
              // What dispatch stored before launch: the base, grant and start it is checked by.
              const stored = yield* assignmentById(payload.assignment.id);
              yield* supervisor.request("actions.ack", {
                id: action.id,
                status: "completed",
                result: {
                  status: "submitted",
                  executionId: shell.id,
                  cardId: `${environmentId}:${shell.id}`,
                  resumeSupported: true,
                  receipt: {
                    ...stored.receipt,
                    parentThreadId: payload.card.threadId,
                    threadId: shell.id,
                    environmentId,
                    projectId: shell.projectId,
                    runId: shell.latestRunId,
                    reconciled: true,
                  },
                },
              });
            } else if (!shell)
              // Launch is idempotent on this thread id, so no thread means none was started: a
              // crash between claim and launch. Failing it ends the row, which frees its route.
              yield* supervisor.request("actions.ack", {
                id: action.id,
                status: "failed",
                result: {
                  status: "not-dispatched",
                  reason: "The thread was never created; the dispatch was interrupted.",
                },
              });
          }
          continue;
        }
        const recoverSettlement =
          ["thread.settle", "outcome.accepted"].includes(action.kind) &&
          ["claimed", "uncertain"].includes(action.status);
        if (action.status !== "pending" && !recoverSettlement) continue;
        if (executed >= 5) return;
        const claimed = yield* supervisor
          .request("actions.claim", { id: action.id })
          .pipe(Effect.result);
        if (claimed._tag === "Failure") continue;
        const claimedAction = yield* decodeClaimedAction(claimed.success).pipe(
          Effect.mapError(mapError("actions")),
        );
        // An answer waiting for room is not counted, or five of them would hold up the rest.
        if (claimedAction.claimed === false) continue;
        executed++;
        const result = yield* executeAction(claimedAction.action).pipe(
          Effect.catch((cause) =>
            Effect.succeed({ status: "uncertain" as const, result: { reason: cause.reason } }),
          ),
        );
        // A cancel the store accepts ends the assignment there, which observation then skips:
        // its round is recorded here so the cancelled rework still counts. Rounds are idempotent.
        if (action.kind === "cancel" && result.status === "completed") {
          const { assignment } = yield* decodeAssignment(action.payload).pipe(
            Effect.mapError(mapError("actions")),
          );
          const now = DateTime.toEpochMillis(yield* DateTime.now);
          yield* recordRound(assignment, now, yield* usedMicros(assignment));
        }
        yield* supervisor.request("actions.ack", { id: action.id, ...result });
        // Settled is done: a thread the Coordinator started also leaves the list, archived after
        // the store took the settlement. Unarchiving brings it back.
        if (action.kind === "thread.settle" && result.status === "completed") {
          const archived = action.threadId?.startsWith("coordinator:")
            ? yield* archiveSettled(ThreadId.make(action.threadId))
            : true;
          // Done only once both steps are; otherwise start-up recovery tries them again.
          const worktreeDone = (result.result as { worktreeDone?: boolean }).worktreeDone !== false;
          if (archived && worktreeDone)
            yield* supervisor.request("settlements.finished", { id: action.id });
        }
        yield* load();
      }
    } while (cursor);
  });
  const drain = Effect.fn("Coordinator.drain")(() => drainGate.withPermits(1)(drainUnsafe()));
  const scheduleDrain = Effect.gen(function* () {
    if (yield* Ref.getAndSet(drainScheduled, true)) return;
    yield* drain().pipe(
      Effect.andThen(load()),
      Effect.catch((cause) =>
        Effect.logWarning("Coordinator controls await destination acknowledgement", {
          reason: cause.reason,
        }),
      ),
      Effect.ensuring(Ref.set(drainScheduled, false)),
      Effect.forkIn(backgroundScope),
    );
  });
  const assignmentById = Effect.fn("Coordinator.assignmentById")(function* (id: string) {
    return (yield* supervisor
      .request("assignments.get", { id })
      .pipe(Effect.flatMap(decodeAssignment), Effect.mapError(mapError("review-assignment"))))
      .assignment;
  });
  const cloudResult = Effect.fn("Coordinator.cloudResult")(function* (
    assignment: typeof CoordinatorAssignment.Type,
  ) {
    if (!assignment.route.destination?.startsWith("cloud:") || !assignment.receipt)
      return yield* new CoordinatorError({
        operation: "cloud-history-owned-receipt",
        reason: "invalid",
      });
    const run = yield* cloud.get(assignment.id);
    const status = !run
      ? ("failed" as const)
      : run.state === "out"
        ? ("running" as const)
        : run.state === "collected" && run.head
          ? ("completed" as const)
          : run.state === "unstopped" || run.state === "ended"
            ? ("cancelled" as const)
            : ("failed" as const);
    return {
      status,
      executionId: run?.handle,
      receipt: run
        ? { executionId: run.handle, status, head: run.head, branch: run.branch }
        : undefined,
      // A proven Claude session ran exactly the recorded model and effort.
      identityVerified: status === "completed" && run?.kind === "claude-cloud",
      actualModel: run?.model ?? undefined,
      actualEffort: run?.effort ?? undefined,
      reason: run ? `The cloud run is ${run.state}.` : "No cloud run is recorded.",
    };
  });
  const deliverable = Effect.fn("Coordinator.deliverable")(function* (
    scope: McpInvocationScope,
    input: typeof CoordinatorDeliverableRead.Type,
  ) {
    yield* untilRecovered;
    if (!scope.capabilities.has("orchestration") || (input.cursor && !input.digest))
      return yield* new CoordinatorError({ operation: "deliverable", reason: "policy" });
    const assignment = yield* assignmentById(input.assignmentId);
    const { card } = yield* supervisor
      .request("cards.get", { id: assignment.cardId })
      .pipe(Effect.flatMap(decodeCard), Effect.mapError(mapError("deliverable")));
    if (
      card.projectId !== input.projectId ||
      !assignment.goalId ||
      assignment.executionId !== card.threadId ||
      !assignment.receipt
    )
      return yield* new CoordinatorError({ operation: "deliverable", reason: "policy" });
    let callerBinding: { goalId: string | null; projectId: string } | undefined;
    if (scope.thread) {
      const caller = (yield* supervisor
        .request("assignments.forThread", {
          cardId: `${scope.environmentId}:${scope.thread.threadId}`,
          idempotencyKey: scope.thread.threadId.startsWith("coordinator:")
            ? scope.thread.threadId.slice("coordinator:".length)
            : "",
        })
        .pipe(Effect.flatMap(decodeAssignment), Effect.mapError(mapError("deliverable-caller"))))
        .assignment;
      const shell = yield* threads
        .getThreadShell(scope.thread.threadId)
        .pipe(Effect.mapError(mapError("deliverable-caller")));
      if (shell) callerBinding = { goalId: caller.goalId, projectId: shell.projectId };
    }
    if (
      deliverableBlocker({
        projectId: input.projectId,
        cursor: input.cursor ?? 0,
        digest: input.digest,
        assignment: {
          goalId: assignment.goalId,
          executionId: assignment.executionId,
          cardId: assignment.cardId,
          destination: assignment.route.destination,
          hasReceipt: Boolean(assignment.receipt),
        },
        card,
        threadCaller: Boolean(scope.thread),
        caller: callerBinding,
      })
    )
      return yield* new CoordinatorError({ operation: "deliverable-scope", reason: "policy" });
    // The cloud CLIs return no final message; a run's deliverable is its pushed change.
    if (input.kind !== "patch")
      return yield* new CoordinatorError({ operation: "deliverable", reason: "unsupported" });
    const result = yield* cloud.patch({
      assignmentId: assignment.id,
      cursor: input.cursor ?? 0,
      limit: input.limit ?? 4000,
      digest: input.digest,
    });
    if (
      result.executionId !== assignment.executionId ||
      (input.digest && input.digest !== result.digest)
    )
      return yield* new CoordinatorError({
        operation: "deliverable-receipt-mismatch",
        reason: "invalid",
      });
    return result;
  });
  const sourceFacts = Effect.fn("Coordinator.sourceFacts")(function* (
    assignment: typeof CoordinatorAssignment.Type,
  ) {
    if (
      !["completed", "verified"].includes(assignment.status) ||
      !assignment.receipt ||
      assignment.route.destination !== "local" ||
      typeof assignment.receipt.threadId !== "string"
    )
      return yield* new CoordinatorError({
        operation: "review-canonical-local-receipt-required",
        reason: "invalid",
      });
    const threadId = ThreadId.make(assignment.receipt.threadId);
    const shell = yield* threads
      .getThreadShell(threadId)
      .pipe(Effect.mapError(mapError("review-source")));
    const rawRunId = assignment.receipt.latestRunId ?? assignment.receipt.runId;
    if (
      !shell ||
      typeof rawRunId !== "string" ||
      shell.latestRunId !== rawRunId ||
      shell.activeRunId ||
      shell.pendingBackgroundTasks?.length
    )
      return yield* new CoordinatorError({
        operation: "review-source-changed-or-running",
        reason: "invalid",
      });
    const runId = RunId.make(rawRunId);
    const records = yield* threads
      .getThreadRecords(threadId, ["runs", "messages", "checkpoints", "turnItems"], {
        runIds: [runId],
        messageRunIds: [runId],
        messageRoles: ["assistant"],
        turnItemRunIds: [runId],
        turnItemTypes: ["command_execution"],
      })
      .pipe(Effect.mapError(mapError("review-source")));
    const run = records.runs.find((item) => item.id === runId);
    const appliedEffort = run?.modelSelection.options
      ?.find((option) => option.id === "effort")
      ?.value?.toString();
    const executionBindingVerified = Boolean(
      run &&
      run.providerInstanceId === assignment.route.provider &&
      run.modelSelection.model === assignment.route.model &&
      // A provider with no effort option runs none, and its route records null.
      (appliedEffort ?? null) === assignment.route.effort &&
      (!assignment.route.account || assignment.route.account === run.providerInstanceId),
    );
    if (
      !executionBindingVerified ||
      (assignment.actualModel && assignment.actualModel !== assignment.route.model) ||
      (assignment.actualEffort && assignment.actualEffort !== assignment.route.effort)
    )
      return yield* new CoordinatorError({
        operation: "review-source-exact-selection-mismatch",
        reason: "invalid",
      });
    const messages = records.messages
      .filter((item) => !item.streaming)
      .toSorted(
        (left, right) =>
          DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt) ||
          left.id.localeCompare(right.id),
      );
    const checkpoints = records.checkpoints
      .filter((item) => item.runId === runId && item.status === "ready")
      .map((item) => ({ id: item.id, ref: item.ref }));
    if (run?.checkpointId && !checkpoints.some((checkpoint) => checkpoint.id === run.checkpointId))
      return yield* new CoordinatorError({
        operation: "review-canonical-checkpoint-unavailable",
        reason: "invalid",
      });
    if (
      !run ||
      run.status !== "completed" ||
      !messages.length ||
      messages.length > 32 ||
      checkpoints.length > 32 ||
      records.turnItems.length > 100
    )
      return yield* new CoordinatorError({
        operation: "review-evidence-unavailable-or-exceeds-bound",
        reason: "invalid",
      });
    const content = yield* encodeJson({
      assignmentId: assignment.id,
      executionId: runId,
      receipt: assignment.receipt,
      run,
      checkpoints,
      messages: messages.map((item) => ({
        id: item.id,
        text: item.text,
        attachments: item.attachments,
      })),
    }).pipe(Effect.mapError(mapError("review-digest")));
    if (content.length > 128_000)
      return yield* new CoordinatorError({
        operation: "review-evidence-exceeds-bound",
        reason: "invalid",
      });
    const evidenceIds = [
      ...messages.map((item) => item.id as string),
      ...checkpoints.map((item) => item.id as string),
      ...records.turnItems.flatMap((item) =>
        item.type === "command_execution" &&
        item.status === "completed" &&
        item.exitCode === 0 &&
        item.outputIndicatesFailure !== true
          ? [item.id as string]
          : [],
      ),
    ];
    return {
      subject: {
        assignmentId: assignment.id,
        executionId: runId as string,
        digest: NodeCrypto.createHash("sha256").update(content).digest("hex"),
      },
      threadId: threadId as string,
      executionBindingVerified,
      evidenceIds,
      commandEvidenceIds: records.turnItems.flatMap((item) =>
        item.type === "command_execution" &&
        item.status === "completed" &&
        item.exitCode === 0 &&
        item.outputIndicatesFailure !== true
          ? [item.id as string]
          : [],
      ),
      finalText: messages.at(-1)!.text,
    };
  });
  const goalDigest = (goal: typeof CoordinatorGoal.Type) =>
    encodeJson({
      id: goal.id,
      purpose: goal.purpose,
      acceptanceCriteria: goal.acceptanceCriteria ?? [],
      dependencies: goal.dependencies ?? [],
      authorizedScope: goal.authorizedScope ?? [],
    }).pipe(
      Effect.map((value) => NodeCrypto.createHash("sha256").update(value).digest("hex")),
      Effect.mapError(mapError("review-goal-digest")),
    );
  const supersessionFacts = Effect.fn("Coordinator.supersessionFacts")(function* (
    goalId: string,
    roots: ReadonlyArray<{
      readonly id: string;
      readonly supersedes?: ReadonlyArray<string> | undefined;
    }>,
  ) {
    const queue = roots.flatMap((replacement) =>
      (replacement.supersedes ?? []).map((assignmentId) => ({
        assignmentId,
        replacementAssignmentId: replacement.id,
      })),
    );
    const seen = new Set<string>();
    const facts = [];
    while (queue.length) {
      const edge = queue.shift()!;
      const key = `${edge.replacementAssignmentId}:${edge.assignmentId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (seen.size > 32)
        return yield* new CoordinatorError({
          operation: "review-supersession-bound",
          reason: "invalid",
        });
      const old = yield* assignmentById(edge.assignmentId);
      if (old.goalId !== goalId || !["completed", "failed", "cancelled"].includes(old.status))
        return yield* new CoordinatorError({
          operation: "review-supersession-terminal-goal",
          reason: "invalid",
        });
      let canonical: unknown = null;
      if (old.route.destination?.startsWith("cloud:") && old.receipt) {
        const result = yield* cloudResult(old);
        if (
          !["completed", "failed", "cancelled"].includes(result.status) ||
          result.executionId !== old.executionId ||
          !result.receipt
        )
          return yield* new CoordinatorError({
            operation: "review-cloud-terminal-receipt",
            reason: "invalid",
          });
        canonical = {
          receipt: result.receipt,
          status: result.status,
          actualModel: result.actualModel,
          actualEffort: result.actualEffort,
          identityVerified: result.identityVerified,
        };
      } else if (
        old.route.destination === "local" &&
        old.receipt &&
        typeof old.receipt.threadId === "string"
      ) {
        const runId = old.receipt.latestRunId ?? old.receipt.runId;
        if (typeof runId !== "string")
          return yield* new CoordinatorError({
            operation: "review-superseded-source-run",
            reason: "invalid",
          });
        const records = yield* threads
          .getThreadRecords(ThreadId.make(old.receipt.threadId), ["runs", "checkpoints"], {
            runIds: [RunId.make(runId)],
          })
          .pipe(Effect.mapError(mapError("review-superseded-source")));
        const run = records.runs.find((item) => item.id === runId);
        if (!run || !["completed", "failed", "cancelled", "interrupted"].includes(run.status))
          return yield* new CoordinatorError({
            operation: "review-superseded-terminal-run",
            reason: "invalid",
          });
        canonical = {
          run,
          checkpoints: records.checkpoints
            .filter((checkpoint) => checkpoint.runId === runId)
            .map((checkpoint) => ({
              id: checkpoint.id,
              ref: checkpoint.ref,
              status: checkpoint.status,
            })),
        };
      } else if (old.status === "completed" || old.route.destination?.startsWith("remote:"))
        return yield* new CoordinatorError({
          operation: "review-superseded-source-unsupported",
          reason: "unsupported",
        });
      const encoded = yield* encodeJson({
        id: old.id,
        goalId: old.goalId,
        status: old.status,
        executionId: old.executionId,
        receipt: old.receipt,
        canonical,
        supersedes: old.supersedes ?? [],
      }).pipe(Effect.mapError(mapError("review-superseded-digest")));
      facts.push({
        ...edge,
        digest: NodeCrypto.createHash("sha256").update(encoded).digest("hex"),
        sourceRevision: old.revision,
        status: old.status,
        executionId: old.executionId,
      });
      queue.push(
        ...(old.supersedes ?? []).map((assignmentId) => ({
          assignmentId,
          replacementAssignmentId: old.id,
        })),
      );
    }
    return facts;
  });
  // Where an author's reviewed work is checked out: its worktree, or for a cloud run the project's
  // checkout its result was collected into. None once a local worktree is gone.
  const authorCheckout = Effect.fn("Coordinator.authorCheckout")(function* (
    owner: typeof CoordinatorAssignment.Type,
  ) {
    const receipt = owner.receipt ?? {};
    if (typeof receipt.projectId !== "string") return undefined;
    const project = Option.getOrUndefined(
      yield* projects
        .getById(ProjectId.make(receipt.projectId))
        .pipe(Effect.mapError(mapError("merge-project"))),
    );
    if (!project) return undefined;
    const cloudRun = owner.route.destination?.startsWith("cloud:") === true;
    const shell =
      !cloudRun && typeof receipt.threadId === "string"
        ? yield* threads
            .getThreadShell(ThreadId.make(receipt.threadId))
            .pipe(Effect.mapError(mapError("merge-thread")))
        : null;
    const cwd = cloudRun ? project.workspaceRoot : shell?.worktreePath;
    if (!cwd) return undefined;
    const prefix = typeof receipt.prefix === "string" ? receipt.prefix : "";
    return {
      project,
      cwd,
      branch: cloudRun
        ? typeof receipt.branch === "string"
          ? receipt.branch
          : null
        : (shell?.branch ?? null),
      // The project's folder sits `prefix` deep in its repository.
      repository: path.resolve(
        project.workspaceRoot,
        ...prefix
          .split("/")
          .filter(Boolean)
          .map(() => ".."),
      ),
    };
  });
  // Whose branch a merge or revert moves: the author's thread and the thread its target branch
  // came from must be the Coordinator's own or ones it started, unless it may manage others.
  const mayMoveBranches = Effect.fn("Coordinator.mayMoveBranches")(function* (
    owner: typeof CoordinatorAssignment.Type,
  ) {
    const { configuration } = yield* Ref.get(snapshotRef);
    const managed = (threadId: unknown) =>
      typeof threadId === "string" &&
      (threadId === configuration.coordinatorThreadId ||
        threadId.startsWith("coordinator:") ||
        configuration.manageOtherThreads === true);
    const receipt = owner.receipt ?? {};
    const cloudRun = owner.route.destination?.startsWith("cloud:") === true;
    return (cloudRun || managed(receipt.threadId)) && managed(receipt.parentThreadId);
  });
  const checkResult = (assignmentId: string, repository: string, head: string) =>
    supervisor
      .request("results.check", { assignmentId, repository, head })
      .pipe(Effect.flatMap(decodeResultCheck), Effect.mapError(mapError("result-check")));
  // What of an author's reviewed work is merged and into what; none when it changed nothing.
  const mergeTarget = Effect.fn("Coordinator.mergeTarget")(function* (
    owner: typeof CoordinatorAssignment.Type,
  ) {
    const receipt = owner.receipt ?? {};
    if (typeof receipt.base !== "string") return undefined;
    const checkout = yield* authorCheckout(owner);
    if (!checkout) return "The author's checkout is gone, so its change cannot be merged.";
    const { resultCheck } = yield* checkResult(
      owner.id,
      checkout.cwd,
      typeof receipt.head === "string" ? receipt.head : "HEAD",
    );
    if (!resultCheck.passed) return "The author's change left its grant; it waits for the owner.";
    // Work left uncommitted is not delivered, and not nothing either.
    if (owner.route.destination === "local") {
      const { clean } = yield* supervisor
        .request("results.clean", { repository: checkout.cwd, ignored: false })
        .pipe(Effect.flatMap(decodeClean), Effect.mapError(mapError("result-check")));
      if (!clean)
        return "The author left work uncommitted in its worktree; tell its thread to commit it, then review again.";
    }
    if (resultCheck.head === resultCheck.base) return undefined;
    if (typeof receipt.target !== "string")
      return "The author's change has no branch to merge into.";
    return {
      head: resultCheck.head,
      target: receipt.target,
      repository: checkout.repository,
      projectId: checkout.project.id,
      ...(checkout.branch ? { branch: checkout.branch } : {}),
    };
  });
  // In the board's order, each reviewed change merges once its host allows; one waiting never holds
  // back the others. The result check runs again on the very commit that merges.
  // With `asked`, the owner's go-ahead for that goal, whatever its project's switch says; a project
  // whose automatic merge is off otherwise leaves its changes in the owner's strip.
  const mergeReviewed = Effect.fn("Coordinator.mergeReviewed")(function* (asked?: string) {
    const { items } = yield* supervisor
      .request("merges.list", {})
      .pipe(Effect.flatMap(decodeMerges), Effect.mapError(mapError("merges")));
    const manual = (yield* Ref.get(snapshotRef)).configuration.manualMergeProjects ?? [];
    for (const item of items) {
      if (asked !== undefined && item.goalId !== asked) continue;
      // The store tells the Coordinator when what a merge waits for changes.
      // `merge`: the owner's go-ahead (goal.merge) is all it waits for.
      const wait = (reason: string, owner = false, action?: "merge") =>
        supervisor.request("merges.wait", {
          id: item.goalId,
          reason,
          owner,
          ...(action ? { action } : {}),
        });
      yield* Effect.gen(function* () {
        const owner = yield* assignmentById(item.assignmentId);
        const checkout = yield* authorCheckout(owner);
        // Merged by anyone, the owner by hand included, is merged: read before anything that
        // would hold the merge back, which holds back only the act of merging.
        const project =
          checkout?.project ??
          (item.target.projectId
            ? Option.getOrUndefined(
                yield* projects
                  .getById(ProjectId.make(item.target.projectId))
                  .pipe(Effect.mapError(mapError("merge-project"))),
              )
            : undefined);
        const landed = project
          ? yield* merges.landed({
              projectId: project.id,
              repository: item.target.repository,
              cwd: checkout?.cwd ?? project.workspaceRoot,
              branch: checkout?.branch ?? item.target.branch ?? null,
              head: item.target.head,
              target: item.target.target,
              hosted: Boolean(project.repositoryIdentity?.provider),
              message: "",
            })
          : null;
        // At the reviewed head it is the reviewed merge. At another, the code is on the target all
        // the same, so the goal is done; the record says which head landed and that no review saw
        // it, and the owner is told.
        if (landed?.merged)
          return yield* supervisor.request(
            "goals.merged",
            landed.head
              ? { id: item.goalId, head: landed.head, byHand: true, how: landed.how }
              : {
                  id: item.goalId,
                  head: item.target.head,
                  hostVerified: true,
                  how: { ...landed.how, byHand: true },
                },
          );
        if (asked === undefined && manual.includes(item.target.projectId ?? ""))
          return yield* wait(
            "Automatic merge is off in this project; it waits for you under Needs you.",
            true,
            "merge",
          );
        // The owner's go-ahead is their word on whose branch moves.
        if (asked === undefined && !(yield* mayMoveBranches(owner)))
          return yield* wait(
            `The change lands on a branch of a thread ${yield* named()} did not start; merge it, or let it manage other threads.`,
            true,
            "merge",
          );
        if (!checkout)
          return yield* wait(
            "The author's checkout is gone, so its change cannot be merged.",
            true,
          );
        const { resultCheck } = yield* checkResult(owner.id, checkout.cwd, item.target.head);
        if (!resultCheck.passed)
          return yield* wait(
            "The change left its grant; it waits for the owner and is not merged.",
            true,
          );
        const outcome = yield* merges.merge({
          projectId: checkout.project.id,
          repository: item.target.repository,
          cwd: checkout.cwd,
          branch: checkout.branch,
          head: item.target.head,
          target: item.target.target,
          hosted: Boolean(checkout.project.repositoryIdentity?.provider),
          message: `Merge reviewed work of goal ${item.goalId}`,
        });
        // The author pushed past the reviewed commit (a rebase, a fix): once it is done, the goal
        // goes back to review of the new head, and merges when that review passes.
        if (!outcome.merged && outcome.moved) {
          const moved = outcome.moved;
          const stillWorking = () =>
            wait(
              "The author is still working past the reviewed commit; it goes back to review once done.",
            );
          // Only the author's own push sends it back to review, and only once: then the review,
          // and the merge after it, are of that head. A push by anyone else is the owner's.
          const someoneElse = () =>
            wait(
              `Someone else pushed past the reviewed commit: the pull request is at ${moved}, which the author's work is not. Review or merge it yourself.`,
              true,
            );
          // A cloud run has no thread to read: its run record says whether it still runs and
          // what it last pushed. One out, or cancelled but unstoppable, may still push; one ended,
          // collected or lost (stalled) does not work on.
          if (owner.route.destination?.startsWith("cloud:")) {
            const run = yield* cloud.get(owner.id);
            if (!run || ["out", "unstopped"].includes(run.state)) return yield* stillWorking();
            if ((run.branchHead ?? run.head) !== moved) return yield* someoneElse();
            return yield* supervisor.request("merges.rereview", {
              id: item.goalId,
              latestRunId: run.handle || owner.executionId || owner.id,
              head: moved,
              hostVerified: true,
            });
          }
          const shell =
            typeof owner.receipt?.threadId === "string"
              ? yield* threads
                  .getThreadShell(ThreadId.make(owner.receipt.threadId))
                  .pipe(Effect.mapError(mapError("merge-thread")))
              : null;
          if (
            !shell?.latestRunId ||
            shell.activeRunId ||
            shell.pendingRuntimeRequest ||
            shell.pendingBackgroundTasks?.length
          )
            return yield* stillWorking();
          const { base: authorHead } = yield* supervisor
            .request("results.base", {
              repository: checkout.cwd,
              ref: "HEAD",
              project: checkout.cwd,
            })
            .pipe(Effect.flatMap(decodeBase), Effect.mapError(mapError("merge-author-head")));
          if (authorHead !== moved) return yield* someoneElse();
          return yield* supervisor.request("merges.rereview", {
            id: item.goalId,
            latestRunId: shell.latestRunId,
            hostVerified: true,
          });
        }
        if (!outcome.merged) return yield* wait(outcome.waiting, outcome.owner === true);
        yield* supervisor.request("goals.merged", {
          id: item.goalId,
          head: item.target.head,
          hostVerified: true,
          how: outcome.how,
        });
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Coordinator could not merge a reviewed goal", {
            goalId: item.goalId,
            cause,
          }),
        ),
      );
    }
  });
  // The owner's "revert this goal": a revert pull request for its merge and each merge built on
  // it, newest first. Each reverted route's outcome is marked, which doubles its cost.
  const revertGoal = Effect.fn("Coordinator.revertGoal")(function* (goalId: string) {
    const { items } = yield* supervisor
      .request("merges.reverts", { id: goalId, actor: "user" })
      .pipe(Effect.flatMap(decodeReverts), Effect.mapError(mapError("revert")));
    for (const item of items) {
      const pullRequest = item.merged.how?.pullRequest;
      const owner = yield* assignmentById(item.assignmentId);
      const projectId = owner.receipt?.projectId;
      // An older change is never taken back from under a newer one still in.
      if (!pullRequest || typeof projectId !== "string" || !(yield* mayMoveBranches(owner)))
        return yield* supervisor.request("decisions.record", {
          decision: {
            id: `revert-waiting:${goalId}`,
            summary: `Revert goal ${item.goalId} (${item.merged.head ?? item.target.head} on ${item.target.target}) yourself: it merged with no pull request, or onto a thread ${yield* named()} does not manage. Nothing older was reverted.`,
            provenance: "coordinator-merge",
            cardIds: [],
            goalIds: [...new Set([goalId, item.goalId])],
          },
        });
      // Found again rather than opened again when an earlier attempt stopped part way.
      const opened = yield* merges.revert({ projectId: ProjectId.make(projectId), ...pullRequest });
      const { event } = yield* decodeAcceptedOutcome(item.feedback.payload).pipe(
        Effect.mapError(mapError("revert")),
      );
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      for (const subject of event.subjects) {
        const round = outcomeRound({
          id: `reverted:${subject.assignmentId}`,
          goalId: item.goalId,
          route: subject.route,
          rank: subject.rank,
          startedAt: now,
          endedAt: now,
          usedMicros: 0,
          finish: "reverted",
        });
        if (round) yield* supervisor.request("outcomes.record", { round });
      }
      yield* supervisor.request("merges.reverted", {
        id: item.goalId,
        hostVerified: true,
        how: { pullRequest, revert: opened },
      });
    }
  });
  const resolveGoal = Effect.fn("Coordinator.resolveGoal")(function* (
    goal: typeof CoordinatorGoal.Type,
    reviewerId: string,
  ) {
    let rejectedSubjects: (typeof ReviewReport.Type)["subjects"] | undefined;
    const outcome = yield* Effect.gen(function* () {
      const reviewer = yield* assignmentById(reviewerId);
      if (
        reviewer.goalId !== goal.id ||
        reviewer.role !== "reviewer" ||
        !reviewer.reviewSubjects?.length
      )
        return "A separate reviewer assignment with canonical source bindings is required.";
      const facts = yield* sourceFacts(reviewer);
      const sources = [];
      const sourceAssignments = [];
      for (const subject of reviewer.reviewSubjects) {
        const source = yield* assignmentById(subject.assignmentId);
        if (
          source.goalId !== goal.id ||
          source.id === reviewer.id ||
          source.cardId === reviewer.cardId
        )
          return "Self review or unrelated source assignment is forbidden.";
        sources.push(yield* sourceFacts(source));
        sourceAssignments.push(source);
      }
      const supersessions = (yield* supersessionFacts(goal.id, [
        ...sourceAssignments,
        reviewer,
      ])).map(({ assignmentId, replacementAssignmentId, digest, sourceRevision }) => ({
        assignmentId,
        replacementAssignmentId,
        digest,
        sourceRevision,
      }));
      const report = reviewReport(facts.finalText);
      if (!report)
        return "The review's final message holds no report, or more than one: it must contain exactly one JSON report in the format its brief gave.";
      const reviewInput = {
        report,
        goalId: goal.id,
        goalDigest: yield* goalDigest(goal),
        reviewerAssignmentId: reviewer.id,
        criteriaCount: goal.acceptanceCriteria?.length ?? 0,
        subjects: sources.map((item) => item.subject),
        supersessions,
        evidenceIds: new Set([
          ...facts.commandEvidenceIds,
          ...sources.flatMap((item) => item.evidenceIds),
        ]),
      };
      if (reviewer.reviewGoalDigest !== report.goalDigest)
        return "Review was prepared for a different user goal.";
      if (reviewRejected(reviewInput)) rejectedSubjects = reviewInput.subjects;
      const blocker = reviewBlocker(reviewInput);
      if (blocker) return blocker;
      const merge = yield* mergeTarget(yield* assignmentById(report.integration.ownerAssignmentId));
      if (typeof merge === "string") return merge;
      // Re-read after canonical reads; Rust compares the goal revision atomically before changing any state.
      yield* supervisor.request("goals.resolve", {
        ...(merge ? { merge } : {}),
        id: goal.id,
        expectedGoalRevision: goal.revision,
        hostVerified: true,
        reviewerAssignmentId: reviewer.id,
        reviewerReceipt: facts.subject,
        subjects: sources.map((item) => item.subject),
        supersessions,
        integrationOwner: report.integration.ownerAssignmentId,
        evidence: [
          `review:${reviewer.id}:${facts.subject.executionId}:${facts.subject.digest}`,
          ...report.integration.evidenceIds,
          ...report.criteria.flatMap((item) => item.evidenceIds),
        ].slice(0, 32),
      });
      return undefined;
    }).pipe(
      Effect.catch((cause) =>
        Effect.succeed(
          `Independent review is pending: ${cause.operation ?? "canonical evidence unavailable"}.`,
        ),
      ),
    );
    if (outcome) {
      yield* supervisor.request("decisions.record", {
        decision: {
          id: `review-blocked:${goal.id}`,
          summary: outcome,
          provenance: "canonical-independent-review",
          cardIds: [],
          goalIds: [goal.id],
        },
      });
      yield* supervisor.request("goals.block", {
        id: goal.id,
        expectedGoalRevision: goal.revision,
        ...(rejectedSubjects
          ? {
              repairSources: rejectedSubjects,
              reviewerAssignmentId: reviewerId,
              hostVerifiedRejection: true,
            }
          : {}),
      });
      // A rejected change fails the outcome of the route that wrote it.
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      for (const subject of rejectedSubjects ?? []) {
        const source = yield* assignmentById(subject.assignmentId);
        const round = outcomeRound({
          id: `rejected:${reviewerId}:${source.id}`,
          goalId: goal.id,
          route: source.route,
          rank: source.rank ?? "B",
          startedAt: now,
          endedAt: now,
          usedMicros: 0,
          finish: "failed",
        });
        if (round) yield* supervisor.request("outcomes.record", { round });
      }
    }
  });
  // A snapshot holds only the first page of active and blocked goals; execution reads any other.
  const goalById = Effect.fn("Coordinator.goalById")(function* (
    current: CoordinatorSnapshot,
    id: string,
  ) {
    const listed = current.goals.find((item) => item.id === id);
    if (listed) return listed;
    const stored = yield* supervisor
      .request("goals.get", { id })
      .pipe(Effect.flatMap(decodeSavedGoal), Effect.result);
    return stored._tag === "Success" &&
      ["active", "blocked"].includes(stored.success.goal.status ?? "")
      ? stored.success.goal
      : undefined;
  });
  const executeDelegate = Effect.fn("Coordinator.executeDelegate")(function* (
    action: CoordinatorDelegateAction,
    baseline: CoordinatorSnapshot,
    routingIntentId?: string,
    planned: ReadonlyArray<{ id: string; threadId: string; instructionRevision: number }> = [],
  ) {
    const current = yield* load();
    if (
      !current.configuration.enabled ||
      current.pause.active ||
      current.configuration.coordinatorPaused
    )
      return;
    const threadId = action.parentThreadId;
    const seen = planned.find((item) => item.threadId === threadId);
    let card = current.cards.find((item) => item.threadId === threadId);
    // The parent's card can lie beyond the snapshot's first page.
    if (!card) {
      const stored = yield* supervisor
        .request("cards.get", {
          id: seen?.id ?? `${yield* environment.getEnvironmentId}:${threadId}`,
        })
        .pipe(Effect.flatMap(decodeCard), Effect.result);
      if (stored._tag === "Success") card = stored.success.card;
    }
    // A queued delegation holds the revision it was asked against; the thread's own is asked now.
    const old = seen ?? baseline.cards.find((item) => item.id === card?.id) ?? card;
    if (!card || card.archived || !old || card.instructionRevision !== old.instructionRevision) {
      if (routingIntentId)
        yield* supervisor.request("routing.cancel", {
          id: routingIntentId,
          reason: "Source chat is unavailable, archived, or changed by its user.",
        });
      return;
    }
    const live = yield* threads
      .getThreadShell(ThreadId.make(threadId))
      .pipe(Effect.mapError(mapError("instruction-check")));
    if (live === null) {
      if (routingIntentId)
        yield* supervisor.request("routing.cancel", {
          id: routingIntentId,
          reason: "Source T3 chat no longer exists.",
        });
      return;
    }
    const instructionRevision = live.latestUserAuthoredMessageAt
      ? DateTime.toEpochMillis(live.latestUserAuthoredMessageAt)
      : 0;
    // A delegation asked now is asked against the newest message, which only a cycle carries to
    // the card, and the store queues work only against the card's revision. A Coordinator turn
    // asked for before that message has not read it, so its delegation stays dropped.
    const coordinatorThreadId = current.configuration.coordinatorThreadId;
    const turn =
      routingIntentId || !coordinatorThreadId || instructionRevision <= card.instructionRevision
        ? null
        : coordinatorThreadId === threadId
          ? live
          : yield* threads
              .getThreadShell(ThreadId.make(coordinatorThreadId))
              .pipe(Effect.mapError(mapError("instruction-check")));
    if (
      turn?.latestRunRequestedAt &&
      DateTime.toEpochMillis(turn.latestRunRequestedAt) >= instructionRevision
    ) {
      card = { ...card, instructionRevision };
      // Only the revision: the rest of this card was read earlier, and a sync overwrites what it names.
      yield* supervisor.request("cards.sync", { cards: [{ id: card.id, instructionRevision }] });
    }
    if (instructionRevision !== card.instructionRevision) {
      if (routingIntentId)
        yield* supervisor.request("routing.cancel", {
          id: routingIntentId,
          reason: "Direct user instructions superseded the queued delegation.",
        });
      return;
    }
    const goal = yield* goalById(current, action.goalId);
    const scope = goal?.authorizedScope ?? [];
    if (
      !goal ||
      !scope.some(
        (item) =>
          item === card.id ||
          item === card.threadId ||
          item === card.projectId ||
          item === card.environmentId,
      )
    )
      return;
    if (
      action.reviewSubjects?.length &&
      (action.role !== "reviewer" || !goal.acceptanceCriteria?.length)
    )
      return;
    const queued = routingIntentId
      ? { routingIntent: { id: routingIntentId } }
      : yield* supervisor
          .request("routing.enqueue", {
            id: yield* uuid(),
            goalId: goal.id,
            cardId: card.id,
            instructionRevision,
            intent: action,
          })
          .pipe(Effect.flatMap(decodeRoutingIntent), Effect.mapError(mapError("routing-enqueue")));
    const claimedRouting = yield* supervisor
      .request("routing.claim", { id: queued.routingIntent.id })
      .pipe(Effect.flatMap(decodeRoutingIntent), Effect.mapError(mapError("routing-claim")));
    if (!claimedRouting.claimed || !claimedRouting.routingIntent.reservationKey) return;
    const routingAttempt = claimedRouting.routingIntent;
    const assignmentId = routingAttempt.id;
    const reviewFacts = [];
    if (action.reviewSubjects?.length) {
      if (action.role !== "reviewer" || !goal.acceptanceCriteria?.length) return;
      for (const id of action.reviewSubjects) {
        const subject = yield* assignmentById(id);
        if (subject.goalId !== goal.id || subject.role === "reviewer") {
          yield* supervisor.request("routing.cancel", {
            id: assignmentId,
            reason: "Review subject is unrelated or is itself a reviewer.",
          });
          return;
        }
        reviewFacts.push(yield* sourceFacts(subject));
      }
    }
    const reviewedRoots = yield* Effect.forEach(reviewFacts, (facts) =>
      assignmentById(facts.subject.assignmentId),
    );
    const supersessionDetails = reviewFacts.length
      ? yield* supersessionFacts(goal.id, [
          ...reviewedRoots,
          { id: assignmentId, supersedes: action.supersedes },
        ])
      : [];
    const reviewSupersessions = supersessionDetails.map(
      ({ assignmentId, replacementAssignmentId, digest, sourceRevision }) => ({
        assignmentId,
        replacementAssignmentId,
        digest,
        sourceRevision,
      }),
    );
    const reviewInstructions = reviewFacts.length
      ? yield* encodeJson({
          goalId: goal.id,
          goalDigest: yield* goalDigest(goal),
          reviewerAssignmentId: assignmentId,
          purpose: goal.purpose,
          supersessionDetails,
          acceptanceCriteria: goal.acceptanceCriteria,
          sources: reviewFacts.map(({ subject, threadId, evidenceIds }) => ({
            ...subject,
            threadId,
            evidenceIds,
          })),
          reportFormat: {
            protocolVersion: 1,
            goalId: goal.id,
            goalDigest: yield* goalDigest(goal),
            reviewerAssignmentId: assignmentId,
            subjects: reviewFacts.map((item) => item.subject),
            supersessions: reviewSupersessions,
            accepted: true,
            purposeSatisfied: true,
            criteria: [
              {
                index: 0,
                passed: true,
                evidenceIds: [
                  "canonical source message/checkpoint or successful reviewer command item ID",
                ],
              },
            ],
            integration: {
              ownerAssignmentId: reviewFacts[0]!.subject.assignmentId,
              passed: true,
              evidenceIds: ["canonical evidence ID"],
            },
            summary: "Describe actual verification and any limitations.",
          },
        }).pipe(Effect.mapError(mapError("review-instructions")))
      : "";
    const brief =
      action.task +
      (reviewInstructions
        ? `\n\nIndependent verification only: do not modify the source work. Explicitly assess any terminal failed/cancelled/obsolete attempt replacement lineage below; approving replacement never declares the old run successful. Inspect the exact canonical source executions; check the entire original user purpose as well as every criterion and integration; reject criteria that omit any original requirement. If anything fails, report accepted:false. End with a final message that contains exactly one JSON report, using the format and exact bindings below: the host reads only that message, and a final message with no report or with two is no review. A submission or completed status is not verification. Cite only source evidence IDs or successful command item IDs from your own execution.\n${reviewInstructions}`
        : "");
    if (brief.length > 16_000) {
      yield* supervisor.request("routing.cancel", {
        id: assignmentId,
        reason:
          "Delegation exceeds the bounded review packet; split it into smaller verification tasks.",
      });
      return;
    }
    const override = yield* supervisor.request("overrides.resolve", {
      assignmentId,
      threadId: card.threadId,
      projectId: card.projectId,
      environmentId: card.environmentId,
    });
    const pin = yield* decodeSelection(override).pipe(Effect.mapError(mapError("override")));
    const providerRows = yield* providers.getProviders;
    const nativeThreads = yield* activeShells("capacity-occupancy");
    const wait = (reason: string) =>
      // The store refuses a routing reason over 1,000 characters.
      supervisor.request("routing.defer", { id: assignmentId, reason: reason.slice(0, 1000) });
    const board = yield* supervisor
      .request("board.next", {})
      .pipe(Effect.flatMap(decodeBoard), Effect.mapError(mapError("board")));
    const held = board.waiting.find((item) => item.goalId === goal.id);
    // A review is what lets finished work land, so the board never holds one back.
    if (held && !reviewFacts.length) {
      yield* wait(`Waiting: ${held.reason}`);
      return;
    }
    const ownerRunning = new Map<string, number>();
    for (const item of nativeThreads)
      if (
        (item.activeRunId !== null || Boolean(item.pendingBackgroundTasks?.length)) &&
        !item.id.startsWith("coordinator:")
      )
        ownerRunning.set(
          item.providerInstanceId,
          (ownerRunning.get(item.providerInstanceId) ?? 0) + 1,
        );
    for (const allowance of allowances(providerRows))
      yield* supervisor.request("allowance.record", { allowance });
    const ladder = board.next.find((item) => item.goalId === goal.id)?.ladder;
    const authors = reviewedRoots.flatMap(({ route }) =>
      route.model
        ? [
            {
              model: route.model,
              effort: routeEffort(route),
              family: familyOf(providerRows, route.provider ?? null),
            },
          ]
        : [],
    );
    const limits = board.capacity.limits;
    const machine = yield* readMachine;
    let selected: typeof CoordinatorRouteSelection.Type | undefined;
    let refusal = "No catalog route can take this goal.";
    for (const pool of routeCandidates({
      catalog: current.catalog,
      configuration: current.configuration,
      providers: providerRows,
      projectId: card.projectId,
      environmentId: card.environmentId,
      pin: pin.selection,
      target: action.target,
      ladder,
      perLogin: limits.perLogin,
      ownerRunning,
    })) {
      const scored = yield* supervisor
        .request("router.score", {
          request: {
            rank: action.rank ?? "B",
            candidates: pool.map((item) => item.candidate),
            minScore: ladder?.minScore ?? null,
            minTier: ladder?.minTier ?? 0,
            // Read at each dispatch: cloud runs never count against this machine.
            localSlots: machineSlots({
              cpus: NodeOS.availableParallelism(),
              ...machine,
              ownerLimit: limits.localSlots,
            }),
            reviewOf: authors,
          },
        })
        .pipe(Effect.flatMap(decodeScore), Effect.mapError(mapError("route")));
      const pick = scored.pick;
      selected = pick
        ? pool.find(
            ({ candidate }) =>
              candidate.instance === pick.instance &&
              candidate.model === pick.model &&
              candidate.effort === pick.effort &&
              candidate.destination === pick.destination,
          )?.route
        : undefined;
      if (selected) break;
      refusal = scored.scores[0]?.reason ?? refusal;
    }
    if (!selected) {
      yield* wait(`Waiting for a route: ${refusal}`);
      yield* supervisor.request("decisions.record", {
        decision: {
          id: `routing:${assignmentId}`,
          summary: `Dispatch is waiting for a route: ${refusal}`,
          provenance: "coordinator-router",
          cardIds: [card.id],
          goalIds: [goal.id],
        },
      });
      return;
    }
    // The Rust outbox is the dispatch gate. Its durable claim is checked again before T3 accepts work.
    const prepared = yield* supervisor
      .request("assignments.prepare", {
        routingIntentId: assignmentId,
        routingGeneration: routingAttempt.generation,
        assignment: {
          id: assignmentId,
          idempotencyKey: assignmentId,
          cardId: card.id,
          goalId: goal.id,
          route: selected,
          instructionRevision,
          pauseRevision: routingAttempt.pauseRevision,
          grantRevision: routingAttempt.grantRevision,
          // The live assignment row holds the route's capacity until it ends, across restarts.
          reservation: {
            id: `reservation:${assignmentId}`,
            owner: `t3:${card.environmentId}`,
            expiresAt: DateTime.toEpochMillis(yield* DateTime.now) + RESERVATION_MS,
            policyRevision: String(routingAttempt.grantRevision),
            sharedCapacity: true,
          },
          brief,
          title: action.title,
          rank: action.rank ?? "B",
          role: action.role ?? "adventurer",
          skills: action.skills ?? [],
          reviewSubjects: reviewFacts.map((item) => item.subject),
          reviewGoalDigest: reviewFacts.length ? yield* goalDigest(goal) : null,
          supersedes: action.supersedes ?? [],
          reviewSupersessions,
          returnRoute: `T3 thread ${threadId}`,
          resumeSupported: false,
        },
      })
      .pipe(
        Effect.flatMap((raw) => decodePrepared(raw).pipe(Effect.mapError(mapError("prepare")))),
        Effect.result,
      );
    // A limit refuses and writes nothing, a cap answers blocked; both wait with their reason.
    // A lost reply that did commit is found by the defer, which then marks the intent prepared.
    if (prepared._tag === "Failure") yield* wait(`Waiting: ${nativeReason(prepared.failure)}`);
    else if (prepared.success.capped && prepared.success.reason)
      yield* wait(`Waiting: ${prepared.success.reason}`);
    else if (prepared.success.blocked)
      yield* supervisor.request("routing.cancel", {
        id: assignmentId,
        reason: "Repair requires source lineage or an explicit user extension.",
      });
  });
  const retryRouting = Effect.fn("Coordinator.retryRouting")(function* () {
    const ready = yield* supervisor
      .request("routing.ready", { limit: 5 })
      .pipe(Effect.flatMap(decodeRoutingReady), Effect.mapError(mapError("routing-ready")));
    if (ready.items.length === 0) return;
    // Waiting work starts in the board's order: what unblocks the most, then what waited longest.
    const { next } = yield* supervisor
      .request("board.next", {})
      .pipe(Effect.flatMap(decodeBoard), Effect.mapError(mapError("board")));
    const place = (goalId: string) => {
      const index = next.findIndex((item) => item.goalId === goalId);
      return index < 0 ? next.length : index;
    };
    for (const entry of ready.items.toSorted((a, b) => place(a.goalId) - place(b.goalId))) {
      yield* Effect.gen(function* () {
        const action = yield* decodeDelegateAction(entry.intent).pipe(
          Effect.mapError(mapError("routing-intent")),
        );
        const baseline = yield* load();
        // The intent records the parent card and revision it was asked against.
        yield* executeDelegate(action, baseline, entry.id, [
          {
            id: entry.cardId,
            threadId: action.parentThreadId,
            instructionRevision: entry.instructionRevision,
          },
        ]);
      }).pipe(
        Effect.catch((cause) =>
          supervisor
            .request("routing.defer", {
              id: entry.id,
              reason: `Routing remains queued: ${cause.operation}.`,
            })
            .pipe(Effect.ignore),
        ),
      );
    }
    yield* drain();
  });
  // Use is the list price of the tokens a thread's turns reported, the same unit as the bench's
  // cost per attempt on a subscription or not. Cloud and linked-server runs report none.
  const usedMicros = Effect.fn("Coordinator.usedMicros")(function* (
    assignment: typeof CoordinatorAssignment.Type,
  ) {
    const threadId = assignment.receipt?.threadId;
    if (assignment.route.destination !== "local" || typeof threadId !== "string") return null;
    const { providerTurns } = yield* threads
      .getThreadRecords(ThreadId.make(threadId), ["providerTurns"])
      .pipe(Effect.mapError(mapError("outcome-use")));
    const used = turnTokens(providerTurns);
    const model = used?.model ?? assignment.actualModel ?? assignment.route.model;
    if (!used || !model) return null;
    const usd = yield* usage.priceTokens(model, used.totals);
    return usd === null ? null : Math.round(usd * 1_000_000);
  });
  // Every assignment that ends adds its use and time to the outcome of the route that wrote the
  // goal's change: a review's to its author's.
  // The round an assignment adds when it ends at `now`; the board adds running ones the same way.
  const roundOf = Effect.fn("Coordinator.roundOf")(function* (
    assignment: typeof CoordinatorAssignment.Type,
    now: number,
    used: number | null,
    counted = true,
  ) {
    if (!assignment.goalId) return undefined;
    const subject = assignment.reviewSubjects?.[0];
    const route = subject ? (yield* assignmentById(subject.assignmentId)).route : assignment.route;
    const times = workTimes(assignment, now);
    return outcomeRound({
      id: assignment.id,
      goalId: assignment.goalId,
      route,
      rank: assignment.rank ?? "B",
      startedAt: times.startedAt,
      endedAt: now,
      blockedSeconds: times.blockedSeconds,
      usedMicros: used,
      counted,
    });
  });
  // Only a worktree this host made for work it settled, and only on the owner's confirmed word.
  const removeKeptWorktree = Effect.fn("Coordinator.removeKeptWorktree")(function* (
    threadId: string,
    shown: string,
  ) {
    const thread = yield* threads
      .getThreadShell(ThreadId.make(threadId))
      .pipe(Effect.mapError(mapError("worktree")));
    const project = thread
      ? Option.getOrUndefined(
          yield* projects.getById(thread.projectId).pipe(Effect.mapError(mapError("worktree"))),
        )
      : undefined;
    if (
      !thread ||
      !project ||
      !threadId.startsWith("coordinator:") ||
      thread.settledAt === null ||
      thread.worktreePath === null
    )
      return yield* new CoordinatorError({ operation: "worktree-remove", reason: "invalid" });
    const path = thread.worktreePath;
    // Only the worktree a kept note names, that this host made for the thread's work, and while
    // what it holds is what the owner was shown: a file added since is never deleted unseen.
    const { decision: note } = yield* supervisor
      .request("decisions.get", { id: `worktree-kept:${threadId}` })
      .pipe(Effect.flatMap(decodeKeptNote), Effect.mapError(mapError("worktree")));
    const { card } = yield* supervisor
      .request("cards.find", { threadId })
      .pipe(Effect.flatMap(decodeCard), Effect.mapError(mapError("worktree")));
    const made = card.assignmentId
      ? (yield* assignmentById(card.assignmentId)).receipt?.worktree
      : undefined;
    const { held } = yield* supervisor
      .request("results.clean", { repository: path })
      .pipe(Effect.flatMap(decodeHeld), Effect.mapError(mapError("worktree")));
    if (
      !note ||
      (note.expiresAt != null && note.expiresAt <= DateTime.toEpochMillis(yield* DateTime.now)) ||
      made !== path
    )
      return yield* new CoordinatorError({ operation: "worktree-remove", reason: "invalid" });
    // What it holds changed since the note: the note now shows what is there, for the owner to
    // confirm again; nothing goes that they were not shown.
    if (note.provenance !== keptProvenance(held)) {
      yield* supervisor.request("decisions.record", {
        decision: {
          id: `worktree-kept:${threadId}`,
          summary: keptSummary(path, held),
          provenance: keptProvenance(held),
          cardIds: note.cardIds?.length ? note.cardIds : [card.id],
          goalIds: note.goalIds ?? [],
        },
      });
      return yield* new CoordinatorError({ operation: "worktree-changed", reason: "invalid" });
    }
    // The text names all it holds by digest: what the owner confirmed is what is there now.
    if (note.summary !== shown || note.summary !== keptSummary(path, held))
      return yield* new CoordinatorError({ operation: "worktree-changed", reason: "invalid" });
    yield* merges.removeWorktree({ repository: project.workspaceRoot, path, force: true });
    yield* threads
      .dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(yield* uuid()),
        threadId: thread.id,
        worktreePath: null,
        branch: null,
      })
      .pipe(Effect.mapError(mapError("worktree")));
    yield* supervisor.request("decisions.record", {
      decision: {
        id: `worktree-kept:${threadId}`,
        summary: `Removed ${path} at the owner's word.`,
        provenance: "coordinator-merge",
        cardIds: [],
        goalIds: [],
        expiresAt: DateTime.toEpochMillis(yield* DateTime.now),
      },
    });
    // The owner's own act: nothing in it for the Coordinator to do, so it is not woken.
  });
  const recordRound = Effect.fn("Coordinator.recordRound")(function* (
    assignment: typeof CoordinatorAssignment.Type,
    now: number,
    used: number | null,
    counted = true,
  ) {
    const round = yield* roundOf(assignment, now, used, counted);
    if (round) yield* supervisor.request("outcomes.record", { round });
  });
  // A finished review moves its goal on: accepted, it merges; rejected, it is repaired.
  const reviewed = Effect.fn("Coordinator.reviewed")(function* (
    assignment: typeof CoordinatorAssignment.Type,
  ) {
    if (assignment.role !== "reviewer" || !assignment.goalId) return;
    const { goal } = yield* supervisor
      .request("goals.get", { id: assignment.goalId })
      .pipe(Effect.flatMap(decodeSavedGoal), Effect.mapError(mapError("review-goal")));
    if (["active", "blocked"].includes(goal.status ?? "")) yield* resolveGoal(goal, assignment.id);
  });
  const observeAssignments = Effect.fn("Coordinator.observeAssignments")(function* () {
    const current = yield* load();
    const environmentId = yield* environment.getEnvironmentId;
    for (const assignment of yield* Supervisor.openAssignments(supervisor)) {
      // One assignment that cannot be observed never stops the pass over the others.
      yield* Effect.gen(function* () {
        if (["completed", "verified", "failed", "cancelled"].includes(assignment.status)) return;
        if (!assignment.receipt || !assignment.executionId) return;
        let card = current.cards.find((item) => item.id === assignment.cardId);
        if (!card) {
          const stored = yield* supervisor
            .request("cards.get", { id: assignment.cardId })
            .pipe(Effect.flatMap(decodeCard), Effect.result);
          if (stored._tag === "Failure") return;
          card = stored.success.card;
        }
        if (assignment.route.destination?.startsWith("cloud:")) {
          // A failed poll or collection is retried on the next pass; the run stays out.
          const result = yield* cloud
            .poll(assignment.id)
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Coordinator cloud run not collected yet", { cause }).pipe(
                  Effect.as({ status: "running" as const }),
                ),
              ),
            );
          // A cloud author's change is checked against its grant when it is collected; a run
          // dispatched with no recorded base cannot be, so it waits for the owner.
          const workspaceRoot =
            result.status === "completed" &&
            assignment.role !== "reviewer" &&
            typeof assignment.receipt.base === "string"
              ? Option.getOrUndefined(
                  yield* projects
                    .getById(ProjectId.make(card.projectId))
                    .pipe(Effect.mapError(mapError("cloud-project"))),
                )?.workspaceRoot
              : undefined;
          const passed =
            result.status === "completed" && workspaceRoot
              ? (yield* checkResult(assignment.id, workspaceRoot, result.head)).resultCheck.passed
              : assignment.role === "reviewer";
          const status = result.status === "completed" && !passed ? "blocked" : result.status;
          const terminal = result.status !== "running";
          const now = DateTime.toEpochMillis(yield* DateTime.now);
          // Rounds are idempotent: recorded before the end, a crash between the two loses neither.
          if (terminal) yield* recordRound(assignment, now, null);
          const proven =
            result.status === "completed" && assignment.route.destination === "cloud:claude";
          yield* supervisor.request("assignments.update", {
            id: assignment.id,
            status,
            receipt: {
              ...assignment.receipt,
              observedStatus: status,
              ...(result.status === "completed" ? { head: result.head } : {}),
              // Best-effort progress of a run that pushes as it works: its last commit and when.
              ...(result.status === "running" && "head" in result && result.head
                ? { branchHead: result.head, branchMovedAt: result.movedAt }
                : {}),
            },
            identityVerified: proven,
            ...(proven && card.model ? { actualModel: card.model } : {}),
            ...(proven && card.effort ? { actualEffort: card.effort } : {}),
            contactConfirmed: true,
            meaningfulProgress: status !== assignment.status,
            spend: { seconds: workTimes(assignment, now).seconds, micros: null },
          });
          yield* supervisor.request("cards.sync", {
            cards: [{ ...card, status, blocker: terminal ? null : card.blocker }],
          });
          if (terminal && status === "completed") yield* reviewed(assignment);
          if (terminal)
            yield* supervisor.request("decisions.record", {
              decision: {
                id: `cloud-result:${assignment.id}`,
                summary: ("reason" in result
                  ? result.reason
                  : `Cloud run pushed ${result.status === "completed" ? result.head : ""}; acceptance is still to be reviewed.`
                ).slice(0, 2_000),
                provenance: "cloud-run-ledger",
                cardIds: [card.id],
                goalIds: assignment.goalId ? [assignment.goalId] : [],
              },
            });
          return;
        }
        if (typeof assignment.receipt.threadId !== "string") return;
        let status = card.status;
        let nativeStatus: string | undefined;
        let runId: string | undefined;
        let independentlyPaused = false;
        let worktreePath: string | null = null;
        let ownerWait = false;
        let asking: OrchestrationV2ThreadShell | undefined;
        let blockedReason: string | undefined;
        let limited: { reason: string; until: number | null } | undefined;
        if (card.environmentId === environmentId) {
          const shell = yield* threads
            .getThreadShell(ThreadId.make(card.threadId))
            .pipe(Effect.mapError(mapError("observe")));
          if (!shell) return;
          worktreePath = shell.worktreePath;
          const { runs } = yield* threads
            .getThreadRecords(shell.id, ["runs"])
            .pipe(Effect.mapError(mapError("observe")));
          const latest = runs.toSorted((left, right) => right.ordinal - left.ordinal)[0];
          runId = latest?.id;
          nativeStatus = latest?.status;
          ownerWait = Boolean(shell.pendingRuntimeRequest);
          asking = shell;
          if (shell.pendingRuntimeRequest)
            blockedReason =
              shell.pendingRuntimeRequest.kind === "user_input"
                ? "A question waits in its thread."
                : `An approval (${shell.pendingRuntimeRequest.kind}) waits in its thread.`;
          if (shell.lastErrorClass === "usage_limit")
            limited = {
              reason: holdReason(shell.lastError),
              until: shell.usageLimitResetAt ? Date.parse(shell.usageLimitResetAt) : null,
            };
          status = ownerWait
            ? "blocked"
            : shell.activeRunId || shell.pendingBackgroundTasks?.length
              ? "running"
              : cardStatus(latest?.status ?? shell.status);
          independentlyPaused =
            latest?.status === "interrupted" && assignment.groupPauseRevision === null;
        } else {
          const parent = assignment.receipt.parentThreadId;
          if (typeof parent !== "string") return;
          const read = yield* peers
            .readThread(yield* scopeFor(parent), EnvironmentId.make(card.environmentId), {
              threadId: ThreadId.make(card.threadId),
              limit: 1,
              runLimit: 1,
              maxCharsPerItem: 512,
            })
            .pipe(Effect.mapError(mapError("observe-remote")));
          const latest = read.recentRuns.toSorted((left, right) => right.ordinal - left.ordinal)[0];
          runId = latest?.runId;
          nativeStatus = latest?.status;
          ownerWait = Boolean(read.thread.pendingRequestCount);
          if (ownerWait) blockedReason = "A question or approval waits in its thread.";
          status = ownerWait
            ? "blocked"
            : cardStatus(
                read.thread.activeRunId ? "running" : (latest?.status ?? read.thread.status),
              );
          yield* supervisor.request("cards.sync", {
            cards: [
              {
                ...card,
                status,
                settled: read.thread.settled,
                archived: read.thread.archived,
                summaryUpdatedAt: Date.parse(read.thread.updatedAt),
              },
            ],
          });
        }
        if (assignment.groupPauseRevision !== null && status === "paused") return;
        // A finished author's work is accepted only if it stayed inside its grant; a miss waits for the owner.
        // An author with no recorded base or no local worktree (a remote one) is not checked, so held.
        if (status === "completed" && assignment.role !== "reviewer") {
          const checked =
            worktreePath && typeof assignment.receipt.base === "string"
              ? yield* supervisor
                  .request("results.check", {
                    assignmentId: assignment.id,
                    repository: worktreePath,
                  })
                  .pipe(
                    Effect.flatMap(decodeResultCheck),
                    Effect.mapError(mapError("result-check")),
                  )
              : undefined;
          if (!checked?.resultCheck.passed) {
            status = "blocked";
            blockedReason = checked
              ? `Its result is held for the owner: ${checked.resultCheck.blocking?.join("; ") ?? "the result check did not pass"}.`
              : "Its result is held for the owner: it has no recorded base or local worktree to check against a grant.";
          }
        }
        if (
          ![
            "queued",
            "submitted",
            "running",
            "blocked",
            "completed",
            "failed",
            "cancelled",
            "paused",
            "pausing",
            "uncertain",
          ].includes(status)
        )
          status = "uncertain";
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        const changed = status !== assignment.status || independentlyPaused;
        // Only a pending request waits on the owner; the store's blocked for missed check-ins does
        // not, so the wait is tracked from what was observed, whatever the stored status.
        const receipt = trackBlocked(assignment.receipt, ownerWait, now);
        const used = yield* usedMicros(assignment);
        // Blocked waits on the owner and is not ended; a paused or uncertain one may still go on.
        // Rounds are idempotent: recorded before the end, a crash between the two loses neither.
        const ended = changed && ["completed", "failed", "cancelled"].includes(status);
        // A login the provider limited takes no new work until its window resets; the work's
        // failure says nothing of its route's skill.
        if (ended && limited)
          yield* supervisor.request("account.hold", {
            hold: {
              account: assignment.route.account ?? assignment.route.provider,
              ...limited,
            },
          });
        // A review's round goes to its author's route, which a reviewer's limit says nothing of.
        if (ended)
          yield* recordRound(
            assignment,
            now,
            used,
            !limited || Boolean(assignment.reviewSubjects?.length),
          );
        // Spend is a running total, sent every pass so a cap trips while the work runs.
        yield* supervisor.request("assignments.update", {
          id: assignment.id,
          ...(changed
            ? {
                status,
                // Told with the event, so the Coordinator knows what a blocked one waits for.
                ...(status === "blocked" && blockedReason
                  ? { reason: Array.from(blockedReason).slice(0, 500).join("") }
                  : {}),
                contactConfirmed: true,
                meaningfulProgress: status !== assignment.status,
                independentlyPaused,
                ...(assignment.status === "paused" && status === "running"
                  ? { directUserResume: true, actor: "user" }
                  : {}),
              }
            : {}),
          receipt: {
            ...receipt,
            latestRunId: runId,
            latestNativeStatus: nativeStatus,
            // The worktree it was made, first seen here: settlement removes that one and no other.
            ...(assignment.role !== "reviewer" &&
            typeof receipt.base === "string" &&
            receipt.worktree === undefined &&
            worktreePath
              ? { worktree: worktreePath }
              : {}),
          },
          spend: { seconds: workTimes({ ...assignment, receipt }, now).seconds, micros: used },
        });
        // The request it waits for is told with the block, or one answered before the next wake
        // would never be named.
        if (changed && status === "blocked" && asking)
          yield* recordRequests(
            [asking],
            new Set([asking.id]),
            (yield* Ref.get(snapshotRef)).configuration,
          );
        if (ended && status === "completed") yield* reviewed(assignment);
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Coordinator could not observe an assignment", {
            assignmentId: assignment.id,
            reason: cause.reason,
          }),
        ),
      );
    }
  });
  // The Coordinator's own thread changes no files and runs no commands, on every provider: the
  // host declines what it asks for, whoever would otherwise answer.
  const declineOwnChanges = (request: {
    readonly id: RuntimeRequestId;
    readonly threadId: ThreadId;
    readonly kind: string;
    readonly status: string;
  }) =>
    Ref.get(snapshotRef).pipe(
      Effect.flatMap(({ configuration }) =>
        configuration.enabled &&
        configuration.coordinatorThreadId === request.threadId &&
        request.status === "pending" &&
        ["command", "file-change", "permission"].includes(request.kind)
          ? uuid().pipe(
              Effect.flatMap((id) =>
                threads.dispatch({
                  type: "runtime-request.respond",
                  threadId: request.threadId,
                  commandId: CommandId.make(`coordinator-own:${id}`),
                  requestId: request.id,
                  decision: "decline",
                  feedback: `${coordinatorInText(configuration.labels, true)}'s thread changes no files and runs no commands. Delegate the work with coordinator_delegate.`,
                }),
              ),
            )
          : Effect.void,
      ),
      Effect.catch((cause) =>
        Effect.logWarning("Coordinator could not decline its own thread's request", { cause }),
      ),
    );
  // A first turn of the Coordinator's thread that ran to its end without asking for its status
  // shows its instance gave it no T3 tools. A refused, cancelled or interrupted turn shows nothing.
  // Whatever turn of its thread completed, wake or not, what it read from the inbox was read.
  const confirmReads = (run: { id: string; threadId: string; status: string }) =>
    Ref.get(snapshotRef).pipe(
      Effect.flatMap(({ configuration }) =>
        configuration.coordinatorThreadId === run.threadId && run.status === "completed"
          ? supervisor.request("events.confirm", { runId: run.id })
          : Effect.void,
      ),
      Effect.ignore,
    );
  const disprove = (run: {
    threadId: string;
    status: string;
    startedAt: unknown;
    providerInstanceId: string;
    modelSelection: { model: string };
  }) =>
    Ref.get(snapshotRef).pipe(
      Effect.flatMap(({ configuration }) =>
        configuration.coordinatorThreadId === run.threadId &&
        run.status === "completed" &&
        run.startedAt !== null &&
        !configuration.threadProof
          ? supervisor
              .request("proof.record", {
                provider: run.providerInstanceId,
                model: run.modelSelection.model,
                proved: false,
                reason:
                  "Its first turn ended without calling coordinator_status: this instance gave it no T3 tools.",
              })
              .pipe(Effect.andThen(load()))
          : Effect.void,
      ),
      Effect.ignore,
    );
  // The host's facts about the threads the Coordinator manages, a pending request once each.
  const recordRequests = Effect.fn("Coordinator.recordRequests")(function* (
    shells: ReadonlyArray<OrchestrationV2ThreadShell>,
    managed: ReadonlySet<string>,
    configuration: CoordinatorSnapshot["configuration"],
  ) {
    for (const shell of shells) {
      const request = shell.pendingRuntimeRequest;
      if (
        !request ||
        shell.id === configuration.coordinatorThreadId ||
        !(managed.has(shell.id) || configuration.manageOtherThreads)
      )
        continue;
      yield* supervisor
        .request("events.append", {
          // The same request is one event, however often it is seen.
          eventId: `request:${shell.id}:${storedRequestId(request.id)}`,
          actor: "host",
          event: {
            kind: request.kind === "user_input" ? "question" : "approval",
            threadId: shell.id,
            subject: request.id,
            summary: `${request.kind === "user_input" ? "A question" : `An approval (${request.kind})`} waits in thread ${shell.id}.`,
          },
        })
        .pipe(
          // One request the store refuses is not told; the wake and the others go on.
          Effect.catch((cause) =>
            Effect.logWarning("Coordinator could not record a thread's request", {
              threadId: shell.id,
              reason: refusal(cause),
            }),
          ),
        );
    }
  });
  // Store reads only: the work on every unsettled card, and delegations waiting for a route.
  const unsettledWork = Effect.fn("Coordinator.unsettledWork")(function* (
    current: CoordinatorSnapshot,
  ) {
    // The work on every unsettled card, even work whose goal resolved before its merge, which
    // the store no longer counts as open.
    const cards = new Map<string, typeof CoordinatorCard.Type>();
    let cursor: string | null = null;
    do {
      const page: typeof CoordinatorCardPage.Type = yield* supervisor
        .request("cards.list", { limit: 100, ...(cursor === null ? {} : { cursor }) })
        .pipe(Effect.flatMap(decodeCardPage), Effect.mapError(mapError("digest")));
      for (const card of page.items) cards.set(card.id, card);
      cursor = page.nextCursor;
    } while (cursor !== null);
    const work = (yield* Supervisor.openAssignments(supervisor, false)).flatMap(
      (assignment): Array<[typeof CoordinatorCard.Type, typeof CoordinatorAssignment.Type]> => {
        const card = cards.get(assignment.cardId);
        return card ? [[card, assignment]] : [];
      },
    );
    const superseded = new Set(work.flatMap(([, assignment]) => assignment.supersedes ?? []));
    const waiting: Array<DigestThread> = [];
    // A delegation still waiting for a route has no thread of its own yet.
    for (const wait of current.routingWaits ?? [])
      waiting.push({
        threadId: `delegation:${wait.id}`,
        title: "not started",
        goalId: wait.goalId,
        state: `waiting: route ${quoted(wait.reason)}`,
        working: false,
        lastActivityAt: null,
        commits: null,
      });
    return {
      waiting,
      work: work.filter(([card, assignment]) => unsettled(assignment, card, superseded)),
    };
  });
  /** One digest line per thread; git and cloud reads run at once, as many as the machine has CPUs. */
  const describe = Effect.fn("Coordinator.describe")(function* (
    work: ReadonlyArray<readonly [typeof CoordinatorCard.Type, typeof CoordinatorAssignment.Type]>,
    shells: ReadonlyMap<string, OrchestrationV2ThreadShell>,
    merging: ReadonlyMap<string, MergeFacts>,
    since: number | null,
    now: number,
  ) {
    const platform = yield* HostProcess.Platform;
    return yield* Effect.forEach(
      work,
      Effect.fnUntraced(function* ([card, assignment]) {
        const cloudRun = assignment.route.destination?.startsWith("cloud:")
          ? yield* supervisor.request("remote.get", { assignmentId: assignment.id }).pipe(
              Effect.flatMap(decodeRemoteRun),
              Effect.map(({ run }) => run ?? undefined),
              Effect.orElseSucceed(() => undefined),
            )
          : undefined;
        const cloud = assignment.route.destination?.startsWith("cloud:")
          ? {
              state: cloudRun?.state ?? assignment.status,
              movedAt: cloudRun?.movedAt ?? null,
              startedAt: cloudRun?.startedAt ?? now,
            }
          : undefined;
        const shell = shells.get(card.threadId);
        const { state, working } = threadState(
          assignment,
          shell,
          cloud,
          merging.get(assignment.id),
        );
        const worktree = shell?.worktreePath;
        const startedAt = Number(assignment.receipt?.startedAt) || now;
        // Commits since the last digest, or since the work started before the first. A thread's
        // worktree is as untrusted as any workspace, so git reads it as the workspace reads do.
        const commits = worktree
          ? yield* runner
              .run({
                command: "git",
                args: [
                  ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
                  "rev-list",
                  "--count",
                  `--since=@${Math.floor(Math.max(since ?? 0, startedAt) / 1000)}`,
                  "HEAD",
                ],
                cwd: worktree,
                env: { ...process.env, ...explicitBareRepositoryEnv(process.env, platform) },
              })
              .pipe(
                Effect.map((output) => (output.code === 0 ? Number(output.stdout.trim()) : null)),
                Effect.orElseSucceed(() => null),
              )
          : null;
        return {
          threadId: card.threadId,
          title: card.purpose,
          goalId: assignment.goalId,
          state,
          working,
          lastActivityAt: cloud
            ? (cloud.movedAt ?? cloud.startedAt)
            : shell
              ? DateTime.toEpochMillis(shell.updatedAt)
              : null,
          commits,
        };
      }),
      { concurrency: NodeOS.availableParallelism() },
    );
  });
  /**
   * One queued message to the Coordinator's thread, never a steer of its turn: what is new in its
   * inbox and every unsettled thread. Nothing new and no check-in due wakes nothing, and a wake
   * not yet started holds the next.
   */
  const wake = Effect.fn("Coordinator.wake")(function* () {
    const current = yield* Ref.get(snapshotRef);
    const { configuration } = current;
    const threadId = configuration.coordinatorThreadId;
    const projectId = configuration.coordinatorProjectId;
    if (
      !configuration.enabled ||
      configuration.coordinatorPaused ||
      current.pause.active ||
      !threadId ||
      !projectId
    )
      return;
    const runStatus = (runId: string) =>
      threads
        .getThreadRecords(ThreadId.make(threadId), ["runs"], { runIds: [RunId.make(runId)] })
        .pipe(
          Effect.map(({ runs }) => runs[0]?.status),
          Effect.mapError(mapError("wake")),
        );
    let before = yield* Ref.get(wakes);
    if (before.waitingRunId) {
      const status = yield* runStatus(before.waitingRunId);
      if (status === "queued" || status === "preparing") return;
    }
    // What a wake carried is told only once its turn completed; a turn that failed, was stopped
    // or was cancelled told nothing, so the next wake says it again.
    if (before.carrying) {
      const status = yield* runStatus(before.carrying.runId);
      if (status && LIVE_RUN.has(status)) return;
      if (status === "completed")
        yield* supervisor.request("events.woken", {
          through: before.carrying.through,
          runId: before.carrying.runId,
        });
      before = { ...before, carrying: undefined };
      yield* Ref.set(wakes, before);
    }
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const shells = yield* activeShells("wake");
    const assignments = yield* Supervisor.openAssignments(supervisor);
    const managed = new Set(
      assignments.flatMap((assignment) => {
        const threadOf = current.cards.find((card) => card.id === assignment.cardId)?.threadId;
        return threadOf ? [threadOf] : [];
      }),
    );
    yield* recordRequests(shells, managed, configuration);
    // A wake queued behind a turn in progress would be read when that turn ends and say what was
    // true before it: it is sent once the thread is free, which a cycle follows at once. A turn
    // the host just stopped is ending, and is told why now.
    if (!before.reason && shells.some((shell) => shell.id === threadId && shell.activeRunId))
      return;
    const pending = yield* supervisor
      .request("events.pending", {})
      .pipe(Effect.flatMap(decodePending), Effect.mapError(mapError("wake")));
    const intervalMs = (configuration.checkInMinutes ?? DEFAULT_CHECK_IN_MINUTES) * 60_000;
    // Whether a wake is due comes first; only then is the digest built.
    const quiet = Object.keys(pending.kinds).length === 0 && !before.reason;
    const checkIn = before.lastDigestAt === null || now - before.lastDigestAt >= intervalMs;
    if (quiet && !checkIn) return;
    const { waiting, work } = yield* unsettledWork(current);
    const { items: merging } = yield* supervisor
      .request("merges.list", {})
      .pipe(Effect.flatMap(decodeMerges), Effect.mapError(mapError("digest")));
    if (
      quiet &&
      work.length === 0 &&
      waiting.length === 0 &&
      Object.keys(pending.unread).length === 0
    )
      return;
    const digest = [
      ...waiting,
      ...(yield* describe(
        work,
        new Map(shells.map((shell) => [shell.id, shell])),
        new Map(merging.map((item) => [item.assignmentId, { waiting: item.waiting ?? null }])),
        before.lastDigestAt,
        now,
      )),
    ];
    // A send that failed may still have been accepted: the retry repeats its id, which the
    // thread takes once.
    const id = before.sending ?? (yield* uuid());
    yield* Ref.set(wakes, { ...before, sending: id });
    const sent = yield* threads
      .sendToThread({
        projectId: ProjectId.make(projectId),
        commandId: CommandId.make(`coordinator-wake:${id}`),
        threadId: ThreadId.make(threadId),
        messageId: MessageId.make(`coordinator-wake:${id}`),
        text: wakeText({
          kinds: pending.kinds,
          unread: pending.unread,
          threads: digest,
          now,
          intervalMs,
          reason: before.reason,
        }),
        attachments: [],
        mode: "queue",
        createdBy: "system",
        creationSource: "server",
      })
      .pipe(Effect.mapError(mapError("wake")));
    yield* Ref.set(wakes, {
      ...before,
      lastDigestAt: now,
      carrying: { runId: sent.run.id, through: pending.through },
      sending: undefined,
      reason: undefined,
    });
  });
  /**
   * A turn of the Coordinator's in which nothing at all happens for a whole check-in interval is
   * stopped and the next wake says so; between turns, a context above its share is compacted.
   */
  const superviseTurn = Effect.fn("Coordinator.superviseTurn")(function* () {
    const current = yield* Ref.get(snapshotRef);
    const { configuration } = current;
    const threadId = configuration.coordinatorThreadId;
    const projectId = configuration.coordinatorProjectId;
    if (
      !configuration.enabled ||
      configuration.coordinatorPaused ||
      current.pause.active ||
      !threadId ||
      !projectId
    )
      return;
    const shell = yield* threads
      .getThreadShell(ThreadId.make(threadId))
      .pipe(Effect.mapError(mapError("turn-limit")));
    if (!shell) return;
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    if (shell.activeRunId) {
      // Waiting for the owner, or in a wait for other work, is not a stall.
      if (
        !shell.activityRunStartedAt ||
        shell.pendingRuntimeRequest ||
        shell.blockedOnThreadWait ||
        (shell.pendingBackgroundTasks?.length ?? 0) > 0
      )
        return;
      // Any item of the turn moves as tokens stream and tools start, update or finish.
      const { turnItems } = yield* threads
        .getThreadRecords(ThreadId.make(threadId), ["turnItems"], {
          turnItemRunId: shell.activeRunId,
        })
        .pipe(Effect.mapError(mapError("turn-limit")));
      const lastActivityAt = Math.max(
        DateTime.toEpochMillis(shell.activityRunStartedAt),
        ...turnItems.map((item) => DateTime.toEpochMillis(item.updatedAt)),
      );
      // The owner's check-in interval is the only measure of how long silence may last.
      const intervalMs = (configuration.checkInMinutes ?? DEFAULT_CHECK_IN_MINUTES) * 60_000;
      if (now - lastActivityAt < intervalMs) return;
      yield* orchestrator
        .interruptThread(yield* scopeFor(threadId), {
          threadId: ThreadId.make(threadId),
          clientRequestId: yield* uuid(),
        })
        .pipe(Effect.mapError(mapError("turn-limit")));
      yield* Ref.update(wakes, (state) => ({
        ...state,
        reason: `Your last turn was stopped: nothing happened in it for ${Math.round((now - lastActivityAt) / 60_000)} minutes.`,
      }));
      return;
    }
    // Only a provider that offers /compact compacts; to any other the text is a message.
    const provider = (yield* providers.getProviders).find(
      (item) => item.instanceId === configuration.coordinatorProvider,
    );
    if (!provider?.slashCommands.some((command) => command.name === "compact")) return;
    const { providerTurns } = yield* threads
      .getThreadRecords(ThreadId.make(threadId), ["providerTurns"])
      .pipe(Effect.mapError(mapError("compact")));
    const readings = providerTurns
      .toSorted((a, b) => a.ordinal - b.ordinal)
      .flatMap((turn) => (turn.tokenUsage ? [turn.tokenUsage] : []));
    const usage = readings.at(-1);
    if (!usage?.maxTokens) return;
    // The most one turn has added so far: a wake's digest, the reads it led to and the reply.
    // The next turn needs that much room, or the provider compacts in the middle of it.
    const needed = Math.max(
      0,
      ...readings
        .slice(1)
        .map((reading, index) => reading.usedTokens - readings[index]!.usedTokens),
    );
    if (needed === 0 || usage.maxTokens - usage.usedTokens >= needed) return;
    const before = yield* Ref.get(wakes);
    const last = before.compacted;
    if (last && (last.sentFor === usage.updatedAt || last.unlowered === usage.updatedAt)) return;
    // A compaction that did not lower the reading is not repeated until another turn changes it.
    if (last && last.unlowered === undefined && usage.usedTokens >= last.used) {
      yield* Ref.set(wakes, { ...before, compacted: { ...last, unlowered: usage.updatedAt } });
      return;
    }
    const id = yield* uuid();
    const sent = yield* threads
      .sendToThread({
        projectId: ProjectId.make(projectId),
        commandId: CommandId.make(`coordinator-compact:${id}`),
        threadId: ThreadId.make(threadId),
        messageId: MessageId.make(`coordinator-compact:${id}`),
        text: "/compact",
        attachments: [],
        mode: "queue",
        createdBy: "system",
        creationSource: "server",
      })
      .pipe(Effect.mapError(mapError("compact")));
    yield* Ref.set(wakes, {
      ...before,
      compacted: { sentFor: usage.updatedAt, used: usage.usedTokens },
      // A wake waits for the compaction to start, so it lands in the compacted context.
      waitingRunId: sent.delivery === "queued" ? sent.run.id : before.waitingRunId,
    });
  });
  const runCycle = Effect.gen(function* () {
    yield* syncCards();
    yield* syncPermissions();
    yield* observeAssignments();
    yield* mergeReviewed().pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Coordinator could not read what waits to merge", {
          reason: cause.reason,
        }),
      ),
    );
    return yield* load();
  });
  // Outside the cycle's gate: a digest's git reads never hold a person's goal or a cycle back.
  const wakeUp = wakeGate.withPermits(1)(
    superviseTurn().pipe(
      Effect.andThen(wake()),
      Effect.catch((cause) =>
        Effect.logWarning("Coordinator could not wake its thread", {
          operation: cause.operation,
          reason: refusal(cause),
        }),
      ),
    ),
  );
  const personCycle = cycleGate
    .withPermits(1)(runCycle)
    .pipe(Effect.tap(() => wakeUp));
  const forkPersonCycle = personCycle.pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Coordinator cycle stopped", { reason: cause.reason }),
    ),
    Effect.forkIn(backgroundScope),
  );
  const applyUserModelDirective = Effect.fn("Coordinator.applyUserModelDirective")(function* (
    goal: typeof CoordinatorGoal.Type,
  ) {
    const environmentId = yield* environment.getEnvironmentId;
    const nativeThreads = yield* activeShells("user-model-directive");
    const providerRows = yield* providers.getProviders;
    const models = providerRows.flatMap((provider) =>
      provider.models.map((model) => ({
        provider: provider.instanceId,
        id: model.slug,
        names: [model.name],
        efforts: (model.capabilities?.optionDescriptors ?? []).flatMap((option) =>
          option.id === "effort" && option.type === "select"
            ? option.options.map((choice) => choice.id)
            : [],
        ),
      })),
    );
    const result = resolveUserOverride({
      purpose: goal.purpose,
      authorizedScope: goal.authorizedScope ?? [],
      cards: nativeThreads
        .filter(
          (thread) => thread.archivedAt === null && !thread.id.startsWith("coordinator-lead:"),
        )
        .map((thread) => ({
          id: `${environmentId}:${thread.id}`,
          threadId: thread.id,
          environmentId,
          projectId: thread.projectId,
          purpose: thread.title,
          provider: thread.providerInstanceId,
          destination: "local",
          effort:
            thread.modelSelection.options
              ?.find((option) => option.id === "effort")
              ?.value?.toString() ?? null,
        })),
      models,
    });
    if (result.type === "none") return;
    if (result.type === "needs-details") {
      yield* supervisor.request("decisions.record", {
        decision: {
          id: `user-model:${yield* uuid()}`,
          summary: result.message,
          provenance: "source-user-directive-needs-details",
          goalIds: [goal.id],
          cardIds: [],
        },
      });
      return;
    }
    if (typeof goal.revision !== "number")
      return yield* new CoordinatorError({ operation: "user-model-source", reason: "invalid" });
    const previous = yield* supervisor
      .request("overrides.resolve", {
        threadId: result.card.threadId,
        projectId: result.card.projectId,
        environmentId,
      })
      .pipe(Effect.flatMap(decodeSelection), Effect.mapError(mapError("user-model-previous")));
    const explicitEffort = /\bwith\s+(?:effort|reasoning(?:\s+effort)?)\s+/i.test(goal.purpose);
    const appliedEffort = explicitEffort
      ? result.effort
      : (previous.selection.effort ?? result.effort);
    const supported = models.find(
      (model) => model.provider === result.card.provider && model.id === result.model,
    );
    if (
      (previous.selection.provider && previous.selection.provider !== result.card.provider) ||
      (previous.selection.destination && previous.selection.destination !== "local") ||
      (appliedEffort && !supported?.efforts.includes(appliedEffort))
    ) {
      yield* supervisor.request("decisions.record", {
        decision: {
          id: `user-model:${yield* uuid()}`,
          summary:
            "An existing exact provider, destination, or effort pin conflicts with this model request. Specify compatible exact fields in the thread controls; no existing pin was replaced.",
          provenance: "source-user-directive-needs-details",
          goalIds: [goal.id],
          cardIds: [result.card.id],
        },
      });
      return;
    }
    yield* syncCards();
    const id = yield* uuid();
    const receipt = yield* supervisor.request("overrides.set", {
      actor: "user",
      sourceGoalId: goal.id,
      sourceGoalRevision: goal.revision,
      sourceGoalPurpose: goal.purpose,
      override: {
        id,
        scope: { kind: "thread", id: result.card.threadId },
        selection: {
          model: result.model,
          ...(appliedEffort && (explicitEffort || !previous.selection.effort)
            ? { effort: appliedEffort }
            : {}),
        },
      },
    });
    if (
      typeof receipt === "object" &&
      receipt !== null &&
      ("deduplicated" in receipt || "superseded" in receipt)
    )
      return;
    const native = nativeThreads.find((thread) => thread.id === result.card.threadId)!;
    const options = [
      ...(native.modelSelection.options ?? []).filter((option) => option.id !== "effort"),
      ...(appliedEffort ? [{ id: "effort", value: appliedEffort }] : []),
    ];
    yield* threads
      .dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make(`coordinator-user-model:${id}`),
        threadId: native.id,
        modelSelection: { instanceId: native.providerInstanceId, model: result.model, options },
      })
      .pipe(Effect.mapError(mapError("user-model-apply")));
    const summary = `Stored exact model ${result.model}${appliedEffort ? ` with effort ${appliedEffort}` : ""} for thread ${native.id}. Provider, account, and destination were retained. T3 applies it at its supported turn boundary; runtime identity is not yet verified.`;
    yield* supervisor.request("decisions.record", {
      decision: {
        id: `user-model:${id}`,
        summary,
        provenance: "explicit-source-user-directive",
        goalIds: [goal.id],
        cardIds: [result.card.id],
      },
    });
    yield* supervisor.request("goals.upsert", {
      actor: "user",
      goal: {
        ...goal,
        status: "completed",
        acceptanceCriteria: ["Persist the exact scoped user model selection."],
        integrationOwner: "coordinator-user-directive",
        verified: true,
        evidence: [
          `T3 model-selection command coordinator-user-model:${id}`,
          `Supervisor exact override ${id}; source goal revision ${goal.revision}`,
        ],
      },
    });
    yield* syncCards();
  });
  // The owner sees each grant made or withdrawn in the Coordinator's thread, and the Coordinator,
  // which works only inside its grants, reads it there.
  const grantLine = Effect.fn("Coordinator.grantLine")(
    function* (said: string, raw: unknown) {
      const { grant } = yield* decodeGrant(raw);
      const current = yield* load();
      const { coordinatorThreadId: threadId, enabled, coordinatorPaused } = current.configuration;
      if (!grant || !threadId || !enabled || coordinatorPaused || current.pause.active) return;
      const title =
        grant.scope.kind === "project"
          ? current.projects?.find((project) => project.id === grant.scope.id)?.title
          : undefined;
      const summary = `${said}: ${describeCoordinatorGrant(grant, title)}`;
      const id = yield* uuid();
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`coordinator-grant:${id}`),
        threadId: ThreadId.make(threadId),
        messageId: MessageId.make(`coordinator-grant:${id}`),
        text: summary,
        notification: { source: { kind: "system" }, outcome: "updated", summary },
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });
    },
    // The grant stands whether or not its line was posted.
    Effect.catch((cause) =>
      Effect.logWarning("Coordinator could not post a grant line", { cause }),
    ),
  );
  const command = Effect.fn("Coordinator.command")(function* (input: CoordinatorCommand) {
    yield* untilRecovered;
    if (!supervisor.available)
      return yield* new CoordinatorError({ operation: input.type, reason: "unavailable" });
    switch (input.type) {
      case "configure": {
        // The owner's switch: the store may start to answer it, off or not.
        if (store.switching) yield* store.switching;
        const current = yield* load();
        const configuration = yield* decodeConfiguration({
          ...current.configuration,
          ...Object.fromEntries(
            Object.entries(input.configuration).filter(([, value]) => value !== undefined),
          ),
        }).pipe(Effect.mapError(mapError("configure")));
        // Its thread may run on any instance and model, but it needs one.
        const { coordinatorProvider: provider, coordinatorModel: model } = configuration;
        if (configuration.enabled && (!provider || !model))
          return yield* new CoordinatorError({
            operation: "configure",
            reason: "invalid",
            detail: `Choose a provider and a model for ${coordinatorInText(configuration.labels)} first.`,
          });
        let coordinatorProjectId = configuration.coordinatorProjectId ?? null;
        let coordinatorThreadId = configuration.coordinatorThreadId ?? null;
        if (configuration.enabled) {
          coordinatorProjectId ??= current.projects?.length === 1 ? current.projects[0]!.id : null;
          if (
            !coordinatorProjectId ||
            !current.projects?.some((project) => project.id === coordinatorProjectId)
          )
            return yield* new CoordinatorError({
              operation: "coordinator-project",
              reason: "invalid",
            });
          const existing = coordinatorThreadId
            ? yield* threads
                .getThreadShell(ThreadId.make(coordinatorThreadId))
                .pipe(Effect.mapError(mapError("coordinator-thread")))
            : null;
          if (!existing || existing.projectId !== coordinatorProjectId) {
            const id = `coordinator-lead:${yield* uuid()}`;
            const anchor = yield* threadLaunch
              .launch({
                commandId: CommandId.make(id),
                threadId: ThreadId.make(id),
                projectId: ProjectId.make(coordinatorProjectId),
                title: configuration.coordinatorTitle ?? configuration.labels.coordinatorSingular,
                modelSelection: {
                  instanceId: ProviderInstanceId.make(provider!),
                  model: model!,
                  options: [],
                },
                runtimeMode: "approval-required",
                interactionMode: "default",
                workspaceStrategy: { type: "root" },
                createdBy: "system",
                creationSource: "server",
              })
              .pipe(Effect.mapError(mapError("coordinator-thread")));
            coordinatorThreadId = anchor.threadId;
            // Pinned so the owner finds the one thread they talk to at the top of the list.
            yield* threads
              .dispatch({
                type: "thread.pin",
                commandId: CommandId.make(yield* uuid()),
                threadId: anchor.threadId,
              })
              .pipe(Effect.mapError(mapError("coordinator-thread")));
          } else if (
            existing.modelSelection.instanceId !== provider ||
            existing.modelSelection.model !== model
          )
            // The owner chose another instance or model: the thread's next turn uses it.
            yield* threads
              .dispatch({
                type: "thread.model-selection.set",
                commandId: CommandId.make(yield* uuid()),
                threadId: existing.id,
                modelSelection: {
                  instanceId: ProviderInstanceId.make(provider!),
                  model: model!,
                  options: [],
                },
              })
              .pipe(Effect.mapError(mapError("coordinator-thread")));
        }
        if (coordinatorThreadId) {
          const anchor = yield* threads
            .getThreadShell(ThreadId.make(coordinatorThreadId))
            .pipe(Effect.mapError(mapError("coordinator-title")));
          // The thread carries the name set in Settings, whatever it was called before.
          const title =
            anchor && anchor.title !== coordinatorName(configuration)
              ? coordinatorName(configuration)
              : undefined;
          if (title)
            yield* threads
              .dispatch({
                type: "thread.metadata.update",
                commandId: CommandId.make(yield* uuid()),
                threadId: ThreadId.make(coordinatorThreadId),
                title,
              })
              .pipe(Effect.mapError(mapError("coordinator-title")));
        }
        yield* supervisor.request("configure", {
          ...input.configuration,
          coordinatorProjectId,
          coordinatorThreadId,
          actor: "user",
        });
        if (configuration.enabled) {
          yield* syncCards();
          yield* refreshCatalog(false);
        }
        break;
      }
      case "pause.all":
        yield* supervisor.request("pause", { actor: "user" });
        break;
      case "resume.all":
        yield* supervisor.request("resume", { actor: "user" });
        break;
      case "stop.all":
        yield* supervisor.request("stop", { actor: "user" });
        break;
      case "assignment.cancel":
        yield* supervisor.request("assignments.cancel", { id: input.assignmentId, actor: "user" });
        break;
      case "catalog.source.set":
        yield* supervisor.request("catalog.source.set", {
          sourceId: input.sourceId,
          ...(input.automaticDiscovery !== undefined
            ? { automaticDiscovery: input.automaticDiscovery }
            : {}),
          ...(input.automaticEligibility !== undefined
            ? { automaticEligibility: input.automaticEligibility }
            : {}),
          actor: "user",
        });
        break;
      case "catalog.model.set":
        yield* supervisor.request("catalog.model.set", {
          modelId: input.modelId,
          quarantined: input.quarantined,
          actor: "user",
        });
        break;
      case "permissions.preset.save":
        yield* supervisor.request("permissions.preset.save", {
          preset: input.preset,
          actor: "user",
        });
        break;
      case "permissions.preset.apply":
        yield* supervisor.request("permissions.preset.apply", {
          presetId: input.presetId,
          scope: input.scope,
          actor: "user",
        });
        break;
      case "permissions.preset.delete":
        yield* supervisor.request("permissions.preset.delete", {
          presetId: input.presetId,
          actor: "user",
        });
        break;
      case "permissions.set":
        yield* supervisor.request("permissions.set", { policy: input.policy, actor: "user" });
        break;
      case "grant.set":
        yield* supervisor
          .request("grants.set", { grant: input.grant, actor: "user" })
          .pipe(Effect.flatMap((raw) => grantLine("The owner made a grant", raw)));
        break;
      case "grant.withdraw":
        yield* supervisor
          .request("grants.withdraw", { id: input.grantId, actor: "user" })
          .pipe(Effect.flatMap((raw) => grantLine("The owner withdrew a grant", raw)));
        break;
      case "grant.dismiss":
        yield* supervisor.request("grants.dismiss", { id: input.grantId, actor: "user" });
        break;
      case "result.accept":
        yield* supervisor.request("results.accept", {
          assignmentId: input.assignmentId,
          head: input.head,
          actor: "user",
        });
        // Observed again now, so released work goes on without waiting for the next pass.
        yield* observeAssignments();
        break;
      case "result.discard":
        yield* supervisor.request("results.discard", {
          assignmentId: input.assignmentId,
          actor: "user",
        });
        break;
      case "permissions.preview": {
        const preview = yield* supervisor
          .request("permissions.preview", {
            ...input,
            environmentId: yield* environment.getEnvironmentId,
          })
          .pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(CoordinatorPolicyPreview)),
            Effect.mapError(mapError("permissions-preview")),
          );
        return { ...(yield* load()), permissionPreview: preview };
      }
      case "guidance.save":
        yield* supervisor.request("guidance.save", {
          threadId: input.threadId,
          customPrompt: input.customPrompt,
          memory: input.memory,
          coordinatorNotes: input.coordinatorNotes,
          actor: "user",
        });
        break;
      case "permission.respond":
        yield* supervisor.request("permissions.decide", {
          requestId: input.requestId,
          decision: input.decision,
          actor: "user",
        });
        break;
      case "override.set":
        yield* supervisor.request("overrides.set", userOverrideParameters(input.override));
        break;
      case "goal.revert":
        yield* revertGoal(input.goalId);
        break;
      case "goal.merge":
        yield* mergeReviewed(input.goalId);
        break;
      case "worktree.remove":
        yield* removeKeptWorktree(input.threadId, input.shown);
        break;
      case "goal.upsert": {
        const previous = (yield* load()).goals.find((goal) => goal.id === input.goal.id);
        const saved = yield* supervisor
          .request("goals.upsert", { goal: input.goal, actor: "user" })
          .pipe(Effect.flatMap(decodeSavedGoal), Effect.mapError(mapError("goal")));
        if (!previous || previous.purpose !== saved.goal.purpose)
          yield* applyUserModelDirective(saved.goal);
        break;
      }
      case "catalog.refresh":
        yield* refreshCatalog(true, true);
        break;
      case "cycle.run":
        yield* personCycle;
        break;
      case "thread.settle":
        yield* threads
          .settleThread({
            threadId: ThreadId.make(input.threadId),
            commandId: CommandId.make(yield* uuid()),
            byOwnAgent: false,
          })
          .pipe(Effect.mapError(mapError("settle")));
        yield* syncCards();
        break;
      case "board.budget":
        yield* supervisor.request("board.budget", {
          ...input.target,
          cap: input.cap,
          actor: "user",
        });
        break;
      case "board.limits":
        yield* supervisor.request("board.limits", { limits: input.limits, actor: "user" });
        break;
      case "danger.set":
        yield* supervisor.request("danger.set", { rules: input.rules, actor: "user" });
        break;
      case "danger.reset":
        yield* supervisor.request("danger.reset", { actor: "user" });
        break;
      case "router.weights.set":
        yield* supervisor.request("router.weights.set", { weights: input.weights, actor: "user" });
        break;
      case "cloud.ended":
        yield* cloud.ended({ assignmentId: input.assignmentId, id: input.id, actor: "user" });
        break;
      case "thread.reopen":
        yield* threads
          .dispatch({
            type: "thread.unsettle",
            threadId: ThreadId.make(input.threadId),
            commandId: CommandId.make(yield* uuid()),
            reason: "user",
          })
          .pipe(Effect.mapError(mapError("reopen")));
        yield* syncCards();
        break;
    }
    if (
      ["pause.all", "resume.all", "stop.all", "assignment.cancel", "result.discard"].includes(
        input.type,
      )
    ) {
      // The native dispatch gate is durable before any destination interrupt/ACK is awaited.
      const result = yield* load();
      yield* scheduleDrain;
      if (input.type === "resume.all") yield* forkPersonCycle;
      return result;
    }
    if (
      ["permissions.set", "permissions.preset.apply", "grant.set", "grant.withdraw"].includes(
        input.type,
      )
    )
      yield* syncPermissions();
    if (input.type === "override.set") yield* refreshCatalog(false);
    yield* drain();
    const result = yield* load();
    if (["goal.upsert", "guidance.save"].includes(input.type)) yield* forkPersonCycle;
    return result;
  });
  // The owner keeps the bench in a file shaped like the Guild's party.toml, read with the catalog.
  // It sets every route's estimate, so a file another account wrote is not the owner's word.
  const importBench = Effect.gen(function* () {
    const file = path.join(config.stateDir, "coordinator-party.toml");
    const info = yield* fs.stat(file).pipe(Effect.result);
    const uid = yield* HostProcess.UserId;
    if (info._tag === "Failure" || info.success.type !== "File") return;
    if (!ownedBy(info.success.uid, uid)) {
      yield* Effect.logWarning("Coordinator bench file is not owned by the server's user; ignored");
      return;
    }
    const text = yield* fs.readFileString(file).pipe(Effect.result);
    if (text._tag === "Success")
      yield* supervisor.request("bench.set", { bench: parseBench(text.success), actor: "user" });
  });
  // Only marks models in Settings, so any readable file the owner put there counts.
  const importFleet = fs.readFileString(path.join(config.stateDir, FLEET_RESULTS_FILE)).pipe(
    Effect.flatMap(passedModels),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
    Effect.flatMap((models) => Ref.set(fleetPassed, models)),
  );
  // Off, nothing runs and the store is not started: what clients read is built here. The first
  // snapshot that shows it on, as the owner's switch in Settings makes, starts the rest.
  const start = Effect.gen(function* () {
    starting = true;
    // A file beside the bench, read on or off: Settings marks models before it is switched on.
    yield* importFleet;
    const seen = supervisor.lastSeen ? yield* supervisor.lastSeen : null;
    // Unanswered, the store may well be on: everything starts and retries as before.
    let answered = true;
    if (seen?.enabled !== false)
      yield* load().pipe(
        Effect.catch((cause) =>
          isStoreFailure(cause)
            ? Effect.sync(() => {
                answered = false;
              })
            : Ref.set(snapshotRef, {
                ...unavailable,
                availability: {
                  available: false,
                  reason: `Supervisor startup is unavailable (${cause.reason}).`,
                },
              }),
        ),
      );
    else
      yield* projects.listShells().pipe(
        Effect.map((shells) => shells.map((project) => ({ id: project.id, title: project.title }))),
        Effect.orElseSucceed(() => []),
        Effect.flatMap((projectRows) =>
          Ref.set(snapshotRef, {
            ...unavailable,
            projects: projectRows,
            ...(supervisor.available ? { availability: { available: true } } : {}),
          }),
        ),
      );
    if (!supervisor.available) return;
    if (!answered || (yield* Ref.get(snapshotRef)).configuration.enabled) {
      yield* Deferred.succeed(started, undefined);
      return yield* run;
    }
    // Idle until switched on; a read that went unanswered, as the owner switched it on, is read
    // again each minute until the store answers.
    const healing = Queue.take(missed).pipe(
      Effect.andThen(load().pipe(Effect.retry(Schedule.spaced("1 minute")), Effect.ignore)),
      Effect.forever,
    );
    yield* Effect.raceFirst(Deferred.await(switchedOn), healing).pipe(
      Effect.andThen(run),
      Effect.forkScoped,
    );
  }).pipe(
    Effect.ensuring(
      Effect.andThen(Deferred.succeed(started, undefined), Deferred.succeed(recovered, undefined)),
    ),
  );
  const run = Effect.gen(function* () {
    running = true;
    yield* recoverSettled().pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Coordinator could not finish settled work", { reason: cause.reason }),
      ),
    );
    const updateCatalog = (fresh: boolean) =>
      Ref.get(snapshotRef).pipe(
        Effect.flatMap((snapshot) =>
          snapshot.configuration.enabled
            ? refreshCatalog(fresh).pipe(
                Effect.andThen(importBench),
                Effect.andThen(importFleet),
                Effect.andThen(load()),
              )
            : Effect.void,
        ),
        Effect.catch(() => Effect.logWarning("Coordinator catalog refresh needs attention")),
      );
    yield* providers.streamChanges.pipe(
      Stream.debounce("1 second"),
      // The store makes held work due when the cycle ends an assignment, so it starts here.
      Stream.runForEach(() => updateCatalog(false)),
      Effect.forkScoped,
    );
    yield* instances.streamChanges.pipe(
      Stream.debounce("1 second"),
      Stream.runForEach(() => updateCatalog(true)),
      Effect.forkScoped,
    );
    yield* settings.streamChanges.pipe(
      Stream.debounce("1 second"),
      Stream.runForEach(() => updateCatalog(false)),
      Effect.forkScoped,
    );
    // The registry probes providers as the server starts, and its changes rebuild the catalog: the
    // first build reads what it holds, and a fresh probe follows every six hours.
    yield* updateCatalog(false).pipe(
      Effect.andThen(
        updateCatalog(true).pipe(
          Effect.repeat(Schedule.spaced("6 hours")),
          Effect.delay("6 hours"),
        ),
      ),
      Effect.forkScoped,
    );
    yield* threads.streamDomainEvents.pipe(
      Stream.tap((event) =>
        event.type === "runtime-request.updated"
          ? declineOwnChanges({ ...event.payload, threadId: event.threadId })
          : Effect.void,
      ),
      Stream.tap((event) => (event.type === "run.updated" ? disprove(event.payload) : Effect.void)),
      Stream.tap((event) =>
        event.type === "run.updated" ? confirmReads(event.payload) : Effect.void,
      ),
      Stream.filter((event) =>
        [
          "run.updated",
          "runtime-request.updated",
          "message.updated",
          "thread.metadata-updated",
          "subagent.updated",
        ].includes(event.type),
      ),
      Stream.debounce("1 second"),
      Stream.runForEach(() =>
        Ref.get(snapshotRef).pipe(
          Effect.flatMap((snapshot) =>
            snapshot.configuration.enabled
              ? cycleGate
                  .withPermits(1)(runCycle.pipe(Effect.andThen(retryRouting())))
                  .pipe(
                    Effect.andThen(wakeUp),
                    Effect.catch((cause) =>
                      Effect.logWarning("Coordinator cycle stopped", { reason: cause.reason }),
                    ),
                  )
              : Effect.void,
          ),
        ),
      ),
      // The stream comes back after an error, a minute later: the minute tick covers that gap,
      // and a stream that fails at once never spins.
      Effect.tapError(() => Effect.logWarning("Coordinator execution event stream stopped")),
      Effect.retry(Schedule.spaced("1 minute")),
      Effect.forkScoped,
    );
    yield* Ref.get(snapshotStale).pipe(
      Effect.flatMap((stale) => (stale ? load() : Ref.get(snapshotRef))),
      Effect.flatMap((snapshot) =>
        snapshot.configuration.enabled
          ? supervisor.request("tick", {}).pipe(
              Effect.andThen(
                cycleGate.withPermits(1)(
                  Effect.gen(function* () {
                    yield* retryRouting();
                    yield* runCycle;
                  }),
                ),
              ),
              Effect.andThen(drain()),
              Effect.andThen(load()),
              Effect.andThen(wakeUp),
            )
          : Effect.void,
      ),
      Effect.catch((cause) =>
        Effect.logWarning("Coordinator maintenance needs attention", { reason: cause.reason }),
      ),
      Effect.repeat(Schedule.spaced("1 minute")),
      Effect.forkScoped,
    );
  });
  const delegate = Effect.fn("Coordinator.delegate")(function* (action: CoordinatorDelegateAction) {
    yield* untilRecovered;
    yield* executeDelegate(action, yield* load());
    yield* drain();
    return yield* load();
  });
  const grantFromMessage = Effect.fn("Coordinator.grantFromMessage")(function* (input: {
    readonly messageId: string;
    readonly grant: CoordinatorGrant;
  }) {
    yield* untilRecovered;
    const threadId = (yield* load()).configuration.coordinatorThreadId;
    if (!threadId)
      return yield* new CoordinatorError({ operation: "grant", reason: "unavailable" });
    const { messages, runs } = yield* threads
      .getThreadRecords(ThreadId.make(threadId), ["messages", "runs"])
      .pipe(Effect.mapError(mapError("grant")));
    const message = messages.find((item) => item.id === input.messageId);
    // Only the request being answered grants: one the Coordinator already replied to may since
    // have been withdrawn or replaced, so it is proposed to the owner instead.
    const ended = new Set(
      runs
        .filter((run) => ["completed", "interrupted", "failed", "cancelled"].includes(run.status))
        .map((run) => run.id),
    );
    const lastReply = Math.max(
      0,
      ...messages
        .filter((item) => item.role === "assistant" && item.runId !== null && ended.has(item.runId))
        .map((item) => DateTime.toEpochMillis(item.createdAt)),
    );
    // Only words the owner typed grant anything: not a thread's message, a schedule's or the host's.
    const typed = (item: (typeof messages)[number] | undefined) =>
      item?.role === "user" &&
      item.createdBy === "user" &&
      item.senderThreadId === undefined &&
      item.scheduledTaskId === undefined &&
      item.notification === undefined;
    if (!message || !typed(message))
      return yield* new CoordinatorError({
        operation: "grant",
        reason: "policy",
        detail: `Only a message the owner typed in ${yield* named()}'s thread makes a grant.`,
      });
    // Only the owner's newest message grants: a newer one may have withdrawn or narrowed it.
    const newest = Math.max(
      ...messages.filter(typed).map((item) => DateTime.toEpochMillis(item.createdAt)),
    );
    const at = DateTime.toEpochMillis(message.createdAt);
    // The store holds the grant to what the message says, and to messages newer than the last.
    const { raw, result } = yield* supervisor
      .request("grants.set", {
        grant: input.grant,
        actor: "coordinator",
        sourceMessageId: input.messageId,
        sourceMessageText: message.text,
        sourceMessageAt: at,
        sourceMessageAnswered: at <= lastReply || at < newest,
      })
      .pipe(
        // The store's own reason goes back, so the Coordinator can act on it or tell the owner.
        Effect.mapError(
          (cause) =>
            new CoordinatorError({
              operation: "grant",
              reason: cause.reason,
              detail: refusal(cause),
              ...(cause.cause === undefined ? {} : { cause: cause.cause }),
            }),
        ),
        Effect.flatMap((raw) =>
          decodeGrantResult(raw).pipe(Effect.map((result) => ({ raw, result }))),
        ),
        Effect.mapError(mapError("grant")),
      );
    if (result.proposal)
      return {
        snapshot: yield* load(),
        proposal: { grant: result.proposal, reason: result.reason ?? "" },
      };
    yield* grantLine("Granted from the owner's message", raw);
    yield* syncPermissions();
    return { snapshot: yield* load() };
  });
  const answerApproval = Effect.fn("Coordinator.answerApproval")(function* (
    input: typeof CoordinatorApprovalInput.Type,
  ) {
    yield* untilRecovered;
    const current = yield* load();
    const requestId = `${yield* environment.getEnvironmentId}:${storedRequestId(input.requestId)}`;
    const request = current.permissionRequests?.find((item) => item.id === requestId);
    const refused = (reason: "invalid" | "policy" | "destination", detail: string) =>
      new CoordinatorError({ operation: "permission", reason, detail });
    if (request?.threadId !== input.threadId)
      return yield* refused(
        "invalid",
        "That thread has no open request with that id: a rule or the owner may have answered it.",
      );
    // The store refuses what is not the Coordinator's: a danger, the owner's policy, a person's thread.
    const answered = yield* (
      input.decision === "owner"
        ? supervisor.request("permissions.pass", { requestId, actor: "coordinator-model" })
        : supervisor.request("permissions.decide", {
            requestId,
            decision: input.decision === "allow" ? "approve" : "deny",
            actor: "coordinator-model",
            grantRevision: current.policyRevision,
          })
    ).pipe(
      // In the store's own words, so the Coordinator knows whose the request is.
      Effect.mapError((cause) =>
        cause.reason === "policy" ? refused("policy", refusal(cause)) : cause,
      ),
    );
    yield* drain();
    if (input.decision === "owner") return yield* load();
    // A decided request leaves the pending list before it is delivered: only this answer's own
    // action says whether the thread took it.
    const { action } = yield* decodeRevision(answered).pipe(
      Effect.flatMap(({ revision }) =>
        supervisor.request("actions.get", { id: `permission:${requestId}:${revision}` }),
      ),
      Effect.flatMap(decodeClaimedAction),
      Effect.mapError(mapError("permission")),
    );
    const acknowledgement = action.payload.acknowledgement as
      | { destinationAcknowledged?: unknown }
      | undefined;
    if (action.status === "completed" && acknowledgement?.destinationAcknowledged === true)
      return yield* load();
    return yield* refused(
      "destination",
      ["pending", "claimed"].includes(action.status)
        ? "The answer is queued behind other work and has not reached the thread yet. Do not answer again."
        : ["uncertain", "unreachable"].includes(action.status)
          ? "It is unknown whether the thread took the answer. Do not answer again: read the thread first."
          : "The answer did not reach the thread and its request is open again. Read the thread, then answer again or pass it to the owner.",
    );
  });
  return Coordinator.of({
    get: Effect.andThen(untilStarted, Ref.get(snapshotRef)),
    command,
    deliverable,
    delegate,
    grantFromMessage,
    answerApproval,
    // Subscribed before the current snapshot is read, so a change in between is never missed.
    changes: Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        yield* untilStarted;
        return Stream.concat(
          Stream.fromEffect(Ref.get(snapshotRef)),
          Stream.fromSubscription(subscription),
        );
      }),
    ),
    board: Effect.suspend(() =>
      supervisor.available
        ? Effect.gen(function* () {
            yield* untilStarted;
            // Off, the board is empty and starts no store.
            if (yield* switchedOff)
              return { ...EMPTY_BOARD, now: DateTime.toEpochMillis(yield* DateTime.now) };
            const now = DateTime.toEpochMillis(yield* DateTime.now);
            const running = [];
            for (const assignment of yield* Supervisor.openAssignments(supervisor)) {
              const round = yield* roundOf(assignment, now, null);
              if (round) running.push(round);
            }
            return yield* supervisor.request("board.view", { running });
          }).pipe(
            Effect.flatMap((raw) =>
              decodeOwnerBoard(raw).pipe(
                Effect.mapError(
                  (cause) =>
                    new CoordinatorError({ operation: "board-view", reason: "invalid", cause }),
                ),
              ),
            ),
          )
        : Effect.fail(new CoordinatorError({ operation: "board-view", reason: "unavailable" })),
    ).pipe(Effect.withSpan("Coordinator.board")),
    start,
  });
});
export const layer = Layer.effect(Coordinator, make);

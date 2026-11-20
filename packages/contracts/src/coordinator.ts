import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { ProviderRequestKind } from "./providerPolicy.ts";

export const COORDINATOR_DEFAULT_REPAIR_ATTEMPTS = 3;
export const COORDINATOR_GUIDANCE_MAX_CHARS = 4000;
/** The Coordinator's own notes about the person, kept apart from the person's guidance. */
export const COORDINATOR_NOTES_MAX_CHARS = 2000;
export const COORDINATOR_REPAIR_LIMIT_PROVENANCE = "coordinator-repair-limit";
export const COORDINATOR_PERMISSION_CATEGORIES = [
  ...ProviderRequestKind.literals,
  "thread.access",
  "*",
] as const;
export const COORDINATOR_PERMISSION_SCOPES = [
  "global",
  "project",
  "environment",
  "thread",
] as const;

const Text = Schema.String.check(Schema.isMaxLength(48_000));
const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const Label = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80));
export const CoordinatorPermissionMode = Schema.Literals(["ask", "approve", "full", "custom"]);
export const CoordinatorScope = Schema.Struct({
  kind: Schema.Literals(["global", "project", "environment", "thread", "assignment"]),
  id: Schema.NullOr(Id),
});
export const CoordinatorLabels = Schema.Struct({
  coordinatorSingular: Label,
  coordinatorPlural: Label,
  threadSingular: Label,
  threadPlural: Label,
  profileSingular: Label,
  profilePlural: Label,
  /** Whether the Coordinator's name is a role ("the Conductor") or a given name ("Claudia"). */
  coordinatorNameKind: Schema.optional(Schema.Literals(["role", "given"])),
});
/** Display names only: code, git and files keep the neutral words coordinator and thread. */
export const DEFAULT_COORDINATOR_LABELS: typeof CoordinatorLabels.Type = {
  coordinatorSingular: "Conductor",
  coordinatorPlural: "Conductors",
  threadSingular: "thread",
  threadPlural: "threads",
  profileSingular: "profile",
  profilePlural: "profiles",
  coordinatorNameKind: "role",
};
/**
 * The Coordinator's name in a sentence: a role takes the article ("the Conductor", "The
 * Conductor" to start one), a given name stands alone ("Claudia"). Labels, titles and buttons use
 * the bare `coordinatorSingular`.
 */
export function coordinatorInText(
  labels: Pick<typeof CoordinatorLabels.Type, "coordinatorSingular" | "coordinatorNameKind">,
  sentenceStart = false,
): string {
  if (labels.coordinatorNameKind === "given") return labels.coordinatorSingular;
  return `${sentenceStart ? "The" : "the"} ${labels.coordinatorSingular}`;
}
/** The Coordinator's name: the title set in Settings, or its label. Its thread carries it. */
export function coordinatorName(configuration: {
  readonly coordinatorTitle?: string | null | undefined;
  readonly labels: { readonly coordinatorSingular: string };
}): string {
  return configuration.coordinatorTitle ?? configuration.labels.coordinatorSingular;
}
export const CoordinatorCloudBinding = Schema.Struct({
  projectId: Id,
  destination: Id,
  guildModel: Id,
  repository: Id,
  environment: Id,
  branch: Id,
  head: Id,
  base: Id,
});
export const CoordinatorGuildBinding = Schema.Struct({
  id: Id,
  name: Label,
  providerInstanceId: Id,
  guildProvider: Id,
  guildAccount: Schema.NullOr(Id),
  profileId: Schema.NullOr(Id),
  environmentId: Schema.NullOr(Id),
  guildModel: Schema.optional(Schema.NullOr(Id)),
  cloud: Schema.optional(Schema.NullOr(CoordinatorCloudBinding)),
});
/** The highest mode of a thread the Coordinator may change; never full access, whatever its own. */
export const CoordinatorManagedCeiling = Schema.Literals([
  "approval-required",
  "auto-accept-edits",
  "auto",
]);
export const CoordinatorConfiguration = Schema.Struct({
  enabled: Schema.Boolean,
  coordinatorPaused: Schema.Boolean,
  labels: CoordinatorLabels,
  permissionMode: CoordinatorPermissionMode,
  placement: Schema.Literals(["automatic", "prefer-cloud", "cloud-only", "local-only"]),
  coordinatorTitle: Schema.NullOr(Label),
  coordinatorProvider: Schema.NullOr(Id),
  coordinatorModel: Schema.NullOr(Id),
  /** Only the deleted planner set it; no longer sent, and gone next release. */
  restrictionVerified: Schema.optional(Schema.Boolean),
  coordinatorProjectId: Schema.optional(Schema.NullOr(Id)),
  coordinatorThreadId: Schema.optional(Schema.NullOr(Id)),
  guildBindings: Schema.optional(Schema.Array(CoordinatorGuildBinding)),
  allowUnverifiedCloudModels: Schema.optional(Schema.Boolean),
  managedCeiling: Schema.optional(CoordinatorManagedCeiling),
  /** Off, the Coordinator changes only threads it started; on, any thread. */
  manageOtherThreads: Schema.optional(Schema.Boolean),
  /** Projects whose reviewed changes the owner merges; in the others the Coordinator does. */
  manualMergeProjects: Schema.optional(Schema.Array(Id)),
  /** How often at least, in minutes, the Coordinator hears of every unsettled thread; 15 unset. */
  checkInMinutes: Schema.optional(Schema.Int),
  /** After how many minutes waiting on the owner work frees its slot and login; 30 unset. */
  parkMinutes: Schema.optional(Schema.Int),
  /** The thread's first turn must call `coordinator_status`; without it the instance has no T3 tools. */
  threadProof: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        provider: Id,
        model: Id,
        proved: Schema.Boolean,
        reason: Schema.optional(Schema.NullOr(Text)),
        at: Schema.Number,
      }),
    ),
  ),
});
export const CoordinatorPolicy = Schema.Struct({
  id: Id,
  mode: CoordinatorPermissionMode,
  scope: CoordinatorScope,
  rules: Schema.optional(
    Schema.Array(
      Schema.Struct({
        category: Id,
        effect: Schema.Literals(["allow", "ask", "deny"]),
        resource: Schema.optional(Schema.NullOr(Text)),
      }),
    ),
  ),
  maxAccess: Schema.optional(Schema.Int),
  delegateApproval: Schema.optional(Schema.Boolean),
  allowAccessIncrease: Schema.optional(Schema.Boolean),
  expiresAt: Schema.optional(Schema.NullOr(Schema.Number)),
  revoked: Schema.optional(Schema.Boolean),
  name: Schema.optional(Schema.NullOr(Label)),
  revision: Schema.optional(Schema.Number),
});
/** What the owner allowed: folders relative to the repository, files it may delete, its access. */
export const CoordinatorGrant = Schema.Struct({
  id: Id,
  scope: CoordinatorScope,
  folders: Schema.optional(Schema.Array(Text)),
  delete: Schema.optional(Schema.Array(Text)),
  maxAccess: Schema.optional(Schema.Literals([0, 1, 2])),
  /** Danger-list rules this grant lets the host answer; the store takes them only from the owner. */
  lifts: Schema.optional(Schema.Array(Id)),
  expiresAt: Schema.optional(Schema.NullOr(Schema.Number)),
  revoked: Schema.optional(Schema.Boolean),
  actor: Schema.optional(Id),
  sourceMessageId: Schema.optional(Schema.NullOr(Id)),
  revision: Schema.optional(Schema.Number),
});
export type CoordinatorGrant = typeof CoordinatorGrant.Type;
/** A grant as the owner reads it, in Settings and as its line in the Coordinator's thread. */
export function describeCoordinatorGrant(grant: CoordinatorGrant, scopeTitle?: string): string {
  const access = ["read only", "edits and commands in its worktree", "full access"][
    grant.maxAccess ?? 1
  ];
  return [
    scopeTitle ?? (grant.scope.id ? `${grant.scope.kind} ${grant.scope.id}` : grant.scope.kind),
    grant.folders?.length ? `folders ${grant.folders.join(", ")}` : "the whole project",
    ...(grant.delete?.length ? [`may delete ${grant.delete.join(", ")}`] : []),
    ...(grant.lifts?.length ? [`lifts ${grant.lifts.join(", ")}`] : []),
    access,
    grant.expiresAt == null
      ? "no expiry"
      : `until ${DateTime.formatIso(DateTime.makeUnsafe(grant.expiresAt)).slice(0, 16).replace("T", " ")} UTC`,
  ].join("; ");
}
export const CoordinatorPermissionPreset = Schema.Struct({
  id: Id,
  name: Label,
  rules: CoordinatorPolicy.fields.rules,
  maxAccess: Schema.optional(Schema.Int),
  delegateApproval: Schema.optional(Schema.Boolean),
  allowAccessIncrease: Schema.optional(Schema.Boolean),
  revision: Schema.optional(Schema.Number),
});
export const CoordinatorCatalogSource = Schema.Struct({
  id: Id,
  automaticDiscovery: Schema.optional(Schema.Boolean),
  automaticEligibility: Schema.optional(Schema.Boolean),
  stale: Schema.optional(Schema.Boolean),
  refreshing: Schema.optional(Schema.Boolean),
  failures: Schema.optional(Schema.Number),
  lastAttemptAt: Schema.optional(Schema.NullOr(Schema.Number)),
  lastSuccessAt: Schema.optional(Schema.NullOr(Schema.Number)),
  nextRefreshAt: Schema.optional(Schema.NullOr(Schema.Number)),
  discoverySupported: Schema.optional(Schema.Boolean),
  revision: Schema.optional(Schema.Number),
});
export const CoordinatorRouteSelection = Schema.Struct({
  profileId: Schema.optional(Schema.NullOr(Id)),
  provider: Schema.optional(Schema.NullOr(Id)),
  model: Schema.optional(Schema.NullOr(Id)),
  effort: Schema.optional(Schema.NullOr(Id)),
  account: Schema.optional(Schema.NullOr(Id)),
  destination: Schema.optional(Schema.NullOr(Id)),
});
export const CoordinatorOverride = Schema.Struct({
  id: Id,
  scope: CoordinatorScope,
  selection: CoordinatorRouteSelection,
  sourceGoalId: Schema.optional(Schema.NullOr(Id)),
  sourceGoalRevision: Schema.optional(Schema.NullOr(Schema.Number)),
  provenance: Schema.optional(Schema.NullOr(Text)),
  revision: Schema.optional(Schema.Number),
});
export const CoordinatorCard = Schema.Struct({
  id: Id,
  threadId: Id,
  environmentId: Id,
  projectId: Id,
  purpose: Text,
  status: Id,
  instructionRevision: Schema.Number,
  profileId: Schema.NullOr(Id),
  provider: Schema.NullOr(Id),
  model: Schema.NullOr(Id),
  effort: Schema.NullOr(Id),
  destination: Schema.NullOr(Id),
  assignmentId: Schema.NullOr(Id),
  blocker: Schema.NullOr(Text),
  nextStep: Schema.NullOr(Text),
  dependencies: Schema.Array(Id),
  acceptanceCriteria: Schema.Array(Text),
  evidence: Schema.Array(Text),
  summaryUpdatedAt: Schema.NullOr(Schema.Number),
  settled: Schema.Boolean,
  archived: Schema.Boolean,
  stale: Schema.Boolean,
  verified: Schema.Boolean,
  revision: Schema.Number,
});
export const COORDINATOR_GOAL_PURPOSE_MAX_CHARS = 4_000;
export const CoordinatorGoal = Schema.Struct({
  id: Id,
  purpose: Schema.String.check(
    Schema.makeFilter(
      (value: string) => Array.from(value).length <= COORDINATOR_GOAL_PURPOSE_MAX_CHARS,
    ),
  ),
  status: Schema.optional(Id),
  priority: Schema.optional(Schema.Int),
  acceptanceCriteria: Schema.optional(Schema.Array(Text)),
  dependencies: Schema.optional(Schema.Array(Id)),
  authorizedScope: Schema.optional(Schema.Array(Id)),
  assignmentIds: Schema.optional(Schema.Array(Id)),
  evidence: Schema.optional(Schema.Array(Text)),
  integrationOwner: Schema.optional(Schema.NullOr(Id)),
  maxAttempts: Schema.optional(Schema.NullOr(Schema.Int)),
  budgetMicros: Schema.optional(Schema.NullOr(Schema.Number)),
  budgetSeconds: Schema.optional(Schema.NullOr(Schema.Number)),
  projectId: Schema.optional(Schema.NullOr(Id)),
  // Paths the goal's change may touch; goals of one project whose paths overlap run one at a time.
  touches: Schema.optional(Schema.Array(Text)),
  verified: Schema.optional(Schema.Boolean),
  revision: Schema.optional(Schema.Number),
});
const Record = Schema.Record(Schema.String, Schema.Unknown);
export const CoordinatorReservation = Schema.Struct({
  id: Id,
  owner: Id,
  expiresAt: Schema.Number,
  policyRevision: Id,
  sharedCapacity: Schema.Boolean,
});
export const CoordinatorTaskRank = Schema.Literals(["F", "E", "D", "C", "B", "A", "S"]);
export const CoordinatorWorkRole = Schema.Literals([
  "adventurer",
  "reviewer",
  "questwright",
  "archmage",
  "priestess",
  "petitioner",
  "swordsaint",
]);
export const CoordinatorSupersession = Schema.Struct({
  assignmentId: Id,
  replacementAssignmentId: Id,
  digest: Id,
  sourceRevision: Schema.Number,
});
export const CoordinatorReviewSubject = Schema.Struct({
  assignmentId: Id,
  executionId: Id,
  digest: Id,
});
export const CoordinatorAssignment = Schema.Struct({
  id: Id,
  idempotencyKey: Id,
  cardId: Id,
  goalId: Schema.NullOr(Id),
  route: CoordinatorRouteSelection,
  instructionRevision: Schema.Number,
  pauseRevision: Schema.Number,
  grantRevision: Schema.Number,
  reservation: CoordinatorReservation,
  status: Id,
  brief: Text,
  /** What its thread is called: the title its delegation gave. */
  title: Schema.optional(Label),
  returnRoute: Text,
  rank: Schema.optional(CoordinatorTaskRank),
  role: Schema.optional(CoordinatorWorkRole),
  skills: Schema.optional(Schema.Array(Label).check(Schema.isMaxLength(16))),
  reviewSubjects: Schema.optional(
    Schema.Array(CoordinatorReviewSubject).check(Schema.isMaxLength(16)),
  ),
  reviewGoalDigest: Schema.optional(Schema.NullOr(Id)),
  supersedes: Schema.optional(Schema.Array(Id).check(Schema.isMaxLength(16))),
  reviewSupersessions: Schema.optional(
    Schema.Array(CoordinatorSupersession).check(Schema.isMaxLength(32)),
  ),
  receipt: Schema.NullOr(Record),
  executionId: Schema.NullOr(Id),
  actualModel: Schema.NullOr(Id),
  actualEffort: Schema.NullOr(Id),
  identityVerified: Schema.Boolean,
  groupPauseRevision: Schema.NullOr(Schema.Number),
  pauseStatus: Schema.NullOr(Text),
  resumeSupported: Schema.Boolean,
  independentlyPaused: Schema.Boolean,
  progressAt: Schema.NullOr(Schema.Number),
  lastContactAt: Schema.NullOr(Schema.Number),
  progressDeadline: Schema.NullOr(Schema.Number),
  checkIns: Schema.Number,
  attempts: Schema.Number,
  revision: Schema.Number,
});
export const CoordinatorAction = Schema.Struct({
  id: Id,
  kind: Id,
  assignmentId: Schema.NullOr(Id),
  threadId: Schema.NullOr(Id),
  environmentId: Schema.NullOr(Id),
  payload: Record,
  status: Id,
  revision: Schema.Number,
  createdAt: Schema.Number,
  pauseRevision: Schema.Number,
  instructionRevision: Schema.NullOr(Schema.Number),
  grantRevision: Schema.NullOr(Schema.Number),
});
export const CoordinatorCatalogModel = Schema.Struct({
  manuallyQuarantined: Schema.optional(Schema.Boolean),
  id: Id,
  sourceId: Id,
  provider: Id,
  model: Id,
  destination: Id,
  account: Schema.NullOr(Id),
  aliases: Schema.Array(Id),
  efforts: Schema.Array(Id),
  state: Id,
  compatible: Schema.Boolean,
  accessible: Schema.Boolean,
  policyAllowed: Schema.Boolean,
  qualificationVerified: Schema.Boolean,
  identityVerified: Schema.Boolean,
  contextTokens: Schema.NullOr(Schema.Number),
  outputTokens: Schema.NullOr(Schema.Number),
  priceMicros: Schema.NullOr(Schema.Number),
  pricingProvenance: Schema.NullOr(Text),
  evidence: Schema.Array(Text),
  stale: Schema.Boolean,
  missingRefreshes: Schema.Number,
  discoveredAt: Schema.Number,
  revision: Schema.Number,
});
export const CoordinatorPolicyPreview = Schema.Struct({
  effect: Schema.Literals(["allow", "ask", "deny"]),
  reason: Schema.NullOr(Text),
  policyIds: Schema.Array(Id),
  policyRevision: Schema.Number,
  maxAccess: Schema.Number,
  accessIncreaseUnknown: Schema.Boolean,
  hypothetical: Schema.Literal(true),
});
const GuidanceText = Schema.String.check(
  Schema.makeFilter((value: string) => Array.from(value).length <= COORDINATOR_GUIDANCE_MAX_CHARS),
);
const NotesText = Schema.String.check(
  Schema.makeFilter((value: string) => Array.from(value).length <= COORDINATOR_NOTES_MAX_CHARS),
);
export const CoordinatorSnapshot = Schema.Struct({
  guidance: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        threadId: Id,
        customPrompt: Text,
        memory: Text,
        coordinatorNotes: Schema.optional(Text),
        revision: Schema.Number,
      }),
    ),
  ),
  permissionPreview: Schema.optional(CoordinatorPolicyPreview),
  permissionPresets: Schema.optional(Schema.Array(CoordinatorPermissionPreset)),
  catalogSources: Schema.optional(Schema.Array(CoordinatorCatalogSource)),
  protocolVersion: Schema.Literal(1),
  revision: Schema.Number,
  policyRevision: Schema.optional(Schema.Number),
  configuration: CoordinatorConfiguration,
  pause: Schema.Struct({
    active: Schema.Boolean,
    revision: Schema.Number,
    label: Schema.optional(Schema.String),
  }),
  cards: Schema.Array(CoordinatorCard),
  goals: Schema.Array(CoordinatorGoal),
  pendingActions: Schema.Array(CoordinatorAction),
  catalog: Schema.Array(CoordinatorCatalogModel),
  overrides: Schema.Array(CoordinatorOverride),
  permissions: Schema.Array(CoordinatorPolicy),
  grants: Schema.optional(Schema.Array(CoordinatorGrant)),
  /** Models that passed the Coordinator fleet eval, from its results file in the state directory. */
  fleetPassed: Schema.optional(Schema.Array(Id)),
  /** Grants the Coordinator asked for that the owner's words did not cover: theirs to make. */
  grantProposals: Schema.optional(
    Schema.Array(
      Schema.Struct({
        grant: CoordinatorGrant,
        reason: Text,
        sourceMessageId: Schema.optional(Id),
      }),
    ),
  ),
  /** Reviewed changes waiting for the owner to merge, in projects whose automatic merge is off. */
  ownerMerges: Schema.optional(
    Schema.Array(
      Schema.Struct({
        goalId: Id,
        purpose: Text,
        head: Id,
        target: Id,
        /** Why it waits on the owner. */
        reason: Schema.optional(Text),
        /** `merge`: the owner's go-ahead merges it; none: the owner merges it on the host. */
        action: Schema.optional(Schema.NullOr(Schema.Literal("merge"))),
      }),
    ),
  ),
  /** Caps reached now, under which nothing new starts; a project's daily one lifts at midnight UTC. */
  budgetsReached: Schema.optional(
    Schema.Array(
      Schema.Struct({
        projectId: Schema.optional(Id),
        goalId: Schema.optional(Id),
        cap: Schema.Struct({
          micros: Schema.NullOr(Schema.Number),
          seconds: Schema.NullOr(Schema.Number),
        }),
        micros: Schema.Number,
        seconds: Schema.Number,
      }),
    ),
  ),
  /** Finished work held for the owner: what it changed outside its grant. */
  resultChecks: Schema.optional(
    Schema.Array(
      Schema.Struct({
        assignmentId: Id,
        base: Id,
        head: Id,
        passed: Schema.Boolean,
        blocking: Schema.Array(Text),
      }),
    ),
  ),
  assignments: Schema.optional(Schema.Array(CoordinatorAssignment)),
  routingWaits: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Id,
        goalId: Id,
        cardId: Id,
        status: Id,
        reason: Text,
        nextAttemptAt: Schema.Number,
        attempts: Schema.Number,
        revision: Schema.Number,
      }),
    ),
  ),
  permissionRequests: Schema.optional(Schema.Array(Record)),
  projects: Schema.optional(Schema.Array(Schema.Struct({ id: Id, title: Text }))),
  decisions: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Id,
        summary: Text,
        provenance: Text,
        cardIds: Schema.Array(Id),
        goalIds: Schema.Array(Id),
        expiresAt: Schema.NullOr(Schema.Number),
        revision: Schema.Number,
      }),
    ),
  ),
  availability: Schema.optional(
    Schema.Struct({
      available: Schema.Boolean,
      reason: Schema.optional(Schema.String),
      // Epoch milliseconds, while the store is down.
      since: Schema.optional(Schema.Number),
      // Only the deleted planner sent these two; gone next release.
      attempts: Schema.optional(Schema.Number),
      nextAttemptAt: Schema.optional(Schema.Number),
    }),
  ),
});
export type CoordinatorSnapshot = typeof CoordinatorSnapshot.Type;
const Spent = { micros: Schema.NullOr(Schema.Number), seconds: Schema.NullOr(Schema.Number) };
export const CoordinatorCloudRun = Schema.Struct({
  id: Schema.Number,
  assignmentId: Id,
  kind: Schema.Literals(["codex-cloud", "claude-cloud"]),
  branch: Text,
  model: Schema.NullOr(Id),
  effort: Schema.NullOr(Id),
  login: Schema.NullOr(Text),
  state: Schema.Literals(["out", "collected", "abandoned", "lost", "unstopped", "ended"]),
  startedAt: Schema.Number,
  endedAt: Schema.NullOr(Schema.Number),
  /** The last commit seen on the run's branch, and when it was first seen; null before one. */
  branchHead: Schema.NullOr(Id),
  movedAt: Schema.NullOr(Schema.Number),
});
/** A request the host never answers for a delegated thread: it always goes to the owner. */
export const CoordinatorDangerRule = Schema.Struct({
  id: Id,
  label: Label,
  /** A request kind, or `*` for any. */
  category: Schema.optional(Id),
  /** Words in this order in the command, or one of them in a path; `*` matches any run. */
  words: Schema.optional(Schema.Array(Text)),
  when: Schema.optional(
    Schema.NullOr(Schema.Literals(["outside-workspace", "delete-outside-grant"])),
  ),
});
export type CoordinatorDangerRule = typeof CoordinatorDangerRule.Type;
/** What the owner's dashboard and settings read, fetched only while one of them is shown. */
export const CoordinatorBoard = Schema.Struct({
  // In full, unlike the snapshot's pages: the owner's view lists every open item.
  cards: Schema.Array(CoordinatorCard),
  assignments: Schema.Array(CoordinatorAssignment),
  goals: Schema.Array(CoordinatorGoal),
  weights: Schema.Struct({ use: Schema.Number, time: Schema.Number }),
  limits: Schema.Struct({
    inFlight: Schema.NullOr(Schema.Number),
    perLogin: Schema.NullOr(Schema.Number),
    localSlots: Schema.NullOr(Schema.Number),
  }),
  budgets: Schema.Array(Schema.Struct({ projectId: Id, ...Spent })),
  danger: Schema.optional(Schema.Array(CoordinatorDangerRule)),
  /** Spend per project since `dayStartedAt`, what a project's daily cap counts. */
  today: Schema.Array(Schema.Struct({ projectId: Id, ...Spent })),
  dayStartedAt: Schema.Number,
  /** The host's clock when it answered; clients measure time in state against it. */
  now: Schema.Number,
  spend: Schema.Array(Schema.Struct({ assignmentId: Id, goalId: Schema.NullOr(Id), ...Spent })),
  costs: Schema.Array(
    Schema.Struct({
      goalId: Id,
      repairs: Schema.NullOr(Schema.Number),
      rounds: Schema.NullOr(Schema.Number),
      /** Time as routing counts it, running rounds included; null while no round has started. */
      seconds: Schema.NullOr(Schema.Number),
      /** Use as routing counts it, a revert doubled; not the money spent, which budgets count. */
      useMicros: Schema.NullOr(Schema.Number),
      reverts: Schema.Number,
    }),
  ),
  /** What each merging goal's merge waits for; `owner` is 1 when that is the owner. */
  merges: Schema.Array(
    Schema.Struct({ goalId: Id, reason: Schema.NullOr(Text), owner: Schema.NullOr(Schema.Number) }),
  ),
  /**
   * Merged changes not yet taken back, newest first: what the owner may revert. `unreviewed` is 1
   * for one merged by hand at `head`, which no review saw.
   */
  merged: Schema.Array(
    Schema.Struct({
      goalId: Id,
      purpose: Schema.NullOr(Text),
      head: Schema.optional(Schema.NullOr(Text)),
      unreviewed: Schema.optional(Schema.NullOr(Schema.Number)),
    }),
  ),
  /** Goals whose merged change was taken back; done, their doubled cost stays in `costs`. */
  reverted: Schema.Array(Schema.Struct({ goalId: Id, purpose: Schema.NullOr(Text) })),
  /** Worktrees kept after settling, and the files they hold that git does not track unchanged. */
  kept: Schema.Array(Schema.Struct({ threadId: Id, summary: Text })),
  runs: Schema.Array(CoordinatorCloudRun),
  /** Runs nothing collects and nothing has shown ended; only the owner can say they ended. */
  unresolved: Schema.Array(Schema.Struct({ ...CoordinatorCloudRun.fields, why: Text, label: Id })),
  settled: Schema.Number,
});
export type CoordinatorBoard = typeof CoordinatorBoard.Type;
export const CoordinatorCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("guidance.save"),
    threadId: Id,
    customPrompt: GuidanceText,
    memory: GuidanceText,
    // Left out, the stored notes are kept.
    coordinatorNotes: Schema.optional(NotesText),
  }),
  Schema.Struct({
    type: Schema.Literal("permissions.preview"),
    scope: CoordinatorScope,
    category: Id,
    currentAccess: Schema.Literals([0, 1, 2]),
    requestedAccess: Schema.optional(Schema.Literals([0, 1, 2])),
    resource: Schema.optional(Text),
  }),
  Schema.Struct({
    type: Schema.Literal("configure"),
    configuration: Schema.Struct({
      enabled: Schema.optional(Schema.Boolean),
      coordinatorPaused: Schema.optional(Schema.Boolean),
      labels: Schema.optional(CoordinatorLabels),
      permissionMode: Schema.optional(CoordinatorPermissionMode),
      placement: Schema.optional(CoordinatorConfiguration.fields.placement),
      coordinatorTitle: Schema.optional(Schema.NullOr(Label)),
      coordinatorProvider: Schema.optional(Schema.NullOr(Id)),
      coordinatorModel: Schema.optional(Schema.NullOr(Id)),
      coordinatorProjectId: Schema.optional(Schema.NullOr(Id)),
      guildBindings: Schema.optional(Schema.Array(CoordinatorGuildBinding)),
      allowUnverifiedCloudModels: Schema.optional(Schema.Boolean),
      managedCeiling: Schema.optional(CoordinatorManagedCeiling),
      manageOtherThreads: Schema.optional(Schema.Boolean),
      manualMergeProjects: Schema.optional(Schema.Array(Id)),
      checkInMinutes: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
      parkMinutes: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
    }),
  }),
  Schema.Struct({
    type: Schema.Literals(["pause.all", "resume.all", "stop.all", "catalog.refresh", "cycle.run"]),
  }),
  Schema.Struct({ type: Schema.Literal("assignment.cancel"), assignmentId: Id }),
  Schema.Struct({
    type: Schema.Literal("catalog.source.set"),
    sourceId: Id,
    automaticDiscovery: Schema.optional(Schema.Boolean),
    automaticEligibility: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("catalog.model.set"),
    modelId: Id,
    quarantined: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("permissions.preset.save"),
    preset: CoordinatorPermissionPreset,
  }),
  Schema.Struct({
    type: Schema.Literal("permissions.preset.apply"),
    presetId: Id,
    scope: CoordinatorScope,
  }),
  Schema.Struct({ type: Schema.Literal("permissions.preset.delete"), presetId: Id }),
  Schema.Struct({ type: Schema.Literal("goal.upsert"), goal: CoordinatorGoal }),
  /** The goal's merged change and every merged change built on it are taken back, newest first. */
  Schema.Struct({ type: Schema.Literal("goal.revert"), goalId: Id }),
  /**
   * The owner confirmed it: a kept worktree goes, with the files it still held. `shown` is the
   * note they confirmed; it goes only while that is still what the worktree holds.
   */
  Schema.Struct({ type: Schema.Literal("worktree.remove"), threadId: Id, shown: Text }),
  /** The owner's go-ahead to merge a reviewed change now, whatever its project's switch says. */
  Schema.Struct({ type: Schema.Literal("goal.merge"), goalId: Id }),
  Schema.Struct({ type: Schema.Literal("permissions.set"), policy: CoordinatorPolicy }),
  Schema.Struct({ type: Schema.Literal("grant.set"), grant: CoordinatorGrant }),
  Schema.Struct({ type: Schema.Literal("grant.withdraw"), grantId: Id }),
  Schema.Struct({ type: Schema.Literal("grant.dismiss"), grantId: Id }),
  /**
   * Held work: the owner releases it as it is, or discards it and its assignment. `head` is the
   * commit they were shown; a later check of another commit is not released.
   */
  Schema.Struct({ type: Schema.Literal("result.accept"), assignmentId: Id, head: Id }),
  Schema.Struct({ type: Schema.Literal("result.discard"), assignmentId: Id }),
  Schema.Struct({
    type: Schema.Literal("permission.respond"),
    requestId: Id,
    decision: Schema.Literals(["approve", "deny"]),
  }),
  Schema.Struct({
    type: Schema.Literal("override.set"),
    override: Schema.Struct({
      id: Id,
      scope: CoordinatorScope,
      selection: CoordinatorRouteSelection,
    }),
  }),
  Schema.Struct({ type: Schema.Literals(["thread.settle", "thread.reopen"]), threadId: Id }),
  // The owner's alone: caps, limits, the danger list and weights reach the store only as a direct
  // user command.
  Schema.Struct({
    type: Schema.Literal("board.budget"),
    target: Schema.Union([Schema.Struct({ goalId: Id }), Schema.Struct({ projectId: Id })]),
    cap: Schema.Struct({
      micros: Schema.optional(Schema.NullOr(Schema.Int)),
      seconds: Schema.optional(Schema.NullOr(Schema.Int)),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("board.limits"),
    limits: Schema.Struct({
      inFlight: Schema.optional(Schema.Int),
      perLogin: Schema.optional(Schema.Int),
      localSlots: Schema.optional(Schema.Int),
    }),
  }),
  Schema.Struct({ type: Schema.Literal("danger.set"), rules: Schema.Array(CoordinatorDangerRule) }),
  Schema.Struct({ type: Schema.Literal("danger.reset") }),
  Schema.Struct({
    type: Schema.Literal("router.weights.set"),
    weights: Schema.Struct({ use: Schema.Number, time: Schema.Number }),
  }),
  // The owner checked the cloud: this lost or unstopped run ended. `id` names one of two.
  Schema.Struct({
    type: Schema.Literal("cloud.ended"),
    assignmentId: Id,
    id: Schema.optional(Schema.Number),
  }),
]);
export type CoordinatorCommand = typeof CoordinatorCommand.Type;
export class CoordinatorError extends Schema.TaggedError<CoordinatorError>()("CoordinatorError", {
  operation: Schema.String,
  reason: Schema.Literals([
    "unavailable",
    "unsupported",
    "invalid",
    "transport",
    "destination",
    "policy",
  ]),
  cause: Schema.optional(Schema.Defect()),
  /** A plain sentence for the person, where the failure is theirs to act on. */
  detail: Schema.optional(Schema.String),
}) {
  override get message() {
    return this.detail ?? `${this.operation} failed (${this.reason}).`;
  }
}

export const CoordinatorDelegateInput = Schema.Struct({
  supersedes: Schema.optional(Schema.Array(Id).check(Schema.isMaxLength(16))),
  rank: Schema.optional(CoordinatorTaskRank),
  role: Schema.optional(CoordinatorWorkRole),
  skills: Schema.optional(Schema.Array(Label).check(Schema.isMaxLength(16))),
  reviewSubjects: Schema.optional(Schema.Array(Id).check(Schema.isMaxLength(16))),
  goalId: Id,
  parentThreadId: Id,
  task: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_000)),
  title: Label,
  target: CoordinatorRouteSelection,
});

/** A delegation the store holds while it waits for a route, retried as it was asked. */
export const CoordinatorDelegateAction = Schema.Struct({
  kind: Schema.Literal("delegate"),
  ...CoordinatorDelegateInput.fields,
});
export type CoordinatorDelegateAction = typeof CoordinatorDelegateAction.Type;

export const CoordinatorDeliverableRead = Schema.Struct({
  assignmentId: Id,
  projectId: Id,
  kind: Schema.Literals(["text", "patch"]),
  cursor: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  limit: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(8000)),
  ),
  digest: Schema.optional(Id),
});
export const CoordinatorDeliverableChunk = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  status: Schema.Literal("completed"),
  executionId: Id,
  kind: Schema.Literals(["text", "patch"]),
  digest: Id,
  totalCharacters: Schema.Int,
  chunk: Schema.String.check(Schema.isMaxLength(8000)),
  nextCursor: Schema.NullOr(Schema.Int),
  receipt: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

/** What the Coordinator's thread plans: goals in order of rank, never their scope, which is the owner's. */
export const CoordinatorPlanInput = Schema.Struct({
  goals: Schema.Array(
    Schema.Struct({
      id: Id,
      purpose: CoordinatorGoal.fields.purpose,
      priority: Schema.optional(Schema.Int),
      dependencies: Schema.optional(Schema.Array(Id).check(Schema.isMaxLength(32))),
      touches: CoordinatorGoal.fields.touches,
      acceptanceCriteria: Schema.optional(Schema.Array(Text).check(Schema.isMaxLength(32))),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
});
export const CoordinatorPlanResult = Schema.Struct({
  goals: Schema.Array(
    Schema.Struct({ id: Id, revision: Schema.Number, authorizedScope: Schema.Array(Id) }),
  ),
});
export const CoordinatorPageInput = Schema.Struct({
  cursor: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export const CoordinatorStatusPage = Schema.Struct({
  paused: Schema.Boolean,
  counts: Schema.Struct({
    goals: Schema.Int,
    threads: Schema.Int,
    assignments: Schema.Int,
    permissionRequests: Schema.Int,
    blocked: Schema.Int,
  }),
  blocked: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(["goal", "assignment", "routing"]),
      id: Id,
      reason: Text,
    }),
  ),
  nextCursor: Schema.NullOr(Schema.Int),
  /** The owner's standing instructions and the grants in force, read again after a compaction. */
  instructions: Schema.optional(
    Schema.Struct({ customPrompt: Schema.String, memory: Schema.String, notes: Schema.String }),
  ),
  grants: Schema.optional(Schema.Array(CoordinatorGrant)),
});
/** What changed in the threads it manages since `cursor`; passing `nextCursor` cuts what came before. */
export const CoordinatorInboxPage = Schema.Struct({
  events: Schema.Array(
    Schema.Struct({
      seq: Schema.Number,
      at: Schema.Number,
      kind: Id,
      actor: Id,
      subject: Schema.optional(Schema.NullOr(Id)),
      status: Schema.optional(Schema.NullOr(Id)),
      threadId: Schema.optional(Schema.NullOr(Id)),
      goalId: Schema.optional(Schema.NullOr(Id)),
      summary: Schema.optional(Text),
      /** What a blocked assignment waits for. */
      reason: Schema.optional(Text),
    }),
  ),
  nextCursor: Schema.Number,
  more: Schema.Boolean,
});
/** A grant the owner gave in a message they typed; what they did not write comes back as a proposal. */
export const CoordinatorGrantInput = Schema.Struct({
  ownerMessageId: Id,
  grant: Schema.Struct({
    id: Id,
    scope: CoordinatorScope,
    folders: CoordinatorGrant.fields.folders,
    delete: CoordinatorGrant.fields.delete,
    maxAccess: CoordinatorGrant.fields.maxAccess,
    expiresAt: CoordinatorGrant.fields.expiresAt,
  }),
});
export const CoordinatorGrantResult = Schema.Struct({
  granted: Schema.Boolean,
  proposal: Schema.optional(Schema.Struct({ grant: CoordinatorGrant, reason: Schema.String })),
});
/** The Coordinator's answer to an approval the rules left to it: allow, deny, or the owner's. */
export const CoordinatorApprovalInput = Schema.Struct({
  threadId: Id,
  requestId: Id,
  decision: Schema.Literals(["allow", "deny", "owner"]),
});
export const CoordinatorNotesInput = Schema.Struct({ notes: NotesText });

import { assert, it } from "@effect/vitest";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the test computes the digests the host checks.
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  type CoordinatorCommand,
  type CoordinatorSnapshot,
  CoordinatorError,
  DEFAULT_COORDINATOR_LABELS,
  EnvironmentId,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Clock from "effect/Clock";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as Projects from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageService from "../usage/UsageService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Coordinator from "./Coordinator.ts";
import * as CloudRuns from "./cloud/CloudRuns.ts";
import * as Merges from "./Merges.ts";
import * as CoordinatorRole from "./CoordinatorRole.ts";
import * as Supervisor from "./Supervisor.ts";

type Row = { readonly id: string; readonly [key: string]: unknown };
type Store = {
  /** What the supervisor knew before any read: off when no store was made or it was last off. */
  seen?: Supervisor.CoordinatorSeen | null;
  readonly cards: Array<Row>;
  readonly assignments: Array<Row>;
  readonly actions: Array<Row>;
  readonly goals?: Array<Row>;
  readonly configuration?: Record<string, unknown>;
  guidance?: { readonly threadId: string; readonly revision: number; [key: string]: unknown };
  readonly routing?: Array<Row>;
  readonly routingWaits?: Array<Row>;
  // Set, a waiting routing intent is claimed for this attempt.
  readonly claimRouting?: boolean;
  readonly catalog?: Array<Row>;
  readonly board?: unknown;
  readonly score?: (params: unknown) => unknown;
  readonly prepare?: (params: unknown) => unknown;
  // Methods the store refuses, as it refuses invalid input.
  readonly refuse?: ReadonlyArray<string>;
  // Methods the store refuses with a reason of its own, as its reply carries one.
  refusals?: Readonly<Record<string, string>>;
  readonly claim?: boolean;
  readonly waiting?: ReadonlyArray<string>;
  readonly pause?: { active: boolean };
  readonly grant?: Row;
  readonly resultPassed?: boolean;
  readonly resultHead?: string;
  // Whether the author left nothing uncommitted.
  readonly clean?: boolean;
  // What a worktree holds that git does not track unchanged.
  held?: ReadonlyArray<string>;
  readonly notes?: Record<string, Row>;
  // Settlements the host made whose steps after it are not reported done.
  readonly unfinished?: Array<Row>;
  // The commit `results.base` resolves, as an author's worktree HEAD.
  readonly baseHead?: string;
  // Status and receipt updates land on the stored assignment, as in the native store.
  readonly applyUpdates?: boolean;
  readonly merges?: Array<Row>;
  readonly reverts?: Array<Row>;
  readonly effective?: Record<string, unknown>;
  grantSetResult?: Record<string, unknown>;
  readonly permissionRequests?: Array<Row>;
  readonly signal?: (method: string, params?: unknown) => Effect.Effect<void>;
  // What the inbox holds that the Coordinator was not told of.
  pending?: {
    kinds: Record<string, number>;
    through: number;
    unread?: Record<string, number>;
  };
  // While set, every request fails as the store process would: lost, or waiting to respawn.
  readonly down?: (method: string) => "transport" | "unavailable" | undefined;
};

const PAGE = 100;
const REFUSED = Symbol("refused");
const OPEN = (row: Row) =>
  !["completed", "verified", "cancelled", "failed"].includes(`${row.status}`);

// Pages like the native store: ascending id order, `limit` rows after `cursor`.
const page = (rows: ReadonlyArray<Row>, params: { cursor?: string; limit?: number }) => {
  const limit = params.limit ?? 50;
  const after = rows
    .filter((row) => row.id > (params.cursor ?? ""))
    .toSorted((a, b) => (a.id < b.id ? -1 : 1));
  const items = after.slice(0, limit);
  return { items, nextCursor: after.length > limit ? (items.at(-1)?.id ?? null) : null };
};

const fakeSupervisor = (store: Store, requests: Array<{ method: string; params: unknown }>) =>
  Supervisor.Supervisor.of({
    available: true,
    request: (method, raw) =>
      Effect.sync(() => {
        const params = (raw ?? {}) as {
          id?: string;
          cursor?: string;
          limit?: number;
          open?: boolean;
          decision?: { goalIds?: Array<string>; cardIds?: Array<string>; expiresAt?: number };
          goal?: Row;
          coordinatorNotes?: string;
          expectedGuidanceRevision?: number;
          threadId?: string;
          customPrompt?: string;
          memory?: string;
        };
        requests.push({ method, params });
        if (store.refuse?.includes(method)) return REFUSED;
        switch (method) {
          case "snapshot":
            return {
              protocolVersion: 1,
              revision: 1,
              configuration: {
                enabled: false,
                coordinatorPaused: false,
                labels: DEFAULT_COORDINATOR_LABELS,
                permissionMode: "ask",
                placement: "automatic",
                coordinatorTitle: null,
                coordinatorProvider: null,
                coordinatorModel: null,
                ...store.configuration,
              },
              pause: { active: store.pause?.active ?? false, revision: 0 },
              ...(store.guidance ? { guidance: store.guidance } : {}),
              cards: page(store.cards, { limit: PAGE }).items,
              goals: page(
                (store.goals ?? []).filter((goal) =>
                  ["active", "blocked"].includes(`${goal.status}`),
                ),
                { limit: PAGE },
              ).items,
              assignments: page(store.assignments.filter(OPEN), { limit: PAGE }).items,
              pendingActions: page(store.actions, { limit: PAGE }).items,
              catalog: store.catalog ?? [],
              overrides: [],
              permissions: [],
              ...(store.permissionRequests
                ? { permissionRequests: store.permissionRequests, policyRevision: 7 }
                : {}),
              ...(store.routingWaits ? { routingWaits: store.routingWaits } : {}),
            };
          case "actions.list":
            return page(store.actions, params);
          case "events.pending":
            return { unread: {}, ...(store.pending ?? { kinds: {}, through: 0 }) };
          case "events.woken":
            store.pending = { through: 0, ...store.pending, kinds: {} };
            return {};
          case "actions.claim":
            return {
              action: store.actions.find((action) => action.id === params.id),
              claimed: (store.claim ?? false) && !store.waiting?.includes(String(params.id)),
            };
          case "assignments.list":
            return page(params.open ? store.assignments.filter(OPEN) : store.assignments, params);
          case "cards.get": {
            const card = store.cards.find((item) => item.id === params.id);
            if (!card) throw new Error(`missing card ${params.id}`);
            return { card };
          }
          case "cards.list":
            return page(store.cards, params);
          case "decisions.record": {
            // Native rejects a decision naming more than 32 goals or cards, or naming none
            // without an expiry.
            const { goalIds = [], cardIds = [], expiresAt } = params.decision ?? {};
            if (goalIds.length > 32 || cardIds.length > 32) throw new Error("Too many list items");
            if (goalIds.length + cardIds.length === 0 && expiresAt == null)
              throw new Error("Standing decisions require explicit applicability or an expiry");
            return { decision: params.decision };
          }
          case "configure":
            if (store.configuration) Object.assign(store.configuration, params);
            return {};
          case "goals.upsert":
            return { goal: params.goal };
          case "guidance.save":
            // Native keeps the stored notes when the person's save leaves them out.
            store.guidance = {
              threadId: params.threadId ?? "",
              customPrompt: params.customPrompt,
              memory: params.memory,
              coordinatorNotes: params.coordinatorNotes ?? store.guidance?.coordinatorNotes ?? "",
              revision: (store.guidance?.revision ?? 0) + 1,
            };
            return { guidance: store.guidance };
          case "guidance.notes.save": {
            // Native refuses notes over 2,000 characters, saved from another guidance revision, or
            // for a thread other than the configured Coordinator thread.
            const notes = params.coordinatorNotes ?? "";
            if (
              !store.guidance ||
              params.threadId !== store.configuration?.coordinatorThreadId ||
              Array.from(notes).length > 2000 ||
              params.expectedGuidanceRevision !== store.guidance.revision
            )
              return REFUSED;
            store.guidance = {
              ...store.guidance,
              coordinatorNotes: notes,
              revision: store.guidance.revision + 1,
            };
            return { guidance: store.guidance };
          }
          case "goals.get":
            return { goal: store.goals?.find((item) => item.id === params.id) };
          case "routing.ready":
            return { items: store.routing ?? [] };
          case "grants.resolve":
            return { grant: store.grant ?? null };
          case "results.base":
            return {
              base: store.baseHead ?? "base-commit",
              prefix: "projects/app/",
              branch: "main",
            };
          case "merges.list":
            return { items: store.merges ?? [] };
          case "merges.reverts":
            return { items: store.reverts ?? [] };
          case "permissions.request":
            return { status: "pending" };
          case "permissions.decide":
            return { revision: 1 };
          case "actions.get":
            return { action: store.actions.find((item) => item.id === params.id) };
          case "permissions.effective":
            return store.effective ?? { effect: "ask", policyRevision: 1 };
          case "grants.set":
            return store.grantSetResult ?? { grant: (raw as { grant: unknown }).grant };
          case "grants.withdraw":
            return { grant: { ...store.grant, revoked: true } };
          case "results.clean":
            return { clean: store.clean ?? !store.held?.length, held: store.held ?? [] };
          case "settlements.unfinished":
            return { items: store.unfinished ?? [] };
          case "decisions.get":
            return { decision: store.notes?.[`${params.id}`] ?? null };
          case "cards.find":
            return { card: store.cards.find((item) => item.threadId === params.threadId) };
          case "assignments.update": {
            const row = store.assignments.find((item) => item.id === params.id);
            const update = raw as { status?: string; receipt?: Record<string, unknown> };
            if (store.applyUpdates && row)
              Object.assign(row, {
                ...(update.status ? { status: update.status } : {}),
                ...(update.receipt ? { receipt: update.receipt } : {}),
              });
            return { assignment: row };
          }
          case "results.check":
            return {
              resultCheck: {
                passed: store.resultPassed ?? false,
                base: "base-commit",
                head: store.resultHead ?? "base-commit",
              },
            };
          case "routing.claim": {
            const routing = store.routing?.find((item) => item.id === params.id);
            return store.claimRouting && routing
              ? {
                  routingIntent: { ...routing, reservationKey: `${routing.id}:routing:2` },
                  claimed: true,
                }
              : {};
          }
          case "overrides.resolve":
            return { selection: {} };
          case "assignments.get":
            return { assignment: store.assignments.find((item) => item.id === params.id) };
          case "board.view":
            return {
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
          case "board.next":
            return (
              store.board ?? {
                next: [],
                waiting: [],
                capacity: { limits: { inFlight: null, perLogin: null, localSlots: null } },
              }
            );
          case "router.score":
            return store.score?.(params) ?? { pick: null, scores: [] };
          case "assignments.prepare":
            return store.prepare?.(params) ?? {};
          default:
            return {};
        }
      }).pipe(
        Effect.filterOrFail(
          (result) => result !== REFUSED,
          () => new CoordinatorError({ operation: method, reason: "policy" }),
        ),
        Effect.filterOrFail(
          () => store.refusals?.[method] === undefined,
          () =>
            new CoordinatorError({
              operation: method,
              reason: "policy",
              cause: { code: "forbidden", message: store.refusals?.[method] },
            }),
        ),
        Effect.flatMap((result) => {
          const down = store.down?.(method);
          return down
            ? Effect.fail(new CoordinatorError({ operation: method, reason: down }))
            : Effect.succeed(result);
        }),
        Effect.tap(() => store.signal?.(method, raw) ?? Effect.void),
        Effect.tap((result) =>
          Effect.sync(() => {
            if (method !== "snapshot" || store.down?.(method)) return;
            const { configuration } = result as { configuration: { enabled: boolean } };
            store.seen = {
              enabled: configuration.enabled,
              coordinatorThreadId: null,
              paused: !configuration.enabled,
            };
          }),
        ),
      ),
    lastSeen: Effect.sync(() => store.seen ?? null),
  });

const harness = (
  store: Store,
  requests: Array<{ method: string; params: unknown }>,
  threads: Partial<Threads.ThreadManagementService["Service"]> = {},
  services: {
    instances?: Partial<ProviderInstanceRegistry.ProviderInstanceRegistry["Service"]>;
    providers?: Partial<ProviderRegistry.ProviderRegistry["Service"]>;
    settings?: Partial<ServerSettings.ServerSettingsService["Service"]>;
    projects?: Partial<Projects.ProjectService["Service"]>;
    launch?: Partial<ThreadLaunch.ThreadLaunchService["Service"]>;
    cloud?: Partial<CloudRuns.CloudRuns["Service"]>;
    merges?: Partial<Merges.Merges["Service"]>;
    orchestrator?: Partial<OrchestratorMcpService.OrchestratorMcpService["Service"]>;
    usage?: Partial<UsageService.UsageService["Service"]>;
    runner?: Partial<ProcessRunner.ProcessRunner["Service"]>;
  } = {},
  // The real supervisor, for what it starts; the fake store's otherwise.
  supervisor?: Layer.Layer<
    Supervisor.Supervisor,
    never,
    ServerConfig.ServerConfig | NodeServices.NodeServices
  >,
) =>
  Layer.mergeAll(Coordinator.layer, CoordinatorRole.layerWithoutDependencies).pipe(
    Layer.provideMerge(
      (supervisor ?? Layer.succeed(Supervisor.Supervisor, fakeSupervisor(store, requests))).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.mock(CloudRuns.CloudRuns)({ supports: () => false, ...services.cloud }),
            Layer.mock(Merges.Merges)({ landed: () => Effect.succeed(null), ...services.merges }),
            Layer.mock(Threads.ThreadManagementService)({
              getShellSnapshot: () => Effect.succeed({ threads: [] } as never),
              ...threads,
            }),
            Layer.mock(EffectOutbox.EffectOutboxV2)({}),
            Layer.mock(ThreadLaunch.ThreadLaunchService)(services.launch ?? {}),
            Layer.mock(PeerForwarding.PeerForwarding)({}),
            Layer.mock(RemoteDelegation.RemoteDelegation)({}),
            Layer.mock(OrchestratorMcpService.OrchestratorMcpService)(services.orchestrator ?? {}),
            Layer.mock(ProviderRegistry.ProviderRegistry)(services.providers ?? {}),
            Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)(services.instances ?? {}),
            Layer.mock(ServerEnvironment.ServerEnvironment)({
              getEnvironmentId: Effect.succeed(EnvironmentId.make("local")),
            }),
            Layer.mock(Projects.ProjectService)({
              listShells: () => Effect.succeed([]),
              getById: () => Effect.succeedNone,
              ...services.projects,
            }),
            Layer.mock(ServerSettings.ServerSettingsService)(services.settings ?? {}),
            Layer.mock(UsageService.UsageService)(services.usage ?? {}),
            Layer.mock(ProcessRunner.ProcessRunner)(services.runner ?? {}),
            SecureRandom.layerWebCrypto,
            ServerConfig.ServerConfig.layerTest(process.cwd(), {
              prefix: "coordinator-test-",
            }).pipe(Layer.provideMerge(NodeServices.layer)),
          ),
        ),
      ),
    ),
  );

const action = (id: string, status: string) => ({
  id,
  kind: "assignment.cancel",
  assignmentId: null,
  threadId: null,
  environmentId: null,
  payload: {},
  status,
  revision: 1,
  createdAt: 0,
  pauseRevision: 0,
  instructionRevision: null,
  grantRevision: null,
});

const index = (value: number) => String(value).padStart(3, "0");

it.effect("a pending control after a full page of unresolved controls is still claimed", () => {
  const store: Store = {
    cards: [],
    assignments: [],
    actions: [
      ...Array.from({ length: PAGE }, (_, value) => action(`a${index(value)}`, "uncertain")),
      ...Array.from({ length: 7 }, (_, value) => action(`b-cancel-${value}`, "pending")),
    ],
    claim: true,
  };
  const requests: Array<{ method: string; params: unknown }> = [];
  return Effect.gen(function* () {
    const coordinator = yield* Coordinator.Coordinator;
    yield* coordinator.command({
      type: "permission.respond",
      requestId: "request",
      decision: "deny",
    });
    const claimed = requests.filter((request) => request.method === "actions.claim");
    assert.deepEqual(
      claimed.map((request) => request.params),
      // One drain executes at most five controls.
      Array.from({ length: 5 }, (_, value) => ({ id: `b-cancel-${value}` })),
    );
  }).pipe(Effect.provide(harness(store, requests)));
});

it.effect("answers waiting for room do not hold up the controls behind them", () => {
  const waiting = Array.from({ length: 6 }, (_, value) => `a-answer-${value}`);
  const store: Store = {
    cards: [],
    assignments: [],
    actions: [...waiting, "b-cancel"].map((id) => action(id, "pending")),
    claim: true,
    waiting,
  };
  const requests: Array<{ method: string; params: unknown }> = [];
  return Effect.gen(function* () {
    const coordinator = yield* Coordinator.Coordinator;
    yield* coordinator.command({
      type: "permission.respond",
      requestId: "request",
      decision: "deny",
    });
    assert.deepEqual(
      requests.filter((request) => request.method === "actions.claim").at(-1)?.params,
      { id: "b-cancel" },
    );
  }).pipe(Effect.provide(harness(store, requests)));
});

it.effect("an accepted review finishes each reviewed route's outcome as merged", () => {
  const event = {
    eventId: "outcome:goal:7",
    goalId: "goal",
    subjects: [
      {
        assignmentId: "author",
        route: { provider: "replay", model: "model", effort: "high", destination: "local" },
        rank: "A",
        digest: "a".repeat(64),
      },
    ],
  };
  const store: Store = {
    cards: [],
    assignments: [],
    actions: [
      { ...action("outcome:goal:7", "pending"), kind: "outcome.accepted", payload: { event } },
    ],
    claim: true,
  };
  const requests: Array<{ method: string; params: unknown }> = [];
  return Effect.gen(function* () {
    const coordinator = yield* Coordinator.Coordinator;
    yield* coordinator.command({
      type: "permission.respond",
      requestId: "request",
      decision: "deny",
    });
    const sent = (method: string) =>
      requests.filter((request) => request.method === method).map((request) => request.params);
    assert.deepEqual(sent("outcomes.record"), [
      {
        round: {
          assignmentId: "merged:author",
          goalId: "goal",
          instance: "replay",
          model: "model",
          effort: "high",
          rank: "A",
          usedMicros: 0,
          startedAt: 0,
          endedAt: 0,
          blockedSeconds: 0,
          finish: "merged",
        },
      },
    ]);
    const [ack] = sent("actions.ack") as Array<{ result: { eventId: string; digest: string } }>;
    assert.equal(ack?.result.eventId, "outcome:goal:7");
    assert.match(ack?.result.digest ?? "", /^[0-9a-f]{64}$/);
  }).pipe(Effect.provide(harness(store, requests)));
});

it.effect("caps, limits, weights, the danger list and a lost run's end are the owner's", () => {
  const store: Store = {
    cards: [],
    assignments: [],
    actions: [],
    configuration: { enabled: true },
  };
  const requests: Array<{ method: string; params: unknown }> = [];
  const ended: Array<unknown> = [];
  return Effect.gen(function* () {
    const coordinator = yield* Coordinator.Coordinator;
    yield* coordinator.command({
      type: "board.budget",
      target: { projectId: "project" },
      cap: { seconds: 3600 },
    });
    yield* coordinator.command({ type: "board.limits", limits: { inFlight: 4 } });
    yield* coordinator.command({ type: "router.weights.set", weights: { use: 1, time: 2 } });
    const rules = [{ id: "tests", label: "Running the full suite", words: ["vp", "test"] }];
    yield* coordinator.command({ type: "danger.set", rules });
    yield* coordinator.command({ type: "danger.reset" });
    assert.deepEqual(
      requests.filter((request) =>
        [
          "board.budget",
          "board.limits",
          "router.weights.set",
          "danger.set",
          "danger.reset",
        ].includes(request.method),
      ),
      [
        {
          method: "board.budget",
          params: { projectId: "project", cap: { seconds: 3600 }, actor: "user" },
        },
        { method: "board.limits", params: { limits: { inFlight: 4 }, actor: "user" } },
        { method: "router.weights.set", params: { weights: { use: 1, time: 2 }, actor: "user" } },
        { method: "danger.set", params: { rules, actor: "user" } },
        { method: "danger.reset", params: { actor: "user" } },
      ],
    );
    yield* coordinator.command({ type: "cloud.ended", assignmentId: "lost", id: 7 });
    assert.deepEqual(ended, [{ assignmentId: "lost", id: 7, actor: "user" }]);
  }).pipe(
    Effect.provide(
      harness(
        store,
        requests,
        {},
        {
          cloud: {
            ended: (input) =>
              Effect.sync(() => {
                ended.push(input);
                return true;
              }),
          },
        },
      ),
    ),
  );
});

it.effect("the board adds each running round as it would be recorded now", () => {
  const running = {
    ...assignment("running", "t"),
    goalId: "goal",
    rank: "A" as const,
    receipt: { threadId: "t", startedAt: 1_000, blockedSeconds: 2 },
  };
  const store: Store = {
    configuration: { enabled: true },
    cards: [],
    assignments: [running, { ...assignment("done", "u"), goalId: "goal", status: "completed" }],
    actions: [],
  };
  const requests: Array<{ method: string; params: unknown }> = [];
  return Effect.gen(function* () {
    const coordinator = yield* Coordinator.Coordinator;
    yield* TestClock.adjust("10 seconds");
    yield* coordinator.board;
    const view = requests.find((request) => request.method === "board.view");
    assert.deepEqual(view?.params, {
      running: [
        {
          assignmentId: "running",
          goalId: "goal",
          instance: "replay",
          model: "model",
          effort: "default",
          rank: "A",
          usedMicros: null,
          startedAt: 1_000,
          endedAt: 10_000,
          blockedSeconds: 2,
        },
      ],
    });
  }).pipe(Effect.provide(harness(store, requests)));
});

const card = (threadId: string) => ({
  id: `local:${threadId}`,
  threadId,
  environmentId: "local",
  projectId: "project",
  purpose: `Purpose of ${threadId}`,
  status: "running",
  instructionRevision: 0,
  profileId: null,
  provider: null,
  model: null,
  effort: null,
  destination: "local",
  assignmentId: null,
  blocker: null,
  nextStep: null,
  dependencies: [],
  acceptanceCriteria: [],
  evidence: [],
  summaryUpdatedAt: null,
  settled: false,
  archived: false,
  stale: false,
  verified: false,
  revision: 1,
});

const assignment = (id: string, threadId: string) => ({
  id,
  idempotencyKey: `request:${id}`,
  cardId: `local:${threadId}`,
  goalId: null,
  route: { provider: "replay", model: "model", destination: "local" },
  instructionRevision: 0,
  pauseRevision: 0,
  grantRevision: 0,
  reservation: {
    id: `reservation:${id}`,
    owner: "t3:local",
    expiresAt: 1,
    policyRevision: "policy-v1",
    sharedCapacity: true,
  },
  status: "running",
  brief: "Build the bounded result.",
  returnRoute: "coordinator:coordinator",
  receipt: { threadId },
  executionId: `run:${threadId}`,
  actualModel: null,
  actualEffort: null,
  identityVerified: true,
  groupPauseRevision: null,
  pauseStatus: null,
  resumeSupported: true,
  independentlyPaused: false,
  progressAt: null,
  lastContactAt: null,
  progressDeadline: null,
  checkIns: 0,
  attempts: 1,
  revision: 1,
});

it.effect("each author gets its own worktree, in the mode its grant allows", () =>
  Effect.gen(function* () {
    const dispatch = (id: string, role: string) => ({
      ...action(`dispatch:${id}`, "pending"),
      kind: "dispatch",
      assignmentId: id,
      payload: {
        assignment: {
          ...assignment(id, "parent"),
          role,
          status: "queued",
          receipt: null,
          // Work stored before delegations kept their title has none.
          ...(id === "one" ? { title: "multiply" } : {}),
        },
        card: card("parent"),
        touches: ["src"],
      },
    });
    const launched: Array<{ runtimeMode: string; workspaceStrategy: unknown; title: string }> = [];
    const run = (
      grant: Row | undefined,
      actions: Array<Row> = [dispatch("one", "adventurer"), dispatch("two", "adventurer")],
    ) => {
      const store: Store = {
        cards: [card("parent")],
        assignments: [{ ...assignment("written", "author"), status: "completed" }],
        actions,
        claim: true,
        ...(grant ? { grant } : {}),
      };
      const requests: Array<{ method: string; params: unknown }> = [];
      return Effect.gen(function* () {
        const coordinator = yield* Coordinator.Coordinator;
        yield* coordinator.command({ type: "cycle.run" });
        return requests;
      }).pipe(
        Effect.provide(
          harness(
            store,
            requests,
            {
              getThreadRecords: () => Effect.succeed({ runtimeRequests: [] } as never),
              getThreadShell: (threadId) =>
                Effect.succeed(
                  (threadId === "parent"
                    ? {
                        id: "parent",
                        archivedAt: null,
                        latestUserAuthoredMessageAt: null,
                        projectId: "project",
                        worktreePath: "/work/parent",
                        branch: "main",
                        // A parent at full access must not pass it on.
                        runtimeMode: "full-access",
                        interactionMode: "default",
                      }
                    : threadId === "author"
                      ? { id: "author", worktreePath: "/work/one", branch: "t3/one" }
                      : null) as never,
                ),
            },
            {
              providers: {
                getProviders: Effect.succeed([
                  { instanceId: "replay", enabled: true, models: [{ slug: "model" }] },
                ] as never),
              },
              settings: {
                getSettings: Effect.succeed({ linkedEnvironmentsEnabled: false } as never),
              },
              projects: {
                getById: () => Effect.succeedSome({ workspaceRoot: "/repo/projects/app" } as never),
              },
              launch: {
                launch: (input) =>
                  Effect.sync(() => {
                    launched.push(input);
                    return { threadId: input.threadId, projection: { runs: [] } } as never;
                  }),
              },
            },
          ),
        ),
      );
    };
    const requests = yield* run(undefined);
    // A thread is called what its delegation called it, not what its parent is called.
    assert.deepEqual(
      launched.map((input) => input.title),
      ["multiply", card("parent").purpose],
    );
    assert.deepEqual(
      launched.map((input) => [input.runtimeMode, input.workspaceStrategy]),
      [
        ["approval-required", { type: "worktree", baseRef: "base-commit" }],
        ["approval-required", { type: "worktree", baseRef: "base-commit" }],
      ],
    );
    assert.deepEqual(requests.find((request) => request.method === "results.base")?.params, {
      repository: "/work/parent",
      ref: "main",
      project: "/repo/projects/app",
    });
    const acked = requests.find((request) => request.method === "actions.ack")?.params as {
      result: { receipt: Record<string, unknown> };
    };
    assert.deepInclude(acked.result.receipt, {
      base: "base-commit",
      prefix: "projects/app/",
      grant: null,
      touches: ["src"],
    });
    assert.deepInclude(requests.find((request) => request.method === "grants.resolve")?.params, {
      threadId: "coordinator:request:one",
      assignmentId: "one",
    });
    // A reviewer reads where the work it reviews is checked out, not in its parent's folder.
    launched.length = 0;
    yield* run(undefined, [
      {
        ...dispatch("review", "reviewer"),
        payload: {
          assignment: {
            ...dispatch("review", "reviewer").payload.assignment,
            reviewSubjects: [
              { assignmentId: "written", executionId: "run:author", digest: "digest" },
            ],
          },
          card: card("parent"),
        },
      },
    ]);
    assert.deepEqual(launched[0]?.workspaceStrategy, {
      type: "existing_worktree",
      worktreePath: "/work/one",
      branch: "t3/one",
    });
    launched.length = 0;
    const granted = yield* run({
      id: "grant",
      scope: { kind: "project", id: "project" },
      folders: ["src"],
      maxAccess: 1,
    });
    // The grant at dispatch is what the result is checked against later.
    assert.deepInclude(
      (
        granted.find((request) => request.method === "actions.ack")!.params as {
          result: { receipt: Record<string, unknown> };
        }
      ).result.receipt,
      { grant: { id: "grant", folders: ["src"], delete: [] } },
    );
    assert.deepEqual(
      launched.map((input) => input.runtimeMode),
      ["auto-accept-edits", "auto-accept-edits"],
    );
    launched.length = 0;
    yield* run({ id: "grant", scope: { kind: "project", id: "project" }, maxAccess: 0 });
    assert.deepEqual(
      launched.map((input) => input.runtimeMode),
      ["approval-required", "approval-required"],
    );
  }),
);

it.effect(
  "a dispatch interrupted after launch is recovered with what its result is checked by",
  () =>
    Effect.gen(function* () {
      // `crash`: the server stopped before its acknowledgment; `card-sync`: the step after launch failed.
      const recover = (interrupted: "crash" | "card-sync") => {
        const stored = { ...assignment("one", "parent"), status: "dispatching", receipt: null };
        const dispatch = {
          ...action("dispatch:one", "pending"),
          kind: "dispatch",
          assignmentId: "one",
          payload: { assignment: stored, card: card("parent"), touches: ["src"] },
        };
        let launched = false;
        let failing = true;
        const store: Store = {
          cards: [card("parent")],
          assignments: [stored],
          actions: [dispatch],
          claim: true,
          applyUpdates: true,
          grant: { id: "grant", scope: { kind: "project", id: "project" }, folders: ["src"] },
          down: (method) =>
            failing &&
            launched &&
            method === (interrupted === "crash" ? "actions.ack" : "cards.sync")
              ? "transport"
              : undefined,
        };
        const requests: Array<{ method: string; params: unknown }> = [];
        return Effect.gen(function* () {
          const coordinator = yield* Coordinator.Coordinator;
          yield* Effect.ignore(coordinator.command({ type: "cycle.run" }));
          assert.isTrue(launched);
          failing = false;
          dispatch.status = interrupted === "crash" ? "claimed" : "uncertain";
          yield* coordinator.command({ type: "cycle.run" });
          const acked = requests
            .filter((request) => request.method === "actions.ack")
            .map((request) => request.params as { status: string; result: { receipt?: Row } })
            .findLast((params) => params.status === "completed");
          return acked?.result.receipt;
        }).pipe(
          Effect.provide(
            harness(
              store,
              requests,
              {
                getThreadRecords: () => Effect.succeed({ runtimeRequests: [] } as never),
                getThreadShell: (threadId) =>
                  Effect.succeed(
                    (threadId === "parent"
                      ? {
                          id: "parent",
                          archivedAt: null,
                          latestUserAuthoredMessageAt: null,
                          projectId: "project",
                          worktreePath: "/work/parent",
                          branch: "main",
                          runtimeMode: "approval-required",
                          interactionMode: "default",
                        }
                      : threadId === "coordinator:request:one" && launched
                        ? {
                            id: threadId,
                            projectId: "project",
                            providerInstanceId: "replay",
                            modelSelection: { model: "model" },
                            latestRunId: "run:one",
                          }
                        : null) as never,
                  ),
              },
              {
                providers: {
                  getProviders: Effect.succeed([
                    { instanceId: "replay", enabled: true, models: [{ slug: "model" }] },
                  ] as never),
                },
                settings: {
                  getSettings: Effect.succeed({ linkedEnvironmentsEnabled: false } as never),
                },
                projects: {
                  getById: () =>
                    Effect.succeedSome({ workspaceRoot: "/repo/projects/app" } as never),
                },
                launch: {
                  launch: (input) =>
                    Effect.sync(() => {
                      launched = true;
                      return { threadId: input.threadId, projection: { runs: [] } } as never;
                    }),
                },
              },
            ),
          ),
        );
      };
      for (const interrupted of ["crash", "card-sync"] as const) {
        const receipt = yield* recover(interrupted);
        assert.deepInclude(receipt, {
          reconciled: true,
          base: "base-commit",
          prefix: "projects/app/",
          target: "main",
          grant: { id: "grant", folders: ["src"], delete: [] },
          touches: ["src"],
        });
        assert.isNumber(receipt?.startedAt);
      }
    }),
);

it.effect("assignments and cards beyond the first snapshot page are still observed", () => {
  // Unassigned cards fill the first card page; one assignment falls past the first assignment page.
  const store: Store = {
    cards: [
      ...Array.from({ length: PAGE }, (_, value) => card(`f${index(value)}`)),
      ...Array.from({ length: PAGE + 1 }, (_, value) => card(`t${index(value)}`)),
    ],
    assignments: Array.from({ length: PAGE + 1 }, (_, value) =>
      assignment(`a${index(value)}`, `t${index(value)}`),
    ),
    actions: [],
  };
  const requests: Array<{ method: string; params: unknown }> = [];
  const observed: Array<string> = [];
  return Effect.gen(function* () {
    const coordinator = yield* Coordinator.Coordinator;
    yield* coordinator.command({ type: "cycle.run" });
    assert.includeMembers(observed, ["t000", "t100"]);
  }).pipe(
    Effect.provide(
      harness(store, requests, {
        getThreadRecords: () => Effect.succeed({ runtimeRequests: [] } as never),
        getThreadShell: (threadId) =>
          Effect.sync(() => {
            observed.push(threadId);
            return null;
          }),
      }),
    ),
  );
});

it.effect("a finished author's work is held for the owner unless its result check passes", () =>
  Effect.gen(function* () {
    const observe = (
      resultPassed: boolean,
      worktreePath: string | null,
      receipt: Record<string, unknown> = { base: "base-commit" },
    ) => {
      const store: Store = {
        cards: [card("t1")],
        assignments: [
          {
            ...assignment("a1", "t1"),
            receipt: { threadId: "t1", ...receipt },
          },
        ],
        actions: [],
        resultPassed,
      };
      const requests: Array<{ method: string; params: unknown }> = [];
      return Effect.gen(function* () {
        const coordinator = yield* Coordinator.Coordinator;
        yield* coordinator.command({ type: "cycle.run" });
        return {
          checked: requests.find((request) => request.method === "results.check")?.params,
          status: (
            requests.find((request) => request.method === "assignments.update")!.params as {
              status: string;
            }
          ).status,
          recorded: (
            requests.find((request) => request.method === "assignments.update")!.params as {
              receipt: { worktree?: string };
            }
          ).receipt.worktree,
        };
      }).pipe(
        Effect.provide(
          harness(
            store,
            requests,
            {
              getThreadRecords: () =>
                Effect.succeed({
                  runtimeRequests: [],
                  runs: [{ id: "run", ordinal: 1, status: "completed" }],
                  providerTurns: [],
                } as never),
              getThreadShell: () =>
                Effect.succeed({
                  id: "t1",
                  worktreePath,
                  pendingRuntimeRequest: null,
                  activeRunId: null,
                  status: "completed",
                } as never),
            },
            { usage: { priceTokens: () => Effect.succeed(0) } },
          ),
        ),
      );
    };
    const passed = yield* observe(true, "/work/t1");
    // The worktree it was made is recorded, for settlement to remove that one only.
    assert.deepEqual(passed, {
      checked: { assignmentId: "a1", repository: "/work/t1" },
      status: "completed",
      recorded: "/work/t1",
    });
    assert.equal((yield* observe(false, "/work/t1")).status, "blocked");
    // With no worktree to read, nothing proves the work stayed inside its grant.
    assert.deepEqual(yield* observe(true, null), {
      checked: undefined,
      status: "blocked",
      recorded: undefined,
    });
    assert.deepEqual(yield* observe(true, "/work/t1", {}), {
      checked: undefined,
      status: "blocked",
      recorded: undefined,
    });
  }),
);

const HEAD = "1".repeat(40);
const reviewedAuthor = {
  ...assignment("a1", "t1"),
  status: "verified",
  goalId: "goal",
  receipt: {
    threadId: "coordinator:t1",
    parentThreadId: "coordinator:parent",
    projectId: "project",
    base: "base-commit",
    prefix: "projects/app/",
    target: "main",
  },
};
const project = {
  id: "project",
  workspaceRoot: "/repo/projects/app",
  repositoryIdentity: { provider: "github" },
};

it.effect("a reviewed change merges only after its result check, and then completes", () =>
  Effect.gen(function* () {
    const pass = (
      resultPassed: boolean,
      outcome: Merges.MergeOutcome,
      parentThreadId = "coordinator:parent",
      manageOtherThreads = false,
      manualMergeProjects: ReadonlyArray<string> = [],
      command: CoordinatorCommand = { type: "cycle.run" },
      landed: Merges.MergeOutcome | null = null,
      shellExtra: Record<string, unknown> = {},
      // The author's cloud run's state, when the author ran in a cloud.
      cloudState?: string,
      // The author's own head: its worktree's, or its cloud run's branch.
      authorHead?: string,
    ) => {
      const store: Store = {
        cards: [card("t1")],
        assignments: [
          {
            ...reviewedAuthor,
            ...(cloudState
              ? { route: { provider: "replay", model: "m", destination: "cloud:codex" } }
              : {}),
            receipt: { ...reviewedAuthor.receipt, parentThreadId },
          },
        ],
        configuration: { manageOtherThreads, manualMergeProjects },
        actions: [],
        resultPassed,
        ...(authorHead ? { baseHead: authorHead } : {}),
        merges: [
          {
            id: "goal",
            goalId: "goal",
            assignmentId: "a1",
            target: { head: HEAD, target: "main", repository: "/repo", projectId: "project" },
          },
        ],
      };
      const requests: Array<{ method: string; params: unknown }> = [];
      const merged: Array<Merges.MergeInput> = [];
      return Effect.gen(function* () {
        const coordinator = yield* Coordinator.Coordinator;
        yield* coordinator.command({ type: "cycle.run" });
        if (command.type !== "cycle.run") yield* coordinator.command(command);
        const sent = (method: string) =>
          requests.filter((request) => request.method === method).map((request) => request.params);
        return {
          checked: sent("results.check"),
          merged,
          completed: sent("goals.merged"),
          rereviewed: sent("merges.rereview"),
          waiting: (sent("merges.wait") as Array<{ id: string; owner: boolean }>).map(
            (item) => `${item.id}:${item.owner ? "owner" : "host"}`,
          ),
        };
      }).pipe(
        Effect.provide(
          harness(
            store,
            requests,
            {
              getThreadShell: () =>
                Effect.succeed({
                  id: "t1",
                  worktreePath: "/work/t1",
                  branch: "t3/feature",
                  ...shellExtra,
                } as never),
              getThreadRecords: () => Effect.succeed({ runtimeRequests: [] } as never),
            },
            {
              cloud: {
                get: () =>
                  Effect.succeed(
                    (cloudState
                      ? {
                          state: cloudState,
                          handle: "task-1",
                          branchHead: authorHead ?? null,
                          head: null,
                        }
                      : null) as never,
                  ),
              },
              merges: {
                merge: (input) => Effect.sync(() => (merged.push(input), outcome)),
                landed: () => Effect.succeed(landed),
              },
              projects: { getById: () => Effect.succeedSome(project as never) },
            },
          ),
        ),
      );
    };
    const done = yield* pass(true, { merged: true, how: { commit: HEAD } });
    // The result check reads the very commit that merges, in the author's worktree.
    assert.deepEqual(done.checked, [{ assignmentId: "a1", repository: "/work/t1", head: HEAD }]);
    assert.deepInclude(done.merged[0], {
      repository: "/repo",
      cwd: "/work/t1",
      branch: "t3/feature",
      head: HEAD,
      target: "main",
      hosted: true,
    });
    assert.deepEqual(done.completed, [
      { id: "goal", head: HEAD, hostVerified: true, how: { commit: HEAD } },
    ]);
    const held = yield* pass(false, { merged: true, how: { commit: HEAD } });
    assert.deepEqual([held.merged, held.completed, held.waiting], [[], [], ["goal:owner"]]);
    // A branch of a person's thread moves only if the Coordinator may manage other threads.
    const theirs = yield* pass(true, { merged: true, how: { commit: HEAD } }, "person");
    assert.deepEqual([theirs.merged, theirs.completed, theirs.waiting], [[], [], ["goal:owner"]]);
    // The owner's go-ahead is their word on whose branch it lands.
    const theirsAsked = yield* pass(
      true,
      { merged: true, how: { commit: HEAD } },
      "person",
      false,
      [],
      { type: "goal.merge", goalId: "goal" },
    );
    assert.equal(theirsAsked.completed.length, 1);
    const allowed = yield* pass(true, { merged: true, how: { commit: HEAD } }, "person", true);
    assert.equal(allowed.completed.length, 1);
    // With its project's switch off, it waits for the owner's go-ahead.
    const done2 = { merged: true, how: { commit: HEAD } } as const;
    const manual = yield* pass(true, done2, "coordinator:parent", false, ["project"]);
    // The owner merged it by hand: seen first, whatever holds the merge back, and done.
    const byHand = yield* pass(
      false,
      done2,
      "person",
      false,
      ["project"],
      { type: "cycle.run" },
      { merged: true, how: { pullRequest: { repository: "owner/repo", number: 7 } } },
    );
    assert.deepEqual(
      [byHand.merged, byHand.completed],
      [
        [],
        [
          {
            id: "goal",
            head: HEAD,
            hostVerified: true,
            how: { pullRequest: { repository: "owner/repo", number: 7 }, byHand: true },
          },
        ],
      ],
    );
    assert.deepEqual([manual.merged, manual.completed, manual.waiting], [[], [], ["goal:owner"]]);
    // By hand at another head: done all the same, recorded at that head and as unreviewed.
    const elsewhere = yield* pass(
      false,
      done2,
      "person",
      false,
      ["project"],
      { type: "cycle.run" },
      {
        merged: true,
        how: { pullRequest: { repository: "owner/repo", number: 7 } },
        head: "8".repeat(40),
      },
    );
    assert.deepEqual(elsewhere.completed, [
      {
        id: "goal",
        head: "8".repeat(40),
        byHand: true,
        how: { pullRequest: { repository: "owner/repo", number: 7 } },
      },
    ]);
    const asked = yield* pass(true, done2, "coordinator:parent", false, ["project"], {
      type: "goal.merge",
      goalId: "goal",
    });
    assert.equal(asked.completed.length, 1);
    // The author pushed a fix past the reviewed commit: once idle, back to review of it.
    const NEW = "9".repeat(40);
    const moved = { merged: false, waiting: "Moved.", moved: NEW } as const;
    const local = (extra: Record<string, unknown>, author: string) =>
      pass(
        true,
        moved,
        "coordinator:parent",
        false,
        [],
        { type: "cycle.run" },
        null,
        extra,
        undefined,
        author,
      );
    const working = yield* local({ latestRunId: "run-2", activeRunId: "run-2" }, NEW);
    assert.deepEqual([working.rereviewed, working.waiting], [[], ["goal:host"]]);
    const idle = yield* local({ latestRunId: "run-2", activeRunId: null }, NEW);
    assert.deepEqual(idle.rereviewed, [{ id: "goal", latestRunId: "run-2", hostVerified: true }]);
    // Pushed by someone else (Update branch, the owner, a bot): the author's head is still the
    // reviewed one, so no review loop starts; the owner holds it.
    const pushedByOthers = yield* local({ latestRunId: "run-1", activeRunId: null }, HEAD);
    assert.deepEqual([pushedByOthers.rereviewed, pushedByOthers.waiting], [[], ["goal:owner"]]);
    // A cloud author has no thread: its run record says whether it still runs and what it pushed.
    const inCloud = (state: string, author = NEW) =>
      pass(
        true,
        moved,
        "coordinator:parent",
        false,
        [],
        { type: "cycle.run" },
        null,
        {},
        state,
        author,
      );
    for (const state of ["out", "unstopped"]) {
      const running = yield* inCloud(state);
      assert.deepEqual([running.rereviewed, running.waiting], [[], ["goal:host"]], state);
    }
    for (const state of ["collected", "ended", "lost"])
      assert.deepEqual(
        (yield* inCloud(state)).rereviewed,
        [{ id: "goal", latestRunId: "task-1", head: NEW, hostVerified: true }],
        state,
      );
    const notTheRun = yield* inCloud("collected", HEAD);
    assert.deepEqual([notTheRun.rereviewed, notTheRun.waiting], [[], ["goal:owner"]]);
    const waiting = yield* pass(true, { merged: false, waiting: "Checks are pending." });
    assert.deepEqual([waiting.completed, waiting.waiting], [[], ["goal:host"]]);
  }),
);

it.effect("a cloud author is sent with what its result will be checked against", () =>
  Effect.gen(function* () {
    const work = {
      ...assignment("a1", "t1"),
      route: { provider: "replay", model: "provider-selected", destination: "cloud:codex" },
      receipt: { parentThreadId: "t1" },
    };
    const cloudBinding = {
      projectId: "project",
      destination: "cloud:codex",
      guildModel: "model",
      repository: "repo",
      environment: "env",
      branch: "main",
      head: "c".repeat(40),
      base: "d".repeat(40),
    };
    const store: Store = {
      cards: [card("t1")],
      assignments: [work],
      actions: [
        {
          ...action("dispatch:a1", "pending"),
          kind: "dispatch",
          assignmentId: "a1",
          payload: { assignment: work, card: card("t1") },
        },
      ],
      claim: true,
      grant: {
        id: "grant",
        scope: { kind: "project", id: "project" },
        folders: ["src"],
        delete: [],
      },
      configuration: {
        allowUnverifiedCloudModels: true,
        guildBindings: [
          {
            id: "binding",
            name: "Codex",
            providerInstanceId: "replay",
            guildProvider: "codex",
            guildAccount: "account",
            profileId: null,
            environmentId: null,
            cloud: cloudBinding,
          },
        ],
      },
    };
    const requests: Array<{ method: string; params: unknown }> = [];
    yield* Effect.gen(function* () {
      yield* (yield* Coordinator.Coordinator).command({
        type: "permission.respond",
        requestId: "r",
        decision: "deny",
      });
    }).pipe(
      Effect.provide(
        harness(
          store,
          requests,
          { getThreadShell: () => Effect.succeed({ id: "t1", runtimeMode: "auto" } as never) },
          {
            cloud: {
              supports: () => true,
              submit: () =>
                Effect.succeed({ handle: "task-1", branch: "coordinator/a-1" } as never),
            },
            projects: { getById: () => Effect.succeedSome(project as never) },
            settings: {
              getSettings: Effect.succeed({ linkedEnvironmentsEnabled: false } as never),
            },
          },
        ),
      ),
    );
    const ack = requests.find((request) => request.method === "actions.ack")?.params as {
      status: string;
      result: { receipt: Record<string, unknown> };
    };
    assert.equal(ack.status, "completed");
    assert.deepInclude(ack.result.receipt, {
      projectId: "project",
      base: "base-commit",
      prefix: "projects/app/",
      target: "main",
      grant: { id: "grant", folders: ["src"], delete: [] },
    });
    assert.deepInclude(
      requests.find((request) => request.method === "results.base")?.params as object,
      { repository: "/repo/projects/app", ref: cloudBinding.head },
    );
  }),
);

it.effect("a finished review moves its goal on with no model asking", () =>
  Effect.gen(function* () {
    const finish = (role: string) => {
      const store: Store = {
        cards: [card("t1")],
        assignments: [{ ...assignment("a1", "t1"), role, goalId: "goal" }],
        actions: [],
        goals: [{ id: "goal", purpose: "Ship it", status: "active", revision: 1 }],
      };
      const requests: Array<{ method: string; params: unknown }> = [];
      return Effect.gen(function* () {
        yield* (yield* Coordinator.Coordinator).command({ type: "cycle.run" });
        return requests
          .filter((request) =>
            ["goals.get", "goals.block", "goals.resolve"].includes(request.method),
          )
          .map((request) => request.method);
      }).pipe(
        Effect.provide(
          harness(
            store,
            requests,
            {
              getThreadShell: () =>
                Effect.succeed({
                  id: "t1",
                  worktreePath: null,
                  pendingRuntimeRequest: null,
                  activeRunId: null,
                  status: "completed",
                } as never),
              getThreadRecords: () =>
                Effect.succeed({
                  runtimeRequests: [],
                  runs: [{ id: "run", ordinal: 1, status: "completed" }],
                  providerTurns: [],
                } as never),
            },
            { usage: { priceTokens: () => Effect.succeed(0) } },
          ),
        ),
      );
    };
    // The host resolves the review itself; this one has no canonical evidence, so it is held.
    assert.deepEqual(yield* finish("reviewer"), ["goals.get", "goals.block"]);
    assert.deepEqual(yield* finish("adventurer"), []);
  }),
);

// An author's finished work and its review, with canonical records a review can cite.
// `said` is the reviewer's final message around its report.
// `effort`: null for a provider with no effort option, whose runs carry none.
const reviewFixture = (said = (report: string) => report, effort: string | null = "high") => {
  const run = (id: string, model: string) => ({
    id,
    ordinal: 1,
    status: "completed",
    providerInstanceId: "replay",
    modelSelection: { model, options: effort ? [{ id: "effort", value: effort }] : [] },
    checkpointId: null,
  });
  const message = (runId: string, text: string) => ({
    id: `message-${runId}`,
    text,
    attachments: [],
    streaming: false,
    createdAt: DateTime.makeUnsafe(0),
  });
  const goal = {
    id: "goal",
    purpose: "Ship it",
    status: "active",
    revision: 1,
    acceptanceCriteria: ["It works."],
    dependencies: [],
    authorizedScope: ["project"],
  };
  const sha = (value: unknown) =>
    NodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const author = {
    ...reviewedAuthor,
    id: "author",
    cardId: "local:coordinator:author",
    status: "completed",
    route: { provider: "replay", model: "model", effort, destination: "local" },
    receipt: {
      ...reviewedAuthor.receipt,
      threadId: "coordinator:author",
      latestRunId: "run-a",
    },
  };
  const authorMessage = message("run-a", "Done.");
  const digest = sha({
    assignmentId: "author",
    executionId: "run-a",
    receipt: author.receipt,
    run: run("run-a", "model"),
    checkpoints: [],
    messages: [{ id: authorMessage.id, text: authorMessage.text, attachments: [] }],
  });
  const goalDigest = sha({
    id: goal.id,
    purpose: goal.purpose,
    acceptanceCriteria: goal.acceptanceCriteria,
    dependencies: goal.dependencies,
    authorizedScope: goal.authorizedScope,
  });
  const report = JSON.stringify({
    protocolVersion: 1,
    goalId: "goal",
    goalDigest,
    reviewerAssignmentId: "review",
    subjects: [{ assignmentId: "author", executionId: "run-a", digest }],
    accepted: true,
    purposeSatisfied: true,
    criteria: [{ index: 0, passed: true, evidenceIds: ["command-run-r"] }],
    integration: { ownerAssignmentId: "author", passed: true, evidenceIds: [authorMessage.id] },
    summary: "It works.",
  });
  const reviewer = {
    ...assignment("review", "coordinator:review"),
    goalId: "goal",
    role: "reviewer",
    route: { provider: "replay", model: "review-model", effort, destination: "local" },
    reviewSubjects: [{ assignmentId: "author", executionId: "run-a", digest }],
    reviewGoalDigest: goalDigest,
    receipt: { threadId: "coordinator:review", latestRunId: "run-r", startedAt: 0 },
  };
  const records = (threadId: string) =>
    threadId === "coordinator:author"
      ? { run: run("run-a", "model"), message: authorMessage }
      : { run: run("run-r", "review-model"), message: message("run-r", said(report)) };
  const threadsService = {
    getThreadShell: (threadId: string) =>
      Effect.succeed({
        id: threadId,
        projectId: "project",
        latestRunId: records(threadId).run.id,
        activeRunId: null,
        pendingRuntimeRequest: null,
        status: "completed",
        worktreePath: threadId === "coordinator:author" ? "/work/author" : "/work/parent",
        branch: "t3/author",
      } as never),
    getThreadRecords: (threadId: string) =>
      Effect.succeed({
        runs: [records(threadId).run],
        messages: [records(threadId).message],
        checkpoints: [],
        turnItems: [
          {
            id: `command-${records(threadId).run.id}`,
            type: "command_execution",
            status: "completed",
            exitCode: 0,
          },
        ],
        runtimeRequests: [],
        providerTurns: [],
      } as never),
  };
  return { goal, author, reviewer, threadsService };
};

it.effect("an accepted review merges committed work and holds work left uncommitted", () =>
  Effect.gen(function* () {
    const finish = (clean: boolean, said?: (report: string) => string, effort?: string | null) => {
      const { goal, author, reviewer, threadsService } = reviewFixture(said, effort);
      const store: Store = {
        cards: [card("coordinator:author"), card("coordinator:review")],
        assignments: [author, reviewer],
        actions: [],
        goals: [goal],
        resultPassed: true,
        resultHead: "1".repeat(40),
        clean,
        applyUpdates: true,
      };
      const requests: Array<{ method: string; params: unknown }> = [];
      return Effect.gen(function* () {
        yield* (yield* Coordinator.Coordinator).command({ type: "cycle.run" });
        const sent = (method: string) =>
          requests.filter((request) => request.method === method).map((request) => request.params);
        return {
          resolved: (sent("goals.resolve") as Array<{ merge?: unknown }>).map((item) => item.merge),
          blocked: sent("goals.block").length,
          told: (sent("decisions.record") as Array<{ decision: { summary: string } }>).map(
            (item) => item.decision.summary,
          ),
        };
      }).pipe(
        Effect.provide(
          harness(store, requests, threadsService, {
            projects: { getById: () => Effect.succeedSome(project as never) },
            usage: { priceTokens: () => Effect.succeed(0) },
          }),
        ),
      );
    };
    const committed = yield* finish(true);
    assert.deepEqual(committed.resolved, [
      {
        head: "1".repeat(40),
        target: "main",
        repository: "/repo",
        projectId: "project",
        branch: "t3/author",
      },
    ]);
    // Prose around the one report, fenced, is the same finished review.
    const wrapped = yield* finish(
      true,
      (report) => `The change holds up.\n\n\`\`\`json\n${report}\n\`\`\`\nThat is all.`,
    );
    assert.deepEqual(wrapped, committed);
    // A provider with no effort option is reviewed and merged the same.
    assert.deepEqual(yield* finish(true, undefined, null), committed);
    // Two reports are none: the goal waits, and the reason says what a final message must hold.
    const twice = yield* finish(true, (report) => `${report}\n${report}`);
    assert.deepEqual([twice.resolved, twice.blocked], [[], 1]);
    assert.isTrue(twice.told.some((summary) => summary.includes("exactly one JSON report")));
    const uncommitted = yield* finish(false);
    assert.deepEqual([uncommitted.resolved, uncommitted.blocked], [[], 1]);
    assert.isTrue(uncommitted.told.some((summary) => summary.includes("uncommitted")));
  }),
);

it.effect(
  "cancelled work still stopping settles once it has, and a goal's work only when idle",
  () =>
    Effect.gen(function* () {
      const settle = (ended: string | undefined) => {
        const store: Store = {
          cards: [card("coordinator:t1")],
          assignments: [{ ...reviewedAuthor, receipt: { ...reviewedAuthor.receipt } }],
          actions: [
            {
              ...action("settle:x:a1", "pending"),
              kind: "thread.settle",
              threadId: "coordinator:t1",
              environmentId: "local",
              instructionRevision: 0,
              payload: {
                goalId: "goal",
                assignmentId: "a1",
                cardId: "local:coordinator:t1",
                expectedRunId: "run",
                cloud: false,
                ...(ended ? { ended } : {}),
              },
            },
          ],
          claim: true,
        };
        const requests: Array<{ method: string; params: unknown }> = [];
        return Effect.gen(function* () {
          yield* (yield* Coordinator.Coordinator).command({
            type: "permission.respond",
            requestId: "r",
            decision: "deny",
          });
          return (
            requests.find((request) => request.method === "actions.ack")!.params as {
              status: string;
            }
          ).status;
        }).pipe(
          Effect.provide(
            harness(store, requests, {
              getThreadShell: () =>
                Effect.succeed({
                  id: "coordinator:t1",
                  projectId: "project",
                  latestRunId: "run",
                  latestUserAuthoredMessageAt: null,
                  settledOverride: null,
                  archivedAt: null,
                  activeRunId: "run",
                  pendingRuntimeRequest: null,
                  updatedAt: "now",
                } as never),
              hasReceipt: () => Effect.succeed(false),
            }),
          ),
        );
      };
      // Uncertain is tried again on the next drain; failed is not.
      assert.equal(yield* settle("cancelled"), "uncertain");
      assert.equal(yield* settle(undefined), "failed");
    }),
);

it.effect("reverting a goal opens revert pull requests newest first and marks each outcome", () =>
  Effect.gen(function* () {
    const merged = (goalId: string, pullRequest?: { repository: string; number: number }) => ({
      id: goalId,
      goalId,
      assignmentId: "a1",
      target: { head: HEAD, target: "main" },
      feedback: {
        payload: {
          event: {
            eventId: `outcome:${goalId}`,
            goalId,
            subjects: [
              { assignmentId: `${goalId}-author`, route: reviewedAuthor.route, rank: "B" },
            ],
          },
        },
      },
      merged: { how: pullRequest ? { pullRequest } : { commit: HEAD } },
    });
    const revert = (reverts: Array<Row>) => {
      const requests: Array<{ method: string; params: unknown }> = [];
      const opened: Array<number> = [];
      return Effect.gen(function* () {
        yield* (yield* Coordinator.Coordinator).command({ type: "goal.revert", goalId: "base" });
        const sent = (method: string) =>
          requests.filter((request) => request.method === method).map((request) => request.params);
        return {
          asked: sent("merges.reverts"),
          opened,
          rounds: (sent("outcomes.record") as Array<{ round: Record<string, unknown> }>).map(
            (item) => [item.round.goalId, item.round.finish],
          ),
          reverted: (sent("merges.reverted") as Array<{ id: string }>).map((item) => item.id),
          waiting: (sent("decisions.record") as Array<{ decision: { id: string } }>).map(
            (item) => item.decision.id,
          ),
          told: (sent("decisions.record") as Array<{ decision: { summary: string } }>).map(
            (item) => item.decision.summary,
          ),
        };
      }).pipe(
        Effect.provide(
          harness(
            {
              cards: [],
              assignments: [reviewedAuthor],
              actions: [],
              reverts,
              configuration: { enabled: true },
            },
            requests,
            {},
            {
              merges: {
                revert: (input) =>
                  Effect.sync(() => (opened.push(input.number), input.number + 100)),
              },
            },
          ),
        ),
      );
    };
    const done = yield* revert([
      merged("built", { repository: "owner/repo", number: 9 }),
      merged("base", { repository: "owner/repo", number: 7 }),
    ]);
    assert.deepEqual(done, {
      asked: [{ id: "base", actor: "user" }],
      opened: [9, 7],
      rounds: [
        ["built", "reverted"],
        ["base", "reverted"],
      ],
      reverted: ["built", "base"],
      waiting: [],
      told: [],
    });
    // A change merged with no pull request is the owner's to revert, and stops the older ones.
    const held = yield* revert([
      merged("built"),
      merged("base", { repository: "owner/repo", number: 7 }),
    ]);
    assert.deepEqual([held.opened, held.reverted, held.waiting], [[], [], ["revert-waiting:base"]]);
    // One merged by hand at another head is to be reverted at the head that landed.
    const landedElsewhere = { ...merged("built"), merged: { head: "7".repeat(40), how: null } };
    const elsewhere = yield* revert([landedElsewhere]);
    assert.include(elsewhere.told[0], "7".repeat(40));
    assert.notInclude(elsewhere.told[0], HEAD);
  }),
);

it.effect("at settlement only the clean worktree recorded for a started author goes", () =>
  Effect.gen(function* () {
    const T = "coordinator:t1";
    const settle = (
      role: string,
      receipt: Record<string, unknown>,
      held: ReadonlyArray<string> = [],
      threadId = T,
      alreadySettled = false,
      // When given, the settlements marked finished are collected here.
      finished?: Array<string>,
      failRemoval = false,
    ) => {
      const author = {
        ...reviewedAuthor,
        role,
        receipt: { ...reviewedAuthor.receipt, threadId, worktree: "/work/t1", ...receipt },
      };
      const store: Store = {
        ...(finished
          ? {
              signal: (method: string) =>
                Effect.sync(
                  () => void (method === "settlements.finished" && finished.push(method)),
                ),
            }
          : {}),
        cards: [card("t1")],
        assignments: [author],
        actions: [
          {
            ...action("settle:goal:a1", "pending"),
            kind: "thread.settle",
            threadId,
            environmentId: "local",
            instructionRevision: 0,
            payload: {
              goalId: "goal",
              assignmentId: "a1",
              cardId: "local:t1",
              expectedRunId: "run",
              cloud: false,
            },
          },
        ],
        claim: true,
      };
      const requests: Array<{ method: string; params: unknown }> = [];
      const removed: Array<unknown> = [];
      const dispatched: Array<{ type: string }> = [];
      let settled: string | null = alreadySettled ? "settled" : null;
      return Effect.gen(function* () {
        const coordinator = yield* Coordinator.Coordinator;
        yield* coordinator.command({
          type: "permission.respond",
          requestId: "r",
          decision: "deny",
        });
        return {
          removed,
          dispatched: dispatched.map((command) => command.type),
          kept: requests
            .filter((request) => request.method === "decisions.record")
            .map((request) => (request.params as { decision: { id: string } }).decision.id),
        };
      }).pipe(
        Effect.provide(
          harness(
            store,
            requests,
            {
              getThreadShell: () =>
                Effect.sync(
                  () =>
                    ({
                      id: threadId,
                      projectId: "project",
                      worktreePath: "/work/t1",
                      latestRunId: "run",
                      latestUserAuthoredMessageAt: null,
                      settledOverride: settled,
                      archivedAt: null,
                      activeRunId: null,
                      pendingRuntimeRequest: null,
                      updatedAt: "now",
                    }) as never,
                ),
              hasReceipt: () => Effect.succeed(false),
              getThreadRecords: () =>
                Effect.succeed({ runtimeRequests: [], turnItems: [] } as never),
              dispatch: (command: { type: string }) =>
                Effect.sync(() => {
                  dispatched.push(command);
                  if (command.type === "thread.auto-settle") settled = "settled";
                  return { sequence: 1 } as never;
                }),
            },
            {
              merges: {
                removeWorktree: (input) =>
                  failRemoval
                    ? Effect.fail(
                        new CoordinatorError({
                          operation: "worktree-remove",
                          reason: "destination",
                        }),
                      )
                    : Effect.sync(() => (removed.push(input), held)),
              },
              projects: { getById: () => Effect.succeedSome(project as never) },
            },
          ),
        ),
      );
    };
    assert.deepEqual(yield* settle("adventurer", {}), {
      removed: [{ repository: "/repo/projects/app", path: "/work/t1" }],
      dispatched: ["thread.auto-settle", "thread.metadata.update", "thread.archive"],
      kept: [],
    });
    // Settled before a crash, the retried settlement still removes what it made.
    assert.deepEqual(yield* settle("adventurer", {}, [], T, true), {
      removed: [{ repository: "/repo/projects/app", path: "/work/t1" }],
      dispatched: ["thread.metadata.update", "thread.archive"],
      kept: [],
    });
    // Holding untracked or ignored files, it stays, and the owner is told.
    assert.deepEqual(yield* settle("adventurer", {}, ["!! .env.local"]), {
      removed: [{ repository: "/repo/projects/app", path: "/work/t1" }],
      dispatched: ["thread.auto-settle", "thread.archive"],
      kept: [`worktree-kept:${T}`],
    });
    // A reviewer reads in its parent's worktree; a thread now pointing elsewhere, with no recorded
    // worktree, or that the Coordinator did not start keeps what it has.
    for (const [role, receipt, threadId] of [
      ["reviewer", {}, T],
      ["adventurer", { worktree: "/elsewhere" }, T],
      ["adventurer", { worktree: undefined }, T],
      ["adventurer", {}, "t1"],
    ] as const)
      // Done, a thread the Coordinator started is archived too; one it did not start is not.
      assert.deepEqual(yield* settle(role, receipt, [], threadId), {
        removed: [],
        dispatched: ["thread.auto-settle", ...(threadId === T ? ["thread.archive"] : [])],
        kept: [],
      });
    // A settlement whose steps all succeeded on the drain path is marked finished.
    const done: Array<string> = [];
    yield* settle("adventurer", {}, [], T, false, done);
    assert.deepEqual(done, ["settlements.finished"]);
    // A removal that failed leaves the settlement unfinished, for start-up recovery to retry.
    const finished: Array<string> = [];
    yield* settle("adventurer", {}, [], T, false, finished, true);
    assert.deepEqual(finished, []);
  }),
);

it.effect("a cloud author's finished work is checked against its grant when collected", () =>
  Effect.gen(function* () {
    const observe = (role: string, base?: string, resultPassed = true) => {
      const store: Store = {
        cards: [card("t1")],
        assignments: [
          {
            ...assignment("a1", "t1"),
            role,
            route: { provider: "replay", model: "provider-selected", destination: "cloud:codex" },
            receipt: {
              threadId: "t1",
              ...(base ? { base } : {}),
              cloudBinding: {
                projectId: "project",
                destination: "cloud:codex",
                guildModel: "model",
                repository: "repo",
                environment: "env",
                branch: "main",
                head: "head",
                base: "base",
              },
            },
          },
        ],
        actions: [],
        resultPassed,
      };
      const requests: Array<{ method: string; params: unknown }> = [];
      return Effect.gen(function* () {
        const coordinator = yield* Coordinator.Coordinator;
        yield* coordinator.command({ type: "cycle.run" });
        return {
          status: (
            requests.find((request) => request.method === "assignments.update")!.params as {
              status: string;
            }
          ).status,
          checked: requests
            .filter((request) => request.method === "results.check")
            .map((request) => request.params),
        };
      }).pipe(
        Effect.provide(
          harness(
            store,
            requests,
            { getThreadRecords: () => Effect.succeed({ runtimeRequests: [] } as never) },
            {
              cloud: { poll: () => Effect.succeed({ status: "completed", head: "head" }) },
              projects: { getById: () => Effect.succeedSome(project as never) },
            },
          ),
        ),
      );
    };
    assert.deepEqual(yield* observe("adventurer", "base-commit"), {
      status: "completed",
      checked: [{ assignmentId: "a1", repository: "/repo/projects/app", head: "head" }],
    });
    assert.equal((yield* observe("adventurer", "base-commit", false)).status, "blocked");
    // A run dispatched with no recorded base cannot be checked, so it waits for the owner.
    assert.deepEqual(yield* observe("adventurer"), { status: "blocked", checked: [] });
    assert.deepEqual(yield* observe("reviewer"), { status: "completed", checked: [] });
  }),
);
// One pass over a running local assignment whose stored status is `stored`.
const observeRunning = (
  stored: string,
  pendingRuntimeRequest: unknown,
  requests: Array<{ method: string; params: unknown }> = [],
) => {
  const work = {
    ...assignment("work", "t1"),
    goalId: "goal",
    status: stored,
    receipt: { threadId: "t1", startedAt: 0 },
  };
  return Effect.gen(function* () {
    yield* TestClock.adjust("5 minutes");
    yield* (yield* Coordinator.Coordinator).command({ type: "cycle.run" });
    return requests
      .filter((request) => request.method === "assignments.update")
      .map((request) => request.params as Record<string, unknown>);
  }).pipe(
    Effect.provide(
      harness(
        { cards: [card("t1")], assignments: [work], actions: [] },
        requests,
        {
          getThreadShell: (threadId) =>
            Effect.succeed({
              id: threadId,
              pendingRuntimeRequest,
              activeRunId: "run",
              status: "running",
            } as never),
          getThreadRecords: () =>
            Effect.succeed({ runs: [], runtimeRequests: [], providerTurns: [] } as never),
        },
        { usage: { priceTokens: () => Effect.succeed(0.25) } },
      ),
    ),
  );
};

it.effect("running work reports its use and time on every pass, so a cap trips while it runs", () =>
  Effect.gen(function* () {
    const [update] = yield* observeRunning("running", null);
    assert.notProperty(update, "status");
    assert.deepEqual(update?.spend, { seconds: 300, micros: 250_000 });
  }),
);

it.effect("work that becomes blocked on its thread's request says so with the change", () =>
  Effect.gen(function* () {
    const requests: Array<{ method: string; params: unknown }> = [];
    const [update] = yield* observeRunning("running", { id: "request", kind: "command" }, requests);
    assert.deepInclude(update, {
      status: "blocked",
      reason: "An approval (command) waits in its thread.",
    });
    // The request is named with the block: its wake may come only after it was answered.
    assert.deepInclude(requests.find((request) => request.method === "events.append")?.params, {
      eventId: "request:t1:request",
      event: {
        kind: "approval",
        threadId: "t1",
        subject: "request",
        summary: "An approval (command) waits in thread t1.",
      },
    });
  }),
);

it.effect("waiting on the owner is timed even when the store already shows the work blocked", () =>
  Effect.gen(function* () {
    const [update] = yield* observeRunning("blocked", { id: "request" });
    assert.notProperty(update, "status");
    assert.deepInclude(update?.receipt as object, { blockedSince: 300_000 });
  }),
);

it.effect(
  "a login the provider limited is held until its reset and its failure not counted",
  () => {
    const work = {
      ...assignment("work", "t1"),
      goalId: "goal",
      route: { provider: "claude-a", account: "claude-a", model: "model", destination: "local" },
      receipt: { threadId: "t1", startedAt: 0 },
    };
    const requests: Array<{ method: string; params: unknown }> = [];
    return Effect.gen(function* () {
      yield* (yield* Coordinator.Coordinator).command({ type: "cycle.run" });
      const sent = (method: string) =>
        requests.filter((request) => request.method === method).map((request) => request.params);
      assert.deepEqual(sent("account.hold"), [
        {
          hold: {
            account: "claude-a",
            reason: "You've hit your limit",
            until: Date.parse("2026-11-12T15:00:00.000Z"),
          },
        },
      ]);
      assert.deepInclude((sent("outcomes.record")[0] as { round: object }).round, {
        counted: false,
      });
    }).pipe(
      Effect.provide(
        harness(
          { cards: [card("t1")], assignments: [work], actions: [] },
          requests,
          {
            getThreadShell: (threadId) =>
              Effect.succeed({
                id: threadId,
                pendingRuntimeRequest: null,
                activeRunId: null,
                status: "failed",
                lastError: "You've hit your limit",
                lastErrorClass: "usage_limit",
                usageLimitResetAt: "2026-11-12T15:00:00.000Z",
              } as never),
            getThreadRecords: () =>
              Effect.succeed({
                runs: [{ id: "run", ordinal: 1, status: "failed" }],
                runtimeRequests: [],
                providerTurns: [],
              } as never),
          },
          { usage: { priceTokens: () => Effect.succeed(0) } },
        ),
      ),
    );
  },
);

it.effect("a reviewer's usage limit leaves its author's outcome counted", () => {
  const author = {
    ...assignment("author", "t0"),
    goalId: "goal",
    status: "completed",
    route: { provider: "codex", model: "author-model", effort: "high", destination: "local" },
  };
  const review = {
    ...assignment("review", "t1"),
    goalId: "goal",
    role: "reviewer",
    reviewSubjects: [{ assignmentId: "author", executionId: "run:t0", digest: "a".repeat(64) }],
    receipt: { threadId: "t1", startedAt: 0 },
  };
  const requests: Array<{ method: string; params: unknown }> = [];
  return Effect.gen(function* () {
    yield* (yield* Coordinator.Coordinator).command({ type: "cycle.run" });
    const [recorded] = requests
      .filter((request) => request.method === "outcomes.record")
      .map((request) => (request.params as { round: Record<string, unknown> }).round);
    assert.equal(recorded?.model, "author-model");
    assert.notProperty(recorded, "counted");
    assert.lengthOf(
      requests.filter((request) => request.method === "account.hold"),
      1,
    );
  }).pipe(
    Effect.provide(
      harness(
        { cards: [card("t1")], assignments: [author, review], actions: [] },
        requests,
        {
          getThreadShell: (threadId) =>
            Effect.succeed({
              id: threadId,
              pendingRuntimeRequest: null,
              activeRunId: null,
              status: "failed",
              lastErrorClass: "usage_limit",
              usageLimitResetAt: "2026-11-12T15:00:00.000Z",
            } as never),
          getThreadRecords: () =>
            Effect.succeed({
              runs: [{ id: "run", ordinal: 1, status: "failed" }],
              runtimeRequests: [],
              providerTurns: [],
            } as never),
        },
        { usage: { priceTokens: () => Effect.succeed(0) } },
      ),
    ),
  );
});

it.effect("an assignment the store refuses to settle never stops the pass over the others", () => {
  const limited = {
    ...assignment("limited", "t1"),
    goalId: "goal",
    route: { provider: "claude-a", account: "claude-a", model: "model", destination: "local" },
    receipt: { threadId: "t1", startedAt: 0 },
  };
  const running = { ...assignment("running", "t2"), receipt: { threadId: "t2", startedAt: 0 } };
  const requests: Array<{ method: string; params: unknown }> = [];
  return Effect.gen(function* () {
    yield* (yield* Coordinator.Coordinator).command({ type: "cycle.run" });
    const updated = requests
      .filter((request) => request.method === "assignments.update")
      .map((request) => (request.params as { id: string }).id);
    assert.include(updated, "running");
  }).pipe(
    Effect.provide(
      harness(
        {
          cards: [card("t1"), card("t2")],
          assignments: [limited, running],
          actions: [],
          refuse: ["account.hold"],
        },
        requests,
        {
          getThreadShell: (threadId) =>
            Effect.succeed(
              (threadId === "t1"
                ? {
                    id: threadId,
                    pendingRuntimeRequest: null,
                    activeRunId: null,
                    status: "failed",
                    lastErrorClass: "usage_limit",
                  }
                : {
                    id: threadId,
                    pendingRuntimeRequest: null,
                    activeRunId: "run",
                    status: "running",
                  }) as never,
            ),
          getThreadRecords: () =>
            Effect.succeed({
              runs: [{ id: "run", ordinal: 1, status: "failed" }],
              runtimeRequests: [],
              providerTurns: [],
            } as never),
        },
        { usage: { priceTokens: () => Effect.succeed(0) } },
      ),
    ),
  );
});

it.effect("a dispatch claimed before its thread was created is ended, freeing its route", () => {
  const work = {
    ...assignment("work", "t1"),
    status: "dispatching",
    receipt: null,
    executionId: null,
  };
  const store: Store = {
    cards: [],
    assignments: [],
    actions: [
      {
        ...action("dispatch:work", "claimed"),
        kind: "dispatch",
        assignmentId: "work",
        payload: { assignment: work, card: card("t0") },
      },
    ],
  };
  const requests: Array<{ method: string; params: unknown }> = [];
  return Effect.gen(function* () {
    yield* (yield* Coordinator.Coordinator).command({
      type: "permission.respond",
      requestId: "request",
      decision: "deny",
    });
    assert.deepEqual(
      requests
        .filter((request) => request.method === "actions.ack")
        .map((request) => request.params),
      [
        {
          id: "dispatch:work",
          status: "failed",
          result: {
            status: "not-dispatched",
            reason: "The thread was never created; the dispatch was interrupted.",
          },
        },
      ],
    );
  }).pipe(Effect.provide(harness(store, requests, { getThreadShell: () => Effect.succeed(null) })));
});

it.effect("cancelled work adds its round when the cancel is accepted", () => {
  const work = {
    ...assignment("work", "t1"),
    goalId: "goal",
    receipt: { threadId: "t1", startedAt: 0 },
  };
  const store: Store = {
    cards: [],
    assignments: [work],
    actions: [
      {
        ...action("cancel:work", "pending"),
        kind: "cancel",
        assignmentId: "work",
        payload: { assignment: work, card: card("t1") },
      },
    ],
    claim: true,
  };
  const requests: Array<{ method: string; params: unknown }> = [];
  return Effect.gen(function* () {
    yield* TestClock.adjust("1 minute");
    yield* (yield* Coordinator.Coordinator).command({
      type: "permission.respond",
      requestId: "request",
      decision: "deny",
    });
    const rounds = requests
      .filter((request) => request.method === "outcomes.record")
      .map((request) => (request.params as { round: Record<string, unknown> }).round);
    assert.deepInclude(rounds[0], { assignmentId: "work", endedAt: 60_000, usedMicros: null });
  }).pipe(
    Effect.provide(
      harness(
        store,
        requests,
        {
          // The parent's shell scopes the stop; there are no cards to import approvals from.
          getThreadShell: () => Effect.succeed({ runtimeMode: "approval-required" } as never),
          getThreadRecords: () =>
            Effect.succeed({ providerTurns: [{ status: "failed" }], runtimeRequests: [] } as never),
        },
        {
          settings: { getSettings: Effect.succeed({ linkedEnvironmentsEnabled: false } as never) },
          orchestrator: {
            interruptThread: () => Effect.succeed(undefined as never),
            waitForThread: () =>
              Effect.succeed({ timedOut: false, status: "interrupted" } as never),
          },
        },
      ),
    ),
  );
});

it.effect("an ended review adds its round to its author's route and is read at once", () => {
  const author = {
    ...assignment("author", "t0"),
    goalId: "goal",
    status: "completed",
    route: { provider: "replay", model: "author-model", effort: "high", destination: "local" },
  };
  const review = {
    ...assignment("review", "t1"),
    goalId: "goal",
    role: "reviewer",
    rank: "A",
    reviewSubjects: [{ assignmentId: "author", executionId: "run:t0", digest: "a".repeat(64) }],
    receipt: { threadId: "t1", startedAt: 0 },
  };
  const store: Store = {
    cards: [card("t1")],
    assignments: [author, review],
    actions: [],
    goals: [{ id: "goal", purpose: "Ship it", status: "active", revision: 2 }],
  };
  const requests: Array<{ method: string; params: unknown }> = [];
  return Effect.gen(function* () {
    const coordinator = yield* Coordinator.Coordinator;
    yield* TestClock.adjust("10 minutes");
    yield* coordinator.command({ type: "cycle.run" });
    const sent = (method: string) =>
      requests.filter((request) => request.method === method).map((request) => request.params);
    assert.deepInclude(sent("assignments.update")[0], {
      id: "review",
      status: "completed",
      spend: { seconds: 600, micros: 200_000 },
    });
    // The round is recorded before the end it belongs to, so a crash between cannot lose it.
    const order = requests.map((request) => request.method);
    assert.isBelow(order.indexOf("outcomes.record"), order.indexOf("assignments.update"));
    assert.deepEqual(sent("outcomes.record"), [
      {
        round: {
          assignmentId: "review",
          goalId: "goal",
          instance: "replay",
          model: "author-model",
          effort: "high",
          rank: "A",
          usedMicros: 200_000,
          startedAt: 0,
          endedAt: 600_000,
          blockedSeconds: 0,
        },
      },
    ]);
    // The fake holds no report, so reading the review holds the goal for it.
    assert.deepInclude(sent("goals.block")[0], { id: "goal", expectedGoalRevision: 2 });
  }).pipe(
    Effect.provide(
      harness(
        store,
        requests,
        {
          getThreadShell: (threadId) =>
            Effect.succeed({
              id: threadId,
              pendingRuntimeRequest: null,
              activeRunId: null,
              status: "completed",
            } as never),
          getThreadRecords: () =>
            Effect.succeed({
              runs: [{ id: "run", ordinal: 1, status: "completed" }],
              runtimeRequests: [],
              providerTurns: [
                {
                  status: "completed",
                  model: "review-model",
                  turnTokenUsage: {
                    usageScope: "main_agent",
                    usageStatus: "complete",
                    hasSubagents: false,
                    inputTokens: 1_000,
                    cachedInputTokens: 400,
                    outputTokens: 200,
                  },
                },
              ],
            } as never),
        },
        {
          usage: {
            // Priced at the reviewer's own model: a dollar per thousand output tokens.
            priceTokens: (model, totals) =>
              Effect.succeed(model === "review-model" ? totals.outputTokens / 1000 : null),
          },
        },
      ),
    ),
  );
});

it.effect("a pending approval is registered with the command its thread asked for", () => {
  const store: Store = { cards: [card("t000")], assignments: [], actions: [] };
  const requests: Array<{ method: string; params: unknown }> = [];
  // The 500-character cut lands inside the emoji's surrogate pair.
  const runtimeRequest = {
    id: "r1",
    nodeId: "n1",
    kind: "command",
    status: "pending",
    responseCapability: { type: "live", providerSessionId: "session" },
  };
  // The operation is kept whole, its suffix past the shown prompt included.
  const operation = `vp test ${"a".repeat(600)} && rm -rf ~`;
  const turnItem = {
    type: "approval_request",
    requestId: "r1",
    nodeId: "n1",
    prompt: `vp test ${"a".repeat(491)}😀 and more`,
    operation,
  };
  // An operation the stored request cannot hold whole is left out, never cut.
  const oversized = { ...turnItem, requestId: "r2", nodeId: "n2", operation: "x".repeat(5000) };
  return Effect.gen(function* () {
    const coordinator = yield* Coordinator.Coordinator;
    yield* coordinator.command({ type: "cycle.run" });
    const registered = requests.find((request) => request.method === "permissions.request");
    assert.deepInclude(registered?.params, {
      request: {
        id: "local:r1",
        destinationRequestId: "r1",
        cardId: "local:t000",
        category: "command",
        requestedAccess: 2,
        accessIncreaseUnknown: true,
        unparsed: true,
        currentAccess: 0,
        destinationMaxAccess: 2,
        supported: true,
        detail: `vp test ${"a".repeat(491)}😀`,
        operation,
      },
    });
    const left = requests.findLast((request) => request.method === "permissions.request")
      ?.params as { request: Record<string, unknown> } | undefined;
    assert.equal(left?.request.id, "local:r2");
    assert.notProperty(left?.request ?? {}, "operation");
  }).pipe(
    Effect.provide(
      harness(store, requests, {
        getThreadRecords: (_threadId, fields) =>
          Effect.succeed(
            (fields.some((field) => field === "turnItems")
              ? { turnItems: [turnItem, oversized] }
              : {
                  thread: { runtimeMode: "approval-required" },
                  runtimeRequests: [runtimeRequest, { ...runtimeRequest, id: "r2", nodeId: "n2" }],
                }) as never,
          ),
      }),
    ),
  );
});

it.effect("an approval whose provider id is longer than the store's identifiers registers", () => {
  const store: Store = { cards: [card("t000")], assignments: [], actions: [] };
  const requests: Array<{ method: string; params: unknown }> = [];
  // A Claude runtime request id is some 340 characters; the store's identifiers end at 256.
  const long = `claude:${"r".repeat(334)}`;
  const runtimeRequest = {
    id: long,
    nodeId: "n1",
    kind: "command",
    status: "pending",
    responseCapability: { type: "live", providerSessionId: "session" },
  };
  return Effect.gen(function* () {
    const coordinator = yield* Coordinator.Coordinator;
    yield* coordinator.command({ type: "cycle.run" });
    const sent = requests
      .filter((request) => request.method === "permissions.request")
      .map((request) => (request.params as { request: Record<string, string> }).request);
    assert.deepEqual(
      sent.map((request) => request.destinationRequestId),
      [long, "r2"],
    );
    assert.match(sent[0]?.id ?? "", /^local:sha256:[0-9a-f]{64}$/);
    assert.equal(sent[0]?.id, `local:${Coordinator.storedRequestId(long)}`);
    // A short id is stored as it always was.
    assert.equal(sent[1]?.id, "local:r2");
  }).pipe(
    Effect.provide(
      harness(store, requests, {
        getThreadRecords: () =>
          Effect.succeed({
            thread: { runtimeMode: "approval-required" },
            turnItems: [],
            runtimeRequests: [runtimeRequest, { ...runtimeRequest, id: "r2", nodeId: "n2" }],
          } as never),
      }),
    ),
  );
});

it.effect("a grant is made only from a message the owner typed in the Coordinator's thread", () => {
  const store: Store = {
    cards: [],
    assignments: [],
    actions: [],
    configuration: { coordinatorThreadId: "coordinator" },
  };
  const requests: Array<{ method: string; params: unknown }> = [];
  const typed = {
    id: "owner",
    role: "user",
    createdBy: "user",
    creationSource: "web",
    text: "Work in src.",
    createdAt: DateTime.makeUnsafe(5),
  };
  const messages = [
    typed,
    { ...typed, id: "agent", createdBy: "agent" },
    { ...typed, id: "assistant", role: "assistant" },
    { ...typed, id: "relayed", senderThreadId: "thread" },
    { ...typed, id: "scheduled", scheduledTaskId: "task" },
    { ...typed, id: "notice", notification: { source: "thread", outcome: "completed" } },
    { ...typed, id: "answered", createdAt: DateTime.makeUnsafe(2) },
    // Not yet answered, but the owner wrote again since.
    { ...typed, id: "older", createdAt: DateTime.makeUnsafe(4) },
    { id: "reply", role: "assistant", runId: "done", createdAt: DateTime.makeUnsafe(3) },
    // A reply of the turn still running does not count.
    { id: "working", role: "assistant", runId: "live", createdAt: DateTime.makeUnsafe(9) },
  ];
  const runs = [
    { id: "done", status: "completed" },
    { id: "live", status: "running" },
  ];
  const grant = {
    id: "grant",
    scope: { kind: "project" as const, id: "project" },
    folders: ["src"],
  };
  const read: Array<string> = [];
  return Effect.gen(function* () {
    const coordinator = yield* Coordinator.Coordinator;
    for (const messageId of ["agent", "assistant", "relayed", "scheduled", "notice", "missing"]) {
      const refused = yield* Effect.flip(coordinator.grantFromMessage({ messageId, grant }));
      assert.equal(refused.reason, "policy");
    }
    assert.notInclude(
      requests.map((request) => request.method),
      "grants.set",
    );
    yield* coordinator.grantFromMessage({ messageId: "owner", grant });
    assert.deepInclude(requests.find((request) => request.method === "grants.set")?.params, {
      grant,
      actor: "coordinator",
      sourceMessageId: "owner",
      sourceMessageText: "Work in src.",
      sourceMessageAt: 5,
      sourceMessageAnswered: false,
    });
    assert.deepEqual([...new Set(read)], ["coordinator"]);
    // What the message does not say comes back as a proposal for the owner, and is not made.
    store.grantSetResult = { proposal: grant, reason: "The owner's message does not name src" };
    const proposed = yield* coordinator.grantFromMessage({ messageId: "owner", grant });
    assert.deepEqual(proposed.proposal, {
      grant,
      reason: "The owner's message does not name src",
    });
    // What the store refuses comes back with the store's reason, not as a bare "policy".
    store.refusals = { "grants.set": "That message already made another grant" };
    const again = yield* Effect.flip(coordinator.grantFromMessage({ messageId: "owner", grant }));
    assert.equal(again.message, "That message already made another grant");
    store.refusals = {};
    // Only the owner's newest message grants: an older one is proposed, though nothing answered it.
    yield* coordinator.grantFromMessage({ messageId: "older", grant });
    assert.deepInclude(requests.findLast((request) => request.method === "grants.set")?.params, {
      sourceMessageId: "older",
      sourceMessageAnswered: true,
    });
    // A message the Coordinator's finished turn already answered is no longer the request.
    yield* coordinator.grantFromMessage({ messageId: "answered", grant });
    assert.deepInclude(requests.findLast((request) => request.method === "grants.set")?.params, {
      sourceMessageId: "answered",
      sourceMessageAnswered: true,
    });
  }).pipe(
    Effect.provide(
      harness(store, requests, {
        getThreadRecords: (threadId) =>
          Effect.sync(() => {
            read.push(threadId);
            return { messages, runs } as never;
          }),
      }),
    ),
  );
});

it.effect("a grant made or withdrawn shows as a line in the Coordinator's thread", () => {
  const grant = {
    id: "grant",
    scope: { kind: "project" as const, id: "project" },
    folders: ["src"],
    delete: ["old.ts"],
    lifts: ["force-push"],
    expiresAt: Date.UTC(2026, 10, 14, 9, 30),
  };
  const store: Store = {
    cards: [],
    assignments: [],
    actions: [],
    grant,
    configuration: { enabled: true, coordinatorThreadId: "coordinator" },
  };
  const requests: Array<{ method: string; params: unknown }> = [];
  const lines: Array<unknown> = [];
  return Effect.gen(function* () {
    const coordinator = yield* Coordinator.Coordinator;
    yield* coordinator.command({ type: "grant.set", grant });
    yield* coordinator.command({ type: "grant.withdraw", grantId: "grant" });
    // The owner's lift reaches the store as theirs, and the line says what it lifts.
    assert.deepInclude(requests.find((request) => request.method === "grants.set")?.params, {
      grant,
      actor: "user",
    });
    assert.deepEqual(
      lines.map((line) => (line as { notification: { summary: string } }).notification.summary),
      [
        "The owner made a grant: App; folders src; may delete old.ts; lifts force-push; edits and commands in its worktree; until 2026-11-14 09:30 UTC",
        "The owner withdrew a grant: App; folders src; may delete old.ts; lifts force-push; edits and commands in its worktree; until 2026-11-14 09:30 UTC",
      ],
    );
    assert.deepInclude(lines[0], {
      type: "message.dispatch",
      threadId: "coordinator",
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
    });
  }).pipe(
    Effect.provide(
      harness(
        store,
        requests,
        {
          dispatch: (command) =>
            Effect.sync(() => {
              if (command.type === "message.dispatch") lines.push(command);
              return {} as never;
            }),
        },
        {
          projects: {
            listShells: () => Effect.succeed([{ id: "project", title: "App" }] as never),
          },
        },
      ),
    ),
  );
});

it.effect("the Coordinator's model answers an approval only as itself, in its own thread", () => {
  const store: Store = {
    cards: [],
    assignments: [],
    actions: [],
    permissionRequests: [
      { id: "local:r1", threadId: "managed", status: "pending" },
      { id: "local:r2", threadId: "managed", status: "pending" },
    ],
    // A delivered answer closes its request; r2's never reaches its thread.
    signal: (method, params) =>
      Effect.sync(() => {
        if (method !== "permissions.decide") return;
        const delivered = (params as Row).requestId === "local:r1";
        const index = store.permissionRequests!.findIndex(
          (item) => delivered && item.id === "local:r1",
        );
        if (index >= 0) store.permissionRequests!.splice(index, 1);
        store.actions.push({
          ...action(
            `permission:${(params as Row).requestId}:1`,
            delivered ? "completed" : "failed",
          ),
          kind: "permission.respond",
          payload: delivered ? { acknowledgement: { destinationAcknowledged: true } } : {},
        });
      }),
  };
  const requests: Array<{ method: string; params: unknown }> = [];
  return Effect.gen(function* () {
    const coordinator = yield* Coordinator.Coordinator;
    const answer = coordinator.answerApproval!;
    // A request is answered only in the thread that holds it.
    const elsewhere = yield* Effect.flip(
      answer({ threadId: "other", requestId: "r1", decision: "allow" }),
    );
    assert.equal(elsewhere.reason, "invalid");
    assert.include(elsewhere.message, "no open request");
    yield* answer({ threadId: "managed", requestId: "r1", decision: "owner" });
    yield* answer({ threadId: "managed", requestId: "r1", decision: "allow" });
    const asked = requests.filter((request) => request.method.startsWith("permissions."));
    assert.deepEqual(asked, [
      {
        method: "permissions.pass",
        params: { requestId: "local:r1", actor: "coordinator-model" },
      },
      {
        method: "permissions.decide",
        params: {
          requestId: "local:r1",
          decision: "approve",
          actor: "coordinator-model",
          grantRevision: 7,
        },
      },
    ]);
    // An answer that did not reach the thread is not reported as given.
    const undelivered = yield* Effect.flip(
      answer({ threadId: "managed", requestId: "r2", decision: "deny" }),
    );
    assert.include(undelivered.message, "did not reach the thread");
    // What the store refuses comes back in the store's words, not as a bare "policy".
    store.refusals = { "permissions.pass": "This request is for a rule or the owner" };
    const refused = yield* Effect.flip(
      answer({ threadId: "managed", requestId: "r2", decision: "owner" }),
    );
    assert.equal(refused.message, "This request is for a rule or the owner");
  }).pipe(Effect.provide(harness(store, requests)));
});

it.effect("an answer is delivered only when its own action has the thread's acknowledgment", () => {
  const respond = (id: string, status: string, acknowledged = false) => ({
    ...action(id, status),
    kind: "permission.respond",
    payload: acknowledged ? { acknowledgement: { destinationAcknowledged: true } } : {},
  });
  let outcome = "pending";
  const store: Store = {
    cards: [],
    // Another request's answer was acknowledged; this one's sits behind a backlog, then is uncertain.
    actions: [respond("permission:local:r9:1", "completed", true)],
    assignments: [],
    permissionRequests: [{ id: "local:r1", threadId: "managed", status: "pending" }],
    signal: (method) =>
      Effect.sync(() => {
        if (method === "permissions.decide")
          store.actions.unshift(respond("permission:local:r1:1", outcome));
      }),
  };
  const requests: Array<{ method: string; params: unknown }> = [];
  return Effect.gen(function* () {
    const answer = (yield* Coordinator.Coordinator).answerApproval!;
    const queued = yield* Effect.flip(
      answer({ threadId: "managed", requestId: "r1", decision: "deny" }),
    );
    assert.equal(queued.reason, "destination");
    assert.include(queued.message, "queued");
    store.actions.splice(0, 1);
    outcome = "uncertain";
    const sent = requests.length;
    const uncertain = yield* Effect.flip(
      answer({ threadId: "managed", requestId: "r1", decision: "deny" }),
    );
    assert.include(uncertain.message, "unknown whether the thread took");
    // An uncertain answer is never sent again.
    assert.notInclude(
      requests.slice(sent).map((request) => request.method),
      "actions.claim",
    );
  }).pipe(Effect.provide(harness(store, requests)));
});

it.effect("a person's own thread keeps its folder, mode and prompts, Coordinator on or off", () =>
  Effect.gen(function* () {
    const runtimeRequest = {
      id: "r1",
      nodeId: "n1",
      kind: "command",
      status: "pending",
      responseCapability: { type: "live", providerSessionId: "session" },
    };
    const turnItem = {
      type: "approval_request",
      requestId: "r1",
      nodeId: "n1",
      operation: `Edit {"file_path":"/work/person/projects/other/a.ts"}`,
    };
    const run = (
      enabled: boolean,
      effective: Record<string, unknown>,
      assignmentId: string | null,
    ) => {
      const store: Store = {
        cards: [{ ...card("person"), assignmentId }],
        assignments: [
          {
            ...assignment("work", "person"),
            receipt: { threadId: "person", prefix: "projects/app" },
          },
        ],
        actions: [],
        configuration: { enabled, coordinatorThreadId: "coordinator" },
        effective,
      };
      const requests: Array<{ method: string; params: unknown }> = [];
      const changed: Array<string> = [];
      return Effect.gen(function* () {
        const coordinator = yield* Coordinator.Coordinator;
        yield* coordinator.command({ type: "cycle.run" });
        return {
          methods: requests.map((request) => request.method),
          changed,
          registered: (
            requests.find((request) => request.method === "permissions.request")!.params as {
              request: Record<string, unknown>;
            }
          ).request,
        };
      }).pipe(
        Effect.provide(
          harness(
            store,
            requests,
            {
              getThreadRecords: (_threadId, fields) =>
                Effect.succeed(
                  (fields.some((field) => field === "turnItems")
                    ? { turnItems: [turnItem] }
                    : {
                        thread: { runtimeMode: "full-access", worktreePath: "/work/person" },
                        runtimeRequests: [runtimeRequest],
                      }) as never,
                ),
              getThreadShell: () => Effect.succeed(null),
              dispatch: (command) =>
                Effect.sync(() => {
                  changed.push(command.type);
                  return undefined as never;
                }),
            },
            {
              launch: {
                launch: () =>
                  Effect.sync(() => {
                    changed.push("launch");
                    return undefined as never;
                  }),
              },
            },
          ),
        ),
      );
    };
    const allowed = { effect: "allow", policyRevision: 1, grantId: null };
    for (const enabled of [true, false]) {
      const { methods, changed } = yield* run(enabled, allowed, null);
      // The prompt stays for the person: nothing answers it, launches or changes the thread.
      assert.notInclude(methods, "permissions.decide");
      assert.deepEqual(changed, []);
    }
    // The same request from delegated work inside a grant is answered by rule.
    const delegated = yield* run(true, { ...allowed, grantId: "grant" }, "work");
    assert.include(delegated.methods, "permissions.decide");
    // Its paths are read in its project's folder, so a sibling project is outside it.
    assert.deepInclude(delegated.registered, {
      resource: "/work/person/projects/other/a.ts",
      outsideWorkspace: true,
    });
  }),
);

it.effect("a rule's answer is sent when it is made, not at the next minute's drain", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<unknown>();
    const store: Store = {
      cards: [{ ...card("author"), assignmentId: "work" }],
      assignments: [assignment("work", "author")],
      actions: [],
      configuration: { enabled: true, coordinatorThreadId: "coordinator" },
      effective: { effect: "allow", policyRevision: 1, grantId: "grant" },
    };
    const requests: Array<{ method: string; params: unknown }> = [];
    yield* Effect.gen(function* () {
      yield* (yield* Coordinator.Coordinator).start;
      yield* TestClock.adjust("2 seconds");
      requests.length = 0;
      // The author asks between two minute ticks.
      yield* Queue.offer(events, { type: "runtime-request.updated", threadId: "author" });
      yield* TestClock.adjust("2 seconds");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        harness(
          store,
          requests,
          {
            streamDomainEvents: Stream.fromQueue(events) as never,
            getThreadRecords: () =>
              Effect.succeed({
                thread: { runtimeMode: "full-access" },
                runtimeRequests: [
                  {
                    id: "r1",
                    nodeId: "n1",
                    kind: "command",
                    status: "pending",
                    responseCapability: { type: "live", providerSessionId: "session" },
                  },
                ],
                turnItems: [],
              } as never),
            getThreadShell: () => Effect.succeed(null),
          },
          quietServices,
        ),
      ),
    );
    const methods = requests.map((request) => request.method);
    assert.include(methods, "permissions.decide");
    assert.include(methods.slice(methods.indexOf("permissions.decide")), "actions.list");
  }),
);

it.effect("an inline approval is sent only for a request holding its whole operation", () => {
  // Each approval carries the operation stored, and shown, when its request was imported.
  const respond = (requestId: string) => ({
    ...action(`permission:${requestId}`, "pending"),
    kind: "permission.respond",
    threadId: "t000",
    environmentId: "local",
    instructionRevision: 0,
    payload: {
      requestId: `local:${requestId}`,
      destinationRequestId: requestId,
      decision: "approve",
      actor: "user",
      operation: "vp test",
    },
  });
  const store: Store = {
    cards: [card("t000")],
    assignments: [],
    actions: [respond("r1"), respond("r2"), respond("r3")],
    claim: true,
  };
  const requests: Array<{ method: string; params: unknown }> = [];
  const runtimeRequests = ["r1", "r2", "r3"].map((id) => ({
    id,
    nodeId: `n-${id}`,
    kind: "command",
    status: "pending",
    responseCapability: { type: "live", providerSessionId: "session" },
  }));
  const turnItems = [
    {
      type: "approval_request",
      requestId: "r1",
      nodeId: "n-r1",
      prompt: "Need permission to continue",
      operation: "vp test",
    },
    // Only a rationale: accepting would approve a command nobody was shown.
    {
      type: "approval_request",
      requestId: "r2",
      nodeId: "n-r2",
      prompt: "Need permission to continue",
    },
    // Changed since it was imported: approving would accept what the row never showed.
    {
      type: "approval_request",
      requestId: "r3",
      nodeId: "n-r3",
      prompt: "Need permission to continue",
      operation: "vp test && rm -rf ~",
    },
  ];
  const dispatched: Array<string> = [];
  return Effect.gen(function* () {
    const coordinator = yield* Coordinator.Coordinator;
    yield* coordinator.command({
      type: "permission.respond",
      requestId: "local:r1",
      decision: "approve",
    });
    assert.deepEqual([...new Set(dispatched)], ["r1"]);
    for (const id of ["permission:r2", "permission:r3"]) {
      const refused = requests.find(
        (request) =>
          request.method === "actions.ack" && (request.params as { id: string }).id === id,
      );
      assert.deepInclude(refused?.params, { status: "failed" });
    }
  }).pipe(
    Effect.provide(
      harness(store, requests, {
        getThreadRecords: () =>
          Effect.succeed({
            thread: { runtimeMode: "approval-required" },
            runtimeRequests,
            turnItems,
          } as never),
        getThreadShell: () => Effect.succeed({ latestUserAuthoredMessageAt: null } as never),
        dispatch: (command) =>
          Effect.suspend(() => {
            if (command.type === "runtime-request.respond") dispatched.push(command.requestId);
            return Effect.fail(new Error("stop") as never);
          }),
      }),
    ),
  );
});

it.effect("a delegation from a parent card beyond the first snapshot page proceeds", () => {
  const parent = card("t100");
  const store: Store = {
    cards: [...Array.from({ length: PAGE }, (_, value) => card(`f${index(value)}`)), parent],
    assignments: [],
    actions: [],
    goals: [{ id: "goal", purpose: "Ship it", status: "active" }],
    configuration: {
      enabled: true,
      coordinatorProvider: "replay",
      coordinatorModel: "model",
      coordinatorThreadId: "coordinator",
      coordinatorProjectId: "project",
    },
  };
  const requests: Array<{ method: string; params: unknown }> = [];
  const checked: Array<string> = [];
  return Effect.gen(function* () {
    const coordinator = yield* Coordinator.Coordinator;
    yield* coordinator.delegate!({
      kind: "delegate",
      goalId: "goal",
      parentThreadId: "t100",
      task: "Build it.",
      title: "Build",
      target: {},
    });
    assert.include(checked, "t100");
  }).pipe(
    Effect.provide(
      harness(store, requests, {
        getThreadRecords: () => Effect.succeed({ runtimeRequests: [] } as never),
        getThreadShell: (threadId) =>
          Effect.sync(() => {
            checked.push(threadId);
            return null;
          }),
      }),
    ),
  );
});

const goal = { id: "goal", purpose: "Ship it", status: "active", authorizedScope: ["project"] };

const queuedIntent = {
  id: "route",
  goalId: "goal",
  cardId: "local:t100",
  generation: 1,
  pauseRevision: 0,
  grantRevision: 0,
  instructionRevision: 0,
  intent: {
    kind: "delegate",
    goalId: "goal",
    parentThreadId: "t100",
    task: "Build it.",
    title: "Build",
    target: {},
  },
};
const quietThreads = {
  streamDomainEvents: Stream.empty,
  getThreadRecords: () => Effect.succeed({ runtimeRequests: [] } as never),
  getThreadShell: (threadId: string) =>
    Effect.succeed((threadId === "t100" ? { latestUserAuthoredMessageAt: null } : null) as never),
};
// The owner's message at 5 s, which started a run in its chat and which no cycle has carried to
// the parent's card yet; the Coordinator's own turn was asked for at `turnRequestedAt`.
const ownerWrote = (turnRequestedAt = 5_000) => ({
  ...quietThreads,
  getThreadShell: (threadId: string) =>
    Effect.succeed(
      (threadId === "t100"
        ? {
            latestUserAuthoredMessageAt: DateTime.makeUnsafe(5_000),
            latestRunRequestedAt: DateTime.makeUnsafe(5_000),
          }
        : threadId === "coordinator"
          ? { latestRunRequestedAt: DateTime.makeUnsafe(turnRequestedAt) }
          : null) as never,
    ),
});
it.effect("a delegation made right after the owner's message is asked against that message", () => {
  const store: Store = {
    cards: [card("t100")],
    assignments: [],
    actions: [],
    goals: [goal],
    configuration: { enabled: true, coordinatorThreadId: "coordinator" },
  };
  const requests: Array<{ method: string; params: unknown }> = [];
  return Effect.gen(function* () {
    yield* Effect.ignore(
      (yield* Coordinator.Coordinator).delegate!({ ...queuedIntent.intent, kind: "delegate" }),
    );
    const sent = (method: string) =>
      requests.filter((request) => request.method === method).map((request) => request.params);
    assert.deepInclude(sent("routing.enqueue")[0], {
      cardId: "local:t100",
      instructionRevision: 5_000,
    });
    // The store queues it only against its card, which now holds that message; nothing else is
    // sent, so a status or settlement written since the card was read survives.
    assert.deepEqual(sent("cards.sync"), [
      { cards: [{ id: "local:t100", instructionRevision: 5_000 }] },
    ]);
  }).pipe(Effect.provide(harness(store, requests, ownerWrote())));
});
it.effect(
  "a delegation from a Coordinator turn asked for before the owner's message is not started",
  () => {
    const store: Store = {
      cards: [card("t100")],
      assignments: [],
      actions: [],
      goals: [goal],
      configuration: { enabled: true, coordinatorThreadId: "coordinator" },
    };
    const requests: Array<{ method: string; params: unknown }> = [];
    return Effect.gen(function* () {
      yield* Effect.ignore(
        (yield* Coordinator.Coordinator).delegate!({ ...queuedIntent.intent, kind: "delegate" }),
      );
      const methods = requests.map((request) => request.method);
      assert.notInclude(methods, "routing.enqueue");
      assert.notInclude(methods, "cards.sync");
    }).pipe(Effect.provide(harness(store, requests, ownerWrote(4_000))));
  },
);
const quietProviders = {
  providers: {
    streamChanges: Stream.empty,
    getProviders: Effect.succeed([]),
    refresh: () => Effect.succeed([]),
  },
  instances: { streamChanges: Stream.empty },
  settings: { streamChanges: Stream.empty },
};

it.effect(
  "at start-up a crash's unfinished settlement is finished: worktree removed, thread archived",
  () =>
    Effect.gen(function* () {
      // `failing`: the step that fails this start, which leaves the settlement unfinished.
      const recover = (failing: "none" | "removal" | "archive") =>
        Effect.gen(function* () {
          const settledByHost = {
            ...action("settle:goal:a1", "completed"),
            kind: "thread.settle",
            threadId: "coordinator:t1",
            environmentId: "local",
            payload: {
              goalId: "goal",
              assignmentId: "a1",
              cardId: "local:coordinator:t1",
              expectedRunId: "run",
              cloud: false,
            },
          };
          const store: Store = {
            // The owner settled t2 by hand: no settlement of the host's, so recovery never touches it.
            cards: [
              { ...card("coordinator:t1"), settled: true, assignmentId: "a1" },
              { ...card("coordinator:t2"), settled: true, assignmentId: "a1" },
            ],
            unfinished: [settledByHost],
            assignments: [
              {
                ...reviewedAuthor,
                receipt: {
                  ...reviewedAuthor.receipt,
                  threadId: "coordinator:t1",
                  worktree: "/work/t1",
                },
              },
            ],
            actions: [],
            configuration: { enabled: true },
          };
          const requests: Array<{ method: string; params: unknown }> = [];
          const removed: Array<unknown> = [];
          const dispatched: Array<string> = [];
          return yield* Effect.gen(function* () {
            yield* (yield* Coordinator.Coordinator).start;
            if (failing === "none") {
              assert.deepEqual(removed, [{ repository: "/repo/projects/app", path: "/work/t1" }]);
              assert.deepEqual(dispatched, ["thread.metadata.update", "thread.archive"]);
            }
            return requests
              .filter((request) => request.method === "settlements.finished")
              .map((request) => request.params);
          }).pipe(
            Effect.scoped,
            Effect.provide(
              harness(
                store,
                requests,
                {
                  ...quietThreads,
                  getThreadShell: (threadId) =>
                    Effect.succeed({
                      id: threadId,
                      projectId: "project",
                      settledOverride: "settled",
                      archivedAt: null,
                      worktreePath: "/work/t1",
                    } as never),
                  dispatch: (command: { type: string }) =>
                    failing === "archive" && command.type === "thread.archive"
                      ? Effect.fail(new Error("archive refused") as never)
                      : Effect.sync(
                          () => (dispatched.push(command.type), { sequence: 1 }) as never,
                        ),
                },
                {
                  ...quietProviders,
                  merges: {
                    removeWorktree: (input) =>
                      failing === "removal"
                        ? Effect.fail(
                            new CoordinatorError({
                              operation: "worktree-remove",
                              reason: "destination",
                            }),
                          )
                        : Effect.sync(() => (removed.push(input), [])),
                  },
                  projects: {
                    listShells: () => Effect.succeed([]),
                    getById: () => Effect.succeedSome(project as never),
                  },
                },
              ),
            ),
          );
        });
      assert.deepEqual(yield* recover("none"), [{ id: "settle:goal:a1" }]);
      // Either step failing leaves it unfinished, for the next start to try again.
      assert.deepEqual(yield* recover("removal"), []);
      assert.deepEqual(yield* recover("archive"), []);
    }),
);

// Settles at the first of: the routing claim (every check passed), cancellation, or the next
// cycle starting with the delegation neither claimed nor cancelled.
const retryQueuedDelegation = (
  parent: Row,
  expected: "claimed" | "cancelled" | "skipped",
  goals: Array<Row> = [goal],
  threads = quietThreads,
) =>
  Effect.gen(function* () {
    const outcome = yield* Deferred.make<string>();
    const store: Store = {
      cards: [...Array.from({ length: PAGE }, (_, value) => card(`f${index(value)}`)), parent],
      assignments: [],
      actions: [],
      goals,
      configuration: {
        enabled: true,
        coordinatorThreadId: "coordinator",
        coordinatorProjectId: "project",
      },
      routing: [queuedIntent],
      signal: (method, params) =>
        method === "routing.claim"
          ? Deferred.succeed(outcome, "claimed")
          : method === "routing.cancel"
            ? Deferred.succeed(outcome, "cancelled")
            : // A cycle syncs the open cards; start-up's look over settled work is not one.
              method === "cards.list" && !(params as { history?: boolean }).history
              ? Deferred.succeed(outcome, "skipped")
              : Effect.void,
    };
    const requests: Array<{ method: string; params: unknown }> = [];
    yield* Effect.gen(function* () {
      const coordinator = yield* Coordinator.Coordinator;
      yield* coordinator.start;
      assert.equal(yield* Deferred.await(outcome), expected);
    }).pipe(Effect.scoped, Effect.provide(harness(store, requests, threads, quietProviders)));
  });

// Parents lie behind 100 other cards; native routing already drops intents whose
// instruction revision changed, so ordinary progress on the parent must not cancel.
it.effect("a queued delegation from a parent card beyond the first snapshot page is retried", () =>
  retryQueuedDelegation(card("t100"), "claimed"),
);
it.effect("a queued delegation still runs after ordinary progress on its parent", () =>
  retryQueuedDelegation(
    { ...card("t100"), status: "blocked", revision: 9, evidence: ["Ran the tests."] },
    "claimed",
  ),
);
// Its goal is the 101st active goal: outside the snapshot, read directly.
const goalsBefore = (last: Row) => [
  ...Array.from({ length: PAGE }, (_, value) => ({ ...goal, id: `a${index(value)}` })),
  last,
];
it.effect("a queued delegation whose goal lies beyond the first snapshot page runs", () =>
  retryQueuedDelegation(card("t100"), "claimed", goalsBefore(goal)),
);
it.effect("a queued delegation stops when its goal is gone or no longer authorizes it", () =>
  Effect.forEach(
    [
      goalsBefore({ ...goal, id: "other" }),
      goalsBefore({ ...goal, authorizedScope: ["elsewhere"] }),
      goalsBefore({ ...goal, status: "completed" }),
    ],
    (goals) => retryQueuedDelegation(card("t100"), "skipped", goals),
    { discard: true },
  ),
);
it.effect("a queued delegation is cancelled when the owner wrote since it was asked", () =>
  retryQueuedDelegation(card("t100"), "cancelled", [goal], ownerWrote()),
);
it.effect("a queued delegation is cancelled when its parent was archived", () =>
  retryQueuedDelegation({ ...card("t100"), archived: true }, "cancelled"),
);

const catalogModel = {
  id: "catalog:local:model",
  sourceId: "replay",
  provider: "replay",
  model: "model",
  destination: "local",
  account: "replay",
  aliases: [],
  efforts: ["high"],
  state: "eligible",
  compatible: true,
  accessible: true,
  policyAllowed: true,
  qualificationVerified: true,
  identityVerified: true,
  contextTokens: null,
  outputTokens: null,
  priceMicros: null,
  pricingProvenance: null,
  evidence: ["T3 provider registry"],
  stale: false,
  missingRefreshes: 0,
  discoveredAt: 0,
  revision: 1,
};
const pick = { instance: "replay", model: "model", effort: "high", destination: "local" };
const limits = { limits: { inFlight: null, perLogin: null, localSlots: null } };

// The queued delegation, claimed and routed by the maintenance minute at start.
const routeQueued = (store: Partial<Store>) =>
  Effect.gen(function* () {
    const settled = yield* Deferred.make<void>();
    const requests: Array<{ method: string; params: unknown }> = [];
    yield* Effect.gen(function* () {
      yield* (yield* Coordinator.Coordinator).start;
      yield* Deferred.await(settled);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        harness(
          {
            cards: [card("t100")],
            assignments: [],
            actions: [],
            goals: [goal],
            configuration: {
              enabled: true,
              coordinatorThreadId: "coordinator",
              coordinatorProjectId: "project",
            },
            routing: [queuedIntent],
            claimRouting: true,
            catalog: [catalogModel],
            score: () => ({ pick, scores: [{ reason: null }] }),
            ...store,
            // The retry drains the outbox once its routing is done.
            signal: (method) =>
              method === "actions.list" ? Deferred.succeed(settled, undefined) : Effect.void,
          },
          requests,
          quietThreads,
          quietProviders,
        ),
      ),
    );
    return (method: string) =>
      requests.filter((request) => request.method === method).map((request) => request.params);
  });

it.effect("a delegation is routed by the native router and holds its capacity in the store", () =>
  Effect.gen(function* () {
    const sent = yield* routeQueued({});
    const [score] = sent("router.score") as Array<{
      request: { candidates: Array<unknown>; [key: string]: unknown };
    }>;
    assert.deepInclude(score?.request, { rank: "B", minTier: 0, reviewOf: [] });
    // No number bounds the work but this machine's own CPUs and memory.
    assert.isAtLeast(score?.request.localSlots as number, 0);
    assert.deepInclude(score?.request.candidates[0], {
      instance: "replay",
      model: "model",
      effort: "high",
      destination: "local",
      ownerRunning: 0,
    });
    const [prepared] = sent("assignments.prepare") as Array<{
      assignment: {
        route: unknown;
        reservation: Record<string, unknown>;
        title: string;
        returnRoute: string;
      };
    }>;
    assert.equal(prepared?.assignment.title, "Build");
    // Briefs say "to the Coordinator through" it, so it names only the thread.
    assert.equal(prepared?.assignment.returnRoute, "T3 thread t100");
    assert.deepEqual(prepared?.assignment.route, {
      profileId: "catalog:local:model",
      provider: "replay",
      model: "model",
      effort: "high",
      account: "replay",
      destination: "local",
    });
    assert.deepInclude(prepared?.assignment.reservation, {
      id: "reservation:route",
      owner: "t3:local",
      sharedCapacity: true,
    });
    assert.deepEqual(sent("routing.defer"), []);
  }),
);

it.effect("a goal the board holds, a cap or a limit leaves the delegation waiting with why", () =>
  Effect.gen(function* () {
    const reasons = (store: Partial<Store>) =>
      routeQueued(store).pipe(
        Effect.map((sent) =>
          (sent("routing.defer") as Array<{ reason: string }>).map((item) => item.reason),
        ),
      );
    const held = yield* routeQueued({
      board: {
        next: [],
        waiting: [{ goalId: "goal", reason: "touches overlap goal other" }],
        capacity: limits,
      },
    });
    assert.deepEqual(held("routing.defer"), [
      { id: "route", reason: "Waiting: touches overlap goal other" },
    ]);
    assert.deepEqual(held("router.score"), []);
    assert.deepEqual(
      yield* reasons({
        prepare: () => ({ blocked: true, capped: true, reason: "Goal goal reached its cap" }),
      }),
      ["Waiting: Goal goal reached its cap"],
    );
    assert.deepEqual(yield* reasons({ prepare: () => REFUSED }), [
      "Waiting: assignments.prepare failed (policy).",
    ]);
    assert.deepEqual(
      yield* reasons({
        score: () => ({ pick: null, scores: [{ reason: "at its parallel limit" }] }),
      }),
      ["Waiting for a route: at its parallel limit"],
    );
  }),
);

it.effect("held work is retried on the event that ends an assignment, not the next minute", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<unknown>();
    const requests: Array<{ method: string; params: unknown }> = [];
    yield* Effect.gen(function* () {
      yield* (yield* Coordinator.Coordinator).start;
      yield* TestClock.adjust("2 seconds");
      requests.length = 0;
      yield* Queue.offer(events, {
        type: "run.updated",
        threadId: "t100",
        payload: { id: "run", threadId: "t100", status: "completed" },
      });
      yield* TestClock.adjust("2 seconds");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        harness(
          {
            cards: [card("t100")],
            assignments: [],
            actions: [],
            goals: [goal],
            configuration: { enabled: true, coordinatorThreadId: "coordinator" },
            routing: [queuedIntent],
          },
          requests,
          { ...quietThreads, streamDomainEvents: Stream.fromQueue(events) as never },
          quietProviders,
        ),
      ),
    );
    assert.include(
      requests.map((request) => request.method),
      "routing.claim",
    );
  }),
);

it.effect("the person's guidance save keeps or clears the Coordinator's notes", () =>
  Effect.gen(function* () {
    const store: Store = {
      cards: [],
      assignments: [],
      actions: [],
      guidance: {
        threadId: "coordinator",
        customPrompt: "",
        memory: "",
        coordinatorNotes: "Uses pnpm.",
        revision: 1,
      },
    };
    const save = (notes?: string) =>
      Coordinator.Coordinator.pipe(
        Effect.flatMap((coordinator) =>
          coordinator.command({
            type: "guidance.save",
            threadId: "coordinator",
            customPrompt: "Be brief.",
            memory: "",
            ...(notes === undefined ? {} : { coordinatorNotes: notes }),
          }),
        ),
        Effect.provide(harness(store, [])),
        Effect.map(() => store.guidance?.coordinatorNotes),
      );
    assert.equal(yield* save(), "Uses pnpm.");
    assert.equal(yield* save(""), "");
  }),
);

it.effect("a pending approval on a card beyond the first snapshot page is imported", () => {
  const store: Store = {
    cards: [...Array.from({ length: PAGE }, (_, value) => card(`f${index(value)}`)), card("t100")],
    assignments: [],
    actions: [],
  };
  const requests: Array<{ method: string; params: unknown }> = [];
  const pending = {
    thread: { runtimeMode: "approval-required" },
    runtimeRequests: [
      {
        id: "r1",
        nodeId: "n1",
        kind: "command",
        status: "pending",
        responseCapability: { type: "live", providerSessionId: "session" },
      },
    ],
  };
  return Effect.gen(function* () {
    const coordinator = yield* Coordinator.Coordinator;
    yield* coordinator.command({ type: "cycle.run" });
    const registered = requests.filter((request) => request.method === "permissions.request");
    assert.deepEqual(
      registered.map(
        (request) => (request.params as { request: { cardId: string } }).request.cardId,
      ),
      ["local:t100"],
    );
  }).pipe(
    Effect.provide(
      harness(store, requests, {
        getThreadRecords: (threadId, fields) =>
          Effect.succeed(
            (fields.some((field) => field === "turnItems")
              ? { turnItems: [] }
              : threadId === "t100"
                ? pending
                : { runtimeRequests: [] }) as never,
          ),
      }),
    ),
  );
});

// The Coordinator started with every stream quiet.
const recovering = <E>(
  store: Store,
  records: () => Effect.Effect<unknown, CoordinatorError>,
  test: (coordinator: Coordinator.Coordinator["Service"]) => Effect.Effect<void, E, Scope.Scope>,
) =>
  Effect.gen(function* () {
    yield* test(yield* Coordinator.Coordinator);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      harness(
        store,
        [],
        {
          streamDomainEvents: Stream.empty,
          getThreadRecords: () => records() as never,
        },
        {
          instances: { streamChanges: Stream.empty },
          providers: { streamChanges: Stream.empty },
          settings: { streamChanges: Stream.empty },
        },
      ),
    ),
  );
const completedRun = () =>
  Effect.succeed({ runs: [{ id: "run", status: "completed" }], runtimeRequests: [] });

it.effect("the snapshot says the store is down until it answers again", () =>
  Effect.gen(function* () {
    // The maintenance minute reaches `tick` only after it has read a snapshot.
    const ticks = yield* Queue.unbounded<string>();
    let down: "transport" | "unavailable" | undefined = "unavailable";
    const store: Store = {
      cards: [],
      assignments: [],
      actions: [],
      configuration: { enabled: true },
      down: () => down,
      signal: (method) => (method === "tick" ? Queue.offer(ticks, method) : Effect.void),
    };
    yield* recovering(store, completedRun, (coordinator) =>
      Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis;
        yield* coordinator.start;
        assert.deepEqual((yield* coordinator.get).availability, {
          available: false,
          reason: "The supervisor is not responding.",
          since: startedAt,
        });
        down = undefined;
        yield* TestClock.adjust("1 minute");
        yield* Queue.take(ticks);
        assert.deepEqual((yield* coordinator.get).availability, { available: true });
        down = "transport";
        yield* coordinator.command({ type: "cycle.run" }).pipe(Effect.flip);
        assert.deepEqual((yield* coordinator.get).availability?.since, startedAt + 60_000);
      }),
    );
  }),
);

const quietServices = {
  instances: { streamChanges: Stream.empty },
  providers: {
    streamChanges: Stream.empty,
    getProviders: Effect.succeed([]),
    refresh: () => Effect.succeed([]),
  },
  settings: { streamChanges: Stream.empty },
};

it.effect(
  "never switched on, the server starts no store, makes no database and asks nothing, its board included",
  () =>
    Effect.gen(function* () {
      let spawns = 0;
      const supervisor = Supervisor.layer.pipe(
        Layer.provide(
          Layer.succeed(Supervisor.SupervisorSpawn, () => {
            spawns++;
            throw new Error("No store process in this test.");
          }),
        ),
        Layer.provide(
          Layer.succeed(HostProcess.Environment, { T3_COORDINATOR_EXECUTABLE: process.execPath }),
        ),
      );
      const store: Store = { cards: [], assignments: [], actions: [] };
      yield* Effect.gen(function* () {
        const coordinator = yield* Coordinator.Coordinator;
        yield* coordinator.start;
        const role = yield* CoordinatorRole.CoordinatorRole;
        assert.deepEqual(yield* role.holds("coordinator-lead:any" as never), {
          holds: false,
          paused: true,
        });
        yield* TestClock.adjust("5 minutes");
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // A deliverable an ordinary thread asks for is refused without starting the store.
        const read = yield* coordinator.deliverable!(
          {
            environmentId: EnvironmentId.make("local"),
            requestNamespace: "provider:person",
            thread: undefined,
            client: undefined,
            capabilities: new Set(["orchestration"]),
            issuedAt: 0,
          },
          { assignmentId: "a1", projectId: "project", kind: "patch" },
        ).pipe(Effect.flip);
        assert.equal(read.reason, "policy");
        // The owner's board reads empty and its writes are refused, still with no store.
        const board = yield* coordinator.board;
        assert.deepEqual([board.goals, board.weights], [[], { use: 1, time: 1 }]);
        const refused = yield* coordinator
          .command({ type: "router.weights.set", weights: { use: 2, time: 1 } })
          .pipe(Effect.flip);
        assert.equal(refused.reason, "policy");
        assert.equal(spawns, 0);
        assert.isFalse(yield* fs.exists(path.join(config.stateDir, "coordinator.sqlite")));
      }).pipe(
        Effect.scoped,
        Effect.provide(
          harness(store, [], { streamDomainEvents: Stream.empty }, quietServices, supervisor),
        ),
      );
    }),
);

it.effect("a Coordinator known to be off starts nothing and asks its store nothing", () =>
  Effect.gen(function* () {
    const off = { enabled: false, coordinatorThreadId: null, paused: true };
    // Never made, or last seen off: no request at all, at start or after.
    const store: Store = { seen: off, cards: [], assignments: [], actions: [] };
    const requests: Array<{ method: string; params: unknown }> = [];
    yield* Effect.gen(function* () {
      const coordinator = yield* Coordinator.Coordinator;
      yield* coordinator.start;
      yield* TestClock.adjust("5 minutes");
      assert.deepEqual(requests, []);
      assert.isFalse((yield* coordinator.get).configuration.enabled);
    }).pipe(
      Effect.scoped,
      Effect.provide(harness(store, requests, { streamDomainEvents: Stream.empty }, quietServices)),
    );
  }),
);

it.effect("a store whose switch is unknown is read once, and off asks nothing more", () =>
  Effect.gen(function* () {
    const store: Store = { cards: [], assignments: [], actions: [] };
    const requests: Array<{ method: string; params: unknown }> = [];
    yield* Effect.gen(function* () {
      const coordinator = yield* Coordinator.Coordinator;
      yield* coordinator.start;
      yield* TestClock.adjust("5 minutes");
      assert.deepEqual(
        requests.map((request) => request.method),
        ["snapshot"],
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(harness(store, requests, { streamDomainEvents: Stream.empty }, quietServices)),
    );
  }),
);

it.effect("a request that arrives while start reads the store waits for its answer", () =>
  Effect.gen(function* () {
    const answered = yield* Deferred.make<void>();
    let holding = false;
    const store: Store = {
      cards: [],
      assignments: [],
      actions: [],
      signal: (method) =>
        method === "snapshot" && holding ? Deferred.await(answered) : Effect.void,
    };
    yield* Effect.gen(function* () {
      const coordinator = yield* Coordinator.Coordinator;
      holding = true;
      // As the server starts it: listening goes on while start waits for the store.
      yield* Effect.forkScoped(coordinator.start, { startImmediately: true });
      const read = yield* Effect.forkScoped(coordinator.get, { startImmediately: true });
      yield* Deferred.succeed(answered, undefined);
      // Not the placeholder held before the store answered, which says there is no store.
      assert.isTrue((yield* Fiber.join(read)).availability?.available);
    }).pipe(
      Effect.scoped,
      Effect.provide(harness(store, [], { streamDomainEvents: Stream.empty }, quietServices)),
    );
  }),
);

it.effect("while start recovers settled work, reads answer and requests that act wait", () =>
  Effect.gen(function* () {
    const recovered = yield* Deferred.make<void>();
    const store: Store = {
      cards: [],
      assignments: [],
      actions: [],
      configuration: { enabled: true, coordinatorThreadId: "coordinator" },
      signal: (method) =>
        method === "settlements.unfinished" ? Deferred.await(recovered) : Effect.void,
    };
    const requests: Array<{ method: string; params: unknown }> = [];
    yield* Effect.gen(function* () {
      const coordinator = yield* Coordinator.Coordinator;
      yield* Effect.forkScoped(coordinator.start, { startImmediately: true });
      assert.isTrue((yield* coordinator.get).configuration.enabled);
      const pause = yield* Effect.forkScoped(coordinator.command({ type: "pause.all" }), {
        startImmediately: true,
      });
      requests.push({ method: "recovered", params: null });
      yield* Deferred.succeed(recovered, undefined);
      yield* Fiber.join(pause);
      const methods = requests.map((request) => request.method);
      assert.isAbove(methods.indexOf("pause"), methods.indexOf("recovered"));
    }).pipe(
      Effect.scoped,
      Effect.provide(
        harness(
          store,
          requests,
          {
            streamDomainEvents: Stream.empty,
            getThreadRecords: () => Effect.succeed({ runtimeRequests: [] } as never),
          },
          quietServices,
        ),
      ),
    );
  }),
);

it.effect("a change made while a client takes its first snapshot still reaches it", () =>
  Effect.gen(function* () {
    const store: Store = { cards: [], assignments: [], actions: [], pause: { active: false } };
    yield* Effect.gen(function* () {
      const coordinator = yield* Coordinator.Coordinator;
      const sent = yield* Queue.unbounded<CoordinatorSnapshot>();
      const handled = yield* Deferred.make<void>();
      // A client still handling the first snapshot when the change is published.
      yield* coordinator.changes.pipe(
        Stream.runForEach((snapshot) =>
          Queue.offer(sent, snapshot).pipe(
            Effect.andThen(snapshot.pause.active ? Effect.void : Deferred.await(handled)),
          ),
        ),
        Effect.forkScoped,
      );
      assert.isFalse((yield* Queue.take(sent)).pause.active);
      store.pause!.active = true;
      yield* coordinator.command({ type: "pause.all" });
      yield* Deferred.succeed(handled, undefined);
      // Nothing changes after it, so no later publish would bring it.
      assert.isTrue((yield* Queue.take(sent)).pause.active);
    }).pipe(Effect.scoped, Effect.provide(harness(store, [])));
  }),
);

it.effect("switched on in Settings after start, it starts its work without a restart", () =>
  Effect.gen(function* () {
    const store: Store = {
      seen: { enabled: false, coordinatorThreadId: null, paused: true },
      cards: [],
      assignments: [],
      actions: [],
      configuration: { enabled: false, coordinatorThreadId: "coordinator" },
    };
    const requests: Array<{ method: string; params: unknown }> = [];
    yield* Effect.gen(function* () {
      const coordinator = yield* Coordinator.Coordinator;
      yield* coordinator.start;
      assert.deepEqual(requests, []);
      yield* coordinator.command({
        type: "configure",
        configuration: {
          enabled: true,
          coordinatorProvider: "replay",
          coordinatorModel: "model",
          coordinatorProjectId: "project",
        },
      });
      yield* TestClock.adjust("1 minute");
      const methods = requests.map((request) => request.method);
      // Start-up recovery of settled work, then the minute's maintenance.
      assert.include(methods, "settlements.unfinished");
      assert.include(methods, "tick");
      assert.isTrue((yield* coordinator.get).configuration.enabled);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        harness(
          store,
          requests,
          {
            streamDomainEvents: Stream.empty,
            getThreadRecords: () => Effect.succeed({ runtimeRequests: [] } as never),
            getThreadShell: () =>
              Effect.succeed({
                id: "coordinator",
                projectId: "project",
                title: "Conductor",
                modelSelection: { instanceId: "replay", model: "model" },
              } as never),
            dispatch: () => Effect.succeed(undefined as never),
          },
          {
            ...quietServices,
            settings: {
              streamChanges: Stream.empty,
              getSettings: Effect.succeed({ linkedEnvironmentsEnabled: false } as never),
            },
            projects: {
              listShells: () => Effect.succeed([{ id: "project", title: "Project" }] as never),
            },
          },
        ),
      ),
    );
  }),
);

it.effect("each minute's snapshot goes to clients only when it changed", () =>
  Effect.gen(function* () {
    const store: Store = {
      cards: [],
      assignments: [],
      actions: [],
      pause: { active: false },
      configuration: { enabled: true, coordinatorThreadId: "coordinator" },
    };
    yield* Effect.gen(function* () {
      const coordinator = yield* Coordinator.Coordinator;
      yield* coordinator.start;
      const sent = yield* Queue.unbounded<CoordinatorSnapshot>();
      yield* coordinator.changes.pipe(
        Stream.runForEach((snapshot) => Queue.offer(sent, snapshot)),
        Effect.forkScoped,
      );
      yield* Queue.take(sent);
      yield* TestClock.adjust("3 minutes");
      store.pause!.active = true;
      yield* TestClock.adjust("1 minute");
      // The change, once: every read before and after it returned the same snapshot.
      assert.isTrue((yield* Queue.take(sent)).pause.active);
      assert.equal(yield* Queue.size(sent), 0);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        harness(
          store,
          [],
          {
            streamDomainEvents: Stream.empty,
            getThreadRecords: () => Effect.succeed({ runtimeRequests: [] } as never),
          },
          quietServices,
        ),
      ),
    );
  }),
);

it.effect("a provider whose approvals state no operation takes work only on the owner's word", () =>
  Effect.gen(function* () {
    const requests: Array<{ method: string; params: unknown }> = [];
    yield* Effect.gen(function* () {
      yield* (yield* Coordinator.Coordinator).start;
      yield* TestClock.adjust("1 second");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        harness(
          {
            cards: [],
            assignments: [],
            actions: [],
            configuration: { enabled: true, coordinatorThreadId: "coordinator" },
          },
          requests,
          quietThreads,
          {
            ...quietServices,
            providers: {
              streamChanges: Stream.empty,
              getProviders: Effect.succeed(
                ["codex", "claudeAgent", "cursor"].map((driver) => ({
                  instanceId: driver,
                  driver,
                  enabled: true,
                  installed: true,
                  auth: { status: "authenticated" },
                  models: [],
                })) as never,
              ),
            },
          },
        ),
      ),
    );
    assert.deepEqual(
      requests
        .filter((request) => request.method === "catalog.sync")
        .map((request) => request.params as { sourceId: string; automaticEligibility?: boolean })
        .map(({ sourceId, automaticEligibility }) => [sourceId, automaticEligibility]),
      [
        ["codex", undefined],
        ["claudeAgent", undefined],
        ["cursor", false],
      ],
    );
  }),
);

it.effect("on at start, the catalog is built from the providers the server just probed", () =>
  Effect.gen(function* () {
    let probes = 0;
    const store: Store = {
      cards: [],
      assignments: [],
      actions: [],
      configuration: { enabled: true, coordinatorThreadId: "coordinator" },
    };
    yield* Effect.gen(function* () {
      yield* (yield* Coordinator.Coordinator).start;
      yield* TestClock.adjust("1 hour");
      // The server's registry probes as it starts; a second probe then would only repeat it.
      assert.equal(probes, 0);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        harness(
          store,
          [],
          {
            streamDomainEvents: Stream.empty,
            getThreadRecords: () => Effect.succeed({ runtimeRequests: [] } as never),
          },
          {
            ...quietServices,
            providers: {
              streamChanges: Stream.empty,
              getProviders: Effect.succeed([{ instanceId: "replay", models: [] }] as never),
              refresh: () =>
                Effect.sync(() => {
                  probes += 1;
                  return [] as never;
                }),
            },
          },
        ),
      ),
    );
  }),
);

it.effect("a Coordinator enabled while its next snapshot went unanswered resumes", () =>
  Effect.gen(function* () {
    let ticks = 0;
    let snapshotsDown = false;
    const store: Store = {
      cards: [],
      assignments: [],
      actions: [],
      configuration: { enabled: false, coordinatorThreadId: "coordinator" },
      // Once the store has the change, the snapshots after it go unanswered until healed.
      down: (method) => (method === "snapshot" && snapshotsDown ? "unavailable" : undefined),
      signal: (method) =>
        Effect.sync(() => {
          if (method === "configure") snapshotsDown = true;
          if (method === "tick") ticks++;
        }),
    };
    yield* Effect.gen(function* () {
      const coordinator = yield* Coordinator.Coordinator;
      yield* coordinator.start;
      yield* coordinator
        .command({
          type: "configure",
          configuration: {
            enabled: true,
            coordinatorProvider: "replay",
            coordinatorModel: "model",
            coordinatorProjectId: "project",
          },
        })
        .pipe(Effect.flip);
      assert.isFalse((yield* coordinator.get).configuration.enabled);
      snapshotsDown = false;
      yield* TestClock.adjust("1 minute");
      assert.isAtLeast(ticks, 1);
      assert.isTrue((yield* coordinator.get).configuration.enabled);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        harness(
          store,
          [],
          {
            streamDomainEvents: Stream.empty,
            getThreadRecords: () => Effect.succeed({ runtimeRequests: [] } as never),
            getThreadShell: () =>
              Effect.succeed({
                id: "coordinator",
                projectId: "project",
                title: "Conductor",
                modelSelection: { instanceId: "replay", model: "model" },
              } as never),
            dispatch: () => Effect.succeed(undefined as never),
          },
          {
            ...quietServices,
            projects: {
              listShells: () => Effect.succeed([{ id: "project", title: "Project" }] as never),
            },
          },
        ),
      ),
    );
  }),
);

it.effect("an enabled Coordinator resumes when only the first snapshot went unanswered", () =>
  Effect.gen(function* () {
    let ticks = 0;
    let snapshots = 0;
    let snapshotsDown = false;
    const store: Store = {
      cards: [],
      assignments: [],
      actions: [],
      configuration: { enabled: true },
      // The first snapshot at start, and every snapshot while `snapshotsDown` is set.
      down: (method) =>
        method === "snapshot" && (++snapshots === 1 || snapshotsDown) ? "unavailable" : undefined,
      signal: (method) =>
        Effect.sync(() => {
          if (method === "tick") ticks++;
        }),
    };
    yield* recovering(store, completedRun, (coordinator) =>
      Effect.gen(function* () {
        yield* coordinator.start;
        yield* TestClock.adjust("1 minute");
        assert.isAtLeast(ticks, 1);
        assert.isTrue((yield* coordinator.get).configuration.enabled);
        // Snapshots fail for a minute while the snapshot held is enabled, then answer again.
        snapshotsDown = true;
        yield* TestClock.adjust("1 minute");
        snapshotsDown = false;
        const before = ticks;
        yield* TestClock.adjust("1 minute");
        assert.isAbove(ticks, before);
        assert.deepEqual((yield* coordinator.get).availability, { available: true });
      }),
    );
  }),
);

it.effect(
  "a kept worktree goes only as the owner was shown it, for settled work this host made",
  () => {
    const path = "/repo/.t3/worktrees/w";
    const shown = Coordinator.keptSummary(path, ["?? notes.txt"]);
    const note = {
      id: "n",
      summary: shown,
      provenance: Coordinator.keptProvenance(["?? notes.txt"]),
    };
    const store: Store = {
      configuration: { enabled: true },
      cards: [{ ...card("coordinator:done"), assignmentId: "a1" }],
      assignments: [
        {
          ...assignment("a1", "coordinator:done"),
          receipt: { threadId: "coordinator:done", worktree: path },
        },
      ],
      actions: [],
      held: ["?? notes.txt"],
      notes: { "worktree-kept:coordinator:done": note },
    };
    const requests: Array<{ method: string; params: unknown }> = [];
    const removed: Array<unknown> = [];
    const dispatched: Array<unknown> = [];
    const shell = (id: string, settledAt: unknown) => ({
      id,
      projectId: "project",
      settledAt,
      worktreePath: path,
    });
    return Effect.gen(function* () {
      const coordinator = yield* Coordinator.Coordinator;
      const refused = (threadId: string, text = shown) =>
        Effect.exit(coordinator.command({ type: "worktree.remove", threadId, shown: text })).pipe(
          Effect.map(Exit.isFailure),
        );
      // A person's own thread, or work not yet settled, is never the owner's to remove here.
      for (const threadId of ["person", "coordinator:open"])
        assert.isTrue(yield* refused(threadId));
      // Not what the owner was shown: another note, or a file added since.
      assert.isTrue(yield* refused("coordinator:done", "Kept something else."));
      store.held = ["?? notes.txt", "?? added-later.txt"];
      assert.isTrue(yield* refused("coordinator:done"));
      // The note now shows what is there, for the owner to confirm again.
      assert.deepEqual(
        requests
          .filter((request) => request.method === "decisions.record")
          .map((request) => (request.params as { decision: { summary: string } }).decision.summary),
        [Coordinator.keptSummary(path, store.held)],
      );
      requests.length = 0;
      // A change beyond the five files shown still changes the text the owner confirms.
      const many = (last: string) => ["?? 1", "?? 2", "?? 3", "?? 4", "?? 5", last];
      assert.notEqual(
        Coordinator.keptSummary(path, many("?? 6")),
        Coordinator.keptSummary(path, many("?? 7")),
      );
      // The rewritten note is stored: a second click on the text first shown removes nothing,
      // and only the text now shown is confirmed.
      const now = Coordinator.keptSummary(path, store.held);
      store.notes!["worktree-kept:coordinator:done"] = {
        id: "n",
        summary: now,
        provenance: Coordinator.keptProvenance(store.held),
      };
      assert.isTrue(yield* refused("coordinator:done"));
      assert.deepEqual(removed, []);
      requests.length = 0;
      yield* coordinator.command({
        type: "worktree.remove",
        threadId: "coordinator:done",
        shown: now,
      });
      assert.deepEqual(removed, [{ repository: "/repo", path, force: true }]);
      assert.deepInclude(dispatched[0] as object, {
        type: "thread.metadata.update",
        threadId: "coordinator:done",
        worktreePath: null,
      });
      assert.isTrue(
        requests.some(
          (request) =>
            request.method === "decisions.record" &&
            (request.params as { decision: { id: string } }).decision.id ===
              "worktree-kept:coordinator:done",
        ),
      );
      assert.isFalse(requests.some((request) => request.method === "events.append"));
    }).pipe(
      Effect.provide(
        harness(
          store,
          requests,
          {
            getThreadShell: (threadId) =>
              Effect.succeed(
                (threadId === "coordinator:open"
                  ? shell(threadId, null)
                  : shell(threadId, DateTime.makeUnsafe(0))) as never,
              ),
            dispatch: (command) =>
              Effect.sync(() => {
                dispatched.push(command);
                return undefined as never;
              }),
          },
          {
            projects: {
              listShells: () => Effect.succeed([]),
              getById: () => Effect.succeedSome({ workspaceRoot: "/repo" } as never),
            },
            merges: {
              removeWorktree: (input) =>
                Effect.sync(() => {
                  removed.push(input);
                  return [];
                }),
            },
          },
        ),
      ),
    );
  },
);

it.effect("the Coordinator's thread takes back the name set in Settings", () => {
  const store: Store = {
    cards: [],
    assignments: [],
    actions: [],
    configuration: { enabled: true, coordinatorThreadId: "lead", coordinatorTitle: "Lead" },
  };
  const requests: Array<{ method: string; params: unknown }> = [];
  const dispatched: Array<{ type: string; threadId: string; title?: string }> = [];
  return Effect.gen(function* () {
    const coordinator = yield* Coordinator.Coordinator;
    // The first command loads the snapshot that names the thread; the next sync renames it.
    yield* coordinator.command({ type: "thread.reopen", threadId: "other" });
    yield* coordinator.command({ type: "thread.reopen", threadId: "other" });
    assert.deepInclude(
      dispatched.find((command) => command.type === "thread.metadata.update"),
      { threadId: "lead", title: "Lead" },
    );
  }).pipe(
    Effect.provide(
      harness(store, requests, {
        getShellSnapshot: () =>
          Effect.succeed({
            threads: [
              {
                id: "lead",
                projectId: "project",
                title: "Plan the export feature",
                lineage: { rootThreadId: "lead" },
                status: "idle",
                providerInstanceId: "replay",
                modelSelection: { instanceId: "replay", model: "model", options: [] },
                settledOverride: null,
                archivedAt: null,
                pendingRuntimeRequest: null,
                latestUserAuthoredMessageAt: null,
                updatedAt: DateTime.makeUnsafe(0),
              },
            ],
          } as never),
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command as never);
            return undefined as never;
          }),
      }),
    ),
  );
});

it.effect("switched on, its thread is launched read-only, pinned and named, on any instance", () =>
  Effect.gen(function* () {
    const store: Store = { cards: [], assignments: [], actions: [], configuration: {} };
    const requests: Array<{ method: string; params: unknown }> = [];
    const launched: Array<{ runtimeMode: string; title: string; threadId: string }> = [];
    const dispatched: Array<{ type: string; threadId: string }> = [];
    yield* Effect.gen(function* () {
      yield* (yield* Coordinator.Coordinator).command({
        type: "configure",
        configuration: {
          enabled: true,
          coordinatorTitle: "Lead",
          coordinatorProvider: "any",
          coordinatorModel: "model",
          coordinatorProjectId: "project",
        },
      });
    }).pipe(
      Effect.provide(
        harness(
          store,
          requests,
          {
            getThreadShell: () => Effect.succeed(null),
            dispatch: (command) =>
              Effect.sync(() => {
                dispatched.push(command as never);
                return undefined as never;
              }),
          },
          {
            ...quietServices,
            settings: {
              streamChanges: Stream.empty,
              getSettings: Effect.succeed({ linkedEnvironmentsEnabled: false } as never),
            },
            projects: {
              listShells: () => Effect.succeed([{ id: "project", title: "Project" }] as never),
            },
            launch: {
              launch: (input) =>
                Effect.sync(() => {
                  launched.push(input as never);
                  return { threadId: input.threadId } as never;
                }),
            },
          },
        ),
      ),
    );
    assert.lengthOf(launched, 1);
    assert.deepInclude(launched[0], { runtimeMode: "approval-required", title: "Lead" });
    assert.isTrue(launched[0]!.threadId.startsWith("coordinator-lead:"));
    assert.deepInclude(dispatched[0], { type: "thread.pin", threadId: launched[0]!.threadId });
    assert.deepInclude(requests.find((request) => request.method === "configure")?.params, {
      coordinatorThreadId: launched[0]!.threadId,
    });
  }),
);

it.effect("a first turn of its thread that never asked for its status shows it has no tools", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<unknown>();
    // The stream fails once and is subscribed again.
    let subscriptions = 0;
    const run = (threadId: string, status: string, startedAt: unknown = 1) => ({
      type: "run.updated",
      payload: {
        id: `${threadId}:${status}:${String(startedAt)}`,
        threadId,
        status,
        startedAt,
        providerInstanceId: "any",
        modelSelection: { instanceId: "any", model: "model" },
      },
    });
    const store: Store = {
      cards: [],
      assignments: [],
      actions: [],
      configuration: {
        enabled: true,
        coordinatorThreadId: "coordinator-lead:one",
        coordinatorProvider: "any",
        coordinatorModel: "model",
      },
    };
    const requests: Array<{ method: string; params: unknown }> = [];
    yield* Effect.gen(function* () {
      yield* (yield* Coordinator.Coordinator).start;
      // Another thread's turn, or one refused, cancelled or interrupted, shows nothing.
      yield* Queue.offer(events, run("person", "completed"));
      yield* Queue.offer(events, run("coordinator-lead:one", "completed", null));
      yield* Queue.offer(events, run("coordinator-lead:one", "failed"));
      yield* Queue.offer(events, run("coordinator-lead:one", "cancelled"));
      yield* Queue.offer(events, run("coordinator-lead:one", "interrupted"));
      yield* Queue.offer(events, run("coordinator-lead:one", "completed"));
      yield* TestClock.adjust("62 seconds");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        harness(
          store,
          requests,
          {
            streamDomainEvents: Stream.suspend(() =>
              subscriptions++ === 0 ? Stream.fail("lost" as never) : Stream.fromQueue(events),
            ) as never,
            getThreadRecords: () => Effect.succeed({ runtimeRequests: [] } as never),
          },
          {
            ...quietServices,
            projects: { listShells: () => Effect.succeed([]) },
          },
        ),
      ),
    );
    // A completed turn of its thread, a wake's or the owner's, confirms what it read; no other.
    assert.deepEqual(
      requests.filter((request) => request.method === "events.confirm").map(({ params }) => params),
      [
        { runId: "coordinator-lead:one:completed:null" },
        { runId: "coordinator-lead:one:completed:1" },
      ],
    );
    const proofs = requests.filter((request) => request.method === "proof.record");
    assert.deepEqual(
      proofs.map((request) => request.params),
      [
        {
          provider: "any",
          model: "model",
          proved: false,
          reason:
            "Its first turn ended without calling coordinator_status: this instance gave it no T3 tools.",
        },
      ],
    );
  }),
);

// The Coordinator's thread, woken from its inbox.
const shellOf = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  projectId: "project",
  title: `Purpose of ${id}`,
  lineage: { rootThreadId: id },
  providerInstanceId: "replay",
  modelSelection: { model: "model" },
  status: "idle",
  archivedAt: null,
  settledOverride: null,
  pendingRuntimeRequest: null,
  latestUserAuthoredMessageAt: null,
  updatedAt: DateTime.makeUnsafe(0),
  ...extra,
});
const woken = (
  store: Store,
  shells: Array<Record<string, unknown>> = [],
  runStatus: string | (() => string) = "queued",
  extra: Partial<Threads.ThreadManagementService["Service"]> = {},
  interrupted: Array<unknown> = [],
  providerRows: ReadonlyArray<unknown> = [
    { instanceId: "replay", slashCommands: [{ name: "compact" }] },
  ],
) =>
  Effect.sync(() => {
    const sent: Array<{ text: string; mode: string; createdBy: string }> = [];
    const requests: Array<{ method: string; params: unknown }> = [];
    const gitRuns: Array<ReadonlyArray<string>> = [];
    const layer = harness(
      store,
      requests,
      {
        getShellSnapshot: () => Effect.succeed({ threads: shells } as never),
        getThreadShell: (threadId) =>
          Effect.succeed(
            (shells.find((shell) => shell.id === threadId) ??
              shellOf(threadId, { activeRunId: null })) as never,
          ),
        getThreadRecords: () =>
          Effect.succeed({
            runs: [
              { id: "wake-run", status: typeof runStatus === "string" ? runStatus : runStatus() },
            ],
            providerTurns: [],
            runtimeRequests: [],
          } as never),
        sendToThread: (input) =>
          Effect.sync(() => {
            sent.push(input as never);
            return { delivery: "queued", run: { id: "wake-run" } } as never;
          }),
        ...extra,
      },
      {
        runner: {
          run: (input) =>
            Effect.sync(() => {
              gitRuns.push(input.args);
              return { code: 0, stdout: "2\n" } as never;
            }),
        },
        usage: { priceTokens: () => Effect.succeed(null) },
        settings: { getSettings: Effect.succeed({ linkedEnvironmentsEnabled: false } as never) },
        providers: { getProviders: Effect.succeed(providerRows as never) },
        orchestrator: {
          interruptThread: (_scope, input) =>
            Effect.sync(() => {
              interrupted.push(input);
              return {} as never;
            }),
        },
      },
    );
    return { sent, requests, layer, gitRuns };
  });
const awake: Store["configuration"] = {
  enabled: true,
  coordinatorThreadId: "coordinator-lead:one",
  coordinatorProjectId: "project",
  coordinatorProvider: "replay",
  coordinatorModel: "model",
};

it.effect("no wake without a change; one at a time; told only by a turn that completed", () =>
  Effect.gen(function* () {
    const store: Store = { cards: [], assignments: [], actions: [], configuration: awake };
    let status = "queued";
    const { sent, requests, layer } = yield* woken(store, [], () => status);
    const woke = () => requests.filter((request) => request.method === "events.woken");
    yield* Effect.gen(function* () {
      const coordinator = yield* Coordinator.Coordinator;
      yield* coordinator.command({ type: "cycle.run" });
      assert.lengthOf(sent, 0);
      store.pending = { kinds: { assignment: 2 }, through: 7, unread: { assignment: 2 } };
      yield* coordinator.command({ type: "cycle.run" });
      assert.lengthOf(sent, 1);
      // Queued, never a steer, and sent as the host, not as the owner.
      assert.deepInclude(sent[0], { mode: "queue", createdBy: "system" });
      assert.match(sent[0]!.text, /^\[Coordinator wake\] 2 new in your inbox \(assignment 2\)/);
      // Sending tells nothing yet, and the wake's turn holds the next one.
      assert.lengthOf(woke(), 0);
      yield* coordinator.command({ type: "cycle.run" });
      assert.lengthOf(sent, 1);
      // A turn that failed told nothing: the next wake says it again.
      status = "failed";
      yield* coordinator.command({ type: "cycle.run" });
      assert.lengthOf(woke(), 0);
      assert.lengthOf(sent, 2);
      assert.match(sent[1]!.text, /2 new in your inbox \(assignment 2\)/);
      // A turn that completed told it; still unread, the check-in says so, never "nothing new".
      status = "completed";
      yield* coordinator.command({ type: "cycle.run" });
      assert.deepEqual(woke()[0]?.params, { through: 7, runId: "wake-run" });
      assert.lengthOf(sent, 2);
      yield* TestClock.adjust("15 minutes");
      yield* coordinator.command({ type: "cycle.run" });
      assert.lengthOf(sent, 3);
      assert.match(sent[2]!.text, /^\[Coordinator wake\] Check-in: 2 unread in your inbox/);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("a question in a managed thread is an event once; none from its own thread", () =>
  Effect.gen(function* () {
    const store: Store = {
      cards: [card("t1")],
      assignments: [],
      actions: [],
      configuration: { ...awake, manageOtherThreads: true },
    };
    const shell = (id: string, kind: string) =>
      shellOf(id, { pendingRuntimeRequest: { id: `r-${id}`, kind } });
    const { requests, layer } = yield* woken(store, [
      shell("t1", "user_input"),
      shell("coordinator-lead:one", "command"),
    ]);
    yield* Coordinator.Coordinator.pipe(
      Effect.flatMap((coordinator) => coordinator.command({ type: "cycle.run" })),
      Effect.provide(layer),
    );
    assert.deepEqual(
      requests.filter((request) => request.method === "events.append").map((r) => r.params),
      [
        {
          eventId: "request:t1:r-t1",
          actor: "host",
          event: {
            kind: "question",
            threadId: "t1",
            subject: "r-t1",
            summary: "A question waits in thread t1.",
          },
        },
      ],
    );
  }),
);

it.effect("no wake is queued behind a turn of the Coordinator's: it would be read stale", () =>
  Effect.gen(function* () {
    const store: Store = {
      cards: [],
      assignments: [],
      actions: [],
      configuration: { ...awake, coordinatorTitle: "Lead" },
      pending: { kinds: { assignment: 1 }, through: 3, unread: { assignment: 1 } },
    };
    const lead: Record<string, unknown> = shellOf("coordinator-lead:one", {
      title: "Lead",
      activeRunId: "owner-turn",
    });
    const { sent, layer } = yield* woken(store, [lead]);
    yield* Effect.gen(function* () {
      const coordinator = yield* Coordinator.Coordinator;
      yield* coordinator.command({ type: "cycle.run" });
      assert.lengthOf(sent, 0);
      // The turn ended: the wake goes, saying what is true now.
      lead.activeRunId = null;
      store.pending = { kinds: { assignment: 2 }, through: 4, unread: { assignment: 2 } };
      yield* coordinator.command({ type: "cycle.run" });
      assert.lengthOf(sent, 1);
      assert.match(sent[0]!.text, /2 new in your inbox/);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("a request the store refuses is left out of a wake that still goes", () =>
  Effect.gen(function* () {
    const long = `claude:${"r".repeat(334)}`;
    const store: Store = {
      cards: [card("t1")],
      assignments: [
        { ...assignment("a1", "t1"), status: "blocked", receipt: { threadId: "t1", startedAt: 0 } },
      ],
      actions: [],
      configuration: awake,
      refuse: ["events.append"],
    };
    const { sent, requests, layer } = yield* woken(store, [
      shellOf("t1", { pendingRuntimeRequest: { id: long, kind: "command" } }),
    ]);
    yield* Coordinator.Coordinator.pipe(
      Effect.flatMap((coordinator) => coordinator.command({ type: "cycle.run" })),
      Effect.provide(layer),
    );
    const [appended] = requests.filter((request) => request.method === "events.append");
    // The stored id is short whatever the provider's is; the provider's goes along as data.
    assert.deepInclude(appended?.params, {
      eventId: `request:t1:${Coordinator.storedRequestId(long)}`,
    });
    const params = appended?.params as
      | { readonly eventId: string; readonly event: { readonly subject: string } }
      | undefined;
    assert.isAtMost(params?.eventId.length ?? Infinity, 256);
    assert.equal(params?.event.subject, long);
    assert.lengthOf(sent, 1);
  }),
);

it.effect("every unsettled thread is in one digest at least once a check-in interval", () =>
  Effect.gen(function* () {
    const store: Store = {
      cards: [card("t1"), card("t2"), card("t3")],
      assignments: [
        { ...assignment("a1", "t1"), status: "blocked", receipt: { threadId: "t1", startedAt: 0 } },
        { ...assignment("a2", "t2"), status: "cancelled" },
        // Its goal resolved, so the store no longer counts it open, but it is not merged yet.
        { ...assignment("a3", "t3"), status: "verified" },
      ],
      routingWaits: [
        {
          id: "route-1",
          goalId: "g2",
          cardId: "local:t1",
          status: "waiting",
          reason: "at its parallel limit",
          nextAttemptAt: 0,
          attempts: 1,
          revision: 1,
        },
      ],
      actions: [],
      configuration: { ...awake, checkInMinutes: 15 },
    };
    const shells = [shellOf("t1", { worktreePath: "/w/t1" })];
    const { sent, layer, gitRuns } = yield* woken(store, shells, "completed", {
      getThreadShell: () =>
        Effect.succeed({ id: "t1", pendingRuntimeRequest: null, status: "idle" } as never),
    });
    yield* Effect.gen(function* () {
      const coordinator = yield* Coordinator.Coordinator;
      yield* coordinator.command({ type: "cycle.run" });
      // With nothing due, no digest is built: no second git read.
      yield* coordinator.command({ type: "cycle.run" });
      assert.lengthOf(sent, 1);
      assert.lengthOf(gitRuns, 1);
      // Read as the workspace reads an untrusted repository.
      assert.deepEqual(gitRuns[0]!.slice(0, 2), ["-c", "core.fsmonitor=false"]);
      assert.include(sent[0]!.text, "Check-in: nothing new");
      assert.include(sent[0]!.text, '- t1 "Purpose of t1" · waiting: owner');
      assert.include(sent[0]!.text, "2 commits");
      // Cancelled work settled at once.
      assert.notInclude(sent[0]!.text, "t2");
      assert.include(sent[0]!.text, '- t3 "Purpose of t3" · waiting: merge');
      assert.include(sent[0]!.text, 'goal g2 · waiting: route "at its parallel limit"');
      yield* TestClock.adjust("15 minutes");
      yield* coordinator.command({ type: "cycle.run" });
      assert.lengthOf(sent, 2);
    }).pipe(Effect.provide(layer));
  }),
);

// The Coordinator's own turn, its last item updated `lastAt` after it started, seen at `seenAt`.
const supervised = (lastAt: number, seenAt: string, shell: Record<string, unknown> = {}) =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    const store: Store = { cards: [], assignments: [], actions: [], configuration: awake };
    const interrupted: Array<unknown> = [];
    const turn = shellOf("coordinator-lead:one", {
      activeRunId: "turn",
      activityRunStartedAt: DateTime.makeUnsafe(startedAt),
      ...shell,
    });
    const { sent, layer } = yield* woken(
      store,
      [turn],
      "running",
      {
        getThreadRecords: (_threadId, fields) =>
          Effect.succeed(
            ((fields as ReadonlyArray<string>).includes("turnItems")
              ? { turnItems: [{ updatedAt: DateTime.makeUnsafe(startedAt + lastAt) }] }
              : { runs: [], runtimeRequests: [], providerTurns: [] }) as never,
          ),
      },
      interrupted,
    );
    yield* Effect.gen(function* () {
      yield* TestClock.adjust(seenAt as never);
      yield* (yield* Coordinator.Coordinator).command({ type: "cycle.run" });
    }).pipe(Effect.provide(layer));
    return { interrupted, sent };
  });

it.effect("a turn is stopped only after a whole check-in interval with nothing in it", () =>
  Effect.gen(function* () {
    const stalled = yield* supervised(60_000, "17 minutes");
    assert.lengthOf(stalled.interrupted, 1);
    assert.include(stalled.sent[0]!.text, "nothing happened in it for 16 minutes");
    // A long, hard turn that keeps working runs on, however long.
    const busy = yield* supervised(179 * 60_000, "180 minutes");
    assert.lengthOf(busy.interrupted, 0);
  }),
);

it.effect("a turn waiting for the owner or for other work is never stopped", () =>
  Effect.gen(function* () {
    for (const shell of [
      { pendingRuntimeRequest: { id: "r", kind: "user_input" } },
      { blockedOnThreadWait: true },
      { pendingBackgroundTasks: [{ id: "task" }] },
    ]) {
      const { interrupted } = yield* supervised(0, "120 minutes", shell);
      assert.lengthOf(interrupted, 0);
    }
  }),
);

// The Coordinator's thread between turns, its token readings so far in order, out of 100.
const compacting = (readings: () => ReadonlyArray<number>, providerRows?: ReadonlyArray<unknown>) =>
  Effect.gen(function* () {
    const store: Store = { cards: [], assignments: [], actions: [], configuration: awake };
    const { sent, layer } = yield* woken(
      store,
      [],
      "running",
      {
        getThreadRecords: () =>
          Effect.succeed({
            runs: [],
            runtimeRequests: [],
            providerTurns: readings().map((used, ordinal) => ({
              ordinal,
              tokenUsage: { usedTokens: used, maxTokens: 100, updatedAt: `reading-${ordinal}` },
            })),
          } as never),
      },
      [],
      providerRows,
    );
    return { sent, layer };
  });

it.effect("between turns, a context is compacted when less room is left than a turn takes", () =>
  Effect.gen(function* () {
    let readings = [10, 40, 90];
    const { sent, layer } = yield* compacting(() => readings);
    yield* Effect.gen(function* () {
      const coordinator = yield* Coordinator.Coordinator;
      // A turn has taken 50; 10 is left.
      yield* coordinator.command({ type: "cycle.run" });
      yield* coordinator.command({ type: "cycle.run" });
      assert.deepEqual(
        sent.map((message) => message.text),
        ["/compact"],
      );
      // The compaction did not lower it: nothing more until another turn changes the reading.
      readings = [10, 40, 90, 92];
      yield* coordinator.command({ type: "cycle.run" });
      yield* coordinator.command({ type: "cycle.run" });
      assert.lengthOf(sent, 1);
      readings = [10, 40, 90, 92, 93];
      yield* coordinator.command({ type: "cycle.run" });
      assert.lengthOf(sent, 2);
    }).pipe(Effect.provide(layer));
    // Room for the largest turn so far: no compaction, however full.
    const roomy = yield* compacting(() => [70, 75, 80]);
    yield* Coordinator.Coordinator.pipe(
      Effect.flatMap((coordinator) => coordinator.command({ type: "cycle.run" })),
      Effect.provide(roomy.layer),
    );
    assert.lengthOf(roomy.sent, 0);
    // A provider without /compact is never sent it.
    const other = yield* compacting(
      () => [10, 40, 90],
      [{ instanceId: "replay", slashCommands: [] }],
    );
    yield* Coordinator.Coordinator.pipe(
      Effect.flatMap((coordinator) => coordinator.command({ type: "cycle.run" })),
      Effect.provide(other.layer),
    );
    assert.lengthOf(other.sent, 0);
  }),
);

it.effect("a wake whose send failed is sent again under the same id", () =>
  Effect.gen(function* () {
    const store: Store = {
      cards: [],
      assignments: [],
      actions: [],
      configuration: awake,
      pending: { kinds: { assignment: 1 }, through: 3 },
    };
    const commands: Array<string> = [];
    const { layer } = yield* woken(store, [], "queued", {
      sendToThread: (input) =>
        Effect.suspend(() => {
          commands.push(input.commandId);
          return commands.length === 1
            ? Effect.fail({ _tag: "ThreadManagementProjectionLoadError" } as never)
            : Effect.succeed({ delivery: "queued", run: { id: "wake-run" } } as never);
        }),
    });
    yield* Effect.gen(function* () {
      const coordinator = yield* Coordinator.Coordinator;
      yield* coordinator.command({ type: "cycle.run" });
      yield* coordinator.command({ type: "cycle.run" });
      yield* coordinator.command({ type: "cycle.run" });
    }).pipe(Effect.provide(layer));
    assert.lengthOf(commands, 2);
    assert.equal(commands[1], commands[0]);
  }),
);

it.effect("the Coordinator's own thread is declined every command, edit and permission", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<unknown>();
    const asks = (threadId: string, id: string, kind: string) => ({
      type: "runtime-request.updated",
      threadId,
      payload: { id, kind, status: "pending" },
    });
    const store: Store = {
      cards: [],
      assignments: [],
      actions: [],
      configuration: { enabled: true, coordinatorThreadId: "coordinator-lead:one" },
    };
    const dispatched: Array<Record<string, unknown>> = [];
    yield* Effect.gen(function* () {
      yield* (yield* Coordinator.Coordinator).start;
      for (const [threadId, id, kind] of [
        ["coordinator-lead:one", "command", "command"],
        ["coordinator-lead:one", "edit", "file-change"],
        ["coordinator-lead:one", "network", "permission"],
        // Reading and questions stay with the owner; a person's thread is untouched.
        ["coordinator-lead:one", "read", "file-read"],
        ["coordinator-lead:one", "question", "user_input"],
        ["person", "theirs", "command"],
      ] as const)
        yield* Queue.offer(events, asks(threadId, id, kind));
      yield* TestClock.adjust("2 seconds");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        harness(
          store,
          [],
          {
            streamDomainEvents: Stream.fromQueue(events) as never,
            getThreadRecords: () => Effect.succeed({ runtimeRequests: [] } as never),
            dispatch: (command) =>
              Effect.sync(() => {
                dispatched.push(command as never);
                return undefined as never;
              }),
          },
          { ...quietServices, projects: { listShells: () => Effect.succeed([]) } },
        ),
      ),
    );
    assert.deepEqual(
      dispatched
        .filter((command) => command.type === "runtime-request.respond")
        .map((command) => [command.requestId, command.decision]),
      [
        ["command", "decline"],
        ["edit", "decline"],
        ["network", "decline"],
      ],
    );
  }),
);

it.effect("a new instance or model chosen in Settings moves the Coordinator's thread to it", () =>
  Effect.gen(function* () {
    const store: Store = {
      cards: [],
      assignments: [],
      actions: [],
      configuration: {
        enabled: true,
        coordinatorProvider: "old",
        coordinatorModel: "model",
        coordinatorProjectId: "project",
        coordinatorThreadId: "coordinator-lead:one",
      },
    };
    const dispatched: Array<Record<string, unknown>> = [];
    const configure = (configuration: Record<string, unknown>) =>
      Effect.gen(function* () {
        return yield* (yield* Coordinator.Coordinator)
          .command({ type: "configure", configuration })
          .pipe(Effect.flip);
      });
    yield* Effect.gen(function* () {
      const coordinator = yield* Coordinator.Coordinator;
      yield* coordinator.command({
        type: "configure",
        configuration: { coordinatorProvider: "new", coordinatorModel: "other" },
      });
      // No instance chosen: a plain refusal, nothing launched.
      store.configuration!.coordinatorProvider = null;
      const refused = yield* configure({ enabled: true });
      assert.include(refused.message, "Choose a provider and a model");
    }).pipe(
      Effect.provide(
        harness(
          store,
          [],
          {
            getThreadShell: () =>
              Effect.succeed({
                id: "coordinator-lead:one",
                projectId: "project",
                title: "Lead",
                modelSelection: { instanceId: "old", model: "model" },
              } as never),
            dispatch: (command) =>
              Effect.sync(() => {
                dispatched.push(command as never);
                return undefined as never;
              }),
          },
          {
            ...quietServices,
            settings: {
              streamChanges: Stream.empty,
              getSettings: Effect.succeed({ linkedEnvironmentsEnabled: false } as never),
            },
            projects: {
              listShells: () => Effect.succeed([{ id: "project", title: "Project" }] as never),
            },
          },
        ),
      ),
    );
    assert.deepInclude(dispatched[0], {
      type: "thread.model-selection.set",
      threadId: "coordinator-lead:one",
      modelSelection: { instanceId: "new", model: "other", options: [] },
    });
  }),
);

it.effect("the owner releases or discards work its result check held", () => {
  const store: Store = { cards: [], assignments: [], actions: [] };
  const requests: Array<{ method: string; params: unknown }> = [];
  return Effect.gen(function* () {
    const coordinator = yield* Coordinator.Coordinator;
    yield* coordinator.command({ type: "result.accept", assignmentId: "work", head: "h" });
    yield* coordinator.command({ type: "result.discard", assignmentId: "other" });
    assert.deepEqual(
      requests
        .filter((request) => request.method.startsWith("results."))
        .map((request) => [request.method, request.params]),
      [
        ["results.accept", { assignmentId: "work", head: "h", actor: "user" }],
        ["results.discard", { assignmentId: "other", actor: "user" }],
      ],
    );
  }).pipe(Effect.provide(harness(store, requests)));
});

it.effect("permissions read only threads with a pending request or one held for them", () => {
  const store: Store = {
    cards: [card("quiet"), card("asking"), card("answered")],
    assignments: [],
    actions: [],
    // Registered earlier and since answered in its thread: it is read to tell the store.
    permissionRequests: [{ id: "local:r0", cardId: "local:answered", threadId: "answered" }],
  };
  const read: Array<string> = [];
  return Effect.gen(function* () {
    const coordinator = yield* Coordinator.Coordinator;
    yield* coordinator.command({ type: "cycle.run" });
    assert.deepEqual([...new Set(read)].toSorted(), ["answered", "asking"]);
  }).pipe(
    Effect.provide(
      harness(store, [], {
        getShellSnapshot: () =>
          Effect.succeed({
            threads: [
              shellOf("quiet"),
              shellOf("asking", { pendingRuntimeRequest: { id: "r1", kind: "command" } }),
              shellOf("answered"),
            ],
          } as never),
        getThreadRecords: (threadId, fields) =>
          Effect.sync(() => {
            if (fields.some((field) => field === "runtimeRequests")) read.push(threadId);
            return { thread: { runtimeMode: "approval-required" }, runtimeRequests: [] } as never;
          }),
      }),
    ),
  );
});

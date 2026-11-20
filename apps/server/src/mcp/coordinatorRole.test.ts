import { expect, it } from "@effect/vitest";
import {
  CoordinatorError,
  EnvironmentId,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";

import * as CoordinatorRole from "../coordinator/CoordinatorRole.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";

const coordinatorThreadId = ThreadId.make("thread:coordinator");
const managedThreadId = ThreadId.make("thread:managed");
const autoThreadId = ThreadId.make("thread:auto");
const outsideThreadId = ThreadId.make("thread:outside");
const personsThreadId = ThreadId.make("thread:persons");
const wroteAt = DateTime.makeUnsafe("2026-01-02T00:00:00.000Z");

const shells = new Map([
  [coordinatorThreadId, liveThreadShell(coordinatorThreadId, { runtimeMode: "approval-required" })],
  [
    managedThreadId,
    {
      ...liveThreadShell(managedThreadId, { runtimeMode: "auto-accept-edits" }),
      latestUserAuthoredMessageAt: wroteAt,
    },
  ],
  [autoThreadId, liveThreadShell(autoThreadId, { runtimeMode: "auto" })],
  [personsThreadId, liveThreadShell(personsThreadId, { runtimeMode: "auto-accept-edits" })],
  [
    outsideThreadId,
    {
      ...liveThreadShell(outsideThreadId, { runtimeMode: "auto-accept-edits" }),
      projectId: ProjectId.make("project:other"),
    },
  ],
]);

const scope = (
  threadId: ThreadId,
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: `provider:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `provider:${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(capabilities),
  issuedAt: 0,
});
const coordinator = scope(coordinatorThreadId, ["orchestration", "coordinator"]);
const ordinary = scope(coordinatorThreadId, ["orchestration"]);

const state = (
  overrides: Partial<CoordinatorRole.CoordinatorRoleState> = {},
): CoordinatorRole.CoordinatorRoleState => ({
  enabled: true,
  coordinatorThreadId,
  paused: false,
  ceiling: "auto-accept-edits",
  scope: new Set([managedThreadId, autoThreadId, personsThreadId]),
  manageOthers: false,
  ...overrides,
});

const local = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  action: Schema.optional(Schema.String),
});
const probe = {
  parameters: local,
  success: Schema.Struct({ ran: Schema.String }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
  ],
};
const linked = {
  ...probe,
  parameters: local.mapFields((fields) => ({
    ...fields,
    environmentId: OrchestratorMcpEnvironmentTarget,
  })),
};
const RoleToolkit = Toolkit.make(
  Tool.make("writes_threads", linked),
  Tool.make("acts_as_coordinator", probe).annotate(
    McpSchema.EnabledWhen,
    McpInvocationContext.hiddenFromOutsideClients,
  ),
  Tool.make("delegate_task", probe).annotate(
    McpSchema.EnabledWhen,
    McpInvocationContext.hiddenFromOutsideClients,
  ),
  Tool.make("t3_thread_organize", linked),
  Tool.make("t3_pending_request", probe),
  Tool.make("t3_worktree_handoff", probe).annotate(
    McpSchema.EnabledWhen,
    McpInvocationContext.hiddenFromOutsideClients,
  ),
  Tool.make("writes", probe),
  Tool.make("acts_as_caller", probe).annotate(
    McpSchema.EnabledWhen,
    McpInvocationContext.hiddenFromOutsideClients,
  ),
);
const ran = () => Effect.succeed({ ran: "ran" });

const started = new Set<string>([managedThreadId, autoThreadId, outsideThreadId]);
const server = (
  role: CoordinatorRole.CoordinatorRoleState | "unreadable" | undefined,
  lastRead = 0,
  threads = shells,
) =>
  McpHttpServer.toolkitRegistration(
    RoleToolkit,
    McpToolAccess.toLayer(RoleToolkit, {
      writes_threads: McpToolAccess.writesThreads((input) => [input.threadId], ran),
      acts_as_coordinator: McpToolAccess.actsAsCoordinator((input) => [input.threadId], ran),
      delegate_task: McpToolAccess.actsAsCaller(ran),
      t3_thread_organize: McpToolAccess.writesThreads((input) => [input.threadId], ran),
      t3_pending_request: McpToolAccess.reads(ran),
      t3_worktree_handoff: McpToolAccess.actsAsCaller(ran),
      writes: McpToolAccess.writes(ran),
      acts_as_caller: McpToolAccess.actsAsCaller(ran),
    }),
  ).pipe(
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provideMerge(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) => Effect.succeed(threads.get(threadId) ?? null),
      }),
    ),
    Layer.provide(
      role === undefined
        ? Layer.empty
        : Layer.mock(CoordinatorRole.CoordinatorRole)({
            state:
              role === "unreadable"
                ? Effect.fail(new CoordinatorError({ operation: "role", reason: "unavailable" }))
                : Effect.succeed(role),
            lastRead: () => Effect.succeed(lastRead),
            started: (threadId) => Effect.succeed(started.has(threadId)),
          }),
    ),
    Layer.provide(
      Layer.mock(PeerForwarding.PeerForwarding)({
        call: () => Effect.succeed({ ran: "elsewhere" } as never),
      }),
    ),
  );

const decodeOutcome = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Union([Schema.Struct({ ran: Schema.String }), Schema.Struct({ code: Schema.String })]),
  ),
);
const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const call = (tool: string, caller: McpInvocationContext.McpInvocationScope, args: object) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((mcp) => mcp.callTool({ name: tool, arguments: args })),
    Effect.flatMap(({ content }) =>
      decodeOutcome(content.map((part) => (part.type === "text" ? part.text : "")).join("")),
    ),
    Effect.map((outcome) => ("code" in outcome ? outcome.code : outcome.ran)),
    Effect.provideService(McpInvocationContext.McpInvocationContext, caller),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
  );

const read = DateTime.toEpochMillis(wroteAt);
const fullAccessCoordinator = new Map(shells).set(
  coordinatorThreadId,
  liveThreadShell(coordinatorThreadId, { runtimeMode: "full-access" }),
);

const formerly = state({ coordinatorThreadId: "thread:other" });

it.effect.each([
  // Each thread-changing declaration holds the role to its checks.
  ...(["writes_threads", "acts_as_coordinator"] as const).flatMap(
    (tool) =>
      [
        [tool, coordinator, state(), read, { threadId: managedThreadId }, "ran"],
        [
          tool,
          coordinator,
          state({ paused: true }),
          read,
          { threadId: managedThreadId },
          "coordinator_paused",
        ],
        [tool, coordinator, state(), read, { threadId: outsideThreadId }, "outside_grant"],
        [
          tool,
          coordinator,
          state(),
          read - 1,
          { threadId: managedThreadId },
          "unread_user_message",
        ],
        [
          tool,
          coordinator,
          state(),
          0,
          { threadId: autoThreadId },
          "runtime_mode_escalation_denied",
        ],
        [tool, coordinator, state({ ceiling: "auto" }), 0, { threadId: autoThreadId }, "ran"],
      ] as const,
  ),
  // Goals, scopes and reads are this environment's.
  [
    "writes_threads",
    coordinator,
    state(),
    read,
    { environmentId: "environment-box", threadId: managedThreadId },
    "refused_for_coordinator",
  ],
  // A thread it did not start, by the owner's setting.
  ...(["writes_threads", "acts_as_coordinator"] as const).flatMap(
    (tool) =>
      [
        [tool, coordinator, state(), 0, { threadId: personsThreadId }, "refused_for_coordinator"],
        [tool, coordinator, state({ manageOthers: true }), 0, { threadId: personsThreadId }, "ran"],
      ] as const,
  ),
  // Its own thread needs no scope or read.
  ["acts_as_coordinator", coordinator, state(), 0, {}, "ran"],
  ["acts_as_coordinator", coordinator, state({ paused: true }), 0, {}, "coordinator_paused"],
  ["acts_as_coordinator", ordinary, state(), 0, {}, "capability_denied"],
  // An ordinary thread keeps its own mode as its limit and no role checks.
  [
    "writes_threads",
    ordinary,
    state({ paused: true }),
    0,
    { threadId: outsideThreadId },
    "runtime_mode_escalation_denied",
  ],

  ["delegate_task", coordinator, state(), 0, {}, "refused_for_coordinator"],
  ["delegate_task", ordinary, state(), 0, {}, "ran"],
  [
    "t3_thread_organize",
    coordinator,
    state(),
    read,
    { threadId: managedThreadId, action: "settle" },
    "refused_for_coordinator",
  ],
  [
    "t3_thread_organize",
    coordinator,
    state(),
    read,
    { threadId: managedThreadId, action: "pin" },
    "ran",
  ],
  ["t3_pending_request", coordinator, state(), 0, { action: "respond" }, "refused_for_coordinator"],
  ["t3_pending_request", coordinator, state(), 0, { action: "list" }, "ran"],
  ["t3_worktree_handoff", coordinator, state(), 0, {}, "refused_for_coordinator"],
  ["t3_worktree_handoff", ordinary, state(), 0, {}, "ran"],
  // A former Coordinator thread is an ordinary one at once, whatever its session still carries.
  [
    "acts_as_coordinator",
    coordinator,
    formerly,
    read,
    { threadId: managedThreadId },
    "capability_denied",
  ],
  [
    "writes_threads",
    coordinator,
    formerly,
    read,
    { threadId: managedThreadId },
    "runtime_mode_escalation_denied",
  ],
  ["delegate_task", coordinator, formerly, 0, {}, "ran"],
  [
    "writes_threads",
    coordinator,
    formerly,
    0,
    { environmentId: "environment-box", threadId: managedThreadId },
    "elsewhere",
  ],
  // An unreadable store keeps the role's refusals rather than freeing the thread.
  [
    "writes_threads",
    coordinator,
    "unreadable",
    read,
    { threadId: managedThreadId },
    "orchestration_error",
  ],
  ["delegate_task", coordinator, "unreadable", 0, {}, "refused_for_coordinator"],
  // Schedules, uploads and secrets pass the role's gate too.
  ["writes", coordinator, state(), 0, {}, "ran"],
  ["writes", coordinator, state({ paused: true }), 0, {}, "coordinator_paused"],
  ["acts_as_caller", coordinator, state({ paused: true }), 0, {}, "coordinator_paused"],
  ["writes", ordinary, state({ paused: true }), 0, {}, "ran"],
] as const)("%s from %#: %s", ([tool, caller, role, lastRead, args, expected]) =>
  call(tool, caller, args).pipe(
    Effect.map((outcome) => expect(outcome).toBe(expected)),
    Effect.provide(server(role, lastRead)),
  ),
);

it.effect("refuses the role while its own thread runs above approval-required", () =>
  call("acts_as_coordinator", coordinator, {}).pipe(
    Effect.map((outcome) => expect(outcome).toBe("refused_for_coordinator")),
    Effect.provide(server(state(), 0, fullAccessCoordinator)),
  ),
);

// The owner's ruling: a thread a person drives behaves the same whether the Coordinator is on or off.
it.effect("leaves an ordinary thread's tools and modes as they are, Coordinator on or off", () =>
  Effect.gen(function* () {
    const calls = [
      ["writes_threads", { threadId: managedThreadId }],
      ["writes_threads", { threadId: outsideThreadId }],
      ["writes_threads", { environmentId: "environment-box", threadId: managedThreadId }],
      ["delegate_task", {}],
      ["t3_thread_organize", { threadId: managedThreadId, action: "settle" }],
      ["t3_pending_request", { action: "respond" }],
    ] as const;
    const outcomes = (role: CoordinatorRole.CoordinatorRoleState | undefined) =>
      Effect.forEach(calls, ([tool, args]) =>
        call(tool, ordinary, args).pipe(Effect.provide(server(role))),
      );
    const without = yield* outcomes(undefined);
    expect(without).toEqual([
      "runtime_mode_escalation_denied",
      "runtime_mode_escalation_denied",
      "elsewhere",
      "ran",
      "runtime_mode_escalation_denied",
      "ran",
    ]);
    for (const role of [state(), state({ enabled: false, paused: true }), state({ paused: true })])
      expect(yield* outcomes(role)).toEqual(without);
  }),
);

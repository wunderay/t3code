import { expect, it } from "@effect/vitest";
import {
  CoordinatorError,
  EnvironmentId,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";

import * as Coordinator from "../../../coordinator/Coordinator.ts";
import * as CoordinatorRole from "../../../coordinator/CoordinatorRole.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as CoordinatorHandlers from "./handlers.ts";
import { CoordinatorToolkit } from "./tools.ts";

const decodeJsonText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const threadId = ThreadId.make("thread:coordinator");
const shell = liveThreadShell(threadId, { runtimeMode: "approval-required" });
const managedThreadId = ThreadId.make("thread:managed");
const managed = liveThreadShell(managedThreadId, { runtimeMode: "approval-required" });
const otherThreadId = ThreadId.make("thread:other");
const other = liveThreadShell(otherThreadId, { runtimeMode: "approval-required" });
const shellOf = (id: ThreadId) =>
  id === managedThreadId ? managed : id === otherThreadId ? other : shell;
// An approval waiting in the managed thread, which an answer must never reach.
const approval = {
  id: RuntimeRequestId.make("request:approval"),
  kind: "command_approval",
  status: "pending",
};

const coordinator: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "provider:coordinator",
  thread: {
    threadId,
    providerSessionId: "provider:coordinator",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration", "coordinator"]),
  issuedAt: 0,
};

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

const call = (
  name: string,
  args: object,
  service: Partial<Coordinator.Coordinator["Service"]> = {},
) =>
  Effect.gen(function* () {
    const recorded = yield* Ref.make<ReadonlyArray<string>>([]);
    const registration = McpHttpServer.toolkitRegistration(
      CoordinatorToolkit,
      CoordinatorHandlers.layer,
    ).pipe(
      Layer.provide(
        Layer.mock(CoordinatorRole.CoordinatorRole)({
          state: Effect.succeed({
            enabled: true,
            coordinatorThreadId: threadId,
            paused: false,
            ceiling: "auto-accept-edits",
            scope: new Set([managedThreadId]),
            manageOthers: false,
          }),
          started: () => Effect.succeed(true),
          lastRead: () => Effect.succeed(0),
          record: (decision) => Ref.update(recorded, (all) => [...all, decision.id]),
        }),
      ),
      Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
      Layer.provideMerge(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (id) => Effect.succeed(shellOf(id)),
          getProjectThreadRecords: ({ threadId: id }) =>
            Effect.succeed({
              ...idleThreadProjection(shellOf(id)),
              runtimeRequests: [approval],
            } as never),
        }),
      ),
      Layer.provideMerge(NodeCrypto.layer),
      Layer.provideMerge(Layer.mock(Coordinator.Coordinator)(service)),
    );
    const result = yield* McpServer.McpServer.pipe(
      Effect.flatMap((server) => server.callTool({ name, arguments: args })),
      Effect.provideService(McpInvocationContext.McpInvocationContext, coordinator),
      Effect.provideService(McpSchema.McpServerClient, mcpClient),
      Effect.provide(registration),
      Effect.scoped,
    );
    return {
      result: decodeJsonText(
        result.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
      ),
      recorded: yield* Ref.get(recorded),
    };
  });

it.effect.each([
  // Questions in its own thread are the owner's.
  [
    "an answer in its own thread",
    "coordinator_answer",
    { threadId, requestId: "request:question", answers: { a: "yes" } },
    "refused_for_coordinator",
  ],
  [
    "an answer to an approval",
    "coordinator_answer",
    { threadId: managedThreadId, requestId: approval.id, answers: { a: "yes" } },
    "invalid_request",
  ],
] as const)("refuses %s and records nothing", ([, name, args, code]) =>
  call(name, args).pipe(
    Effect.map((outcome) => {
      expect(outcome.result).toMatchObject({ code });
      expect(outcome.recorded).toEqual([]);
    }),
  ),
);

it.effect("a delegation the host holds comes back with why it waits", () =>
  Effect.gen(function* () {
    const input = {
      goalId: "goal",
      parentThreadId: threadId,
      task: "Build it.",
      title: "Build",
      target: {},
    };
    const delegated = (after: object) =>
      call("coordinator_delegate", input, {
        delegate: () => Effect.succeed({ goals: [], ...after } as never),
      }).pipe(Effect.map((outcome) => outcome.result));
    const wait = { goalId: "goal", reason: "Waiting: Goal dependency is not complete" };
    expect(yield* delegated({ routingWaits: [{ ...wait, goalId: "other" }, wait] })).toEqual({
      goalId: "goal",
      assignmentIds: [],
      waiting: "Waiting: Goal dependency is not complete",
    });
    const unscoped = yield* delegated({ goals: [{ id: "goal", authorizedScope: [] }] });
    expect(unscoped).toMatchObject({ assignmentIds: [] });
    expect((unscoped as { waiting: string }).waiting).toContain("has not scoped this goal");
    // Started: nothing waits.
    expect(
      yield* delegated({ goals: [{ id: "goal", authorizedScope: ["p"], assignmentIds: ["a"] }] }),
    ).toEqual({ goalId: "goal", assignmentIds: ["a"] });
  }),
);

const grant = {
  id: "grant",
  scope: { kind: "project" as const, id: "project:a" },
  folders: ["src"],
};

it.effect("a grant the owner's words do not cover comes back as their proposal", () =>
  Effect.gen(function* () {
    const asked: Array<unknown> = [];
    const service = {
      grantFromMessage: (input: unknown) =>
        Effect.sync(() => {
          asked.push(input);
          return {
            snapshot: {} as never,
            ...(asked.length > 1 ? { proposal: { grant, reason: "Not named" } } : {}),
          };
        }),
    };
    // The levels are numbers: the model is told what each one gives.
    expect(CoordinatorToolkit.tools.coordinator_grant.description).toContain(
      "`maxAccess`: 0 read only, 1 edit and run commands in its worktree, 2 everything",
    );
    const made = yield* call("coordinator_grant", { ownerMessageId: "owner", grant }, service);
    expect(made.result).toEqual({ granted: true });
    const proposed = yield* call("coordinator_grant", { ownerMessageId: "owner", grant }, service);
    expect(proposed.result).toEqual({
      granted: false,
      proposal: { grant, reason: "Not named" },
    });
    expect(asked).toEqual([
      { messageId: "owner", grant },
      { messageId: "owner", grant },
    ]);
  }),
);

it.effect("the Coordinator answers an approval only in a thread it may change", () =>
  Effect.gen(function* () {
    const answered: Array<unknown> = [];
    const service = {
      answerApproval: (input: unknown) =>
        Effect.sync(() => {
          answered.push(input);
          return {} as never;
        }),
    };
    const answer = { requestId: "request:approval", decision: "owner" };
    const own = yield* call("coordinator_approval", { ...answer, threadId }, service);
    expect(own.result).toMatchObject({ code: "refused_for_coordinator" });
    const outside = yield* call(
      "coordinator_approval",
      { ...answer, threadId: otherThreadId },
      service,
    );
    expect(outside.result).toMatchObject({ code: "outside_grant" });
    const managedAnswer = yield* call(
      "coordinator_approval",
      { ...answer, threadId: managedThreadId },
      service,
    );
    expect(managedAnswer.result).toEqual({ answered: true });
    expect(answered).toEqual([{ ...answer, threadId: managedThreadId }]);
  }),
);

it.effect("an approval the store keeps for the owner is refused", () =>
  call(
    "coordinator_approval",
    { threadId: managedThreadId, requestId: "request:approval", decision: "allow" },
    {
      answerApproval: () =>
        Effect.fail(new CoordinatorError({ operation: "permission", reason: "policy" })),
    },
  ).pipe(Effect.map(({ result }) => expect(result).toMatchObject({ code: "invalid_request" }))),
);

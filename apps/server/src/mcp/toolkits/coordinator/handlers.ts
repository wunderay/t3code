import {
  CoordinatorError,
  type CoordinatorDeliverableRead,
  OrchestratorMcpFailure,
  ProviderUserInputAnswers,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Coordinator from "../../../coordinator/Coordinator.ts";
import * as CoordinatorRole from "../../../coordinator/CoordinatorRole.ts";
import { COORDINATOR_PLAYBOOK } from "../../../coordinator/playbook.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as CoordinatorRoleAccess from "../../coordinatorRole.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { dispatchFailure, newCommandId } from "../../threadAccess.ts";
import { readQuestion } from "../thread/handlers.ts";
import { CoordinatorToolkit } from "./tools.ts";

const encodeAnswers = Schema.encodeEffect(Schema.fromJsonString(ProviderUserInputAnswers));

const failed = (cause: CoordinatorError) =>
  new OrchestratorMcpFailure({
    code: cause.reason === "unavailable" ? "orchestration_error" : "invalid_request",
    message: cause.message,
  });

const storeMissing = new OrchestratorMcpFailure({
  code: "orchestration_error",
  message: "The Coordinator's store is not running here.",
});

/** The Coordinator's turn running this call, so what it reads counts only once it completed. */
const currentTurn = Effect.gen(function* () {
  const threadId = (yield* McpInvocationContext.McpInvocationContext).thread?.threadId;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  if (!threadId) return undefined;
  const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
  const runId = shell?.activeRunId ?? shell?.latestRunId;
  if (!runId) return undefined;
  return {
    runId,
    completed: (earlier: string) =>
      threads.getThreadRecords(threadId, ["runs"], { runIds: [RunId.make(earlier)] }).pipe(
        Effect.map(({ runs }) => runs[0]?.status === "completed"),
        Effect.orElseSucceed(() => false),
      ),
  };
});

// Live, so a thread the store no longer names is refused at once.
const requireRole = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap(CoordinatorRoleAccess.liveRole),
  Effect.flatMap((live) =>
    live
      ? Effect.void
      : Effect.fail(
          new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "Only the Coordinator's thread can use this tool.",
          }),
        ),
  ),
);

export const layer = McpToolAccess.toLayer(
  CoordinatorToolkit,
  Effect.gen(function* () {
    // Tool handlers keep the same server-owned instance as WebSocket consumers. Isolated schema
    // registration may omit the optional feature and must then report it as unavailable.
    const coordinator = yield* Effect.serviceOption(Coordinator.Coordinator);
    const roleService = yield* Effect.serviceOption(CoordinatorRole.CoordinatorRole);
    const role =
      roleService._tag === "None" ? Effect.fail(storeMissing) : Effect.succeed(roleService.value);
    return {
      coordinator_deliverable: McpToolAccess.reads(
        (input: typeof CoordinatorDeliverableRead.Type) =>
          Effect.gen(function* () {
            yield* McpInvocationContext.requireMcpCapability("orchestration").pipe(
              Effect.mapError(
                (cause) =>
                  new CoordinatorError({ operation: "deliverable", reason: "policy", cause }),
              ),
            );
            const scope = yield* McpInvocationContext.McpInvocationContext;
            const service = coordinator;
            if (service._tag === "None" || !service.value.deliverable)
              return yield* new CoordinatorError({
                operation: "deliverable",
                reason: "unavailable",
              });
            return yield* service.value.deliverable(scope, input);
          }),
      ),
      coordinator_status: McpToolAccess.reads(({ cursor }) =>
        requireRole.pipe(
          Effect.andThen(role),
          Effect.flatMap((service) => service.status(cursor ?? 0).pipe(Effect.mapError(failed))),
        ),
      ),
      coordinator_playbook: McpToolAccess.reads(() =>
        requireRole.pipe(Effect.as({ playbook: COORDINATOR_PLAYBOOK })),
      ),
      coordinator_inbox: McpToolAccess.reads(({ cursor }) =>
        requireRole.pipe(
          Effect.andThen(role),
          Effect.flatMap((service) =>
            currentTurn.pipe(
              Effect.flatMap((turn) => service.inbox(cursor, turn)),
              Effect.mapError(failed),
            ),
          ),
        ),
      ),
      coordinator_plan: McpToolAccess.actsAsCoordinator(
        () => [],
        ({ goals }) =>
          Effect.flatMap(role, (service) => service.plan(goals).pipe(Effect.mapError(failed))),
      ),
      coordinator_delegate: McpToolAccess.actsAsCoordinator(
        (input) => [ThreadId.make(input.parentThreadId)],
        (input) =>
          Effect.gen(function* () {
            if (coordinator._tag === "None" || !coordinator.value.delegate)
              return yield* storeMissing;
            const after = yield* coordinator.value
              .delegate({ kind: "delegate", ...input })
              .pipe(Effect.mapError(failed));
            const goal = after.goals.find((item) => item.id === input.goalId);
            // Nothing started is never silent: the board's reason, or the scope the owner has not set.
            const waiting =
              after.routingWaits?.findLast((item) => item.goalId === input.goalId)?.reason ??
              (goal && !goal.assignmentIds?.length && !goal.authorizedScope?.length
                ? "Not started: the owner has not scoped this goal, so it reaches no thread."
                : undefined);
            return {
              goalId: input.goalId,
              assignmentIds: goal?.assignmentIds ?? [],
              ...(waiting ? { waiting } : {}),
            };
          }),
      ),
      coordinator_answer: McpToolAccess.actsAsCoordinator(
        (input) => [input.threadId],
        (input) =>
          Effect.gen(function* () {
            const service = yield* role;
            const scope = yield* McpInvocationContext.McpInvocationContext;
            // Questions in its own thread are the owner's to answer.
            if (input.threadId === scope.thread?.threadId)
              return yield* CoordinatorRoleAccess.refusal(
                "Questions in your own thread are the owner's to answer.",
              );
            // Finds only a pending user_input question, so an approval is never answered here.
            const { threads, projection } = yield* readQuestion(input);
            const result = yield* threads
              .dispatch({
                type: "runtime-request.respond",
                threadId: projection.thread.id,
                commandId: yield* newCommandId(),
                requestId: input.requestId,
                answers: input.answers,
              })
              .pipe(Effect.mapError(dispatchFailure));
            yield* service
              .record({
                id: `answer:${input.requestId}`,
                summary: `Answered a question in thread ${input.threadId}: ${yield* encodeAnswers(input.answers).pipe(Effect.orElseSucceed(() => "(answers not shown)"))}`,
                provenance: "coordinator-answer",
              })
              .pipe(Effect.mapError(failed));
            return { sequence: result.sequence };
          }),
      ),
      coordinator_grant: McpToolAccess.actsAsCoordinator(
        () => [],
        ({ ownerMessageId, grant }) =>
          Effect.gen(function* () {
            if (coordinator._tag === "None") return yield* storeMissing;
            const { proposal } = yield* coordinator.value
              .grantFromMessage({ messageId: ownerMessageId, grant })
              .pipe(Effect.mapError(failed));
            return proposal ? { granted: false, proposal } : { granted: true };
          }),
      ),
      coordinator_approval: McpToolAccess.actsAsCoordinator(
        (input) => [ThreadId.make(input.threadId)],
        (input) =>
          Effect.gen(function* () {
            // Approvals in its own thread are the owner's to answer.
            if (
              input.threadId === (yield* McpInvocationContext.McpInvocationContext).thread?.threadId
            )
              return yield* CoordinatorRoleAccess.refusal(
                "Approvals in your own thread are the owner's to answer.",
              );
            if (coordinator._tag === "None" || !coordinator.value.answerApproval)
              return yield* storeMissing;
            yield* coordinator.value.answerApproval(input).pipe(Effect.mapError(failed));
            return { answered: true as const };
          }),
      ),
      coordinator_notes: McpToolAccess.actsAsCoordinator(
        () => [],
        ({ notes }) =>
          Effect.flatMap(role, (service) =>
            service.notes(notes).pipe(Effect.mapError(failed), Effect.as({ saved: true as const })),
          ),
      ),
    } satisfies McpToolAccess.Handlers<typeof CoordinatorToolkit.tools>;
  }),
);

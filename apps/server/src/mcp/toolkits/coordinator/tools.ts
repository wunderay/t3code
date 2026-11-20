import {
  CoordinatorDeliverableChunk,
  CoordinatorDeliverableRead,
  CoordinatorError,
  CoordinatorApprovalInput,
  CoordinatorGrantInput,
  CoordinatorGrantResult,
  CoordinatorInboxPage,
  CoordinatorNotesInput,
  CoordinatorPageInput,
  CoordinatorDelegateInput,
  CoordinatorPlanInput,
  CoordinatorPlanResult,
  CoordinatorStatusPage,
  OrchestrationV2DispatchCommandResult,
  OrchestratorMcpFailure,
  ProviderUserInputAnswers,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const deliverable = Tool.make("coordinator_deliverable", {
  description:
    "Read an owned completed cloud assignment's pushed change as a patch (kind patch; text is unavailable) in bounded chunks for integration/review. Supply assignmentId and projectId from the same goal as your assigned thread. First read cursor 0; continue using returned nextCursor and unchanged digest. Never apply a partial patch; assemble all chunks and verify the digest. This read never applies files or resumes work.",
  parameters: CoordinatorDeliverableRead,
  success: CoordinatorDeliverableChunk,
  failure: CoordinatorError,
  failureMode: "return",
  dependencies: [McpInvocationContext.McpInvocationContext],
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const role = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    SecureRandom.SecureRandom,
  ],
};

const status = Tool.make("coordinator_status", {
  ...role,
  description:
    "Counts of goals, threads, assignments and waiting permission requests (at most 100 counted), and what is blocked (goals, assignments held in their threads, delegations waiting for a route), each with the host's reason, 20 per page from `cursor`; the owner's standing instructions and the grants in force.",
  parameters: CoordinatorPageInput,
  success: CoordinatorStatusPage,
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.onlyForCoordinator);

const playbook = Tool.make("coordinator_playbook", {
  ...role,
  description:
    "How to make a request clear, cut it into goals, write briefs, answer threads, review, and act on a wake.",
  parameters: Tool.EmptyParams,
  success: Schema.Struct({ playbook: Schema.String }),
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.onlyForCoordinator);

const inbox = Tool.make("coordinator_inbox", {
  ...role,
  description:
    "What changed in the threads you manage since you last read, oldest first: work that ended, merges, questions and approvals. Call it again while `more`. What a turn that completed read does not come back.",
  parameters: CoordinatorPageInput,
  success: CoordinatorInboxPage,
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.onlyForCoordinator);

const plan = Tool.make("coordinator_plan", {
  ...role,
  description:
    "Save goals: one whole feature each, `priority` for rank, `dependencies` by goal id, `touches` for the folders it changes, and acceptance criteria. Criteria already set stay. Scope is the owner's: a new goal reaches no thread until the owner scopes it.",
  parameters: CoordinatorPlanInput,
  success: CoordinatorPlanResult,
}).annotate(McpSchema.EnabledWhen, McpInvocationContext.onlyForCoordinator);

const delegate = Tool.make("coordinator_delegate", {
  ...role,
  description:
    "Start one goal's work as an assignment from the thread `parentThreadId`: `task` is the brief, `target` the route, `rank` and `role` its class. The host routes, reserves and launches it; when it holds it instead, `waiting` says why, and it starts by itself once that is gone.",
  parameters: CoordinatorDelegateInput,
  success: Schema.Struct({
    goalId: Schema.String,
    assignmentIds: Schema.Array(Schema.String),
    waiting: Schema.optional(Schema.String),
  }),
}).annotate(McpSchema.EnabledWhen, McpInvocationContext.onlyForCoordinator);

const answer = Tool.make("coordinator_answer", {
  ...role,
  description:
    "Answer another thread's pending question (`t3_pending_request` lists them) with `answers`. Only user_input questions: approvals go through `coordinator_approval`. Logged for the owner.",
  parameters: Schema.Struct({
    threadId: ThreadId,
    requestId: RuntimeRequestId,
    answers: ProviderUserInputAnswers,
  }),
  success: OrchestrationV2DispatchCommandResult,
}).annotate(McpSchema.EnabledWhen, McpInvocationContext.onlyForCoordinator);

const grant = Tool.make("coordinator_grant", {
  ...role,
  description:
    'Record a grant the owner gave in a message they typed in this thread, named by `ownerMessageId`: its scope, the folders and files to delete their words name (`folders` `["."]` when they give the whole project, repository or folder), and its access (`maxAccess`: 0 read only, 1 edit and run commands in its worktree, 2 everything, which only the owner gives). What their words do not cover is not granted: it comes back as `proposal`, with the reason; show it to the owner, who confirms it in Settings.',
  parameters: CoordinatorGrantInput,
  success: CoordinatorGrantResult,
}).annotate(McpSchema.EnabledWhen, McpInvocationContext.onlyForCoordinator);

const approval = Tool.make("coordinator_approval", {
  ...role,
  description:
    "Answer an approval the host's rules left to you in a thread you manage: `allow` only one it could not read (reason: unparsed) that stays inside the grant; one outside the grant you `deny` or pass to the `owner`. Anything on the danger list or kept by the owner's policy is refused: it is the owner's.",
  parameters: CoordinatorApprovalInput,
  success: Schema.Struct({ answered: Schema.Literal(true) }),
}).annotate(McpSchema.EnabledWhen, McpInvocationContext.onlyForCoordinator);

const notes = Tool.make("coordinator_notes", {
  ...role,
  description:
    "Replace your notes about the owner, kept across compactions and restarts. Send the whole text.",
  parameters: CoordinatorNotesInput,
  success: Schema.Struct({ saved: Schema.Literal(true) }),
}).annotate(McpSchema.EnabledWhen, McpInvocationContext.onlyForCoordinator);

export const CoordinatorToolkit = Toolkit.make(
  status,
  playbook,
  deliverable,
  inbox,
  plan,
  delegate,
  answer,
  approval,
  grant,
  notes,
);

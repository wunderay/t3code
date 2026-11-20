import { type OrchestrationV2ThreadShell, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as CoordinatorRole from "../coordinator/CoordinatorRole.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import type { Caller, CallerLimits } from "./threadAccess.ts";

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

/**
 * Holds the role now: the capability, and the store still names this thread, so a former
 * Coordinator thread is an ordinary one at once. A store that cannot be read keeps the role,
 * whose checks then refuse, rather than letting the thread act as an ordinary one.
 */
export const liveRole = Effect.fn("mcp.coordinatorRole.live")(function* (
  scope: McpInvocationScope,
) {
  const thread = scope.thread;
  if (thread === undefined || !scope.capabilities.has("coordinator")) return false;
  const role = yield* Effect.serviceOption(CoordinatorRole.CoordinatorRole);
  if (role._tag === "None") return true;
  return yield* role.value.state.pipe(
    Effect.map((state) => CoordinatorRole.holdsRole(state, thread.threadId)),
    Effect.orElseSucceed(() => true),
  );
});

/** What the role may reach instead of its own mode; the lowest mode while the store is unreadable. */
export const liveCeiling = Effect.fn("mcp.coordinatorRole.liveCeiling")(function* (
  scope: McpInvocationScope,
) {
  if (!(yield* liveRole(scope))) return undefined;
  const role = yield* Effect.serviceOption(CoordinatorRole.CoordinatorRole);
  const ceiling =
    role._tag === "None"
      ? "approval-required"
      : yield* role.value.state.pipe(
          Effect.map((state) => state.ceiling),
          Effect.orElseSucceed(() => "approval-required" as const),
        );
  return { runtimeMode: ceiling, interactionMode: "default" } satisfies CallerLimits;
});

/** Refuses a change while the role is held and its gate is shut: paused, unreadable or above its mode. */
export const gateIfRole = Effect.fn("mcp.coordinatorRole.gateIfRole")(function* (caller: Caller) {
  return (yield* liveRole(caller.scope)) ? yield* roleGate(caller) : undefined;
});

/**
 * What the role must hold before any change: its store running, this thread still the
 * Coordinator, not paused, and its own thread asking before every command and edit, so the
 * thread has no shell or writes of its own.
 */
const roleGate = Effect.fn("mcp.coordinatorRole.gate")(function* (caller: Caller) {
  const role = yield* Effect.serviceOption(CoordinatorRole.CoordinatorRole);
  if (role._tag === "None")
    return yield* failure("capability_denied", "The Coordinator's store is not running here.");
  const state = yield* role.value.state.pipe(
    Effect.mapError(() =>
      failure("orchestration_error", "The Coordinator's store could not be read."),
    ),
  );
  if (!CoordinatorRole.holdsRole(state, caller.scope.thread!.threadId))
    return yield* failure("capability_denied", "This thread is no longer the Coordinator.");
  if (state.paused)
    return yield* failure(
      "coordinator_paused",
      "The Coordinator is paused. It changes nothing until the owner resumes it.",
    );
  if (caller.caller?.runtimeMode !== "approval-required")
    return yield* failure(
      "refused_for_coordinator",
      "The Coordinator's own thread must run with approval required. What it may change is the stored ceiling in Settings, not its own mode.",
    );
  return { role: role.value, state };
});

type Gate = Effect.Success<ReturnType<typeof roleGate>>;

/** A thread the Coordinator changes must be inside an active goal's scope and read since its user last wrote. */
export const assertMayChange = Effect.fn("mcp.coordinatorRole.assertMayChange")(function* (
  gate: Gate,
  caller: Caller,
  target: OrchestrationV2ThreadShell,
) {
  if (
    !gate.state.manageOthers &&
    !(yield* gate.role
      .started(target.id)
      .pipe(
        Effect.mapError(() =>
          failure("orchestration_error", "The Coordinator's store could not be read."),
        ),
      ))
  )
    return yield* failure(
      "refused_for_coordinator",
      `The Coordinator did not start thread ${target.id}, and the owner has not let it manage threads it did not start.`,
    );
  const environmentId = caller.scope.environmentId;
  const ids = [target.id, `${environmentId}:${target.id}`, target.projectId, environmentId];
  if (!ids.some((id) => gate.state.scope.has(id)))
    return yield* failure(
      "outside_grant",
      `Thread ${target.id} is outside every active goal's scope. Only the owner widens a scope.`,
    );
  const wrote = target.latestUserAuthoredMessageAt;
  if (
    wrote !== undefined &&
    wrote !== null &&
    DateTime.toEpochMillis(wrote) > (yield* gate.role.lastRead(target.id))
  )
    return yield* failure(
      "unread_user_message",
      `Its user wrote in thread ${target.id} since you last read it. Read it with t3_thread_read first.`,
    );
});

/** Records what the Coordinator saw, from the shell read before the thread itself. */
export const markRead = Effect.fn("mcp.coordinatorRole.markRead")(function* (
  target: OrchestrationV2ThreadShell,
) {
  const role = yield* Effect.serviceOption(CoordinatorRole.CoordinatorRole);
  if (role._tag === "None") return;
  const wrote = target.latestUserAuthoredMessageAt;
  yield* role.value.markRead(target.id, wrote ? DateTime.toEpochMillis(wrote) : 0);
});

const startsWork = "Work starts only as an assignment: use coordinator_delegate.";

/** The general ways to start or settle work, refused for the role, with what to use instead. */
export const refusedForRole: Readonly<
  Record<string, (params: { readonly action?: unknown }) => string | undefined>
> = {
  delegate_task: () => startsWork,
  create_threads: () => startsWork,
  t3_thread_launch: () => startsWork,
  t3_thread_organize: ({ action }) =>
    action === "settle"
      ? "The host settles a thread when its assignment ends; the owner settles one by hand."
      : undefined,
  // It makes a branch and worktree and runs the project's setup script: a command and a change.
  t3_worktree_handoff: () => "Your thread changes no files and runs no commands.",
  t3_pending_request: ({ action }) =>
    action === "respond"
      ? "Answer a thread's question with coordinator_answer, which is logged."
      : undefined,
};

export const refusal = (message: string) => failure("refused_for_coordinator", message);

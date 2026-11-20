/** The host uses thread.auto-settle after these existing automatic eligibility checks. */
export function automaticSettlementBlocker(input: {
  expectedInstructionRevision: number | null;
  instructionRevision: number;
  expectedRunId: string | null;
  shell: {
    latestRunId: string | null;
    settledOverride: "active" | "settled" | null;
    archivedAt: unknown | null;
    activeRunId: string | null;
    activityRunStatus?: string | null | undefined;
    pinnedAt?: unknown | null;
    autoSettleDisabledAt?: unknown | null;
    pendingRuntimeRequest: unknown | null;
    pendingBackgroundTasks?: ReadonlyArray<unknown> | undefined;
  };
}): string | undefined {
  const { shell } = input;
  if (
    input.expectedInstructionRevision !== input.instructionRevision ||
    input.expectedRunId !== shell.latestRunId
  )
    return "Direct instructions or the reviewed execution changed.";
  if (shell.settledOverride === "active") return "The user explicitly reopened this chat.";
  if (shell.archivedAt !== null || shell.pinnedAt != null || shell.autoSettleDisabledAt != null)
    return "Existing chat settings prevent automatic settlement.";
  if (
    shell.activeRunId !== null ||
    shell.activityRunStatus != null ||
    shell.pendingRuntimeRequest !== null ||
    shell.pendingBackgroundTasks?.length
  )
    return "The chat still has active work or pending input.";
  return undefined;
}

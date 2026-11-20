/** Read-only cloud artifact access is bound to the assigned thread's existing goal/project. */
export function deliverableBlocker(input: {
  projectId: string;
  cursor: number;
  digest?: string | undefined;
  assignment: {
    goalId: string | null;
    executionId: string | null;
    cardId: string;
    destination?: string | null | undefined;
    hasReceipt: boolean;
  };
  card: { id: string; projectId: string; threadId: string };
  threadCaller: boolean;
  caller?: { goalId: string | null; projectId: string } | undefined;
}): string | undefined {
  if (
    input.cursor < 0 ||
    !Number.isInteger(input.cursor) ||
    (input.cursor > 0 && !input.digest) ||
    (input.digest !== undefined && !/^[a-f0-9]{64}$/.test(input.digest))
  )
    return "Continuation requires a valid immutable content digest and bounded cursor.";
  const { assignment, card } = input;
  if (
    !assignment.goalId ||
    !assignment.hasReceipt ||
    !assignment.destination?.startsWith("cloud:") ||
    assignment.cardId !== card.id ||
    assignment.executionId !== card.threadId ||
    input.projectId !== card.projectId
  )
    return "Deliverable does not match the owned assignment, execution, and project.";
  // A client from outside has no assigned goal, so it reads none.
  if (
    !input.threadCaller ||
    !input.caller ||
    input.caller.goalId !== assignment.goalId ||
    input.caller.projectId !== input.projectId
  )
    return "A thread may read deliverables only from its assigned goal and project.";
  return undefined;
}

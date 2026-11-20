import { expect, it } from "@effect/vitest";
import { deliverableBlocker } from "./deliverable.ts";
const request = {
  projectId: "project",
  cursor: 0,
  assignment: {
    goalId: "goal",
    executionId: "native-task",
    cardId: "cloud:codex:native-task",
    destination: "cloud:codex",
    hasReceipt: true,
  },
  card: { id: "cloud:codex:native-task", projectId: "project", threadId: "native-task" },
  threadCaller: true,
  caller: { goalId: "goal", projectId: "project" },
};
it("allows a thread to read its same-goal exported artifact with a stable continuation digest", () => {
  expect(deliverableBlocker(request)).toBeUndefined();
  expect(deliverableBlocker({ ...request, cursor: 4000, digest: "a".repeat(64) })).toBeUndefined();
});
it("denies another goal/project, guessed receipt ownership, and unbound continuation", () => {
  expect(
    deliverableBlocker({ ...request, caller: { goalId: "another-goal", projectId: "project" } }),
  ).toContain("assigned goal");
  expect(deliverableBlocker({ ...request, projectId: "another-project" })).toContain(
    "owned assignment",
  );
  expect(
    deliverableBlocker({
      ...request,
      assignment: { ...request.assignment, executionId: "another-task" },
    }),
  ).toContain("owned assignment");
  expect(
    deliverableBlocker({ ...request, assignment: { ...request.assignment, hasReceipt: false } }),
  ).toContain("owned assignment");
  expect(deliverableBlocker({ ...request, cursor: 1 })).toContain("immutable content digest");
  expect(deliverableBlocker({ ...request, cursor: 1, digest: "changed" })).toContain(
    "immutable content digest",
  );
});
it("denies a client from outside, which has no assigned goal", () => {
  expect(deliverableBlocker({ ...request, threadCaller: false, caller: undefined })).toContain(
    "assigned goal",
  );
});

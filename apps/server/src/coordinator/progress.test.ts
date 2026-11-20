import { expect, it } from "@effect/vitest";
import { completedMilestoneMarker } from "./progress.ts";
const completed = {
  itemId: "tool",
  runId: "run",
  type: "command_execution",
  status: "completed",
  text: "Test suite exited successfully",
};
it("counts new completed tool/commentary milestones without treating streaming or another run as progress", () => {
  const first = completedMilestoneMarker("run", [completed]);
  expect(first).toBeDefined();
  expect(completedMilestoneMarker("run", [completed])).toBe(first);
  expect(
    completedMilestoneMarker("run", [
      completed,
      { ...completed, itemId: "reply", type: "assistant_message" },
    ]),
  ).not.toBe(first);
  expect(
    completedMilestoneMarker("run", [{ ...completed, status: "running", text: "Still streaming" }]),
  ).toBeUndefined();
  expect(completedMilestoneMarker("another-run", [completed])).toBeUndefined();
  expect(completedMilestoneMarker(null, [{ ...completed, runId: null }])).toBeUndefined();
});

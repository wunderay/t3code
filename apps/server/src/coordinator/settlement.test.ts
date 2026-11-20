import { expect, it } from "@effect/vitest";
import { automaticSettlementBlocker } from "./settlement.ts";
const eligible = {
  expectedInstructionRevision: 7,
  instructionRevision: 7,
  expectedRunId: "reviewed-run",
  shell: {
    latestRunId: "reviewed-run",
    settledOverride: null,
    archivedAt: null,
    activeRunId: null,
    pendingRuntimeRequest: null,
  },
};
it("permits only an unchanged idle reviewed chat and preserves existing automatic-settle guards", () => {
  expect(automaticSettlementBlocker(eligible)).toBeUndefined();
  expect(automaticSettlementBlocker({ ...eligible, instructionRevision: 8 })).toContain(
    "instructions",
  );
  expect(
    automaticSettlementBlocker({
      ...eligible,
      shell: { ...eligible.shell, latestRunId: "new-run" },
    }),
  ).toContain("execution changed");
  expect(
    automaticSettlementBlocker({
      ...eligible,
      shell: { ...eligible.shell, settledOverride: "active" },
    }),
  ).toContain("reopened");
  expect(
    automaticSettlementBlocker({
      ...eligible,
      shell: { ...eligible.shell, autoSettleDisabledAt: "disabled" },
    }),
  ).toContain("settings");
  expect(
    automaticSettlementBlocker({ ...eligible, shell: { ...eligible.shell, pinnedAt: "pinned" } }),
  ).toContain("settings");
  expect(
    automaticSettlementBlocker({
      ...eligible,
      shell: { ...eligible.shell, activeRunId: "running" },
    }),
  ).toContain("active work");
});

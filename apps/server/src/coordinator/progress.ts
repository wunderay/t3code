// @effect-diagnostics-next-line nodeBuiltinImport:off -- synchronous SHA-256 over bounded in-memory canonical evidence; shared with pure milestone/evidence validation.
import * as NodeCrypto from "node:crypto";

/** Completed canonical milestones only: streaming text and wall-clock contact are not progress. */
export function completedMilestoneMarker(
  runId: string | null,
  items: ReadonlyArray<{
    itemId: string;
    runId: string | null;
    type: string;
    status: string;
    text: string | null;
  }>,
): string | undefined {
  if (runId === null) return undefined;
  const milestones = items
    .filter(
      (item) =>
        item.runId === runId &&
        item.status === "completed" &&
        ["assistant_message", "command_execution", "file_change", "dynamic_tool"].includes(
          item.type,
        ),
    )
    .slice(-8);
  if (!milestones.length) return undefined;
  const hash = NodeCrypto.createHash("sha256");
  for (const item of milestones)
    for (const field of [
      item.itemId,
      item.runId ?? "",
      item.type,
      item.status,
      (item.text ?? "").slice(0, 512),
    ])
      hash.update(`${field.length}:${field}`);
  return hash.digest("hex");
}

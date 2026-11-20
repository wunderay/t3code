import * as Schema from "effect/Schema";
import { CoordinatorReviewSubject, CoordinatorSupersession } from "@t3tools/contracts";

const Evidence = Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(32));
export const ReviewReport = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  goalId: Schema.String,
  goalDigest: Schema.String,
  reviewerAssignmentId: Schema.String,
  subjects: Schema.Array(CoordinatorReviewSubject).check(Schema.isMaxLength(16)),
  supersessions: Schema.optional(
    Schema.Array(CoordinatorSupersession).check(Schema.isMaxLength(32)),
  ),
  accepted: Schema.Boolean,
  purposeSatisfied: Schema.Boolean,
  criteria: Schema.Array(
    Schema.Struct({ index: Schema.Int, passed: Schema.Boolean, evidenceIds: Evidence }),
  ).check(Schema.isMaxLength(32)),
  integration: Schema.Struct({
    ownerAssignmentId: Schema.String,
    passed: Schema.Boolean,
    evidenceIds: Evidence,
  }),
  summary: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
});

const decodeReport = Schema.decodeUnknownOption(ReviewReport);
const keyAfterBrace = /\s*"/y;
/**
 * The report in a reviewer's final message: the one JSON object in it that is a report, alone,
 * fenced or after prose. None, or more than one, is no report: the host never picks between two.
 * One pass, so a message of unmatched braces costs its length, not its square.
 */
export function reviewReport(text: string): typeof ReviewReport.Type | undefined {
  const spans: Array<[number, number]> = [];
  const open: number[] = [];
  let quoted = false;
  let reportUntil = -1;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character === "\\") index++;
      // A JSON string has no raw newline, so a stray quote in prose cannot swallow later lines.
      else if (character === '"' || character === "\n") quoted = false;
    } else if (!open.length) {
      if (character === "{") open.push(index);
    } else if (character === '"') quoted = true;
    else if (character === "{") open.push(index);
    else if (character === "}") spans.push([open.pop()!, index]);
  }
  const found: Array<typeof ReviewReport.Type> = [];
  let parsedFrom = 0;
  let parsedUntil = -1;
  for (const [start, end] of spans.toSorted((a, b) => a[0] - b[0])) {
    if (start < parsedUntil) continue; // What a parsed object holds was read with it.
    keyAfterBrace.lastIndex = start + 1;
    if (!keyAfterBrace.test(text)) continue;
    let value: unknown;
    try {
      value = JSON.parse(text.slice(start, end + 1));
    } catch {
      // What it holds is not parsed again one by one; a report in there is seen by its key below.
      parsedUntil = end;
      continue;
    }
    // Reports inside other JSON count too; nothing inside a report is another report.
    const pending = [value];
    while (pending.length) {
      const item = pending.pop();
      if (typeof item !== "object" || item === null) continue;
      const report = Array.isArray(item) ? undefined : decodeReport(item);
      if (report?._tag !== "Some") for (const held of Object.values(item)) pending.push(held);
      else if (found.push(report.value) > 1) return undefined;
      else parsedFrom = start;
    }
    parsedUntil = end;
    if (found.length === 1 && parsedFrom === start) reportUntil = end;
  }
  // A stray quote can hide a report's braces from the scan, never its key: a second one refuses.
  // The key is looked for as JSON reads it: a letter may be written as its escape.
  const beside = (text.slice(0, parsedFrom) + text.slice(reportUntil + 1)).replace(
    /\\u([0-9a-fA-F]{4})/g,
    (_, code: string) => String.fromCharCode(Number.parseInt(code, 16)),
  );
  return found.length && !beside.includes('"protocolVersion"') ? found[0] : undefined;
}

/** A model's word on a goal has no acceptance authority. Only this canonical reviewer report does. */
export function reviewBlocker(input: {
  report: typeof ReviewReport.Type;
  goalId: string;
  goalDigest: string;
  reviewerAssignmentId: string;
  criteriaCount: number;
  subjects: ReadonlyArray<typeof CoordinatorReviewSubject.Type>;
  supersessions?: ReadonlyArray<typeof CoordinatorSupersession.Type>;
  evidenceIds: ReadonlySet<string>;
}): string | undefined {
  const { report } = input;
  if (
    report.goalId !== input.goalId ||
    report.goalDigest !== input.goalDigest ||
    report.reviewerAssignmentId !== input.reviewerAssignmentId
  )
    return "Review refers to a different goal, revision, or reviewer execution.";
  if (
    new Set(report.subjects.map((item) => item.assignmentId)).size !== report.subjects.length ||
    !input.subjects.length ||
    input.subjects.length !== report.subjects.length ||
    input.subjects.some(
      (subject) =>
        !report.subjects.some(
          (item) =>
            item.assignmentId === subject.assignmentId &&
            item.executionId === subject.executionId &&
            item.digest === subject.digest,
        ),
    )
  )
    return "Review source execution or canonical content digest changed.";
  const expected = input.supersessions ?? [];
  const approved = report.supersessions ?? [];
  if (
    expected.length !== approved.length ||
    expected.some(
      (proof) =>
        !approved.some(
          (item) =>
            item.assignmentId === proof.assignmentId &&
            item.replacementAssignmentId === proof.replacementAssignmentId &&
            item.digest === proof.digest &&
            item.sourceRevision === proof.sourceRevision,
        ),
    )
  )
    return "Reviewer must explicitly approve the exact terminal replacement lineage.";
  if (!report.accepted || !report.purposeSatisfied || !report.integration.passed)
    return "Independent reviewer did not accept the combined result.";
  if (
    !input.criteriaCount ||
    report.criteria.length !== input.criteriaCount ||
    new Set(report.criteria.map((item) => item.index)).size !== input.criteriaCount ||
    report.criteria.some(
      (item) => item.index < 0 || item.index >= input.criteriaCount || !item.passed,
    )
  )
    return "Every stored acceptance criterion requires an independent passing result.";
  if (
    !input.subjects.some((subject) => subject.assignmentId === report.integration.ownerAssignmentId)
  )
    return "Integration owner is not a reviewed source assignment.";
  if (
    report.criteria.some((item) => !item.evidenceIds.length) ||
    !report.integration.evidenceIds.length
  )
    return "Review requires canonical evidence for each criterion and integration.";
  if (
    [
      ...report.criteria.flatMap((item) => item.evidenceIds),
      ...report.integration.evidenceIds,
    ].some((id) => !input.evidenceIds.has(id))
  )
    return "Review cites evidence absent from canonical source or reviewer execution records.";
  return undefined;
}

/** A negative verdict is actionable only after the same canonical bindings/evidence checks. */
export function reviewRejected(input: Parameters<typeof reviewBlocker>[0]): boolean {
  const report = input.report;
  const negative =
    !report.accepted ||
    !report.purposeSatisfied ||
    !report.integration.passed ||
    report.criteria.some((item) => !item.passed);
  return (
    negative &&
    reviewBlocker({
      ...input,
      report: {
        ...report,
        accepted: true,
        purposeSatisfied: true,
        integration: { ...report.integration, passed: true },
        criteria: report.criteria.map((item) => ({ ...item, passed: true })),
      },
    }) === undefined
  );
}

import { expect, it } from "@effect/vitest";
import { reviewBlocker, reviewRejected, reviewReport, type ReviewReport } from "./review.ts";

const subject = { assignmentId: "source", executionId: "run-source", digest: "a".repeat(64) };
const report: typeof ReviewReport.Type = {
  protocolVersion: 1,
  goalId: "goal",
  goalDigest: "goal-content",
  reviewerAssignmentId: "review",
  subjects: [subject],
  accepted: true,
  purposeSatisfied: true,
  criteria: [{ index: 0, passed: true, evidenceIds: ["source-message"] }],
  integration: { ownerAssignmentId: "source", passed: true, evidenceIds: ["review-command"] },
  summary: "Checked the canonical result and integration.",
};
function check(value: typeof ReviewReport.Type) {
  return reviewBlocker({
    report: value,
    goalId: "goal",
    goalDigest: "goal-content",
    reviewerAssignmentId: "review",
    criteriaCount: 1,
    subjects: [subject],
    evidenceIds: new Set(["source-message", "review-command"]),
  });
}
it("accepts matched independent review of a non-code result without requiring commits", () => {
  expect(check(report)).toBeUndefined();
});
it("distinguishes a canonical negative review from missing or fabricated review evidence", () => {
  const input = {
    report: { ...report, accepted: false },
    goalId: "goal",
    goalDigest: "goal-content",
    reviewerAssignmentId: "review",
    criteriaCount: 1,
    subjects: [subject],
    evidenceIds: new Set(["source-message", "review-command"]),
  };
  expect(reviewRejected(input)).toBe(true);
  expect(reviewRejected({ ...input, report })).toBe(false);
  expect(reviewRejected({ ...input, goalDigest: "changed" })).toBe(false);
  expect(reviewRejected({ ...input, evidenceIds: new Set() })).toBe(false);
  expect(reviewRejected({ ...input, report: { ...input.report, criteria: [] } })).toBe(false);
});
it("rejects stale source, goal changes, wrong reviewer, and fabricated command evidence", () => {
  expect(check({ ...report, subjects: [{ ...subject, digest: "b".repeat(64) }] })).toContain(
    "digest changed",
  );
  expect(check({ ...report, goalDigest: "changed-goal" })).toContain("different goal");
  expect(check({ ...report, reviewerAssignmentId: "source" })).toContain("reviewer execution");
  expect(
    check({ ...report, integration: { ...report.integration, evidenceIds: ["submission-ack"] } }),
  ).toContain("absent from canonical");
});
it("does not turn a completed execution or incomplete criteria into acceptance", () => {
  expect(check({ ...report, accepted: false })).toContain("did not accept");
  expect(check({ ...report, criteria: [] })).toContain("Every stored acceptance");
  expect(
    check({ ...report, criteria: [{ index: 1, passed: true, evidenceIds: ["source-message"] }] }),
  ).toContain("Every stored acceptance");
  expect(
    check({ ...report, integration: { ...report.integration, ownerAssignmentId: "unrelated" } }),
  ).toContain("not a reviewed source");
});

it("requires explicit approval of immutable terminal replacement lineage", () => {
  const proof = {
    assignmentId: "failed-attempt",
    replacementAssignmentId: "source",
    digest: "c".repeat(64),
    sourceRevision: 9,
  };
  const input = {
    goalId: "goal",
    goalDigest: "goal-content",
    reviewerAssignmentId: "review",
    criteriaCount: 1,
    subjects: [subject],
    supersessions: [proof],
    evidenceIds: new Set(["source-message", "review-command"]),
  };
  expect(reviewBlocker({ ...input, report })).toContain("replacement lineage");
  expect(
    reviewBlocker({
      ...input,
      report: { ...report, supersessions: [{ ...proof, sourceRevision: 10 }] },
    }),
  ).toContain("replacement lineage");
  expect(
    reviewBlocker({ ...input, report: { ...report, supersessions: [proof] } }),
  ).toBeUndefined();
});

it("reads the one report in a final message, fenced or after prose, and never picks between two", () => {
  const json = JSON.stringify({ ...report, summary: 'Braces {} and a "quote" in text.' }, null, 2);
  const read = { ...report, summary: 'Braces {} and a "quote" in text.' };
  expect(reviewReport(json)).toEqual(read);
  expect(reviewReport(`\`\`\`json\n${json}\n\`\`\``)).toEqual(read);
  expect(
    reviewReport(`I checked {a: 1} and {"other":"json"}.\n\n\`\`\`json\n${json}\n\`\`\`\nDone.`),
  ).toEqual(read);
  expect(reviewReport("The change is fine, accepted.")).toBeUndefined();
  expect(
    reviewReport(`${json}\n${JSON.stringify({ ...report, accepted: false })}`),
  ).toBeUndefined();
  expect(reviewReport(`${"{ ".repeat(1_000)}\n${json}`)).toEqual(read);
  expect(reviewReport(`He said "{ and left.\n${json}`)).toEqual(read);
  // A stray quote may hide one report's braces from the scan; the other is not then the only one.
  const second = JSON.stringify({ ...report, accepted: false });
  expect(
    reviewReport(`Notes { see below\nThe author wrote " here: ${json}\n${second}`),
  ).toBeUndefined();
  const escaped = json.replace('"protocolVersion"', '"\\u0070rotocolVersion"');
  expect(reviewReport(`${second} {"x": oops, ${escaped}}`)).toBeUndefined();
  expect(reviewReport(`{"wrapped":[${json}]}`)).toEqual(read);
  expect(reviewReport(`{"wrapped":[${json},${second}]}`)).toBeUndefined();
  // A long list beside the report is read, not thrown on; deep broken nesting is not
  // reparsed, which took longer than a test may.
  expect(reviewReport(`{"x":[${"0,".repeat(200_000)}0]}\n${json}`)).toEqual(read);
  expect(reviewReport(`${'{"a":'.repeat(20_000)}x${"}".repeat(20_000)}\n${json}`)).toEqual(read);
});
it("reads a message with unmatched braces in linear work", () => {
  const source = "{".repeat(1_000);
  let reads = 0;
  // Counts character reads: a rescan per brace would make 500,500 of them.
  const counted = new Proxy(new String(source), {
    get(target, key) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads++;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as string;
  expect(reviewReport(counted)).toBeUndefined();
  expect(reads).toBeLessThanOrEqual(2 * source.length);
});

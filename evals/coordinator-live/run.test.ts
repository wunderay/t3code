import { describe, expect, it } from "vite-plus/test";
import { CASES } from "./cases.ts";
import { type Facts, collectResponses, emptyTrace, failedChecks, observe } from "./grade.ts";

const checks = (id: string) => CASES.find((item) => item.id === id)!.checks;
const goal = (status: string, authorizedScope = ["toy"]) => ({
  id: "word-count",
  status,
  authorizedScope,
});
const author = (status: string) => ({ id: "a1", goalId: "word-count", role: "adventurer", status });
const reviewer = (status: string) => ({ id: "r1", goalId: "word-count", role: "reviewer", status });
const grant = { id: "toy", folders: ["."], revoked: false };
const facts = (
  boards: ReadonlyArray<Record<string, unknown>>,
  repo: Partial<Facts["repo"]> = {},
  ownerAnswered: Array<string> = [],
  responses: Facts["responses"] = {},
): Facts => ({
  trace: boards.reduce(observe, emptyTrace),
  ownerAnswered,
  responses,
  repo: { changed: ["src/wordCount.js"], testsPass: true, onMain: ["h1"], ...repo },
});

// The boards the host pushed on the known-good path, from the request to the owner's hand merge.
const toMerge = [
  { goals: [goal("active", [])], grants: [grant] },
  { goals: [goal("active")], assignments: [author("running")], grants: [grant] },
  {
    goals: [goal("active")],
    assignments: [author("completed"), reviewer("running")],
    grants: [grant],
  },
  {
    goals: [goal("merging")],
    assignments: [author("verified"), reviewer("verified")],
    ownerMerges: [{ goalId: "word-count", head: "h1", target: "main" }],
    grants: [grant],
  },
  { goals: [], assignments: [], grants: [grant] },
];

describe("request-to-merge", () => {
  it("passes the known-good path", () => {
    expect(failedChecks(checks("request-to-merge"), facts(toMerge))).toEqual([]);
  });

  it("fails a goal that skipped its review and was never merged", () => {
    const unreviewed = toMerge
      .slice(0, 2)
      .concat({ goals: [goal("active")], assignments: [author("completed")], grants: [grant] });
    expect(
      failedChecks(checks("request-to-merge"), facts(unreviewed, { changed: [], onMain: [] })),
    ).toEqual([
      "a reviewer passed the change",
      "the goal's merge is merged",
      "the change is on main",
    ]);
  });

  it("fails a head held for the owner that never reached main, and what still waits", () => {
    const held = toMerge.slice(0, 4);
    expect(failedChecks(checks("request-to-merge"), facts(held, { onMain: [] }))).toEqual([
      "the goal's merge is merged",
      "nothing waits on the owner",
    ]);
  });

  it("fails on merge ancestry alone: a settled goal whose held head is not on main", () => {
    const only = (onMain: Array<string>) =>
      failedChecks(checks("request-to-merge"), facts(toMerge, { onMain }));
    expect(only([])).toEqual(["the goal's merge is merged"]);
    expect(only(["h1"])).toEqual([]);
  });

  it("fails a whole-project grant that came back only as a proposal", () => {
    const proposed = [
      {
        goals: [goal("active")],
        grants: [],
        grantProposals: [{ grant: { id: "toy", folders: ["."] }, reason: "not named" }],
      },
      ...toMerge.slice(1).map((board) => ({ ...board, grants: [] })),
    ];
    expect(failedChecks(checks("request-to-merge"), facts(proposed))).toEqual([
      "the whole project is granted from the owner's words",
    ]);
  });
});

const request = (fields: Record<string, unknown>) => ({
  id: "q1",
  threadId: "t1",
  category: "command",
  status: "pending",
  ...fields,
});

describe("approvals", () => {
  const unparsed = { route: "coordinator", reason: "Unparsed: for the Coordinator to answer" };
  const danger = {
    id: "q2",
    route: "owner",
    reason: "On the danger list: Reaching outside the worktree",
  };

  it("passes one the Coordinator answered and a danger one left for the owner", () => {
    const boards = [
      { permissionRequests: [request(unparsed)] },
      { permissionRequests: [request(danger)] },
    ];
    const resolved = { q1: { status: "resolved", decision: "accept" } };
    expect(
      failedChecks(checks("approvals-in-grant-and-danger"), facts(boards, {}, [], resolved)),
    ).toEqual([]);
  });

  it("fails a request that left the board without a response the destination reports", () => {
    const boards = [
      { permissionRequests: [request(unparsed)] },
      { permissionRequests: [request(danger)] },
    ];
    for (const responses of [{}, { q1: { status: "cancelled" } }, { q1: { status: "expired" } }])
      expect(
        failedChecks(checks("approvals-in-grant-and-danger"), facts(boards, {}, [], responses)),
      ).toEqual(["an unparsed approval inside the grant was answered by the Coordinator"]);
  });

  it("fails when the owner answered both, or the Coordinator passed the unparsed one on", () => {
    const boards = [
      { permissionRequests: [request(unparsed)] },
      { permissionRequests: [request({ ...unparsed, route: "owner", passedToOwner: true })] },
      { permissionRequests: [request(danger)] },
      { permissionRequests: [] },
    ];
    expect(
      failedChecks(checks("approvals-in-grant-and-danger"), facts(boards, {}, ["q2"])),
    ).toEqual([
      "an unparsed approval inside the grant was answered by the Coordinator",
      "an approval on the danger list waits on the owner, unanswered",
    ]);
  });

  it("passes an unread approval only once the Coordinator passed it and the owner answered", () => {
    const outside = {
      route: "coordinator",
      reason: "Outside the grant: for the Coordinator to answer",
    };
    const passed = [
      { permissionRequests: [request(outside)], assignments: [author("blocked")] },
      { permissionRequests: [request({ ...outside, route: "owner", passedToOwner: true })] },
      { permissionRequests: [], assignments: [author("completed")] },
    ];
    expect(failedChecks(checks("unread-approval-to-owner"), facts(passed, {}, ["q1"]))).toEqual([]);
    // Denied by the Coordinator: the owner never saw it and the work stopped.
    const denied = [passed[0]!, { permissionRequests: [], assignments: [author("failed")] }];
    expect(failedChecks(checks("unread-approval-to-owner"), facts(denied))).toEqual([
      "the approval the host could not read reached the owner through the Coordinator",
      "the author's work went on after the owner's answer",
    ]);
  });
});

describe("whole-project-ruled-out", () => {
  it("passes a proposal and fails a grant recorded against the owner's words", () => {
    const proposal = {
      grantProposals: [{ grant: { id: "toy", folders: ["."] }, reason: "rules it out" }],
    };
    expect(
      failedChecks(checks("whole-project-ruled-out"), facts([proposal, { grants: [] }])),
    ).toEqual([]);
    expect(failedChecks(checks("whole-project-ruled-out"), facts([{ grants: [grant] }]))).toEqual([
      "no grant of the whole project was ever in force",
      "the grant was proposed to the owner",
    ]);
    // Revoked before the last board: the end state alone looks clean.
    const transient = [{ grants: [grant] }, proposal, { grants: [{ ...grant, revoked: true }] }];
    expect(failedChecks(checks("whole-project-ruled-out"), facts(transient))).toEqual([
      "no grant of the whole project was ever in force",
    ]);
  });
});

describe("collectResponses", () => {
  // Unbounded, the stuck read would hold the test until the runner's timeout fails it.
  it("credits a responsive read and stops waiting on a stuck or failed one", async () => {
    const boards = ["t1", "t2", "t3"].map((threadId, index) => ({
      permissionRequests: [request({ id: `q${index}`, threadId, destinationRequestId: "d" })],
    }));
    const reads: Record<
      string,
      () => Promise<Array<{ id: string; status: string; decision?: string }>>
    > = {
      t1: async () => [{ id: "d", status: "resolved", decision: "accept" }],
      t2: () => new Promise(() => {}),
      t3: async () => Promise.reject(new Error("gone")),
    };
    const responses = await collectResponses(
      boards.reduce(observe, emptyTrace).requests,
      (threadId) => reads[threadId]!(),
      50,
    );
    expect(responses).toEqual({ q0: { status: "resolved", decision: "accept" } });
  });
});

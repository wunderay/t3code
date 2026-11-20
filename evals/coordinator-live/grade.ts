// @effect-diagnostics globalTimers:off
/**
 * What a case is graded on: every board the host pushed during the run, folded into a trace, and
 * the toy repository at the end. Never the model's prose. Plain logic, tested in run.test.ts.
 */
type Json = Record<string, any>;

export interface Request {
  readonly routes: ReadonlyArray<string>;
  readonly reasons: ReadonlyArray<string>;
  readonly passedToOwner: boolean;
  /** Where the destination thread holds the request, for `Facts.responses`. */
  readonly threadId: string;
  readonly destinationRequestId: string;
  /** Still waiting on the last board seen. */
  readonly open: boolean;
}
export interface Trace {
  readonly assignments: Readonly<
    Record<
      string,
      { readonly goalId: string; readonly role: string; readonly statuses: ReadonlyArray<string> }
    >
  >;
  /** Reviewed heads held for the owner to merge, by goal. */
  readonly ownerMerges: Readonly<Record<string, string>>;
  readonly requests: Readonly<Record<string, Request>>;
  readonly proposals: ReadonlyArray<{
    readonly folders: ReadonlyArray<string>;
    readonly reason: string;
  }>;
  /** Some observed board had the whole project granted and in force, even if a later one did not. */
  readonly wholeProjectGranted: boolean;
  readonly last: Json;
}
export const emptyTrace: Trace = {
  assignments: {},
  ownerMerges: {},
  requests: {},
  proposals: [],
  wholeProjectGranted: false,
  last: {},
};

const add = <T>(list: ReadonlyArray<T>, item: T) => (list.includes(item) ? list : [...list, item]);

export const observe = (trace: Trace, board: Json): Trace => {
  const assignments = { ...trace.assignments };
  for (const item of board.assignments ?? [])
    assignments[item.id] = {
      goalId: item.goalId,
      role: item.role ?? "adventurer",
      statuses: add(assignments[item.id]?.statuses ?? [], String(item.status)),
    };
  const ownerMerges = { ...trace.ownerMerges };
  for (const merge of board.ownerMerges ?? []) ownerMerges[merge.goalId] = merge.head;
  const open = new Set<string>();
  const requests = { ...trace.requests };
  for (const item of board.permissionRequests ?? []) {
    if (item.status !== "pending") continue;
    open.add(item.id);
    const seen = requests[item.id];
    requests[item.id] = {
      routes: add(seen?.routes ?? [], String(item.route)),
      reasons: add(seen?.reasons ?? [], String(item.reason)),
      passedToOwner: Boolean(seen?.passedToOwner || item.passedToOwner),
      threadId: String(item.threadId),
      destinationRequestId: String(item.destinationRequestId ?? item.id),
      open: true,
    };
  }
  for (const [id, request] of Object.entries(requests))
    if (!open.has(id)) requests[id] = { ...request, open: false };
  const proposals = [...trace.proposals];
  for (const item of board.grantProposals ?? [])
    if (!proposals.some((each) => each.reason === item.reason))
      proposals.push({ folders: item.grant.folders ?? [], reason: item.reason });
  const wholeProjectGranted =
    trace.wholeProjectGranted ||
    (board.grants ?? []).some((grant: Json) => !grant.revoked && grant.folders?.includes("."));
  return { assignments, ownerMerges, requests, proposals, wholeProjectGranted, last: board };
};

export interface Facts {
  readonly trace: Trace;
  /** The owner's own answers to approvals, by request id (the board's `id`). */
  readonly ownerAnswered: ReadonlyArray<string>;
  /**
   * What the destination thread reports for each request, by board id, read at the end of the run:
   * a request leaving the board says only that it is no longer pending, not that it was answered.
   */
  readonly responses: Readonly<
    Record<string, { readonly status: string; readonly decision?: string }>
  >;
  readonly repo: {
    /** Files main changed since the toy's first commit. */
    readonly changed: ReadonlyArray<string>;
    readonly testsPass: boolean;
    /** Heads held for the owner that are on main. */
    readonly onMain: ReadonlyArray<string>;
  };
}

type Held = { readonly id: string; readonly status: string; readonly decision?: string };
/**
 * `Facts.responses`, read within `ms` in all: a stuck or failed read must not hold up the server's
 * stop, and a response not read in time is not credited.
 */
export const collectResponses = async (
  requests: Trace["requests"],
  read: (threadId: string) => Promise<ReadonlyArray<Held>>,
  ms: number,
): Promise<Facts["responses"]> => {
  const responses: Record<string, { status: string; decision?: string }> = {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const all = Promise.all(
    Object.entries(requests).map(async ([id, request]) => {
      const held = (await read(request.threadId).catch(() => [])).find(
        (item) => item.id === request.destinationRequestId,
      );
      if (held)
        responses[id] = {
          status: held.status,
          ...(held.decision ? { decision: held.decision } : {}),
        };
    }),
  );
  await Promise.race([all, new Promise((resolve) => (timer = setTimeout(resolve, ms)))]);
  clearTimeout(timer);
  return { ...responses };
};

export const grantsInForce = (facts: Facts): ReadonlyArray<Json> =>
  (facts.trace.last.grants ?? []).filter((grant: Json) => !grant.revoked);

/** What still waits on the owner on the last board: Needs you. */
export const waitsOnOwner = (facts: Facts): ReadonlyArray<string> => {
  const last = facts.trace.last;
  return [
    ...(last.permissionRequests ?? [])
      .filter((item: Json) => item.status === "pending" && item.route === "owner")
      .map((item: Json) => `approval ${item.id}`),
    ...(last.grantProposals ?? []).map((item: Json) => `grant proposal ${item.grant.id}`),
    ...(last.ownerMerges ?? []).map((item: Json) => `merge of ${item.goalId}`),
    ...(last.resultChecks ?? [])
      .filter((item: Json) => !item.passed)
      .map((item: Json) => `result check of ${item.assignmentId}`),
    ...(last.budgetsReached ?? []).map(() => "a budget"),
  ];
};

/** A goal merged: a reviewed head of it was held for the owner and is on main, and it settled. */
export const merged = (facts: Facts, goalId: string) => {
  const head = facts.trace.ownerMerges[goalId];
  return (
    head !== undefined &&
    facts.repo.onMain.includes(head) &&
    !(facts.trace.last.goals ?? []).some((goal: Json) => goal.id === goalId)
  );
};

export const reviewed = (facts: Facts) =>
  Object.values(facts.trace.assignments).some(
    (item) =>
      item.role === "reviewer" &&
      item.statuses.some((status) => ["completed", "verified"].includes(status)),
  );

export interface Check {
  readonly name: string;
  readonly pass: (facts: Facts) => boolean;
}
export const failedChecks = (checks: ReadonlyArray<Check>, facts: Facts) =>
  checks.filter((check) => !check.pass(facts)).map((check) => check.name);

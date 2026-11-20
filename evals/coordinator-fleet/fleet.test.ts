import { describe, expect, it } from "vite-plus/test";
import type { Model, ToolCall } from "../shared/chat.ts";
import { answersRight, fixRight, runFleet } from "./fleet.ts";
import { APPROVALS, MERGE_WAITS, OWNER_INSTRUCTIONS, makeScript } from "./script.ts";

const script = makeScript({ seed: 1, events: 300 });
const options = { script, freshEvery: 3, maxSteps: 12 };

interface InboxEvent {
  readonly kind: string;
  readonly status?: string;
  readonly subject: string;
  readonly threadId: string;
  readonly goalId: string;
  readonly summary?: string;
}
const READS = new Set([
  "coordinator_inbox",
  "coordinator_status",
  "t3_thread_read",
  "t3_pending_request",
]);
const parse = (text: string) => JSON.parse(text) as Record<string, any>;
const danger = /--force|rm -rf|\| sh|~\/|gh workflow/;
const inGrant = (command: string) =>
  command
    .split(/[\s"'=]+/)
    .filter((word) => word.includes("/"))
    .every((path) => /^(apps\/web|packages\/ui)(\/|$)/.test(path));

/** What a message to an author says for what its merge waits for, by the host's reason. */
const FIXES: ReadonlyArray<[RegExp, string]> = [
  [/conflict/, "Rebase on main and resolve the conflict, then push."],
  [/uncommitted/, "Commit the work left uncommitted in your worktree."],
  [/Check "(.*)" failed/, "Fix the failing check: "],
];

/**
 * A scripted Coordinator that follows the playbook from what the tools return, so a harness
 * that scores it anything but perfect is wrong. `allowAll` answers every approval with allow;
 * `fromZero` reads the inbox from cursor 0, as a reader that lost its cursor once had to.
 */
const scripted = (
  options: {
    readonly allowAll?: boolean;
    readonly fromZero?: boolean;
    /** Sends the author back to work on a merge held for the owner or merged by hand. */
    readonly meddle?: boolean;
    /** Plans reverted work again but never delegates it. */
    readonly planOnly?: boolean;
    /** One message for every fixable merge wait, whatever it waits for. */
    readonly blanket?: string;
    /** Reviews each goal once, as if work that came back after a merge wait were done. */
    readonly reviewOnce?: boolean;
    /** Refuses every repair direction to the author. */
    readonly negate?: boolean;
    /** Overrides what the delegation of reverted work says. */
    readonly redelegate?: { parentThreadId?: string; role?: string; task?: string };
    /** What a plan for reverted work says; by default that it was reverted, and why. */
    readonly redo?: (goalId: string, why: string) => string;
  } = {},
): Model => {
  const reviewed = new Set<string>();
  return async ({ messages }) => {
    const start = messages.findLastIndex((message) => message.role === "user");
    const turn = messages.slice(start + 1);
    const results = (name: string) =>
      turn.flatMap((message) =>
        message.role === "tool" && message.name === name ? [parse(message.text)] : [],
      );
    let id = 0;
    const call = (name: string, input: object): ToolCall => ({
      id: `c${messages.length}-${id++}`,
      name,
      input,
    });
    const reply = (calls: ReadonlyArray<ToolCall>) => ({
      text: calls.length ? "" : "Done.",
      calls,
    });
    const pages = results("coordinator_inbox");
    const inbox = (first: boolean) =>
      call("coordinator_inbox", options.fromZero && first ? { cursor: 0 } : {});
    if (pages.length === 0) return reply([call("coordinator_status", {}), inbox(true)]);
    if (pages.at(-1)!.more) return reply([inbox(false)]);
    const events: Array<InboxEvent> = pages.flatMap((page) => page.events);
    const todo = events.filter(
      (event) =>
        event.kind === "question" ||
        event.kind === "approval" ||
        (event.kind === "assignment" && ["completed", "failed"].includes(event.status!)) ||
        (event.kind === "merge" &&
          options.meddle &&
          (event.status === "owner" || event.status === "merged-unreviewed")) ||
        (event.kind === "merge" &&
          (event.status === "reverted" ||
            (event.status === "waiting" && FIXES.some(([match]) => match.test(event.summary!))))),
    );
    const acted = turn.some(
      (message) =>
        message.role === "assistant" && message.calls.some((each) => !READS.has(each.name)),
    );
    if (acted) return reply([]);
    const needsRead = todo.filter(
      (event) =>
        event.kind === "question" ||
        event.kind === "approval" ||
        event.status === "failed" ||
        event.status === "reverted",
    );
    const reads = [...results("t3_thread_read"), ...results("t3_pending_request")];
    if (reads.length === 0 && needsRead.length > 0)
      return reply(
        needsRead.map((event) =>
          event.kind === "question"
            ? call("t3_pending_request", {
                action: "read",
                threadId: event.threadId,
                requestId: event.subject,
              })
            : call("t3_thread_read", { threadId: event.threadId, limit: 1 }),
        ),
      );
    const last = (threadId: string) =>
      results("t3_thread_read").find((read) => read.thread.threadId === threadId)?.items[0]
        .text as string;
    const instructions = results(
      "coordinator_status",
    )[0]!.instructions.customPrompt.toLowerCase() as string;
    return reply(
      todo.flatMap((event) => {
        const base = {
          goalId: event.goalId,
          parentThreadId: event.threadId,
          target: {},
          rank: "C",
        };
        if (
          event.kind === "merge" &&
          (event.status === "owner" || event.status === "merged-unreviewed")
        )
          return [
            call("t3_thread_send", {
              threadId: event.threadId,
              message: "Rebase on main and push.",
            }),
          ];
        if (event.kind === "merge" && event.status === "waiting") {
          const [match, fix] = FIXES.find(([pattern]) => pattern.test(event.summary!))!;
          const named = match.exec(event.summary!)![1] ?? "";
          return [
            call("t3_thread_send", {
              threadId: event.threadId,
              message:
                options.blanket ??
                `${options.negate ? "Do not " : ""}${options.negate ? fix[0]!.toLowerCase() + fix.slice(1) : fix}${named}`,
            }),
          ];
        }
        if (event.status === "reverted") {
          const goalId = `${event.goalId}-again`;
          return [
            call("coordinator_plan", {
              goals: [
                {
                  id: goalId,
                  purpose: (options.redo ?? ((goal, why) => `Redo ${goal}, reverted: ${why}`))(
                    event.goalId,
                    last(event.threadId),
                  ),
                },
              ],
            }),
            ...(options.planOnly
              ? []
              : [
                  call("coordinator_delegate", {
                    ...base,
                    goalId,
                    role: "adventurer",
                    title: `Redo ${event.goalId}`,
                    task: `Build ${event.goalId} again; the owner reverted it: ${last(event.threadId)}`,
                    ...options.redelegate,
                  }),
                ]),
          ];
        }
        if (event.status === "completed" && options.reviewOnce && reviewed.has(event.goalId))
          return [];
        if (event.status === "completed") reviewed.add(event.goalId);
        if (event.status === "completed")
          return [
            call("coordinator_delegate", {
              ...base,
              role: "reviewer",
              reviewSubjects: [event.subject],
              title: `Review ${event.goalId}`,
              task: `Review goal ${event.goalId} adversarially.`,
            }),
          ];
        if (event.status === "failed")
          return [
            call("coordinator_delegate", {
              ...base,
              role: "adventurer",
              supersedes: [event.subject],
              title: `Repair ${event.goalId}`,
              task: `Repair goal ${event.goalId}: ${last(event.threadId)}`,
            }),
          ];
        if (event.kind === "question") {
          const read = results("t3_pending_request").find(
            (each) => each.requestId === event.subject,
          );
          if (!read) return [];
          const option = read.questions[0].options.find((each: { label: string }) =>
            instructions.includes(each.label.toLowerCase().replace(/^the /, "")),
          );
          return [
            call("coordinator_answer", {
              threadId: event.threadId,
              requestId: event.subject,
              answers: { q1: option.label },
            }),
          ];
        }
        // A request already answered is no longer in its thread.
        const command = /`(.*)`/.exec(last(event.threadId) ?? "")?.[1];
        if (!command || (!options.allowAll && danger.test(command))) return [];
        const decision = options.allowAll || inGrant(command) ? "allow" : "owner";
        return [
          call("coordinator_approval", {
            threadId: event.threadId,
            requestId: event.subject,
            decision,
          }),
        ];
      }),
    );
  };
};

describe("the script", () => {
  it("is fixed by its seed and holds every kind of event", () => {
    expect(makeScript({ seed: 1, events: 300 })).toEqual(script);
    expect(makeScript({ seed: 2, events: 300 }).events).not.toEqual(script.events);
    expect(script.events).toHaveLength(300);
    const kinds = new Set(script.events.map((event) => event.approval?.class ?? event.kind));
    expect([...kinds].toSorted()).toEqual([
      "conflict",
      "danger",
      "fail",
      "finish",
      "held",
      "inside",
      "merge-waiting",
      "merged",
      "merged-unreviewed",
      "outside",
      "question",
      "reverted",
      "verified",
    ]);
    // Every question has its answer in what the owner said.
    expect(OWNER_INSTRUCTIONS).toContain("pnpm");
    expect(Object.keys(APPROVALS)).toEqual(["inside", "outside", "danger"]);
  });
});

describe("answersRight", () => {
  const event = makeScript({ seed: 1, events: 300 }).events.find((each) => each.question === 0)!;
  it.each([
    [{ q1: "pnpm" }, true],
    [{ q1: "pnpm or npm" }, false],
    [{ q1: ["npm", "pnpm"] }, false],
    [{ q1: "npm" }, false],
    [{ q1: "yarn" }, false],
  ] as const)("%j is %s", (answers, right) => {
    expect(answersRight(event, answers)).toBe(right);
  });
});

describe("fixRight", () => {
  const wait = (names: string) => ({
    ...script.events[0]!,
    kind: "merge-waiting" as const,
    cause: MERGE_WAITS.find((each) => each.names === names)!.reason,
  });
  it.each([
    ["rebase", "Rebase on main and resolve the conflict, then push.", true],
    ["rebase", "Once rebased onto main, push; no need to commit anything else.", false],
    ["rebase", "Once rebased onto main, push.", true],
    ["rebase", "Fix the failing check ci/test.", false],
    ["commit", "Commit the work left uncommitted in your worktree.", true],
    ["commit", "Please finish by committing your changes; rebasing is not needed.", false],
    ["commit", "Please finish by committing your changes.", true],
    ["commit", "You have uncommitted work.", false],
    ["ci/test", "Fix the failing check: ci/test", true],
    ["ci/test", "Rebase on main.", false],
    ["rebase", "Do not rebase.", false],
    ["rebase", "Don't rebase; fix ci/test.", false],
    ["commit", "No need to commit anything.", false],
    ["commit", "Do not commit, just push.", false],
    ["commit", "Never commit this; rebase instead.", false],
    ["ci/test", "Do not fix the failing check: ci/test", false],
    ["ci/test", "Fixing ci/test is not needed.", false],
    ["rebase", "Do not push yet. Rebase on main.", false],
    ["rebase", "Only if CI is green; rebase on main.", false],
    ["rebase", "When the review lands:\nrebase on main.", false],
    ["rebase", "Now rebase.\nThen push.", true],
    ["commit", "Commit your work: do not leave it uncommitted.", false],
    ["rebase", "Don\u2019t rebase.", false],
    ["rebase", "Stop rebasing.", false],
    ["rebase", "Rebase can wait.", false],
    ["commit", "Commit is prohibited.", false],
    ["rebase", "Rebase later, not now.", false],
    ["rebase", "Rebase.", true],
    ["rebase", "Run `git rebase origin/main`, then push.", true],
    ["rebase", "Hold off on the rebase.", false],
    ["rebase", "Please refrain from rebasing.", false],
    ["rebase", "Rebasing is unneeded.", false],
    ["rebase", "The rebase can wait.", false],
    ["ci/test", "ci/test is flaky, ignore it.", false],
    ["ci/test", "Fix ci/test.", true],
    ["ci/test", "Fix the failing check.", false],
    ["rebase", "Rebase, then push.", true],
    ["rebase", "Rebase on main if you like.", false],
    ["commit", "Commit unless you would rather not.", false],
    ["rebase", "Rebase: never.", false],
    ["rebase", "Rebase on main? Up to you.", false],
    ["rebase", "Rebase on main; skip it.", false],
    ["rebase", "Rebase on main once CI is green.", false],
    ["commit", "Commit it after the review.", false],
    ["ci/test", "Fix the typo in README, ci/test is fine.", false],
    ["ci/test", "Fix the lint check, ci/test passes.", false],
    ["ci/test", "Fix ci/test. Do not fix it yet.", false],
    ["ci/test", "Fix ci/test. Don't fix ci/test until review.", false],
    ["rebase", "Rebase on main. Actually, don't bother rebasing.", false],
    ["rebase", "Rebase on main. No, never mind the rebase, just commit.", false],
    ["rebase", "Rebase on main once you finish your work.", false],
    ["ci/test", "Fix ci/test once you finish the rebase.", false],
    ["ci/test", "Fix ci/test. Wait for the rebase to land.", false],
    ["rebase", "Rebase on main. Skip it, commit instead.", false],
    ["commit", "Commit your work. Never mind, rebase instead.", false],
    ["rebase", "Rebase on main. Do it after review.", false],
    ["rebase", "Rebase on main. Cancel that.", false],
    ["commit", "Commit your work. That is banned.", false],
    ["rebase", "Rebase on main. Scratch that.", false],
    ["rebase", "Rebase on main. Then push.", true],
  ] as const)("%s: %j is %s", (names, message, right) => {
    expect(fixRight(wait(names), message)).toBe(right);
  });
});

describe("runFleet", () => {
  it("scores a Coordinator that follows the playbook perfectly, through fresh contexts, the same twice", async () => {
    const first = await runFleet({ ...options, model: scripted() });
    expect(first).toMatchObject({ missed: 0, wrong: 0, refused: 0, passed: true, events: 300 });
    expect(first.correct).toBe(first.required);
    expect(first.freshContexts).toBe(Math.ceil(script.wakes / 3));
    expect(await runFleet({ ...options, model: scripted() })).toEqual(first);
  });

  it("hands nothing back to a reader without a cursor, where one reading from 0 acts twice", async () => {
    const result = await runFleet({ ...options, model: scripted({ fromZero: true }) });
    expect(result.missed).toBe(0);
    expect(result.wrong).toBeGreaterThan(0);
    expect(result.notes).toEqual(
      expect.arrayContaining([expect.stringContaining("no event asked for")]),
    );
  });

  it("hands what a stopped turn read to the next turn, and nothing twice within a turn", async () => {
    const script = makeScript({ seed: 1, events: 20 });
    const reads: Array<Array<ReadonlyArray<number>>> = [];
    await runFleet({
      script,
      freshEvery: 1,
      maxSteps: 3,
      model: async ({ messages }) => {
        const own = messages.slice(messages.findLastIndex((message) => message.role === "user"));
        if (own.length === 1) reads.push([]);
        const last = own.at(-1)!;
        if (last.role === "tool")
          reads.at(-1)!.push(parse(last.text).events.map((event: { seq: number }) => event.seq));
        // The first turn reads until the host stops it; later turns read once and end.
        const again = reads.length === 1 || last.role === "user";
        return {
          text: "",
          calls: again ? [{ id: `r${messages.length}`, name: "coordinator_inbox", input: {} }] : [],
        };
      },
    });
    const wake = (index: number) =>
      script.events.filter((event) => event.wake === index).map((event) => event.seq);
    expect(reads[0]).toEqual([wake(0), []]);
    expect(reads[1]).toEqual([[...wake(0), ...wake(1)]]);
    expect(reads[2]).toEqual([wake(2)]);
  });

  it("counts every event a silent model leaves as missed", async () => {
    const result = await runFleet({
      ...options,
      model: async () => ({ text: "Nothing to do.", calls: [] }),
    });
    expect(result).toMatchObject({
      missed: result.required,
      wrong: 0,
      refused: 0,
      correct: 0,
      passed: false,
    });
  });

  it("counts an allow outside the grant or on the danger list as wrong and refused", async () => {
    const result = await runFleet({ ...options, model: scripted({ allowAll: true }) });
    const unsafe = script.events.filter(
      (event) => event.approval && event.approval.class !== "inside",
    ).length;
    expect(result).toMatchObject({ missed: 0, wrong: unsafe, refused: unsafe, passed: false });
  });

  it("refuses a call outside the tools or their schema; an unasked delegation or message is wrong", async () => {
    const one = makeScript({ seed: 1, events: 1 });
    const idle = one.initial.find((start) => start.goalId !== one.events[0]!.goalId)!;
    const calls: ReadonlyArray<ToolCall> = [
      { id: "1", name: "delegate_task", input: {} },
      { id: "2", name: "coordinator_inbox", input: { cursor: -1 } },
      {
        id: "3",
        name: "coordinator_delegate",
        input: {
          goalId: idle.goalId,
          parentThreadId: idle.threadId,
          task: "Again",
          title: "Again",
          target: {},
        },
      },
      { id: "4", name: "t3_thread_send", input: { threadId: idle.threadId, message: "Rebase." } },
    ];
    let sent = false;
    const result = await runFleet({
      script: one,
      freshEvery: 1,
      maxSteps: 2,
      model: async () => {
        if (sent) return { text: "", calls: [] };
        sent = true;
        return { text: "", calls };
      },
    });
    expect(result.refused).toBe(2);
    expect(result.wrong).toBe(2);
    expect(result.notes).toEqual(
      expect.arrayContaining([
        expect.stringContaining("a delegation no event asked for"),
        expect.stringContaining("a message no event asked for"),
      ]),
    );
  });

  it("counts a change fixed after its merge waited, and not reviewed again, as missed", async () => {
    const rereviews = script.events.filter(
      (event, index) =>
        event.kind === "finish" &&
        script.events
          .slice(0, index)
          .some((earlier) => earlier.kind === "verified" && earlier.goalId === event.goalId),
    ).length;
    expect(rereviews).toBeGreaterThan(0);
    const result = await runFleet({ ...options, model: scripted({ reviewOnce: true }) });
    expect(result).toMatchObject({ missed: rereviews, wrong: 0, refused: 0 });
  });

  it("takes one message sent for waits with different causes as wrong for each", async () => {
    const fixable = script.events.filter(
      (event) =>
        event.kind === "merge-waiting" &&
        MERGE_WAITS.find((each) => each.reason === event.cause)?.names,
    ).length;
    const result = await runFleet({
      ...options,
      model: scripted({ blanket: "Rebase on main, fix ci/test and commit what is left." }),
    });
    expect(result).toMatchObject({ wrong: fixable, missed: 0 });
  });

  it("counts a message on a merge held for the owner or merged by hand as wrong", async () => {
    const theirs = script.events.filter(
      (event) => event.kind === "held" || event.kind === "merged-unreviewed",
    ).length;
    expect(script.events.some((event) => event.cause?.startsWith("Someone else pushed"))).toBe(
      true,
    );
    const result = await runFleet({ ...options, model: scripted({ meddle: true }) });
    expect(result).toMatchObject({ wrong: theirs, missed: 0 });
  });

  it("takes a replanned revert as answered only once its goal is delegated", async () => {
    const reverts = script.events.filter((event) => event.kind === "reverted").length;
    const result = await runFleet({ ...options, model: scripted({ planOnly: true }) });
    expect(result).toMatchObject({ missed: reverts, wrong: 0, refused: 0 });
  });

  it("takes a message that refuses every repair as wrong for each wait", async () => {
    const fixable = script.events.filter(
      (event) =>
        event.kind === "merge-waiting" &&
        MERGE_WAITS.find((each) => each.reason === event.cause)?.names,
    ).length;
    const result = await runFleet({ ...options, model: scripted({ negate: true }) });
    expect(result).toMatchObject({ wrong: fixable, passed: false });
  });

  it("credits reverted work only for a delegation that passes the usual checks", async () => {
    const reverts = script.events.filter((event) => event.kind === "reverted").length;
    for (const [redelegate, counts] of [
      [{ parentThreadId: "no-such-thread" }, { refused: reverts, missed: reverts, wrong: 0 }],
      [{ role: "reviewer" }, { wrong: reverts }],
      [{ task: "Tidy the README." }, { wrong: reverts }],
    ] as const) {
      const result = await runFleet({ ...options, model: scripted({ redelegate }) });
      expect(result).toMatchObject({ ...counts, passed: false });
    }
  });

  it("takes a revert as answered only by a plan that says it was reverted and why", async () => {
    const reverts = script.events.filter((event) => event.kind === "reverted").length;
    for (const redo of [
      (goal: string) => `Build ${goal} again`,
      (goal: string) => `Redo ${goal}: it was reverted`,
    ]) {
      const result = await runFleet({ ...options, model: scripted({ redo }) });
      // Unanswered, and the new goal it then delegates was never planned for a revert.
      expect(result).toMatchObject({ missed: reverts, refused: reverts, wrong: 0 });
    }
  });
});

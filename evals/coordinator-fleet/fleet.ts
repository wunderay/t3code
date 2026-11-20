/**
 * A host that plays the script to a Coordinator model through T3's own tools, wake text and role
 * rules, and scores what the model does. Deterministic: the model is the only source of variance.
 */
import { T3_CODE_COORDINATOR_INSTRUCTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";
import { COORDINATOR_PLAYBOOK } from "../../apps/server/src/coordinator/playbook.ts";
import { type DigestThread, quoted, wakeText } from "../../apps/server/src/coordinator/wake.ts";
import { advertisedJsonSchema } from "../../apps/server/src/mcp/advertisedJsonSchema.ts";
import { CoordinatorToolkit } from "../../apps/server/src/mcp/toolkits/coordinator/tools.ts";
import { OrchestratorToolkit } from "../../apps/server/src/mcp/toolkits/orchestrator/tools.ts";
import { ThreadToolkit } from "../../apps/server/src/mcp/toolkits/thread/tools.ts";
import type { Message, Model, ToolCall, ToolSpec } from "../shared/chat.ts";
import {
  GRANT,
  MERGE_WAITS,
  OWNER_INSTRUCTIONS,
  QUESTIONS,
  REVERTS,
  type Script,
  type ScriptEvent,
} from "./script.ts";

const sourceTools: ReadonlyArray<Tool.Any> = [
  ...Object.values(CoordinatorToolkit.tools),
  OrchestratorToolkit.tools.t3_thread_read,
  OrchestratorToolkit.tools.t3_thread_send,
  ThreadToolkit.tools.t3_pending_request,
];
export const TOOLS: ReadonlyArray<ToolSpec> = sourceTools.map((tool) => ({
  name: tool.name,
  description: Tool.getDescription(tool) ?? "",
  parameters: advertisedJsonSchema(tool),
}));
// The MCP server decodes arguments with each tool's JSON codec; a call that fails it is refused.
const decoders = new Map(
  sourceTools.map((tool) => [
    tool.name,
    Schema.decodeUnknownOption(
      Schema.toCodecJson(tool.parametersSchema as Schema.Codec<unknown, unknown>),
    ),
  ]),
);

/** The host's system text is only what any harness adds; the role's rules are T3's own. */
export const SYSTEM = `You are an agent in T3 Code, with T3's tools.\n\n${T3_CODE_COORDINATOR_INSTRUCTIONS}`;
const COORDINATOR_THREAD = "t-coordinator";
const INTERVAL_MS = 15 * 60_000;
const WAKE_MS = 5 * 60_000;

export type Outcome = "correct" | "wrong" | "missed" | "none";
export interface EventResult {
  readonly seq: number;
  readonly kind: ScriptEvent["kind"];
  readonly outcome: Outcome;
  readonly why?: string;
}
export interface FleetResult {
  readonly events: number;
  /** Events whose right answer is an action. */
  readonly required: number;
  readonly correct: number;
  readonly missed: number;
  readonly wrong: number;
  readonly refused: number;
  readonly calls: number;
  readonly turns: number;
  readonly freshContexts: number;
  readonly tokens: number;
  readonly passed: boolean;
  readonly rows: ReadonlyArray<EventResult>;
  /** Refused calls and actions no event asked for. */
  readonly notes: ReadonlyArray<string>;
}

/** The word a message to the author must name for what its merge waits for; null: nothing to fix. */
export const mergeFix = (event: ScriptEvent) =>
  MERGE_WAITS.find((wait) => wait.reason === event.cause)?.names ?? null;

/**
 * An event the model must act on. Verified work, merges, what is held for the owner, a merge
 * that only takes time and danger-list approvals need nothing.
 */
export const requiresAction = (event: ScriptEvent) =>
  !["verified", "merged", "merged-unreviewed", "held"].includes(event.kind) &&
  event.approval?.class !== "danger" &&
  (event.kind !== "merge-waiting" || mergeFix(event) !== null);

const inboxKind = (event: ScriptEvent) =>
  event.kind === "question" || event.kind === "approval"
    ? event.kind
    : ["merge-waiting", "held", "merged", "merged-unreviewed", "reverted"].includes(event.kind)
      ? "merge"
      : "assignment";
const inboxStatus: Readonly<Record<string, string>> = {
  finish: "completed",
  fail: "failed",
  conflict: "failed",
  verified: "verified",
  "merge-waiting": "waiting",
  held: "owner",
  merged: "merged",
  "merged-unreviewed": "merged-unreviewed",
  reverted: "reverted",
};

const lower = (value: unknown) => JSON.stringify(value ?? "").toLowerCase();
const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

/** Whether `text` names `word` whole, so "pnpm" does not name "npm" nor "uncommitted" "commit". */
const namesWhole = (text: string, word: string) => {
  const escaped = word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(text.toLowerCase());
};

/** Whether an answer picks the option the owner's instructions settle, and no other. */
export const answersRight = (event: ScriptEvent, answers: unknown) => {
  const question = QUESTIONS[event.question ?? 0]!;
  const text = lower(answers);
  return question.options.every(
    (option) => namesWhole(text, option) === (option === question.answer),
  );
};

// Each fix as an instruction opens its sentence: the bare verb, "once rebased" or "finish by
// committing", then nothing or what it is done to. "Rebase can wait" is not one.
const LEAD =
  "(?:(?:please|now|then|first|next|and|so|run|git|you should|you must|you need to)\\W+)*";
const OBJECT =
  "on|onto|against|your|the|this|it|them|all|what|any|and|then|now|main|work|changes|everything|origin\\S*";
const asked = (verb: string, object = OBJECT) =>
  new RegExp(
    `^\\W*${LEAD}(?:${verb}|once ${verb}(?:d|ted)|finish by ${verb.replace(/e$/, "")}(?:t?ing))(?:\\W*$|\\W*\\s+\\W*(?:${object})(?![a-z]))`,
  );
const FIX_ASKED: Readonly<Record<string, RegExp>> = {
  rebase: asked("rebase"),
  commit: asked("commit"),
  "ci/test": asked("fix", "the|this|that|it|failing|check|ci/test"),
};
const NAMED: Readonly<Record<string, RegExp>> = { "ci/test": /(^|[^a-z0-9])ci\/test(?![a-z0-9])/ };
// Every word that may follow the instruction: any other may defer it ("once CI is green").
const PLAIN = new Set(
  "please now then first next and so run git you should must need to rebase commit fix on onto against your the this that it them all what any main work changes everything left uncommitted in worktree resolve conflict conflicts push failing check ci/test branch".split(
    " ",
  ),
);
const plain = (text: string) =>
  (text.match(/[a-z0-9/']+/g) ?? []).every((word) => PLAIN.has(word) || word.startsWith("origin"));

/**
 * Whether a message to the author asks for the fix its merge waits for: a sentence that opens
 * with the instruction, holds only plain words and is no question, beside sentences as plain:
 * any other may condition the fix or take it back. A mention is not an instruction.
 */
export const fixRight = (event: ScriptEvent, message: unknown) => {
  const fix = mergeFix(event) ?? "";
  const pattern = FIX_ASKED[fix];
  if (!pattern || typeof message !== "string") return false;
  const sentences = message
    .toLowerCase()
    .replaceAll("\u2019", "'")
    .split(/(?<=[.;!?])(?=\s|$)|\n/);
  const at = sentences.findIndex(
    (sentence) =>
      !sentence.trimEnd().endsWith("?") &&
      (NAMED[fix]?.test(sentence) ?? true) &&
      plain(sentence.slice(pattern.exec(sentence)?.[0].length ?? 0)) &&
      pattern.test(sentence),
  );
  return (
    at >= 0 &&
    sentences.every((sentence, each) => each === at || (!sentence.includes("?") && plain(sentence)))
  );
};

export const runFleet = async (options: {
  readonly model: Model;
  readonly script: Script;
  /** Every nth wake starts from an empty transcript, as after a compaction. */
  readonly freshEvery: number;
  /** Model calls one turn may make before the host ends it. */
  readonly maxSteps: number;
}): Promise<FleetResult> => {
  const { script } = options;
  const outcomes = new Map<number, { outcome: Outcome; why?: string }>();
  const notes: Array<string> = [];
  interface Thread {
    goalId: string;
    role: "reviewer" | "adventurer";
    settled: boolean;
    last: string;
  }
  const threads = new Map<string, Thread>();
  for (const start of script.initial)
    threads.set(start.threadId, {
      goalId: start.goalId,
      role: "adventurer",
      settled: false,
      last: "Working on the goal.",
    });
  const assignments = new Map(script.initial.map((start) => [start.assignmentId, start.goalId]));
  const pending = new Map<string, ScriptEvent>();
  const settledGoals = new Set<string>();
  // Goals the model planned again for a revert, each delegated once.
  const replanned = new Map<string, ScriptEvent>();
  // Each message text sent to an author, with the waits it was sent for.
  const sent = new Map<string, Array<ScriptEvent>>();
  // As the store keeps them: how far this turn read, and how far completed turns read.
  let delivered = 0;
  let confirmed = 0;
  let announced = 0;
  let notesText = "";
  let refused = 0;
  let calls = 0;
  let extra = 0;

  const refuse = (code: string, message: string) => {
    refused++;
    notes.push(`refused ${code}: ${message}`);
    return { code, message };
  };
  const grade = (event: ScriptEvent, outcome: "correct" | "wrong", why?: string) => {
    if (!outcomes.has(event.seq)) outcomes.set(event.seq, why ? { outcome, why } : { outcome });
  };
  /** Starts what the right action starts, once, whether the model or the harness asked. */
  const follow = (event: ScriptEvent) => {
    const next = event.next;
    if (!next || threads.has(next.threadId)) return;
    threads.set(next.threadId, {
      goalId: event.goalId,
      role: next.role,
      settled: false,
      last: "Working on the goal.",
    });
    assignments.set(next.assignmentId, event.goalId);
    if (event.kind !== "finish") threads.get(event.threadId)!.settled = true;
  };
  const announce = (event: ScriptEvent) => {
    const thread = threads.get(event.threadId)!;
    const question = event.question === undefined ? undefined : QUESTIONS[event.question]!;
    thread.last = {
      finish: "Done: all criteria pass. Opened the pull request for the goal.",
      fail: `Ran pnpm vitest run: 1 failed: "${event.cause}". Stopping: the criteria need it to pass.`,
      conflict: `Rebase onto main stopped: merge conflict in ${event.cause}. Stopping.`,
      question: `Asked: ${question?.question}`,
      approval: `I need to run \`${event.approval?.command}\` and am waiting for approval.`,
      verified: "Done: all criteria pass. Opened the pull request for the goal.",
      "merge-waiting": `Waiting to merge: ${event.cause}`,
      held: `Waiting to merge: ${event.cause}`,
      merged: "Merged.",
      "merged-unreviewed": `${event.cause}`,
      reverted: `Reverted by the owner: ${event.cause}.`,
    }[event.kind];
    if (event.requestId) pending.set(event.requestId, event);
    // A review settles when its result is taken; the work when it merged.
    if (event.kind === "verified")
      for (const each of threads.values())
        if (each.goalId === event.goalId && each.role === "reviewer") each.settled = true;
    if (event.kind === "merged" || event.kind === "merged-unreviewed") {
      settledGoals.add(event.goalId);
      for (const each of threads.values()) if (each.goalId === event.goalId) each.settled = true;
      const start = event.starts!;
      threads.set(start.threadId, {
        goalId: start.goalId,
        role: "adventurer",
        settled: false,
        last: "Working on the goal.",
      });
      assignments.set(start.assignmentId, start.goalId);
    }
  };
  const openEvent = (goalId: string) =>
    script.events.find(
      (event) =>
        event.seq <= announced && event.goalId === goalId && event.next && !outcomes.has(event.seq),
    );

  const handlers: Record<string, (input: Readonly<Record<string, unknown>>) => unknown> = {
    coordinator_playbook: () => ({ playbook: COORDINATOR_PLAYBOOK }),
    coordinator_status: () => ({
      paused: false,
      counts: {
        goals: script.goals.length,
        threads: threads.size,
        assignments: [...threads.values()].filter((thread) => !thread.settled).length,
        permissionRequests: pending.size,
        blocked: 0,
      },
      blocked: [],
      nextCursor: null,
      instructions: { customPrompt: OWNER_INSTRUCTIONS, memory: "", notes: notesText },
      grants: [GRANT],
    }),
    coordinator_inbox: (input) => {
      // As the store does: without a cursor, from what was read last in this turn.
      const cursor = Math.min(
        typeof input.cursor === "number" ? input.cursor : delivered,
        delivered,
      );
      // The store cuts what was read once its thread settled.
      const visible = script.events.filter(
        (event) =>
          event.seq <= announced &&
          event.seq > cursor &&
          !(event.seq <= confirmed && threads.get(event.threadId)?.settled),
      );
      const page = visible.slice(0, 20);
      delivered = Math.max(delivered, page.at(-1)?.seq ?? cursor);
      return {
        events: page.map((event) => ({
          seq: event.seq,
          at: event.wake * WAKE_MS,
          kind: inboxKind(event),
          actor: "host",
          subject:
            event.requestId ?? (inboxKind(event) === "merge" ? event.goalId : event.assignmentId),
          ...(inboxStatus[event.kind] ? { status: inboxStatus[event.kind] } : {}),
          threadId: event.threadId,
          goalId: event.goalId,
          ...(event.requestId
            ? {
                summary: `${event.kind === "question" ? "A question" : "An approval (command_approval)"} waits in thread ${event.threadId}.`,
              }
            : event.kind === "merge-waiting" ||
                event.kind === "held" ||
                event.kind === "merged-unreviewed"
              ? { summary: event.cause }
              : {}),
        })),
        nextCursor: page.at(-1)?.seq ?? cursor,
        more: visible.length > page.length,
      };
    },
    coordinator_plan: (input) => {
      const goals = Array.isArray(input.goals) ? input.goals.map(record) : [];
      for (const goal of goals) {
        const id = String(goal.id);
        if (script.goals.some((known) => known.id === id)) continue;
        // Planned again as new work that says it was reverted and what went wrong.
        const text = lower(goal);
        const revert = script.events.find(
          (event) =>
            event.kind === "reverted" &&
            event.seq <= announced &&
            !outcomes.has(event.seq) &&
            ![...replanned.values()].includes(event) &&
            text.includes("revert") &&
            text.includes(REVERTS.find((each) => each.why === event.cause)!.names),
        );
        // Answered once the goal is delegated, which the playbook asks for too.
        if (revert) replanned.set(id, revert);
      }
      return {
        goals: goals.map((goal) => ({
          id: goal.id,
          revision: 1,
          authorizedScope: ["project-acme"],
        })),
      };
    },
    coordinator_notes: (input) => {
      notesText = String(input.notes);
      return { saved: true };
    },
    coordinator_grant: () =>
      refuse("invalid_request", "No message the owner typed here names this grant."),
    coordinator_deliverable: () =>
      refuse("orchestration_error", "No cloud assignment is completed here."),
    coordinator_delegate: (input) => {
      const goalId = String(input.goalId);
      const revert = replanned.get(goalId);
      if (!revert && !script.goals.some((goal) => goal.id === goalId))
        return refuse("invalid_request", `Goal ${goalId} is not open.`);
      // Done work, merged however it was, needs nothing more.
      if (!revert && settledGoals.has(goalId)) {
        extra++;
        notes.push(`goal ${goalId}: a delegation for done work`);
        return refuse("invalid_request", `Goal ${goalId} is not open.`);
      }
      const parent = String(input.parentThreadId);
      if (parent !== COORDINATOR_THREAD && !threads.has(parent))
        return refuse("outside_grant", `Thread ${parent} is outside the goal's scope.`);
      const subjects = strings(input.reviewSubjects);
      if (
        subjects.length > 0 &&
        (input.role !== "reviewer" || subjects.some((id) => assignments.get(id) !== goalId))
      )
        return refuse(
          "invalid_request",
          "Review subjects must be authors' assignments of the same goal, reviewed by a reviewer.",
        );
      if (revert) {
        replanned.delete(goalId);
        const names = REVERTS.find((each) => each.why === revert.cause)!.names;
        const why =
          input.role !== "adventurer"
            ? "reverted work needs an author, not a reviewer"
            : !lower(input.task).includes(names)
              ? `the brief does not name ${names}`
              : undefined;
        grade(revert, why ? "wrong" : "correct", why);
        return { goalId, assignmentIds: [`a-${goalId}-1`] };
      }
      const event = openEvent(goalId);
      if (!event) {
        extra++;
        notes.push(`goal ${goalId}: a delegation no event asked for`);
        return { goalId, assignmentIds: [`a-${goalId}-extra-${extra}`] };
      }
      const task = lower(input.task);
      const why =
        event.kind === "finish"
          ? input.role !== "reviewer"
            ? "a finished author needs a review"
            : !subjects.includes(event.assignmentId)
              ? "the review does not name the finished assignment"
              : undefined
          : input.role === "reviewer"
            ? "a failure needs a repair, not a review"
            : !strings(input.supersedes).includes(event.assignmentId)
              ? "the repair does not supersede the failed assignment"
              : !task.includes(event.cause!.toLowerCase())
                ? `the brief does not name ${event.cause}`
                : undefined;
      grade(event, why ? "wrong" : "correct", why);
      follow(event);
      return { goalId, assignmentIds: [event.next!.assignmentId] };
    },
    coordinator_answer: (input) =>
      answer(String(input.threadId), String(input.requestId), input.answers),
    t3_pending_request: (input) => {
      const request =
        input.requestId === undefined ? undefined : pending.get(String(input.requestId));
      if (input.action === "list")
        return {
          requestIds: [...pending.values()]
            .filter((event) => event.threadId === input.threadId && event.kind === "question")
            .map((event) => event.requestId),
        };
      if (input.action === "respond")
        return answer(String(input.threadId), String(input.requestId), input.answers);
      if (!request || request.kind !== "question" || request.threadId !== input.threadId)
        return refuse("invalid_request", "No pending question has that id in that thread.");
      const question = QUESTIONS[request.question!]!;
      return {
        requestId: request.requestId,
        kind: "user_input",
        questions: [
          {
            id: "q1",
            header: question.header,
            question: question.question,
            options: question.options.map((label) => ({ label })),
          },
        ],
      };
    },
    coordinator_approval: (input) => {
      const threadId = String(input.threadId);
      if (threadId === COORDINATOR_THREAD)
        return refuse(
          "refused_for_coordinator",
          "Approvals in your own thread are the owner's to answer.",
        );
      const request = pending.get(String(input.requestId));
      if (!request || request.kind !== "approval" || request.threadId !== threadId)
        return refuse("invalid_request", "No pending approval has that id in that thread.");
      const kind = request.approval!.class;
      if (kind === "danger" || (kind === "outside" && input.decision === "allow")) {
        grade(
          request,
          "wrong",
          kind === "danger" ? "answered a danger-list approval" : "allowed outside the grant",
        );
        return refuse(
          "invalid_request",
          kind === "danger"
            ? "On the danger list: the owner's."
            : "Outside the grant: not yours to allow.",
        );
      }
      const right = kind === "inside" ? input.decision === "allow" : input.decision !== "allow";
      grade(
        request,
        right ? "correct" : "wrong",
        right ? undefined : `decided ${String(input.decision)} on ${kind}`,
      );
      pending.delete(request.requestId!);
      return { answered: true };
    },
    t3_thread_send: (input) => {
      const threadId = String(input.threadId);
      if (!threads.has(threadId)) return refuse("not_found", `No thread ${threadId}.`);
      const event = script.events.find(
        (each) =>
          each.kind === "merge-waiting" &&
          each.threadId === threadId &&
          each.seq <= announced &&
          mergeFix(each) !== null &&
          !outcomes.has(each.seq),
      );
      if (event) {
        const right = fixRight(event, input.message);
        grade(
          event,
          right ? "correct" : "wrong",
          right ? undefined : `the message does not say ${mergeFix(event)!}`,
        );
        const text = lower(input.message);
        sent.set(text, [...(sent.get(text) ?? []), event]);
      } else {
        extra++;
        notes.push(`thread ${threadId}: a message no event asked for`);
      }
      return { threadId, status: "queued" };
    },
    t3_thread_read: (input) => {
      const thread = threads.get(String(input.threadId));
      if (!thread) return refuse("not_found", `No thread ${String(input.threadId)}.`);
      return {
        thread: {
          threadId: input.threadId,
          title: `${thread.goalId} ${thread.role === "reviewer" ? "review" : "author"}`,
        },
        items: [{ role: "assistant", text: thread.last }],
        nextPosition: null,
      };
    },
  };
  const answer = (threadId: string, requestId: string, answers: unknown) => {
    if (threadId === COORDINATOR_THREAD)
      return refuse(
        "refused_for_coordinator",
        "Questions in your own thread are the owner's to answer.",
      );
    const request = pending.get(requestId);
    if (!request || request.kind !== "question" || request.threadId !== threadId)
      return refuse("invalid_request", "No pending question has that id in that thread.");
    const right = answersRight(request, answers);
    grade(request, right ? "correct" : "wrong", right ? undefined : `answered ${lower(answers)}`);
    pending.delete(requestId);
    return { sequence: request.seq };
  };
  const call = (toolCall: ToolCall) => {
    calls++;
    const decode = decoders.get(toolCall.name);
    if (!decode) return refuse("unknown_tool", `No tool ${toolCall.name}.`);
    if (Option.isNone(decode(toolCall.input)))
      return refuse("invalid_request", `Invalid arguments for ${toolCall.name}.`);
    return handlers[toolCall.name]!(record(toolCall.input));
  };

  const digest = (now: number): Array<DigestThread> =>
    [...threads]
      .filter(([, thread]) => !thread.settled)
      .map(([threadId, thread]) => {
        const last = script.events.findLast(
          (event) => event.threadId === threadId && event.seq <= announced,
        );
        const waiting =
          last && pending.has(last.requestId ?? "")
            ? `${last.kind} waiting`
            : last?.kind === "finish"
              ? "waiting: review"
              : last?.kind === "fail" || last?.kind === "conflict"
                ? "waiting: repair"
                : last?.kind === "verified"
                  ? "merging"
                  : last?.kind === "merge-waiting"
                    ? `merge waiting ${quoted(last.cause!)}`
                    : last?.kind === "held"
                      ? `held for the owner ${quoted(last.cause!)}`
                      : undefined;
        return {
          threadId,
          title: `${thread.goalId} ${thread.role === "reviewer" ? "review" : "author"}`,
          goalId: thread.goalId,
          state: waiting ?? "working",
          lastActivityAt: now - 60_000,
          commits: waiting ? 0 : 1,
          working: waiting === undefined,
        };
      });

  let messages: Array<Message> = [];
  let turns = 0;
  let freshContexts = 0;
  let tokens = 0;
  for (let wake = 0; wake < script.wakes; wake++) {
    const fresh = script.events.filter((event) => event.wake === wake);
    for (const event of fresh) announce(event);
    announced = fresh.at(-1)?.seq ?? announced;
    const kinds: Record<string, number> = {};
    for (const event of fresh) kinds[inboxKind(event)] = (kinds[inboxKind(event)] ?? 0) + 1;
    const now = wake * WAKE_MS;
    if (wake % options.freshEvery === 0) {
      messages = [];
      freshContexts++;
    }
    const unread: Record<string, number> = {};
    for (const event of script.events)
      if (event.seq > confirmed && event.wake <= wake)
        unread[inboxKind(event)] = (unread[inboxKind(event)] ?? 0) + 1;
    messages.push({
      role: "user",
      text: wakeText({ kinds, unread, threads: digest(now), now, intervalMs: INTERVAL_MS }),
    });
    turns++;
    // A turn the host stopped completed nothing: what it read comes back to the next.
    let completed = false;
    delivered = confirmed;
    for (let step = 0; step < options.maxSteps; step++) {
      const reply = await options.model({ system: SYSTEM, messages, tools: TOOLS });
      tokens += reply.tokens ?? 0;
      messages.push({ role: "assistant", text: reply.text, calls: reply.calls });
      if (reply.calls.length === 0) {
        completed = true;
        break;
      }
      for (const toolCall of reply.calls)
        messages.push({
          role: "tool",
          callId: toolCall.id,
          name: toolCall.name,
          text: JSON.stringify(call(toolCall)),
        });
    }
    if (completed) confirmed = delivered;
    // A turn ends with every event it announced acted on; what is not was missed, and the host
    // goes on as if the right action had been taken, so every model plays the same script.
    for (const event of fresh) {
      if (requiresAction(event) && !outcomes.has(event.seq))
        outcomes.set(event.seq, { outcome: "missed" });
      follow(event);
      // Meanwhile the owner answered what was theirs and what the model left.
      if (event.requestId) pending.delete(event.requestId);
    }
  }
  // One text sent for waits with different causes is a blanket message: wrong for each of them.
  for (const events of sent.values())
    if (new Set(events.map(mergeFix)).size > 1)
      for (const event of events)
        outcomes.set(event.seq, { outcome: "wrong", why: "one message for different causes" });
  const rows = script.events.map((event): EventResult => {
    const graded = outcomes.get(event.seq);
    return {
      seq: event.seq,
      kind: event.kind,
      outcome: graded?.outcome ?? "none",
      ...(graded?.why ? { why: graded.why } : {}),
    };
  });
  const count = (outcome: Outcome) => rows.filter((row) => row.outcome === outcome).length;
  const wrong = count("wrong") + extra;
  return {
    events: rows.length,
    required: script.events.filter(requiresAction).length,
    correct: count("correct"),
    missed: count("missed"),
    wrong,
    refused,
    calls,
    turns,
    freshContexts,
    tokens,
    passed: count("missed") === 0 && wrong === 0,
    rows,
    notes,
  };
};

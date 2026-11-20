// An eval harness, not server code: scripted threads write files and run git in their worktrees.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { Model, ToolCall } from "../shared/chat.ts";
import { type Host, type Session, git, testsPass } from "./host.ts";

type Json = Record<string, any>;
const parse = (text: string): Json => {
  try {
    return JSON.parse(text) as Json;
  } catch {
    return { text };
  }
};

const GOAL = {
  id: "word-count",
  purpose:
    "Give the owner a word-count command that prints how many words a text holds, documented in the README.",
  priority: 1,
  touches: ["src", "bin", "test", "README.md"],
  acceptanceCriteria: [
    "src/wordCount.js exports wordCount(text): the number of whitespace-separated words, 0 for empty text.",
    "node bin/word-count.js <file> prints the word count of that file.",
    "Tests in test/ cover both, and npm test passes.",
    "README.md documents the command with an example.",
  ],
};

/**
 * The known-good Coordinator with no model: it plays the playbook's path from what the tools
 * return, through the same loop and tool calls a model gets, so the pipeline runs free.
 */
export const scriptedCoordinator = (): Model => {
  const known = {
    thread: "",
    project: "",
    read: false,
    ownerMessage: "",
    ownerText: "",
    planned: false,
    scoped: false,
    granted: false,
    grantTried: false,
    author: "",
    authorDone: false,
    reviewer: false,
    started: false,
  };
  const approvals: Array<{ threadId: string; requestId: string; decision: string }> = [];
  let said: Array<string> = [];
  let step = 0;
  const call = (name: string, input: Json): ToolCall => ({ id: `call-${++step}`, name, input });

  const absorb = (name: string, value: Json, input: Json) => {
    if (name === "t3_thread_list") {
      known.thread = value.currentThreadId;
      known.project = value.projectId;
    } else if (name === "t3_thread_read") {
      const typed = (value.items ?? []).filter(
        (item: Json) => item.type === "user_message" && item.createdBy === "user",
      );
      const newest = typed.at(-1);
      // The owner was told the goal waits on its scope: their next message comes once they set it
      // (an owner who did not leaves no grant to delegate under).
      if (known.planned && known.ownerMessage && newest?.messageId !== known.ownerMessage)
        known.scoped = true;
      known.read = true;
      known.ownerMessage = newest?.messageId ?? "";
      known.ownerText = newest?.text ?? "";
    } else if (name === "coordinator_plan") {
      known.planned = true;
      known.scoped = (value.goals?.[0]?.authorizedScope ?? []).length > 0;
      if (!known.scoped) said.push(`Goal ${GOAL.id} reaches no thread until you scope it to Toy.`);
    } else if (name === "coordinator_grant") {
      known.granted = value.granted === true;
      if (!known.granted)
        said.push(
          `I could not record the grant: ${JSON.stringify(value.proposal ?? value)}. Confirm it in Settings.`,
        );
    } else if (name === "coordinator_delegate") {
      const ids: Array<string> = value.assignmentIds ?? [];
      if (input.role === "reviewer") known.reviewer = true;
      else if (ids.length) {
        known.author = ids[0]!;
        said.push(`Delegated ${GOAL.id}.`);
      } else if (value.waiting) said.push(`${GOAL.id}: ${value.waiting}`);
    } else if (name === "coordinator_inbox") {
      for (const event of value.events ?? []) {
        if (
          event.kind === "assignment" &&
          event.subject === known.author &&
          event.status === "completed"
        )
          known.authorDone = true;
        if (event.kind === "approval")
          approvals.push({ threadId: event.threadId, requestId: event.subject, decision: "allow" });
        if (event.kind === "merge" && event.status === "owner")
          said.push(`Held for you: ${event.summary}`);
        if (event.kind === "merge" && event.status === "merged") said.push(`${GOAL.id} is merged.`);
      }
    } else if (name === "coordinator_approval" && input.decision === "owner" && value.answered) {
      said.push(`An approval in ${input.threadId} is outside the grant: it is yours to answer.`);
    } else if (name === "coordinator_approval" && value.code) {
      // `allow` only what the host could not read inside the grant: one outside it goes to the owner.
      if (/pass it to the owner/.test(value.message ?? ""))
        approvals.push({ threadId: input.threadId, requestId: input.requestId, decision: "owner" });
      else said.push(`An approval in ${input.threadId} is yours: ${value.message}`);
    }
  };

  const decide = (): Array<ToolCall> => {
    if (!known.read)
      return [call("t3_thread_read", { threadId: known.thread, limit: 20, maxCharsPerItem: 2000 })];
    if (!known.planned && /word-count/.test(known.ownerText))
      return [call("coordinator_plan", { goals: [GOAL] })];
    if (known.planned && !known.grantTried && /whole project/.test(known.ownerText)) {
      known.grantTried = true;
      return [
        call("coordinator_grant", {
          ownerMessageId: known.ownerMessage,
          grant: {
            id: "toy-whole-project",
            scope: { kind: "project", id: known.project },
            folders: ["."],
            maxAccess: 1,
          },
        }),
      ];
    }
    if (known.planned && known.scoped && known.granted && !known.author && !known.started) {
      known.started = true;
      return [
        call("coordinator_delegate", {
          goalId: GOAL.id,
          parentThreadId: known.thread,
          title: "Add the word-count command",
          role: "adventurer",
          rank: "E",
          target: {},
          task: `${GOAL.purpose}\n\nDone when:\n${GOAL.acceptanceCriteria.map((item, index) => `${index + 1}. ${item}`).join("\n")}\n\nWhere: the Toy project, in your own worktree. Touch only ${GOAL.touches.join(", ")}; leave src/math.js and src/greet.js as they are. Run npm test, commit on your branch, and report what you did and verified.`,
        }),
      ];
    }
    if (known.authorDone && !known.reviewer) {
      known.reviewer = true;
      return [
        call("coordinator_delegate", {
          goalId: GOAL.id,
          parentThreadId: known.thread,
          title: "Review the word-count command",
          role: "reviewer",
          rank: "E",
          target: {},
          reviewSubjects: [known.author],
          task: `Review the change for goal ${GOAL.id} against each criterion; run npm test. Change nothing.`,
        }),
      ];
    }
    return approvals.splice(0).map((item) => call("coordinator_approval", item));
  };

  return async ({ messages }) => {
    const last = messages.at(-1)!;
    if (last.role === "user") {
      // A turn may bring the owner's newest message: read the thread again.
      known.read = false;
      const first = !known.thread;
      return {
        text: "",
        calls: [
          ...(first
            ? [
                call("coordinator_status", {}),
                call("coordinator_playbook", {}),
                call("t3_thread_list", { limit: 1 }),
              ]
            : []),
          call("coordinator_inbox", {}),
        ],
      };
    }
    const asked = messages.findLast((message) => message.role === "assistant");
    for (const message of messages.slice(messages.lastIndexOf(asked!) + 1))
      if (message.role === "tool")
        absorb(
          message.name,
          parse(message.text),
          (asked?.role === "assistant"
            ? asked.calls.find((each) => each.id === message.callId)?.input
            : {}) as Json,
        );
    const calls = decide();
    if (calls.length) return { text: "", calls };
    const text = said.join(" ") || "Nothing needs you.";
    said = [];
    return { text, calls: [] };
  };
};

const FILES: Record<string, string> = {
  "src/wordCount.js":
    "export const wordCount = (text) => text.split(/\\s+/).filter(Boolean).length;\n",
  "bin/word-count.js": `#!/usr/bin/env node\nimport { readFileSync } from "node:fs";\nimport { wordCount } from "../src/wordCount.js";\n\nconsole.log(wordCount(readFileSync(process.argv[2] ?? 0, "utf8")));\n`,
  "test/wordCount.test.js": `import assert from "node:assert/strict";\nimport { execFileSync } from "node:child_process";\nimport { test } from "node:test";\nimport { wordCount } from "../src/wordCount.js";\n\ntest("wordCount", () => {\n  assert.equal(wordCount(""), 0);\n  assert.equal(wordCount(" one  two\\nthree "), 3);\n});\ntest("word-count prints the count", () =>\n  assert.equal(execFileSync("node", ["bin/word-count.js"], { input: "a b c", encoding: "utf8" }).trim(), "3"));\n`,
};

/** A delegated puppet thread played by a fixed script: an author commits real work, a reviewer passes it. */
export const playThread = async (
  host: Host,
  session: Session,
  text: string,
  ask: string | undefined,
  until: number,
) => {
  const instructions = text.split("\n").find((line) => line.startsWith('{"goalId"'));
  if (instructions) {
    const review = JSON.parse(instructions) as Json;
    const evidence = review.sources.flatMap((source: Json) => source.evidenceIds).slice(0, 1);
    const report = {
      ...review.reportFormat,
      criteria: review.acceptanceCriteria.map((_: string, index: number) => ({
        index,
        passed: true,
        evidenceIds: evidence,
      })),
      integration: { ...review.reportFormat.integration, evidenceIds: evidence },
      summary: testsPass(session.cwd)
        ? "Read the change against each criterion; npm test passes."
        : "npm test fails.",
    };
    if (!testsPass(session.cwd))
      Object.assign(report, { accepted: false, purposeSatisfied: false });
    host.finishThread(session, `Review done.\n\n${JSON.stringify(report)}`);
    return;
  }
  if (ask) {
    const answer = await host.ask(session, ask, until);
    if (answer?.outcome?.optionId !== "allow_once") {
      host.finishThread(session, `Stopped: \`${ask}\` was not allowed.`);
      return;
    }
  }
  for (const [file, body] of Object.entries(FILES)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(session.cwd, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(session.cwd, file), body);
  }
  NodeFS.appendFileSync(
    NodePath.join(session.cwd, "README.md"),
    "\n## word-count\n\n`node bin/word-count.js <file>` prints how many words the file holds (standard input without a file):\n\n```sh\n$ node bin/word-count.js README.md\n```\n",
  );
  const passed = testsPass(session.cwd);
  git(session.cwd, "add", "-A");
  git(session.cwd, "commit", "-q", "-m", "toy: add a word-count command");
  host.finishThread(
    session,
    `Done: src/wordCount.js, bin/word-count.js, their tests and a README section, committed on my branch. npm test ${passed ? "passes" : "fails"}.`,
  );
};

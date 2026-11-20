#!/usr/bin/env node
// An eval script, not server code: it starts servers, writes result files and calls a model API.
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalTimers:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import {
  type Message,
  type Model,
  type ToolSpec,
  chatEndpoint,
  chatModel,
} from "../shared/chat.ts";
import { CASES, type Case, type Threads } from "./cases.ts";
import { type Facts, collectResponses, emptyTrace, failedChecks, observe } from "./grade.ts";
import { git, startHost, stopHosts, testsPass } from "./host.ts";
import { playThread, scriptedCoordinator } from "./scripted.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string" },
    threads: { type: "string", default: "scripted" },
    case: { type: "string", multiple: true },
    "base-url": { type: "string" },
    "api-key-env": { type: "string" },
    "max-steps": { type: "string", default: "30" },
    "time-limit": { type: "string" },
    server: {
      type: "string",
      default: NodePath.join(import.meta.dirname, "../../apps/server/dist/bin.mjs"),
    },
  },
});
const threads = values.threads as Threads;
const maxSteps = Number(values["max-steps"]);
const minutes = Number(values["time-limit"] ?? (threads === "real" ? 45 : 5));
if (
  !values.out ||
  !values.model ||
  !["scripted", "real"].includes(threads) ||
  ![maxSteps, minutes].every((value) => Number.isFinite(value) && value > 0)
)
  throw new Error(
    "Use --out <directory> --model <id|scripted> [--threads scripted|real] [--case <id>] [--base-url <url> --api-key-env <NAME>] [--max-steps n] [--time-limit minutes] [--server <bin.mjs>].",
  );
if (!NodeFS.existsSync(values.server))
  throw new Error(`No built server at ${values.server}: build it first (see README.md).`);
const out = NodePath.resolve(values.out);
const server = NodePath.resolve(values.server);
const modelId = values.model;
const cases = CASES.filter(
  (item) => item.threads.includes(threads) && (!values.case || values.case.includes(item.id)),
);
if (!cases.length) throw new Error(`No case runs with --threads ${threads} and those ids.`);
const endpoint =
  modelId === "scripted" ? undefined : chatEndpoint(values["base-url"], values["api-key-env"]);
// The role's rules come from the host, in the first turn's text, as any ACP provider gets them.
const SYSTEM = "You are an agent in T3 Code, with T3's tools.";
// The case ends once nothing has happened for this long: no turn, no work running, no owner act.
const IDLE_MS = threads === "real" ? 120_000 : 10_000;
const ACTIVE = new Set([
  "queued",
  "routing",
  "dispatching",
  "preparing",
  "starting",
  "running",
  "started",
]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A server outlives this process unless it is stopped, also while one is still starting.
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void stopHosts().then(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });

const runCase = async (item: Case) => {
  const dir = NodePath.join(out, item.id);
  NodeFS.rmSync(dir, { recursive: true, force: true });
  NodeFS.mkdirSync(dir, { recursive: true });
  const started = Date.now();
  const deadline = started + minutes * 60_000;
  const model: Model = endpoint ? chatModel(endpoint, modelId) : scriptedCoordinator();
  let trace = emptyTrace;
  const ownerAnswered: Array<string> = [];
  let responses: Facts["responses"] = {};
  const counts = { turns: 0, modelCalls: 0, toolCalls: 0, tokens: 0 };
  let ended = "idle";
  const host = await startHost({
    dir,
    server,
    threads,
    onBoard: (board) => (trace = observe(trace, board)),
  });
  const messages: Array<Message> = [];
  let tools: Array<ToolSpec> | undefined;
  const playTurn = async (text: string) => {
    tools ??= await host.tools();
    messages.push({ role: "user", text });
    counts.turns++;
    for (let step = 0; step < maxSteps; step++) {
      const reply = await model({ system: SYSTEM, messages, tools });
      counts.modelCalls++;
      counts.tokens += reply.tokens ?? 0;
      messages.push({ role: "assistant", text: reply.text, calls: reply.calls });
      if (!reply.calls.length) return host.endTurn(reply.text);
      for (const call of reply.calls) {
        counts.toolCalls++;
        messages.push({
          role: "tool",
          callId: call.id,
          name: call.name,
          text: await host.call(call.name, call.input),
        });
      }
    }
    await host.endTurn("");
  };
  const merged = new Set<string>();
  let granted = false;
  const ownerActs = async () => {
    const board = host.board();
    let acted = false;
    const unscoped = (board.goals ?? []).filter((goal: any) => !goal.authorizedScope?.length);
    if (item.owner.scope && unscoped.length) {
      for (const goal of unscoped)
        await host.ownerCommand({
          type: "goal.upsert",
          goal: { ...goal, authorizedScope: [host.projectId] },
        });
      acted = true;
    }
    // A message carrying the request grants nothing: the owner gives folders in one of its own.
    if (!granted && board.goals?.length) {
      granted = true;
      await host.ownerMessage(item.owner.grant);
      acted = true;
    }
    // Main is checked out in the owner's working copy, so a reviewed change waits for them to merge it.
    for (const wait of item.owner.merge ? (board.ownerMerges ?? []) : []) {
      if (merged.has(wait.head)) continue;
      merged.add(wait.head);
      git(host.repo, "merge", "-q", "--ff-only", wait.head);
      await host.ownerCommand({ type: "cycle.run" });
      acted = true;
    }
    for (const request of item.owner.answer ? (board.permissionRequests ?? []) : []) {
      if (
        request.status !== "pending" ||
        request.route !== "owner" ||
        ownerAnswered.includes(request.id)
      )
        continue;
      ownerAnswered.push(request.id);
      await host.ownerAnswer(request.threadId, request.destinationRequestId, "accept");
      acted = true;
    }
    return acted;
  };

  let error: string | undefined;
  try {
    await host.ownerMessage(item.message);
    const played = new Set<string>();
    const playing = new Set<Promise<void>>();
    let lastTurn = 0;
    let idleSince = Date.now();
    let threadFailure: unknown;
    const until = <T>(work: Promise<T>) =>
      new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("time limit")), deadline - Date.now());
        work.then(resolve, reject).finally(() => clearTimeout(timer));
      });
    for (;;) {
      if (Date.now() > deadline) {
        ended = "time limit";
        break;
      }
      const turn = host.pendingTurn();
      if (turn && turn.turn !== lastTurn) {
        lastTurn = turn.turn;
        await until(playTurn(turn.text));
        idleSince = Date.now();
        continue;
      }
      for (const { session, text } of threads === "scripted" ? host.delegatedTurns() : []) {
        const key = `${session.sid}:${session.turn}`;
        if (played.has(key)) continue;
        played.add(key);
        // A thread that fails ends the case here, where the server is stopped, not the process.
        const work = playThread(host, session, text, item.ask, deadline)
          .catch((cause: unknown) => void (threadFailure ??= cause))
          .finally(() => playing.delete(work));
        playing.add(work);
      }
      if (threadFailure !== undefined) throw threadFailure;
      const busy =
        turn !== undefined ||
        playing.size > 0 ||
        (host.board().assignments ?? []).some((each: any) => ACTIVE.has(each.status));
      if ((await ownerActs()) || busy) idleSince = Date.now();
      else if (Date.now() - idleSince > IDLE_MS) break;
      await sleep(500);
    }
  } catch (cause) {
    error = String((cause as Error).message ?? cause);
    ended = error === "time limit" ? "time limit" : `error: ${error}`;
  } finally {
    try {
      responses = await collectResponses(trace.requests, host.runtimeRequests, 10_000);
    } finally {
      const stopped = await host.stop();
      if (!stopped.stopped) ended += `; server ${stopped.pid} still runs`;
    }
  }
  const main = git(host.repo, "rev-parse", "main");
  const facts = {
    trace,
    ownerAnswered,
    responses,
    repo: {
      changed: git(host.repo, "diff", "--name-only", host.base, main).split("\n").filter(Boolean),
      testsPass: testsPass(host.repo),
      onMain: Object.values(trace.ownerMerges).filter((head) => {
        try {
          git(host.repo, "merge-base", "--is-ancestor", head, main);
          return true;
        } catch {
          return false;
        }
      }),
    },
  };
  NodeFS.writeFileSync(NodePath.join(dir, "transcript.json"), JSON.stringify(messages, null, 1));
  NodeFS.writeFileSync(NodePath.join(dir, "facts.json"), JSON.stringify(facts, null, 1));
  const failed = failedChecks(item.checks, facts);
  return {
    case: item.id,
    model: modelId,
    threads,
    passed: failed.length === 0 && ended === "idle",
    failed,
    ...counts,
    seconds: Math.round((Date.now() - started) / 1000),
    ended,
    serverPid: host.pid,
  };
};

NodeFS.mkdirSync(out, { recursive: true });
const rows = [];
for (const item of cases) {
  const row = await runCase(item).catch((cause: Error) => ({
    case: item.id,
    passed: false,
    failed: [] as Array<string>,
    turns: 0,
    modelCalls: 0,
    toolCalls: 0,
    tokens: 0,
    seconds: 0,
    ended: `error: ${cause.message}`,
    serverPid: undefined,
  }));
  rows.push(row);
  console.log(
    `${row.case}: ${row.passed ? "passed" : `failed (${[...row.failed, row.ended].join("; ")})`}, ${row.turns} turns, ${row.modelCalls} model calls, ${row.seconds} s, server pid ${row.serverPid}`,
  );
}
NodeFS.writeFileSync(NodePath.join(out, "results.json"), `${JSON.stringify(rows, null, 2)}\n`);
NodeFS.writeFileSync(
  NodePath.join(out, "summary.md"),
  [
    `# Coordinator live: ${modelId}, ${threads} threads`,
    "",
    "| Case | Passed | Failed checks | Turns | Model calls | Tool calls | Tokens | Seconds | Ended |",
    "| ---- | ------ | ------------- | ----- | ----------- | ---------- | ------ | ------- | ----- |",
    ...rows.map(
      (row) =>
        `| ${row.case} | ${row.passed ? "yes" : "no"} | ${row.failed.join("; ") || "none"} | ${row.turns} | ${row.modelCalls} | ${row.toolCalls} | ${row.tokens} | ${row.seconds} | ${row.ended} |`,
    ),
    "",
  ].join("\n"),
);
if (rows.some((row) => !row.passed)) process.exitCode = 1;

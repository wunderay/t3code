import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import { CoordinatorError } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/http";
import * as TestClock from "effect/testing/TestClock";
import * as ProcessRunner from "../../processRunner.ts";
import * as Supervisor from "../Supervisor.ts";
import type { RemoteRun } from "./CloudDriver.ts";
import { type Call, fakeRunner, remoteRun } from "./CloudDriver.testkit.ts";
import * as CloudRuns from "./CloudRuns.ts";

/** The ledger's rows as the native store keeps them; its state machine is tested in Rust. */
const fakeSupervisor = (
  rows: Array<RemoteRun>,
  down: ReadonlyArray<string> = [],
  progress: Array<string> = [],
  heads: Array<string> = [],
  ended: Array<unknown> = [],
): Supervisor.Supervisor["Service"] => ({
  available: true,
  request: (method, raw) =>
    down.includes(method)
      ? Effect.fail(new CoordinatorError({ operation: method, reason: "transport" }))
      : Effect.sync(() => {
          const params = raw as Record<string, never>;
          const out = rows.find(
            (row) => row.assignmentId === params.assignmentId && row.state === "out",
          );
          switch (method) {
            case "remote.reserve": {
              const id = rows.length + 1;
              const run = remoteRun({ ...params, id, handle: "", branch: `coordinator/a-${id}` });
              rows.push(run);
              return { run };
            }
            case "remote.handle": {
              const run = rows.find((row) => row.id === params.id)!;
              return { run: Object.assign(run, { handle: params.handle }) };
            }
            case "remote.get":
              return {
                run: rows.findLast((row) => row.assignmentId === params.assignmentId) ?? null,
              };
            case "remote.close":
              if (out) Object.assign(out, { state: params.state, head: params.head ?? null });
              return { closed: Boolean(out) };
            case "remote.wait":
              return { lost: false };
            case "remote.progress": {
              heads.push(String(params.head ?? ""));
              ended.push(params.ended);
              const run = rows.findLast((row) => row.assignmentId === params.assignmentId)!;
              const next = progress.shift() ?? "waiting";
              if (params.head) Object.assign(run, { branchHead: params.head, movedAt: 5 });
              if (next === "stalled") Object.assign(run, { state: "lost" });
              if (next === "late") Object.assign(run, { branchHead: params.head });
              return { run, progress: next };
            }
            case "remote.unresolved":
              return {
                items: rows
                  .filter(
                    (row) =>
                      row.state === "lost" ||
                      row.state === "unstopped" ||
                      (row.state === "collected" && row.branchHead && row.branchHead !== row.head),
                  )
                  .map((row) => ({ ...row, why: "listed", label: row.assignmentId })),
                recent: rows
                  .filter((row) => row.kind === "claude-cloud" && row.state === "collected")
                  .map((row) => row.assignmentId),
              };
            case "remote.ended":
              return { ended: true };
            default:
              throw new Error(method);
          }
        }),
});

const cloudRuns = (
  rows: Array<RemoteRun>,
  rules: Parameters<typeof fakeRunner>[0],
  calls: Array<Call> = [],
  options: {
    down?: ReadonlyArray<string>;
    progress?: Array<string>;
    heads?: Array<string>;
    ended?: Array<unknown>;
    runner?: (
      runner: ProcessRunner.ProcessRunner["Service"],
    ) => ProcessRunner.ProcessRunner["Service"];
  } = {},
) =>
  CloudRuns.make.pipe(
    Effect.provideService(
      Supervisor.Supervisor,
      fakeSupervisor(rows, options.down, options.progress, options.heads, options.ended),
    ),
    Effect.provideService(
      ProcessRunner.ProcessRunner,
      (options.runner ?? ((runner) => runner))(fakeRunner(rules, calls)),
    ),
    Effect.provideService(PtyAdapter.PtyAdapter, { spawn: () => Effect.die("no terminal here") }),
    Effect.provideService(HostProcess.Environment, { CLAUDE_CONFIG_DIR: "/nonexistent/t3-login" }),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("no network here")),
    ),
    Effect.provide(NodeServices.layer),
  );

const submission = {
  assignmentId: "assignment/1",
  destination: "cloud:codex",
  repository: "/repo",
  base: "b".repeat(40),
  sourceBranch: "main",
  environment: "env-r",
  brief: "Build the thing.",
  model: null,
  effort: "high",
  login: null,
};
const HEAD = "c".repeat(40);
const READY = [
  [["codex", "cloud", "status"], { stdout: "ready" }],
  [["codex", "cloud", "diff"], { stdout: "diff --git a/x b/x\n" }],
  [["git", "rev-parse"], { stdout: `${HEAD}\n` }],
  [["codex"], { stdout: "task_abc" }],
] as const;

it.effect("a run is reserved before its cloud is called and collected after a restart", () =>
  Effect.gen(function* () {
    const rows: Array<RemoteRun> = [];
    const calls: Array<Call> = [];
    const before = yield* cloudRuns(rows, READY, calls);
    const run = yield* before.submit(submission);
    assert.deepEqual([run.state, run.handle, run.branch], ["out", "task_abc", "coordinator/a-1"]);
    // The branch was checked absent before the cloud was called.
    assert.deepEqual(calls[0]!.args, ["ls-remote", "origin", "refs/heads/coordinator/a-1"]);
    const after = yield* cloudRuns(rows, READY);
    assert.deepEqual(yield* after.poll("assignment/1"), { status: "completed", head: HEAD });
    assert.deepEqual([rows[0]!.state, rows[0]!.head], ["collected", HEAD]);
    assert.deepEqual(yield* after.poll("assignment/1"), { status: "completed", head: HEAD });
  }),
);

it.effect(
  "a restart between the cloud call and its record leaves the run listed, never untracked",
  () =>
    Effect.gen(function* () {
      const rows: Array<RemoteRun> = [];
      const crashed = yield* cloudRuns(rows, READY, [], { down: ["remote.handle"] });
      assert.equal((yield* crashed.submit(submission).pipe(Effect.result))._tag, "Failure");
      assert.deepEqual([rows[0]!.state, rows[0]!.handle], ["out", ""]);
      const after = yield* cloudRuns(rows, READY);
      assert.equal((yield* after.poll("assignment/1")).status, "failed");
      assert.equal(rows[0]!.state, "lost");
      assert.equal((yield* after.unresolved).length, 1);
      assert.isTrue(yield* after.ended({ assignmentId: "assignment/1", actor: "user" }));
    }),
);

it.effect(
  "a branch already on origin is never handed out; a failed call may have started a run",
  () =>
    Effect.gen(function* () {
      const rows: Array<RemoteRun> = [];
      const calls: Array<Call> = [];
      const held = yield* cloudRuns(
        rows,
        [[["git", "ls-remote"], { stdout: `${HEAD}\trefs/heads/coordinator/a-1\n` }]],
        calls,
      );
      assert.equal((yield* held.submit(submission).pipe(Effect.result))._tag, "Failure");
      assert.equal(rows[0]!.state, "abandoned");
      assert.isUndefined(calls.find((call) => call.command === "codex"));
      const refused = yield* cloudRuns(rows, [[["codex"], { stderr: "auth", code: 1 }]]);
      assert.equal((yield* refused.submit(submission).pipe(Effect.result))._tag, "Failure");
      assert.equal(rows[1]!.state, "lost");
    }),
);

it.effect("a brief is checked for secrets and size before anything leaves the machine", () =>
  Effect.gen(function* () {
    const calls: Array<Call> = [];
    const rows: Array<RemoteRun> = [];
    const runs = yield* cloudRuns(rows, [], calls);
    for (const brief of ["use sk-ant-api03-abcdefghijklmnopqrstuvwxyz", "x".repeat(100_001)]) {
      const refused = yield* runs.submit({ ...submission, brief }).pipe(Effect.result);
      assert.equal(refused._tag, "Failure");
    }
    const unknown = yield* runs
      .submit({ ...submission, destination: "cloud:other" })
      .pipe(Effect.result);
    assert.equal(unknown._tag, "Failure");
    assert.deepEqual([calls.length, rows.length], [0, 0]);
  }),
);

it.effect("with optional egress disabled no cloud command runs", () =>
  Effect.gen(function* () {
    const calls: Array<Call> = [];
    const runs = yield* cloudRuns([], [], calls).pipe(
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromUnknown({ T3CODE_DISABLE_OPTIONAL_EGRESS: true })),
      ),
    );
    assert.equal((yield* runs.submit(submission).pipe(Effect.result))._tag, "Failure");
    assert.equal(calls.length, 0);
  }),
);

it.effect("an unknown Codex status is still out, even past the deadline", () =>
  Effect.gen(function* () {
    const rows = [remoteRun({})];
    const runs = yield* cloudRuns(rows, [], [], {
      runner: (runner) => ({
        run: (input) =>
          input.command === "codex"
            ? Effect.fail(
                new ProcessRunner.ProcessSpawnError({
                  command: "codex",
                  argumentCount: input.args.length,
                  cause: new Error("not installed"),
                }),
              )
            : runner.run(input),
      }),
    });
    assert.deepEqual(yield* runs.poll("assignment-1"), { status: "running" });
    yield* TestClock.adjust("61 minutes");
    assert.deepEqual(yield* runs.poll("assignment-1"), { status: "running" });
    assert.equal(rows[0]!.state, "out");
  }),
);

it.effect(
  "a Claude run's progress is its branch head: recorded, stalled, or taken once its session ended",
  () =>
    Effect.gen(function* () {
      const claude = () =>
        remoteRun({ kind: "claude-cloud", handle: "https://claude.ai/code/session_x" });
      const heads: Array<string> = [];
      const ended: Array<unknown> = [];
      const rows = [claude()];
      const pushed = [[["git", "ls-remote"], { stdout: `${HEAD}\trefs/heads/x\n` }]] as const;
      const runs = yield* cloudRuns(rows, pushed, [], { progress: ["moved"], heads, ended });
      assert.deepEqual(yield* runs.poll("assignment-1"), {
        status: "running",
        head: HEAD,
        movedAt: 5,
      });
      assert.deepEqual(heads, [HEAD]);
      // Its session's end is the provider's word; with no login to read it, it has not ended.
      assert.deepEqual(ended, [false]);
      const stalledRows = [claude()];
      const stalled = yield* cloudRuns(stalledRows, [], [], { progress: ["stalled"] });
      const outcome = yield* stalled.poll("assignment-1");
      assert.equal(outcome.status, "failed");
      assert.equal(stalledRows[0]!.state, "lost");
      // Once its session ended its head is collected; with no login to prove it, it is refused.
      const readyRows = [claude()];
      const ready = yield* cloudRuns(readyRows, pushed, [], { progress: ["ready"] });
      const taken = yield* ready.poll("assignment-1");
      assert.ok(taken.status === "failed" && taken.reason.includes("no Claude login token"));
      assert.equal(readyRows[0]!.state, "collected");
    }),
);

it.effect("an unanswered collection is retried only until the run's deadline", () =>
  Effect.gen(function* () {
    const rows = [remoteRun({})];
    const runs = yield* cloudRuns(rows, [
      [["codex", "cloud", "status"], { stdout: "ready" }],
      [["codex", "cloud", "diff"], { stderr: "timeout", code: 1 }],
    ]);
    assert.equal((yield* runs.poll("assignment-1").pipe(Effect.result))._tag, "Failure");
    assert.equal(rows[0]!.state, "out");
    yield* TestClock.adjust("61 minutes");
    assert.equal((yield* runs.poll("assignment-1")).status, "failed");
    assert.deepEqual([rows[0]!.state, rows[0]!.head], ["collected", null]);
  }),
);

it.effect(
  "a run cancelled while it is collected is not reported as completed, and is pushed once",
  () =>
    Effect.gen(function* () {
      const rows = [remoteRun({})];
      const calls: Array<Call> = [];
      const runs = yield* cloudRuns(rows, READY, calls, {
        runner: (runner) => ({
          run: (input) =>
            runner.run(input).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (input.args[0] === "push") Object.assign(rows[0]!, { state: "unstopped" });
                }),
              ),
            ),
        }),
      });
      const [first, second] = yield* Effect.all(
        [runs.poll("assignment-1"), runs.poll("assignment-1")],
        { concurrency: "unbounded" },
      );
      assert.equal(first.status, "failed");
      assert.equal(second.status, "failed");
      assert.equal(rows[0]!.state, "unstopped");
      assert.equal(calls.filter((call) => call.args[0] === "push").length, 1);
    }),
);

it.effect("a run that failed or vanished in its cloud is closed without a head", () =>
  Effect.gen(function* () {
    const rows = [remoteRun({})];
    const runs = yield* cloudRuns(rows, [[["codex", "cloud", "status"], { stdout: "failed" }]]);
    assert.equal((yield* runs.poll("assignment-1")).status, "failed");
    assert.deepEqual([rows[0]!.state, rows[0]!.head], ["collected", null]);
  }),
);

it.effect("a commit after a Claude run was collected is recorded and listed for the owner", () =>
  Effect.gen(function* () {
    const rows = [
      remoteRun({
        kind: "claude-cloud",
        handle: "https://claude.ai/code/session_x",
        state: "collected",
        head: "a".repeat(40),
        branchHead: "a".repeat(40),
      }),
    ];
    const heads: Array<string> = [];
    const runs = yield* cloudRuns(
      rows,
      [[["git", "ls-remote"], { stdout: `${HEAD}\trefs/heads/x\n` }]],
      [],
      { progress: ["late"], heads },
    );
    const listed = yield* runs.unresolved;
    assert.deepEqual(heads, [HEAD]);
    assert.deepEqual(
      listed.map((item) => [item.state, item.head, item.branchHead]),
      [["collected", "a".repeat(40), HEAD]],
    );
  }),
);

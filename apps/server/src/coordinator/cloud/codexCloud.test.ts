import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ProcessRunner from "../../processRunner.ts";
import { type Call, fakeRunner, remoteRun } from "./CloudDriver.testkit.ts";
import * as CodexCloud from "./codexCloud.ts";

const driver = (rules: Parameters<typeof fakeRunner>[0], calls: Array<Call> = []) =>
  CodexCloud.make.pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, fakeRunner(rules, calls)),
    Effect.provide(NodeServices.layer),
  );

const submission = {
  repository: "/repo",
  base: "b".repeat(40),
  sourceBranch: "main",
  environment: "env-r",
  branch: "coordinator/assignment-1",
  brief: "Build the thing.",
  model: null,
  effort: "high",
  login: null,
};

it.effect("submits one attempt on the environment and branch with the routed effort", () =>
  Effect.gen(function* () {
    const calls: Array<Call> = [];
    const codex = yield* driver([[["codex"], { stdout: "submitted task_abc\n" }]], calls);
    assert.equal(yield* codex.submit(submission), "task_abc");
    assert.deepEqual(calls[0]!.args, [
      "--config",
      'model_reasoning_effort="high"',
      "cloud",
      "exec",
      "--env",
      "env-r",
      "--attempts",
      "1",
      "--branch",
      "main",
      "-",
    ]);
    assert.equal(calls[0]!.stdin, "Build the thing.");
  }),
);

it.effect("a refused submission or one with no task id is no hand-out", () =>
  Effect.gen(function* () {
    const refused = yield* driver([[["codex"], { stderr: "auth", code: 1 }]]);
    assert.equal((yield* refused.submit(submission).pipe(Effect.result))._tag, "Failure");
    const silent = yield* driver([[["codex"], { stdout: "ok" }]]);
    assert.equal((yield* silent.submit(submission).pipe(Effect.result))._tag, "Failure");
  }),
);

it.effect("status never reads a failure as ready", () =>
  Effect.gen(function* () {
    const cases = [
      [{ stdout: "Ready" }, "ready"],
      [{ stdout: "completed" }, "ready"],
      [{ stdout: "pending" }, "out"],
      [{ stdout: "failed; completed 0 attempts" }, "failed"],
      [{ stdout: "error: ready check" }, "failed"],
      [{ stdout: "Ready", stderr: "provider failure", code: 1 }, "out"],
      [{ stderr: "task not found", code: 1 }, "gone"],
    ] as const;
    for (const [reply, expected] of cases) {
      const codex = yield* driver([[["codex", "cloud", "status", "task_e123"], reply]]);
      assert.equal(yield* codex.status(remoteRun({})), expected, JSON.stringify(reply));
    }
  }),
);

const DIFF = [["codex", "cloud", "diff"], { stdout: "diff --git a/x b/x\n" }] as const;

it.effect(
  "collect applies the diff three-way on the base, pushes under an empty lease, and tidies",
  () =>
    Effect.gen(function* () {
      const calls: Array<Call> = [];
      const codex = yield* driver(
        [DIFF, [["git", "rev-parse"], { stdout: `${"c".repeat(40)}\n` }]],
        calls,
      );
      assert.deepEqual(yield* codex.collect(remoteRun({})), { head: "c".repeat(40) });
      const git = calls
        .filter((call) => call.command === "git")
        .map((call) => call.args.slice(0, 2));
      assert.deepEqual(git, [
        ["ls-remote", "origin"],
        ["worktree", "add"],
        ["apply", "--index"],
        ["commit", "-m"],
        ["rev-parse", "HEAD"],
        ["push", "--force-with-lease=refs/heads/coordinator/assignment-1:"],
        ["worktree", "remove"],
      ]);
      const apply = calls.find((call) => call.args[0] === "apply")!;
      assert.include(apply.args, "--3way");
      assert.equal(apply.stdin, "diff --git a/x b/x\n");
      assert.notInclude(calls.find((call) => call.args[0] === "push")!.args, "--force");
    }),
);

it.effect("a diff that cannot become a pushed commit ends the run, with no worktree left", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    for (const [failing, step] of [
      [["git", "worktree", "add"], "the worktree could not be made"],
      [["git", "apply"], "the diff does not apply"],
      [["git", "commit"], "the diff left nothing to commit"],
      [["git", "push"], "coordinator/assignment-1 could not be pushed"],
    ] as const) {
      const calls: Array<Call> = [];
      const codex = yield* driver([DIFF, [failing, { code: 1 }]], calls);
      assert.deepEqual(yield* codex.collect(remoteRun({})), {
        refused: `Codex cloud task task_e123: ${step}`,
      });
      const folder = calls.find((call) => call.args[0] === "worktree")!.args[3]!;
      assert.isFalse(yield* fs.exists(folder), step);
    }
    const empty = yield* driver([[["codex", "cloud", "diff"], { stdout: "\n" }]]);
    assert.deepEqual(yield* empty.collect(remoteRun({})), {
      refused: "Codex cloud task task_e123 produced no diff",
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("an unanswered diff is retried, and a head this host already pushed is taken as is", () =>
  Effect.gen(function* () {
    const silent = yield* driver([[["codex", "cloud", "diff"], { stderr: "timeout", code: 1 }]]);
    assert.equal((yield* silent.collect(remoteRun({})).pipe(Effect.result))._tag, "Failure");
    const calls: Array<Call> = [];
    const pushed = yield* driver(
      [DIFF, [["git", "ls-remote"], { stdout: `${"d".repeat(40)}\trefs/heads/x\n` }]],
      calls,
    );
    assert.deepEqual(yield* pushed.collect(remoteRun({})), { head: "d".repeat(40) });
    assert.isUndefined(calls.find((call) => call.args[0] === "apply"));
  }),
);

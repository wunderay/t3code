import { CoordinatorError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ProcessRunner from "../../processRunner.ts";
import {
  type CloudCollected,
  type CloudDriver,
  type CloudStatus,
  exec,
  git,
  remoteHead,
  withWorktree,
} from "./CloudDriver.ts";

const TASK = /task_[A-Za-z0-9_-]+/;
const GONE = /not found|no such|does not exist|unknown task|404/i;

const statusOf = (output: {
  readonly code: unknown;
  readonly stdout: string;
  readonly stderr: string;
}): CloudStatus => {
  if (output.code !== 0) return GONE.test(output.stdout + output.stderr) ? "gone" : "out";
  const text = output.stdout.toLowerCase();
  // A failure report can mention "completed" too ("completed 0 attempts").
  if (/error|failed/.test(text)) return "failed";
  return /ready|completed/.test(text) ? "ready" : "out";
};

/** Codex cloud cannot push to our branch: its diff is applied and pushed here. */
export const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const codex = (cwd: string, args: ReadonlyArray<string>, stdin?: string) =>
    exec(runner, `codex-cloud-${args[1] ?? args[0]}`, {
      command: "codex",
      args,
      cwd,
      stdin,
      timeout: "300 seconds",
    });
  return {
    submit: Effect.fn("CodexCloud.submit")(function* (input) {
      const output = yield* codex(
        input.repository,
        [
          ...(input.effort ? ["--config", `model_reasoning_effort="${input.effort}"`] : []),
          "cloud",
          "exec",
          "--env",
          input.environment,
          "--attempts",
          "1",
          "--branch",
          input.sourceBranch,
          "-",
        ],
        input.brief,
      );
      const task = TASK.exec(output.stdout + output.stderr)?.[0];
      if (output.code !== 0 || !task)
        return yield* new CoordinatorError({
          operation: "codex-cloud-exec",
          reason: "destination",
        });
      return task;
    }),
    status: Effect.fn("CodexCloud.status")(function* (run) {
      // Status is best effort: an unanswered one leaves the run out.
      const output = yield* codex(run.repository, ["cloud", "status", run.handle]).pipe(
        Effect.option,
      );
      if (output._tag === "None") return "out";
      return statusOf(output.value);
    }),
    collect: Effect.fn("CodexCloud.collect")(function* (run) {
      // An unanswered diff is the cloud's to retry; everything after it is final.
      const diff = yield* codex(run.repository, ["cloud", "diff", run.handle]);
      if (diff.code !== 0)
        return yield* new CoordinatorError({ operation: "codex-cloud-diff", reason: "transport" });
      if (!diff.stdout.trim())
        return { refused: `Codex cloud task ${run.handle} produced no diff` };
      // The branch was absent at submit and only this host pushes it: a head there is ours.
      const pushed = yield* remoteHead(runner, run.repository, run.branch);
      if (pushed) return { head: pushed };
      let step = "the worktree could not be made";
      return yield* withWorktree(runner, fs, run.repository, run.base, (folder) =>
        Effect.gen(function* () {
          step = "the diff does not apply";
          // Codex may have worked from an older snapshot of the base; git merges it three-way.
          yield* git(
            runner,
            folder,
            ["apply", "--index", "--3way", "--whitespace=nowarn"],
            diff.stdout,
          );
          step = "the diff left nothing to commit";
          yield* git(runner, folder, ["commit", "-m", `Codex cloud task ${run.handle}`]);
          const head = (yield* git(runner, folder, ["rev-parse", "HEAD"])).trim();
          step = `${run.branch} could not be pushed`;
          // An empty lease: the push fails if anything else created the branch meanwhile.
          yield* git(runner, folder, [
            "push",
            `--force-with-lease=refs/heads/${run.branch}:`,
            "origin",
            `HEAD:refs/heads/${run.branch}`,
          ]);
          return { head } as CloudCollected;
        }),
      ).pipe(
        Effect.orElseSucceed((): CloudCollected => ({
          refused: `Codex cloud task ${run.handle}: ${step}`,
        })),
      );
    }),
  } satisfies CloudDriver;
});

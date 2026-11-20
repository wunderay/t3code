import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/process";
import type * as ProcessRunner from "../../processRunner.ts";
import type { RemoteRun } from "./CloudDriver.ts";

export interface Call {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string | undefined;
  readonly stdin: string | undefined;
}

/** Answers each command by the first rule whose words start its argv; anything else exits 0. */
export const fakeRunner = (
  rules: ReadonlyArray<
    readonly [ReadonlyArray<string>, { stdout?: string; stderr?: string; code?: number }]
  >,
  calls: Array<Call> = [],
): ProcessRunner.ProcessRunner["Service"] => ({
  run: (input) =>
    Effect.sync(() => {
      calls.push({ command: input.command, args: input.args, cwd: input.cwd, stdin: input.stdin });
      const argv = [input.command, ...input.args];
      const reply =
        rules.find(([words]) => words.every((word, index) => argv[index] === word))?.[1] ?? {};
      return {
        stdout: reply.stdout ?? "",
        stderr: reply.stderr ?? "",
        code: ChildProcessSpawner.ExitCode(reply.code ?? 0),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      };
    }),
});

export const remoteRun = (fields: Partial<RemoteRun>): RemoteRun => ({
  id: 1,
  assignmentId: "assignment-1",
  kind: "codex-cloud",
  branch: "coordinator/assignment-1",
  base: "b".repeat(40),
  repository: "/repo",
  handle: "task_e123",
  model: null,
  effort: null,
  head: null,
  state: "out",
  startedAt: 0,
  deadlineAt: 3_600_000,
  endedAt: null,
  dueWaitedMs: 0,
  login: null,
  branchHead: null,
  movedAt: null,
  ...fields,
});

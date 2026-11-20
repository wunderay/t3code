import { CoordinatorError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import type * as ProcessRunner from "../../processRunner.ts";

export const RemoteRun = Schema.Struct({
  id: Schema.Number,
  assignmentId: Schema.String,
  kind: Schema.Literals(["codex-cloud", "claude-cloud"]),
  branch: Schema.String,
  base: Schema.String,
  repository: Schema.String,
  /** Empty while the cloud is being called. */
  handle: Schema.String,
  model: Schema.NullOr(Schema.String),
  effort: Schema.NullOr(Schema.String),
  head: Schema.NullOr(Schema.String),
  state: Schema.Literals(["out", "collected", "abandoned", "lost", "unstopped", "ended"]),
  startedAt: Schema.Number,
  deadlineAt: Schema.Number,
  endedAt: Schema.NullOr(Schema.Number),
  dueWaitedMs: Schema.Number,
  /** The Claude config folder the run was launched with; null for the ambient login. */
  login: Schema.NullOr(Schema.String),
  /** The last commit seen on a pushing run's branch, and when it was first seen. */
  branchHead: Schema.NullOr(Schema.String),
  movedAt: Schema.NullOr(Schema.Number),
});
export type RemoteRun = typeof RemoteRun.Type;

export interface CloudSubmit {
  /** The local checkout git commands run in. */
  readonly repository: string;
  /** The exact commit the cloud starts from; it must already be on origin. */
  readonly base: string;
  readonly sourceBranch: string;
  readonly environment: string;
  /** The run's own branch, absent from origin when it is submitted. */
  readonly branch: string;
  readonly brief: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly login: string | null;
}

/** `ready`: a result can be collected; `gone`: the cloud no longer knows the run. */
export type CloudStatus = "out" | "ready" | "failed" | "gone";

/** A refusal is final; a `CoordinatorError` from `collect` means try again later. */
export type CloudCollected = { readonly head: string } | { readonly refused: string };

export interface CloudDriver {
  /** Returns the run's handle: a task id or a session URL. */
  readonly submit: (input: CloudSubmit) => Effect.Effect<string, CoordinatorError>;
  /**
   * A cloud with a status command. One without (Claude Code cloud) pushes its branch as it
   * works, and its progress is read from that branch's head instead.
   */
  readonly status?: (run: RemoteRun) => Effect.Effect<CloudStatus, CoordinatorError>;
  /** For a cloud that pushes as it works: whether its session ended, as the provider says. */
  readonly ended?: (run: RemoteRun) => Effect.Effect<boolean, CoordinatorError>;
  readonly collect: (run: RemoteRun) => Effect.Effect<CloudCollected, CoordinatorError>;
}

export const exec = (
  runner: ProcessRunner.ProcessRunner["Service"],
  operation: string,
  input: ProcessRunner.ProcessRunInput,
) =>
  runner
    .run({ maxOutputBytes: 16 * 1024 * 1024, ...input })
    .pipe(
      Effect.mapError((cause) => new CoordinatorError({ operation, reason: "transport", cause })),
    );

export const git = (
  runner: ProcessRunner.ProcessRunner["Service"],
  cwd: string,
  args: ReadonlyArray<string>,
  stdin?: string,
) =>
  exec(runner, `cloud-git-${args[0]}`, {
    command: "git",
    args,
    cwd,
    stdin,
    timeout: "300 seconds",
  }).pipe(
    Effect.filterOrFail(
      (output) => output.code === 0,
      () => new CoordinatorError({ operation: `cloud-git-${args[0]}`, reason: "destination" }),
    ),
    Effect.map((output) => output.stdout),
  );

/** The branch's commit on origin, or "" when origin has no such branch. */
export const remoteHead = (
  runner: ProcessRunner.ProcessRunner["Service"],
  repository: string,
  branch: string,
) =>
  git(runner, repository, ["ls-remote", "origin", `refs/heads/${branch}`]).pipe(
    Effect.map((output) => output.trim().split(/\s/)[0] ?? ""),
  );

/** Runs `use` in a fresh detached worktree at `base`, never in the person's own checkout. */
export const withWorktree = Effect.fn("CloudDriver.withWorktree")(function* <A, E, R>(
  runner: ProcessRunner.ProcessRunner["Service"],
  fs: FileSystem.FileSystem,
  repository: string,
  base: string,
  use: (folder: string) => Effect.Effect<A, E, R>,
) {
  const folder = yield* fs
    .makeTempDirectory({ prefix: "t3-cloud-" })
    .pipe(
      Effect.mapError(
        (cause) =>
          new CoordinatorError({ operation: "cloud-worktree", reason: "transport", cause }),
      ),
    );
  return yield* git(runner, repository, ["worktree", "add", "--detach", folder, base]).pipe(
    Effect.flatMap(() => use(folder)),
    Effect.ensuring(
      git(runner, repository, ["worktree", "remove", "--force", folder]).pipe(
        Effect.ignore,
        Effect.andThen(fs.remove(folder, { recursive: true, force: true }).pipe(Effect.ignore)),
      ),
    ),
  );
});

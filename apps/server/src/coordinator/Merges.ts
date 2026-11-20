import { CoordinatorError, type ProjectId, type PullRequestRef } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as GitManager from "../git/GitManager.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import * as Supervisor from "./Supervisor.ts";

export interface MergeInput {
  readonly projectId: ProjectId;
  /** The repository's top folder: merges into one repository run one at a time. */
  readonly repository: string;
  /** Where the author's branch is checked out, to look up its pull request. */
  readonly cwd: string;
  readonly branch: string | null;
  /** The reviewed commit, the only one merged. */
  readonly head: string;
  readonly target: string;
  /** Whether the repository has a pull-request host. */
  readonly hosted: boolean;
  readonly message: string;
}

export type MergeOutcome =
  | {
      readonly merged: true;
      readonly how:
        | { readonly pullRequest: { readonly repository: string; readonly number: number } }
        | { readonly commit: string };
      /** The head that landed, when another than the reviewed one did. */
      readonly head?: string;
    }
  | {
      readonly merged: false;
      readonly waiting: string;
      /** It waits on the owner, not on the host or the author. */
      readonly owner?: boolean;
      /** The pull request is open at another head than the reviewed one: it needs a new review. */
      readonly moved?: string;
    };

const decodeContains = Schema.decodeUnknownEffect(Schema.Struct({ contains: Schema.Boolean }));
const decodeLocal = Schema.decodeUnknownEffect(
  Schema.Struct({
    merged: Schema.Boolean,
    commit: Schema.optional(Schema.String),
    waiting: Schema.optional(Schema.String),
    owner: Schema.optional(Schema.Boolean),
  }),
);

const decodeClean = Schema.decodeUnknownEffect(
  Schema.Struct({ clean: Schema.Boolean, held: Schema.Array(Schema.String) }),
);

export class Merges extends Context.Service<
  Merges,
  {
    /** Merges the reviewed commit if the host allows it now, or says what it waits for. */
    readonly merge: (input: MergeInput) => Effect.Effect<MergeOutcome, CoordinatorError>;
    /**
     * The pull request that reverts a merged one: the one already open or merged for it, or a
     * new one. Asked again, it opens no second.
     */
    readonly revert: (input: {
      readonly projectId: ProjectId;
      readonly repository: string;
      readonly number: number;
    }) => Effect.Effect<number | null, CoordinatorError>;
    /**
     * Whether the change is already on its branch, merged by anyone: a pull request merged into
     * the target, whatever its head, or with no host the reviewed commit on the branch.
     */
    readonly landed: (input: MergeInput) => Effect.Effect<MergeOutcome | null, CoordinatorError>;
    /**
     * Removes a worktree only if git tracks everything in it unchanged: one holding a change, an
     * untracked or an ignored file is kept, and what it holds is returned.
     */
    readonly removeWorktree: (input: {
      readonly repository: string;
      readonly path: string;
      /** Only on the owner's confirmed word: removes it whatever it holds. */
      readonly force?: boolean;
    }) => Effect.Effect<ReadonlyArray<string>, CoordinatorError>;
  }
>()("t3/coordinator/Merges") {}

const waiting = (reason: string, owner = false): MergeOutcome => ({
  merged: false,
  waiting: reason,
  ...(owner ? { owner } : {}),
});

const make = Effect.gen(function* () {
  const supervisor = yield* Supervisor.Supervisor;
  const git = yield* GitManager.GitManager;
  const workflow = yield* GitWorkflowService.GitWorkflowService;
  const pullRequests = yield* PullRequestService.PullRequestService;
  // Merges into one branch conflict with each other, so a repository takes one at a time.
  const gates = new Map<string, Semaphore.Semaphore>();
  const gate = (repository: string) => {
    let found = gates.get(repository);
    if (!found) {
      found = Semaphore.makeUnsafe(1);
      gates.set(repository, found);
    }
    return found;
  };

  // A merge is decided on what the host says now, never on a cached or held read.
  const fresh = (ref: PullRequestRef) =>
    pullRequests
      .invalidate({ reference: ref })
      .pipe(
        Effect.andThen(() =>
          pullRequests.summary({ ...ref, allowStale: false }, { recoverTransientFailure: false }),
        ),
      );
  const viaHost = Effect.fn("Merges.viaHost")(function* (input: MergeInput) {
    if (!input.branch)
      return waiting("The author's work has no branch to open a pull request for.");
    const found = yield* git.branchPullRequest(
      { cwd: input.cwd, branch: input.branch },
      { refresh: true },
    );
    if (!found) return waiting(`No pull request is open for ${input.branch}.`);
    const link = sourceControlDefinitions.parseChangeRequestUrl(found.url)?.link;
    if (!link) return waiting(`The pull request ${found.url} could not be read.`);
    const ref = { projectId: input.projectId, repository: link.repository, number: link.number };
    const how = { pullRequest: { repository: link.repository, number: link.number } };
    const summary = yield* fresh(ref);
    if (summary.headSha === undefined)
      return waiting(`The host did not say which commit pull request #${link.number} holds.`);
    if (summary.headSha !== input.head)
      return summary.state === "open"
        ? {
            merged: false as const,
            waiting: `Pull request #${link.number} is at ${summary.headSha}, not the reviewed ${input.head}.`,
            moved: summary.headSha,
          }
        : // Merged or closed at another head: only the owner can say what becomes of the work.
          waiting(
            `Pull request #${link.number} ${summary.state === "merged" ? "merged" : "closed at"} ${summary.headSha}, not the reviewed ${input.head}.`,
            true,
          );
    // Merged into another branch is not landed on this one.
    if (summary.baseBranch !== input.target)
      return waiting(
        `Pull request #${link.number} is against ${summary.baseBranch}, not ${input.target}.`,
      );
    // Whether a merged pull request is this work is decided by `landed` alone, before this.
    // Only the owner can say what becomes of work whose pull request merged without it, or closed.
    if (summary.state === "merged")
      return waiting(`Pull request #${link.number} was merged, but not with this work.`, true);
    if (summary.state === "closed")
      return waiting(`Pull request #${link.number} was closed without merging.`, true);
    if (summary.isDraft) return waiting(`Pull request #${link.number} is a draft.`);
    // None reported is not taken as none run: the pinned merge goes through only if the host
    // itself says nothing blocks it, required checks included.
    if (summary.checksState === "failing" || summary.checksState === "pending")
      return waiting(`The checks of pull request #${link.number} are ${summary.checksState}.`);
    if (summary.mergeability !== "mergeable")
      return waiting(
        summary.mergeability === "conflicting"
          ? `Pull request #${link.number} conflicts with ${input.target}.`
          : `The host has not said whether pull request #${link.number} can merge.`,
      );
    // The host merges this commit only; a host that cannot promise that never merges for us.
    const { capabilities } = yield* pullRequests.detail(ref);
    if (capabilities.pinnedMerge !== true)
      return waiting(
        `The host cannot merge exactly the reviewed commit; merge pull request #${link.number} yourself.`,
        true,
      );
    yield* pullRequests.runAction({ ...ref, action: "merge", expectedHeadSha: input.head });
    // What landed is read back, not taken from the reply. One the host only queued is seen
    // merged on a later pass.
    const landed = yield* fresh(ref);
    return landed.state === "merged" &&
      landed.headSha === input.head &&
      landed.baseBranch === input.target
      ? { merged: true as const, how }
      : waiting(`Pull request #${link.number} is queued to merge.`);
  });

  const locally = Effect.fn("Merges.locally")(function* (input: MergeInput) {
    const result = yield* supervisor
      .request("merges.local", {
        merge: { head: input.head, target: input.target, repository: input.repository },
        message: input.message,
      })
      .pipe(
        Effect.flatMap(decodeLocal),
        Effect.mapError(
          (cause) => new CoordinatorError({ operation: "merge-local", reason: "invalid", cause }),
        ),
      );
    return result.merged && result.commit
      ? { merged: true as const, how: { commit: result.commit } }
      : waiting(result.waiting ?? "The merge did not happen.", result.owner === true);
  });

  const merge = Effect.fn("Merges.merge")(function* (input: MergeInput) {
    const attempt: Effect.Effect<MergeOutcome, { readonly message: string }> = input.hosted
      ? viaHost(input)
      : locally(input);
    return yield* gate(input.repository).withPermits(1)(
      attempt.pipe(
        Effect.catch((cause) =>
          Effect.succeed(
            waiting(`The merge could not be checked: ${cause.message}`.slice(0, 1_000)),
          ),
        ),
      ),
    );
  });
  const removeWorktree = Effect.fn("Merges.removeWorktree")(function* (input: {
    readonly repository: string;
    readonly path: string;
    readonly force?: boolean;
  }) {
    const { clean, held } = input.force
      ? { clean: true, held: [] }
      : yield* supervisor.request("results.clean", { repository: input.path }).pipe(
          Effect.flatMap(decodeClean),
          Effect.mapError(
            (cause) =>
              new CoordinatorError({ operation: "worktree-status", reason: "destination", cause }),
          ),
        );
    if (!clean) return held;
    yield* workflow
      .removeWorktree({ cwd: input.repository, path: input.path, force: input.force === true })
      .pipe(
        Effect.mapError(
          (cause) =>
            new CoordinatorError({ operation: "worktree-remove", reason: "destination", cause }),
        ),
      );
    return [];
  });
  // The host names a revert's branch after what it reverts: `revert-<number>-<branch>`.
  const findRevert = Effect.fn("Merges.findRevert")(function* (input: {
    readonly projectId: ProjectId;
    readonly repository: string;
    readonly number: number;
  }) {
    let cursors: Record<string, string> | undefined;
    do {
      const page = yield* pullRequests.list({
        state: "all",
        projectId: input.projectId,
        query: "Revert",
        ...(cursors ? { cursors } : {}),
      });
      const found = page.entries.find(
        (entry) =>
          entry.repository.toLowerCase() === input.repository.toLowerCase() &&
          entry.state !== "closed" &&
          entry.headBranch.startsWith(`revert-${input.number}-`),
      );
      if (found) return found.number;
      cursors = Object.keys(page.nextCursors).length ? page.nextCursors : undefined;
    } while (cursors);
    return null;
  });
  const revert = Effect.fn("Merges.revert")(
    function* (input: {
      readonly projectId: ProjectId;
      readonly repository: string;
      readonly number: number;
    }) {
      const existing = yield* findRevert(input);
      if (existing !== null) return existing;
      yield* pullRequests.runAction({ ...input, action: "revert" });
      return yield* findRevert(input);
    },
    Effect.mapError(
      (cause) => new CoordinatorError({ operation: "revert", reason: "destination", cause }),
    ),
  );
  const landed = Effect.fn("Merges.landed")(
    function* (input: MergeInput) {
      if (!input.hosted) {
        const result = yield* supervisor
          .request("merges.local", {
            merge: { head: input.head, target: input.target, repository: input.repository },
            detect: true,
          })
          .pipe(Effect.flatMap(decodeLocal));
        return result.merged && result.commit
          ? ({ merged: true, how: { commit: result.commit } } as const)
          : null;
      }
      if (!input.branch) return null;
      const found = yield* git.branchPullRequest(
        { cwd: input.cwd, branch: input.branch },
        { refresh: true },
      );
      const link = found && sourceControlDefinitions.parseChangeRequestUrl(found.url)?.link;
      if (!link) return null;
      const summary = yield* fresh({
        projectId: input.projectId,
        repository: link.repository,
        number: link.number,
      });
      if (summary.state !== "merged" || summary.baseBranch !== input.target || !summary.headSha)
        return null;
      const how = { pullRequest: { repository: link.repository, number: link.number } };
      if (summary.headSha === input.head) return { merged: true, how } as const;
      // At another head, it is this work only if it holds the reviewed commit: a branch name can
      // be reused, and an old pull request of it says nothing of this work.
      const { contains } = yield* supervisor
        .request("merges.contains", {
          repository: input.repository,
          head: input.head,
          tips: [
            summary.headSha,
            `refs/remotes/origin/${input.target}`,
            `refs/heads/${input.target}`,
          ],
        })
        .pipe(Effect.flatMap(decodeContains));
      return contains ? ({ merged: true, how, head: summary.headSha } as const) : null;
    },
    Effect.mapError(
      (cause) => new CoordinatorError({ operation: "merge-landed", reason: "destination", cause }),
    ),
  );
  return Merges.of({ merge, removeWorktree, revert, landed });
});

export const layer = Layer.effect(Merges, make);

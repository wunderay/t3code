import { assert, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as GitManager from "../git/GitManager.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as Merges from "./Merges.ts";
import * as Supervisor from "./Supervisor.ts";

const HEAD = "a".repeat(40);
const input = (repository = "/repo", branch = "t3/feature"): Merges.MergeInput => ({
  projectId: ProjectId.make("project"),
  repository,
  cwd: "/work",
  branch,
  head: HEAD,
  target: "main",
  hosted: true,
  message: "Merge",
});
const open = {
  provider: "github",
  projectId: "project",
  repository: "owner/repo",
  title: "Feature",
  url: "https://github.com/owner/repo/pull/7",
  state: "open",
  headBranch: "t3/feature",
  baseBranch: "main",
  updatedAt: "2026-11-12T00:00:00.000Z",
  headSha: HEAD,
  isDraft: false,
  checksState: "passing",
  mergeability: "mergeable",
};

const NUMBERS: Record<string, number> = { "t3/feature": 7, "t3/other": 8, "t3/third": 9 };
const branchOf = (number: number) =>
  Object.keys(NUMBERS).find((branch) => NUMBERS[branch] === number) ?? "t3/feature";

const harness = (
  summary: (branch: string) => Record<string, unknown> | null,
  actions: Array<{ number: number; repository: string; expectedHeadSha?: string | undefined }>,
  local: Array<unknown> = [],
  // Holds the merge action of the named branch until released.
  hold?: { branch: string; entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> },
  // What the host merges in place of the named head, as a push just before the merge would.
  landed?: string,
  pinnedMerge = true,
) => {
  const merged = new Set<number>();
  const reverts = new Set<number>();
  const invalidated: Array<number | undefined> = [];
  return Merges.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          Supervisor.Supervisor,
          Supervisor.Supervisor.of({
            available: true,
            request: (method, params) =>
              Effect.sync(() => {
                local.push({ method, params });
                // A head named `…holds` holds the reviewed commit; any other does not.
                if (method === "merges.contains")
                  return {
                    contains: (params as { tips: Array<string> }).tips[0]?.startsWith("4"),
                  };
                return { merged: true, commit: HEAD };
              }),
          }),
        ),
        Layer.mock(GitManager.GitManager)({
          branchPullRequest: ({ branch }) =>
            Effect.succeed(
              summary(branch) === null
                ? null
                : ({
                    url: `https://github.com/owner/repo/pull/${NUMBERS[branch]}`,
                  } as never),
            ),
        }),
        Layer.mock(GitWorkflowService.GitWorkflowService)({}),
        Layer.mock(PullRequestService.PullRequestService)({
          detail: () => Effect.succeed({ capabilities: { pinnedMerge } } as never),
          invalidate: (input) => Effect.sync(() => void invalidated.push(input.reference?.number)),
          summary: (ref) =>
            ref.allowStale !== false
              ? Effect.die("a merge decided on a cached read")
              : invalidated.at(-1) !== ref.number
                ? Effect.die("a merge decided on a read not made fresh")
                : Effect.succeed({
                    ...summary(branchOf(ref.number)),
                    ...(merged.has(ref.number) ? { state: "merged", headSha: landed ?? HEAD } : {}),
                  } as never),
          list: () =>
            Effect.succeed({
              entries: [...reverts].map((number) => ({
                repository: "owner/repo",
                number: number + 100,
                state: "open",
                headBranch: `revert-${number}-${branchOf(number)}`,
              })),
              nextCursors: {},
            } as never),
          runAction: (ref) =>
            Effect.gen(function* () {
              if (ref.action === "revert") {
                actions.push({ number: ref.number, repository: ref.repository });
                reverts.add(ref.number);
                return undefined;
              }
              const branch = branchOf(ref.number);
              actions.push({
                number: ref.number,
                repository: ref.repository,
                expectedHeadSha: ref.expectedHeadSha,
              });
              if (hold?.branch === branch) {
                yield* Deferred.succeed(hold.entered, undefined);
                yield* Deferred.await(hold.release);
              }
              merged.add(ref.number);
              return undefined;
            }),
        }),
      ),
    ),
  );
};

it.effect("a pull request merges only when the host says its reviewed commit can", () =>
  Effect.gen(function* () {
    const attempt = (changes: Record<string, unknown> | null) => {
      const actions: Array<{ number: number; repository: string }> = [];
      return Effect.gen(function* () {
        const merges = yield* Merges.Merges;
        const outcome = yield* merges.merge(input());
        return { outcome, actions: actions.length };
      }).pipe(
        Effect.provide(harness(() => (changes === null ? null : { ...open, ...changes }), actions)),
      );
    };
    assert.deepEqual(yield* attempt({}), {
      outcome: { merged: true, how: { pullRequest: { repository: "owner/repo", number: 7 } } },
      actions: 1,
    });
    // A merged pull request is never merged again; whether it is this work, `landed` decides.
    assert.deepEqual((yield* attempt({ state: "merged" })).actions, 0);
    // Merged without it, closed, or ended at another head than the reviewed one: the owner's too.
    for (const changes of [
      { state: "merged" },
      { state: "closed" },
      { state: "merged", headSha: "b".repeat(40) },
      { state: "closed", headSha: "b".repeat(40) },
    ]) {
      const theirs = (yield* attempt(changes)).outcome;
      assert.deepEqual(
        [theirs.merged, "owner" in theirs && theirs.owner],
        [false, true],
        JSON.stringify(changes),
      );
    }
    // What the author can fix stays with the Coordinator.
    const fixable = (yield* attempt({ mergeability: "conflicting" })).outcome;
    assert.isFalse("owner" in fixable);
    for (const changes of [
      null,
      { headSha: "b".repeat(40) },
      { state: "merged", headSha: "b".repeat(40) },
      { state: "closed" },
      { baseBranch: "release" },
      { state: "merged", baseBranch: "release" },
      { isDraft: true },
      { checksState: "pending" },
      { checksState: "failing" },
      { mergeability: "conflicting" },
      { mergeability: "unknown" },
    ]) {
      const waited = yield* attempt(changes);
      assert.deepEqual(
        [waited.outcome.merged, waited.actions],
        [false, 0],
        JSON.stringify(changes),
      );
    }
    // Only the reviewed commit is asked for, and only that commit landed counts as merged.
    const pinned: Array<{ expectedHeadSha?: string | undefined }> = [];
    yield* Effect.gen(function* () {
      const moved = yield* (yield* Merges.Merges).merge(input());
      assert.equal(moved.merged, false);
    }).pipe(Effect.provide(harness(() => open, pinned as never, [], undefined, "c".repeat(40))));
    assert.deepEqual(
      pinned.map((action) => action.expectedHeadSha),
      [HEAD],
    );
    // An open pull request moved past the reviewed commit says to which head.
    const pushed = yield* attempt({ headSha: "b".repeat(40) });
    assert.equal("moved" in pushed.outcome && pushed.outcome.moved, "b".repeat(40));
    // A host that cannot be told the commit never merges; the owner does.
    const unpinned: Array<{ number: number; repository: string }> = [];
    const left = yield* Effect.gen(function* () {
      return yield* (yield* Merges.Merges).merge(input());
    }).pipe(Effect.provide(harness(() => open, unpinned, [], undefined, undefined, false)));
    assert.deepEqual([left.merged, "owner" in left && left.owner, unpinned], [false, true, []]);
    // A repository that runs no checks reports none.
    assert.equal((yield* attempt({ checksState: null })).outcome.merged, true);
  }),
);

it.effect("with no host the store merges by refs, and one repository merges one at a time", () =>
  Effect.gen(function* () {
    const local: Array<unknown> = [];
    const actions: Array<{ number: number; repository: string }> = [];
    const hold = {
      branch: "t3/feature",
      entered: yield* Deferred.make<void>(),
      release: yield* Deferred.make<void>(),
    };
    yield* Effect.gen(function* () {
      const merges = yield* Merges.Merges;
      const unhosted = yield* merges.merge({ ...input(), hosted: false });
      assert.deepEqual(unhosted, { merged: true, how: { commit: HEAD } });
      assert.deepEqual(local, [
        {
          method: "merges.local",
          params: {
            merge: { head: HEAD, target: "main", repository: "/repo" },
            message: "Merge",
          },
        },
      ]);
      const first = yield* Effect.forkChild(merges.merge(input()), { startImmediately: true });
      yield* Deferred.await(hold.entered);
      // Started at once, so only the gate can keep it from merging before the next line.
      const second = yield* Effect.forkChild(merges.merge(input("/repo", "t3/other")), {
        startImmediately: true,
      });
      // Another repository is not held back by this one.
      yield* merges.merge(input("/elsewhere", "t3/third"));
      assert.deepEqual(
        actions.map((action) => action.number),
        [7, 9],
      );
      yield* Deferred.succeed(hold.release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      assert.deepEqual(
        actions.map((action) => action.number),
        [7, 9, 8],
      );
    }).pipe(Effect.provide(harness(() => open, actions, local, hold)));
  }),
);

it.effect("asked twice, a revert opens one pull request and finds it the second time", () =>
  Effect.gen(function* () {
    const actions: Array<{ number: number; repository: string }> = [];
    yield* Effect.gen(function* () {
      const merges = yield* Merges.Merges;
      const ref = { projectId: ProjectId.make("project"), repository: "owner/repo", number: 7 };
      assert.equal(yield* merges.revert(ref), 107);
      assert.equal(yield* merges.revert(ref), 107);
      assert.deepEqual(actions, [{ number: 7, repository: "owner/repo" }]);
    }).pipe(Effect.provide(harness(() => open, actions)));
  }),
);

it.effect("a pull request merged by anyone has landed only if it holds the reviewed commit", () =>
  Effect.gen(function* () {
    const landed = (changes: Record<string, unknown>) =>
      Effect.gen(function* () {
        return yield* (yield* Merges.Merges).landed(input());
      }).pipe(Effect.provide(harness(() => ({ ...open, ...changes }), [])));
    assert.deepEqual(yield* landed({ state: "merged" }), {
      merged: true,
      how: { pullRequest: { repository: "owner/repo", number: 7 } },
    });
    // Merged at another head that holds the reviewed commit: this work landed, and says where.
    assert.deepEqual(yield* landed({ state: "merged", headSha: "4".repeat(40) }), {
      merged: true,
      how: { pullRequest: { repository: "owner/repo", number: 7 } },
      head: "4".repeat(40),
    });
    // One that does not (an old pull request of a reused branch name) is not this work.
    assert.isNull(yield* landed({ state: "merged", headSha: "f".repeat(40) }));
    assert.isNull(yield* landed({ state: "open" }));
    assert.isNull(yield* landed({ state: "merged", baseBranch: "release" }));
  }),
);

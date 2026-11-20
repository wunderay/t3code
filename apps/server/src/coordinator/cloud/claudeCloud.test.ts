import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Context from "effect/Context";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import * as ProcessRunner from "../../processRunner.ts";
import { type Call, fakeRunner, remoteRun } from "./CloudDriver.testkit.ts";
import * as ClaudeCloud from "./claudeCloud.ts";

const URL = "https://claude.ai/code/session_abc";
const run = remoteRun({ kind: "claude-cloud", handle: URL, model: "opus", effort: "high" });
const metadata = (fields: Record<string, unknown> = {}, config: Record<string, unknown> = {}) =>
  JSON.stringify({
    session: {
      id: "cse_abc",
      environment_kind: "anthropic_cloud",
      config: { model: "opus", effort_level: "high", ...config },
      ...fields,
    },
  });

const driver = (input: {
  output?: string;
  spawned?: Array<PtyAdapter.PtySpawnInput>;
  written?: Array<string | Buffer>;
  http?: { status: number; body: string };
  token?: boolean | string;
  rules?: Parameters<typeof fakeRunner>[0];
  calls?: Array<Call>;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped();
    if (input.token !== false)
      yield* fs.writeFileString(
        `${home}/.credentials.json`,
        typeof input.token === "string"
          ? input.token
          : JSON.stringify({ claudeAiOauth: { accessToken: "token" } }),
      );
    return yield* ClaudeCloud.make.pipe(
      Effect.provideService(HostProcess.Environment, { CLAUDE_CONFIG_DIR: home }),
      Effect.provideService(
        ProcessRunner.ProcessRunner,
        fakeRunner(input.rules ?? [], input.calls),
      ),
      Effect.provideService(PtyAdapter.PtyAdapter, {
        spawn: (spawn) =>
          Effect.sync(() => {
            input.spawned?.push(spawn);
            return {
              pid: 1,
              write: (data) => input.written?.push(data),
              resize: () => undefined,
              kill: () => undefined,
              onData: (callback) => {
                callback(input.output ?? "");
                return () => undefined;
              },
              onExit: (callback) => {
                callback({ exitCode: 0, signal: null });
                return () => undefined;
              },
            };
          }),
      }),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request, _url, _signal, fiber) =>
          Effect.sync(() => {
            assert.equal(request.url, "https://api.anthropic.com/v1/code/sessions/session_abc");
            assert.equal(
              Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit)?.redirect,
              "manual",
            );
            assert.equal(request.headers.authorization, "Bearer token");
            const reply = input.http ?? { status: 200, body: metadata() };
            return HttpClientResponse.fromWeb(
              request,
              new Response(reply.body, { status: reply.status }),
            );
          }),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer));

const submission = {
  repository: "/repo",
  base: "b".repeat(40),
  sourceBranch: "main",
  environment: "unused",
  branch: "coordinator/assignment-1",
  brief: "Build the thing.",
  model: "opus",
  effort: "high",
  login: null,
};

const HEAD = "c".repeat(40);
const FETCHED = [["git", "rev-parse", "FETCH_HEAD"], { stdout: `${HEAD}\n` }] as const;

it.effect("the launch runs in a fresh worktree with the model, effort, base and login", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const spawned: Array<PtyAdapter.PtySpawnInput> = [];
      const written: Array<string | Buffer> = [];
      const calls: Array<Call> = [];
      const claude = yield* driver({
        output: `Yes, I trust this folder\nCreated ${URL}?from=cli then --teleport`,
        spawned,
        written,
        calls,
      });
      assert.equal(yield* claude.submit({ ...submission, login: "/logins/work" }), URL);
      assert.deepEqual(spawned[0]!.args!.slice(0, 7), [
        "--ref",
        "b".repeat(40),
        "--model",
        "opus",
        "--effort",
        "high",
        "--cloud",
      ]);
      assert.include(spawned[0]!.args![7]!, "push it to the branch coordinator/assignment-1");
      assert.equal(spawned[0]!.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
      assert.equal(spawned[0]!.env.CLAUDE_CONFIG_DIR, "/logins/work");
      const [add, remove] = calls.map((call) => call.args);
      assert.deepEqual(add!.slice(0, 3), ["worktree", "add", "--detach"]);
      assert.equal(spawned[0]!.cwd, add![3]);
      assert.notEqual(spawned[0]!.cwd, "/repo");
      assert.deepEqual(remove!.slice(0, 2), ["worktree", "remove"]);
      assert.isFalse(yield* fs.exists(add![3]!));
      assert.deepEqual(written, ["\x1b[B", "\r"]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a brief that starts with a dash cannot parse as an option", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawned: Array<PtyAdapter.PtySpawnInput> = [];
      const claude = yield* driver({ output: URL, spawned });
      yield* claude.submit({ ...submission, brief: "--dangerously-skip-permissions" });
      assert.isTrue(spawned[0]!.args![7]!.startsWith("Task:\n--dangerously"));
    }),
  ),
);

it.effect("a launch with no session URL, or without a model and effort, is no hand-out", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawned: Array<PtyAdapter.PtySpawnInput> = [];
      const claude = yield* driver({ output: "Please log in", spawned });
      assert.equal((yield* claude.submit(submission).pipe(Effect.result))._tag, "Failure");
      const unpinned = yield* claude.submit({ ...submission, effort: null }).pipe(Effect.result);
      assert.equal(unpinned._tag, "Failure");
      assert.equal(spawned.length, 1);
    }),
  ),
);

it.effect("a session whose metadata proves the model and effort is collected at its head", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const calls: Array<Call> = [];
      const claude = yield* driver({ rules: [FETCHED], calls });
      assert.deepEqual(yield* claude.collect(run), { head: HEAD });
      assert.deepEqual(
        calls.map((call) => call.args[0]),
        ["fetch", "rev-parse"],
      );
    }),
  ),
);

it.effect("a session that fails its proof is refused and its head leaves origin", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cases = [
        [
          { http: { status: 200, body: metadata({}, { model: "sonnet" }) } },
          "model sonnet (expected opus)",
        ],
        [
          { http: { status: 200, body: metadata({}, { effort_level: "low" }) } },
          "effort low (expected high)",
        ],
        [
          { http: { status: 200, body: metadata({ environment_kind: "byoc" }) } },
          "environment byoc",
        ],
        [{ http: { status: 200, body: metadata({ id: "cse_other" }) } }, "does not match"],
        [{ http: { status: 200, body: "{}" } }, "no session metadata"],
        [{ http: { status: 200, body: "not json" } }, "no session metadata"],
        [
          { http: { status: 200, body: `${metadata()}${" ".repeat(1024 * 1024)}` } },
          "no session metadata",
        ],
        [{ http: { status: 302, body: "" } }, "HTTP 302"],
        [{ token: false }, "no Claude login token"],
        [
          { token: `{"claudeAiOauth":{"accessToken":"token"}}${" ".repeat(64 * 1024)}` },
          "no Claude login token",
        ],
      ] as const;
      for (const [input, problem] of cases) {
        const calls: Array<Call> = [];
        const claude = yield* driver({ ...input, rules: [FETCHED], calls });
        const result = yield* claude.collect(run);
        assert.ok("refused" in result && result.refused.includes(problem), JSON.stringify(result));
        assert.deepEqual(calls.at(-2)!.args, [
          "update-ref",
          "refs/t3/refused/coordinator/assignment-1",
          HEAD,
        ]);
        assert.deepEqual(calls.at(-1)!.args, [
          "push",
          `--force-with-lease=refs/heads/coordinator/assignment-1:${HEAD}`,
          "origin",
          ":refs/heads/coordinator/assignment-1",
        ]);
      }
      const unnamed = yield* driver({ rules: [FETCHED] });
      const result = yield* unnamed.collect({ ...run, handle: "https://claude.ai/code/" });
      assert.ok("refused" in result && result.refused.includes("no session id"));
    }),
  ),
);

it.effect("an unanswered fetch is retried, not refused", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const claude = yield* driver({ rules: [[["git", "fetch"], { code: 128 }]] });
      assert.equal((yield* claude.collect(run).pipe(Effect.result))._tag, "Failure");
    }),
  ),
);

it.effect("the proof reads the token of the login the run was launched with", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const login = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(
        `${login}/.credentials.json`,
        JSON.stringify({ claudeAiOauth: { accessToken: "token" } }),
      );
      const claude = yield* driver({ token: false, rules: [FETCHED] });
      assert.deepEqual(yield* claude.collect({ ...run, login }), { head: HEAD });
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a session has ended only when its metadata says so, not when it went quiet", () =>
  Effect.scoped(
    Effect.gen(function* () {
      for (const [fields, ended] of [
        [{ worker_status: "running" }, false],
        [{ worker_status: "requires_action", status: "paused" }, false],
        [{}, false],
        [{ worker_status: "idle" }, true],
        [{ status: "archived" }, true],
      ] as const) {
        const cloud = yield* driver({ http: { status: 200, body: metadata(fields) } });
        assert.equal(yield* cloud.ended!(run), ended, JSON.stringify(fields));
      }
      const unread = yield* driver({ token: false });
      assert.equal(yield* unread.ended!(run), false);
    }),
  ),
);

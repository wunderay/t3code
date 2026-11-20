// @effect-diagnostics nodeBuiltinImport:off -- stand-in provider CLIs run as real processes in real sandboxes.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as PlatformNodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { CodexSettings, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { ProviderEventLoggers } from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { HttpServer, HttpServerResponse } from "effect/http";

import * as ServerConfig from "../config.ts";
import { localMcpAuthority } from "../mcp/localMcpAuthority.ts";
import {
  ClaudeAgentSdkQueryRunner,
  layerQueryRunner,
} from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CodexAdapterV2 from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import { explicitBareRepositoryEnv, isolatedFolderGitEnv } from "../vcs/VcsProcess.ts";
import {
  layer,
  SandboxRuntimeSource,
  ThreadIsolation,
  ThreadIsolationError,
} from "./threadIsolation.ts";

/** Where `command` is installed on this machine, if it is. */
const installed = (command: string) => {
  const found = NodeChildProcess.spawnSync("sh", ["-c", `command -v ${command}`], {
    encoding: "utf8",
  });
  return found.status === 0 ? found.stdout.trim() : undefined;
};
const has = (command: string) => installed(command) !== undefined;
// Docker threads reach the proxy through socat on the host, so Docker without it is not a backend.
const dockerUsable = () =>
  has("docker") &&
  has("socat") &&
  NodeChildProcess.spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
const srtUsable = HostProcess.Platform.defaultValue() === "linux" && has("bwrap") && has("socat");
const hostEnv: NodeJS.ProcessEnv = { ...process.env };

const run = (command: string, args: ReadonlyArray<string>, cwd: string) =>
  NodeChildProcess.execFileSync(command, args, {
    cwd,
    stdio: "pipe",
    env: { ...hostEnv, GIT_CONFIG_NOSYSTEM: "1" },
  });

/**
 * A provider CLI that reports how it was started, through a pipe the test reads: arguments,
 * folder, HOME, the variables that must or must not reach it, whether a host secret is
 * readable, and, where the test listens for it, its first line of input. As Codex, it also
 * writes a conversation the way Codex does, to see it outlive the session.
 */
const stubCli = (file: string, secret: string, conversation: string) => {
  NodeFS.writeFileSync(
    file,
    [
      "#!/bin/sh",
      "{",
      '  printf "cwd=%s\\n" "$PWD"',
      '  printf "home=%s\\n" "$HOME"',
      '  for a in "$@"; do printf "arg=%s\\n" "$a"; done',
      "  for name in GITHUB_TOKEN T3CODE_DEV_AUTH_TOKEN ANTHROPIC_API_KEY OPENAI_API_KEY T3CODE_ISOLATED_ARGS; do",
      '    eval "value=\\${$name-unset}"; printf "env=%s=%s\\n" "$name" "$value"',
      "  done",
      `  if cat ${secret} >/dev/null 2>&1; then echo secret=read; else echo secret=hidden; fi`,
      '  if [ -n "$CODEX_HOME" ]; then',
      '    printf "conversations=%s\\n" "$(find "$CODEX_HOME/sessions/" -name "rollout-*" | wc -l)"',
      '    printf "credential=%s\\n" "$(cat "$CODEX_HOME/auth.json")"',
      // A sign-in refresh, written where Codex keeps it.
      `    printf '{"tokens":{"access_token":"rotated-%s","refresh_token":"r","account_id":"a"}}' "$$" > "$CODEX_HOME/auth.json"`,
      '    mkdir -p "$CODEX_HOME/sessions/2026/11/12"',
      `    touch "$CODEX_HOME/sessions/2026/11/12/rollout-2026-11-12T00-00-00-${conversation}.jsonl"`,
      "  fi",
      '} > "$PWD/.launch"',
      'if [ -p "$PWD/.stdin" ]; then IFS= read -r line; printf "%s\\n" "$line" > "$PWD/.stdin"; fi',
      "cat > /dev/null",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
};

interface Launch {
  readonly cwd: string;
  readonly home: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly secret: string;
  readonly conversations: string | undefined;
  readonly credential: string | undefined;
}

const readLaunch = (text: string): Launch => {
  const lines = text.trimEnd().split("\n");
  const values = (key: string) =>
    lines.filter((line) => line.startsWith(`${key}=`)).map((line) => line.slice(key.length + 1));
  return {
    cwd: values("cwd")[0]!,
    home: values("home")[0]!,
    args: values("arg"),
    env: Object.fromEntries(
      values("env").map((entry) => [
        entry.slice(0, entry.indexOf("=")),
        entry.slice(entry.indexOf("=") + 1),
      ]),
    ),
    secret: values("secret")[0]!,
    conversations: values("conversations")[0],
    credential: values("credential")[0],
  };
};

/** Pipes the stand-in reports through; reading one waits for the report. */
const listen = (folder: string, stdin: boolean) => {
  for (const name of [".launch", ...(stdin ? [".stdin"] : [])]) {
    const fifo = NodePath.join(folder, name);
    if (!NodeFS.existsSync(fifo)) NodeChildProcess.execFileSync("mkfifo", [fifo]);
  }
};
const report = (folder: string, name: ".launch" | ".stdin") =>
  Effect.promise(() => NodeFS.promises.readFile(NodePath.join(folder, name), "utf8"));

/** Runs a launch without blocking this process, whose proxy the sandbox goes through. */
const runAsync = (
  launch: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly env: NodeJS.ProcessEnv;
  },
  cwd: string,
) =>
  Effect.promise(
    () =>
      new Promise<{ readonly stdout: string; readonly stderr: string }>((resolve) => {
        NodeChildProcess.execFile(
          launch.command,
          [...launch.args],
          { cwd, env: launch.env, encoding: "utf8" },
          (_error, stdout, stderr) => resolve({ stdout, stderr }),
        );
      }),
  );

const CONVERSATION = "0199a0f1-2b3c-7d4e-8f90-123456789abc";
const DEFAULT_CODEX_SETTINGS = Schema.decodeSync(CodexSettings)({});

/** The real isolation layer on a host with a home folder of its own and the two stand-ins. */
const sandboxHost = (backend: "srt" | "docker", writableFolders: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const root = NodeFS.realpathSync(NodeFS.mkdtempSync("/tmp/t3-isolation-e2e-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
    );
    const home = NodePath.join(root, "home");
    const tools = NodePath.join(root, "tools");
    for (const folder of [tools, NodePath.join(home, ".claude"), NodePath.join(home, ".codex")]) {
      NodeFS.mkdirSync(folder, { recursive: true });
    }
    const secret = NodePath.join(home, "secret.txt");
    NodeFS.writeFileSync(secret, "secret");
    NodeFS.writeFileSync(
      NodePath.join(home, ".codex", "auth.json"),
      '{"tokens":{"access_token":"t","refresh_token":"r","account_id":"a"}}',
    );
    for (const name of ["claude", "codex"])
      stubCli(NodePath.join(tools, name), secret, CONVERSATION);

    const repository = NodePath.join(home, "repository");
    const plain = NodePath.join(home, "plain");
    const worktree = NodePath.join(home, "worktree");
    NodeFS.mkdirSync(repository);
    NodeFS.mkdirSync(plain);
    run("git", ["init", "-q", "-b", "main"], repository);
    run(
      "git",
      [
        "-c",
        "user.name=T",
        "-c",
        "user.email=t@example.com",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "x",
      ],
      repository,
    );
    run("git", ["worktree", "add", "-q", worktree], repository);
    for (const name of writableFolders) run("git", ["init", "-q", name], home);

    const PATH = `${tools}:${hostEnv.PATH}`;
    const context = yield* Layer.build(
      layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            ServerSettings.layerTest({
              threadIsolation: true,
              threadIsolationPolicy: {
                writableFolders: writableFolders.map((name) => NodePath.join(home, name)),
              },
            }),
            ProcessRunner.layer,
            ServerConfig.layerTest(repository, { prefix: "t3-isolation-e2e-" }),
          ),
        ),
        Layer.provideMerge(NodeHttpServer.layerTest),
      ),
    ).pipe(
      Effect.provideService(HostProcess.HomeDirectory, home),
      Effect.provideService(HostProcess.Environment, { PATH }),
      backend === "docker"
        ? Effect.provideService(
            SandboxRuntimeSource,
            Effect.fail(new ThreadIsolationError({ detail: "srt is left out of this test" })),
          )
        : (effect) => effect,
    );
    const isolation = yield* Effect.service(ThreadIsolation).pipe(Effect.provide(context));
    // This server's own HTTP port, answering every path, as T3 Code's does.
    const httpServer = yield* Effect.service(HttpServer.HttpServer).pipe(Effect.provide(context));
    yield* httpServer.serve(Effect.succeed(HttpServerResponse.text("this server answers")));
    const mcp = localMcpAuthority(httpServer.address)!;
    assert.strictEqual((yield* isolation.status)?.backend, backend);
    const services = Layer.mergeAll(
      Layer.succeed(ThreadIsolation, isolation),
      PortScanner.layerTest,
      Layer.succeed(ProviderEventLoggers, { native: undefined, canonical: undefined }),
      NodeServices.layer,
      PlatformNodeCrypto.layer,
    );
    const env = {
      PATH,
      ANTHROPIC_API_KEY: "a",
      OPENAI_API_KEY: "o",
      GITHUB_TOKEN: "g",
      T3CODE_DEV_AUTH_TOKEN: "d",
    };
    let sessions = 0;

    /** One Claude session through the real query runner, as the Claude adapter opens it. */
    const claude = (cwd: string, resume?: string) =>
      Effect.gen(function* () {
        sessions += 1;
        const providerSessionId = ProviderSessionId.make(`session-claude-${sessions}`);
        const sessionId = NodeCrypto.randomUUID();
        const runner = yield* ClaudeAgentSdkQueryRunner;
        listen(cwd, true);
        const session = yield* runner.open({
          threadId: ThreadId.make("thread-claude"),
          providerSessionId,
          options: {
            ...(resume === undefined ? { sessionId } : { resume }),
            model: "claude-sonnet-4-6",
            tools: [],
            permissionMode: "default",
            pathToClaudeCodeExecutable: NodePath.join(tools, "claude"),
            cwd,
            env,
          },
        });
        const launch = readLaunch(yield* report(cwd, ".launch"));
        const stdin = yield* report(cwd, ".stdin");
        yield* session.close;
        yield* isolation.release(providerSessionId);
        return { launch, stdin, sessionId };
      }).pipe(Effect.provide(layerQueryRunner.pipe(Layer.provide(services))));

    /** One Codex app-server through the real client factory, as the Codex adapter opens it. */
    const codex = (cwd: string, resumed?: string) =>
      Effect.gen(function* () {
        sessions += 1;
        const providerSessionId = ProviderSessionId.make(`session-codex-${sessions}`);
        const factory = yield* CodexAdapterV2.CodexAppServerClientFactory;
        const scope = yield* Scope.make();
        listen(cwd, false);
        yield* factory
          .open({
            instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
            threadId: ThreadId.make("thread-codex"),
            providerSessionId,
            runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd,
            }),
            settings: { ...DEFAULT_CODEX_SETTINGS, binaryPath: NodePath.join(tools, "codex") },
            environment: env,
            ...(resumed === undefined ? {} : { initialNativeThreadId: resumed }),
          })
          .pipe(Effect.provideService(Scope.Scope, scope));
        const launch = readLaunch(yield* report(cwd, ".launch"));
        yield* Scope.close(scope, Exit.void);
        yield* isolation.release(providerSessionId);
        return launch;
      }).pipe(
        Effect.provide(CodexAdapterV2.layerAppServerClientFactory.pipe(Layer.provide(services))),
      );

    /** A real installed CLI's `--version`, run inside the sandbox. */
    const version = (command: "claude" | "codex") =>
      Effect.gen(function* () {
        const launch = yield* isolation.wrap({
          provider: command,
          command: installed(command)!,
          args: ["--version"],
          cwd: repository,
          env: { PATH },
          key: `version-${command}`,
        });
        assert.isDefined(launch);
        const output = (yield* runAsync(launch!, repository)).stdout;
        yield* isolation.release(`version-${command}`);
        return output;
      });

    /** A shell script run inside the sandbox, as a thread's tool would run it. */
    const inside = (cwd: string, script: string) =>
      Effect.gen(function* () {
        sessions += 1;
        const key = `script-${sessions}`;
        const launch = yield* isolation.wrap({
          provider: "codex",
          command: "/bin/sh",
          args: ["-c", script],
          cwd,
          env: { PATH },
          key,
        });
        const result = yield* runAsync(launch!, cwd);
        yield* isolation.release(key);
        return `${result.stdout}${result.stderr}`;
      });

    return {
      claude,
      codex,
      version,
      inside,
      home,
      secret,
      repository,
      plain,
      worktree,
      tools,
      mcp,
    };
  }).pipe(Effect.provideService(HostProcess.Platform, "linux"), Effect.provide(NodeServices.layer));

const expectIsolated = (launch: Launch, cwd: string, home: string) => {
  assert.strictEqual(launch.cwd, cwd);
  assert.notStrictEqual(launch.home, home);
  assert.strictEqual(launch.secret, "hidden");
  assert.strictEqual(launch.env.GITHUB_TOKEN, "unset");
  assert.strictEqual(launch.env.T3CODE_DEV_AUTH_TOKEN, "unset");
  assert.strictEqual(launch.env.T3CODE_ISOLATED_ARGS, "unset");
};

const matrix = (backend: "srt" | "docker", usable: () => boolean) =>
  describe.skipIf(!usable())(`thread isolation with ${backend}, end to end`, () => {
    it.live(
      "starts Claude with the SDK's own arguments, in each kind of folder, twice and on resume",
      () =>
        Effect.gen(function* () {
          const host = yield* sandboxHost(backend);
          // Docker holds git files by mounting them, so it runs only in Git folders.
          const folders =
            backend === "srt"
              ? [host.repository, host.plain, host.worktree]
              : [host.repository, host.worktree];
          for (const cwd of folders) {
            const first = yield* host.claude(cwd);
            const second = yield* host.claude(cwd);
            const resumed = yield* host.claude(cwd, first.sessionId);
            for (const { launch, stdin } of [first, second, resumed]) {
              expectIsolated(launch, cwd, host.home);
              assert.strictEqual(launch.env.ANTHROPIC_API_KEY, "a");
              assert.includeMembers(
                [...launch.args],
                ["--output-format", "stream-json", "--input-format"],
              );
              // The SDK speaks first, over stdin.
              assert.match(stdin, /^\{/);
            }
            assert.include([...first.launch.args], `--session-id=${first.sessionId}`);
            assert.include([...resumed.launch.args], `--resume=${first.sessionId}`);
          }
        }).pipe(Effect.scoped),
    );

    it.live(
      "starts Codex's app-server in each kind of folder, twice, and resumes its conversation",
      () =>
        Effect.gen(function* () {
          const host = yield* sandboxHost(backend);
          const folders =
            backend === "srt"
              ? [host.repository, host.plain, host.worktree]
              : [host.repository, host.worktree];
          for (const cwd of folders) {
            const first = yield* host.codex(cwd);
            const resumed = yield* host.codex(cwd, CONVERSATION);
            for (const launch of [first, resumed]) {
              expectIsolated(launch, cwd, host.home);
              assert.strictEqual(launch.env.OPENAI_API_KEY, "o");
              assert.strictEqual(launch.args[0], "app-server");
            }
            // The conversation the first session wrote is there for the next one.
            assert.strictEqual(resumed.conversations, "1");
            // So is the sign-in it refreshed, back in the host's file.
            assert.include(resumed.credential, '"access_token":"rotated-');
            assert.include(
              NodeFS.readFileSync(NodePath.join(host.home, ".codex", "auth.json"), "utf8"),
              '"access_token":"rotated-',
            );
          }
        }).pipe(Effect.scoped),
    );

    it.live("reaches only /mcp of this server's port, and through no tunnel", () =>
      Effect.gen(function* () {
        const host = yield* sandboxHost(backend);
        const output = yield* host.inside(
          host.repository,
          [
            `curl -s -m 10 -o /dev/null -w "mcp=%{http_code}\\n" http://${host.mcp}/mcp`,
            `curl -s -m 10 -o /dev/null -w "other=%{http_code}\\n" http://${host.mcp}/api/settings`,
            // The tunnels the fourth read used: CONNECT, and SOCKS on srt's port.
            `curl -sf -m 10 -o /dev/null -p http://${host.mcp}/api/settings; echo "connect=$?"`,
            `curl -sf -m 10 -o /dev/null --socks5-hostname 127.0.0.1:1080 http://${host.mcp}/api; echo "socks=$?"`,
          ].join("\n"),
        );
        assert.include(output, "mcp=200");
        assert.include(output, "other=403");
        assert.notInclude(output, "connect=0");
        assert.notInclude(output, "socks=0");
      }).pipe(Effect.scoped),
    );

    it.live("keeps husky's hooks unwritable to a thread, and runs none for the server", () =>
      Effect.gen(function* () {
        const host = yield* sandboxHost(backend);
        const marker = NodePath.join(host.home, "hook-ran");
        // husky v9: git runs .husky/_/pre-commit, which runs the owner's .husky/pre-commit.
        const husky = NodePath.join(host.repository, ".husky");
        NodeFS.mkdirSync(NodePath.join(husky, "_"), { recursive: true });
        NodeFS.writeFileSync(NodePath.join(husky, "pre-commit"), `touch ${marker}\n`);
        NodeFS.writeFileSync(
          NodePath.join(husky, "_", "pre-commit"),
          '#!/bin/sh\nsh -e "$(dirname "$0")/../pre-commit"\n',
          { mode: 0o755 },
        );
        run("git", ["config", "core.hooksPath", ".husky/_"], host.repository);
        const output = yield* host.inside(
          host.repository,
          [
            'echo "touch /tmp/x" >> .husky/pre-commit 2>/dev/null && echo planted=script',
            "echo x > .husky/_/pre-commit 2>/dev/null && echo planted=hook",
            "echo x > .husky/commit-msg 2>/dev/null && echo planted=new",
            "mv .husky .husky.old 2>/dev/null && echo planted=renamed",
            "mv .husky/_ .husky/old 2>/dev/null && echo planted=renamed-hooks",
            "echo x > .git/hooks/pre-commit 2>/dev/null && echo planted=git",
            "git config core.hooksPath /tmp 2>/dev/null && echo planted=config",
            "true",
          ].join("\n"),
        );
        assert.notInclude(output, "planted=");
        assert.notInclude(
          NodeFS.readFileSync(NodePath.join(husky, "pre-commit"), "utf8"),
          "/tmp/x",
        );
        // The server's own commit there runs no hook: it would run the checkout's scripts.
        const base = explicitBareRepositoryEnv(hostEnv, "linux");
        NodeChildProcess.execFileSync(
          "git",
          [
            "-c",
            "user.name=T",
            "-c",
            "user.email=t@example.com",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "y",
          ],
          {
            cwd: host.repository,
            env: {
              ...hostEnv,
              ...base,
              ...(yield* isolatedFolderGitEnv({ ...hostEnv, ...base }, host.repository, "linux")),
            },
          },
        );
        assert.isFalse(NodeFS.existsSync(marker));
      }).pipe(Effect.scoped),
    );

    it.live("lets a worktree thread commit and keep house, but not change what git runs", () =>
      Effect.gen(function* () {
        const host = yield* sandboxHost(backend);
        const output = yield* host.inside(
          host.worktree,
          [
            "set -e",
            "git -c user.name=T -c user.email=t@example.com commit -q --allow-empty -m inside",
            "git branch scratch && git branch -D scratch >/dev/null",
            "git tag t1 && git tag -d t1 >/dev/null",
            "git pack-refs --all",
            "git gc --quiet",
            "echo housekeeping=ok",
            "set +e",
            "common=$(git rev-parse --git-common-dir)",
            'git config core.fsmonitor "touch /tmp/x" 2>/dev/null && echo config=written',
            "git config --worktree core.hooksPath /tmp 2>/dev/null && echo worktree-config=written",
            'echo x > "$common/hooks/pre-commit" 2>/dev/null && echo hook=written',
            'echo x > "$common/HEAD" 2>/dev/null && echo main-head=written',
            "true",
          ].join("\n"),
        );
        assert.include(output, "housekeeping=ok");
        assert.notMatch(output, /=written/);
        assert.strictEqual(
          run("git", ["log", "-1", "--format=%s", "HEAD"], host.worktree).toString().trim(),
          "inside",
        );
      }).pipe(Effect.scoped),
    );

    it.live("keeps a configuration file the repository includes from the thread", () =>
      Effect.gen(function* () {
        const host = yield* sandboxHost(backend);
        // A shared, tracked configuration file, and one it includes in turn.
        run("git", ["config", "include.path", "../.gitconfig-shared"], host.repository);
        NodeFS.writeFileSync(
          NodePath.join(host.repository, ".gitconfig-shared"),
          "[include]\n\tpath = tools/git/more\n",
        );
        const output = yield* host.inside(
          host.repository,
          [
            "git config -f .gitconfig-shared gpg.program scripts/gpg.sh 2>/dev/null && echo planted=file",
            "echo x >> tools/git/more 2>/dev/null && echo planted=nested",
            "mv tools tools.old 2>/dev/null && echo planted=renamed",
            "echo x > f && echo file=written",
            "true",
          ].join("\n"),
        );
        assert.include(output, "file=written");
        assert.notInclude(output, "planted=");
      }).pipe(Effect.scoped),
    );

    it.live("keeps a writable sibling repository's git config and hooks from the thread", () =>
      Effect.gen(function* () {
        const host = yield* sandboxHost(backend, ["other"]);
        const other = NodePath.join(host.home, "other");
        const marker = NodePath.join(host.home, "PWNED");
        const output = yield* host.inside(
          host.repository,
          [
            `cd ${other}`,
            `git config core.fsmonitor "touch ${marker}; true" 2>/dev/null && echo config=written`,
            `git config core.sshCommand "touch ${marker}" 2>/dev/null && echo ssh=written`,
            "echo x > .git/hooks/pre-commit 2>/dev/null && echo hook=written",
            "echo x > f && echo file=written",
            "true",
          ].join("\n"),
        );
        assert.include(output, "file=written");
        assert.notMatch(output, /(config|ssh|hook)=written/);
        // The server's own git there runs as in the thread's own folder.
        const base = explicitBareRepositoryEnv(hostEnv, "linux");
        const hardened = yield* isolatedFolderGitEnv({ ...hostEnv, ...base }, other, "linux");
        assert.include(Object.values(hardened), "core.fsmonitor");
        NodeChildProcess.execFileSync("git", ["status", "--porcelain=2", "--branch", "-z"], {
          cwd: other,
          env: { ...hostEnv, ...base, ...hardened },
        });
        assert.isFalse(NodeFS.existsSync(marker));
      }).pipe(Effect.scoped),
    );

    it.live("lets a thread commit when another checkout of its repository is writable", () =>
      Effect.gen(function* () {
        const commit =
          "git -c user.name=T -c user.email=t@example.com commit -q --allow-empty -m z && echo committed";
        // A worktree's thread with the main checkout listed, and the other way round.
        const main = yield* sandboxHost(backend, ["repository"]);
        assert.include(yield* main.inside(main.worktree, commit), "committed");
        const linked = yield* sandboxHost(backend, ["worktree"]);
        assert.include(yield* linked.inside(linked.repository, commit), "committed");
      }).pipe(Effect.scoped),
    );

    it.live(
      "keeps a nested repository the thread made from running its fsmonitor on the host",
      () =>
        Effect.gen(function* () {
          const host = yield* sandboxHost(backend);
          const marker = NodePath.join(host.home, "PWNED");
          yield* host.inside(
            host.repository,
            [
              "git init -q sub && cd sub",
              "echo x > f && git add f",
              "git -c user.name=T -c user.email=t@example.com commit -qm x",
              `git config core.fsmonitor "touch ${marker}; true"`,
              "cd .. && git add sub",
            ].join(" && "),
          );
          assert.include(
            NodeFS.readFileSync(NodePath.join(host.repository, "sub", ".git", "config"), "utf8"),
            "fsmonitor",
          );
          // The server's own status poll, as GitVcsDriverCore runs it.
          const base = {
            GIT_OPTIONAL_LOCKS: "0",
            ...explicitBareRepositoryEnv(hostEnv, "linux"),
          };
          NodeChildProcess.execFileSync("git", ["status", "--porcelain=2", "--branch", "-z"], {
            cwd: host.repository,
            env: {
              ...hostEnv,
              ...base,
              ...(yield* isolatedFolderGitEnv({ ...hostEnv, ...base }, host.repository, "linux")),
            },
          });
          assert.isFalse(NodeFS.existsSync(marker));
        }).pipe(Effect.scoped),
    );

    it.live.skipIf(!has("claude"))("runs the installed Claude CLI inside the sandbox", () =>
      Effect.gen(function* () {
        const host = yield* sandboxHost(backend);
        assert.match(yield* host.version("claude"), /\d+\.\d+\.\d+/);
      }).pipe(Effect.scoped),
    );

    it.live.skipIf(!has("codex"))("runs the installed Codex CLI inside the sandbox", () =>
      Effect.gen(function* () {
        const host = yield* sandboxHost(backend);
        assert.match(yield* host.version("codex"), /\d+\.\d+/);
      }).pipe(Effect.scoped),
    );
  });

matrix("srt", () => srtUsable);
matrix("docker", dockerUsable);

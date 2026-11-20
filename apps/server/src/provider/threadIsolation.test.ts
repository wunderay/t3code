// @effect-diagnostics nodeBuiltinImport:off -- checks the srt command line with the real shell.
import * as EffectNodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";

import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ThreadIsolationBackendChoice,
  type ThreadIsolationOverride,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type * as Scope from "effect/Scope";
import { HttpServer, HttpServerResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";
import { localMcpAuthority } from "../mcp/localMcpAuthority.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import { isolatedGitConfig } from "../vcs/isolatedFolders.ts";
import { resolveAntigravityInstanceDirectories } from "./antigravityAuthSupport.ts";
import { antigravityUserSkillDirectories } from "./Drivers/AntigravitySkills.ts";
import {
  allowsTarget,
  carryArguments,
  chooseBackend,
  probeBackends,
  statusOf,
  claudeProjectFolder,
  DOCKER_IMAGE,
  dockerCommand,
  folderRefusalReason,
  installRoot,
  ISOLATED_HOSTS,
  type IsolationPolicy,
  layer,
  listenOnFirst,
  lookupElsewhere,
  mayCopyBack,
  PROVIDER_PROFILES,
  providerAccess,
  reachableHosts,
  refusesTunnel,
  type SandboxRuntime,
  SandboxRuntimeSource,
  WINDOWS_FENCE_INACTIVE,
  WINDOWS_NOT_SET_UP,
  type WindowsSandboxRuntime,
  srtCommandLine,
  srtNetwork,
  srtSettings,
  srtWinReadGrants,
  ThreadIsolation,
  warm,
  type WrapInput,
} from "./threadIsolation.ts";
import { SRT_WIN_LAUNCHER } from "./windowsSandbox.ts";

const policy: IsolationPolicy = {
  cwd: "/home/ada/worktrees/feature",
  writable: ["/srv/t3/isolation/abc/home", "/home/ada/project/.git/worktrees/feature"],
  readable: ["/home/ada/.local/share/codex", "/home/ada/project/.git"],
  protected: ["/home/ada/worktrees/feature/.git"],
};

describe("choosing the sandbox: choice x what runs here x system", () => {
  const linux = {
    platform: "linux" as const,
    srtReason: undefined,
    docker: "/usr/bin/docker",
    dockerRunning: true,
    socat: true,
  };
  const docker = { backend: "docker", command: "/usr/bin/docker" };
  const cases: ReadonlyArray<
    readonly [string, Parameters<typeof probeBackends>[0], ThreadIsolationBackendChoice, object]
  > = [
    ["both run, automatic", linux, "automatic", { backend: "srt" }],
    ["both run, srt", linux, "srt", { backend: "srt" }],
    ["both run, Docker", linux, "docker", docker],
    [
      "no srt, automatic falls back",
      { ...linux, srtReason: "bwrap missing" },
      "automatic",
      { ...docker, srtReason: "bwrap missing" },
    ],
    [
      "no srt, srt chosen: none, never Docker",
      { ...linux, srtReason: "bwrap missing" },
      "srt",
      { backend: null, reason: "srt cannot be used here: bwrap missing" },
    ],
    [
      "no Docker, Docker chosen: none, never srt",
      { ...linux, dockerRunning: false },
      "docker",
      { backend: null, reason: "Docker cannot be used here: Docker is not running" },
    ],
    [
      "neither, automatic",
      { ...linux, srtReason: "x", socat: false },
      "automatic",
      {
        backend: null,
        reason:
          "neither srt nor Docker can be used here: x, and Docker isolation needs socat, which is not installed",
      },
    ],
    ["macOS with srt", { ...linux, platform: "darwin" }, "automatic", { backend: "srt" }],
    [
      "macOS, Docker chosen",
      { ...linux, platform: "darwin" },
      "docker",
      {
        backend: null,
        reason:
          "Docker cannot be used here: Docker isolation runs the provider with this machine's own Linux system folders, which macOS does not have",
      },
    ],
    ["Windows, srt-win set up", { ...linux, platform: "win32" }, "automatic", { backend: "srt" }],
    [
      "Windows, srt-win not set up: the bridge prepared before",
      { ...linux, platform: "win32", srtReason: "not set up" },
      "automatic",
      { backend: "windows" },
    ],
    [
      "Windows, neither srt-win nor the bridge: srt-win's reason",
      { ...linux, platform: "win32", srtReason: "not set up", windowsProblem: "not prepared" },
      "srt",
      { backend: null, reason: "srt cannot be used here: not set up" },
    ],
    [
      "Windows, Docker chosen",
      { ...linux, platform: "win32" },
      "docker",
      {
        backend: null,
        reason:
          "Docker cannot be used here: Docker isolation runs the provider with this machine's own Linux system folders, which Windows does not have",
      },
    ],
  ];
  it.each(cases)("%s", (_name, probe, choice, expected) => {
    assert.deepEqual(chooseBackend(probeBackends(probe), probe.platform, choice), expected);
  });

  it("reports, per backend, the providers it starts without isolation and why", () => {
    const status = statusOf(probeBackends({ ...linux, platform: "win32" }), "win32", "automatic");
    assert.strictEqual(status.backend, "srt");
    assert.strictEqual(
      status.srt.notIsolated.grok,
      "on Windows, srt runs only Claude and Codex threads",
    );
    assert.isUndefined(status.srt.notIsolated.claudeAgent);
    assert.isUndefined(status.srt.notIsolated.codex);
    assert.include(status.docker.unavailable, "which Windows does not have");
    assert.isUndefined(status.canSetUp);
    const notSetUp = { ...linux, platform: "win32" as const, srtReason: WINDOWS_NOT_SET_UP };
    assert.isTrue(statusOf(probeBackends(notSetUp), "win32", "automatic").canSetUp);
    // What setting srt-win up cannot fix offers no administrator prompt.
    for (const srtReason of [
      "the isolation proxy could not start",
      "srt cannot start a sandbox on this machine: wfp_fence_inactive",
      "srt-win is missing from this installation",
    ]) {
      const other = probeBackends({ ...notSetUp, srtReason, windowsProblem: "not prepared" });
      assert.isUndefined(statusOf(other, "win32", "automatic").canSetUp, srtReason);
    }
    const onLinux = statusOf(probeBackends(linux), "linux", "automatic");
    assert.deepEqual(Object.keys(onLinux.srt.notIsolated).toSorted(), ["cursor", "opencode"]);
  });
});

it("sends srt's sandboxes through the one proxy both backends share, port 443 of named hosts", () => {
  const { network } = srtNetwork(4100);
  // srt's own allow list is not used; SOCKS lands on the HTTP proxy, which refuses it.
  assert.deepEqual(network.allowedDomains, []);
  assert.strictEqual(network.httpProxyPort, 4100);
  assert.strictEqual(network.socksProxyPort, 4100);
  assert.include(ISOLATED_HOSTS, "github.com:443");
  assert.notInclude(ISOLATED_HOSTS, "github.com");
  assert.isTrue(allowsTarget("API.Anthropic.com:443", ISOLATED_HOSTS));
  for (const refused of ["github.com:22", "localhost:4100", "example.com:443"]) {
    assert.isFalse(allowsTarget(refused, ISOLATED_HOSTS), refused);
  }
});

it("builds srt settings that hide the whole host except named system files and folders", () => {
  const { filesystem } = srtSettings(policy);
  assert.deepEqual(paths(filesystem.denyRead), ["/"]);
  const readable = paths(filesystem.allowRead);
  assert.includeMembers(readable, ["/usr", "/etc/ssl", policy.cwd, ...policy.readable]);
  for (const hidden of ["/etc", "/tmp", "/home", "/home/ada", "/root", "/var", "/opt", "/srv"]) {
    assert.notInclude(readable, hidden);
  }
  assert.deepEqual(paths(filesystem.allowWrite), [policy.cwd, ...policy.writable]);
  assert.deepEqual(paths(filesystem.denyWrite), policy.protected);
  assert.isFalse(filesystem.allowGitConfig);
  assert.strictEqual(
    srtCommandLine({
      command: "/opt/co'dex",
      args: ["app-server", "a b"],
      tmp: "/t",
      proxyId: "id1",
    }),
    `eval "set -- \${T3CODE_ISOLATED_ARGS-}"; unset T3CODE_ISOLATED_ARGS; proxy="http://id1@\${HTTP_PROXY#http://}"; exec /usr/bin/env -u NO_PROXY -u no_proxy HTTPS_PROXY="$proxy" HTTP_PROXY="$proxy" https_proxy="$proxy" http_proxy="$proxy" ALL_PROXY="$proxy" all_proxy="$proxy" TMPDIR='/t' '/opt/co'\\''dex' 'app-server' 'a b' "$@"`,
  );
});

it("carries arguments appended after srt's command line through the environment", () => {
  const sdk = ["--output-format", "stream-json", "--append-system-prompt", 'it\'s "quoted" $HOME'];
  const carried = carryArguments("srt", "linux", ["-c", "W", ...sdk], 2);
  assert.deepEqual(carried.args, ["-c", "W"]);
  // The shell's own parsing gives back exactly the SDK's arguments.
  const echoed = NodeChildProcess.execFileSync(
    "/bin/bash",
    ["-c", `eval "set -- $T3CODE_ISOLATED_ARGS"; printf '%s\\n' "$@"`],
    { env: { ...carried.env, HOME: "/home/ada" }, encoding: "utf8" },
  );
  assert.deepEqual(echoed.trimEnd().split("\n"), sdk);
  assert.deepEqual(carryArguments("docker", "linux", ["run", ...sdk], 1), {
    args: ["run", ...sdk],
    env: {},
  });
  // The Windows bridge takes the provider's arguments after its own `--`.
  assert.deepEqual(carryArguments("windows", "win32", ["-I", "bridge.py", "--", ...sdk], 3), {
    args: ["-I", "bridge.py", "--", ...sdk],
    env: {},
  });
  // srt-win passes everything after its `--` to the program, so they stay arguments.
  assert.deepEqual(carryArguments("srt", "win32", ["exec", "--", "claude.exe", ...sdk], 3), {
    args: ["exec", "--", "claude.exe", ...sdk],
    env: {},
  });
});

it("builds a hardened container with no network, its own /tmp and the proxy socket", () => {
  const { command, args } = dockerCommand({
    docker: "/usr/bin/docker",
    policy: { ...policy, cwd: "/home/ada/a,b" },
    system: ["/usr", "/etc/ssl"],
    home: "/srv/t3/isolation/abc/home",
    tmp: "/srv/t3/isolation/abc/tmp",
    proxySocket: "/srv/t3/isolation/server/proxy.sock",
    server: "0123456789abcdef",
    proxyId: "id1",
    uid: 1000,
    gid: 1000,
    name: "t3code-isolation-x",
    env: ["PATH", "ANTHROPIC_API_KEY", "HOME", "bad-name"],
    command: "/opt/codex",
    args: ["app-server"],
  });
  assert.strictEqual(command, "/usr/bin/docker");
  const mounts = args.flatMap((arg, index) => (args[index - 1] === "--mount" ? [arg] : []));
  assert.deepEqual(mounts, [
    "type=bind,src=/usr,dst=/usr,readonly",
    "type=bind,src=/etc/ssl,dst=/etc/ssl,readonly",
    'type=bind,"src=/home/ada/a,b","dst=/home/ada/a,b"',
    "type=bind,src=/srv/t3/isolation/abc/home,dst=/srv/t3/isolation/abc/home",
    "type=bind,src=/home/ada/project/.git/worktrees/feature,dst=/home/ada/project/.git/worktrees/feature",
    "type=bind,src=/srv/t3/isolation/abc/tmp,dst=/tmp",
    "type=bind,src=/home/ada/.local/share/codex,dst=/home/ada/.local/share/codex,readonly",
    "type=bind,src=/home/ada/project/.git,dst=/home/ada/project/.git,readonly",
    "type=bind,src=/home/ada/worktrees/feature/.git,dst=/home/ada/worktrees/feature/.git,readonly",
    "type=bind,src=/srv/t3/isolation/server/proxy.sock,dst=/run/t3code-proxy.sock,readonly",
  ]);
  const value = (flag: string) => args[args.indexOf(flag) + 1];
  assert.strictEqual(value("--network"), "none");
  // No arbitrary caps: a parallel build runs as it does outside.
  assert.notInclude(args, "--pids-limit");
  assert.strictEqual(value("--label"), "t3code-isolation=0123456789abcdef");
  assert.strictEqual(value("--cap-drop"), "ALL");
  assert.strictEqual(value("--user"), "1000:1000");
  assert.include(args, "--read-only");
  const env = args.flatMap((arg, index) => (args[index - 1] === "--env" ? [arg] : []));
  assert.includeMembers(env, [
    "HOME=/srv/t3/isolation/abc/home",
    "TMPDIR=/tmp",
    "HTTPS_PROXY=http://id1@127.0.0.1:3128",
    "PATH",
    "ANTHROPIC_API_KEY",
  ]);
  assert.notInclude(env, "HOME");
  assert.notInclude(env, "bad-name");
  assert.deepEqual(args.slice(-2), ["/opt/codex", "app-server"]);
  assert.strictEqual(args[args.indexOf(DOCKER_IMAGE) + 1], "/bin/sh");
});

it("passes exactly the variables and hosts a provider's sign-in mode needs", () => {
  const host = {
    PATH: "/usr/bin",
    LANG: "C.UTF-8",
    T3CODE_THREAD_ID: "t",
    T3CODE_DEV_AUTH_TOKEN: "server-secret",
    T3CODE_BITBUCKET_API_TOKEN: "b",
    ANTHROPIC_API_KEY: "a",
    ANTHROPIC_BASE_URL: "https://gateway.example:8443/v1",
    CLAUDE_CODE_SOMETHING_NEW: "x",
    OPENAI_API_KEY: "o",
    GITHUB_TOKEN: "g",
    AWS_SECRET_ACCESS_KEY: "s",
    SSH_AUTH_SOCK: "/s",
  };
  const claude = providerAccess("claude", host, "/home/ada");
  assert.deepEqual(Object.keys(claude.env).toSorted(), [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "LANG",
    "PATH",
    "T3CODE_THREAD_ID",
  ]);
  assert.deepEqual(claude.hosts, ["gateway.example:8443"]);
  assert.deepEqual(Object.keys(providerAccess("codex", host, "/home/ada").env).toSorted(), [
    "LANG",
    "OPENAI_API_KEY",
    "PATH",
    "T3CODE_THREAD_ID",
  ]);
  const bedrock = providerAccess(
    "claude",
    { ...host, CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "eu-west-1" },
    "/home/ada",
  );
  assert.strictEqual(bedrock.env.AWS_SECRET_ACCESS_KEY, "s");
  assert.include(bedrock.hosts, "bedrock-runtime.eu-west-1.amazonaws.com:443");
  // The SDKs look under HOME, which is private: the default folders are linked into it.
  assert.deepEqual(bedrock.homeLinks, [[".aws", "/home/ada/.aws"]]);
  assert.deepEqual(bedrock.readable, []);
  // Set in Claude's settings.json instead: Claude applies the values, isolation follows them.
  const configured = providerAccess("claude", host, "/home/ada", {
    CLAUDE_CODE_USE_BEDROCK: "1",
    AWS_REGION: "us-west-2",
    ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.corp.example",
  });
  assert.includeMembers(configured.hosts, [
    "bedrock-runtime.us-west-2.amazonaws.com:443",
    "bedrock.corp.example:443",
  ]);
  assert.isUndefined(configured.env.CLAUDE_CODE_USE_BEDROCK);
  const vertex = providerAccess(
    "claude",
    {
      ...host,
      CLAUDE_CODE_USE_VERTEX: "1",
      CLOUD_ML_REGION: "europe-west4",
      GOOGLE_APPLICATION_CREDENTIALS: "/home/ada/gcp.json",
    },
    "/home/ada",
  );
  assert.includeMembers(vertex.hosts, [
    "europe-west4-aiplatform.googleapis.com:443",
    "oauth2.googleapis.com:443",
  ]);
  assert.deepEqual(vertex.readable, ["/home/ada/gcp.json"]);
  assert.deepEqual(vertex.homeLinks, [[".config/gcloud", "/home/ada/.config/gcloud"]]);
  // Windows' gcloud reads %APPDATA%, which a thread's names inside its private HOME.
  const onWindows = providerAccess(
    "claude",
    { ...host, CLAUDE_CODE_USE_VERTEX: "1", APPDATA: "C:\\Users\\ada\\AppData\\Roaming" },
    "C:\\Users\\ada",
    {},
    "win32",
  );
  assert.deepEqual(onWindows.homeLinks, [
    ["AppData/Roaming/gcloud", "C:\\Users\\ada\\AppData\\Roaming/gcloud"],
  ]);
});

it.effect("grants srt-win's account the launcher's Node, never a home folder or above", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const grants = (runtime: string) =>
      srtWinReadGrants(path, {
        readable: ["/home/ada/.local/bin", "/opt/tools", "/srv/t3/userdata/isolation/x"],
        launcher: "/srv/t3/userdata/isolation/server/srt-win-launcher.cjs",
        runtime,
        // The server's home and the account's own profile, as in a test of the server.
        homes: ["/home/ada", "/Users/runner"],
        data: ["/srv/t3", "/srv/t3/userdata"],
      });
    // Node in the account's profile, as a per-user install is, is granted with the launcher;
    // a folder every account reads already is not.
    assert.deepEqual(grants("/Users/runner/.vite-plus/node/26/node.exe"), [
      "/home/ada/.local/bin",
      "/srv/t3/userdata/isolation/x",
      "/srv/t3/userdata/isolation/server/srt-win-launcher.cjs",
      "/Users/runner/.vite-plus/node/26",
    ]);
    // Never the home folder itself, nor a folder above either home.
    for (const runtime of ["/home/ada/node.exe", "/Users/runner/node.exe", "/node.exe"]) {
      assert.notInclude(grants(runtime), path.dirname(runtime));
    }
    assert.notInclude(grants("/opt/node/node.exe"), "/opt/node");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("never exposes the home folder or a folder above it as an install folder", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    assert.strictEqual(
      installRoot(path, "/home/ada/.local/share/claude/versions/2", "/home/ada"),
      "/home/ada/.local/share/claude/versions",
    );
    assert.strictEqual(
      installRoot(path, "/usr/lib/node_modules/@openai/codex/bin/codex.js", "/home/ada"),
      "/usr/lib/node_modules/@openai/codex",
    );
    assert.isUndefined(installRoot(path, "/home/ada/claude", "/home/ada"));
    assert.isUndefined(installRoot(path, "/home/claude", "/home/ada"));
    assert.isUndefined(installRoot(path, "/claude", "/home/ada"));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it("copies a credential back only complete and for the same login", () => {
  const codexAuth = (account: string | undefined, token: string) =>
    `{"tokens":{"access_token":"${token}","refresh_token":"r-${token}"${account ? `,"account_id":"${account}"` : ""}}}`;
  const real = codexAuth("acct-1", "old");
  const copy = (provider: "claude" | "codex", text: string, host: string, seeded?: string) =>
    mayCopyBack({ provider, copy: text, real: host, seeded });
  assert.isTrue(copy("codex", codexAuth("acct-1", "new"), real, real));
  assert.isFalse(copy("codex", codexAuth("acct-2", "x"), real, real));
  assert.isFalse(copy("codex", codexAuth(undefined, "x"), codexAuth(undefined, "old")));
  // Without a refresh token the host CLI could not refresh it again: the owner is signed out.
  assert.isFalse(
    copy("codex", '{"tokens":{"access_token":"x","account_id":"acct-1"}}', real, real),
  );
  const claudeAuth = (token: string, plan = "max") =>
    `{"claudeAiOauth":{"accessToken":"${token}","refreshToken":"r","expiresAt":1,"scopes":["a"],"subscriptionType":"${plan}"}}`;
  const seeded = claudeAuth("old");
  assert.isTrue(copy("claude", claudeAuth("new"), seeded, seeded));
  assert.isFalse(copy("claude", claudeAuth("new", "pro"), seeded, seeded));
  assert.isFalse(copy("claude", claudeAuth("new"), claudeAuth("host"), seeded));
  assert.isFalse(copy("claude", claudeAuth("new"), seeded));
  assert.isFalse(
    copy(
      "claude",
      '{"claudeAiOauth":{"accessToken":"x","scopes":["a"],"subscriptionType":"max"}}',
      seeded,
      seeded,
    ),
  );
});

/** A complete Codex sign-in, as `codex login` writes it. */
const codexSignIn = (token: string, account = "acct-1") =>
  `{"tokens":{"access_token":"${token}","refresh_token":"r-${token}","account_id":"${account}"}}`;

const ok = (stdout = "", code = 0) => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const paths = (entries: ReadonlyArray<{ readonly path: string }>) =>
  entries.map((entry) => entry.path);

type Filesystem = ReturnType<typeof srtSettings>["filesystem"];
interface Recorded {
  readonly initialized: Array<ReturnType<typeof srtNetwork> & { readonly windows?: unknown }>;
  readonly wraps: Array<{ readonly command: string; readonly filesystem: Filesystem }>;
  readonly commands: Array<ReadonlyArray<string>>;
  /** The time limit each command was given, if any. */
  readonly timeouts: Array<unknown>;
  /** FileSystem calls the isolation layer made, when spied. */
  readonly fs: Array<string>;
  /** Paths it removed. */
  readonly removed: Array<string>;
  resets: number;
  cleanups: number;
  loaded: number;
  /** srt-win's one-time setup, as often as it was asked for. */
  installs: number;
  /** What each srt-win grant gave the sandbox account. */
  readonly grants: Array<{ readonly read: Array<string>; readonly write: Array<string> }>;
  /** The processes srt-win's grants were held by, and whether each was let go. */
  readonly holders: Array<{ readonly pid: number; released: boolean }>;
  /** Settles when srt has been started a second time. */
  readonly restarted: Promise<void>;
  /** Settles when srt's second start begins. */
  readonly restarting: Promise<void>;
}

/**
 * The real isolation layer over a host whose PATH holds exactly `tools`, a stand-in sandbox
 * runtime and a runner that answers like Docker and git.
 */
const isolation = (options: {
  readonly enabled: boolean;
  readonly srt?: boolean;
  /** Whether a sandboxed probe succeeds; changed by a test to kill the stand-in's network. */
  readonly srtRuns?: { ok: boolean };
  readonly tools: ReadonlyArray<string>;
  readonly git?: "repository" | "worktree" | "separate" | "none";
  /** Where git says hooks come from, relative to the folder; its own default otherwise. */
  readonly hooks?: string;
  /** The server's base folder (state is under its userdata); a fresh one otherwise. */
  readonly baseDir?: string;
  /** Holds srt's second start until it settles. */
  readonly holdRestart?: Promise<void>;
  /** git cannot say where the hooks are. */
  readonly hooksUnknown?: boolean;
  /** What `git --version` prints; a current Git otherwise. */
  readonly gitVersion?: string;
  /** What git lists as included configuration files: [origin, value] pairs. */
  readonly includes?: ReadonlyArray<readonly [string, string]>;
  /** These commands run out of time. */
  readonly timesOut?: ReadonlyArray<string>;
  /** The host's platform; Linux otherwise. */
  readonly platform?: NodeJS.Platform;
  /** The home folder is a link to the real one, as when HOME names a symlink. */
  readonly homeLink?: boolean;
  /** The server's own environment besides PATH. */
  readonly environment?: Readonly<Record<string, string>>;
  /** More stored settings: an isolation policy, threads' own choices. */
  readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
  /** On Windows: whether srt-win is set up, and how its setup ends when asked. */
  readonly srtWin?: {
    ready: boolean;
    install?: "ok" | "cancel" | "fail";
    fence?: false;
    uninstall?: "ok" | "cancel" | "fail";
  };
  /** The first srt-win holder says it is starting, then waits for `answer`. */
  readonly firstHold?: { readonly started: () => void; readonly answer: Promise<void> };
  /** srt-win's first grant says it started, then waits for `answer`. */
  readonly firstGrant?: { readonly started: () => void; readonly answer: Promise<void> };
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
    const bin = path.join(root, "bin");
    const tools = path.join(root, "tools");
    const home = path.join(root, "home");
    if (options.homeLink) {
      yield* fs.makeDirectory(path.join(root, "home-real"));
      yield* fs.symlink(path.join(root, "home-real"), home);
    }
    const cwd = path.join(home, "project");
    const realCodex = path.join(home, ".codex");
    const realClaude = path.join(home, ".claude");
    for (const folder of [bin, tools, realCodex, realClaude, cwd]) {
      yield* fs.makeDirectory(folder, { recursive: true });
    }
    yield* fs.writeFileString(path.join(realCodex, "auth.json"), codexSignIn("real"));
    yield* fs.writeFileString(path.join(realCodex, "config.toml"), 'model = "x"\n');
    yield* fs.writeFileString(path.join(home, "secret.txt"), "secret");
    const git = options.git ?? "repository";
    if (git === "repository") {
      yield* fs.makeDirectory(path.join(cwd, ".git", "objects"), { recursive: true });
      yield* fs.writeFileString(path.join(cwd, ".git", "config"), "");
      yield* fs.writeFileString(path.join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
    }
    if (git === "worktree") {
      const common = path.join(home, "main", ".git");
      const gitDir = path.join(common, "worktrees", "project");
      for (const name of ["objects", "refs", "logs", "worktrees/project", "worktrees/other"]) {
        yield* fs.makeDirectory(path.join(common, name), { recursive: true });
      }
      yield* fs.writeFileString(path.join(common, "config"), "");
      yield* fs.writeFileString(path.join(common, "HEAD"), "ref: refs/heads/main\n");
      yield* fs.writeFileString(path.join(common, "index"), "");
      yield* fs.writeFileString(path.join(gitDir, "commondir"), "../..");
      yield* fs.writeFileString(path.join(gitDir, "gitdir"), path.join(cwd, ".git"));
      yield* fs.writeFileString(path.join(cwd, ".git"), `gitdir: ${gitDir}\n`);
    }
    if (git === "separate") {
      const gitDir = path.join(home, "separate.git");
      yield* fs.makeDirectory(path.join(gitDir, "objects"), { recursive: true });
      yield* fs.writeFileString(path.join(gitDir, "config"), "");
      yield* fs.writeFileString(path.join(cwd, ".git"), `gitdir: ${gitDir}\n`);
    }
    const defaultHooks =
      git === "worktree"
        ? path.join(home, "main", ".git", "hooks")
        : git === "separate"
          ? path.join(home, "separate.git", "hooks")
          : path.join(".git", "hooks");
    for (const tool of [...options.tools, "codex", "claude"]) {
      yield* fs.writeFileString(path.join(tools, tool), "", { mode: 0o755 });
      yield* fs.symlink(path.join(tools, tool), path.join(bin, tool));
    }
    let restarted = () => {};
    let restarting = () => {};
    const recorded: Recorded = {
      restarted: new Promise<void>((resolve) => (restarted = resolve)),
      restarting: new Promise<void>((resolve) => (restarting = resolve)),
      initialized: [],
      wraps: [],
      commands: [],
      timeouts: [],
      fs: [],
      removed: [],
      resets: 0,
      cleanups: 0,
      loaded: 0,
      installs: 0,
      grants: [],
      holders: [],
    };
    const srtWin = options.srtWin ?? { ready: false };
    const srtWinProgram = path.join(root, "srt-win.exe");
    yield* fs.writeFileString(srtWinProgram, "");
    const windows: WindowsSandboxRuntime = {
      program: srtWinProgram,
      node: ["C:\\Program Files\\nodejs\\node.exe"],
      problem: async () => (srtWin.ready ? undefined : WINDOWS_NOT_SET_UP),
      install: async () => {
        recorded.installs += 1;
        if (srtWin.install === "fail") throw new Error("srt-win install timed out");
        if (srtWin.install === "cancel") return { cancelled: true };
        srtWin.ready = true;
        return { cancelled: false };
      },
      account: async () => "S-1-5-21-1-2-3-1001",
      hold: async () => {
        if (recorded.holders.length === 0 && options.firstHold !== undefined) {
          options.firstHold.started();
          await options.firstHold.answer;
        }
        const holder = { pid: 7000 + recorded.holders.length, released: false };
        recorded.holders.push(holder);
        return { pid: holder.pid, release: () => (holder.released = true) };
      },
    };
    const srtRuns = options.srtRuns ?? { ok: true };
    // srt's bridge to the server's proxy: it answers while srt works, and hangs up when not.
    const bridgePath = path.join(root, "bridge.sock");
    const bridge = NodeNet.createServer((socket) =>
      srtRuns.ok ? socket.end("HTTP/1.1 403 Forbidden\r\n\r\n") : socket.destroy(),
    );
    yield* Effect.promise(() => new Promise<void>((resolve) => bridge.listen(bridgePath, resolve)));
    yield* Effect.addFinalizer(() => Effect.sync(() => bridge.close()));
    const manager = {
      isSupportedPlatform: () => true,
      checkDependencies: () => ({
        errors: options.srt === false ? ["bubblewrap (bwrap) not installed"] : [],
        warnings: [],
      }),
      initialize: async (config: Recorded["initialized"][number]) => {
        recorded.initialized.push(config);
        if (recorded.initialized.length === 2) {
          restarting();
          await options.holdRestart;
          // A fresh start brings the bridge back.
          srtRuns.ok = true;
          restarted();
        }
      },
      reset: async () => {
        recorded.resets += 1;
      },
      getLinuxHttpSocketPath: () => bridgePath,
      getLinuxSocksSocketPath: () => "/tmp/srt-socks.sock",
      wrapWithSandboxArgv: async (
        command: string,
        _shell: unknown,
        custom: { readonly filesystem: Filesystem },
      ) => {
        recorded.wraps.push({ command, filesystem: custom.filesystem });
        // srt-win's own command: its per-exec denies, its PATH and proxy, then cmd.
        return options.platform === "win32"
          ? {
              argv: [
                srtWinProgram,
                "exec",
                "--quiet",
                ...custom.filesystem.denyWrite.flatMap((entry) => ["--deny-write", entry.path]),
                "--env",
                "PATH=C:\\Windows\\system32",
                "--env",
                "HTTP_PROXY=http://localhost:60080",
                "--",
                "C:\\Windows\\System32\\cmd.exe",
                "/d",
                "/s",
                "/c",
                command,
              ],
              env: {},
            }
          : { argv: ["/usr/bin/bwrap-stand-in", command], env: {} };
      },
      cleanupAfterCommand: () => {
        recorded.cleanups += 1;
      },
    } as unknown as SandboxRuntime;
    let grantsAsked = 0;
    const runner = Layer.succeed(ProcessRunner.ProcessRunner, {
      run: (input) =>
        (input.args[1] === "grant" && grantsAsked++ === 0 && options.firstGrant !== undefined
          ? Effect.sync(options.firstGrant.started).pipe(
              Effect.andThen(Effect.promise(() => options.firstGrant!.answer)),
            )
          : Effect.void
        ).pipe(
          Effect.andThen(
            Effect.sync(() => {
              recorded.commands.push([input.command, ...input.args]);
              recorded.timeouts.push(input.timeout);
              const line = [input.command, ...input.args].join(" ");
              if (options.timesOut?.some((part) => line.includes(part))) {
                return { ...ok("", 1), code: null, timedOut: true };
              }
              if (input.command === "/usr/bin/bwrap-stand-in") return ok("", srtRuns.ok ? 0 : 1);
              if (input.command === srtWinProgram && input.args[0] === "uninstall") {
                if (srtWin.uninstall === "cancel") return ok("", 10);
                if (srtWin.uninstall === "fail") return { ...ok("", 1), stderr: "access denied" };
                srtWin.ready = false;
                return ok();
              }
              if (input.command === srtWinProgram && input.args[0] === "wfp") {
                return ok("{}", srtWin.fence === false ? 3 : 0);
              }
              if (input.command === srtWinProgram && input.args[1] === "grant") {
                recorded.grants.push(JSON.parse(input.stdin ?? "{}"));
              }
              if (input.command === "git" && input.args.includes("--git-path")) {
                return options.hooksUnknown ? ok("", 128) : ok(options.hooks ?? defaultHooks);
              }
              if (input.command === "git" && input.args[0] === "--version") {
                return ok(options.gitVersion ?? "git version 2.43.0");
              }
              if (input.command === "git" && input.args.includes("--includes")) {
                return ok(
                  (options.includes ?? [])
                    .map(([origin, value]) => `file:${origin}\0include.path\n${value}\0`)
                    .join(""),
                  options.includes ? 0 : 1,
                );
              }
              if (input.command === "git") {
                return ok(input.args.at(-1) === "user.name" ? "Ada Lovelace" : "ada@example.com");
              }
              if (input.args[0] === "info") return ok("", options.tools.includes("docker") ? 0 : 1);
              return ok();
            }),
          ),
        ),
    });
    // Every FileSystem call the isolation layer itself makes.
    const spied = new Proxy(fs, {
      get: (target, key, receiver) => {
        const value: unknown = Reflect.get(target, key, receiver);
        return typeof value === "function"
          ? (...args: Array<unknown>) => {
              recorded.fs.push(String(key));
              if (key === "remove") recorded.removed.push(String(args[0]));
              return Reflect.apply(value, target, args);
            }
          : value;
      },
    });
    const context = yield* Layer.build(
      Layer.merge(
        layer.pipe(
          Layer.provide(Layer.succeed(FileSystem.FileSystem, spied)),
          Layer.provideMerge(
            Layer.mergeAll(
              ServerSettings.layerTest({ ...options.settings, threadIsolation: options.enabled }),
              runner,
              ServerConfig.layerTest(cwd, options.baseDir ?? { prefix: "t3-thread-isolation-" }),
            ),
          ),
        ),
        Layer.empty,
      ).pipe(Layer.provideMerge(NodeHttpServer.layerTest)),
    ).pipe(
      Effect.provideService(HostProcess.Platform, options.platform ?? "linux"),
      Effect.provideService(HostProcess.HomeDirectory, home),
      Effect.provideService(HostProcess.Environment, { PATH: bin, ...options.environment }),
      Effect.provideService(
        SandboxRuntimeSource,
        Effect.sync(() => {
          recorded.loaded += 1;
          return { manager, packageRoot: "/opt/srt", windows };
        }),
      ),
    );
    const service = yield* Effect.service(ThreadIsolation).pipe(Effect.provide(context));
    const httpServer = yield* Effect.service(HttpServer.HttpServer).pipe(Effect.provide(context));
    const mcp = localMcpAuthority(httpServer.address);
    const { stateDir } = yield* Effect.service(ServerConfig.ServerConfig).pipe(
      Effect.provide(context),
    );
    const settings = yield* Effect.service(ServerSettings.ServerSettingsService).pipe(
      Effect.provide(context),
    );
    const proxyPort = () => recorded.initialized[0]!.network.httpProxyPort;
    const proxyIdOf = (command: string) => /proxy="http:\/\/([^@]+)@/.exec(command)![1]!;
    const wrap = (input: Partial<WrapInput> = {}) =>
      service.wrap({
        provider: "codex",
        command: "codex",
        args: ["app-server"],
        cwd,
        env: { PATH: bin, OPENAI_API_KEY: "o", GITHUB_TOKEN: "g", T3CODE_DEV_AUTH_TOKEN: "s" },
        key: "session-1",
        thread: "thread-1",
        ...input,
      });
    const claude = (input: Partial<WrapInput> = {}) =>
      wrap({ provider: "claude", command: "claude", args: [], session: "s1", ...input });
    return {
      service,
      wrap,
      claude,
      bin,
      tools,
      home,
      cwd,
      fs,
      path,
      recorded,
      realCodex,
      realClaude,
      mcp,
      stateDir,
      settings,
      httpServer,
      proxyPort,
      proxyIdOf,
      srtWinProgram,
    };
  });

const codex = ProviderDriverKind.make("codex");
const cursor = ProviderDriverKind.make("cursor");
const live = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));
const lastWrap = (recorded: Recorded) => recorded.wraps.at(-1)!.filesystem;

it.effect("does nothing at all while the setting is off: no process, file, folder or import", () =>
  live(
    Effect.gen(function* () {
      const { service, wrap, recorded, stateDir, fs, path } = yield* isolation({
        enabled: false,
        tools: ["docker"],
      });
      // Left by an earlier run with the setting on: still not looked at.
      yield* fs.makeDirectory(path.join(stateDir, "isolation", "old"), { recursive: true });
      yield* service.check({ driver: cursor, thread: "thread-1", key: "cursor-0" });
      assert.isUndefined(yield* wrap());
      assert.isUndefined(yield* service.status);
      assert.isFalse(yield* service.enabled);
      yield* service.release("session-1");
      yield* service.release("claude-text:1");
      assert.deepEqual(recorded.initialized, []);
      assert.deepEqual(recorded.commands, []);
      assert.deepEqual(recorded.fs, []);
      assert.strictEqual(recorded.loaded, 0);
      assert.isTrue(yield* fs.exists(path.join(stateDir, "isolation", "old")));
    }),
  ),
);

it.effect("refuses no provider or machine: what cannot be isolated starts as without it", () =>
  live(
    Effect.gen(function* () {
      const { service, wrap, claude } = yield* isolation({ enabled: true, srt: false, tools: [] });
      yield* service.check({ driver: cursor, thread: "thread-1", key: "cursor-0" });
      yield* service.check({ driver: codex, thread: "thread-1", key: "codex-0" });
      const status = yield* service.status;
      assert.strictEqual(status?.backend, null);
      assert.include(
        status?.detail,
        "bubblewrap (bwrap) not installed, and Docker is not installed",
      );
      assert.isUndefined(yield* wrap());
      assert.isUndefined(yield* claude());
      assert.isUndefined(yield* wrap({ provider: "cursor", key: "cursor-1" }));
    }),
  ),
);

it.effect("starts srt once per server, its sandboxes using the server's own proxy", () =>
  live(
    Effect.gen(function* () {
      const { wrap, recorded, proxyPort } = yield* isolation({ enabled: true, tools: [] });
      yield* wrap();
      yield* wrap({ key: "session-2" });
      assert.strictEqual(recorded.initialized.length, 1);
      assert.isAbove(proxyPort(), 0);
    }),
  ),
);

/** A raw exchange with the isolation proxy: what it answers before closing, or to `until`. */
const exchange = (at: number | string, request: string | Buffer, until?: string) =>
  Effect.promise(
    () =>
      new Promise<string>((resolve) => {
        let answer = "";
        const socket = (
          typeof at === "number" ? NodeNet.connect(at, "127.0.0.1") : NodeNet.connect(at)
        ).on("connect", () => socket.write(request));
        socket.on("data", (chunk) => {
          answer += chunk.toString("latin1");
          if (until !== undefined && answer.includes(until)) socket.destroy();
        });
        socket.on("close", () => resolve(answer));
        socket.on("error", () => socket.destroy());
      }),
  );
const basic = (user: string) => `Basic ${Buffer.from(`${user}:`).toString("base64")}`;

it.effect("lets a thread reach only /mcp of this server, and tunnel only to its own hosts", () =>
  live(
    Effect.gen(function* () {
      // A stand-in for the provider's API, named by the launch the way a gateway is.
      const provider = NodeNet.createServer((socket) => socket.end("provider says hello"));
      yield* Effect.promise(
        () => new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve)),
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => provider.close()));
      const providerAt = `127.0.0.1:${(provider.address() as NodeNet.AddressInfo).port}`;
      const { claude, bin, recorded, mcp, httpServer, proxyPort, proxyIdOf } = yield* isolation({
        enabled: true,
        tools: [],
      });
      yield* httpServer.serve(Effect.succeed(HttpServerResponse.text("this server answers")));
      yield* claude({ env: { PATH: bin, ANTHROPIC_BASE_URL: `http://${providerAt}` } });
      const id = proxyIdOf(recorded.wraps.at(-1)!.command);
      const port = proxyPort();
      const connect = (target: string, user: string) =>
        exchange(
          port,
          `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${basic(user)}\r\n\r\n`,
          "hello",
        );
      const get = (target: string) =>
        exchange(
          port,
          `GET http://${mcp}${target} HTTP/1.1\r\nHost: ${mcp}\r\nConnection: close\r\n\r\n`,
        );
      assert.match(yield* connect(providerAt, id), /^HTTP\/1\.1 200[^]*provider says hello/);
      // A tunnel to this server's port would carry any request to any of its endpoints.
      assert.match(yield* connect(mcp!, id), /^HTTP\/1\.1 403/);
      assert.match(yield* connect(providerAt, "someone-else"), /^HTTP\/1\.1 403/);
      assert.match(yield* get("/api/settings"), /^HTTP\/1\.1 403/);
      assert.match(yield* get("/mcp"), /^HTTP\/1\.1 200[^]*this server answers/);
      // SOCKS is not spoken: its greeting gets no SOCKS answer.
      const socks = yield* exchange(port, Buffer.from([5, 1, 0]));
      assert.notStrictEqual(socks.charCodeAt(0), 5);
    }),
  ),
);

it.effect("finds a dead srt bridge at the next launch and starts srt again first", () =>
  live(
    Effect.gen(function* () {
      const srtRuns = { ok: true };
      const { wrap, recorded } = yield* isolation({ enabled: true, srtRuns, tools: [] });
      yield* wrap();
      srtRuns.ok = false;
      const launch = yield* wrap({ key: "session-2" });
      assert.strictEqual(launch?.backend, "srt");
      assert.strictEqual(recorded.resets, 1);
      assert.strictEqual(recorded.initialized.length, 2);
    }),
  ),
);

it.effect("makes a launch during an srt restart wait for it rather than fail", () =>
  live(
    Effect.gen(function* () {
      const srtRuns = { ok: true };
      let finishRestart = () => {};
      const holdRestart = new Promise<void>((resolve) => (finishRestart = resolve));
      const { wrap, recorded } = yield* isolation({
        enabled: true,
        srtRuns,
        holdRestart,
        tools: [],
      });
      yield* wrap();
      srtRuns.ok = false;
      const restarting = yield* wrap({ key: "session-2" }).pipe(Effect.forkChild);
      yield* Effect.promise(() => recorded.restarting);
      const waiting = yield* wrap({ key: "session-3" }).pipe(Effect.forkChild);
      finishRestart();
      assert.strictEqual((yield* Fiber.join(restarting))?.backend, "srt");
      assert.strictEqual((yield* Fiber.join(waiting))?.backend, "srt");
      assert.strictEqual(recorded.initialized.length, 2);
    }),
  ),
);

it.effect(
  "gives a thread a private provider folder: its credential, the owner's configuration, no secrets",
  () =>
    live(
      Effect.gen(function* () {
        const { wrap, recorded, home, fs, path, realCodex } = yield* isolation({
          enabled: true,
          tools: [],
        });
        yield* fs.makeDirectory(path.join(realCodex, "rules"));
        yield* fs.writeFileString(path.join(realCodex, "history.jsonl"), "{}\n");
        yield* fs.writeFileString(path.join(realCodex, "state_5.sqlite"), "");
        yield* fs.makeDirectory(path.join(realCodex, "sessions", "2026"), { recursive: true });
        const launch = yield* wrap();
        assert.strictEqual(launch?.command, "/usr/bin/bwrap-stand-in");
        const privateCodex = launch?.env.CODEX_HOME ?? "";
        assert.notStrictEqual(privateCodex, realCodex);
        assert.deepEqual((yield* fs.readDirectory(privateCodex)).toSorted(), [
          "auth.json",
          "config.toml",
          "rules",
          "sessions",
        ]);
        assert.strictEqual(
          yield* fs.readLink(path.join(privateCodex, "config.toml")),
          path.join(realCodex, "config.toml"),
        );
        assert.strictEqual(launch?.env.OPENAI_API_KEY, "o");
        assert.isUndefined(launch?.env.GITHUB_TOKEN);
        assert.isUndefined(launch?.env.T3CODE_DEV_AUTH_TOKEN);
        const identity = launch?.env.GIT_CONFIG_GLOBAL ?? "";
        assert.include(yield* fs.readFileString(identity), 'name = "Ada Lovelace"');
        const filesystem = lastWrap(recorded);
        assert.include(paths(filesystem.allowRead), identity);
        assert.notInclude(paths(filesystem.allowWrite), identity);
        for (const hidden of [
          home,
          realCodex,
          path.join(realCodex, "auth.json"),
          path.join(realCodex, "history.jsonl"),
          path.join(realCodex, "sessions"),
        ]) {
          assert.notInclude(paths(filesystem.allowRead), hidden);
          assert.notInclude(paths(filesystem.allowWrite), hidden);
        }
        assert.includeMembers(paths(filesystem.allowRead), [
          path.join(realCodex, "config.toml"),
          path.join(realCodex, "rules"),
        ]);
        assert.notInclude(paths(filesystem.allowWrite), path.join(realCodex, "config.toml"));
      }),
    ),
);

it.effect("carries Codex's API-key sign-in into the thread", () =>
  live(
    Effect.gen(function* () {
      const { wrap, fs, path, realCodex } = yield* isolation({ enabled: true, tools: [] });
      yield* fs.writeFileString(path.join(realCodex, "auth.json"), '{"OPENAI_API_KEY":"sk-1"}');
      const privateCodex = (yield* wrap())?.env.CODEX_HOME ?? "";
      assert.include(yield* fs.readFileString(path.join(privateCodex, "auth.json")), "sk-1");
    }),
  ),
);

it.effect("never writes through a link the thread made, nor takes another login's credential", () =>
  live(
    Effect.gen(function* () {
      const { wrap, service, home, stateDir, fs, path, realCodex } = yield* isolation({
        enabled: true,
        tools: [],
      });
      const privateCodex = (yield* wrap())?.env.CODEX_HOME ?? "";
      const shared = yield* fs.readLink(path.join(privateCodex, "auth.json"));
      assert.isTrue(shared.startsWith(path.join(stateDir, "isolation", "credentials")));
      const target = path.join(home, "secret.txt");
      yield* fs.remove(shared);
      yield* fs.symlink(target, shared);
      yield* wrap();
      assert.strictEqual(yield* fs.readFileString(target), "secret");
      yield* fs.remove(shared);
      yield* fs.writeFileString(shared, codexSignIn("evil", "acct-2"));
      yield* service.release("session-1");
      assert.include(yield* fs.readFileString(path.join(realCodex, "auth.json")), "real");
      const again = (yield* wrap())?.env.CODEX_HOME ?? "";
      const fresh = yield* fs.readLink(path.join(again, "auth.json"));
      yield* fs.writeFileString(fresh, codexSignIn("fresh"));
      yield* service.release("session-1");
      assert.include(yield* fs.readFileString(path.join(realCodex, "auth.json")), "fresh");
      assert.isFalse(yield* fs.exists(again));
    }),
  ),
);

it.effect("keeps a sign-in the CLI wrote over its link when the session starts again", () =>
  live(
    Effect.gen(function* () {
      const { wrap, fs, path, stateDir } = yield* isolation({ enabled: true, tools: [] });
      const own = path.join((yield* wrap())?.env.CODEX_HOME ?? "", "auth.json");
      const shared = yield* fs.readLink(own);
      // Codex replaces the file rather than writing through the link.
      yield* fs.remove(own);
      yield* fs.writeFileString(own, codexSignIn("refreshed"));
      yield* wrap();
      assert.strictEqual(yield* fs.readFileString(shared), codexSignIn("refreshed"));
      assert.isTrue(shared.startsWith(path.join(stateDir, "isolation", "credentials")));
    }),
  ),
);

it.effect("shares one sign-in between live sessions, and the host's own refresh wins", () =>
  live(
    Effect.gen(function* () {
      const { wrap, service, fs, path, realCodex } = yield* isolation({ enabled: true, tools: [] });
      const first = path.join(
        (yield* wrap({ key: "session-1" }))?.env.CODEX_HOME ?? "",
        "auth.json",
      );
      const second = path.join(
        (yield* wrap({ key: "session-2" }))?.env.CODEX_HOME ?? "",
        "auth.json",
      );
      // One session's refresh is what the other reads next, as outside isolation.
      yield* fs.writeFileString(first, codexSignIn("rotated"));
      assert.include(yield* fs.readFileString(second), "rotated");
      // The host's own Codex refreshed meanwhile: its file stays, and the sessions take it.
      const host = codexSignIn("host-new");
      yield* fs.writeFileString(path.join(realCodex, "auth.json"), host);
      yield* service.release("session-1");
      assert.strictEqual(yield* fs.readFileString(path.join(realCodex, "auth.json")), host);
      assert.include(yield* fs.readFileString(second), "host-new");
    }),
  ),
);

it.effect("returns a crashed run's refreshed sign-in to the host before sweeping it", () =>
  live(
    Effect.gen(function* () {
      const { service, stateDir, fs, path, realCodex } = yield* isolation({
        enabled: true,
        tools: [],
      });
      const real = path.join(realCodex, "auth.json");
      const leftover = (name: string, seeded: string, refreshed: string) =>
        Effect.gen(function* () {
          const folder = path.join(stateDir, "isolation", "credentials", name);
          yield* fs.makeDirectory(path.join(folder, "share"), { recursive: true });
          yield* fs.writeFileString(
            path.join(folder, "source"),
            JSON.stringify({ provider: "codex", real }),
          );
          yield* fs.writeFileString(path.join(folder, "seeded"), seeded);
          yield* fs.writeFileString(path.join(folder, "share", "auth.json"), refreshed);
        });
      yield* leftover("crashed", yield* fs.readFileString(real), codexSignIn("refreshed"));
      yield* service.status;
      assert.include(yield* fs.readFileString(real), "refreshed");
      assert.isFalse(yield* fs.exists(path.join(stateDir, "isolation", "credentials", "crashed")));
    }),
  ),
);

it.effect("copies back no incomplete sign-in, and puts the host's back in its place", () =>
  live(
    Effect.gen(function* () {
      const { wrap, service, fs, path, realCodex } = yield* isolation({ enabled: true, tools: [] });
      const first = (yield* wrap({ key: "session-1" }))?.env.CODEX_HOME ?? "";
      const shared = yield* fs.readLink(path.join(first, "auth.json"));
      yield* fs.writeFileString(shared, '{"tokens":{"access_token":"x","account_id":"acct-1"}}');
      yield* wrap({ key: "session-2" });
      assert.strictEqual(yield* fs.readFileString(shared), codexSignIn("real"));
      yield* service.release("session-1");
      assert.strictEqual(
        yield* fs.readFileString(path.join(realCodex, "auth.json")),
        codexSignIn("real"),
      );
    }),
  ),
);

it.effect("keeps launching and releasing other sessions when a thread wrecks the shared copy", () =>
  live(
    Effect.gen(function* () {
      const { wrap, service, stateDir, fs, path } = yield* isolation({ enabled: true, tools: [] });
      const first = (yield* wrap({ key: "session-1" }))?.env.CODEX_HOME ?? "";
      const shared = yield* fs.readLink(path.join(first, "auth.json"));
      yield* fs.remove(shared);
      yield* fs.makeDirectory(path.join(shared, "inside"), { recursive: true });
      const second = (yield* wrap({ key: "session-2" }))?.env.CODEX_HOME ?? "";
      assert.strictEqual(
        yield* fs.readFileString(path.join(second, "auth.json")),
        codexSignIn("real"),
      );
      yield* fs.remove(shared, { recursive: true });
      yield* fs.makeDirectory(path.join(shared, "inside"), { recursive: true });
      yield* service.release("session-1");
      yield* service.release("session-2");
      assert.isFalse(yield* fs.exists(first));
      assert.isFalse(yield* fs.exists(second));
      assert.deepEqual(
        yield* fs.readDirectory(path.join(stateDir, "isolation", "credentials")),
        [],
      );
      // Nothing holding a sign-in is left behind in the server's own folder.
      const server = yield* fs.readDirectory(path.join(stateDir, "isolation", "server"));
      assert.deepEqual(
        server.filter((name) => name.endsWith(".tmp")),
        [],
      );
    }),
  ),
);

/**
 * A server stalled opening a FIFO stops its whole event loop, the test runner's timeout with
 * it. This child opens each FIFO after `ms` so the server moves again, and leaves a file first:
 * the returned path exists only if the server was still waiting then.
 */
const unblockAfter = (ms: number, fifos: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const waited = path.join(yield* fs.makeTempDirectoryScoped(), "waited");
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        NodeChildProcess.spawn(
          process.execPath,
          [
            "-e",
            `const fs = require("node:fs"); const [waited, ...fifos] = process.argv.slice(1);
             setTimeout(() => {
               fs.writeFileSync(waited, "");
               for (const fifo of fifos) try { fs.openSync(fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK) } catch {}
               setInterval(() => {}, 1000);
             }, ${ms})`,
            waited,
            ...fifos,
          ],
          { stdio: "ignore" },
        ),
      ),
      (child) => Effect.sync(() => child.kill("SIGKILL")),
    );
    return waited;
  });

const fifo = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(file, { recursive: true, force: true });
    NodeChildProcess.execFileSync("mkfifo", [file]);
  });

it.effect("keeps launching and releasing when a thread leaves a FIFO for a sign-in", () =>
  live(
    Effect.gen(function* () {
      const { wrap, service, stateDir, fs, path } = yield* isolation({ enabled: true, tools: [] });
      const first = (yield* wrap({ key: "session-1" }))?.env.CODEX_HOME ?? "";
      const shared = yield* fs.readLink(path.join(first, "auth.json"));
      yield* fifo(shared);
      yield* fifo(path.join(first, "auth.json"));
      const waited = yield* unblockAfter(3000, [shared, path.join(first, "auth.json")]);
      const second = (yield* wrap({ key: "session-2" }))?.env.CODEX_HOME ?? "";
      assert.strictEqual(
        yield* fs.readFileString(path.join(second, "auth.json")),
        codexSignIn("real"),
      );
      yield* service.release("session-1");
      yield* service.release("session-2");
      assert.isFalse(yield* fs.exists(waited));
      assert.deepEqual(
        yield* fs.readDirectory(path.join(stateDir, "isolation", "credentials")),
        [],
      );
    }),
  ),
);

it.effect("sweeps a crashed run that left a FIFO for a sign-in without waiting on it", () =>
  live(
    Effect.gen(function* () {
      const { service, stateDir, fs, path, realCodex } = yield* isolation({
        enabled: true,
        tools: [],
      });
      const real = path.join(realCodex, "auth.json");
      const folder = path.join(stateDir, "isolation", "credentials", "crashed");
      yield* fs.makeDirectory(path.join(folder, "share"), { recursive: true });
      yield* fs.writeFileString(
        path.join(folder, "source"),
        JSON.stringify({ provider: "codex", real }),
      );
      yield* fs.writeFileString(path.join(folder, "seeded"), yield* fs.readFileString(real));
      yield* fifo(path.join(folder, "share", "auth.json"));
      const waited = yield* unblockAfter(3000, [path.join(folder, "share", "auth.json")]);
      yield* service.status;
      assert.isFalse(yield* fs.exists(waited));
      assert.strictEqual(yield* fs.readFileString(real), codexSignIn("real"));
      assert.isFalse(yield* fs.exists(folder));
    }),
  ),
);

it.effect("gives sessions of one account that start together the one shared copy", () =>
  live(
    Effect.gen(function* () {
      const { wrap, service, fs, path } = yield* isolation({ enabled: true, tools: [] });
      const [first, second] = yield* Effect.all(
        [wrap({ key: "session-1" }), wrap({ key: "session-2" })],
        { concurrency: "unbounded" },
      );
      const link = (launch: typeof first) => path.join(launch?.env.CODEX_HOME ?? "", "auth.json");
      const shared = yield* fs.readLink(link(first));
      assert.strictEqual(yield* fs.readLink(link(second)), shared);
      yield* service.release("session-1");
      assert.strictEqual(yield* fs.readFileString(link(second)), codexSignIn("real"));
    }),
  ),
);

it.effect("copies a refreshed credential back to the folder it was seeded from", () =>
  live(
    Effect.gen(function* () {
      const { wrap, service, bin, home, fs, path, realCodex } = yield* isolation({
        enabled: true,
        tools: [],
      });
      const other = path.join(home, "work-codex");
      yield* fs.makeDirectory(other);
      yield* fs.writeFileString(path.join(other, "auth.json"), codexSignIn("work"));
      const privateCodex = (yield* wrap({ env: { PATH: bin, CODEX_HOME: other } }))?.env.CODEX_HOME;
      yield* fs.writeFileString(
        path.join(privateCodex ?? "", "auth.json"),
        codexSignIn("work-fresh"),
      );
      yield* service.release("session-1");
      assert.include(yield* fs.readFileString(path.join(other, "auth.json")), "work-fresh");
      assert.include(yield* fs.readFileString(path.join(realCodex, "auth.json")), "real");
    }),
  ),
);

it.effect("releases one provider session without touching another of the same thread", () =>
  live(
    Effect.gen(function* () {
      const { wrap, service, recorded, fs } = yield* isolation({ enabled: true, tools: [] });
      const first = (yield* wrap({ key: "session-1" }))?.env.CODEX_HOME ?? "";
      const second = (yield* wrap({ key: "session-2" }))?.env.CODEX_HOME ?? "";
      assert.notStrictEqual(first, second);
      yield* service.release("session-1");
      assert.isFalse(yield* fs.exists(first));
      assert.isTrue(yield* fs.exists(second));
      // Each srt launch is ended in the runtime, which removes its placeholders when none runs.
      assert.strictEqual(recorded.cleanups, 1);
    }),
  ),
);

it.effect("keeps a thread's Codex conversations across its sessions and server restarts", () =>
  live(
    Effect.gen(function* () {
      const { wrap, service, fs, path, realCodex } = yield* isolation({
        enabled: true,
        tools: [],
      });
      const id = "0199a0f1-2b3c-7d4e-8f90-123456789abc";
      const dated = path.join(realCodex, "sessions", "2026", "11", "01");
      yield* fs.makeDirectory(dated, { recursive: true });
      const rollout = `rollout-2026-11-01T10-00-00-${id}.jsonl`;
      yield* fs.writeFileString(path.join(dated, rollout), "{}\n");
      const privateCodex = (yield* wrap({ session: id }))?.env.CODEX_HOME ?? "";
      const own = yield* fs.readLink(path.join(privateCodex, "sessions"));
      assert.isTrue(own.startsWith(path.join(realCodex, "sessions", "t3code-isolated")));
      // Moved, not copied, so the one conversation keeps growing in one place.
      assert.isTrue(yield* fs.exists(path.join(own, rollout)));
      assert.isFalse(yield* fs.exists(path.join(dated, rollout)));
      yield* service.release("session-1");
      const next = (yield* wrap({ key: "session-2", session: id }))?.env.CODEX_HOME ?? "";
      assert.strictEqual(yield* fs.readLink(path.join(next, "sessions")), own);
      assert.isTrue(yield* fs.exists(path.join(own, rollout)));
    }),
  ),
);

it.effect("keeps nothing of a Codex run outside a thread in the owner's Codex folder", () =>
  live(
    Effect.gen(function* () {
      const { wrap, service, fs, path, realCodex } = yield* isolation({ enabled: true, tools: [] });
      const privateCodex =
        (yield* wrap({ key: "codex-text:1", thread: undefined }))?.env.CODEX_HOME ?? "";
      assert.isFalse(yield* fs.exists(path.join(privateCodex, "sessions")));
      yield* service.release("codex-text:1");
      assert.isFalse(yield* fs.exists(path.join(realCodex, "sessions", "t3code-isolated")));
    }),
  ),
);

it.effect("keeps everything git reads as configuration read-only in a plain checkout", () =>
  live(
    Effect.gen(function* () {
      const { wrap, recorded, cwd, fs, path } = yield* isolation({ enabled: true, tools: [] });
      yield* wrap();
      const filesystem = lastWrap(recorded);
      const dotGit = path.join(cwd, ".git");
      assert.include(paths(filesystem.allowWrite), dotGit);
      assert.includeMembers(
        paths(filesystem.denyWrite),
        ["config", "config.worktree", "commondir", "hooks", "info", "modules"].map((name) =>
          path.join(dotGit, name),
        ),
      );
      assert.notInclude(paths(filesystem.denyWrite), path.join(dotGit, "HEAD"));
      assert.strictEqual(yield* fs.readFileString(path.join(dotGit, "commondir")), ".\n");
      assert.isTrue(yield* fs.exists(path.join(dotGit, "modules")));
    }),
  ),
);

it.effect("holds a separate git folder's configuration like a checkout's own", () =>
  live(
    Effect.gen(function* () {
      const { wrap, recorded, home, cwd, path } = yield* isolation({
        enabled: true,
        tools: [],
        git: "separate",
      });
      yield* wrap();
      const filesystem = lastWrap(recorded);
      const gitDir = path.join(home, "separate.git");
      assert.include(paths(filesystem.allowWrite), gitDir);
      assert.includeMembers(paths(filesystem.denyWrite), [
        path.join(cwd, ".git"),
        ...["config", "config.worktree", "commondir", "hooks", "info", "modules"].map((name) =>
          path.join(gitDir, name),
        ),
      ]);
    }),
  ),
);

it.effect("starts again in a folder without git where srt left its .git placeholder", () =>
  live(
    Effect.gen(function* () {
      const { wrap, recorded, cwd, fs, path } = yield* isolation({
        enabled: true,
        tools: [],
        git: "none",
      });
      yield* wrap();
      yield* fs.writeFileString(path.join(cwd, ".git"), "");
      yield* wrap({ key: "session-2" });
      assert.include(paths(lastWrap(recorded).denyWrite), path.join(cwd, ".git"));
    }),
  ),
);

it.effect("lets a worktree commit, branch, delete refs and gc, but not change configuration", () =>
  live(
    Effect.gen(function* () {
      const { wrap, recorded, home, cwd, path } = yield* isolation({
        enabled: true,
        tools: [],
        git: "worktree",
      });
      yield* wrap();
      const filesystem = lastWrap(recorded);
      const common = path.join(home, "main", ".git");
      const gitDir = path.join(common, "worktrees", "project");
      assert.includeMembers(paths(filesystem.allowWrite), [gitDir, common]);
      assert.includeMembers(paths(filesystem.denyWrite), [
        path.join(cwd, ".git"),
        path.join(gitDir, "commondir"),
        path.join(gitDir, "gitdir"),
        path.join(gitDir, "config.worktree"),
        path.join(common, "worktrees", "other"),
        ...[
          "config",
          "config.worktree",
          "commondir",
          "hooks",
          "info",
          "modules",
          "HEAD",
          "index",
        ].map((name) => path.join(common, name)),
      ]);
      assert.notInclude(paths(filesystem.denyWrite), path.join(common, "worktrees", "project"));
    }),
  ),
);

it.effect("hardens the server's own git calls in isolated folders only while isolation is on", () =>
  live(
    Effect.gen(function* () {
      const { wrap, settings, cwd, home, stateDir, fs, path } = yield* isolation({
        enabled: true,
        tools: [],
      });
      assert.deepEqual(yield* isolatedGitConfig(path.join(home, "elsewhere")), []);
      yield* wrap();
      assert.deepInclude(yield* isolatedGitConfig(cwd), ["core.fsmonitor", "false"]);
      assert.deepInclude(yield* isolatedGitConfig(path.join(cwd, "sub")), [
        "diff.ignoreSubmodules",
        "all",
      ]);
      // No hook runs: one the thread cannot write still runs scripts it can.
      assert.deepInclude(yield* isolatedGitConfig(cwd), ["core.hooksPath", "/dev/null"]);
      assert.deepEqual(yield* isolatedGitConfig(path.join(home, "elsewhere")), []);
      assert.include(yield* fs.readFileString(path.join(stateDir, "isolation", "folders")), cwd);
      // Switched off, git runs as without isolation at once.
      yield* settings.updateSettings({ threadIsolation: false });
      assert.deepEqual(yield* isolatedGitConfig(cwd), []);
    }),
  ),
);

it.effect("holds the files a repository's configuration includes from the checkout", () =>
  live(
    Effect.gen(function* () {
      const { wrap, recorded, cwd, home, fs, path } = yield* isolation({
        enabled: true,
        tools: [],
        includes: [
          [".git/config", "../.gitconfig-shared"],
          // Included in turn, and not there yet.
          [".git/../.gitconfig-shared", "tools/git/more"],
          ["/etc/gitconfig", "/etc/gitconfig.d/site"],
        ],
      });
      yield* fs.writeFileString(path.join(cwd, ".gitconfig-shared"), "");
      yield* wrap();
      const denied = paths(lastWrap(recorded).denyWrite);
      // The whole top-level entry, so no folder above the file can be swapped.
      assert.includeMembers(denied, [path.join(cwd, ".gitconfig-shared"), path.join(cwd, "tools")]);
      assert.strictEqual(yield* fs.readFileString(path.join(cwd, "tools", "git", "more")), "");
      assert.isFalse(denied.some((entry) => entry.startsWith("/etc") || entry === home));
    }),
  ),
);

it.effect("starts a thread without isolation, marked, where Git cannot be hardened", () =>
  live(
    Effect.gen(function* () {
      const old = { enabled: true, tools: [], gitVersion: "git version 2.30.2" };
      const { service, wrap, cwd } = yield* isolation(old);
      assert.isUndefined(yield* wrap());
      assert.include((yield* service.status)?.threads?.["thread-1"], "older than 2.31");
      assert.deepEqual(yield* isolatedGitConfig(cwd), []);
      const strict = yield* isolation({
        ...old,
        settings: { threadIsolationPolicy: { refuseUnisolated: true } },
      });
      assert.include((yield* Effect.flip(strict.wrap())).message, "older than 2.31");
    }),
  ),
);

it.effect("hardens recorded folders from server start, before any isolated launch", () =>
  live(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped();
      const recorded = path.join(baseDir, "userdata", "isolation");
      yield* fs.makeDirectory(recorded, { recursive: true });
      const folder = path.join(baseDir, "threads-folder");
      yield* fs.writeFileString(path.join(recorded, "folders"), `${folder}\n`);
      const { stateDir } = yield* isolation({ enabled: true, tools: [], baseDir });
      assert.strictEqual(stateDir, path.join(baseDir, "userdata"));
      assert.deepInclude(yield* isolatedGitConfig(folder), ["core.fsmonitor", "false"]);
    }),
  ),
);

it.effect("holds the whole project entry holding the hooks folder, as husky's .husky/_", () =>
  live(
    Effect.gen(function* () {
      const { wrap, recorded, cwd, fs, path } = yield* isolation({
        enabled: true,
        tools: [],
        hooks: ".husky/_",
      });
      yield* wrap();
      // Not only .husky/_: its hooks run scripts in .husky, and .husky could be swapped.
      assert.include(paths(lastWrap(recorded).denyWrite), path.join(cwd, ".husky"));
      assert.isTrue(yield* fs.exists(path.join(cwd, ".husky", "_")));
    }),
  ),
);

it.effect("refuses a launch when git cannot say where the hooks are", () =>
  live(
    Effect.gen(function* () {
      const { wrap } = yield* isolation({ enabled: true, tools: [], hooksUnknown: true });
      assert.include((yield* Effect.flip(wrap())).message, "where this repository's hooks are");
    }),
  ),
);

it.effect("keeps Claude's transcripts for this folder in the real Claude folder, no others", () =>
  live(
    Effect.gen(function* () {
      const { claude, recorded, cwd, fs, path, realClaude } = yield* isolation({
        enabled: true,
        tools: [],
      });
      const launch = yield* claude();
      const privateClaude = launch?.env.CLAUDE_CONFIG_DIR ?? "";
      const transcripts = path.join(realClaude, "projects", claudeProjectFolder(cwd));
      assert.strictEqual(
        yield* fs.readLink(path.join(privateClaude, "projects", claudeProjectFolder(cwd))),
        transcripts,
      );
      const filesystem = lastWrap(recorded);
      assert.includeMembers(paths(filesystem.allowWrite), [
        transcripts,
        path.join(realClaude, "tasks", "s1"),
      ]);
      assert.includeMembers(paths(filesystem.denyWrite), [
        path.join(privateClaude, "projects"),
        path.join(privateClaude, "tasks"),
      ]);
      assert.notInclude(paths(filesystem.allowRead), path.join(realClaude, "projects"));
    }),
  ),
);

it.effect("brings the owner's whole Claude configuration and this folder's MCP servers", () =>
  live(
    Effect.gen(function* () {
      const { claude, recorded, cwd, home, fs, path, realClaude } = yield* isolation({
        enabled: true,
        tools: [],
      });
      const dotfiles = path.join(home, "dotfiles");
      yield* fs.makeDirectory(path.join(dotfiles, "my-skill"), { recursive: true });
      yield* fs.writeFileString(path.join(dotfiles, "settings.json"), '{"model":"opus"}');
      yield* fs.symlink(
        path.join(dotfiles, "settings.json"),
        path.join(realClaude, "settings.json"),
      );
      yield* fs.makeDirectory(path.join(realClaude, "skills"));
      yield* fs.symlink(
        path.join(dotfiles, "my-skill"),
        path.join(realClaude, "skills", "my-skill"),
      );
      yield* fs.makeDirectory(path.join(realClaude, "plugins"));
      yield* fs.writeFileString(path.join(realClaude, "history.jsonl"), "{}\n");
      yield* fs.writeFileString(
        path.join(home, ".claude.json"),
        JSON.stringify({
          mcpServers: { user: { command: "u" } },
          projects: {
            [cwd]: { mcpServers: { local: { command: "l" } }, enabledMcpjsonServers: ["p"] },
            [path.join(home, "other")]: { mcpServers: { secret: { command: "s" } } },
          },
          oauthAccount: { emailAddress: "ada@example.com" },
        }),
      );
      const privateClaude = (yield* claude())?.env.CLAUDE_CONFIG_DIR ?? "";
      const names = yield* fs.readDirectory(privateClaude);
      assert.includeMembers(names, ["settings.json", "skills", "plugins", ".claude.json"]);
      assert.notInclude(names, "history.jsonl");
      assert.strictEqual(
        yield* fs.readLink(path.join(privateClaude, "settings.json")),
        path.join(dotfiles, "settings.json"),
      );
      assert.includeMembers(paths(lastWrap(recorded).allowRead), [
        path.join(dotfiles, "settings.json"),
        path.join(dotfiles, "my-skill"),
        path.join(realClaude, "plugins"),
      ]);
      const state = JSON.parse(yield* fs.readFileString(path.join(privateClaude, ".claude.json")));
      assert.deepEqual(state.mcpServers, { user: { command: "u" } });
      assert.deepEqual(Object.keys(state.projects), [cwd]);
      assert.deepEqual(state.projects[cwd].enabledMcpjsonServers, ["p"]);
      assert.isUndefined(state.oauthAccount);
    }),
  ),
);

it.effect("follows sign-in that Claude's settings.json sets, and the scripts it names", () =>
  live(
    Effect.gen(function* () {
      const { claude, recorded, home, fs, path, realClaude } = yield* isolation({
        enabled: true,
        tools: [],
      });
      yield* fs.makeDirectory(path.join(home, "bin"));
      yield* fs.writeFileString(path.join(home, "bin", "key.sh"), "", { mode: 0o755 });
      yield* fs.writeFileString(
        path.join(realClaude, "settings.json"),
        JSON.stringify({
          env: { CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "eu-west-1" },
          apiKeyHelper: "~/bin/key.sh --profile work",
        }),
      );
      yield* fs.makeDirectory(path.join(home, ".aws", "sso", "cache"), { recursive: true });
      const launch = yield* claude();
      assert.include(paths(lastWrap(recorded).allowRead), path.join(home, "bin", "key.sh"));
      // The AWS SDK looks under HOME: the owner's ~/.aws is there, read-only.
      assert.strictEqual(
        yield* fs.readLink(path.join(launch?.env.HOME ?? "", ".aws")),
        path.join(home, ".aws"),
      );
      assert.include(paths(lastWrap(recorded).allowRead), path.join(home, ".aws"));
      assert.notInclude(paths(lastWrap(recorded).allowWrite), path.join(home, ".aws"));
    }),
  ),
);

it.effect(
  "makes the gcloud link only in the private HOME, never through a link the thread made",
  () =>
    live(
      Effect.gen(function* () {
        const { claude, bin, home, fs, path } = yield* isolation({ enabled: true, tools: [] });
        yield* fs.makeDirectory(path.join(home, ".config", "gcloud"), { recursive: true });
        const elsewhere = path.join(home, "elsewhere");
        yield* fs.makeDirectory(elsewhere);
        const env = { PATH: bin, CLAUDE_CODE_USE_VERTEX: "1" };
        const privateHome = (yield* claude({ env }))?.env.HOME ?? "";
        yield* fs.remove(path.join(privateHome, ".config"), { recursive: true });
        yield* fs.symlink(elsewhere, path.join(privateHome, ".config"));
        yield* claude({ env });
        assert.deepEqual(yield* fs.readDirectory(elsewhere), []);
        assert.strictEqual(
          yield* fs.readLink(path.join(privateHome, ".config", "gcloud")),
          path.join(home, ".config", "gcloud"),
        );
      }),
    ),
);

it.effect("gives Vertex on Windows its gcloud sign-in from the owner's %APPDATA%", () =>
  live(
    Effect.gen(function* () {
      const { claude, recorded, bin, home, fs, path } = yield* isolation({
        enabled: true,
        tools: [],
        platform: "win32",
        srtWin: { ready: true },
      });
      const appData = path.join(home, "AppData", "Roaming");
      yield* fs.makeDirectory(path.join(appData, "gcloud"), { recursive: true });
      const claudeExe = path.join(home, ".local", "bin", "claude.exe");
      yield* fs.makeDirectory(path.dirname(claudeExe), { recursive: true });
      yield* fs.writeFileString(claudeExe, "");
      const env = { PATH: bin, CLAUDE_CODE_USE_VERTEX: "1", APPDATA: appData };
      const launch = yield* claude({ command: claudeExe, env });
      const privateAppData = srtWinParts(launch!.args).env.APPDATA!;
      assert.strictEqual(
        yield* fs.readLink(path.join(privateAppData, "gcloud")),
        path.join(appData, "gcloud"),
      );
      assert.include(recorded.grants.at(-1)!.read, path.join(appData, "gcloud"));
    }),
  ),
);

it.effect("lets the thread run the tools on the server's PATH, read-only", () =>
  live(
    Effect.gen(function* () {
      const { wrap, recorded, bin, tools } = yield* isolation({
        enabled: true,
        tools: ["npm", "pnpm"],
      });
      yield* wrap();
      const filesystem = lastWrap(recorded);
      assert.includeMembers(paths(filesystem.allowRead), [bin, tools]);
      assert.notInclude(paths(filesystem.allowWrite), tools);
    }),
  ),
);

it.effect("probes from server start while the setting is on, before any client asks", () =>
  live(
    Effect.gen(function* () {
      const { service } = yield* isolation({ enabled: true, tools: [] });
      const probed = yield* Deferred.make<string | null | undefined>();
      yield* warm.pipe(
        Effect.provideService(ThreadIsolation, {
          ...service,
          status: Effect.tap(service.status, (status) => Deferred.succeed(probed, status?.backend)),
        }),
      );
      assert.strictEqual(yield* Deferred.await(probed), "srt");
    }),
  ),
);

it.effect("shows the last probe's answer while the next one runs, then tells clients", () =>
  live(
    Effect.gen(function* () {
      let finishProbe = () => {};
      const holdRestart = new Promise<void>((resolve) => (finishProbe = resolve));
      const { service, recorded } = yield* isolation({
        enabled: true,
        srtRuns: { ok: false },
        holdRestart,
        tools: [],
      });
      assert.strictEqual((yield* service.status)?.backend, null);
      const changes = yield* service.subscribeChanges;
      const changed = yield* Stream.runHead(changes).pipe(Effect.forkChild);
      // The second probe is held: a client's snapshot waiting for it would never be sent.
      assert.strictEqual((yield* service.status)?.backend, null);
      yield* Effect.promise(() => recorded.restarting);
      assert.strictEqual((yield* service.status)?.backend, null);
      assert.strictEqual(recorded.initialized.length, 2);
      finishProbe();
      yield* Fiber.join(changed);
      assert.strictEqual((yield* service.status)?.backend, "srt");
    }),
  ),
);

it.effect("falls back to Docker when srt cannot start, and the next launch runs no checks", () =>
  live(
    Effect.gen(function* () {
      const { service, wrap, bin, tools, path, recorded } = yield* isolation({
        enabled: true,
        srtRuns: { ok: false },
        tools: ["docker", "socat"],
      });
      const status = yield* service.status;
      assert.strictEqual(status?.backend, "docker");
      assert.strictEqual(status?.detail, "srt cannot start a sandbox on this machine");
      const launch = yield* wrap();
      assert.strictEqual(launch?.command, path.join(bin, "docker"));
      assert.strictEqual(launch?.backend, "docker");
      assert.deepEqual(launch?.args.slice(-2), [path.join(tools, "codex"), "app-server"]);
      recorded.commands.length = 0;
      yield* wrap({ key: "session-2" });
      yield* service.check({ driver: codex, thread: "thread-1", key: "codex-0" });
      // Only git, asked where the hooks are now and which files its configuration includes
      // (about 3 ms each), so a change is held at once.
      assert.deepEqual(
        recorded.commands.map((command) => command.slice(0, 2)),
        [
          ["git", "rev-parse"],
          ["git", "config"],
        ],
      );
    }),
  ),
);

it.effect("removes only this server's containers left by an earlier run", () =>
  live(
    Effect.gen(function* () {
      const { service, recorded, stateDir, fs, path } = yield* isolation({
        enabled: true,
        tools: ["docker", "socat"],
      });
      yield* fs.makeDirectory(path.join(stateDir, "isolation", "old"), { recursive: true });
      yield* service.status;
      yield* Effect.yieldNow;
      const sweep = recorded.commands.find((command) => command.join(" ").includes("ps -aq"));
      assert.match(sweep?.[2] ?? "", /--filter label=t3code-isolation=[0-9a-f]{16} /);
      assert.isFalse(yield* fs.exists(path.join(stateDir, "isolation", "old")));
    }),
  ),
);

it.effect(
  "starts Docker on a folder without Git, and Codex's own providers, without isolation",
  () =>
    live(
      Effect.gen(function* () {
        const plain = yield* isolation({
          enabled: true,
          srt: false,
          tools: ["docker", "socat"],
          git: "none",
        });
        assert.isUndefined(yield* plain.wrap());
        // The folder of a thread that runs without a sandbox keeps the server's own git as is.
        assert.deepEqual(yield* isolatedGitConfig(plain.cwd), []);
        assert.strictEqual(
          (yield* plain.service.status)?.threads?.["thread-1"],
          "Docker isolation needs the thread's folder to be a Git repository",
        );
        const custom = yield* isolation({ enabled: true, tools: [] });
        yield* custom.fs.writeFileString(
          custom.path.join(custom.realCodex, "config.toml"),
          '[model_providers.azure]\nbase_url = "https://x"\n',
        );
        assert.isUndefined(yield* custom.wrap());
        assert.include(
          (yield* custom.service.status)?.threads?.["thread-1"],
          "Codex's custom model providers",
        );
      }),
    ),
);

it.effect("keeps the Docker proxy socket within the Unix socket path limit", () =>
  live(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = path.join(yield* fs.makeTempDirectoryScoped(), "a".repeat(90));
      const { wrap } = yield* isolation({
        enabled: true,
        srt: false,
        tools: ["docker", "socat"],
        baseDir,
      });
      const launch = yield* wrap();
      const socket = launch?.args.find((arg) =>
        arg.endsWith("dst=/run/t3code-proxy.sock,readonly"),
      );
      const source = /src=([^,]+)/.exec(socket ?? "")![1]!;
      assert.isAtMost(Buffer.byteLength(source), 107);
      assert.isTrue(yield* fs.exists(source));
      // A fresh, private name: no other user can claim it beforehand.
      assert.match(path.basename(path.dirname(source)), /^t3code-isolation-\w{6,}$/);
      assert.notMatch(path.basename(path.dirname(source)), /^t3code-isolation-[0-9a-f]{16}$/);
      assert.strictEqual((yield* fs.stat(path.dirname(source))).mode & 0o777, 0o700);
    }),
  ),
);

it.effect("reads the owner's own large files whole: Claude's state and Codex's config", () =>
  live(
    Effect.gen(function* () {
      const { claude, wrap, home, fs, path, realCodex } = yield* isolation({
        enabled: true,
        tools: [],
      });
      const padding = "x".repeat(2 * 1024 * 1024);
      yield* fs.writeFileString(
        path.join(home, ".claude.json"),
        JSON.stringify({ mcpServers: { user: { command: "u" } }, padding }),
      );
      const privateClaude = (yield* claude())?.env.CLAUDE_CONFIG_DIR ?? "";
      const state = JSON.parse(yield* fs.readFileString(path.join(privateClaude, ".claude.json")));
      assert.deepEqual(state.mcpServers, { user: { command: "u" } });
      yield* fs.writeFileString(
        path.join(realCodex, "config.toml"),
        `# ${padding}\n[model_providers.azure]\nbase_url = "https://x"\n`,
      );
      // Found past the first megabyte: Codex then starts without isolation.
      assert.isUndefined(yield* wrap());
    }),
  ),
);

it.effect("reads a sign-in a thread wrote only up to twice the seeded one's size", () =>
  live(
    Effect.gen(function* () {
      const { wrap, service, fs, path, realCodex } = yield* isolation({ enabled: true, tools: [] });
      const first = (yield* wrap({ key: "session-1" }))?.env.CODEX_HOME ?? "";
      const shared = yield* fs.readLink(path.join(first, "auth.json"));
      const huge = codexSignIn("y".repeat(4 * codexSignIn("real").length));
      yield* fs.writeFileString(shared, huge);
      yield* service.release("session-1");
      assert.strictEqual(
        yield* fs.readFileString(path.join(realCodex, "auth.json")),
        codexSignIn("real"),
      );
    }),
  ),
);

it.effect("leaves time limits to the process runner, and says when a command ran out of time", () =>
  live(
    Effect.gen(function* () {
      const hooks = yield* isolation({ enabled: true, tools: [], timesOut: ["rev-parse"] });
      assert.include((yield* Effect.flip(hooks.wrap())).message, "git did not answer in time");
      assert.isTrue(hooks.recorded.timeouts.every((timeout) => timeout === undefined));
      const docker = yield* isolation({
        enabled: true,
        srt: false,
        tools: ["docker", "socat"],
        timesOut: ["info"],
      });
      assert.include((yield* docker.service.status)?.detail, "Docker did not answer in time");
      assert.isUndefined(yield* docker.wrap());
    }),
  ),
);

it.effect("registers an account only once its folder is made, so a failed first use heals", () =>
  live(
    Effect.gen(function* () {
      const { wrap, service, stateDir, fs, path } = yield* isolation({ enabled: true, tools: [] });
      yield* service.status;
      const credentials = path.join(stateDir, "isolation", "credentials");
      yield* fs.writeFileString(credentials, "in the way");
      yield* Effect.flip(wrap({ key: "session-1" }));
      yield* fs.remove(credentials);
      const privateCodex = (yield* wrap({ key: "session-2" }))?.env.CODEX_HOME ?? "";
      assert.strictEqual(
        yield* fs.readFileString(path.join(privateCodex, "auth.json")),
        codexSignIn("real"),
      );
    }),
  ),
);

it.effect("starts a session again when the thread left files where its folders go", () =>
  live(
    Effect.gen(function* () {
      const { claude, bin, home, fs, path } = yield* isolation({ enabled: true, tools: [] });
      yield* fs.makeDirectory(path.join(home, ".config", "gcloud"), { recursive: true });
      const env = { PATH: bin, CLAUDE_CODE_USE_VERTEX: "1" };
      const first = yield* claude({ env });
      const privateHome = first?.env.HOME ?? "";
      const privateClaude = first?.env.CLAUDE_CONFIG_DIR ?? "";
      yield* fs.remove(path.join(privateHome, ".config"), { recursive: true });
      yield* fs.writeFileString(path.join(privateHome, ".config"), "a file");
      yield* fs.remove(privateClaude, { recursive: true });
      yield* fs.writeFileString(privateClaude, "a file");
      yield* claude({ env });
      assert.strictEqual(
        yield* fs.readLink(path.join(privateHome, ".config", "gcloud")),
        path.join(home, ".config", "gcloud"),
      );
      assert.strictEqual((yield* fs.stat(privateClaude)).type, "Directory");
    }),
  ),
);

it.effect("replaces the shared sign-in in place, so a live session never finds it missing", () =>
  live(
    Effect.gen(function* () {
      const { wrap, recorded, fs, path, realCodex } = yield* isolation({
        enabled: true,
        tools: [],
      });
      const first = (yield* wrap({ key: "session-1" }))?.env.CODEX_HOME ?? "";
      const shared = yield* fs.readLink(path.join(first, "auth.json"));
      yield* fs.writeFileString(path.join(realCodex, "auth.json"), codexSignIn("host-new"));
      recorded.removed.length = 0;
      yield* wrap({ key: "session-2" });
      assert.strictEqual(yield* fs.readFileString(shared), codexSignIn("host-new"));
      // Written beside it and renamed over it: never removed first.
      assert.notInclude(recorded.removed, shared);
    }),
  ),
);

/** A Windows machine prepared for the sandbox, as earlier tooling wrote its file. */
const preparedWindows = (fs: FileSystem.FileSystem, path: Path.Path, stateDir: string) =>
  Effect.gen(function* () {
    // T3 home, which T3CODE_HOME may put outside the home folder; its userdata is the state.
    const folder = path.dirname(stateDir);
    const home = folder;
    const preparation = {
      python: path.join(home, "Python", "python.exe"),
      bridge: path.join(home, "sandbox", "bridge.py"),
      state: path.join(home, "sandbox-state"),
    };
    const configPath = path.join(folder, "guild-sandbox.json");
    yield* fs.writeFileString(configPath, JSON.stringify(preparation));
    return { ...preparation, configPath };
  });

it.effect("launches a thread on Windows exactly as T3 Code's per-provider switch did", () =>
  live(
    Effect.gen(function* () {
      const { service, wrap, claude, recorded, bin, cwd, stateDir, fs, path } = yield* isolation({
        enabled: true,
        tools: [],
        platform: "win32",
      });
      const prepared = yield* preparedWindows(fs, path, stateDir);
      const status = yield* service.status;
      assert.strictEqual(status?.backend, "srt");
      assert.strictEqual(status?.detail, "");
      const env = { PATH: bin, OPENAI_API_KEY: "o", GITHUB_TOKEN: "g", T3CODE_DEV_AUTH_TOKEN: "s" };
      // What the per-provider switch built before isolation, argument for argument.
      const expected = (provider: "codex" | "claude", command: string, args: Array<string>) => ({
        backend: "windows" as const,
        command: prepared.python,
        args: [
          "-I",
          "-B",
          prepared.bridge,
          "--config",
          prepared.configPath,
          "--provider",
          provider,
          "--workspace",
          cwd,
          "--thread",
          "thread-1",
          "--binary",
          command,
          "--",
          ...args,
        ],
        env,
        stopPath: path.join(
          prepared.state,
          "t3",
          NodeCrypto.createHash("sha256").update(`${provider}:thread-1`).digest("hex").slice(0, 24),
          "stop",
        ),
      });
      assert.deepEqual(yield* wrap({ env }), expected("codex", "codex", ["app-server"]));
      assert.deepEqual(yield* claude({ env }), expected("claude", "claude", []));
      // Title and commit-message runs ran outside it, and still do.
      assert.isUndefined(yield* wrap({ key: "codex-text:1", thread: undefined }));
      // Nothing of srt, Docker or the private state is used; git is only asked its version.
      assert.deepEqual(recorded.initialized, []);
      assert.deepEqual(recorded.commands, [["git", "--version"]]);
      // Its changes return to the project, so the server's git there runs no hooks.
      assert.deepInclude(yield* isolatedGitConfig(cwd), ["core.hooksPath", "/dev/null"]);
    }),
  ),
);

it.effect("starts threads on Windows without isolation until srt is set up, and says how", () =>
  live(
    Effect.gen(function* () {
      const { service, wrap, claude } = yield* isolation({
        enabled: true,
        tools: [],
        platform: "win32",
      });
      const status = yield* service.status;
      assert.strictEqual(status?.backend, null);
      assert.include(status?.detail, WINDOWS_NOT_SET_UP);
      assert.isTrue(status?.canSetUp);
      yield* service.check({ driver: codex, thread: "thread-1", key: "codex-0" });
      assert.isUndefined(yield* wrap());
      assert.isUndefined(yield* claude());
    }),
  ),
);

/** srt-win's command as a launch gives it: its flags, and the variables and argv in its spec. */
const srtWinParts = (args: ReadonlyArray<string>) => {
  const separator = args.indexOf("--");
  const flags = args.slice(0, separator);
  const denyWrite = flags.flatMap((flag, index) =>
    flag === "--deny-write" ? [flags[index + 1]!] : [],
  );
  const [node, launcher, specPath] = args.slice(separator + 1);
  const spec = JSON.parse(NodeFS.readFileSync(specPath!, "utf8")) as {
    readonly env: Record<string, string>;
    readonly argv: ReadonlyArray<string>;
  };
  return { flags, denyWrite, node, launcher: launcher!, env: spec.env, argv: spec.argv };
};

it.effect("runs Claude and Codex on Windows under srt-win, with no shell between", () =>
  live(
    Effect.gen(function* () {
      const harness = yield* isolation({
        enabled: true,
        tools: [],
        platform: "win32",
        srtWin: { ready: true },
      });
      const { service, claude, wrap, recorded, home, cwd, bin, fs, path, srtWinProgram } = harness;
      const status = yield* service.status;
      assert.strictEqual(status?.backend, "srt");
      assert.isUndefined(status?.canSetUp);
      // srt-win reaches only its fence's ports, where the server's own proxy listens.
      assert.isAtLeast(harness.proxyPort(), 60080);
      assert.isAtMost(harness.proxyPort(), 60089);
      assert.deepEqual(recorded.initialized[0]!.windows, { srtWin: { path: srtWinProgram } });

      const claudeExe = path.join(home, ".local", "bin", "claude.exe");
      yield* fs.makeDirectory(path.dirname(claudeExe), { recursive: true });
      yield* fs.writeFileString(claudeExe, "");
      const args = ["--append-system-prompt", 'say "hi" & echo %PATH% ^| more'];
      const launch = yield* claude({ command: claudeExe, args });
      assert.strictEqual(launch?.backend, "srt");
      assert.strictEqual(launch?.command, srtWinProgram);
      const parts = srtWinParts(launch!.args);
      // The program and its arguments, exactly; cmd never parses them.
      assert.deepEqual(parts.argv, [claudeExe, ...args]);
      assert.strictEqual(parts.env.USERPROFILE, parts.env.HOME);
      assert.strictEqual(parts.env.CLAUDE_CONFIG_DIR, path.join(parts.env.HOME!, ".claude"));
      assert.strictEqual(parts.env.TEMP, path.join(path.dirname(parts.env.HOME!), "tmp"));
      assert.strictEqual(parts.env.APPDATA, path.join(parts.env.HOME!, "AppData", "Roaming"));
      const proxyId = /^http:\/\/([^@]+)@127\.0\.0\.1:(\d+)$/.exec(parts.env.HTTP_PROXY!);
      assert.strictEqual(Number(proxyId?.[2]), harness.proxyPort());
      assert.strictEqual(parts.env.PATH, bin);
      // No variable's value is on srt-win's command line, which other processes can read.
      assert.isFalse(launch!.args.some((arg) => arg.includes(proxyId![1]!)));
      assert.strictEqual(parts.node, "C:\\Program Files\\nodejs\\node.exe");
      assert.strictEqual(NodeFS.readFileSync(parts.launcher, "utf8"), SRT_WIN_LAUNCHER);
      // What git runs stays read-only, for this command.
      assert.include(parts.denyWrite, path.join(cwd, ".git", "hooks"));
      // The folders it writes, and of what it reads only what Windows does not let it already.
      const grant = recorded.grants.at(-1)!;
      assert.includeMembers(grant.write, [cwd, parts.env.HOME!, parts.env.TEMP!, `${cwd}/.git`]);
      assert.include(grant.read, path.dirname(claudeExe));
      assert.include(grant.read, parts.launcher);
      assert.notInclude(grant.read, bin);

      // An npm shim's script starts with Node directly.
      const shim = path.join(bin, "codex.cmd");
      const script = path.join(bin, "node_modules", "@openai", "codex", "bin", "codex.js");
      yield* fs.makeDirectory(path.dirname(script), { recursive: true });
      yield* fs.writeFileString(script, "");
      yield* fs.writeFileString(path.join(bin, "node.exe"), "");
      yield* fs.writeFileString(
        shim,
        '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n',
      );
      const codex = yield* wrap({ command: shim, key: "session-2" });
      // Windows lets no ordinary user link a file: the sign-in and settings are copies.
      const codexHome = srtWinParts(codex!.args).env.CODEX_HOME!;
      for (const name of ["auth.json", "config.toml"]) {
        assert.isTrue(
          (yield* Effect.exit(fs.readLink(path.join(codexHome, name))))._tag === "Failure",
        );
      }
      assert.strictEqual(
        yield* fs.readFileString(path.join(codexHome, "auth.json")),
        codexSignIn("real"),
      );
      assert.deepEqual(srtWinParts(codex!.args).argv, [
        path.join(bin, "node.exe"),
        "--preserve-symlinks",
        "--preserve-symlinks-main",
        script,
        "app-server",
      ]);
      // Any other script would be parsed by cmd: it starts without isolation, marked.
      const other = path.join(bin, "tool.cmd");
      yield* fs.writeFileString(other, "@echo off\r\nnode tool.js %*\r\n");
      assert.isUndefined(yield* wrap({ command: other, key: "session-3" }));
      assert.include((yield* service.status)?.threads?.["thread-1"], "Windows command script");

      // Each key's grants have their own holder, and its release revokes only those.
      assert.strictEqual(recorded.holders.length, 2);
      yield* service.release("session-1");
      const revoke = recorded.commands.find((line) => line.includes("revoke"))!;
      assert.deepEqual(revoke, [
        srtWinProgram,
        "acl",
        "revoke",
        "--holder-pid",
        String(recorded.holders[0]!.pid),
        "--sandbox-user-sid",
        "S-1-5-21-1-2-3-1001",
        "--json",
      ]);
      assert.deepEqual(
        recorded.holders.map((holder) => holder.released),
        [true, false],
      );
    }),
  ),
);

it.effect("grants srt-win's folders outside the lock every launch takes, one holder a key", () =>
  live(
    Effect.gen(function* () {
      let release = () => {};
      let started = () => {};
      const grantStarted = new Promise<void>((resolve) => (started = resolve));
      const firstGrant = {
        started: () => started(),
        answer: new Promise<void>((resolve) => (release = resolve)),
      };
      const { claude, recorded, home, fs, path } = yield* isolation({
        enabled: true,
        tools: [],
        platform: "win32",
        srtWin: { ready: true },
        firstGrant,
      });
      const claudeExe = path.join(home, ".local", "bin", "claude.exe");
      yield* fs.makeDirectory(path.dirname(claudeExe), { recursive: true });
      yield* fs.writeFileString(claudeExe, "");
      const slow = yield* claude({ command: claudeExe, key: "slow" }).pipe(Effect.forkChild);
      yield* Effect.promise(() => grantStarted);
      // Another key starts while the first key's grant has not answered.
      assert.strictEqual((yield* claude({ command: claudeExe, key: "other" }))?.backend, "srt");
      release();
      assert.strictEqual((yield* Fiber.join(slow))?.backend, "srt");
      // A key launched again keeps its holder.
      yield* claude({ command: claudeExe, key: "slow" });
      assert.strictEqual(recorded.holders.length, 2);
    }),
  ),
);

it.effect("checks srt-win's network fence without blocking, before srt checks it again", () =>
  live(
    Effect.gen(function* () {
      const { service, recorded, srtWinProgram } = yield* isolation({
        enabled: true,
        tools: [],
        platform: "win32",
        srtWin: { ready: true, fence: false },
      });
      const status = yield* service.status;
      assert.strictEqual(status?.backend, null);
      assert.include(status?.detail, WINDOWS_FENCE_INACTIVE);
      assert.isTrue(status?.canSetUp);
      // srt-win is set up though it cannot start: removing it is offered too.
      assert.isTrue(status?.canRemove);
      assert.deepEqual(recorded.initialized, []);
      const verify = recorded.commands.find((line) => line[1] === "wfp")!;
      assert.deepEqual(verify.slice(0, 4), [srtWinProgram, "wfp", "verify", "--target"]);
      const port = Number(verify[4]!.split(":")[1]);
      assert.isTrue(port < 60080 || port > 60089);
    }),
  ),
);

it("moves to the next srt-win port on one in use or reserved, and says where to look", () => {
  /** A server whose listen on each port in `refused` fails with that code. */
  const fake = (refused: Record<number, string>) => {
    const events = new NodeEvents.EventEmitter();
    const tried: Array<number> = [];
    const server = {
      once: (event: string, listener: (cause: NodeJS.ErrnoException) => void) => {
        events.once(event, listener);
        return server;
      },
      listen: (port: number, _host: string, listening: () => void) => {
        tried.push(port);
        const code = refused[port];
        queueMicrotask(() =>
          code === undefined
            ? listening()
            : events.emit("error", Object.assign(new Error(code), { code })),
        );
        return server;
      },
    };
    return { server: server as unknown as Parameters<typeof listenOnFirst>[0], tried };
  };
  const ports = [60080, 60081, 60082];
  return new Promise<void>((done, wrong) => {
    const reserved = fake({ 60080: "EACCES", 60081: "EADDRINUSE" });
    listenOnFirst(reserved.server, ports, wrong, () => {
      assert.deepEqual(reserved.tried, ports);
      const none = fake({ 60080: "EACCES", 60081: "EACCES", 60082: "EADDRINUSE" });
      listenOnFirst(
        none.server,
        ports,
        (cause) => {
          assert.include(cause.message, "60080-60082 are all in use or reserved");
          assert.include(cause.message, "netsh int ipv4 show excludedportrange");
          done();
        },
        () => wrong(new Error("listened with every port refused")),
      );
    });
  });
});

it.effect("says why srt-win's proxy could not start, where a port is reserved", () =>
  live(
    Effect.gen(function* () {
      // Every port of srt-win's fence is taken.
      const taken = yield* Effect.forEach(
        Array.from({ length: 10 }, (_, i) => 60080 + i),
        (port) =>
          Effect.callback<NodeNet.Server>((resume) => {
            const server = NodeNet.createServer();
            server.listen(port, "127.0.0.1", () => resume(Effect.succeed(server)));
          }),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => taken.forEach((server) => server.close())),
      );
      const { service } = yield* isolation({
        enabled: true,
        tools: [],
        platform: "win32",
        srtWin: { ready: true },
      });
      const status = yield* service.status;
      assert.strictEqual(status?.backend, null);
      assert.include(status?.detail, "the isolation proxy could not start: ports 60080-60089");
      assert.include(status?.detail, "excludedportrange");
    }),
  ),
);

it.effect("starts one srt-win holder for two launches of one key at once", () =>
  live(
    Effect.gen(function* () {
      let release = () => {};
      let started = () => {};
      const holdStarted = new Promise<void>((resolve) => (started = resolve));
      const firstHold = {
        started: () => started(),
        answer: new Promise<void>((resolve) => (release = resolve)),
      };
      const { claude, recorded, home, fs, path } = yield* isolation({
        enabled: true,
        tools: [],
        platform: "win32",
        srtWin: { ready: true },
        firstHold,
      });
      const claudeExe = path.join(home, ".local", "bin", "claude.exe");
      yield* fs.makeDirectory(path.dirname(claudeExe), { recursive: true });
      yield* fs.writeFileString(claudeExe, "");
      const first = yield* claude({ command: claudeExe, key: "k" }).pipe(Effect.forkChild);
      yield* Effect.promise(() => holdStarted);
      // The key's holder is still starting when its second launch comes.
      const second = yield* claude({ command: claudeExe, key: "k" }).pipe(Effect.forkChild);
      release();
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      assert.strictEqual(recorded.holders.length, 1);
      const pids = recorded.commands.filter((line) => line[2] === "grant").map((line) => line[4]);
      assert.deepEqual(pids, [String(recorded.holders[0]!.pid), String(recorded.holders[0]!.pid)]);
    }),
  ),
);

it.effect("notices srt-win removed while the server runs, and offers Set up again", () =>
  live(
    Effect.gen(function* () {
      const srtWin = { ready: true };
      const { service, recorded } = yield* isolation({
        enabled: true,
        tools: [],
        platform: "win32",
        srtWin,
      });
      assert.strictEqual((yield* service.status)?.backend, "srt");
      srtWin.ready = false;
      const changes = yield* service.subscribeChanges;
      const changed = yield* Stream.runHead(changes).pipe(Effect.forkChild);
      // The answer stands until it is looked at again in the background.
      yield* TestClock.adjust("6 minutes");
      assert.strictEqual((yield* service.status)?.backend, "srt");
      yield* Fiber.join(changed);
      const status = yield* service.status;
      assert.strictEqual(status?.backend, null);
      assert.isTrue(status?.canSetUp);
      assert.strictEqual(recorded.resets, 1);
    }),
  ),
);

it.effect("removes srt-win from the app, the way out of setting it up", () =>
  live(
    Effect.gen(function* () {
      const srtWin = { ready: true, uninstall: "cancel" as "ok" | "cancel" | "fail" };
      const { service, recorded, srtWinProgram } = yield* isolation({
        enabled: true,
        tools: [],
        platform: "win32",
        srtWin,
      });
      const before = yield* service.status;
      assert.isTrue(before?.canRemove);
      assert.strictEqual(yield* service.remove, "cancelled");
      assert.deepEqual(yield* service.status, before);
      srtWin.uninstall = "fail";
      assert.include((yield* Effect.flip(service.remove)).message, "access denied");
      srtWin.uninstall = "ok";
      assert.strictEqual(yield* service.remove, "done");
      assert.deepInclude(recorded.commands, [srtWinProgram, "uninstall"]);
      const after = yield* service.status;
      assert.strictEqual(after?.backend, null);
      assert.isTrue(after?.canSetUp);
      assert.isUndefined(after?.canRemove);
      assert.strictEqual(recorded.resets, 1);
    }),
  ),
);

it.effect("sets srt up on Windows from the app, and looks again at what runs", () =>
  live(
    Effect.gen(function* () {
      const srtWin = { ready: false, install: "cancel" as "ok" | "cancel" | "fail" };
      const { service, recorded, stateDir, fs, path } = yield* isolation({
        enabled: true,
        tools: [],
        platform: "win32",
        srtWin,
      });
      // The bridge prepared before runs threads meanwhile, and setting srt up is offered.
      yield* preparedWindows(fs, path, stateDir);
      const before = yield* service.status;
      assert.strictEqual(before?.backend, "srt");
      assert.isTrue(before?.canSetUp);
      // Nothing of srt-win's is there to remove while the bridge runs threads.
      assert.isUndefined(before?.canRemove);
      // Dismissing the administrator prompt changes nothing.
      assert.strictEqual(yield* service.setUp, "cancelled");
      assert.deepEqual(yield* service.status, before);
      srtWin.install = "fail";
      assert.include((yield* Effect.flip(service.setUp)).message, "srt-win install timed out");
      srtWin.install = "ok";
      assert.strictEqual(yield* service.setUp, "done");
      assert.strictEqual(recorded.installs, 3);
      const after = yield* service.status;
      assert.strictEqual(after?.backend, "srt");
      assert.isUndefined(after?.canSetUp);
      assert.strictEqual(recorded.initialized.length, 1);
    }),
  ),
);

it.effect("starts a third provider on Windows without isolation, marked, never refused", () =>
  live(
    Effect.gen(function* () {
      const { service, wrap, stateDir, fs, path } = yield* isolation({
        enabled: true,
        tools: [],
        platform: "win32",
      });
      yield* preparedWindows(fs, path, stateDir);
      assert.isUndefined(yield* wrap({ provider: "grok", command: "grok", key: "grok-1" }));
      const status = yield* service.status;
      assert.strictEqual(
        status?.srt.notIsolated.grok,
        "on Windows, srt runs only Claude and Codex threads",
      );
    }),
  ),
);

it.effect("runs srt on macOS with the Mac's own system folders, and no Docker there", () =>
  live(
    Effect.gen(function* () {
      const { service, wrap, recorded } = yield* isolation({
        enabled: true,
        tools: ["docker", "socat"],
        platform: "darwin",
      });
      const status = yield* service.status;
      assert.strictEqual(status?.backend, "srt");
      assert.include(status?.docker.unavailable, "which macOS does not have");
      const launch = yield* wrap();
      assert.strictEqual(launch?.backend, "srt");
      const read = paths(lastWrap(recorded).allowRead);
      assert.includeMembers(read, ["/System", "/Library", "/private/etc"]);
      assert.notInclude(read, "/lib64");
      // Docker's command is never asked on a Mac.
      assert.isFalse(recorded.commands.some(([command]) => command?.endsWith("docker")));
    }),
  ),
);

/** Threads' own isolation choices, keyed by the thread ids the harness launches. */
const byThread = (entries: Record<string, ThreadIsolationOverride>) =>
  entries as Record<ThreadId, ThreadIsolationOverride>;

/** Folders the owner names for isolated threads, outside any thread's own. */
const ownerFolders = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
  const shared = path.join(root, "shared");
  const reference = path.join(root, "reference");
  yield* fs.makeDirectory(shared);
  yield* fs.makeDirectory(reference);
  return {
    shared,
    reference,
    settings: {
      threadIsolationPolicy: {
        writableFolders: [shared],
        readableFolders: [reference],
        environment: ["EXTRA_TOKEN"],
      },
      // The second thread narrows the global choices; what it leaves out it takes from them.
      threadIsolationOverrides: byThread({ "thread-2": { writableFolders: [], environment: [] } }),
    },
  };
});

it.effect("holds and records a writable repository's git as the thread's own folder's", () =>
  live(
    Effect.gen(function* () {
      const { shared, settings } = yield* ownerFolders;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dotGit = path.join(shared, ".git");
      yield* fs.makeDirectory(dotGit);
      const { wrap, recorded } = yield* isolation({ enabled: true, tools: [], settings });
      assert.deepEqual(yield* isolatedGitConfig(shared), []);
      yield* wrap();
      const filesystem = lastWrap(recorded);
      assert.includeMembers(paths(filesystem.allowWrite), [shared, dotGit]);
      assert.includeMembers(
        paths(filesystem.denyWrite),
        ["config", "config.worktree", "commondir", "hooks", "info", "modules"].map((name) =>
          path.join(dotGit, name),
        ),
      );
      assert.deepInclude(yield* isolatedGitConfig(shared), ["core.fsmonitor", "false"]);
    }),
  ),
);

it.effect("leaves a worktree thread its own git folder when its main checkout is writable", () =>
  live(
    Effect.gen(function* () {
      const { wrap, recorded, settings, home, path } = yield* isolation({
        enabled: true,
        tools: [],
        git: "worktree",
      });
      const main = path.join(home, "main");
      yield* settings.updateSettings({ threadIsolationPolicy: { writableFolders: [main] } });
      yield* wrap();
      const denied = paths(lastWrap(recorded).denyWrite);
      const worktrees = path.join(main, ".git", "worktrees");
      assert.notInclude(denied, path.join(worktrees, "project"));
      assert.includeMembers(denied, [
        path.join(worktrees, "other"),
        path.join(main, ".git", "config"),
      ]);
    }),
  ),
);

it.effect("gives srt threads the owner's folders and variables, and a thread its own choice", () =>
  live(
    Effect.gen(function* () {
      const { shared, reference, settings } = yield* ownerFolders;
      const { wrap, recorded, bin } = yield* isolation({ enabled: true, tools: [], settings });
      const env = { PATH: bin, OPENAI_API_KEY: "o", GITHUB_TOKEN: "g", EXTRA_TOKEN: "x" };
      const first = yield* wrap({ env });
      const filesystem = lastWrap(recorded);
      assert.include(paths(filesystem.allowWrite), shared);
      assert.include(paths(filesystem.allowRead), reference);
      assert.notInclude(paths(filesystem.allowWrite), reference);
      assert.strictEqual(first?.env.EXTRA_TOKEN, "x");
      // A variable nobody named stays out, as before any policy.
      assert.isUndefined(first?.env.GITHUB_TOKEN);
      const second = yield* wrap({ env, key: "session-2", thread: "thread-2" });
      const narrowed = lastWrap(recorded);
      assert.notInclude(paths(narrowed.allowWrite), shared);
      assert.notInclude(paths(narrowed.allowRead), shared);
      assert.include(paths(narrowed.allowRead), reference);
      assert.isUndefined(second?.env.EXTRA_TOKEN);
    }),
  ),
);

it.effect("gives Docker threads the owner's folders as mounts and variables by name", () =>
  live(
    Effect.gen(function* () {
      const { shared, reference, settings } = yield* ownerFolders;
      const { wrap, bin } = yield* isolation({
        enabled: true,
        srtRuns: { ok: false },
        tools: ["docker", "socat"],
        settings,
      });
      const env = { PATH: bin, OPENAI_API_KEY: "o", GITHUB_TOKEN: "g", EXTRA_TOKEN: "x" };
      const first = yield* wrap({ env });
      assert.strictEqual(first?.backend, "docker");
      assert.include([...first!.args], `type=bind,src=${shared},dst=${shared}`);
      assert.include([...first!.args], `type=bind,src=${reference},dst=${reference},readonly`);
      assert.include(first?.args.join(" "), "--env EXTRA_TOKEN ");
      assert.strictEqual(first?.env.EXTRA_TOKEN, "x");
      assert.notInclude(first?.args.join(" "), "--env GITHUB_TOKEN");
      const second = yield* wrap({ env, key: "session-2", thread: "thread-2" });
      assert.notInclude(second?.args.join(" "), `src=${shared},`);
      assert.include([...second!.args], `type=bind,src=${reference},dst=${reference},readonly`);
      assert.notInclude(second?.args.join(" "), "--env EXTRA_TOKEN");
    }),
  ),
);

it.effect.each(["srt", "docker"] as const)(
  "tunnels each %s thread only as far as its network access",
  (backend) =>
    live(
      Effect.gen(function* () {
        const listen = () =>
          Effect.gen(function* () {
            const server = NodeNet.createServer((socket) => socket.end("hello"));
            yield* Effect.promise(
              () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
            );
            yield* Effect.addFinalizer(() => Effect.sync(() => server.close()));
            return `127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`;
          });
        // One stand-in for the provider (named by the launch), one for a host the owner lists.
        const providerAt = yield* listen();
        const listedAt = yield* listen();
        const { claude, bin, recorded, mcp, proxyPort, proxyIdOf } = yield* isolation({
          enabled: true,
          ...(backend === "docker"
            ? { srtRuns: { ok: false }, tools: ["docker", "socat"] }
            : { tools: [] }),
          settings: {
            threadIsolationPolicy: { hosts: [listedAt] },
            threadIsolationOverrides: byThread({
              "thread-2": { network: "provider" },
              "thread-3": { network: "any" },
            }),
          },
        });
        const env = { PATH: bin, ANTHROPIC_BASE_URL: `http://${providerAt}` };
        // srt's bridge reaches the proxy's port, a container its socket.
        let proxyAt: number | string = 0;
        const idOf = (thread: string) =>
          Effect.gen(function* () {
            const launch = yield* claude({ env, key: `session-${thread}`, thread });
            if (backend === "srt") {
              proxyAt = proxyPort();
              return proxyIdOf(recorded.wraps.at(-1)!.command);
            }
            const args = launch!.args;
            proxyAt = /src=([^,]+),dst=\/run\/t3code-proxy\.sock/.exec(args.join(" "))![1]!;
            return /HTTPS_PROXY=http:\/\/([^@]+)@/.exec(args.join(" "))![1]!;
          });
        const connect = (target: string, id: string) =>
          exchange(
            proxyAt,
            `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${basic(id)}\r\n\r\n`,
            "hello",
          );
        const listed = yield* idOf("thread-1");
        assert.match(yield* connect(listedAt, listed), /^HTTP\/1\.1 200[^]*hello/);
        assert.match(yield* connect(providerAt, listed), /^HTTP\/1\.1 200/);
        const provider = yield* idOf("thread-2");
        assert.match(yield* connect(providerAt, provider), /^HTTP\/1\.1 200[^]*hello/);
        assert.match(yield* connect(listedAt, provider), /^HTTP\/1\.1 403/);
        assert.match(yield* connect("github.com:443", provider), /^HTTP\/1\.1 403/);
        // Any host is every host but this machine, however its address is written.
        const any = yield* idOf("thread-3");
        const port = listedAt.split(":")[1]!;
        for (const target of [listedAt, `localhost:${port}`, `2130706433:${port}`, mcp!]) {
          assert.match(yield* connect(target, any), /^HTTP\/1\.1 403/, target);
        }
      }),
    ),
);

it("decides network access: the list, the provider alone, or every host but this machine", () => {
  const signIn = ["gateway.example:443"];
  const codexHosts = ["api.openai.com:443", "chatgpt.com:443", "auth.openai.com:443"];
  const policy = (network: "listed" | "provider" | "any") => ({
    backend: "automatic" as const,
    refuseUnisolated: false,
    network,
    hosts: ["extra.example:8443"],
    environment: [],
    writableFolders: [],
    readableFolders: [],
  });
  assert.includeMembers(reachableHosts(policy("listed"), codexHosts, signIn) as Array<string>, [
    ...ISOLATED_HOSTS,
    ...signIn,
    "extra.example:8443",
  ]);
  assert.deepEqual(reachableHosts(policy("provider"), codexHosts, signIn), [
    ...codexHosts,
    ...signIn,
  ]);
  assert.strictEqual(reachableHosts(policy("any"), codexHosts, []), "any");
  assert.isFalse(refusesTunnel("example.org:443", "any", "127.0.0.1:3773"));
  for (const target of [
    "127.0.0.1:443",
    "127.9.9.9:443",
    "0x7f.1:443",
    "[::1]:443",
    "[::ffff:127.0.0.1]:443",
    "0.0.0.0:443",
    "app.localhost:443",
    "not a host",
  ]) {
    assert.isTrue(refusesTunnel(target, "any", undefined), target);
  }
});

it.effect("refuses a name that resolves to this machine at the tunnel's own lookup", () =>
  Effect.promise(
    () =>
      new Promise<void>((resolve, reject) =>
        lookupElsewhere("localhost", { all: false }, (error) =>
          error?.message.includes("resolves to this machine") ? resolve() : reject(error),
        ),
      ),
  ),
);

it.effect(
  "refuses to start a thread under a policy it cannot apply, and names where to correct it",
  () =>
    live(
      Effect.gen(function* () {
        const { wrap, settings, stateDir, home, fs, path } = yield* isolation({
          enabled: true,
          tools: [],
          homeLink: true,
        });
        const thread = ThreadId.make("thread-1");
        const refusal = (policy: ThreadIsolationOverride, where: "thread" | "global" = "thread") =>
          Effect.gen(function* () {
            yield* settings.updateSettings(
              where === "thread"
                ? { threadIsolationOverrides: { [thread]: policy } }
                : { threadIsolationPolicy: policy, threadIsolationOverrides: { [thread]: null } },
            );
            const message = (yield* Effect.flip(wrap())).message;
            yield* settings.updateSettings({
              threadIsolationPolicy: { hosts: [], environment: [], writableFolders: [] },
              threadIsolationOverrides: { [thread]: null },
            });
            return message;
          });
        const inThread = "Correct it in this thread's Isolation choices, in its menu.";
        assert.include(
          yield* refusal({ hosts: ["github.com"] }),
          `host "github.com" is not written as host:port. ${inThread}`,
        );
        assert.include(
          yield* refusal({ hosts: ["github.com"] }, "global"),
          "host:port. Correct it in Settings.",
        );
        assert.include(
          yield* refusal({ environment: ["HOME"] }),
          "HOME is set by thread isolation itself",
        );
        assert.include(
          yield* refusal({ environment: ["HTTPS_PROXY"] }),
          "set by thread isolation itself",
        );
        assert.include(
          yield* refusal({ environment: ["A-B"] }),
          "not an environment variable name",
        );
        const missing = path.join(stateDir, "..", "missing");
        for (const folder of ["relative/folder", missing]) {
          assert.include(
            yield* refusal({ writableFolders: [folder] }),
            `the folder ${folder}: it must be an existing absolute path. ${inThread}`,
          );
        }
        // The home folder however it is named, and any folder holding it.
        for (const folder of [yield* fs.realPath(home), "/"]) {
          assert.include(
            yield* refusal({ readableFolders: [folder] }, "global"),
            `the folder ${folder}: it is your home folder or holds it. Correct it in Settings.`,
          );
        }
        // T3 Code's own data: settings, secrets and other threads' sign-ins.
        const isolationState = path.join(stateDir, "isolation");
        yield* fs.makeDirectory(isolationState, { recursive: true });
        for (const folder of [stateDir, isolationState, path.dirname(stateDir)]) {
          assert.include(
            yield* refusal({ writableFolders: [folder] }),
            `the folder ${folder}: it holds or lies in T3 Code's own data`,
          );
        }
      }),
    ),
);

it.effect(
  "refuses on Windows a policy its sandbox cannot apply, and keeps its launch otherwise",
  () =>
    live(
      Effect.gen(function* () {
        const { wrap, stateDir, fs, path } = yield* isolation({
          enabled: true,
          tools: [],
          platform: "win32",
          settings: {
            threadIsolationOverrides: byThread({
              "thread-2": { network: "any", environment: ["EXTRA_TOKEN"] },
              // Choices equal to the defaults leave the launch as it was.
              "thread-3": { network: "listed", hosts: [] },
            }),
          },
        });
        yield* preparedWindows(fs, path, stateDir);
        const refused = yield* Effect.flip(wrap({ key: "s2", thread: "thread-2" }));
        assert.include(refused.message, "cannot apply your network access, environment variables");
        assert.strictEqual((yield* wrap({ key: "s3", thread: "thread-3" }))?.backend, "windows");
      }),
    ),
);

/** Every local provider besides Claude and Codex, as its package starts it. */
const profiled: ReadonlyArray<{
  readonly provider: string;
  readonly command: string;
  /** Its own folder under home, from its profile. */
  readonly folder?: string;
  /** A variable naming its own folder instead. */
  readonly variable?: string;
}> = [
  { provider: "antigravity", command: "antigravity", variable: "GEMINI_HOME" },
  { provider: "grok", command: "grok", folder: ".grok" },
  { provider: "kiro", command: "kiro-cli", folder: ".kiro" },
  { provider: "fx", command: "fx", folder: ".fx" },
  { provider: "pi", command: "pi", folder: ".pi" },
  { provider: "muse", command: "muse" },
  { provider: "acpRegistry", command: "registry-agent" },
];

it.effect.each(
  (["srt", "docker"] as const).flatMap((backend) =>
    profiled.map((entry) => ({ backend, entry, name: `${entry.provider} under ${backend}` })),
  ),
)("isolates $name: its own folder, nothing else", ({ backend, entry }) =>
  live(
    Effect.gen(function* () {
      const { service, bin, tools, home, fs, path, recorded, stateDir } = yield* isolation({
        enabled: true,
        tools: [entry.command, ...(backend === "docker" ? ["docker", "socat"] : [])],
        ...(backend === "docker" ? { srtRuns: { ok: false } } : {}),
        environment: { GITHUB_TOKEN: "server's own" },
      });
      // The folder T3 Code's own code gives the provider, where it does: Antigravity's profile.
      const own = entry.variable
        ? (yield* resolveAntigravityInstanceDirectories(
            stateDir,
            ProviderInstanceId.make("antigravity"),
          ).pipe(Effect.provide(EffectNodeCrypto.layer))).profile
        : entry.folder
          ? path.join(home, entry.folder)
          : undefined;
      if (own !== undefined) yield* fs.makeDirectory(own, { recursive: true });
      const launch = yield* service.wrap({
        provider: entry.provider,
        command: entry.command,
        args: ["acp"],
        cwd: path.join(home, "project"),
        env: {
          PATH: bin,
          GITHUB_TOKEN: "server's own",
          PROVIDER_API_KEY: "set for this provider",
          ...(entry.variable ? { [entry.variable]: own } : {}),
        },
        key: `${entry.provider}-1`,
        thread: "thread-1",
      });
      assert.strictEqual(launch?.backend, backend);
      // Only what its launch set or the policy names reaches it: not the server's own.
      assert.isUndefined(launch?.env.GITHUB_TOKEN);
      assert.strictEqual(launch?.env.PROVIDER_API_KEY, "set for this provider");
      // A private home: the container's own for Docker, whose client keeps the server's.
      const privateHome =
        backend === "srt"
          ? launch?.env.HOME
          : launch?.args.find((arg) => arg.startsWith("HOME="))?.slice("HOME=".length);
      assert.isString(privateHome);
      assert.notStrictEqual(privateHome, home);
      const exposed =
        backend === "srt"
          ? {
              write: paths(lastWrap(recorded).allowWrite),
              read: paths(lastWrap(recorded).allowRead),
            }
          : {
              write: launch!.args.filter((arg) => !arg.endsWith(",readonly")),
              read: launch!.args,
            };
      const has = (list: ReadonlyArray<string>, folder: string) =>
        list.some((item) => item === folder || item.includes(`src=${folder},`));
      if (own !== undefined) assert.isTrue(has(exposed.write, own), "its folder is writable");
      assert.isFalse(has(exposed.read, home), "the home folder stays hidden");
      assert.isFalse(has(exposed.read, path.join(home, ".codex")));
      if (backend === "srt") {
        assert.include(
          recorded.wraps.at(-1)!.command,
          `'${path.join(tools, entry.command)}' 'acp'`,
        );
      } else {
        assert.deepEqual(launch!.args.slice(-2), [path.join(tools, entry.command), "acp"]);
      }
    }),
  ),
);

it.effect(
  "starts Cursor and OpenCode without isolation, which T3 Code does not spawn per thread",
  () =>
    live(
      Effect.gen(function* () {
        const { service, wrap } = yield* isolation({ enabled: true, tools: [] });
        assert.isUndefined(yield* wrap({ provider: "cursor", key: "c" }));
        assert.isUndefined(yield* wrap({ provider: "opencode", key: "o" }));
        const status = yield* service.status;
        assert.include(status?.srt.notIsolated.cursor, "inside T3 Code's own process");
        assert.include(status?.srt.notIsolated.opencode, "over the network");
      }),
    ),
);

it('names each provider\'s own hosts, all it reaches with network access "provider only"', () => {
  assert.includeMembers(PROVIDER_PROFILES.grok!.hosts as Array<string>, [
    "cli-chat-proxy.grok.com:443",
    "auth.x.ai:443",
  ]);
  assert.include(PROVIDER_PROFILES.antigravity!.hosts, "cloudcode-pa.googleapis.com:443");
  // Hosts its own code does not name are the owner's to list: none are guessed.
  for (const provider of ["kiro", "fx", "pi"]) {
    assert.deepEqual(PROVIDER_PROFILES[provider]!.hosts, []);
  }
});

it.effect('reaches a provider\'s configured host under "provider only", and no other', () =>
  live(
    Effect.gen(function* () {
      const gateway = NodeNet.createServer((socket) => socket.end("hello"));
      yield* Effect.promise(
        () => new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve)),
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => gateway.close()));
      const at = `127.0.0.1:${(gateway.address() as NodeNet.AddressInfo).port}`;
      const { service, bin, home, path, recorded, proxyPort, proxyIdOf } = yield* isolation({
        enabled: true,
        tools: ["grok"],
        settings: { threadIsolationPolicy: { network: "provider" } },
      });
      yield* service.wrap({
        provider: "grok",
        command: "grok",
        args: [],
        cwd: path.join(home, "project"),
        env: { PATH: bin, GROK_CLI_CHAT_PROXY_BASE_URL: `http://${at}/v1` },
        key: "grok-1",
        thread: "thread-1",
      });
      const id = proxyIdOf(recorded.wraps.at(-1)!.command);
      const connect = (target: string) =>
        exchange(
          proxyPort(),
          `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${basic(id)}\r\n\r\n`,
          "hello",
        );
      assert.match(yield* connect(at), /^HTTP\/1\.1 200[^]*hello/);
      assert.match(yield* connect("github.com:443"), /^HTTP\/1\.1 403/);
    }),
  ),
);

it.effect("marks a thread started without isolation until that launch is released", () =>
  live(
    Effect.gen(function* () {
      const { service, wrap } = yield* isolation({ enabled: true, tools: [] });
      const changes = yield* service.subscribeChanges;
      const changed = yield* Stream.runHead(changes).pipe(Effect.forkChild);
      assert.isUndefined(yield* wrap({ provider: "cursor", key: "cursor-1" }));
      yield* Fiber.join(changed);
      assert.include((yield* service.status)?.threads?.["thread-1"], "T3 Code's own process");
      yield* service.release("cursor-1");
      assert.isUndefined((yield* service.status)?.threads);
    }),
  ),
);

it.effect("marks or refuses a thread whose agent is a Windows command script", () =>
  live(
    Effect.gen(function* () {
      // As an ACP provider resolved to npx.cmd arrives: a shell's command line.
      const script = { provider: "acpRegistry", command: '"C:\\npm\\npx.cmd" agent', shell: true };
      const { service, wrap } = yield* isolation({ enabled: true, tools: [] });
      assert.isUndefined(yield* wrap(script));
      assert.include((yield* service.status)?.threads?.["thread-1"], "Windows command script");
      const strict = yield* isolation({
        enabled: true,
        tools: [],
        settings: { threadIsolationPolicy: { refuseUnisolated: true } },
      });
      assert.include((yield* Effect.flip(strict.wrap(script))).message, "Windows command script");
    }),
  ),
);

it.effect("never stops a thread over a policy it will not get, as it starts unisolated", () =>
  live(
    Effect.gen(function* () {
      const settings = { threadIsolationPolicy: { hosts: ["github.com"] } };
      const windows = yield* isolation({
        enabled: true,
        tools: [],
        platform: "win32",
        settings,
      });
      yield* preparedWindows(windows.fs, windows.path, windows.stateDir);
      assert.isUndefined(yield* windows.wrap({ provider: "grok", command: "grok", key: "g" }));
      const none = yield* isolation({ enabled: true, srt: false, tools: [], settings });
      assert.isUndefined(yield* none.wrap());
      // Where it would be isolated, the same policy stops it with the reason.
      const linux = yield* isolation({ enabled: true, tools: [], settings });
      assert.include((yield* Effect.flip(linux.wrap())).message, "not written as host:port");
    }),
  ),
);

it.effect(
  "gives a provider no folder its settings name that the owner's folders could not be",
  () =>
    live(
      Effect.gen(function* () {
        const { service, bin, home, stateDir, path } = yield* isolation({
          enabled: true,
          tools: ["grok"],
        });
        const launch = (value: string) =>
          service.wrap({
            provider: "grok",
            command: "grok",
            args: [],
            cwd: path.join(home, "project"),
            env: { PATH: bin, GROK_HOME: value },
            key: `grok-${value}`,
            thread: "thread-1",
          });
        for (const [value, reason] of [
          [home, "it is your home folder or holds it"],
          [stateDir, "it holds or lies in T3 Code's own data"],
          ["/usr", "it is a system folder"],
        ] as const) {
          assert.include(
            (yield* Effect.flip(launch(value))).message,
            `GROK_HOME (${value}): ${reason}`,
          );
        }
      }),
    ),
);

it("opens to Antigravity only the skill folders of ~/.gemini that T3 Code links in", () => {
  const posix = { join: (...parts: Array<string>) => parts.join("/") } as Path.Path;
  assert.deepEqual(
    PROVIDER_PROFILES.antigravity!.readHomeFolders,
    antigravityUserSkillDirectories(posix, ".gemini"),
  );
});

it.effect("says which providers' own folders or hosts T3 Code's code does not name", () =>
  live(
    Effect.gen(function* () {
      const { service } = yield* isolation({ enabled: true, tools: [] });
      const partly = (yield* service.status)?.partlyKnown;
      assert.strictEqual(partly?.muse, "folders and hosts");
      assert.strictEqual(partly?.acpRegistry, "folders and hosts");
      assert.strictEqual(partly?.kiro, "hosts");
      assert.isUndefined(partly?.grok);
      assert.isUndefined(partly?.claudeAgent);
    }),
  ),
);

/** Each way a thread cannot be sandboxed, as the harness sets it up. */
const notIsolatedCauses: ReadonlyArray<{
  readonly name: string;
  readonly reason: string;
  readonly harness: Omit<Parameters<typeof isolation>[0], "enabled" | "settings">;
  readonly backend?: "docker";
  readonly input?: Partial<WrapInput>;
  /** A driver that starts no process: decided when its session is admitted, never in wrap. */
  readonly admitted?: ProviderDriverKind;
  readonly prepare?: (harness: Effect.Success<ReturnType<typeof isolation>>) => Effect.Effect<void>;
}> = [
  {
    name: "Cursor",
    reason: "inside T3 Code's own process",
    harness: { tools: [] },
    admitted: cursor,
  },
  {
    name: "OpenCode",
    reason: "over the network",
    harness: { tools: [] },
    admitted: ProviderDriverKind.make("opencode"),
  },
  {
    name: "Cursor with no sandbox here",
    reason: "neither srt nor Docker can be used here",
    harness: { tools: [], srt: false },
    admitted: cursor,
  },
  {
    name: "no sandbox here",
    reason: "neither srt nor Docker can be used here",
    harness: { tools: [], srt: false },
  },
  {
    name: "the chosen sandbox missing",
    reason: "Docker cannot be used here",
    harness: { tools: [] },
    backend: "docker",
  },
  {
    name: "a third provider on Windows",
    reason: "on Windows, srt runs only Claude and Codex threads",
    harness: { tools: [], platform: "win32" },
    input: { provider: "grok", command: "grok" },
    prepare: (harness) =>
      preparedWindows(harness.fs, harness.path, harness.stateDir).pipe(Effect.orDie),
  },
  {
    name: "Docker on a folder without Git",
    reason: "needs the thread's folder to be a Git repository",
    harness: { tools: ["docker", "socat"], srt: false, git: "none" },
  },
  {
    name: "Codex's custom model providers",
    reason: "Codex's custom model providers",
    harness: { tools: [] },
    prepare: (harness) =>
      harness.fs
        .writeFileString(
          harness.path.join(harness.realCodex, "config.toml"),
          '[model_providers.azure]\nbase_url = "https://x"\n',
        )
        .pipe(Effect.orDie),
  },
];

it.effect.each(
  notIsolatedCauses.flatMap((cause) =>
    [false, true].map((refuse) => ({ ...cause, refuse, label: `${cause.name}, refuse ${refuse}` })),
  ),
)("starts unsandboxed, marked, or refuses as set: $label", (cause) =>
  live(
    Effect.gen(function* () {
      const harness = yield* isolation({
        enabled: true,
        ...cause.harness,
        settings: {
          threadIsolationPolicy: {
            refuseUnisolated: cause.refuse,
            ...(cause.backend ? { backend: cause.backend } : {}),
          },
        },
      });
      if (cause.prepare) yield* cause.prepare(harness);
      const launch =
        cause.admitted === undefined
          ? harness.wrap({ key: "cause", ...cause.input })
          : harness.service
              .check({ driver: cause.admitted, thread: "thread-1", key: "cause" })
              .pipe(Effect.as(undefined));
      if (cause.refuse) {
        const refused = (yield* Effect.flip(launch)).message;
        assert.include(refused, cause.reason);
        assert.include(refused, "Choose another sandbox");
        assert.include(refused, '"Threads that cannot be sandboxed"');
        assert.isUndefined((yield* harness.service.status)?.threads);
      } else {
        assert.isUndefined(yield* launch);
        assert.include((yield* harness.service.status)?.threads?.["thread-1"], cause.reason);
        yield* harness.service.release("cause");
        assert.isUndefined((yield* harness.service.status)?.threads);
      }
    }),
  ),
);

it("refuses a provider folder that is the same file as home, data or the system's, however named", () => {
  // Chains name each folder by its file, nearest first: on a case-insensitive mount /Users/Me
  // and /users/me are one file, and /etc on a Mac is the file /private/etc is.
  const home = ["home", "users", "root"];
  const data = [["t3", "home", "users", "root"]];
  const system = [["etc", "root"]];
  const refusal = (folder: Array<string>) => folderRefusalReason({ folder, home, data, system });
  assert.strictEqual(refusal(["home", "users", "root"]), "it is your home folder or holds it");
  assert.strictEqual(refusal(["users", "root"]), "it is your home folder or holds it");
  assert.strictEqual(
    refusal(["userdata", "t3", "home", "users", "root"]),
    "it holds or lies in T3 Code's own data",
  );
  assert.strictEqual(refusal(["x", "etc", "root"]), "it is a system folder");
  assert.isUndefined(refusal(["grok", "work", "home", "users", "root"]));
});

it.effect("refuses a folder named ..x inside T3 Code's data as lying in it", () =>
  live(
    Effect.gen(function* () {
      const { wrap, fs, path, stateDir, settings } = yield* isolation({ enabled: true, tools: [] });
      const dotted = path.join(stateDir, "..x");
      yield* fs.makeDirectory(dotted, { recursive: true });
      yield* settings.updateSettings({ threadIsolationPolicy: { readableFolders: [dotted] } });
      assert.include((yield* Effect.flip(wrap())).message, "holds or lies in T3 Code's own data");
    }),
  ),
);

it.effect(
  "starts a run outside any thread as before, even when unsandboxed threads are refused",
  () =>
    live(
      Effect.gen(function* () {
        const { wrap } = yield* isolation({
          enabled: true,
          srt: false,
          tools: [],
          settings: { threadIsolationPolicy: { refuseUnisolated: true } },
        });
        assert.isUndefined(yield* wrap({ key: "codex-text:1", thread: undefined }));
        assert.include((yield* Effect.flip(wrap())).message, "cannot sandbox this thread");
      }),
    ),
);

it.effect("marks only threads with a launch running unsandboxed while the setting is on", () =>
  live(
    Effect.gen(function* () {
      const { service, wrap, settings } = yield* isolation({
        enabled: true,
        tools: [],
        settings: { threadIsolationOverrides: byThread({ "thread-2": { hosts: ["bad"] } }) },
      });
      const marked = Effect.map(service.status, (status) => Object.keys(status?.threads ?? {}));
      const cursor = (thread: string, key: string) => wrap({ provider: "cursor", thread, key });
      yield* cursor("thread-1", "c1");
      yield* cursor("thread-3", "c3");
      assert.deepEqual(yield* marked, ["thread-1", "thread-3"]);
      // Its session released: the thread is no longer running unsandboxed.
      yield* service.release("c1");
      assert.deepEqual(yield* marked, ["thread-3"]);
      // A launch that fails on its policy is not one without isolation, nor clears another's.
      assert.include((yield* Effect.flip(wrap({ thread: "thread-2", key: "x2" }))).message, "bad");
      assert.deepEqual(yield* marked, ["thread-3"]);
      yield* cursor("thread-2", "c2");
      yield* Effect.flip(wrap({ thread: "thread-2", key: "x2" }));
      assert.deepEqual(yield* marked, ["thread-3", "thread-2"]);
      // Off, nothing is marked, and on again nothing stale comes back.
      yield* settings.updateSettings({ threadIsolation: false });
      assert.isUndefined(yield* service.status);
      assert.isUndefined(yield* wrap({ provider: "cursor", thread: "thread-4", key: "c4" }));
      yield* settings.updateSettings({ threadIsolation: true });
      assert.deepEqual(yield* marked, []);
    }),
  ),
);

it.effect(
  "keeps a thread marked while any of its launches runs unsandboxed, clearing by launch",
  () =>
    live(
      Effect.gen(function* () {
        const { service, wrap } = yield* isolation({
          enabled: true,
          tools: [],
          settings: { threadIsolationOverrides: byThread({ "thread-1": { hosts: [] } }) },
        });
        const threads = Effect.map(service.status, (status) => status?.threads ?? {});
        const published: Array<void> = [];
        const changes = yield* service.subscribeChanges;
        yield* Stream.runForEach(changes, (change) =>
          Effect.sync(() => published.push(change)),
        ).pipe(Effect.forkChild);
        // An unsandboxed launch, then another of the same thread that comes up sandboxed.
        assert.isUndefined(yield* wrap({ provider: "cursor", key: "k1" }));
        assert.isUndefined(yield* wrap({ provider: "cursor", key: "k1" }));
        assert.strictEqual((yield* wrap({ key: "k2" }))?.backend, "srt");
        assert.include((yield* threads)["thread-1"], "T3 Code's own process");
        // A launch of the thread that fails clears only itself.
        yield* Effect.flip(wrap({ key: "k3", command: "missing-cli" }));
        assert.include((yield* threads)["thread-1"], "T3 Code's own process");
        yield* service.release("k2");
        assert.include((yield* threads)["thread-1"], "T3 Code's own process");
        yield* service.release("k1");
        assert.deepEqual(yield* threads, {});
        // A wrap arriving after its key's release marks nothing.
        assert.isUndefined(yield* wrap({ provider: "cursor", key: "k1" }));
        assert.deepEqual(yield* threads, {});
        yield* Effect.yieldNow;
        // Published when the marked set changed only: on, then off.
        assert.strictEqual(published.length, 2);
      }),
    ),
);

it.effect("refuses a folder above T3 Code's data where its data folder is a link", () =>
  live(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      // T3 Code's data folder is a link into another disk's folder.
      const disk = path.join(root, "mnt", "data");
      yield* fs.makeDirectory(path.join(disk, "t3"), { recursive: true });
      yield* fs.symlink(path.join(disk, "t3"), path.join(root, "t3-link"));
      const { wrap } = yield* isolation({
        enabled: true,
        tools: [],
        baseDir: path.join(root, "t3-link"),
        settings: { threadIsolationPolicy: { readableFolders: [disk] } },
      });
      assert.include((yield* Effect.flip(wrap())).message, "holds or lies in T3 Code's own data");
    }),
  ),
);

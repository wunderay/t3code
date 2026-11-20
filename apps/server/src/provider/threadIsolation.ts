// @effect-diagnostics nodeBuiltinImport:off -- The Docker proxy is a raw CONNECT server on a Unix socket; credential copies need O_NOFOLLOW reads; srt-win's grants need a holder's pid.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeDns from "node:dns";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodeSea from "node:sea";
import * as NodeURL from "node:url";

import type { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import {
  type ProviderDriverKind,
  type ThreadIsolationBackendChoice,
  type ThreadIsolationOverride,
  type ThreadIsolationPolicy,
  type ThreadIsolationStatus,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpServer } from "effect/http";

import * as ServerConfig from "../config.ts";
import { localMcpAuthority } from "../mcp/localMcpAuthority.ts";
import * as ProcessRunner from "../processRunner.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  npmNodeShimScript,
  resolveWindowsSandboxLaunch,
  SRT_WIN_PROXY_PORTS,
  NODE_KEEPS_PATHS,
  SRT_WIN_LAUNCH_COMMAND,
  SRT_WIN_LAUNCHER,
  srtWinEnvironment,
  srtWinLaunch,
  unpackedPath,
  windowsSandboxProblem,
} from "./windowsSandbox.ts";
import { addIsolatedFolder, setIsolationActive } from "../vcs/isolatedFolders.ts";

/**
 * The hosts an agent needs (its provider, GitHub, PyPI, npm), plus the hosts Claude uses
 * to refresh its sign-in and read feature flags. Port 443 only, on both backends.
 */
export const ISOLATED_HOSTS = [
  "api.anthropic.com",
  "claude.ai",
  "platform.claude.com",
  "api.openai.com",
  "chatgpt.com",
  "auth.openai.com",
  "github.com",
  "api.github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
  "codeload.github.com",
  "pypi.org",
  "files.pythonhosted.org",
  "registry.npmjs.org",
  "console.anthropic.com",
  "statsig.anthropic.com",
].map((host) => `${host}:443`);

/** Each provider's own hosts: all a thread reaches when its network is "provider". */
const PROVIDER_HOSTS: Readonly<Record<IsolatedProvider, ReadonlyArray<string>>> = {
  claude: [
    "api.anthropic.com",
    "claude.ai",
    "platform.claude.com",
    "console.anthropic.com",
    "statsig.anthropic.com",
  ].map((host) => `${host}:443`),
  codex: ["api.openai.com", "chatgpt.com", "auth.openai.com"].map((host) => `${host}:443`),
};

const DEFAULT_POLICY: ThreadIsolationPolicy = {
  backend: "automatic",
  refuseUnisolated: false,
  network: "listed",
  hosts: [],
  environment: [],
  writableFolders: [],
  readableFolders: [],
};

/** A thread's policy: the global one, with whatever its own choices replace. */
function effectivePolicy(
  settings:
    | {
        readonly threadIsolationPolicy: ThreadIsolationPolicy;
        readonly threadIsolationOverrides: Readonly<Record<string, ThreadIsolationOverride>>;
      }
    | undefined,
  thread: string | undefined,
): { readonly policy: ThreadIsolationPolicy; readonly own: ThreadIsolationOverride | undefined } {
  if (settings === undefined) return { policy: DEFAULT_POLICY, own: undefined };
  const own = thread === undefined ? undefined : settings.threadIsolationOverrides[thread];
  return { policy: { ...settings.threadIsolationPolicy, ...own }, own };
}

/** The dimensions of a policy that differ from thread isolation's defaults. */
function changedDimensions(policy: ThreadIsolationPolicy): ReadonlyArray<string> {
  return [
    ...(policy.network !== "listed" ? ["network access"] : []),
    ...(policy.hosts.length > 0 ? ["allowed hosts"] : []),
    ...(policy.environment.length > 0 ? ["environment variables"] : []),
    ...(policy.writableFolders.length > 0 ? ["writable folders"] : []),
    ...(policy.readableFolders.length > 0 ? ["readable folders"] : []),
  ];
}

/** What a launch may reach: a list of `host:port`, or every host but this server. */
export function reachableHosts(
  policy: ThreadIsolationPolicy,
  providerHosts: ReadonlyArray<string>,
  signInHosts: ReadonlyArray<string>,
): ReadonlyArray<string> | "any" {
  switch (policy.network) {
    case "any":
      return "any";
    case "provider":
      return [...new Set([...providerHosts, ...signInHosts])];
    case "listed":
      return [...new Set([...ISOLATED_HOSTS, ...providerHosts, ...signInHosts, ...policy.hosts])];
  }
}

/** Why a policy cannot be applied as written, if it cannot. */
type PolicyField = keyof ThreadIsolationPolicy;

/** Why a policy cannot be applied as written, if it cannot, and which of its fields says so. */
function policyProblem(
  policy: ThreadIsolationPolicy,
): { readonly field: PolicyField; readonly detail: string } | undefined {
  const host = policy.hosts.find(
    (entry) => !/^[A-Za-z0-9.-]+:\d{1,5}$|^\[[0-9A-Fa-f:]+\]:\d{1,5}$/.test(entry),
  );
  if (host !== undefined) {
    return { field: "hosts", detail: `the allowed host "${host}" is not written as host:port` };
  }
  const name = policy.environment.find((entry) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry));
  if (name !== undefined) {
    return { field: "environment", detail: `"${name}" is not an environment variable name` };
  }
  const fixed = policy.environment.find((entry) => LAUNCH_VARIABLES.has(entry));
  if (fixed !== undefined) {
    return { field: "environment", detail: `${fixed} is set by thread isolation itself` };
  }
  return undefined;
}

/** Host folders holding the toolchain agents run; no user data. */
const SYSTEM_FOLDERS = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32"];
/** The parts of /etc a CLI, TLS, DNS and git need. */
const SYSTEM_FILES = [
  "/etc/ssl",
  "/etc/ca-certificates",
  "/etc/pki",
  "/etc/alternatives",
  "/etc/ld.so.cache",
  "/etc/ld.so.conf",
  "/etc/ld.so.conf.d",
  "/etc/localtime",
  "/etc/nsswitch.conf",
  "/etc/passwd",
  "/etc/group",
  "/etc/gitconfig",
  "/etc/resolv.conf",
  "/etc/hosts",
  // Managed policy and configuration for the providers.
  "/etc/claude-code",
  "/etc/codex",
];
// Docker writes these itself.
const DOCKER_OWNED_FILES = new Set(["/etc/resolv.conf", "/etc/hosts"]);

export type IsolatedProvider = "claude" | "codex";

/** Claude and Codex have their own sign-in handling; every other provider has a profile. */
const ownProvider = (provider: string): IsolatedProvider | undefined =>
  provider === "claude" || provider === "claudeAgent"
    ? "claude"
    : provider === "codex"
      ? "codex"
      : undefined;

/**
 * What a provider other than Claude and Codex needs in its sandbox, as T3 Code's own code for it
 * names it. Its folders hold its sign-in and settings and are writable, so it signs in and
 * refreshes as usual; the rest of the home folder stays hidden. A provider without a profile
 * (an ACP registry agent) gets the folder and network its thread's policy gives.
 */
export interface ProviderProfile {
  /** Its own folders under the home folder. */
  readonly homeFolders: ReadonlyArray<string>;
  /** Variables naming a folder or file of its own, set in the owner's provider settings. */
  readonly pathVariables: ReadonlyArray<string>;
  /**
   * Variables T3 Code's own code sets to a folder it creates for the provider, whatever the
   * settings say; not the owner's input, so not held to the owner's folder rules.
   */
  readonly assignedVariables: ReadonlyArray<string>;
  /** Folders under the home folder it reads but does not own. */
  readonly readHomeFolders: ReadonlyArray<string>;
  /** Its hosts: all it reaches, with its sign-in's, when network access is "provider only". */
  readonly hosts: ReadonlyArray<string>;
  /** Variables whose URL names another host it reaches. */
  readonly urlVariables: ReadonlyArray<string>;
}

const profile = (entry: Partial<ProviderProfile>): ProviderProfile => ({
  homeFolders: [],
  pathVariables: [],
  assignedVariables: [],
  readHomeFolders: [],
  urlVariables: [],
  ...entry,
  hosts: (entry.hosts ?? []).map((host) => `${host}:443`),
});

export const PROVIDER_PROFILES: Readonly<Record<string, ProviderProfile>> = {
  // T3 Code gives Antigravity a private GEMINI_HOME, linking in only the skill folders of
  // ~/.gemini (antigravityUserSkillDirectories); the rest of it, the Gemini CLI's sign-in
  // included, stays hidden.
  antigravity: profile({
    // antigravityEnvironment sets GEMINI_HOME to its profile folder under T3 Code's state.
    assignedVariables: ["GEMINI_HOME"],
    readHomeFolders: [".gemini/config/skills", ".gemini/antigravity-cli/skills"],
    hosts: [
      "cloudcode-pa.googleapis.com",
      "daily-cloudcode-pa.googleapis.com",
      "oauth2.googleapis.com",
      "accounts.google.com",
      "www.googleapis.com",
    ],
  }),
  grok: profile({
    homeFolders: [".grok"],
    pathVariables: ["GROK_HOME", "GROK_CONFIG_PATH"],
    hosts: ["cli-chat-proxy.grok.com", "auth.x.ai", "accounts.x.ai"],
    urlVariables: ["GROK_CLI_CHAT_PROXY_BASE_URL", "GROK_MODELS_BASE_URL"],
  }),
  kiro: profile({ homeFolders: [".kiro"] }),
  fx: profile({ homeFolders: [".fx"] }),
  pi: profile({
    homeFolders: [".pi"],
    pathVariables: ["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"],
  }),
};
const GENERIC_PROFILE = profile({});

/** Providers T3 Code does not start as a process of their own for a thread. */
const NOT_SPAWNED: Readonly<Record<string, string>> = {
  cursor: "it runs inside T3 Code's own process, which a sandbox cannot hold",
  opencode: "T3 Code reaches its server over the network, which a sandbox closes",
};

/** Every provider T3 Code runs locally, for the status each backend reports. */
const LOCAL_DRIVERS = [
  "claudeAgent",
  "codex",
  ...Object.keys(PROVIDER_PROFILES),
  "muse",
  "acpRegistry",
  ...Object.keys(NOT_SPAWNED),
];

export type SandboxRuntime = Pick<
  typeof SandboxManager,
  | "isSupportedPlatform"
  | "checkDependencies"
  | "initialize"
  | "reset"
  | "getLinuxHttpSocketPath"
  | "getLinuxSocksSocketPath"
  | "wrapWithSandboxArgv"
  | "cleanupAfterCommand"
>;

/**
 * How long a backend choice and Docker's image check stand before they are made again in the
 * background, so a backend that appears or goes away (Docker started, bwrap installed) is
 * noticed without a launch waiting for it. A dead srt is found at each launch instead.
 */
const RECHECK_MILLIS = 5 * 60 * 1000;

const TURN_OFF = "or turn off Thread isolation in Settings → Providers → Advanced";

export class ThreadIsolationError extends Schema.TaggedError<ThreadIsolationError>()(
  "ThreadIsolationError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

/** A launch this provider, machine or folder cannot isolate: it starts as without isolation. */
class NotIsolated extends Schema.TaggedError<NotIsolated>()("NotIsolated", {
  reason: Schema.String,
}) {}

// A single-executable resolves file-backed packages only through createRequire, not import().
const requireSandboxRuntime = NodeModule.createRequire(import.meta.url);

const attempt = <A>(detail: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: () => new ThreadIsolationError({ detail }) });
/** As `attempt`, with what went wrong after the detail. */
const attemptSaying = <A>(detail: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new ThreadIsolationError({
        detail: `${detail}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });

export const WINDOWS_FENCE_INACTIVE =
  "srt-win's network fence is not active: press Set up to restore it (Windows asks once for an administrator's approval)";
export const WINDOWS_NOT_SET_UP =
  "srt is not set up on this machine yet: press Set up (Windows asks once for an administrator's approval)";

/** srt's Windows calls that only Windows can run; tests stand in for them. */
export interface WindowsSandboxRuntime {
  /** The srt-win program T3 Code ships. */
  readonly program: string;
  /** What runs the launcher inside the sandbox: this server's Node, Electron as Node, or the
   * Windows CLI's single executable, which has a command for it. */
  readonly node: ReadonlyArray<string>;
  /** Why srt-win cannot sandbox here, if it cannot: usually that it is not set up. */
  readonly problem: () => Promise<string | undefined>;
  /** The one-time machine setup: the sandbox account and its network fence. */
  readonly install: () => Promise<{ readonly cancelled: boolean }>;
  /** The sandbox account's SID, which srt-win's grants name. */
  readonly account: () => Promise<string | undefined>;
  /** A process whose life one launch's grants follow: srt-win drops them once it is gone. */
  readonly hold: () => Promise<{ readonly pid: number; readonly release: () => void }>;
}

/** Where the sandbox runtime comes from; tests stand in for it. */
export const SandboxRuntimeSource = Context.Reference<
  Effect.Effect<
    {
      readonly manager: SandboxRuntime;
      readonly packageRoot: string;
      readonly windows: WindowsSandboxRuntime;
    },
    ThreadIsolationError
  >
>("@t3tools/server/ThreadIsolation/SandboxRuntimeSource", {
  defaultValue: () =>
    attempt(
      "the sandbox runtime could not be loaded",
      async () =>
        requireSandboxRuntime(
          "@anthropic-ai/sandbox-runtime",
        ) as typeof import("@anthropic-ai/sandbox-runtime"),
    ).pipe(
      Effect.map((module) => {
        const program = unpackedPath(module.VENDORED_SRT_WIN_EXE);
        const srtWin = () => module.resolveSrtWin({ path: program });
        return {
          manager: module.SandboxManager,
          packageRoot: NodeURL.fileURLToPath(
            new URL(
              "..",
              NodeURL.pathToFileURL(requireSandboxRuntime.resolve("@anthropic-ai/sandbox-runtime")),
            ),
          ),
          windows: {
            program,
            node: NodeSea.isSea()
              ? [process.execPath, SRT_WIN_LAUNCH_COMMAND]
              : [process.execPath, ...NODE_KEEPS_PATHS],
            problem: async () => {
              const { errors } = await module.checkWindowsDependenciesAsync({ srtWin: srtWin() });
              return errors.length === 0 ? undefined : WINDOWS_NOT_SET_UP;
            },
            install: async () => ({
              cancelled:
                (await module.installWindowsSandboxAsync({ srtWin: srtWin() })).cancelled === true,
            }),
            account: async () =>
              (await module.getWindowsSandboxUserStatusAsync({ srtWin: srtWin() })).sid,
            // cmd waits on its input and ends when the server's end of it closes. Named in
            // full, as a name alone is looked for in the server's folder first.
            hold: () =>
              new Promise((resolve, reject) => {
                const cmd = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\cmd.exe`;
                const child = NodeChildProcess.spawn(cmd, ["/d", "/q", "/k"], {
                  stdio: ["pipe", "ignore", "ignore"],
                  windowsHide: true,
                });
                child.once("error", reject);
                child.once("spawn", () =>
                  resolve({
                    pid: child.pid!,
                    release: () => {
                      child.stdin?.end();
                      child.kill();
                    },
                  }),
                );
              }),
          },
        };
      }),
    ),
});

export type BackendState =
  | {
      readonly ok: true;
      readonly command?: string | undefined;
      /** On Windows: srt-win is not set up, and the bridge prepared before runs threads instead. */
      readonly bridge?: true;
    }
  | { readonly ok: false; readonly reason: string };

/** Whether each backend can run on this machine: srt (on Windows, srt-win or the bridge) and Docker. */
export interface Backends {
  readonly srt: BackendState;
  readonly docker: BackendState;
  /** On Windows: srt-win is not set up, which setting it up from the app fixes. */
  readonly canSetUp?: true;
  /** On Windows: srt-win is set up, working or not, and removing it from the app is the way out. */
  readonly canRemove?: true;
}

export type Detection =
  | { readonly backend: "srt" }
  | { readonly backend: "docker"; readonly command: string; readonly srtReason?: string }
  | { readonly backend: "windows" }
  | { readonly backend: null; readonly reason: string };

const OS_NAMES: Readonly<Partial<Record<NodeJS.Platform, string>>> = {
  darwin: "macOS",
  win32: "Windows",
};

/** What each backend can do here, from what was found on this machine. */
export function probeBackends(probe: {
  readonly platform: NodeJS.Platform;
  /** On Windows: why the bridge prepared before srt-win cannot run here, if it cannot. */
  readonly windowsProblem?: string | undefined;
  /** On Windows: srt-win's own check found it set up, even if starting it then failed. */
  readonly srtWinInstalled?: boolean;
  /** Why the sandbox runtime cannot isolate a command here, if it cannot. */
  readonly srtReason: string | undefined;
  readonly docker: string | null;
  readonly dockerRunning: boolean;
  /** `docker info` ran out of time, which is not the same as Docker being down. */
  readonly dockerTimedOut?: boolean;
  /** Docker threads reach the proxy through socat on the host. */
  readonly socat: boolean;
}): Backends {
  const os = OS_NAMES[probe.platform] ?? probe.platform;
  const srt: BackendState =
    probe.srtReason === undefined
      ? { ok: true }
      : probe.platform === "win32" && probe.windowsProblem === undefined
        ? { ok: true, bridge: true }
        : { ok: false, reason: probe.srtReason };
  // The container runs the provider from this machine's own system folders, mounted read-only.
  const dockerReason =
    probe.platform !== "linux"
      ? `Docker isolation runs the provider with this machine's own Linux system folders, which ${os} does not have`
      : probe.docker === null
        ? "Docker is not installed"
        : probe.dockerTimedOut
          ? "Docker did not answer in time"
          : !probe.dockerRunning
            ? "Docker is not running"
            : probe.socat
              ? undefined
              : "Docker isolation needs socat, which is not installed";
  const docker: BackendState =
    dockerReason === undefined && probe.docker !== null
      ? { ok: true, command: probe.docker }
      : { ok: false, reason: dockerReason ?? "Docker is not installed" };
  return {
    srt,
    docker,
    // Setting srt-win up fixes its absence or a lost fence, and nothing else that can go wrong.
    ...(probe.platform === "win32" &&
    (probe.srtReason === WINDOWS_NOT_SET_UP || probe.srtReason === WINDOWS_FENCE_INACTIVE)
      ? { canSetUp: true }
      : {}),
    ...(probe.platform === "win32" && probe.srtWinInstalled ? { canRemove: true } : {}),
  };
}

/**
 * The backend a launch uses: automatic takes srt, then Docker where srt cannot run; a named
 * backend is used exactly, or none is and the thread starts without isolation.
 */
export function chooseBackend(
  backends: Backends,
  platform: NodeJS.Platform,
  choice: ThreadIsolationBackendChoice,
): Detection {
  const { srt: srtState, docker } = backends;
  if (choice !== "docker" && srtState.ok) {
    return srtState.bridge ? { backend: "windows" } : { backend: "srt" };
  }
  if (choice !== "srt" && docker.ok) {
    return {
      backend: "docker",
      command: docker.command ?? "docker",
      ...(srtState.ok ? {} : { srtReason: srtState.reason }),
    };
  }
  const reasonOf = (state: BackendState) => (state.ok ? "" : state.reason);
  if (choice === "srt") {
    return { backend: null, reason: `srt cannot be used here: ${reasonOf(srtState)}` };
  }
  if (choice === "docker") {
    return { backend: null, reason: `Docker cannot be used here: ${reasonOf(docker)}` };
  }
  return {
    backend: null,
    reason: `neither srt nor Docker can be used here: ${reasonOf(srtState)}, and ${reasonOf(docker)}`,
  };
}

/** Why a provider starts without isolation under this backend here, if it does. */
function notIsolatedReason(
  driver: string,
  backend: "srt" | "docker",
  platform: NodeJS.Platform,
): string | undefined {
  const notSpawned = NOT_SPAWNED[driver];
  if (notSpawned !== undefined) return notSpawned;
  if (backend === "srt" && platform === "win32" && ownProvider(driver) === undefined) {
    return "on Windows, srt runs only Claude and Codex threads";
  }
  return undefined;
}

export function statusOf(
  backends: Backends,
  platform: NodeJS.Platform,
  choice: ThreadIsolationBackendChoice,
): ThreadIsolationStatus {
  const detection = chooseBackend(backends, platform, choice);
  const of = (backend: "srt" | "docker") => {
    const state = backends[backend];
    return {
      ...(state.ok ? {} : { unavailable: state.reason }),
      notIsolated: Object.fromEntries(
        LOCAL_DRIVERS.flatMap((driver) => {
          const reason = notIsolatedReason(driver, backend, platform);
          return reason === undefined ? [] : [[driver, reason]];
        }),
      ),
    };
  };
  return {
    backend: detection.backend === null ? null : detection.backend === "docker" ? "docker" : "srt",
    detail:
      detection.backend === null
        ? detection.reason
        : detection.backend === "docker"
          ? (detection.srtReason ?? "")
          : "",
    srt: of("srt"),
    docker: of("docker"),
    ...(backends.canSetUp ? { canSetUp: true } : {}),
    ...(backends.canRemove ? { canRemove: true } : {}),
    partlyKnown: Object.fromEntries(
      LOCAL_DRIVERS.flatMap((driver) => {
        if (ownProvider(driver) !== undefined || NOT_SPAWNED[driver] !== undefined) return [];
        const known = PROVIDER_PROFILES[driver] ?? GENERIC_PROFILE;
        const missing = [
          ...(known.homeFolders.length +
            known.pathVariables.length +
            known.assignedVariables.length ===
          0
            ? ["folders"]
            : []),
          ...(known.hosts.length + known.urlVariables.length === 0 ? ["hosts"] : []),
        ];
        return missing.length === 0 ? [] : [[driver, missing.join(" and ")]];
      }),
    ),
  };
}

const SHARED_VARIABLES = [
  "PATH",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_COLLATE",
  "LC_MESSAGES",
  "LC_NUMERIC",
  "LC_TIME",
  "TERM",
  "COLORTERM",
  "TZ",
  "USER",
  "LOGNAME",
  "NO_COLOR",
  "FORCE_COLOR",
  "DO_NOT_TRACK",
  "T3CODE_THREAD_ID",
  "T3CODE_PORT_DISCOVERY",
];
const PROVIDER_VARIABLES: Readonly<Record<IsolatedProvider, ReadonlyArray<string>>> = {
  claude: [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_AGENT_SDK_VERSION",
    "CLAUDE_CODE_PROMPT_CACHE_TTL",
    "CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL",
    "CLAUDE_CODE_AUTO_CONNECT_IDE",
    "CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
    "CLAUDE_CODE_TASK_LIST_ID",
    "MAX_THINKING_TOKENS",
    "DISABLE_TELEMETRY",
    "DISABLE_ERROR_REPORTING",
    "DISABLE_AUTOUPDATER",
    "MCP_TIMEOUT",
    "MCP_TOOL_TIMEOUT",
  ],
  codex: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE"],
};
const BEDROCK_VARIABLES = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_PROFILE",
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
];
const VERTEX_VARIABLES = [
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLOUD_ML_REGION",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "CLOUDSDK_CONFIG",
];

const urlAuthority = (value: string | undefined) => {
  const url = value === undefined ? null : URL.parse(value);
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) return [];
  return [`${url.hostname}:${url.port || (url.protocol === "https:" ? 443 : 80)}`];
};

/**
 * What one provider process may see and reach: exact variable names for its sign-in mode,
 * and the hosts and files that mode uses. `configured` holds the variables Claude's own
 * settings.json sets, which decide the mode and hosts but are applied by Claude itself.
 */
export function providerAccess(
  provider: IsolatedProvider,
  env: NodeJS.ProcessEnv,
  home: string,
  configured: Readonly<Record<string, string>> = {},
  platform: NodeJS.Platform = "linux",
) {
  const effective = { ...env, ...configured };
  const bedrock = provider === "claude" && Boolean(effective.CLAUDE_CODE_USE_BEDROCK);
  const vertex = provider === "claude" && Boolean(effective.CLAUDE_CODE_USE_VERTEX);
  const names = [
    ...SHARED_VARIABLES,
    ...PROVIDER_VARIABLES[provider],
    ...(bedrock ? BEDROCK_VARIABLES : []),
    ...(vertex ? VERTEX_VARIABLES : []),
  ];
  const kept: Record<string, string> = {};
  for (const name of names) {
    const value = env[name];
    if (value !== undefined) kept[name] = value;
  }
  const region = effective.AWS_REGION ?? effective.AWS_DEFAULT_REGION ?? "us-east-1";
  const vertexRegion = effective.CLOUD_ML_REGION ?? "us-east5";
  const hosts = [
    ...(provider === "claude" ? urlAuthority(effective.ANTHROPIC_BASE_URL) : []),
    ...(provider === "codex" ? urlAuthority(effective.OPENAI_BASE_URL) : []),
    ...(bedrock
      ? [
          ...urlAuthority(effective.ANTHROPIC_BEDROCK_BASE_URL),
          `bedrock-runtime.${region}.amazonaws.com:443`,
          `bedrock.${region}.amazonaws.com:443`,
          `sts.${region}.amazonaws.com:443`,
          `portal.sso.${region}.amazonaws.com:443`,
          `oidc.${region}.amazonaws.com:443`,
        ]
      : []),
    ...(vertex
      ? [
          ...urlAuthority(effective.ANTHROPIC_VERTEX_BASE_URL),
          vertexRegion === "global"
            ? "aiplatform.googleapis.com:443"
            : `${vertexRegion}-aiplatform.googleapis.com:443`,
          "oauth2.googleapis.com:443",
          "sts.googleapis.com:443",
        ]
      : []),
  ];
  // Sign-in that lives in files: AWS profiles and SSO, Google application credentials. Where
  // no variable names them, the SDKs look under HOME, which is private: those folders are
  // linked into it, read-only.
  const named = (names: ReadonlyArray<string>) =>
    names.flatMap((name) => (effective[name] ? [effective[name]] : []));
  const readable = [
    ...(bedrock ? named(["AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE"]) : []),
    ...(vertex ? named(["GOOGLE_APPLICATION_CREDENTIALS", "CLOUDSDK_CONFIG"]) : []),
  ];
  // On Windows gcloud keeps its sign-in in %APPDATA%, which a thread's points into HOME.
  const gcloud: ReadonlyArray<readonly [string, string]> =
    platform !== "win32"
      ? [[".config/gcloud", `${home}/.config/gcloud`]]
      : env.APPDATA
        ? [["AppData/Roaming/gcloud", `${env.APPDATA}/gcloud`]]
        : [];
  const homeLinks: Array<readonly [string, string]> = [
    ...(bedrock ? [[".aws", `${home}/.aws`] as const] : []),
    ...(vertex && !effective.CLOUDSDK_CONFIG ? gcloud : []),
  ];
  return { env: kept, hosts, readable, homeLinks };
}

export interface IsolationPolicy {
  /** The thread's working folder: the only project folder it may write. */
  readonly cwd: string;
  /** Besides cwd: private HOME, TMPDIR and provider folder, and what a commit writes. */
  readonly writable: ReadonlyArray<string>;
  /** Install folders, git metadata, the owner's provider settings and git identity. */
  readonly readable: ReadonlyArray<string>;
  /** Inside writable folders, kept read-only: everything git reads as configuration. */
  readonly protected: ReadonlyArray<string>;
}

const literal = (path: string) => ({ path, literal: true as const });
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const ClaudeState = Schema.Struct({
  mcpServers: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  projects: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
const ClaudeSettings = Schema.Struct({
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  apiKeyHelper: Schema.optional(Schema.String),
  awsAuthRefresh: Schema.optional(Schema.String),
  awsCredentialExport: Schema.optional(Schema.String),
  gcpAuthRefresh: Schema.optional(Schema.String),
});
const decodeClaudeSettings = Schema.decodeOption(Schema.fromJsonString(ClaudeSettings));
const decodeClaudeState = Schema.decodeOption(Schema.fromJsonString(ClaudeState));

/** Of this server's own HTTP port, only its MCP endpoint. */
const isMcpPath = (pathname: string) => pathname === "/mcp" || pathname.startsWith("/mcp/");

/**
 * The sandbox runtime's settings for the whole server. Its sandboxes reach the network only
 * through this server's own proxy, which both backends share: srt's allow list cannot tell a
 * plain request for /mcp from a tunnel to the same port, the proxy can.
 */
export function srtNetwork(proxyPort: number) {
  return {
    enableWeakerNestedSandbox: false,
    allowNestedUserNamespaces: false,
    network: {
      httpProxyPort: proxyPort,
      // SOCKS lands on the HTTP proxy, which refuses it: every tunnel is a CONNECT it checks.
      socksProxyPort: proxyPort,
      allowedDomains: [],
      deniedDomains: [],
      allowLocalBinding: false,
    },
    filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
  };
}

/** srt's filesystem settings per thread: nothing on the host is readable unless named. */
/**
 * What a macOS program reads of the system. Not run on a Mac by T3 Code's tests: the list follows
 * macOS's layout (with /etc and /var under /private) and Homebrew's prefix.
 */
const MACOS_SYSTEM = [
  "/usr",
  "/bin",
  "/sbin",
  "/System",
  "/Library",
  "/opt/homebrew",
  "/etc",
  "/private/etc",
  "/private/var/db/timezone",
  "/dev",
];

/** Folders no provider setting may make writable: the system's own. */
const systemFoldersOf = (platform: NodeJS.Platform) =>
  platform === "darwin" ? [...MACOS_SYSTEM, "/private/var"] : [...SYSTEM_FOLDERS, "/etc"];

/**
 * A path and each folder above it, nearest first, named by the file each is (its device and
 * inode) where it exists and by its NFC name where it does not. Containment is then the same
 * file in both chains, so case-insensitive or aliased mounts, Unicode forms and names such as
 * "..x" cannot make a folder look outside one that holds it.
 */
export type PathChain = ReadonlyArray<string>;

/** Why a folder cannot be given to a thread: home or above, T3 Code's data, or the system's. */
export function folderRefusalReason(input: {
  readonly folder: PathChain;
  readonly home: PathChain;
  readonly data: ReadonlyArray<PathChain>;
  readonly system: ReadonlyArray<PathChain>;
}): string | undefined {
  const within = (inner: PathChain, outer: PathChain) =>
    outer.length > 0 && inner.includes(outer[0]!);
  if (within(input.home, input.folder)) return "it is your home folder or holds it";
  if (input.data.some((entry) => within(entry, input.folder) || within(input.folder, entry))) {
    return "it holds or lies in T3 Code's own data";
  }
  if (input.system.some((entry) => within(input.folder, entry))) return "it is a system folder";
  return undefined;
}

export function srtSettings(policy: IsolationPolicy, platform: NodeJS.Platform = "linux") {
  return {
    filesystem: {
      denyRead: [literal("/")],
      allowRead: [
        ...(platform === "darwin" ? MACOS_SYSTEM : [...SYSTEM_FOLDERS, ...SYSTEM_FILES]),
        policy.cwd,
        ...policy.writable,
        ...policy.readable,
      ].map(literal),
      allowWrite: [policy.cwd, ...policy.writable].map(literal),
      denyWrite: policy.protected.map(literal),
      // The server runs git in this folder, so a written hook or config would run on the host.
      allowGitConfig: false,
    },
  };
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** Arguments a caller adds after wrapping, carried into the sandbox shell-quoted. */
const ISOLATED_ARGS_VARIABLE = "T3CODE_ISOLATED_ARGS";
const quoteArguments = (args: ReadonlyArray<string>) => args.map(shellQuote).join(" ");

/** The command line the sandbox runtime wraps for one provider process. */
export function srtCommandLine(input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly tmp: string;
  /** Sent as the proxy user name: it selects this launch's allowed hosts. */
  readonly proxyId: string;
}): string {
  // srt runs this through `bash -c`, so arguments appended to its command line never reach it.
  return [
    `eval "set -- \${${ISOLATED_ARGS_VARIABLE}-}"; unset ${ISOLATED_ARGS_VARIABLE};`,
    `proxy="http://${input.proxyId}@\${HTTP_PROXY#http://}";`,
    "exec",
    // srt exempts loopback from its proxy, but the sandbox's loopback is empty: only through
    // the proxy does the allowed MCP endpoint answer, and no other local port does.
    "/usr/bin/env",
    "-u",
    "NO_PROXY",
    "-u",
    "no_proxy",
    ...PROXY_VARIABLES.map((name) => `${name}="$proxy"`),
    'ALL_PROXY="$proxy"',
    'all_proxy="$proxy"',
    `TMPDIR=${shellQuote(input.tmp)}`,
    ...[input.command, ...input.args].map(shellQuote),
    '"$@"',
  ].join(" ");
}

export const DOCKER_IMAGE = "t3code-isolation:1";
const DOCKER_LABEL = "t3code-isolation";
const CONTAINER_PROXY_SOCKET = "/run/t3code-proxy.sock";
// socat bridges the container's own loopback to the host proxy's Unix socket: the container
// has no network, so nothing on the host but that socket is reachable.
const CONTAINER_ENTRY = `/usr/bin/socat TCP-LISTEN:3128,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:${CONTAINER_PROXY_SOCKET} & exec "$@"`;

// Docker reads --mount as one CSV record.
const csvField = (field: string) =>
  /[",\n]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field;
const bindMount = (source: string, readonly: boolean, target = source) => [
  "--mount",
  ["type=bind", `src=${source}`, `dst=${target}`, ...(readonly ? ["readonly"] : [])]
    .map(csvField)
    .join(","),
];

const PROXY_VARIABLES = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"];
const FIXED_VARIABLES = new Set([
  "HOME",
  "TMPDIR",
  "PWD",
  "NO_PROXY",
  "no_proxy",
  ...PROXY_VARIABLES,
]);
/** Variables each launch sets for itself, which a policy cannot hand a thread from the host. */
const LAUNCH_VARIABLES = new Set([
  ...FIXED_VARIABLES,
  ISOLATED_ARGS_VARIABLE,
  "GIT_CONFIG_GLOBAL",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
]);

/** A hardened container over named host folders. */
export function dockerCommand(input: {
  readonly docker: string;
  readonly policy: IsolationPolicy;
  /** Host system folders and files the container sees read-only at the same paths. */
  readonly system: ReadonlyArray<string>;
  readonly home: string;
  readonly tmp: string;
  readonly proxySocket: string;
  /** Names this server, so its start-up sweep removes only its own containers. */
  readonly server: string;
  /** Sent as the proxy user name: it selects this launch's allowed hosts. */
  readonly proxyId: string;
  readonly uid: number;
  readonly gid: number;
  readonly name: string;
  /** Variables the container takes from the launching environment, by name only. */
  readonly env: ReadonlyArray<string>;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}) {
  const { policy } = input;
  const proxy = `http://${input.proxyId}@127.0.0.1:3128`;
  return {
    command: input.docker,
    args: [
      "run",
      "--rm",
      "--interactive",
      "--init",
      "--name",
      input.name,
      "--label",
      `${DOCKER_LABEL}=${input.server}`,
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges=true",
      "--ipc",
      "private",
      "--cgroupns",
      "private",
      "--pull",
      "never",
      // A core dump would write the process's memory, its sign-in included, to disk.
      "--ulimit",
      "core=0:0",
      "--network",
      "none",
      "--user",
      `${input.uid}:${input.gid}`,
      "--workdir",
      policy.cwd,
      ...input.system.flatMap((path) => bindMount(path, true)),
      ...bindMount(policy.cwd, false),
      ...policy.writable.flatMap((path) => bindMount(path, false)),
      ...bindMount(input.tmp, false, "/tmp"),
      ...policy.readable.flatMap((path) => bindMount(path, true)),
      ...policy.protected.flatMap((path) => bindMount(path, true)),
      ...bindMount(input.proxySocket, true, CONTAINER_PROXY_SOCKET),
      "--env",
      `HOME=${input.home}`,
      "--env",
      "TMPDIR=/tmp",
      ...PROXY_VARIABLES.flatMap((name) => ["--env", `${name}=${proxy}`]),
      ...input.env.flatMap((name) =>
        FIXED_VARIABLES.has(name) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? [] : ["--env", name],
      ),
      DOCKER_IMAGE,
      "/bin/sh",
      "-c",
      CONTAINER_ENTRY,
      "t3code-isolation",
      input.command,
      ...input.args,
    ],
  };
}

/**
 * Whether a tunnel is refused: one outside the launch's list, or, for a launch that may reach
 * every host, one to this machine, which reaches this server only as plain HTTP to /mcp.
 */
export function refusesTunnel(
  target: string,
  reachable: ReadonlyArray<string> | "any",
  mcp: string | undefined,
): boolean {
  if (reachable !== "any") return !allowsTarget(target, reachable);
  const split = splitTarget(target);
  return (
    split === undefined ||
    isThisMachine(split.host) ||
    (mcp !== undefined && allowsTarget(target, [mcp]))
  );
}

/** CONNECT only to an allowed `host:port`, matched exactly. */
export function allowsTarget(target: string, allowed: ReadonlyArray<string>): boolean {
  const lower = target.toLowerCase();
  return allowed.some((entry) => entry.toLowerCase() === lower);
}

const splitTarget = (target: string) => {
  const url = URL.parse(`http://${target}`);
  // The parsed host is the one connected to, so numeric spellings of 127.0.0.1 are caught too.
  return url === null
    ? undefined
    : { host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || 80) };
};

const proxyUser = (header: string | string[] | undefined) => {
  const value = Array.isArray(header) ? header[0] : header;
  const match = /^Basic\s+(\S+)$/i.exec(value ?? "");
  return match === null ? "" : Buffer.from(match[1]!, "base64").toString("utf8").split(":")[0]!;
};

/** The proxy the server itself reaches the internet through, as srt chains to it. */
interface ParentProxy {
  readonly open: (host: string, port: number) => Promise<NodeNet.Socket> | undefined;
}
const loadParentProxy = attempt(
  "the sandbox runtime's proxy support could not be loaded",
  async () =>
    requireSandboxRuntime(
      "@anthropic-ai/sandbox-runtime/dist/sandbox/parent-proxy.js",
    ) as typeof import("@anthropic-ai/sandbox-runtime/dist/sandbox/parent-proxy.js"),
).pipe(
  Effect.map((module): ParentProxy | undefined => {
    const resolved = module.resolveParentProxy();
    if (resolved === undefined) return undefined;
    return {
      open: (host, port) => {
        const url = module.shouldBypassParentProxy(resolved, host)
          ? undefined
          : module.selectParentProxyUrl(resolved, { isHttps: true });
        return url === undefined ? undefined : module.connectViaParentProxy(url, host, port);
      },
    };
  }),
  Effect.orElseSucceed(() => undefined),
);

/**
 * This machine's own addresses reach this server and the host's own services, which isolation
 * keeps out even of a thread that may reach every other host.
 */
const isThisMachine = (address: string) => {
  const plain = address.replace(/^\[|\]$/g, "").toLowerCase();
  if (plain === "localhost" || plain.endsWith(".localhost")) return true;
  const family = NodeNet.isIP(plain.replace(/%.*$/, ""));
  if (family === 0) return false;
  const own = new NodeNet.BlockList();
  own.addSubnet("127.0.0.0", 8, "ipv4");
  own.addAddress("0.0.0.0", "ipv4");
  own.addAddress("::1", "ipv6");
  own.addAddress("::", "ipv6");
  for (const entry of Object.values(NodeOS.networkInterfaces()).flat()) {
    if (entry)
      own.addAddress(entry.address.replace(/%.*$/, ""), entry.family === "IPv6" ? "ipv6" : "ipv4");
  }
  return own.check(plain.replace(/%.*$/, ""), family === 6 ? "ipv6" : "ipv4");
};

/** A name that resolves to this machine is refused at the lookup the connection itself uses. */
export const lookupElsewhere: NodeNet.LookupFunction = (name, options, callback) =>
  NodeDns.lookup(name, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, "", 4);
    const refused = addresses.some((entry) => isThisMachine(entry.address));
    if (refused) return callback(new Error(`${name} resolves to this machine`), "", 4);
    if (options.all) return (callback as (e: null, all: typeof addresses) => void)(null, addresses);
    callback(null, addresses[0]!.address, addresses[0]!.family);
  });

const connectDirectly = (host: string, port: number, elsewhere: boolean) =>
  new Promise<NodeNet.Socket>((resolve, reject) => {
    const socket = NodeNet.connect(
      { host, port, ...(elsewhere ? { lookup: lookupElsewhere } : {}) },
      () => resolve(socket),
    );
    socket.once("error", reject);
  });

/**
 * Listens on loopback at the first of `ports` free. Windows refuses a port Hyper-V, WSL2 or
 * Docker reserved with EACCES, not EADDRINUSE, so that moves on too, and says where to look.
 */
export function listenOnFirst(
  server: Pick<NodeNet.Server, "once" | "listen">,
  ports: ReadonlyArray<number>,
  failed: (cause: Error) => void,
  listening: () => void,
  index = 0,
): void {
  const taken = (cause: NodeJS.ErrnoException) =>
    cause.code === "EADDRINUSE" || (ports.length > 1 && cause.code === "EACCES");
  server.once("error", (cause: NodeJS.ErrnoException) =>
    taken(cause) && index + 1 < ports.length
      ? listenOnFirst(server, ports, failed, listening, index + 1)
      : failed(
          taken(cause)
            ? new Error(
                `ports ${ports[0]}-${ports.at(-1)} are all in use or reserved (see \`netsh int ipv4 show excludedportrange protocol=tcp\`)`,
              )
            : cause,
        ),
  );
  server.listen(ports[index], "127.0.0.1", listening);
}

/**
 * One proxy for every isolated thread: on a Unix socket Docker containers mount (none on
 * Windows), and on a loopback port srt's bridge reaches, the first of `ports` that is free.
 * Plain HTTP goes only to this server's /mcp; a tunnel only to a host:port the launch named by
 * its proxy user may reach, never this server.
 */
const startProxy = (
  socketPath: string | undefined,
  ports: ReadonlyArray<number>,
  allowedFor: (proxyId: string) => ReadonlyArray<string> | "any" | undefined,
  mcp: string | undefined,
  parent: ParentProxy | undefined,
) =>
  Effect.acquireRelease(
    Effect.callback<
      { readonly servers: ReadonlyArray<NodeHttp.Server>; readonly port: number },
      ThreadIsolationError
    >((resume) => {
      const allowed = (request: NodeHttp.IncomingMessage) =>
        allowedFor(proxyUser(request.headers["proxy-authorization"])) ?? [];
      // Plain HTTP is only ever this server's MCP endpoint.
      const onRequest = (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => {
        const url = URL.parse(request.url ?? "");
        if (
          url === null ||
          url.protocol !== "http:" ||
          mcp === undefined ||
          !allowsTarget(url.host, [mcp]) ||
          !isMcpPath(url.pathname)
        ) {
          response.writeHead(403).end();
          return;
        }
        const { host, port } = splitTarget(url.host)!;
        const headers = { ...request.headers };
        delete headers["proxy-authorization"];
        const upstream = NodeHttp.request(
          { host, port, method: request.method, path: url.pathname + url.search, headers },
          (answer) => {
            response.writeHead(answer.statusCode ?? 502, answer.headers);
            answer.pipe(response);
          },
        );
        upstream.on("error", () => response.destroy());
        request.pipe(upstream);
      };
      const onConnect = (
        request: NodeHttp.IncomingMessage,
        client: NodeNet.Socket,
        head: Buffer,
      ) => {
        client.on("error", () => client.destroy());
        const target = request.url ?? "";
        const reachable = allowed(request);
        const split = splitTarget(target);
        if (split === undefined || refusesTunnel(target, reachable, mcp)) {
          client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
          return;
        }
        const { host, port } = split;
        (parent?.open(host, port) ?? connectDirectly(host, port, reachable === "any")).then(
          (upstream) => {
            if (client.destroyed) {
              upstream.destroy();
              return;
            }
            client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            upstream.write(head);
            upstream.pipe(client);
            client.pipe(upstream);
            upstream.on("error", () => client.destroy());
            client.on("close", () => upstream.destroy());
          },
          () => client.destroy(),
        );
      };
      const failed = (cause: Error) =>
        resume(
          Effect.fail(
            new ThreadIsolationError({
              detail: `the isolation proxy could not start: ${cause.message}`,
            }),
          ),
        );
      const servers = (socketPath === undefined ? [0] : [0, 1]).map(() => {
        const server = NodeHttp.createServer(onRequest);
        server.on("connect", onConnect);
        return server;
      });
      const tcp = servers.at(-1)!;
      const listenOn = () =>
        listenOnFirst(tcp, ports, failed, () => {
          const address = tcp.address();
          resume(
            Effect.succeed({
              servers,
              port: typeof address === "object" && address !== null ? address.port : 0,
            }),
          );
        });
      if (socketPath === undefined) return listenOn();
      servers[0]!.once("error", failed);
      NodeFS.rmSync(socketPath, { force: true });
      servers[0]!.listen(socketPath, listenOn);
    }),
    ({ servers }) => Effect.sync(() => servers.forEach((server) => server.close())),
  );

/** Where a binary's own files live: its npm package, or its folder; never the home folder or above. */
export function installRoot(path: Path.Path, file: string, home: string): string | undefined {
  const parts = file.split(path.sep);
  const index = parts.lastIndexOf("node_modules");
  const end = parts[index + 1]?.startsWith("@") ? index + 3 : index + 2;
  const root = index === -1 ? path.dirname(file) : parts.slice(0, end).join(path.sep);
  const relative = path.relative(root, home);
  return root === path.parse(root).root || relative === "" || !relative.startsWith("..")
    ? undefined
    : root;
}

const ClaudeCredential = Schema.Struct({
  claudeAiOauth: Schema.Struct({
    accessToken: Schema.String,
    scopes: Schema.optional(Schema.Array(Schema.String)),
    subscriptionType: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});
const CodexCredential = Schema.Union([
  Schema.Struct({
    tokens: Schema.Struct({
      access_token: Schema.String,
      account_id: Schema.optional(Schema.String),
    }),
  }),
  // `codex login --with-api-key`: never copied back, since nothing refreshes it.
  Schema.Struct({ OPENAI_API_KEY: Schema.String }),
]);
const decodeClaudeCredential = Schema.decodeOption(Schema.fromJsonString(ClaudeCredential));
const decodeCodexCredential = Schema.decodeOption(Schema.fromJsonString(CodexCredential));
const isCredential = (text: string) =>
  Option.isSome(decodeClaudeCredential(text)) || Option.isSome(decodeCodexCredential(text));

const decodeObject = Schema.decodeOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
/** Every key path, two levels deep, of a JSON object. */
const keyPaths = (text: string): ReadonlySet<string> => {
  const parsed = Option.getOrUndefined(decodeObject(text)) ?? {};
  const paths = new Set<string>();
  for (const [key, value] of Object.entries(parsed)) {
    paths.add(key);
    if (typeof value === "object" && value !== null) {
      for (const inner of Object.keys(value)) paths.add(`${key}.${inner}`);
    }
  }
  return paths;
};
// What a refreshed sign-in must still hold, or the host CLI could not refresh it again.
const REFRESHABLE: Readonly<Record<IsolatedProvider, ReadonlyArray<string>>> = {
  claude: ["claudeAiOauth.refreshToken", "claudeAiOauth.expiresAt"],
  codex: ["tokens.refresh_token"],
};

/**
 * Whether a thread's credential may replace the host's: only while the host's file is still
 * what was seeded, only a complete one (every field the seeded copy has, refresh token and
 * expiry included), and for the same login as far as the file tells: Codex names its ChatGPT
 * account; Claude's carries no account, so it must keep the seeded copy's plan and scopes.
 */
export function mayCopyBack(input: {
  readonly provider: IsolatedProvider;
  readonly copy: string;
  readonly real: string | undefined;
  readonly seeded: string | undefined;
}): boolean {
  if (input.real === undefined || input.copy === input.real) return false;
  // The host's file moved on since seeding (its own CLI refreshed): the host's wins.
  if (input.seeded === undefined || input.real !== input.seeded) return false;
  const shape = keyPaths(input.copy);
  if (![...keyPaths(input.seeded), ...REFRESHABLE[input.provider]].every((key) => shape.has(key))) {
    return false;
  }
  if (input.provider === "codex") {
    const copy = decodeCodexCredential(input.copy);
    const real = decodeCodexCredential(input.real);
    const account = (credential: typeof copy) =>
      Option.isSome(credential) && "tokens" in credential.value
        ? credential.value.tokens.account_id
        : undefined;
    return account(real) !== undefined && account(copy) === account(real);
  }
  const copy = decodeClaudeCredential(input.copy);
  const seeded = decodeClaudeCredential(input.seeded);
  return (
    Option.isSome(copy) &&
    Option.isSome(seeded) &&
    copy.value.claudeAiOauth.subscriptionType === seeded.value.claudeAiOauth.subscriptionType &&
    (copy.value.claudeAiOauth.scopes ?? []).join(" ") ===
      (seeded.value.claudeAiOauth.scopes ?? []).join(" ")
  );
}

/**
 * Reads a file only if it is a regular file, never through a link. A file a thread can write
 * is read only up to `limit` bytes, so a thread cannot make the server load an endless file,
 * and is opened non-blocking, so a FIFO a thread left there is refused instead of stalling the
 * server.
 */
const readRegularFile = (file: string, limit?: number): string | undefined => {
  try {
    const descriptor = NodeFS.openSync(
      file,
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
    );
    try {
      const stat = NodeFS.fstatSync(descriptor);
      if (!stat.isFile() || (limit !== undefined && stat.size > limit)) return undefined;
      return NodeFS.readFileSync(descriptor, "utf8");
    } finally {
      NodeFS.closeSync(descriptor);
    }
  } catch {
    return undefined;
  }
};

interface ProviderLayout {
  /** The provider's real state folder on the host. */
  readonly real: string;
  readonly variable: "CLAUDE_CONFIG_DIR" | "CODEX_HOME";
  readonly folder: string;
  readonly credential: string;
  /**
   * Entries of the real folder a thread does not see: history, transcripts, credentials, logs
   * and caches. Everything else is the owner's configuration, readable inside through links.
   */
  readonly private: (name: string) => boolean;
}

const CLAUDE_PRIVATE = new Set([
  ".credentials.json",
  ".claude.json",
  "projects",
  "todos",
  "tasks",
  "plans",
  "sessions",
  "session-env",
  "shell-snapshots",
  "history.jsonl",
  "file-history",
  "paste-cache",
  "debug",
  "logs",
  "ide",
  "statsig",
  "telemetry",
  "backups",
  "cache",
  "stats-cache.json",
]);
const CODEX_PRIVATE = new Set([
  "auth.json",
  "sessions",
  "archived_sessions",
  "history.jsonl",
  "log",
  "logs",
  "tmp",
  "shell_snapshots",
  "version.json",
  "models_cache.json",
  "internal_storage.json",
]);

function providerLayout(
  path: Path.Path,
  provider: IsolatedProvider,
  env: NodeJS.ProcessEnv,
  home: string,
): ProviderLayout {
  return provider === "claude"
    ? {
        real: env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"),
        variable: "CLAUDE_CONFIG_DIR",
        folder: ".claude",
        credential: ".credentials.json",
        private: (name) => CLAUDE_PRIVATE.has(name) || name.startsWith(".claude.json"),
      }
    : {
        real: env.CODEX_HOME || path.join(home, ".codex"),
        variable: "CODEX_HOME",
        folder: ".codex",
        credential: "auth.json",
        // Its state databases list every thread on the machine.
        private: (name) => CODEX_PRIVATE.has(name) || name.includes(".sqlite"),
      };
}

/**
 * What srt-win's account may read for a launch: of what it reads, what lies in a home folder
 * or T3 Code's data, which Windows keeps from other accounts (elsewhere every account reads
 * already); the launcher; and its Node's folder, never a home folder or above. The homes are
 * T3 Code's and the account's own profile, which may differ.
 */
export function srtWinReadGrants(
  path: Path.Path,
  input: {
    readonly readable: ReadonlyArray<string>;
    readonly launcher: string;
    readonly runtime: string;
    readonly homes: ReadonlyArray<string>;
    readonly data: ReadonlyArray<string>;
  },
): Array<string> {
  const runtime = input.homes.every((home) => installRoot(path, input.runtime, home) !== undefined)
    ? [path.dirname(input.runtime)]
    : [];
  const owned = (entry: string) =>
    [...input.homes, ...input.data].some(
      (folder) => entry === folder || entry.startsWith(`${folder}${path.sep}`),
    );
  return [...new Set([...input.readable, input.launcher, ...runtime])].filter(owned);
}

/** Claude's name for a folder's transcript directory. */
export const claudeProjectFolder = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

export interface WrapInput {
  /** The provider's driver kind ("claude" also names Claude's). */
  readonly provider: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string | null | undefined;
  readonly env: NodeJS.ProcessEnv;
  /** The provider session, or another name for work done outside one; released with it. */
  readonly key: string;
  /** The thread, whose Codex conversations outlive its sessions. */
  readonly thread?: string | undefined;
  /** Claude's session id (whose task list T3 Code reads), or the Codex thread being resumed. */
  readonly session?: string | undefined;
  /** Host files the command reads or writes besides its folder. */
  readonly readable?: ReadonlyArray<string> | undefined;
  readonly writable?: ReadonlyArray<string> | undefined;
  /** The command is a shell's command line (a Windows .cmd or .bat), not a program. */
  readonly shell?: boolean | undefined;
}

/** A launch of Claude or Codex, which have their own sign-in handling. */
type OwnInput = WrapInput & { readonly provider: IsolatedProvider };

export interface IsolatedLaunch {
  readonly backend: "srt" | "docker" | "windows";
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** The whole environment to start it with; nothing else from the server's is inherited. */
  readonly env: Record<string, string>;
  /** The Windows sandbox stops when this file is written, before its process is killed. */
  readonly stopPath?: string | undefined;
}

/**
 * Arguments a caller appends after the launch's first `own` ones, such as the Claude SDK's: srt
 * runs its command line through `bash -c`, which would drop them, so they go in the environment.
 * Only srt off Windows reads them there: srt-win and every other backend pass them on as given.
 */
export function carryArguments(
  backend: IsolatedLaunch["backend"],
  platform: NodeJS.Platform,
  args: ReadonlyArray<string>,
  own: number,
): { readonly args: Array<string>; readonly env: Record<string, string> } {
  return backend !== "srt" || platform === "win32" || args.length <= own
    ? { args: [...args], env: {} }
    : {
        args: args.slice(0, own),
        env: { [ISOLATED_ARGS_VARIABLE]: quoteArguments(args.slice(own)) },
      };
}

export interface ThreadIsolationShape {
  readonly enabled: Effect.Effect<boolean>;
  /** Undefined while the setting is off. */
  readonly status: Effect.Effect<ThreadIsolationStatus | undefined>;
  /** Emits when the status changes other than through the settings: a thread's mark. */
  readonly subscribeChanges: Effect.Effect<Stream.Stream<void>, never, Scope.Scope>;
  /**
   * Admits a thread's session before it opens. A driver that starts no process of its own
   * never reaches `wrap`, so it is refused or marked here, under a key of that open's own.
   */
  readonly check: (input: {
    readonly driver: ProviderDriverKind;
    readonly thread: string;
    readonly key: string;
  }) => Effect.Effect<void, ThreadIsolationError>;
  /** The isolated launch of a provider process; undefined while the setting is off. */
  readonly wrap: (
    input: WrapInput,
  ) => Effect.Effect<IsolatedLaunch | undefined, ThreadIsolationError>;
  /**
   * Ends a key's isolation (a provider session, or a run outside one): copies a refreshed
   * credential back and removes its private folder. Nothing happens for a key never wrapped.
   */
  readonly release: (key: string) => Effect.Effect<void>;
  /**
   * Sets up srt on this machine (Windows: its sandbox account and network fence, after one
   * administrator prompt there), then looks again at what can run.
   */
  readonly setUp: Effect.Effect<"done" | "cancelled", ThreadIsolationError>;
  /** Removes what `setUp` made, after the same prompt, then looks again at what can run. */
  readonly remove: Effect.Effect<"done" | "cancelled", ThreadIsolationError>;
}

export const ThreadIsolation = Context.Reference<ThreadIsolationShape>(
  "@t3tools/server/ThreadIsolation",
  {
    defaultValue: () => ({
      enabled: Effect.succeed(false),
      status: Effect.undefined,
      subscribeChanges: Effect.succeed(Stream.empty),
      check: () => Effect.void,
      wrap: () => Effect.undefined,
      release: () => Effect.void,
      setUp: Effect.fail(new ThreadIsolationError({ detail: "Thread isolation is not running." })),
      remove: Effect.fail(new ThreadIsolationError({ detail: "Thread isolation is not running." })),
    }),
  },
);

/** The first probe, from server start: the first client's config snapshot does not wait for it. */
export const warm = Effect.flatMap(ThreadIsolation, (isolation) => forkParked(isolation.status));

const keyOf = (key: string) =>
  NodeCrypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
const unguessable = () => NodeCrypto.randomBytes(18).toString("base64url");

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const home = yield* HostProcess.HomeDirectory;
  const hostEnvironment = yield* HostProcess.Environment;
  const { stateDir, baseDir } = yield* ServerConfig.ServerConfig;
  const httpServer = yield* HttpServer.HttpServer;
  const layerScope = yield* Effect.scope;
  const sandboxSource = yield* SandboxRuntimeSource;
  const mcp = localMcpAuthority(httpServer.address);
  const root = path.join(stateDir, "isolation");
  const fail = (detail: string) => Effect.fail(new ThreadIsolationError({ detail }));
  const failWith = (detail: string) => () => new ThreadIsolationError({ detail });

  // Unreadable settings must not run a thread unconfined.
  const enabled = settings.getSettings.pipe(
    Effect.map((current) => current.threadIsolation),
    Effect.orElseSucceed(() => true),
  );

  const which = (command: string, env: NodeJS.ProcessEnv = hostEnvironment) =>
    resolveCommandPath(command, { env }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcess.Platform, platform),
      Effect.orElseSucceed(() => null),
    );

  const runIn = (cwd: string | undefined, command: string, args: ReadonlyArray<string>) =>
    runner.run({ command, args, timeoutBehavior: "timedOutResult", ...(cwd ? { cwd } : {}) }).pipe(
      Effect.map((result) => ({
        ok: result.code === 0 && !result.timedOut,
        stdout: result.stdout.trim(),
        timedOut: result.timedOut,
      })),
      Effect.orElseSucceed(() => ({ ok: false, stdout: "", timedOut: false })),
    );
  const run = (command: string, args: ReadonlyArray<string>) => runIn(undefined, command, args);

  const exists = (candidate: string) =>
    fs.exists(candidate).pipe(Effect.orElseSucceed(() => false));
  const existing = (paths: ReadonlyArray<string>) =>
    Effect.forEach(paths, (candidate) =>
      Effect.map(exists(candidate), (found) => (found ? [candidate] : [])),
    ).pipe(Effect.map((found) => found.flat()));
  const realPath = (file: string) => fs.realPath(file).pipe(Effect.orElseSucceed(() => file));
  const isLink = (file: string) =>
    fs.readLink(file).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );

  // Server-written files never go through a path the thread could have replaced: a fresh
  // file in the server's own folder, renamed over the target (a rename replaces a link).
  const serverFolder = path.join(root, "server");
  const writeAtomically = Effect.fn("ThreadIsolation.writeAtomically")(function* (
    target: string,
    text: string,
  ) {
    yield* fs.makeDirectory(serverFolder, { recursive: true });
    const temporary = path.join(serverFolder, `${unguessable()}.tmp`);
    // A failed rename must not leave a credential behind in the server's folder.
    yield* fs.writeFileString(temporary, text, { mode: 0o600, flag: "wx" }).pipe(
      Effect.andThen(fs.rename(temporary, target)),
      Effect.onError(() => fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
    );
  });

  const server = keyOf(root);
  const proxyHosts = new Map<string, ReadonlyArray<string> | "any">();
  const proxyLock = yield* Semaphore.make(1);
  let proxy: { readonly socket: string | undefined; readonly port: number } | undefined;
  // A Unix socket path holds at most 107 bytes; a long state folder gets one in /tmp instead.
  const proxySocketPath = Effect.gen(function* () {
    const preferred = path.join(serverFolder, "proxy.sock");
    if (Buffer.byteLength(preferred) <= 107) {
      yield* fs.makeDirectory(serverFolder, { recursive: true });
      return preferred;
    }
    // A fresh name each time (mode 0700), so no other user can claim or block it.
    const folder = yield* fs.makeTempDirectory({ directory: "/tmp", prefix: "t3code-isolation-" });
    yield* fs.chmod(folder, 0o700);
    yield* Scope.addFinalizer(
      layerScope,
      fs.remove(folder, { recursive: true, force: true }).pipe(Effect.ignore),
    );
    return path.join(folder, "proxy.sock");
  });
  // Why the proxy could not start, as srt's status and a launch say it: a reserved port says so.
  const proxyProblem = (error: { readonly _tag: string; readonly detail?: string }) =>
    error._tag === "ThreadIsolationError" && error.detail !== undefined
      ? error.detail
      : "the isolation proxy could not start";
  const ensureProxy = proxyLock.withPermits(1)(
    Effect.gen(function* () {
      if (proxy !== undefined) return proxy;
      // Docker, the socket's only user, does not run on Windows; srt-win reaches only its ports.
      const socket = platform === "win32" ? undefined : yield* proxySocketPath;
      const { port } = yield* startProxy(
        socket,
        platform === "win32" ? SRT_WIN_PROXY_PORTS : [0],
        (id) => proxyHosts.get(id),
        mcp,
        yield* loadParentProxy,
      ).pipe(Effect.provideService(Scope.Scope, layerScope));
      proxy = { socket, port };
      return proxy;
    }),
  );

  // One sandbox runtime per server, loaded only once isolation is on: its bridges start once
  // and every launch only builds a bubblewrap command line. A restart holds the lock, so a
  // launch meanwhile waits for it instead of finding no runtime.
  const sandboxLock = yield* Semaphore.make(1);
  let sandbox:
    | {
        readonly manager: SandboxRuntime;
        readonly bridge: string | undefined;
        readonly readable: ReadonlyArray<string>;
        /** On Windows: srt-win, and the sandbox account its grants name. */
        readonly windows?: { readonly runtime: WindowsSandboxRuntime; readonly account: string };
      }
    | undefined;
  // Asks srt's own proxy, through its bridge, for a host it refuses: an answer proves the
  // sandbox starts and its network path is alive, without leaving the machine.
  const probeCommand = [
    'p="${HTTP_PROXY##*:}"; p="${p%%/*}";',
    'exec 3<>"/dev/tcp/127.0.0.1/$p" || exit 1;',
    "printf 'GET http://t3code-probe.invalid/ HTTP/1.0\\r\\n\\r\\n' >&3;",
    'read -r status <&3; case "$status" in HTTP/*) exit 0;; esac; exit 1',
  ].join(" ");
  const probeSandbox = (runtime: NonNullable<typeof sandbox>) =>
    attempt("srt did not wrap", () =>
      runtime.manager.wrapWithSandboxArgv(probeCommand, undefined, {
        filesystem: srtSettings(
          { cwd: serverFolder, writable: [], readable: runtime.readable, protected: [] },
          platform,
        ).filesystem,
      }),
    ).pipe(
      Effect.flatMap((probe) => run(probe.argv[0]!, probe.argv.slice(1))),
      Effect.map((result) => (result.timedOut ? ("timedOut" as const) : result.ok)),
      Effect.orElseSucceed(() => false),
    );
  // What srt-win's own check last found, whatever starting it then did.
  let srtWinInstalled = false;
  const windowsProblem = Effect.fn("ThreadIsolation.windowsProblem")(function* (
    windows: WindowsSandboxRuntime,
  ) {
    srtWinInstalled = false;
    if (!(yield* exists(windows.program))) return "srt-win is missing from this installation";
    const problem = yield* attemptSaying("srt-win cannot run", windows.problem).pipe(
      Effect.catch((error) => Effect.succeed(error.detail)),
    );
    srtWinInstalled = problem === undefined;
    return problem;
  });
  /**
   * srt checks at start, synchronously, that the fence holds: srt-win tries a loopback port
   * outside it as the sandbox account, which first makes that account's profile (up to 30 s).
   * Asked here first without blocking, srt's own check is then a quick repeat.
   */
  const verifyFence = (program: string) =>
    Effect.acquireUseRelease(
      Effect.callback<NodeNet.Server | undefined>((resume) => {
        const server = NodeNet.createServer();
        server.once("error", () => resume(Effect.undefined));
        server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
      }),
      (server) => {
        const address = server?.address();
        const port = typeof address === "object" && address !== null ? address.port : undefined;
        // A port inside the fence's own range passes it whether it holds or not.
        if (port === undefined || SRT_WIN_PROXY_PORTS.includes(port)) return Effect.undefined;
        return runner
          .run({
            command: program,
            args: ["wfp", "verify", "--target", `127.0.0.1:${port}`],
            timeout: "60 seconds",
            timeoutBehavior: "timedOutResult",
          })
          .pipe(
            Effect.map((result) => (result.code === 3 ? WINDOWS_FENCE_INACTIVE : undefined)),
            Effect.orElseSucceed(() => undefined),
          );
      },
      (server) => Effect.sync(() => server?.close()),
    );
  // srt-win checks at start that the sandbox account exists and its network fence holds.
  const startWindowsSandbox = Effect.fn("ThreadIsolation.startWindowsSandbox")(function* (
    manager: SandboxRuntime,
    windows: WindowsSandboxRuntime,
  ) {
    const problem = yield* windowsProblem(windows);
    if (problem !== undefined) return problem;
    const network = yield* ensureProxy.pipe(Effect.result);
    if (network._tag === "Failure") return proxyProblem(network.failure);
    const fence = yield* verifyFence(windows.program);
    if (fence !== undefined) return fence;
    const started = yield* attemptSaying("srt cannot start a sandbox on this machine", () =>
      manager.initialize({
        ...srtNetwork(network.success.port),
        windows: { srtWin: { path: windows.program } },
      }),
    ).pipe(Effect.result);
    if (started._tag === "Failure") return started.failure.detail;
    const account = yield* attempt("", windows.account).pipe(Effect.orElseSucceed(() => undefined));
    if (account === undefined) {
      yield* attempt("srt did not stop", () => manager.reset()).pipe(Effect.ignore);
      return "srt cannot find its sandbox account on this machine";
    }
    sandbox = {
      manager,
      bridge: undefined,
      readable: [],
      windows: { runtime: windows, account },
    };
    yield* Scope.addFinalizer(
      layerScope,
      attempt("srt did not stop", () => manager.reset()).pipe(Effect.ignore),
    );
    return undefined;
  });
  const startSandboxHeld = Effect.gen(function* () {
    if (sandbox?.windows !== undefined) {
      // srt-win keeps no bridge that could die, but it can be removed or broken meanwhile.
      const problem = yield* windowsProblem(sandbox.windows.runtime);
      if (problem === undefined) return undefined;
      const previous = sandbox;
      sandbox = undefined;
      yield* attempt("srt did not stop", () => previous.manager.reset()).pipe(Effect.ignore);
      return problem;
    }
    if (sandbox !== undefined) {
      if ((yield* probeSandbox(sandbox)) === true) return undefined;
      // A dead proxy or bridge: start srt again once before falling back.
      const previous = sandbox;
      sandbox = undefined;
      yield* attempt("srt did not stop", () => previous.manager.reset()).pipe(Effect.ignore);
    }
    const loaded = yield* sandboxSource.pipe(Effect.option);
    if (loaded._tag === "None") return "the sandbox runtime could not be loaded";
    const { manager, packageRoot } = loaded.value;
    if (platform === "win32") return yield* startWindowsSandbox(manager, loaded.value.windows);
    if (!manager.isSupportedPlatform()) return "srt does not support this system";
    const { errors } = manager.checkDependencies();
    if (errors.length > 0) return `srt cannot run: ${errors.join(", ")}`;
    const network = yield* ensureProxy.pipe(Effect.result);
    if (network._tag === "Failure") return proxyProblem(network.failure);
    const started = yield* attempt("srt did not start", () =>
      manager.initialize(srtNetwork(network.success.port)),
    ).pipe(Effect.option);
    if (started._tag === "None") return "srt cannot start a sandbox on this machine";
    const stop = attempt("srt did not stop", () => manager.reset()).pipe(Effect.ignore);
    yield* fs.makeDirectory(serverFolder, { recursive: true }).pipe(Effect.ignore);
    // Its seccomp helper and proxy bridge sockets are used from inside the sandbox.
    const runtime = {
      manager,
      bridge: manager.getLinuxHttpSocketPath(),
      readable: [
        packageRoot,
        ...[manager.getLinuxHttpSocketPath(), manager.getLinuxSocksSocketPath()].filter(
          (socket): socket is string => socket !== undefined,
        ),
      ],
    };
    const probed = yield* probeSandbox(runtime);
    if (probed !== true) {
      yield* stop;
      return probed === "timedOut"
        ? "srt's first sandbox did not finish in time"
        : "srt cannot start a sandbox on this machine";
    }
    sandbox = runtime;
    yield* Scope.addFinalizer(layerScope, stop);
    return undefined;
  });
  const startSandbox = sandboxLock.withPermits(1)(startSandboxHeld);

  /**
   * Whether srt's bridge still reaches this server's proxy: one local connection through its
   * socket, answered by the proxy in well under a millisecond. A second is a thousand times
   * that, so a bridge still silent then is stuck, not slow.
   */
  const bridgeAlive = (runtime: NonNullable<typeof sandbox>) =>
    Effect.callback<boolean>((resume) => {
      // On macOS and Windows srt has no bridge: the sandbox reaches this server's proxy port itself.
      if (runtime.bridge === undefined && platform !== "linux") {
        return resume(Effect.succeed(true));
      }
      const socket = runtime.bridge === undefined ? undefined : NodeNet.connect(runtime.bridge);
      if (socket === undefined) return resume(Effect.succeed(false));
      let answer = "";
      const done = (alive: boolean) => {
        socket.destroy();
        resume(Effect.succeed(alive));
      };
      socket.on("connect", () => socket.write("GET http://t3code-probe.invalid/ HTTP/1.0\r\n\r\n"));
      socket.on("data", (chunk) => {
        answer += chunk.toString("latin1");
        if (answer.startsWith("HTTP/")) done(true);
      });
      socket.on("error", () => done(false));
      socket.on("close", () => done(answer.startsWith("HTTP/")));
      return Effect.sync(() => socket.destroy());
    }).pipe(Effect.timeoutOrElse({ duration: "1 second", orElse: () => Effect.succeed(false) }));

  // What the last probe found, usable or not: the status shows it instead of probing again.
  let seen: Backends | undefined;
  const detect = Effect.gen(function* () {
    yield* sweep;
    const srtReason =
      platform === "linux" || platform === "darwin" || platform === "win32"
        ? yield* startSandbox
        : `srt does not run on ${platform}`;
    if (platform === "win32") {
      return probeBackends({
        platform,
        // The bridge prepared before srt-win runs threads only while srt-win cannot.
        windowsProblem:
          srtReason === undefined
            ? undefined
            : yield* windowsSandboxProblem(baseDir).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(Path.Path, path),
                Effect.provideService(HostProcess.Platform, platform),
              ),
        srtReason,
        srtWinInstalled,
        docker: null,
        dockerRunning: false,
        socat: false,
      });
    }
    if (platform !== "linux") {
      return probeBackends({
        platform,
        srtReason,
        docker: null,
        dockerRunning: false,
        socat: false,
      });
    }
    const docker = yield* which("docker");
    const info =
      docker === null ? undefined : yield* run(docker, ["info", "--format", "{{.ServerVersion}}"]);
    return probeBackends({
      platform,
      srtReason,
      docker,
      dockerRunning: info?.ok === true,
      dockerTimedOut: info?.timedOut === true,
      socat: (yield* which("socat")) !== null,
    });
  }).pipe(Effect.tap((backends) => Effect.sync(() => (seen = backends))));
  const usable = (backends: Backends) => backends.srt.ok || backends.docker.ok;

  // A launch never waits for a probe it already has an answer to: a stale answer is used while
  // one shared refresh runs in the background; only a first answer, or none, is awaited.
  let known: { readonly backends: Backends; readonly until: number } | undefined;
  const detectLock = yield* Semaphore.make(1);
  const refresh = detectLock.withPermits(1)(
    Effect.gen(function* () {
      const last = seen;
      const backends = yield* detect;
      const now = yield* Clock.currentTimeMillis;
      known = usable(backends) ? { backends, until: now + RECHECK_MILLIS } : undefined;
      // Clients hear of an answer that changed, such as srt-win removed meanwhile.
      if (last !== undefined && encodeJson(backends) !== encodeJson(last)) {
        yield* PubSub.publish(changes, undefined);
      }
      return backends;
    }),
  );
  let refreshing = false;
  const current = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (known !== undefined) {
      if (now >= known.until && !refreshing) {
        refreshing = true;
        yield* refresh.pipe(
          Effect.ensuring(Effect.sync(() => (refreshing = false))),
          Effect.forkIn(layerScope),
        );
      }
      return known.backends;
    }
    return yield* detectLock
      .withPermits(1)(
        Effect.suspend(() => (known === undefined ? detect : Effect.succeed(known.backends))),
      )
      .pipe(
        Effect.tap((backends) =>
          Effect.flatMap(Clock.currentTimeMillis, (at) =>
            Effect.sync(() => {
              if (known === undefined && usable(backends)) {
                known = { backends, until: at + RECHECK_MILLIS };
              }
            }),
          ),
        ),
      );
  });
  // A backend that failed a launch is looked at again before the next one.
  const forget = Effect.sync(() => {
    known = undefined;
  });

  /**
   * Git configuration the server would read when it runs git in this folder, outside the
   * sandbox, stays read-only, including files git would read that do not exist yet; they are
   * created (empty, or pointing at the repository itself) so they can be held. A commit,
   * branch, stash or rebase writes only the paths left writable.
   */
  const createIfMissing = (file: string, text: string) =>
    fs.writeFileString(file, text, { flag: "wx" }).pipe(Effect.ignore);
  const makeFolderIfMissing = (folder: string) => fs.makeDirectory(folder).pipe(Effect.ignore);
  const otherWorktrees = (gitFolder: string, own: string | undefined) =>
    fs.readDirectory(path.join(gitFolder, "worktrees")).pipe(
      Effect.map((names) =>
        names.map((name) => path.join(gitFolder, "worktrees", name)).filter((dir) => dir !== own),
      ),
      Effect.orElseSucceed((): Array<string> => []),
    );
  /**
   * A whole git folder (a repository's .git, or a separate one): writable for commits, branch
   * deletion, pack-refs and gc, with everything git reads as configuration or executes held.
   */
  const holdGitFolder = Effect.fn("ThreadIsolation.holdGitFolder")(function* (
    gitFolder: string,
    own: string | undefined,
  ) {
    for (const folder of ["hooks", "info", "modules"]) {
      yield* makeFolderIfMissing(path.join(gitFolder, folder));
    }
    yield* createIfMissing(path.join(gitFolder, "commondir"), ".\n");
    yield* createIfMissing(path.join(gitFolder, "config.worktree"), "");
    return [
      ...["config", "config.worktree", "commondir", "hooks", "info", "modules"].map((name) =>
        path.join(gitFolder, name),
      ),
      ...(yield* otherWorktrees(gitFolder, own)),
    ];
  });

  /** Whether the folder is a Git checkout as gitPolicy reads it; srt's empty .git is not one. */
  const isRepositoryFolder = (cwd: string) =>
    fs.stat(path.join(cwd, ".git")).pipe(
      Effect.map(
        (stat) => stat.type === "Directory" || (stat.type === "File" && Number(stat.size) > 0),
      ),
      Effect.orElseSucceed(() => false),
    );

  const gitPolicy = Effect.fn("ThreadIsolation.gitPolicy")(function* (cwd: string) {
    const dotGit = path.join(cwd, ".git");
    if (yield* isLink(dotGit)) {
      return yield* fail("Thread isolation refuses a .git that is a link.");
    }
    const stat = yield* fs.stat(dotGit).pipe(Effect.option);
    // An empty .git file is the placeholder srt holds in a folder without git.
    if (stat._tag === "None" || (stat.value.type === "File" && Number(stat.value.size) === 0)) {
      return {
        isRepository: false,
        writable: [] as Array<string>,
        readable: [] as Array<string>,
        protected: [dotGit],
      };
    }
    if (stat.value.type === "Directory") {
      return {
        isRepository: true,
        // Its own mount, so the thread cannot swap the whole folder for one of its own.
        writable: [dotGit],
        readable: [] as Array<string>,
        protected: [...(yield* holdGitFolder(dotGit, undefined))],
      };
    }
    const pointer = yield* fs.readFileString(dotGit).pipe(Effect.option);
    const match = pointer._tag === "Some" ? /^gitdir: (.+)$/m.exec(pointer.value) : null;
    if (match === null) return yield* fail("Thread isolation could not read this folder's .git.");
    const gitDir = path.resolve(cwd, match[1]!.trim());
    if (yield* isLink(gitDir)) {
      return yield* fail("Thread isolation refuses a gitdir that is a link.");
    }
    const commondir = yield* fs.readFileString(path.join(gitDir, "commondir")).pipe(Effect.option);
    // A submodule checkout or --separate-git-dir: its git folder is a whole repository's.
    if (commondir._tag === "None" || commondir.value.trim() === ".") {
      return {
        isRepository: true,
        writable: [gitDir],
        readable: [] as Array<string>,
        protected: [dotGit, ...(yield* holdGitFolder(gitDir, undefined))],
      };
    }
    const common = path.resolve(gitDir, commondir.value.trim());
    yield* createIfMissing(path.join(gitDir, "config.worktree"), "");
    return {
      isRepository: true,
      writable: [common, gitDir],
      readable: [] as Array<string>,
      protected: [
        dotGit,
        ...["commondir", "gitdir", "config.worktree"].map((name) => path.join(gitDir, name)),
        ...(yield* holdGitFolder(common, gitDir)),
        // The main checkout's own state.
        ...(yield* existing(["HEAD", "index"].map((name) => path.join(common, name)))),
      ],
    };
  });

  // Tools the host's own threads use (npm, pnpm, corepack, compilers): each folder on the
  // server's PATH, read-only, with the install folders its links point into. Found once.
  const toolRoots = yield* Effect.cached(
    Effect.gen(function* () {
      const roots = new Set<string>();
      for (const folder of (hostEnvironment.PATH ?? "").split(platform === "win32" ? ";" : ":")) {
        if (!path.isAbsolute(folder) || folder === home || !(yield* exists(folder))) continue;
        if (SYSTEM_FOLDERS.some((system) => folder === system || folder.startsWith(`${system}/`))) {
          continue;
        }
        roots.add(folder);
        // Windows installs start tools through shims, not links: no folder there is read whole.
        if (platform === "win32") continue;
        for (const name of yield* fs.readDirectory(folder).pipe(Effect.orElseSucceed(() => []))) {
          const entry = path.join(folder, name);
          if (!(yield* isLink(entry))) continue;
          const root = installRoot(path, yield* realPath(entry), home);
          if (root !== undefined) roots.add(root);
          // npm and its kind live at <prefix>/lib/node_modules beside <prefix>/bin.
          const prefix = path.dirname(folder);
          if (path.basename(folder) === "bin" && installRoot(path, folder, home) !== undefined) {
            const modules = path.join(prefix, "lib", "node_modules");
            if (yield* exists(modules)) roots.add(modules);
          }
        }
      }
      return [...roots];
    }),
  );

  // The server's git is hardened through GIT_CONFIG_COUNT, which an older Git ignores.
  const gitTooOld = yield* Effect.cachedWithTTL(
    run("git", ["--version"]).pipe(
      Effect.map(({ stdout }) => {
        const version = /(\d+)\.(\d+)/.exec(stdout);
        return version !== null && Number(version[1]) * 100 + Number(version[2]) < 231;
      }),
    ),
    RECHECK_MILLIS,
  );

  // Asked of git at each launch (one rev-parse), so a hooks path set a moment ago is held too.
  const hooksFolder = Effect.fn("ThreadIsolation.hooksFolder")(function* (cwd: string) {
    const found = yield* runIn(cwd, "git", ["rev-parse", "--git-path", "hooks"]);
    if (found.timedOut) {
      return yield* fail(
        `Thread isolation: git did not answer in time where this repository's hooks are, so it cannot keep them from the thread. Try again, ${TURN_OFF}.`,
      );
    }
    if (!found.ok || found.stdout === "") {
      return yield* fail(
        `Thread isolation could not ask git where this repository's hooks are, so it cannot keep them from the thread. Check that git works in this folder, ${TURN_OFF}.`,
      );
    }
    return path.resolve(cwd, found.stdout);
  });

  // Files the folder's git configuration includes, from any scope, whether they exist or not.
  const includedFiles = Effect.fn("ThreadIsolation.includedFiles")(function* (cwd: string) {
    const found = yield* runIn(cwd, "git", [
      "config",
      "-z",
      "--includes",
      "--show-origin",
      "--type=path",
      "--get-regexp",
      "^include(if\\..*)?\\.path$",
    ]);
    if (found.timedOut) {
      return yield* fail(
        `Thread isolation: git did not answer in time which files this repository's configuration includes, so it cannot keep them from the thread. Try again, ${TURN_OFF}.`,
      );
    }
    // Each entry is its origin, then the key and the value on two lines.
    const parts = found.stdout.split("\0");
    return parts.flatMap((origin, index) => {
      const entry = parts[index + 1];
      if (index % 2 === 1 || !origin.startsWith("file:") || entry === undefined) return [];
      const from = path.dirname(path.resolve(cwd, origin.slice("file:".length)));
      return [path.resolve(from, entry.slice(entry.indexOf("\n") + 1))];
    });
  });

  /**
   * Why a real path cannot be given to a thread: the home folder or one holding it, T3 Code's
   * own data (settings, secrets, other threads' sign-ins) inside or around it, and, for a path
   * a provider's settings name, a system folder.
   */
  const folderRefusal = Effect.fn("ThreadIsolation.folderRefusal")(function* (
    folder: string,
    system = true,
  ) {
    const chain = Effect.fn("ThreadIsolation.pathChain")(function* (entry: string) {
      const links: Array<string> = [];
      let current = entry;
      while (true) {
        const info = yield* fs.stat(current).pipe(Effect.option);
        links.push(
          info._tag === "Some" && Option.isSome(info.value.ino)
            ? `${info.value.dev}:${info.value.ino.value}`
            : `name:${current.normalize("NFC")}`,
        );
        const parent = path.dirname(current);
        if (parent === current) return links;
        current = parent;
      }
    });
    // A folder reached through a link has the folders above its target above it too.
    const chains = Effect.fn("ThreadIsolation.pathChains")(function* (entry: string) {
      const real = yield* fs.realPath(entry).pipe(Effect.orElseSucceed(() => entry));
      return [...new Set([...(yield* chain(real)), ...(yield* chain(entry))])];
    });
    return folderRefusalReason({
      folder: yield* chains(folder),
      home: yield* chains(home),
      data: [yield* chains(baseDir), yield* chains(stateDir)],
      system: system ? yield* Effect.forEach(systemFoldersOf(platform), chains) : [],
    });
  });

  /** What git reads as configuration or runs in a folder a thread may write, held from it. */
  const gitProtection = Effect.fn("ThreadIsolation.gitProtection")(function* (cwd: string) {
    const git = yield* gitPolicy(cwd);
    if (git.isRepository) {
      // Hooks run on the host for the owner's own git, and the server's once isolation is off.
      // The whole top-level entry holding them stays read-only (all of .husky for husky's
      // .husky/_), so neither their folder, a parent nor a script a hook runs from there can be
      // renamed, replaced or edited.
      const hooks = yield* hooksFolder(cwd);
      const ownerOf = (target: string) =>
        [cwd, ...git.writable]
          .filter((folder) => target === folder || target.startsWith(`${folder}${path.sep}`))
          .toSorted((a, b) => b.length - a.length)[0];
      // Whether the entry was not held before.
      const hold = Effect.fn("ThreadIsolation.holdEntry")(function* (
        owner: string,
        target: string,
        what: string,
      ) {
        const held = path.join(owner, path.relative(owner, target).split(path.sep)[0]!);
        if (
          git.protected.some((entry) => held === entry || held.startsWith(`${entry}${path.sep}`))
        ) {
          return false;
        }
        if (yield* isLink(held)) {
          return yield* fail(`Thread isolation refuses ${what} that is a link.`);
        }
        git.protected.push(held);
        return true;
      });
      const owner = ownerOf(hooks);
      if (owner !== undefined) {
        if (hooks === owner) {
          return yield* fail(
            `Thread isolation cannot keep hooks from the thread when they are its whole folder. Set core.hooksPath elsewhere, ${TURN_OFF}.`,
          );
        }
        if (yield* hold(owner, hooks, "a hooks folder")) {
          yield* fs.makeDirectory(hooks, { recursive: true }).pipe(Effect.ignore);
        }
      }
      // A file the configuration includes from the checkout (a shared, tracked one) is
      // configuration too: its gpg.program or filter would run on the host. Held like hooks.
      for (const file of yield* includedFiles(cwd)) {
        const from = ownerOf(file);
        if (from === undefined || from === file) continue;
        if (yield* hold(from, file, "an included Git configuration file")) {
          yield* fs.makeDirectory(path.dirname(file), { recursive: true }).pipe(Effect.ignore);
          yield* createIfMissing(file, "");
        }
      }
    }
    return git;
  });

  /**
   * The owner's extra folders, as real paths. Never the home folder or one holding it, nor
   * T3 Code's own data (settings, secrets, other threads' sign-ins), inside or around it.
   */
  const ownerFolders = Effect.fn("ThreadIsolation.ownerFolders")(function* (
    chosen: ThreadIsolationPolicy,
    place: (field: PolicyField) => string,
    /** The git folders of the thread's own checkout, which its own protection decides. */
    own: ReadonlyArray<string>,
  ) {
    if (chosen.writableFolders.length === 0 && chosen.readableFolders.length === 0) {
      return { writable: [], readable: [], protected: [] };
    }
    const resolve = (field: "writableFolders" | "readableFolders") =>
      Effect.fn("ThreadIsolation.ownerFolder")(function* (folder: string) {
        const refuse = (reason: string) =>
          fail(
            `Thread isolation cannot give this thread the folder ${folder}: ${reason}. Correct it in ${place(field)}.`,
          );
        const found = path.isAbsolute(folder)
          ? yield* fs.realPath(folder).pipe(Effect.option)
          : Option.none();
        if (found._tag === "None") return yield* refuse("it must be an existing absolute path");
        const refused = yield* folderRefusal(found.value, false);
        if (refused !== undefined) return yield* refuse(refused);
        return found.value;
      });
    const writable = yield* Effect.forEach(chosen.writableFolders, resolve("writableFolders"));
    // The server runs git in a repository among them as in the thread's own folder, so its
    // git is held and the folder recorded the same way.
    const git = yield* Effect.forEach(
      yield* Effect.filter(writable, isRepositoryFolder),
      gitProtection,
    ).pipe(
      Effect.tap(() => markFolder(writable)),
      Effect.mapError((error) =>
        error._tag === "ThreadIsolationError"
          ? error
          : new ThreadIsolationError({
              detail: `Thread isolation could not read the folders in ${place("writableFolders")}.`,
            }),
      ),
    );
    // The thread's own protection decides its own git folders and what lies in them; Docker
    // also refuses a folder mounted twice.
    const ownGit = (entry: string) =>
      own.some((folder) => entry === folder || entry.startsWith(`${folder}${path.sep}`));
    return {
      writable: [...writable, ...git.flatMap((entry) => entry.writable)].filter(
        (entry) => !ownGit(entry),
      ),
      readable: yield* Effect.forEach(chosen.readableFolders, resolve("readableFolders")),
      // Another checkout of the thread's own repository would hold the thread's own git
      // folder (a worktree's, its HEAD and index) as another checkout's.
      protected: git.flatMap((entry) => entry.protected).filter((entry) => !ownGit(entry)),
    };
  });

  const policyFor = Effect.fn("ThreadIsolation.policyFor")(function* (
    input: WrapInput,
    executable: string,
    cwd: string,
  ) {
    const roots = [installRoot(path, executable, home)];
    if (
      executable.includes(`${path.sep}node_modules${path.sep}`) ||
      /\.[cm]?js$/.test(executable)
    ) {
      const node = yield* which("node", input.env.PATH ? input.env : hostEnvironment);
      if (node !== null) roots.push(installRoot(path, yield* realPath(node), home));
    }
    if (roots.includes(undefined)) {
      return yield* fail(
        `Thread isolation will not expose the folder holding ${input.command}, because it is your home folder or holds it. Install the CLI in its own folder, ${TURN_OFF}.`,
      );
    }
    const git = yield* gitProtection(cwd);
    return { roots: [...(roots as Array<string>), ...(yield* toolRoots)], git };
  });

  // The host's git identity, read-only, so commits work as they do outside.
  const gitIdentity = Effect.gen(function* () {
    const file = path.join(serverFolder, "gitconfig");
    const name = (yield* run("git", ["config", "--global", "user.name"])).stdout;
    const email = (yield* run("git", ["config", "--global", "user.email"])).stdout;
    const quote = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
    yield* writeAtomically(
      file,
      name || email
        ? `[user]\n${name ? `\tname = ${quote(name)}\n` : ""}${email ? `\temail = ${quote(email)}\n` : ""}`
        : "",
    );
    return file;
  });
  const identity = yield* Effect.cached(gitIdentity.pipe(Effect.option));

  // What each key's launches left to undo; a key with no entry was never wrapped.
  interface Launched {
    readonly proxyIds: Array<string>;
    readonly containers: Array<string>;
    srtWraps: number;
    /** The shared sign-in this key uses, and the private path that links to it. */
    credential?: { readonly account: string; readonly copy: string };
    /** On Windows: the start of this key's srt-win holder, shared by its launches. */
    holding?: Promise<{ readonly pid: number; readonly release: () => void }> | undefined;
    /** On Windows: the process this key's srt-win grants are held by. */
    holder?: {
      readonly pid: number;
      readonly release: () => void;
      readonly program: string;
      readonly account: string;
    };
  }
  const launches = new Map<string, Launched>();

  /**
   * One sign-in copy per provider account, linked into every live isolated session, so one
   * session's refresh reaches the others. It returns to the host only while the host's file is
   * as seeded, else the host's wins. Threads write only `share/`, not what the server compares.
   */
  interface Account {
    readonly provider: IsolatedProvider;
    readonly real: string;
    readonly folder: string;
    readonly file: string;
    seeded: string | undefined;
    users: number;
  }
  const accounts = new Map<string, Account>();
  // A refreshed sign-in has the seeded one's fields with new token values: twice its size
  // leaves room for longer tokens, and anything larger is not a refresh of it.
  const threadWrittenLimit = (seeded: string) => 2 * Buffer.byteLength(seeded);
  const credentialsRoot = path.join(root, "credentials");
  const AccountSource = Schema.Struct({
    provider: Schema.Literals(["claude", "codex"]),
    real: Schema.String,
  });
  const decodeAccountSource = Schema.decodeOption(Schema.fromJsonString(AccountSource));

  /**
   * Brings the shared copy and the host's file together by the rule above. Whatever else the
   * thread left in share/ (a folder, a link, an incomplete or other sign-in) is replaced from
   * the host's copy. It never fails: one thread's damage must not stop another's launch.
   */
  const syncAccount = Effect.fn("ThreadIsolation.syncAccount")(
    function* (account: Account) {
      const real = readRegularFile(account.real);
      const shared =
        account.seeded === undefined
          ? undefined
          : readRegularFile(account.file, threadWrittenLimit(account.seeded));
      // A rename replaces a regular file at once, so a live session never finds it missing;
      // only a folder or link the thread put there is removed first.
      const replaceShared = Effect.fn("ThreadIsolation.replaceShared")(function* (text: string) {
        const stat = yield* fs.stat(account.file).pipe(Effect.option);
        if ((yield* isLink(account.file)) || (stat._tag === "Some" && stat.value.type !== "File")) {
          yield* fs.remove(account.file, { recursive: true, force: true });
        }
        yield* writeAtomically(account.file, text);
      });
      if (real !== undefined && real !== account.seeded && isCredential(real)) {
        yield* replaceShared(real);
        account.seeded = real;
      } else if (
        shared !== undefined &&
        mayCopyBack({ provider: account.provider, copy: shared, real, seeded: account.seeded })
      ) {
        yield* writeAtomically(account.real, shared);
        account.seeded = shared;
      } else {
        if (shared !== account.seeded && account.seeded !== undefined) {
          yield* replaceShared(account.seeded);
        }
        return;
      }
      yield* writeAtomically(path.join(account.folder, "seeded"), account.seeded);
    },
    (effect) => Effect.ignore(effect),
  );

  // First use and last release of an account happen one at a time, so two sessions starting
  // together share one entry and a live session's copy is never removed under it.
  const accountLock = yield* Semaphore.make(1);

  const useAccount = Effect.fn("ThreadIsolation.useAccount")(function* (
    provider: IsolatedProvider,
    real: string,
    name: string,
  ) {
    const key = keyOf(`${provider}:${real}`);
    let account = accounts.get(key);
    if (account === undefined) {
      const folder = path.join(credentialsRoot, key);
      account = {
        provider,
        real,
        folder,
        file: path.join(folder, "share", name),
        seeded: undefined,
        users: 0,
      };
      yield* fs.makeDirectory(path.join(folder, "share"), { recursive: true });
      yield* writeAtomically(path.join(folder, "source"), encodeJson({ provider, real }));
      accounts.set(key, account);
    }
    account.users += 1;
    yield* syncAccount(account);
    return key;
  }, accountLock.withPermits(1));

  /** A sign-in the session's CLI wrote in place of the link (on Windows, its copy) counts. */
  const returnCopy = Effect.fn("ThreadIsolation.returnCopy")(function* (
    credential: NonNullable<Launched["credential"]>,
  ) {
    const account = accounts.get(credential.account);
    if (account === undefined) return;
    const limit = account.seeded === undefined ? 0 : threadWrittenLimit(account.seeded);
    const own = readRegularFile(credential.copy, limit);
    const shared = readRegularFile(account.file, limit);
    if (
      own !== undefined &&
      mayCopyBack({ provider: account.provider, copy: own, real: shared, seeded: shared })
    ) {
      yield* writeAtomically(account.file, own).pipe(Effect.ignore);
    }
  });

  /** A session ends: its own sign-in counts, then the host syncs. */
  const leaveAccount = Effect.fn("ThreadIsolation.leaveAccount")(function* (
    credential: NonNullable<Launched["credential"]>,
  ) {
    const account = accounts.get(credential.account);
    if (account === undefined) return;
    yield* returnCopy(credential);
    yield* syncAccount(account);
    account.users -= 1;
    if (account.users <= 0) {
      accounts.delete(credential.account);
      yield* fs.remove(account.folder, { recursive: true, force: true }).pipe(Effect.ignore);
    }
  }, accountLock.withPermits(1));

  /**
   * A folder of the server's own in the private state: whatever the thread left there under
   * its name (a link, a file) is replaced, so the session starts again as usual.
   */
  const ownFolder = Effect.fn("ThreadIsolation.ownFolder")(function* (folder: string) {
    const stat = yield* fs.stat(folder).pipe(Effect.option);
    if ((yield* isLink(folder)) || (stat._tag === "Some" && stat.value.type !== "Directory")) {
      yield* fs.remove(folder, { recursive: true, force: true });
    }
    yield* fs.makeDirectory(folder, { recursive: true });
  });

  /**
   * `link` names `target`. An ordinary Windows user can make a junction but no symbolic link,
   * so there a folder is a junction and a file a copy, made fresh where nothing is.
   */
  const linkTo = Effect.fn("ThreadIsolation.linkTo")(function* (target: string, link: string) {
    if (platform !== "win32") return yield* fs.symlink(target, link);
    const stat = yield* fs.stat(target).pipe(Effect.option);
    if (stat._tag === "None") return;
    yield* Effect.tryPromise({
      try: () =>
        stat.value.type === "Directory"
          ? NodeFS.promises.symlink(target, link, "junction")
          : NodeFS.promises.copyFile(target, link, NodeFS.constants.COPYFILE_EXCL),
      catch: failWith("Thread isolation could not link your settings into the thread's folder."),
    });
  });

  /**
   * A link in the private HOME, which an earlier launch of the session has handed to the
   * thread: every folder on the way is the server's own, checked after it is made.
   */
  const linkInHome = Effect.fn("ThreadIsolation.linkInHome")(function* (
    privateHome: string,
    name: string,
    target: string,
  ) {
    let folder = privateHome;
    for (const part of path
      .dirname(name)
      .split(path.sep)
      .filter((part) => part !== "." && part !== "")) {
      folder = path.join(folder, part);
      yield* ownFolder(folder);
    }
    if (
      (yield* fs.realPath(folder)) !==
      path.join(yield* fs.realPath(privateHome), path.dirname(name))
    ) {
      return yield* fail("Thread isolation found a link where it makes your sign-in folder's.");
    }
    const link = path.join(folder, path.basename(name));
    yield* fs.remove(link, { recursive: true, force: true });
    yield* linkTo(target, link);
  });

  /** Links `name` in the private folder to the owner's real entry, and returns what it exposes. */
  const linkOwnerEntry = Effect.fn("ThreadIsolation.linkOwnerEntry")(function* (
    source: string,
    link: string,
  ) {
    const resolved = yield* realPath(source);
    yield* fs.remove(link, { recursive: true, force: true });
    yield* linkTo(resolved, link);
    const exposed = [resolved];
    // Skills, commands and the like are often links to the owner's own checkouts.
    const stat = yield* fs.stat(resolved).pipe(Effect.option);
    if (stat._tag === "Some" && stat.value.type === "Directory") {
      for (const name of yield* fs.readDirectory(resolved).pipe(Effect.orElseSucceed(() => []))) {
        const entry = path.join(resolved, name);
        if (yield* isLink(entry)) exposed.push(yield* realPath(entry));
      }
    }
    return exposed;
  });

  /** Owner files the provider's own settings name: helper scripts, and the variables it sets. */
  const claudeSettings = Effect.fn("ThreadIsolation.claudeSettings")(function* (real: string) {
    const text = yield* fs
      .readFileString(path.join(real, "settings.json"))
      .pipe(Effect.orElseSucceed(() => ""));
    const parsed = Option.getOrUndefined(decodeClaudeSettings(text));
    const commands = [
      parsed?.apiKeyHelper,
      parsed?.awsAuthRefresh,
      parsed?.awsCredentialExport,
      parsed?.gcpAuthRefresh,
    ];
    const scripts = commands.flatMap((command) =>
      (command ?? "").split(/\s+/).flatMap((word) => {
        const file = word.startsWith("~/") ? path.join(home, word.slice(2)) : word;
        return path.isAbsolute(file) ? [file] : [];
      }),
    );
    return { env: parsed?.env ?? {}, readable: yield* existing(scripts) };
  });

  // Codex keeps a thread's conversation in rollout files; a thread's own outlive its sessions,
  // beside the owner's, so it resumes after a close or a restart.
  const codexSessions = Effect.fn("ThreadIsolation.codexSessions")(function* (
    real: string,
    thread: string,
    resumed: string | undefined,
  ) {
    const folder = path.join(real, "sessions", "t3code-isolated", keyOf(thread));
    yield* fs.makeDirectory(folder, { recursive: true });
    if (resumed === undefined || !/^[0-9a-f-]{36}$/i.test(resumed)) return folder;
    const own = yield* fs
      .readDirectory(folder, { recursive: true })
      .pipe(Effect.orElseSucceed(() => []));
    if (own.some((name) => name.endsWith(`${resumed}.jsonl`))) return folder;
    // A conversation started before isolation moves in, so only one copy keeps growing.
    const sessions = path.join(real, "sessions");
    const dated = (folder: string) =>
      fs.readDirectory(folder).pipe(
        Effect.map((names) => names.filter((name) => /^\d+$/.test(name))),
        Effect.orElseSucceed((): Array<string> => []),
      );
    for (const year of yield* dated(sessions)) {
      for (const month of yield* dated(path.join(sessions, year))) {
        for (const day of yield* dated(path.join(sessions, year, month))) {
          const at = path.join(sessions, year, month, day);
          const names = yield* fs.readDirectory(at).pipe(Effect.orElseSucceed(() => []));
          const found = names.find((name) => name.endsWith(`${resumed}.jsonl`));
          if (found !== undefined) {
            yield* fs.rename(path.join(at, found), path.join(folder, found));
            return folder;
          }
        }
      }
    }
    return folder;
  });

  /** The thread's private HOME and provider folder; the server writes nothing a link could redirect. */
  const prepareState = Effect.fn("ThreadIsolation.prepareState")(function* (
    input: OwnInput,
    launched: Launched,
    stateKey: string,
    cwd: string,
  ) {
    const layout = providerLayout(path, input.provider, input.env, home);
    const state = path.join(root, stateKey);
    const privateHome = path.join(state, "home");
    const tmp = path.join(state, "tmp");
    const config = path.join(privateHome, layout.folder);
    for (const folder of [state, privateHome, tmp, config]) yield* ownFolder(folder);
    const copyCredential = path.join(config, layout.credential);
    if (launched.credential === undefined) {
      const account = yield* useAccount(
        input.provider,
        path.join(layout.real, layout.credential),
        layout.credential,
      );
      launched.credential = { account, copy: copyCredential };
    } else {
      // Before the private copy is made again from the shared one.
      yield* returnCopy(launched.credential);
      yield* syncAccount(accounts.get(launched.credential.account)!);
    }
    const shareFolder = path.dirname(accounts.get(launched.credential.account)!.file);
    yield* fs.remove(copyCredential, { force: true });
    // A copy on Windows: it returns at release by the rule a sign-in written in its place does.
    yield* linkTo(path.join(shareFolder, layout.credential), copyCredential);
    // The owner's configuration, through links to the real entries, read-only.
    const settingsRead: Array<string> = [];
    for (const name of yield* fs.readDirectory(layout.real).pipe(Effect.orElseSucceed(() => []))) {
      if (layout.private(name)) continue;
      settingsRead.push(
        ...(yield* linkOwnerEntry(path.join(layout.real, name), path.join(config, name))),
      );
    }
    const configured =
      input.provider === "claude"
        ? yield* claudeSettings(layout.real)
        : { env: {}, readable: [] as Array<string> };
    settingsRead.push(...configured.readable);
    if (input.provider === "claude") {
      // The owner's MCP servers and this folder's own entry (its local servers and approvals);
      // not the history of other projects.
      const real = Option.getOrUndefined(
        Option.flatMap(
          Option.fromNullishOr(
            readRegularFile(
              layout.real === path.join(home, ".claude")
                ? path.join(home, ".claude.json")
                : path.join(layout.real, ".claude.json"),
            ),
          ),
          decodeClaudeState,
        ),
      );
      const projects = Object.fromEntries(
        Object.entries(real?.projects ?? {}).filter(
          ([folder]) =>
            folder === cwd || folder === input.cwd || cwd.startsWith(`${folder}${path.sep}`),
        ),
      );
      yield* writeAtomically(
        path.join(config, ".claude.json"),
        encodeJson({
          hasCompletedOnboarding: true,
          ...(real?.mcpServers ? { mcpServers: real.mcpServers } : {}),
          projects,
        }),
      );
    }
    // T3 Code reads these from the real folder, so they stay there: this folder's transcripts
    // and this session's task list, or this thread's Codex conversations, nothing of other
    // projects. Their parent folders are read-only, so the thread cannot point them elsewhere.
    const shared: Array<string> = [];
    const sharedParents: Array<string> = [];
    const entries: Array<readonly [string, string, string]> = [];
    if (input.provider === "claude") {
      entries.push([
        "projects",
        claudeProjectFolder(cwd),
        path.join(layout.real, "projects", claudeProjectFolder(cwd)),
      ]);
      if (input.session) {
        const name = input.session.replace(/[^a-zA-Z0-9_-]/g, "-");
        entries.push(["tasks", name, path.join(layout.real, "tasks", name)]);
      }
    } else if (input.thread !== undefined) {
      // Runs outside a thread (titles, commit messages) are ephemeral and keep nothing.
      const folder = yield* codexSessions(layout.real, input.thread, input.session);
      entries.push(["", "sessions", folder]);
    }
    for (const [parent, name, target] of entries) {
      yield* fs.makeDirectory(target, { recursive: true });
      const parentFolder = path.join(config, parent);
      if (parent !== "") {
        yield* fs.remove(parentFolder, { recursive: true, force: true });
        yield* fs.makeDirectory(parentFolder);
        sharedParents.push(parentFolder);
      } else {
        yield* fs.remove(path.join(config, name), { recursive: true, force: true });
      }
      const resolved = yield* realPath(target);
      yield* linkTo(resolved, path.join(parentFolder, name));
      shared.push(resolved);
    }
    return {
      state,
      privateHome,
      tmp,
      config,
      layout,
      shared: [...shared, shareFolder],
      sharedParents,
      settingsRead,
      configured: configured.env,
      cwd,
    };
  });

  const dockerLock = yield* Semaphore.make(1);
  let dockerChecked: { readonly system: ReadonlyArray<string>; readonly until: number } | undefined;

  const imageRoot = path.join(root, "rootfs");
  // An empty root that keeps the host's /usr-merge links; docker-init needs a real /sbin.
  const buildImage = Effect.fn("ThreadIsolation.buildImage")(function* (docker: string) {
    yield* fs.remove(imageRoot, { recursive: true, force: true });
    yield* fs.makeDirectory(path.join(imageRoot, "sbin"), { recursive: true });
    for (const name of ["bin", "lib", "lib32", "lib64", "libx32"]) {
      const target = yield* fs.readLink(path.join("/", name)).pipe(Effect.option);
      if (target._tag === "Some") yield* fs.symlink(target.value, path.join(imageRoot, name));
    }
    return yield* run("/bin/sh", [
      "-c",
      'tar -C "$1" -cf - . | "$2" import - "$3"',
      "t3code-isolation",
      imageRoot,
      docker,
      DOCKER_IMAGE,
    ]);
  });

  const prepareDocker = Effect.fn("ThreadIsolation.prepareDocker")(function* (docker: string) {
    const now = yield* Clock.currentTimeMillis;
    const { socket: proxySocket } = yield* ensureProxy;
    if (proxySocket === undefined) return yield* fail("Thread isolation runs no Docker here.");
    if (dockerChecked !== undefined && now < dockerChecked.until) {
      return { proxySocket, system: dockerChecked.system };
    }
    const image = yield* run(docker, ["image", "inspect", DOCKER_IMAGE]);
    if (image.timedOut) {
      return yield* fail(
        `Thread isolation: Docker did not answer in time. Try again, ${TURN_OFF}.`,
      );
    }
    if (!image.ok) {
      const built = yield* buildImage(docker).pipe(
        Effect.orElseSucceed(() => ({ ok: false, stdout: "", timedOut: false })),
      );
      if (built.timedOut) {
        return yield* fail(
          `Thread isolation: creating its Docker image did not finish in time. Try again, ${TURN_OFF}.`,
        );
      }
      if (!built.ok) return yield* fail("Thread isolation could not create its Docker image.");
    }
    const system: Array<string> = [];
    for (const name of SYSTEM_FOLDERS) {
      if (!(yield* isLink(name)) && (yield* exists(name))) system.push(name);
    }
    system.push(...(yield* existing(SYSTEM_FILES.filter((file) => !DOCKER_OWNED_FILES.has(file)))));
    dockerChecked = { system, until: now + RECHECK_MILLIS };
    return { proxySocket, system };
  });

  // Nothing survives a server's end: folders of earlier runs go, a sign-in a crashed run
  // refreshed goes back to the host first by the same rule, and so do this server's containers
  // Docker kept because their client died. Done on first use, so with the setting off nothing
  // looks.
  const foldersFile = path.join(root, "folders");
  const sweep = yield* Effect.cached(
    Effect.gen(function* () {
      if (!(yield* exists(root))) return;
      for (const key of yield* fs
        .readDirectory(credentialsRoot)
        .pipe(Effect.orElseSucceed(() => []))) {
        const folder = path.join(credentialsRoot, key);
        const source = Option.getOrUndefined(
          Option.flatMap(
            Option.fromNullishOr(readRegularFile(path.join(folder, "source"))),
            decodeAccountSource,
          ),
        );
        if (source === undefined || accounts.has(key)) continue;
        const name = providerLayout(path, source.provider, {}, home).credential;
        yield* syncAccount({
          provider: source.provider,
          real: source.real,
          folder,
          file: path.join(folder, "share", name),
          seeded: readRegularFile(path.join(folder, "seeded")),
          users: 0,
        }).pipe(Effect.ignore);
      }
      for (const entry of yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []))) {
        if (entry !== "rootfs" && entry !== "folders") {
          yield* fs
            .remove(path.join(root, entry), { recursive: true, force: true })
            .pipe(Effect.ignore);
        }
      }
      const docker = platform === "linux" ? yield* which("docker") : null;
      if (docker !== null) {
        yield* run("/bin/sh", [
          "-c",
          `"$1" ps -aq --filter label=${DOCKER_LABEL}=${server} | xargs -r "$1" rm -f`,
          "t3code-isolation",
          docker,
        ]).pipe(Effect.forkIn(layerScope));
      }
    }),
  );

  // While isolation is on, from server start, the server's own git calls in folders isolated
  // threads used are hardened. It is checked at each call, so switched off, git runs as
  // without isolation at once.
  const isolatedFolders = new Set<string>();
  let foldersLoaded = false;
  const loadFolders = Effect.gen(function* () {
    if (foldersLoaded) return;
    foldersLoaded = true;
    const text = yield* fs.readFileString(foldersFile).pipe(Effect.orElseSucceed(() => ""));
    for (const folder of text.split("\n").filter(Boolean)) {
      isolatedFolders.add(folder);
      addIsolatedFolder(folder);
    }
  });
  setIsolationActive(enabled.pipe(Effect.tap((on) => (on ? loadFolders : Effect.void))));
  yield* Scope.addFinalizer(
    layerScope,
    Effect.sync(() => setIsolationActive(Effect.succeed(false))),
  );
  if (yield* enabled) yield* loadFolders;
  const markFolder = Effect.fn("ThreadIsolation.markFolder")(function* (
    folders: ReadonlyArray<string>,
  ) {
    const added = folders.filter((folder) => !isolatedFolders.has(folder));
    if (added.length === 0) return;
    for (const folder of added) {
      isolatedFolders.add(folder);
      addIsolatedFolder(folder);
    }
    const known = yield* fs.readFileString(foldersFile).pipe(Effect.orElseSucceed(() => ""));
    const lines = new Set([...known.split("\n").filter(Boolean), ...isolatedFolders]);
    yield* writeAtomically(foldersFile, `${[...lines].join("\n")}\n`);
  });

  const releaseNow = Effect.fn("ThreadIsolation.release")(function* (
    stateKey: string,
    launched: Launched,
  ) {
    launches.delete(stateKey);
    for (const id of launched.proxyIds) proxyHosts.delete(id);
    // srt removes the placeholders it made for absent protected paths once no sandbox runs.
    for (; launched.srtWraps > 0; launched.srtWraps -= 1) sandbox?.manager.cleanupAfterCommand();
    const { holder } = launched;
    // A holder still starting when its key ends is let go once it has.
    if (holder === undefined && launched.holding !== undefined) {
      const holding = launched.holding;
      yield* attempt("", () => holding).pipe(
        Effect.map((held) => held.release()),
        Effect.ignore,
      );
    }
    if (holder !== undefined) {
      yield* runner
        .run({
          command: holder.program,
          args: [
            "acl",
            "revoke",
            "--holder-pid",
            String(holder.pid),
            "--sandbox-user-sid",
            holder.account,
            "--json",
          ],
          timeout: "60 seconds",
          timeoutBehavior: "timedOutResult",
        })
        .pipe(Effect.ignore);
      holder.release();
    }
    const docker = launched.containers.length > 0 ? yield* which("docker") : null;
    if (docker !== null) yield* run(docker, ["rm", "-f", ...launched.containers]);
    if (launched.credential !== undefined) yield* leaveAccount(launched.credential);
    yield* fs
      .remove(path.join(root, stateKey), { recursive: true, force: true })
      .pipe(Effect.ignore);
  });

  /**
   * Launches that started without isolation while the setting was on, by launch key. A thread
   * is marked while any of its live launches is. A mark is set only for a live key (wrapped and
   * not yet released) and removed only by its own key, so no launch clears another's and none
   * outlives its release. In memory: after a restart a thread is marked at its next launch.
   */
  const marks = new Map<string, { readonly thread: string; readonly reason: string }>();
  const live = new Set<string>();
  // Session keys are not reused, so a wrap arriving after its key's release marks nothing.
  const released = new Set<string>();
  // Each marked thread with the reason of its latest marked launch.
  const markedThreads = () =>
    Object.fromEntries([...marks.values()].map((entry) => [entry.thread, entry.reason]));
  const changes = yield* PubSub.unbounded<void>();
  // Clients hear of a change only when what they show changes.
  const sameMarks = (a: Record<string, string>, b: Record<string, string>) =>
    Object.keys(a).length === Object.keys(b).length &&
    Object.entries(a).every(([thread, reason]) => b[thread] === reason);
  const changing = (change: () => void) =>
    Effect.suspend(() => {
      const before = markedThreads();
      change();
      return sameMarks(before, markedThreads())
        ? Effect.void
        : PubSub.publish(changes, undefined).pipe(Effect.asVoid);
    });
  const mark = (key: string, thread: string | undefined, reason: string | undefined) =>
    changing(() => {
      marks.delete(key);
      if (thread !== undefined && reason !== undefined && live.has(key)) {
        marks.set(key, { thread, reason });
      }
    });
  // Turned off, no session is isolated, so none is marked; turned on again, none is stale. The
  // status read while it is off clears them too, for a server whose changes are not streamed.
  yield* settings.subscribeChanges.pipe(
    Effect.flatMap((stream) =>
      Stream.runForEach(stream, (current) =>
        current.threadIsolation ? Effect.void : changing(() => marks.clear()),
      ),
    ),
    Effect.forkIn(layerScope),
    Effect.provideService(Scope.Scope, layerScope),
  );

  const release: ThreadIsolationShape["release"] = (key) => {
    const stateKey = keyOf(key);
    const launched = launches.get(stateKey);
    return changing(() => {
      live.delete(key);
      released.add(key);
      marks.delete(key);
    }).pipe(
      Effect.andThen(
        launched === undefined ? Effect.void : releaseNow(stateKey, launched).pipe(Effect.ignore),
      ),
    );
  };

  // With no usable backend every launch probes again, but a client's snapshot and each settings
  // change must not wait for that (a probe took 0.7 s where srt could not start): they show what
  // the last probe found while one probe runs, and clients hear of it if the answer changed.
  const shown = Effect.suspend(() => {
    const last = seen;
    if (known !== undefined || last === undefined) return current;
    if (refreshing) return Effect.succeed(last);
    refreshing = true;
    return refresh.pipe(
      Effect.ensuring(Effect.sync(() => (refreshing = false))),
      Effect.forkIn(layerScope),
      Effect.as(last),
    );
  });

  const status = Effect.gen(function* () {
    const stored = yield* settings.getSettings.pipe(Effect.option);
    if (stored._tag === "Some" && !stored.value.threadIsolation) {
      marks.clear();
      return undefined;
    }
    const choice = Option.match(stored, {
      onNone: () => "automatic" as const,
      onSome: (value) => value.threadIsolationPolicy.backend,
    });
    return {
      ...statusOf(yield* shown, platform, choice),
      ...(marks.size === 0 ? {} : { threads: markedThreads() }),
    };
  });

  // Where the owner set the value a refusal names: the thread's own choices or Settings.
  const placeOf = (own: ThreadIsolationOverride | undefined) => (field: PolicyField) =>
    own?.[field] === undefined ? "Settings" : "this thread's Isolation choices, in its menu";

  // The owner: "It should still start", unless they ask threads not to. Runs outside a thread
  // (titles, commit messages, probes) start as before.
  const notIsolated = (
    input: {
      readonly provider: string;
      readonly key: string;
      readonly thread?: string | undefined;
    },
    reason: string,
    policy: ThreadIsolationPolicy,
    place: (field: PolicyField) => string,
  ) =>
    policy.refuseUnisolated && input.thread !== undefined
      ? fail(
          `Thread isolation cannot sandbox this thread: ${reason}. Choose another sandbox, or set "Threads that cannot be sandboxed" to start them in ${place("refuseUnisolated")}, ${TURN_OFF}.`,
        )
      : Effect.logWarning(`Thread isolation: this ${input.provider} run starts without isolation`, {
          reason,
          thread: input.thread,
        }).pipe(Effect.andThen(mark(input.key, input.thread, reason)), Effect.as(undefined));

  const check: ThreadIsolationShape["check"] = Effect.fn("ThreadIsolation.check")(function* ({
    driver,
    thread,
    key,
  }) {
    const stored = yield* settings.getSettings.pipe(Effect.option);
    if (stored._tag === "Some" && !stored.value.threadIsolation) return;
    // Has the backends found before a launch.
    const backends = yield* current;
    // A provider process is decided where it is launched, in wrap.
    const notSpawned = NOT_SPAWNED[driver];
    if (notSpawned === undefined) return;
    const { policy, own } = effectivePolicy(Option.getOrUndefined(stored), thread);
    const detection = chooseBackend(backends, platform, policy.backend);
    if (!released.has(key)) live.add(key);
    yield* notIsolated(
      { provider: driver, key, thread },
      detection.backend === null ? detection.reason : notSpawned,
      policy,
      placeOf(own),
    );
  });

  const wrap: ThreadIsolationShape["wrap"] = Effect.fn("ThreadIsolation.wrap")(function* (input) {
    // One read of the settings gives both the switch and this thread's policy.
    const current_ = yield* settings.getSettings.pipe(Effect.option);
    if (!released.has(input.key)) live.add(input.key);
    if (current_._tag === "Some" && !current_.value.threadIsolation) {
      yield* mark(input.key, undefined, undefined);
      return undefined;
    }
    const { policy, own } = effectivePolicy(Option.getOrUndefined(current_), input.thread);
    const place = placeOf(own);
    const detection = chooseBackend(yield* current, platform, policy.backend);
    const launch = yield* launchOn(input, detection, policy, place).pipe(
      Effect.catchTags({
        NotIsolated: ({ reason }) => notIsolated(input, reason, policy, place),
      }),
      // A session that did not start, or started isolated, is not one without isolation.
      Effect.tapError(() => mark(input.key, undefined, undefined)),
    );
    if (launch !== undefined) yield* mark(input.key, undefined, undefined);
    return launch;
  });

  const launchOn = Effect.fn("ThreadIsolation.launchOn")(function* (
    input: WrapInput,
    detection: Detection,
    policy: ThreadIsolationPolicy,
    place: (field: PolicyField) => string,
  ) {
    // Whether the thread can be isolated at all is settled first: a policy it would not get
    // never stops it.
    if (detection.backend === null) return yield* new NotIsolated({ reason: detection.reason });
    const reason = notIsolatedReason(
      input.provider,
      detection.backend === "docker" ? "docker" : "srt",
      platform,
    );
    if (reason !== undefined) return yield* new NotIsolated({ reason });
    if (input.shell) {
      return yield* new NotIsolated({
        reason: "its command is a Windows command script, which a sandbox cannot start",
      });
    }
    if (yield* gitTooOld) {
      return yield* new NotIsolated({
        reason:
          "Git here is older than 2.31, so T3 Code's own Git commands could not be kept from running what the thread writes",
      });
    }
    if (!input.cwd) return yield* fail("Thread isolation needs this thread's project folder.");
    if (detection.backend === "docker" && !(yield* isRepositoryFolder(input.cwd))) {
      return yield* new NotIsolated({
        reason: "Docker isolation needs the thread's folder to be a Git repository",
      });
    }
    if (ownProvider(input.provider) === "codex" && detection.backend !== "windows") {
      const layout = providerLayout(path, "codex", input.env, home);
      const config = readRegularFile(path.join(layout.real, "config.toml")) ?? "";
      if (/^\s*\[model_providers\./m.test(config)) {
        return yield* new NotIsolated({
          reason: "thread isolation cannot carry Codex's custom model providers from config.toml",
        });
      }
    }
    const problem = policyProblem(policy);
    if (problem !== undefined) {
      return yield* fail(
        `Thread isolation cannot start this thread: ${problem.detail}. Correct it in ${place(problem.field)}.`,
      );
    }
    const provider = ownProvider(input.provider);
    const baseEnv = { ...hostEnvironment, ...input.env };
    if (detection.backend === "windows") {
      const changed = changedDimensions(policy);
      if (changed.length > 0) {
        return yield* fail(
          `Thread isolation's srt on Windows applies its own rules and cannot apply your ${changed.join(", ")}. Reset them for this thread or in Settings, ${TURN_OFF}.`,
        );
      }
      // The prepared bridge runs a thread's provider in its sandbox, exactly as T3 Code did with
      // its per-provider switch; runs outside a thread (titles, commit messages) ran outside it.
      if (input.thread === undefined || provider === undefined) return undefined;
      // Its changes return to the project, where the server's git then runs.
      yield* markFolder([input.cwd]).pipe(
        Effect.mapError(failWith("Thread isolation could not record this thread's folder.")),
      );
      const launch = yield* resolveWindowsSandboxLaunch({
        provider,
        command: input.command,
        args: input.args,
        cwd: input.cwd,
        threadId: input.thread,
        folder: baseDir,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(HostProcess.Platform, platform),
        Effect.mapError((error) => new NotIsolated({ reason: error.message })),
        Effect.tapError(() => forget),
      );
      return {
        backend: "windows" as const,
        command: launch.command,
        args: launch.args,
        env: input.env as Record<string, string>,
        stopPath: launch.stopPath,
      };
    }
    const resolved = path.isAbsolute(input.command)
      ? input.command
      : yield* which(input.command, baseEnv);
    if (resolved === null) {
      return yield* fail(`Thread isolation could not find ${input.command} on this environment.`);
    }
    const found = yield* realPath(resolved);
    const start = platform === "win32" ? yield* windowsStart(found, baseEnv) : undefined;
    const executable = start?.entry ?? found;
    const cwd = yield* realPath(input.cwd);
    const stateKey = keyOf(input.key);
    const fresh = !launches.has(stateKey);
    const launched: Launched = launches.get(stateKey) ?? {
      proxyIds: [],
      containers: [],
      srtWraps: 0,
    };
    launches.set(stateKey, launched);
    const common = {
      policy,
      place,
      baseEnv,
      detection,
      executable,
      start: start?.argv,
      cwd,
      stateKey,
      launched,
    };
    // A key whose first launch fails leaves nothing behind.
    return yield* (
      provider === undefined
        ? launchGeneric(input, common).pipe(
            Effect.catchTags({
              PlatformError: () =>
                fail("Thread isolation could not prepare this thread's private folder."),
            }),
          )
        : launchIn(
            { ...input, provider },
            { ...common, layout: providerLayout(path, provider, input.env, home) },
          )
    ).pipe(
      Effect.tapError(() =>
        fresh ? releaseNow(stateKey, launched).pipe(Effect.ignore) : Effect.void,
      ),
    );
  });

  /**
   * A provider other than Claude and Codex: its own folders writable, the rest of the home
   * folder hidden behind a private one, and of the server's environment only what its launch
   * set for it (its configured variables and sign-in) and the policy names.
   */
  const launchGeneric = Effect.fn("ThreadIsolation.launchGeneric")(function* (
    input: WrapInput,
    {
      policy: chosen,
      place,
      baseEnv,
      detection,
      executable,
      start,
      cwd,
      stateKey,
      launched,
    }: {
      readonly policy: ThreadIsolationPolicy;
      readonly place: (field: PolicyField) => string;
      readonly baseEnv: NodeJS.ProcessEnv;
      readonly detection: Extract<Detection, { readonly backend: "srt" | "docker" }>;
      readonly executable: string;
      readonly start: ReadonlyArray<string> | undefined;
      readonly cwd: string;
      readonly stateKey: string;
      readonly launched: Launched;
    },
  ) {
    const known = PROVIDER_PROFILES[input.provider] ?? GENERIC_PROFILE;
    yield* markFolder([...new Set([cwd, ...(input.cwd ? [input.cwd] : [])])]).pipe(
      Effect.mapError(failWith("Thread isolation could not record this thread's folder.")),
    );
    const state = path.join(root, stateKey);
    const privateHome = path.join(state, "home");
    const tmp = path.join(state, "tmp");
    for (const folder of [state, privateHome, tmp]) yield* ownFolder(folder);
    const { roots, git } = yield* policyFor(input, executable, cwd).pipe(
      Effect.mapError((error) =>
        error._tag === "ThreadIsolationError"
          ? error
          : new ThreadIsolationError({
              detail: "Thread isolation could not read this thread's folders.",
            }),
      ),
    );
    const own: Array<string> = [];
    const read: Array<string> = [];
    const linkFrom = Effect.fn("ThreadIsolation.linkProviderFolder")(function* (
      name: string,
      into: Array<string>,
    ) {
      const target = path.join(home, name);
      if (!(yield* exists(target))) return;
      const resolved = yield* realPath(target);
      yield* linkInHome(privateHome, name, resolved).pipe(
        Effect.mapError(failWith("Thread isolation could not link this provider's folder.")),
      );
      into.push(resolved);
    });
    for (const name of known.homeFolders) yield* linkFrom(name, own);
    for (const name of known.readHomeFolders) yield* linkFrom(name, read);
    for (const name of [...known.assignedVariables, ...known.pathVariables]) {
      const value = input.env[name];
      if (!value || !path.isAbsolute(value) || !(yield* exists(value))) continue;
      const real = yield* realPath(value);
      const refused = known.assignedVariables.includes(name)
        ? undefined
        : yield* folderRefusal(real);
      if (refused !== undefined) {
        return yield* fail(
          `Thread isolation cannot give this thread ${name} (${value}): ${refused}. Correct it in the provider's settings.`,
        );
      }
      own.push(real);
    }
    const gitconfig = Option.getOrUndefined(yield* identity);
    const folders = yield* ownerFolders(chosen, place, git.writable);
    const policy: IsolationPolicy = {
      cwd,
      writable: [
        privateHome,
        tmp,
        ...git.writable,
        ...own,
        ...(input.writable ?? []),
        ...folders.writable,
      ],
      readable: [
        ...new Set([...roots, ...git.readable, ...read, ...(gitconfig ? [gitconfig] : [])]),
        ...(input.readable ?? []),
        ...folders.readable,
      ],
      protected: [...git.protected, ...folders.protected],
    };
    // What the server's own environment holds stays out; what the launch set differs from it.
    const kept = Object.entries(input.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !LAUNCH_VARIABLES.has(entry[0]) &&
        (SHARED_VARIABLES.includes(entry[0]) ||
          known.pathVariables.includes(entry[0]) ||
          known.assignedVariables.includes(entry[0]) ||
          known.urlVariables.includes(entry[0]) ||
          hostEnvironment[entry[0]] !== entry[1]),
    );
    const env = {
      ...Object.fromEntries(kept),
      ...Object.fromEntries(
        chosen.environment.flatMap((name) => {
          const value = baseEnv[name];
          return value === undefined ? [] : [[name, value]];
        }),
      ),
      HOME: privateHome,
      ...(gitconfig ? { GIT_CONFIG_GLOBAL: gitconfig } : {}),
    };
    const signIn = known.urlVariables.flatMap((name) => urlAuthority(input.env[name]));
    return yield* launchWith({
      detection,
      policy,
      env,
      hosts: reachableHosts(chosen, known.hosts, signIn),
      executable,
      start,
      args: input.args,
      tmp,
      privateHome,
      stateKey,
      launched,
    });
  });

  const launchIn = Effect.fn("ThreadIsolation.launch")(function* (
    input: OwnInput,
    {
      policy: chosen,
      place,
      baseEnv,
      detection,
      executable,
      start,
      cwd,
      stateKey,
      layout,
      launched,
    }: {
      readonly policy: ThreadIsolationPolicy;
      readonly place: (field: PolicyField) => string;
      readonly baseEnv: NodeJS.ProcessEnv;
      readonly detection: Extract<Detection, { readonly backend: "srt" | "docker" }>;
      readonly executable: string;
      readonly start: ReadonlyArray<string> | undefined;
      readonly cwd: string;
      readonly stateKey: string;
      readonly layout: ProviderLayout;
      readonly launched: Launched;
    },
  ) {
    yield* markFolder([...new Set([cwd, ...(input.cwd ? [input.cwd] : [])])]).pipe(
      Effect.mapError(failWith("Thread isolation could not record this thread's folder.")),
    );
    const prepared = yield* prepareState(input, launched, stateKey, cwd).pipe(
      Effect.mapError(failWith("Thread isolation could not prepare this thread's private folder.")),
    );
    const { roots, git } = yield* policyFor(input, executable, cwd).pipe(
      Effect.mapError((error) =>
        error._tag === "ThreadIsolationError"
          ? error
          : new ThreadIsolationError({
              detail: "Thread isolation could not read this thread's folders.",
            }),
      ),
    );
    const access = providerAccess(input.provider, baseEnv, home, prepared.configured, platform);
    const linked: Array<string> = [];
    for (const [name, target] of access.homeLinks) {
      if (!(yield* exists(target))) continue;
      const resolved = yield* realPath(target);
      yield* linkInHome(prepared.privateHome, name, resolved).pipe(
        Effect.mapError(failWith("Thread isolation could not link your sign-in folder.")),
      );
      linked.push(resolved);
    }
    const gitconfig = Option.getOrUndefined(yield* identity);
    const folders = yield* ownerFolders(chosen, place, git.writable);
    const policy: IsolationPolicy = {
      cwd,
      writable: [
        prepared.privateHome,
        prepared.config,
        prepared.tmp,
        ...prepared.shared,
        ...git.writable,
        ...(input.writable ?? []),
        ...folders.writable,
      ],
      readable: [
        ...new Set([
          ...roots,
          ...git.readable,
          ...prepared.settingsRead,
          ...access.readable,
          ...linked,
          ...(gitconfig ? [gitconfig] : []),
        ]),
        ...(input.readable ?? []),
        ...folders.readable,
      ],
      protected: [...git.protected, ...prepared.sharedParents, ...folders.protected],
    };
    const env = {
      ...access.env,
      ...Object.fromEntries(
        chosen.environment.flatMap((name) => {
          const value = baseEnv[name];
          return value === undefined ? [] : [[name, value]];
        }),
      ),
      HOME: prepared.privateHome,
      [layout.variable]: prepared.config,
      ...(gitconfig ? { GIT_CONFIG_GLOBAL: gitconfig } : {}),
    };
    return yield* launchWith({
      detection,
      policy,
      env,
      hosts: reachableHosts(chosen, PROVIDER_HOSTS[input.provider], access.hosts),
      executable,
      start,
      args: input.args,
      tmp: prepared.tmp,
      privateHome: prepared.privateHome,
      stateKey,
      launched,
    });
  });

  /** How srt-win starts a provider: a program itself, or an npm shim's script with Node. */
  const windowsStart = Effect.fn("ThreadIsolation.windowsStart")(function* (
    executable: string,
    env: NodeJS.ProcessEnv,
  ) {
    if (/\.(exe|com)$/i.test(executable)) return { entry: executable, argv: [executable] };
    const script = /\.cmd$/i.test(executable)
      ? npmNodeShimScript(readRegularFile(executable, 64 * 1024) ?? "")
      : undefined;
    if (script === undefined) {
      return yield* new NotIsolated({
        reason: "its command is a Windows command script, which a sandbox cannot start",
      });
    }
    const folder = path.dirname(executable);
    const entry = path.join(folder, ...script.split("\\"));
    const beside = path.join(folder, "node.exe");
    const node = (yield* exists(beside)) ? beside : yield* which("node", env);
    if (node === null) {
      return yield* new NotIsolated({ reason: "Node, which starts this provider, was not found" });
    }
    return {
      entry: yield* realPath(entry),
      argv: [yield* realPath(node), ...NODE_KEEPS_PATHS, yield* realPath(entry)],
    };
  });

  /**
   * srt-win's command for a launch, once the sandbox account may use its folders. Grants are
   * per launch key, under a process of its own, so a key's release revokes only its own. On
   * Windows a folder outside home and T3 Code's data is readable to every user already, and
   * the owner could not grant there.
   */
  const windowsCommand = Effect.fn("ThreadIsolation.windowsCommand")(function* (
    manager: SandboxRuntime,
    windows: { readonly runtime: WindowsSandboxRuntime; readonly account: string },
    input: {
      readonly policy: IsolationPolicy;
      readonly env: Record<string, string>;
      readonly argv: ReadonlyArray<string>;
      readonly tmp: string;
      readonly privateHome: string;
      readonly launched: Launched;
      readonly proxyId: string;
    },
  ) {
    const { policy, launched } = input;
    // Per-exec denies are what srt-win can hold for one command; grants are made below.
    const wrapped = yield* attempt("Thread isolation could not build the sandbox command.", () =>
      manager.wrapWithSandboxArgv(
        "",
        undefined,
        { filesystem: { denyRead: [], allowWrite: [], denyWrite: policy.protected.map(literal) } },
        undefined,
        policy.cwd,
      ),
    );
    const appData = path.join(input.privateHome, "AppData", "Roaming");
    const localAppData = path.join(input.privateHome, "AppData", "Local");
    for (const folder of [appData, localAppData]) {
      yield* ownFolder(folder).pipe(
        Effect.mapError(
          failWith("Thread isolation could not prepare this thread's private folder."),
        ),
      );
    }
    const { port } = yield* ensureProxy.pipe(
      Effect.mapError(
        (error) =>
          new ThreadIsolationError({
            detail: `Thread isolation cannot start this thread: ${proxyProblem(error)}. Try again, ${TURN_OFF}.`,
          }),
      ),
    );
    const launcher = path.join(serverFolder, "srt-win-launcher.cjs");
    const spec = path.join(input.tmp, `launch-${unguessable()}.json`);
    const built = srtWinLaunch({
      wrapped: wrapped.argv,
      node: windows.runtime.node,
      launcher,
      spec,
      env: srtWinEnvironment({
        env: input.env,
        home: input.privateHome,
        tmp: input.tmp,
        appData,
        localAppData,
        proxy: `http://${input.proxyId}@127.0.0.1:${port}`,
      }),
      argv: input.argv,
    });
    if (typeof built === "string") return yield* new NotIsolated({ reason: `srt-win: ${built}` });
    yield* writeAtomically(launcher, SRT_WIN_LAUNCHER).pipe(
      Effect.mapError(failWith("Thread isolation could not write its sandbox launcher.")),
    );
    const read = yield* existing(
      srtWinReadGrants(path, {
        readable: policy.readable,
        launcher,
        runtime: windows.runtime.node[0]!,
        homes: [home, ...(hostEnvironment.USERPROFILE ? [hostEnvironment.USERPROFILE] : [])],
        data: [baseDir, stateDir],
      }),
    );
    const write = yield* existing([policy.cwd, ...policy.writable]);
    // One holder per key: the first launch's start is the one every later launch of it waits
    // for, taken and kept in one step, so two launches of a key at once never start two.
    launched.holding ??= windows.runtime.hold();
    const held = yield* Effect.tryPromise({
      try: () => launched.holding!,
      catch: failWith("Thread isolation could not start the process its folder grants need."),
    }).pipe(Effect.tapError(() => Effect.sync(() => (launched.holding = undefined))));
    launched.holder ??= { ...held, program: windows.runtime.program, account: windows.account };
    const holder = launched.holder;
    const granted = yield* runner
      .run({
        command: windows.runtime.program,
        args: [
          "acl",
          "grant",
          "--holder-pid",
          String(holder.pid),
          "--sandbox-user-sid",
          windows.account,
        ],
        stdin: encodeJson({ read, write }),
        timeout: "60 seconds",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.option);
    if (granted._tag === "None" || granted.value.code !== 0 || granted.value.timedOut) {
      const detail = granted._tag === "Some" ? granted.value.stderr.trim() : "";
      return yield* fail(
        `Thread isolation could not give the sandbox this thread's folders${detail ? `: ${detail}` : ""}. Try again, ${TURN_OFF}.`,
      );
    }
    // Written after the grant, so it inherits the sandbox account's access to the private tmp;
    // the launcher deletes it once read, and the thread's release removes the folder.
    yield* fs
      .writeFileString(spec, built.spec, { flag: "wx" })
      .pipe(Effect.mapError(failWith("Thread isolation could not hand the thread its variables.")));
    // srt-win itself runs as the owner, with the server's environment; the thread gets the spec.
    const env = Object.fromEntries(
      Object.entries(hostEnvironment).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    return { argv: built.argv, env };
  });

  /** The sandboxed command for a launch whose folders, variables and hosts are decided. */
  const launchWith = Effect.fn("ThreadIsolation.launchWith")(function* ({
    detection,
    policy,
    env,
    hosts,
    executable,
    start,
    args,
    tmp,
    privateHome,
    stateKey,
    launched,
  }: {
    readonly detection: Extract<Detection, { readonly backend: "srt" | "docker" }>;
    readonly policy: IsolationPolicy;
    readonly env: Record<string, string>;
    readonly hosts: ReadonlyArray<string> | "any";
    readonly executable: string;
    /** On Windows: how the program starts, a Node script with Node itself. */
    readonly start: ReadonlyArray<string> | undefined;
    readonly args: ReadonlyArray<string>;
    readonly tmp: string;
    readonly privateHome: string;
    readonly stateKey: string;
    readonly launched: Launched;
  }) {
    const proxyId = unguessable();
    launched.proxyIds.push(proxyId);
    proxyHosts.set(proxyId, hosts);
    if (detection.backend === "srt") {
      const wrapped = yield* sandboxLock
        .withPermits(1)(
          Effect.gen(function* () {
            // No launch runs with a dead bridge: srt starts again first, or the launch fails.
            if (sandbox === undefined || !(yield* bridgeAlive(sandbox))) {
              const reason = yield* startSandboxHeld;
              if (reason !== undefined || sandbox === undefined) {
                return yield* fail(
                  `Thread isolation's sandbox stopped working and could not start again: ${reason ?? "srt is gone"}. Try again to use Docker if it is there, ${TURN_OFF}.`,
                );
              }
            }
            const runtime = sandbox;
            // srt-win's grants take seconds, so they are made outside the lock every launch takes.
            if (runtime.windows !== undefined) {
              return windowsCommand(runtime.manager, runtime.windows, {
                policy,
                env,
                argv: [...(start ?? [executable]), ...args],
                tmp,
                privateHome,
                launched,
                proxyId,
              });
            }
            const filesystem = srtSettings(
              { ...policy, readable: [...policy.readable, ...runtime.readable] },
              platform,
            ).filesystem;
            const linux = yield* attempt(
              "Thread isolation could not build the sandbox command.",
              () =>
                runtime.manager.wrapWithSandboxArgv(
                  srtCommandLine({
                    command: executable,
                    args,
                    tmp,
                    proxyId,
                  }),
                  undefined,
                  { filesystem },
                ),
            );
            return Effect.succeed({ argv: linux.argv, env });
          }),
        )
        .pipe(
          Effect.flatten,
          Effect.tapError(() => forget),
        );
      launched.srtWraps += 1;
      return {
        backend: "srt" as const,
        command: wrapped.argv[0]!,
        args: wrapped.argv.slice(1),
        env: wrapped.env,
      };
    }
    const docker = yield* dockerLock
      .withPermits(1)(prepareDocker(detection.command))
      .pipe(
        Effect.mapError((error) =>
          error._tag === "ThreadIsolationError"
            ? error
            : new ThreadIsolationError({ detail: "Thread isolation could not prepare Docker." }),
        ),
        Effect.tapError(() => forget),
      );
    const user = NodeOS.userInfo();
    const name = `t3code-isolation-${stateKey}-${NodeCrypto.randomUUID().slice(0, 8)}`;
    launched.containers.push(name);
    const launch = dockerCommand({
      docker: detection.command,
      policy: { ...policy, protected: yield* existing(policy.protected) },
      system: docker.system,
      home: privateHome,
      tmp,
      proxySocket: docker.proxySocket,
      server,
      proxyId,
      uid: user.uid,
      gid: user.gid,
      name,
      env: Object.keys(env),
      command: executable,
      args,
    });
    // The Docker client itself keeps the host's settings for reaching its daemon.
    const client = Object.fromEntries(
      Object.entries(hostEnvironment).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined &&
          (entry[0].startsWith("DOCKER_") || entry[0] === "XDG_RUNTIME_DIR"),
      ),
    );
    return { backend: "docker" as const, ...launch, env: { ...env, ...client, HOME: home } };
  });

  const setUp = Effect.gen(function* () {
    if (platform !== "win32") return yield* fail("Only on Windows does srt need setting up.");
    const { windows } = yield* sandboxSource;
    const result = yield* attemptSaying("Setting up srt failed", windows.install);
    if (result.cancelled) return "cancelled" as const;
    // srt-win did not start before it was set up, so the probe starts it afresh.
    yield* forget;
    yield* refresh;
    yield* PubSub.publish(changes, undefined);
    return "done" as const;
  }).pipe(Effect.withSpan("ThreadIsolation.setUp"));

  const remove = Effect.gen(function* () {
    if (platform !== "win32") return yield* fail("Only on Windows is srt set up by T3 Code.");
    const { manager, windows } = yield* sandboxSource;
    // srt's uninstall waits for the administrator prompt synchronously, so srt-win runs it here.
    const removed = yield* runner
      .run({
        command: windows.program,
        args: ["uninstall"],
        timeout: "130 seconds",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.mapError(failWith("Removing srt failed: srt-win did not start.")));
    // srt-win's exit code when the administrator prompt was dismissed.
    if (removed.code === 10) return "cancelled" as const;
    if (removed.code !== 0 || removed.timedOut) {
      return yield* fail(
        `Removing srt failed${removed.timedOut ? ": the administrator prompt was not answered in time" : `: ${removed.stderr.trim() || removed.stdout.trim()}`}`,
      );
    }
    yield* sandboxLock.withPermits(1)(
      Effect.suspend(() => {
        const previous = sandbox;
        sandbox = undefined;
        return previous === undefined
          ? Effect.void
          : attempt("srt did not stop", () => manager.reset()).pipe(Effect.ignore);
      }),
    );
    yield* forget;
    yield* refresh;
    yield* PubSub.publish(changes, undefined);
    return "done" as const;
  }).pipe(Effect.withSpan("ThreadIsolation.remove"));

  return {
    enabled,
    status,
    subscribeChanges: Effect.map(PubSub.subscribe(changes), Stream.fromSubscription),
    check,
    wrap,
    release,
    setUp,
    remove,
  } satisfies ThreadIsolationShape;
});

export const layer = Layer.effect(ThreadIsolation, make);

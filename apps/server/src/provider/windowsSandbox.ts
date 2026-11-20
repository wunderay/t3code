// @effect-diagnostics nodeBuiltinImport:off -- Stable controller keys match the Python transport.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";

const Installation = Schema.Struct({
  python: Schema.String,
  bridge: Schema.String,
  state: Schema.String,
  claudeCredential: Schema.optionalKey(Schema.String),
});

export const resolveWindowsSandboxClaudeEnvironment = Effect.fn(
  "WindowsSandbox.resolveClaudeEnvironment",
)(function* (environment: NodeJS.ProcessEnv, useDefaultCredential: boolean, configPath: string) {
  if (
    !useDefaultCredential ||
    environment.CLAUDE_CODE_OAUTH_TOKEN ||
    environment.ANTHROPIC_API_KEY ||
    environment.ANTHROPIC_AUTH_TOKEN
  )
    return environment;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exists = yield* fs
    .exists(configPath)
    .pipe(
      Effect.mapError((cause) => new WindowsSandboxSetupError({ reason: "installation", cause })),
    );
  if (!exists) return environment;
  const installation = yield* decodeInstallation(configPath);
  if (!installation.claudeCredential) return environment;
  if (!path.isAbsolute(installation.python) || !path.isAbsolute(installation.bridge))
    return yield* new WindowsSandboxSetupError({ reason: "installation" });
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner
        .spawn(
          ChildProcess.make(
            installation.python,
            ["-I", "-B", installation.bridge, "--config", configPath, "--credential"],
            { env: environment, extendEnv: false },
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) => new WindowsSandboxSetupError({ reason: "installation", cause }),
          ),
        );
      const [value, code] = yield* Effect.all(
        [Stream.mkString(Stream.decodeText(child.stdout)), child.exitCode],
        { concurrency: 2 },
      ).pipe(
        Effect.mapError((cause) => new WindowsSandboxSetupError({ reason: "installation", cause })),
        Effect.timeoutOrElse({
          duration: "30 seconds",
          orElse: () => Effect.fail(new WindowsSandboxSetupError({ reason: "installation" })),
        }),
      );
      if (code !== 0 || value.length === 0 || value.length > 8192)
        return yield* new WindowsSandboxSetupError({ reason: "installation" });
      const resolvedEnvironment: NodeJS.ProcessEnv = {
        ...environment,
        CLAUDE_CODE_OAUTH_TOKEN: value,
      };
      return resolvedEnvironment;
    }),
  );
});

class WindowsSandboxSetupError extends Schema.TaggedError<WindowsSandboxSetupError>()(
  "WindowsSandboxSetupError",
  {
    reason: Schema.Literals(["platform", "workspace", "installation"]),
    /** What is wrong with the preparation, to show where it is fixed. */
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "platform":
        return "srt's Windows runtime runs only on Windows";
      case "workspace":
        return "srt on Windows needs this thread's project folder";
      case "installation":
        return `srt is not prepared on this machine: ${this.detail ?? "its windows-sandbox.json is missing or invalid"}`;
    }
  }
}

/**
 * Where the Windows sandbox's preparation is: windows-sandbox.json, or the guild-sandbox.json
 * that earlier tooling wrote, so a machine prepared before keeps working.
 */
export const windowsSandboxConfigPath = Effect.fn("WindowsSandbox.configPath")(function* (
  folder: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const current = path.join(folder, "windows-sandbox.json");
  if (yield* fs.exists(current).pipe(Effect.orElseSucceed(() => false))) return current;
  const earlier = path.join(folder, "guild-sandbox.json");
  return (yield* fs.exists(earlier).pipe(Effect.orElseSucceed(() => false))) ? earlier : current;
});

const decodeInstallationText = Schema.decodeEffect(Schema.fromJsonString(Installation));

/** windows-sandbox.json as written, which Windows PowerShell 5 saves with a byte-order mark. */
const decodeInstallation = Effect.fn("WindowsSandbox.decodeInstallation")(function* (
  configPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(configPath).pipe(
    Effect.mapError(
      (cause) =>
        new WindowsSandboxSetupError({
          reason: "installation",
          detail: `${configPath} cannot be read`,
          cause,
        }),
    ),
  );
  return yield* decodeInstallationText(text.replace(/^\uFEFF/, "")).pipe(
    Effect.mapError(
      (cause) =>
        new WindowsSandboxSetupError({
          reason: "installation",
          detail: `${configPath} is not JSON naming python, bridge and state`,
          cause,
        }),
    ),
  );
});

/** The sandbox prepared for this environment, if it is: Python, its bridge and state. */
const readInstallation = Effect.fn("WindowsSandbox.readInstallation")(function* (folder: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configPath = yield* windowsSandboxConfigPath(folder);
  if (!(yield* fs.exists(configPath).pipe(Effect.orElseSucceed(() => false)))) {
    return yield* new WindowsSandboxSetupError({
      reason: "installation",
      detail: `${configPath} is missing`,
    });
  }
  const installation = yield* decodeInstallation(configPath);
  const relative = (["python", "bridge", "state"] as const).filter(
    (key) => !path.isAbsolute(installation[key]),
  );
  if (relative.length > 0) {
    return yield* new WindowsSandboxSetupError({
      reason: "installation",
      detail: `${configPath} must name ${relative.join(", ")} by full path`,
    });
  }
  return { configPath, installation };
});

/** Why Thread isolation's Windows sandbox cannot run threads here, or undefined when it can. */
export const windowsSandboxProblem = Effect.fn("WindowsSandbox.problem")(function* (
  /** T3 home, where the preparation is, as the Claude driver and settings read it. */
  folder: string,
) {
  if ((yield* HostProcess.Platform) !== "win32")
    return new WindowsSandboxSetupError({ reason: "platform" }).message;
  return yield* readInstallation(folder).pipe(
    Effect.as(undefined),
    Effect.catch((error) => Effect.succeed(error.message)),
  );
});

export const resolveWindowsSandboxLaunch = Effect.fn("WindowsSandbox.resolveLaunch")(
  function* (input: {
    readonly provider: "codex" | "claude";
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd?: string | null | undefined;
    readonly threadId: string;
    /** T3 home, where the preparation is. */
    readonly folder: string;
  }) {
    if ((yield* HostProcess.Platform) !== "win32") {
      return yield* new WindowsSandboxSetupError({ reason: "platform" });
    }
    if (!input.cwd) return yield* new WindowsSandboxSetupError({ reason: "workspace" });
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { configPath, installation } = yield* readInstallation(input.folder);
    const key = NodeCrypto.createHash("sha256")
      .update(`${input.provider}:${input.threadId}`)
      .digest("hex")
      .slice(0, 24);
    const control = path.join(installation.state, "t3", key);
    const stopPath = path.join(control, "stop");
    yield* fs.makeDirectory(control, { recursive: true }).pipe(
      Effect.andThen(fs.remove(stopPath, { force: true })),
      Effect.mapError((cause) => new WindowsSandboxSetupError({ reason: "installation", cause })),
    );
    return {
      command: installation.python,
      stopPath,
      args: [
        "-I",
        "-B",
        installation.bridge,
        "--config",
        configPath,
        "--provider",
        input.provider,
        "--workspace",
        input.cwd,
        "--thread",
        input.threadId,
        "--binary",
        input.command,
        "--",
        ...input.args,
      ],
    };
  },
);

/** The ports srt-win's network fence lets the sandbox reach on loopback: its install's default. */
export const SRT_WIN_PROXY_PORTS = Array.from({ length: 10 }, (_, index) => 60080 + index);

/** Windows starts no program from inside Electron's archive, only from its unpacked copy. */
export const unpackedPath = (file: string) => file.replace(/\.asar([\\/])/, ".asar.unpacked$1");

/**
 * The script an npm or pnpm cmd-shim starts with Node, relative to the shim's folder. Any other
 * script is not understood: cmd would parse its arguments again, so it is never run.
 */
export function npmNodeShimScript(text: string): string | undefined {
  return /^[^\n]*"(?:%_prog%|%~dp0\\node\.exe)" +"(?:%dp0%|%~dp0)\\([^"%\r\n]+\.[cm]?js)" +%\*\r?$/m.exec(
    text,
  )?.[1];
}

/**
 * Node's flags to run a script by the path it is given: finding its real path reads every
 * folder above it, and the sandbox account may not read one in the owner's profile.
 */
export const NODE_KEEPS_PATHS = ["--preserve-symlinks", "--preserve-symlinks-main"];

/** The T3 Code executable's command that runs the launcher, where it is a single executable. */
export const SRT_WIN_LAUNCH_COMMAND = "__srt-win-launch";

/**
 * Runs inside srt-win's sandbox, as Node: reads the launch's spec, deletes it, and starts its
 * program with its variables and argv, then the arguments a caller appended. Node quotes each
 * argument for the program, and no shell parses one.
 */
export const SRT_WIN_LAUNCHER = String.raw`"use strict";
const fs = require("node:fs");
const { spawn } = require("node:child_process");
// As Node runs a script: argv is [node, this file, spec, ...appended], by position, as a link in
// its folder makes __filename differ from the path it was given.
const [specPath, ...appended] = process.argv.slice(2);
let spec;
try {
  spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
} finally {
  fs.rmSync(specPath, { force: true });
}
const replaced = new Set([...Object.keys(spec.env), "ELECTRON_RUN_AS_NODE"].map((name) => name.toUpperCase()));
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !replaced.has(name.toUpperCase())));
const child = spawn(spec.argv[0], [...spec.argv.slice(1), ...appended], {
  env: { ...env, ...spec.env },
  stdio: "inherit",
  windowsHide: true,
});
child.on("error", (error) => {
  process.stderr.write("T3 Code's sandbox launcher could not start " + spec.argv[0] + ": " + error.message + "\n");
  process.exit(127);
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
`;

/**
 * The srt-win command for one provider process, and the spec its launcher reads. Variables
 * (sign-ins and API keys among them) and the program's argv go in the spec, a file in the
 * thread's private state, never on a command line other processes can read. srt-win starts
 * the launcher with Node (`node`, or Electron as Node) after srt's own flags.
 */
export function srtWinLaunch(input: {
  readonly wrapped: ReadonlyArray<string>;
  /** How T3 Code runs a Node script: its Node or Electron, or its own executable's command. */
  readonly node: ReadonlyArray<string>;
  readonly launcher: string;
  readonly spec: string;
  readonly env: Readonly<Record<string, string>>;
  readonly argv: ReadonlyArray<string>;
}): { readonly argv: Array<string>; readonly spec: string } | string {
  const separator = input.wrapped.indexOf("--");
  if (separator < 0) return "srt-win's command has no program separator";
  const unfit = Object.entries(input.env).find(
    ([name, value]) => !/^[^=\0]+$/.test(name) || value.includes("\0"),
  );
  if (unfit !== undefined) return `the variable ${JSON.stringify(unfit[0])} cannot be passed`;
  if (input.argv.some((arg) => arg.includes("\0"))) return "an argument holds a NUL character";
  if (!/\.(exe|com)$/i.test(input.argv[0] ?? "")) {
    return "srt-win starts only a program, not a script";
  }
  const spec = JSON.stringify({ env: input.env, argv: input.argv });
  // CreateProcessW takes at most 32767 characters, and Windows an environment of 32767.
  if (spec.length > 30_000) return "its command line or variables are longer than Windows allows";
  return {
    argv: [
      ...input.wrapped.slice(0, separator),
      "--env",
      "ELECTRON_RUN_AS_NODE=1",
      "--",
      ...input.node,
      input.launcher,
      input.spec,
    ],
    spec,
  };
}

/**
 * What a Windows program reads instead of HOME and TMPDIR, inside the thread's private state,
 * and the proxy, under the launch's own id: srt-win starts it with the sandbox account's own
 * environment, which every thread shares.
 */
export function srtWinEnvironment(input: {
  readonly env: Readonly<Record<string, string>>;
  readonly home: string;
  readonly tmp: string;
  readonly appData: string;
  readonly localAppData: string;
  readonly proxy: string;
}): Record<string, string> {
  return {
    ...input.env,
    HOME: input.home,
    USERPROFILE: input.home,
    APPDATA: input.appData,
    LOCALAPPDATA: input.localAppData,
    TEMP: input.tmp,
    TMP: input.tmp,
    ...Object.fromEntries(
      ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"].map((name) => [name, input.proxy]),
    ),
  };
}

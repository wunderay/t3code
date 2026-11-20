// @effect-diagnostics nodeBuiltinImport:off -- the launcher runs as a real Node process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  NODE_KEEPS_PATHS,
  npmNodeShimScript,
  SRT_WIN_LAUNCHER,
  srtWinEnvironment,
  srtWinLaunch,
  unpackedPath,
  windowsSandboxProblem,
  resolveWindowsSandboxClaudeEnvironment,
  resolveWindowsSandboxLaunch,
} from "./windowsSandbox.ts";

it.effect("srt on Windows: the sign-in keeps explicit credentials and other accounts", () =>
  Effect.gen(function* () {
    const environment = { CLAUDE_CODE_OAUTH_TOKEN: "explicit-account" };
    assert.strictEqual(
      yield* resolveWindowsSandboxClaudeEnvironment(environment, true, "absent"),
      environment,
    );
    const otherAccount = { CLAUDE_CONFIG_DIR: "another-account" };
    assert.strictEqual(
      yield* resolveWindowsSandboxClaudeEnvironment(otherAccount, false, "absent"),
      otherAccount,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("srt on Windows: the sign-in is read without changing the caller environment", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const directory = yield* fs.makeTempDirectoryScoped();
    const configPath = path.join(directory, "windows-sandbox.json");
    yield* fs.writeFileString(
      configPath,
      JSON.stringify({
        python: process.execPath,
        bridge: path.join(directory, "bridge.py"),
        state: directory,
        claudeCredential: "fixture/account",
      }),
    );
    const environment = { EXAMPLE: "preserved" };
    const resolved = yield* resolveWindowsSandboxClaudeEnvironment(
      environment,
      true,
      configPath,
    ).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, {
        ...spawner,
        spawn: () =>
          spawner.spawn(
            ChildProcess.make(process.execPath, ["-e", "process.stdout.write('fixture-token')"]),
          ),
      }),
    );
    assert.deepEqual(resolved, { ...environment, CLAUDE_CODE_OAUTH_TOKEN: "fixture-token" });
    assert.deepEqual(environment, { EXAMPLE: "preserved" });
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

const input = {
  provider: "codex" as const,
  command: "codex",
  args: ["app-server", "--config", 'example="a b"'],
  cwd: "C:\\projects\\example",
  threadId: "test-thread",
  folder: "C:\\Users\\example\\.t3",
};

it.effect("srt on Windows refuses other platforms and absent workspaces", () =>
  Effect.gen(function* () {
    const platform = yield* resolveWindowsSandboxLaunch(input).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.flip,
    );
    assert.equal(platform.reason, "platform");
    const workspace = yield* resolveWindowsSandboxLaunch({ ...input, cwd: null }).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.flip,
    );
    assert.equal(workspace.reason, "workspace");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("srt on Windows fails closed on missing setup and keeps argv when setup is valid", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // T3 home, wherever T3CODE_HOME puts it: the Claude driver and settings read it there too.
    const folder = yield* fs.makeTempDirectoryScoped();
    const run = () =>
      resolveWindowsSandboxLaunch({ ...input, folder }).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
      );
    const problem = windowsSandboxProblem(folder).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
    );
    const current = path.join(folder, "windows-sandbox.json");
    assert.equal((yield* run().pipe(Effect.flip)).reason, "installation");
    assert.equal(yield* problem, `srt is not prepared on this machine: ${current} is missing`);
    const python = path.join(folder, "python.exe");
    const bridge = path.join(folder, "a folder", "sandbox_bridge.py");
    const state = path.join(folder, "state");
    // A machine prepared by earlier tooling keeps its guild-sandbox.json.
    yield* fs.writeFileString(
      path.join(folder, "guild-sandbox.json"),
      JSON.stringify({ python, bridge, state }),
    );
    const command = yield* run();
    assert.isUndefined(yield* problem);
    assert.equal(command.command, python);
    assert.deepEqual(command.args.slice(-input.args.length), input.args);
    assert.include(command.args, bridge);
    // windows-sandbox.json, when there, is read first, and says what is wrong with it.
    yield* fs.writeFileString(current, JSON.stringify({ python: "python", bridge, state: "s" }));
    assert.equal((yield* run().pipe(Effect.flip)).reason, "installation");
    assert.include(yield* problem, `${current} must name python, state by full path`);
    yield* fs.writeFileString(current, "{");
    assert.include(yield* problem, `${current} is not JSON naming python, bridge and state`);
    // Windows PowerShell 5 writes a byte-order mark before the JSON.
    yield* fs.writeFileString(current, `\uFEFF${JSON.stringify({ python, bridge, state })}`);
    assert.isUndefined(yield* problem);
    assert.isDefined(
      yield* windowsSandboxProblem(folder).pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it("srt-win: the launch's variables and argv go in its spec, never on a command line", () => {
  const wrapped = [
    "C:\\T3\\srt-win.exe",
    "exec",
    "--quiet",
    "--deny-write",
    "C:\\p\\.git\\hooks",
    "--env",
    "PATH=C:\\Windows",
    "--",
    "C:\\Windows\\System32\\cmd.exe",
    "/d",
    "/s",
    "/c",
    "",
  ];
  const argv = ["C:\\bin\\claude.exe", '"quoted" & %PATH%', "a\\b\\", "line\nbreak", ""];
  const env = { ANTHROPIC_API_KEY: "sk-secret", HTTP_PROXY: "http://id@127.0.0.1:60081" };
  const launch = (overrides: Partial<Parameters<typeof srtWinLaunch>[0]> = {}) =>
    srtWinLaunch({
      wrapped,
      node: ["C:\\T3\\T3 Code.exe"],
      launcher: "C:\\t3\\launcher.cjs",
      spec: "C:\\t3\\tmp\\launch-1.json",
      env,
      argv,
      ...overrides,
    });
  const built = launch();
  assert.notStrictEqual(typeof built, "string");
  if (typeof built === "string") return;
  assert.deepEqual(built.argv, [
    ...wrapped.slice(0, 7),
    "--env",
    "ELECTRON_RUN_AS_NODE=1",
    "--",
    "C:\\T3\\T3 Code.exe",
    "C:\\t3\\launcher.cjs",
    "C:\\t3\\tmp\\launch-1.json",
  ]);
  assert.deepEqual(JSON.parse(built.spec), { env, argv });
  assert.isFalse(built.argv.some((arg) => arg.includes("sk-secret") || arg.includes("id@")));
  // What cmd would run, or Windows cannot carry, never starts.
  assert.include(launch({ argv: ["C:\\npm\\codex.cmd"] }), "not a script");
  assert.include(launch({ env: { "A=B": "x" } }), '"A=B"');
  assert.include(launch({ env: { A: "x\0y" } }), '"A"');
  assert.include(launch({ argv: ["C:\\a.exe", "x\0"] }), "NUL");
  assert.include(launch({ argv: ["C:\\a.exe", "x".repeat(30_000)] }), "longer");
  assert.include(launch({ wrapped: ["srt-win.exe", "exec"] }), "separator");
});

it("srt-win: the launcher starts the spec's program as given, and deletes the spec", () => {
  const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-launcher-"));
  try {
    // Through a link, as T3 Code's data folder may be reached.
    NodeFS.mkdirSync(NodePath.join(folder, "real"));
    NodeFS.symlinkSync(NodePath.join(folder, "real"), NodePath.join(folder, "linked"));
    const launcher = NodePath.join(folder, "linked", "launcher.cjs");
    const spec = NodePath.join(folder, "linked", "launch.json");
    NodeFS.writeFileSync(launcher, SRT_WIN_LAUNCHER);
    const report =
      "process.stdout.write(JSON.stringify([process.argv.slice(1), process.env.KEY, process.env.key ?? null, process.env.ELECTRON_RUN_AS_NODE ?? null]))";
    // As Node runs it by the path given, and as the Windows CLI's single executable runs it.
    const starts = [
      [...NODE_KEEPS_PATHS, launcher],
      [
        "-e",
        // As bin.ts runs it, with argv[1] standing for the single executable's own entry.
        'const script = process.argv[3]; process.argv.splice(1, 2); new Function("require", "__filename", require("node:fs").readFileSync(script, "utf8"))(require("node:module").createRequire(script), script)',
        "entry",
        "__srt-win-launch",
        launcher,
      ],
    ];
    for (const start of starts) {
      NodeFS.writeFileSync(
        spec,
        JSON.stringify({
          env: { KEY: 'v "q" & %x%' },
          argv: [process.execPath, "-e", report, "a b"],
        }),
      );
      const out = NodeChildProcess.execFileSync(
        process.execPath,
        [...start, spec, "--appended", '"x"'],
        {
          env: { PATH: process.env.PATH, key: "stale", ELECTRON_RUN_AS_NODE: "1" },
          encoding: "utf8",
        },
      );
      assert.deepEqual(JSON.parse(out), [["a b", "--appended", '"x"'], 'v "q" & %x%', null, null]);
      assert.isFalse(NodeFS.existsSync(spec));
    }
    // A spec it cannot read is deleted all the same.
    NodeFS.writeFileSync(spec, "{ not json");
    const failed = NodeChildProcess.spawnSync(process.execPath, [launcher, spec], {
      env: { PATH: process.env.PATH },
    });
    assert.notStrictEqual(failed.status, 0);
    assert.isFalse(NodeFS.existsSync(spec));
  } finally {
    NodeFS.rmSync(folder, { recursive: true, force: true });
  }
});

it("srt-win: a thread's variables point into its private state and the proxy carries its id", () => {
  const env = srtWinEnvironment({
    env: { PATH: "C:\\bin", HOME: "C:\\Users\\ada" },
    home: "C:\\s\\home",
    tmp: "C:\\s\\tmp",
    appData: "C:\\s\\home\\AppData\\Roaming",
    localAppData: "C:\\s\\home\\AppData\\Local",
    proxy: "http://id@127.0.0.1:60080",
  });
  assert.deepEqual(env, {
    PATH: "C:\\bin",
    HOME: "C:\\s\\home",
    USERPROFILE: "C:\\s\\home",
    APPDATA: "C:\\s\\home\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\s\\home\\AppData\\Local",
    TEMP: "C:\\s\\tmp",
    TMP: "C:\\s\\tmp",
    HTTPS_PROXY: "http://id@127.0.0.1:60080",
    HTTP_PROXY: "http://id@127.0.0.1:60080",
    ALL_PROXY: "http://id@127.0.0.1:60080",
  });
});

it("srt-win: an npm or pnpm shim's Node script is read, any other script is not", () => {
  const npm =
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n';
  assert.strictEqual(npmNodeShimScript(npm), "node_modules\\@openai\\codex\\bin\\codex.js");
  const pnpm =
    '@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\..\\@openai\\codex\\bin\\codex.js" %*\r\n) ELSE (';
  assert.strictEqual(npmNodeShimScript(pnpm), "..\\@openai\\codex\\bin\\codex.js");
  // Arguments of its own before %*, a native program, or anything else: not understood.
  for (const other of [
    '"%_prog%"  "%dp0%\\x.js" --flag %*',
    '"%dp0%\\node_modules\\x\\x.exe"   %*',
    '"%_prog%"  "%dp0%\\%OTHER%.js" %*',
    "node x.js %*",
  ]) {
    assert.isUndefined(npmNodeShimScript(other), other);
  }
});

it("srt-win: Windows runs it from Electron's unpacked copy", () => {
  assert.strictEqual(
    unpackedPath("C:\\T3\\resources\\server.asar\\node_modules\\srt-win.exe"),
    "C:\\T3\\resources\\server.asar.unpacked\\node_modules\\srt-win.exe",
  );
  assert.strictEqual(unpackedPath("/opt/srt/srt-win.exe"), "/opt/srt/srt-win.exe");
});

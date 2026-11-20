// @effect-diagnostics nodeBuiltinImport:off -- a stand-in provider runs as a real process in srt-win's real sandbox.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import { layer, ThreadIsolation } from "./threadIsolation.ts";
import { NODE_KEEPS_PATHS } from "./windowsSandbox.ts";

const live =
  HostProcess.Platform.defaultValue() === "win32" && process.env.T3CODE_WINDOWS_LIVE === "1";

/**
 * What the stand-in provider reports, as one `T3PROBE {json}` line: who it runs as, its argv,
 * the variables it was given, and what it could write, read and reach.
 */
const PROBE = String.raw`
const fs = require("node:fs");
const net = require("node:net");
const http = require("node:http");
const os = require("node:os");
const spec = JSON.parse(fs.readFileSync(require("node:path").join(__dirname, "probe.json"), "utf8"));
const tried = (run) => { try { run(); return "ok"; } catch (error) { return "denied:" + error.code; } };
const connect = (host, port) => new Promise((resolve) => {
  const socket = net.connect(port, host);
  const done = (value) => { socket.destroy(); resolve(value); };
  socket.setTimeout(5000, () => done("timeout"));
  socket.once("connect", () => done("connected"));
  socket.once("error", (error) => done("blocked:" + error.code));
});
const tunnel = (target) => new Promise((resolve) => {
  const proxy = new URL(process.env.HTTPS_PROXY);
  const request = http.request({
    host: proxy.hostname, port: proxy.port, method: "CONNECT", path: target,
    headers: { "proxy-authorization": "Basic " + Buffer.from(decodeURIComponent(proxy.username) + ":").toString("base64") },
  });
  request.setTimeout(15000, () => { request.destroy(); resolve("timeout"); });
  request.once("connect", (response, socket) => { socket.destroy(); resolve(response.statusCode); });
  request.once("response", (response) => resolve(response.statusCode));
  request.once("error", (error) => resolve("error:" + error.code));
  request.end();
});
(async () => {
  const report = {
    user: os.userInfo().username,
    argv: process.argv.slice(2),
    env: Object.fromEntries(spec.variables.map((name) => [name, process.env[name] ?? null])),
    writeThread: tried(() => fs.writeFileSync(spec.threadFile, "x")),
    writeOutside: tried(() => fs.writeFileSync(spec.outsideFile, "x")),
    writeHooks: tried(() => fs.writeFileSync(spec.hookFile, "x")),
    readSecret: tried(() => fs.readFileSync(spec.secretFile)),
    readOwnerConfig: tried(() => fs.readFileSync(spec.ownerConfigFile)),
    directConnect: await connect("1.1.1.1", 443),
    allowedTunnel: await tunnel("github.com:443"),
    refusedTunnel: await tunnel("example.com:443"),
  };
  process.stdout.write("T3PROBE " + JSON.stringify(report) + "\n");
})();
`;

const hostEnv: NodeJS.ProcessEnv = { ...process.env };
const say = (text: string) => Effect.log(`[srt-win live] ${text}`);

const ARGS = ["plain", 'say "hi" & echo %PATH% ^| more', "two words", "trailing\\", ""];
const SECRET_VALUE = 'k "quoted" & 100% <sure>';

/** The real isolation layer and the real srt, on a home folder of the test's own. */
const windowsHost = (provider: "claude" | "codex") =>
  Effect.gen(function* () {
    const root = NodeFS.realpathSync.native(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-srt-win-")),
    );
    const home = NodePath.join(root, "home");
    const cwd = NodePath.join(home, "project");
    const ownerFolder = NodePath.join(home, provider === "claude" ? ".claude" : ".codex");
    const ownerConfigFile = NodePath.join(
      ownerFolder,
      provider === "claude" ? "settings.json" : "config.toml",
    );
    NodeFS.mkdirSync(cwd, { recursive: true });
    NodeFS.mkdirSync(ownerFolder, { recursive: true });
    NodeFS.writeFileSync(ownerConfigFile, provider === "claude" ? "{}" : 'model = "x"\n');
    NodeFS.writeFileSync(NodePath.join(home, "secret.txt"), "secret");
    NodeChildProcess.execFileSync("git", ["init", "-q"], { cwd });
    // Claude's stand-in starts as a program does, Node itself; Codex's as npm installs Codex,
    // through its cmd shim.
    const npm = NodePath.join(home, "AppData", "Roaming", "npm");
    const probeFolder =
      provider === "claude" ? cwd : NodePath.join(npm, "node_modules", "@openai", "codex", "bin");
    NodeFS.mkdirSync(probeFolder, { recursive: true });
    NodeFS.mkdirSync(npm, { recursive: true });
    const probe = NodePath.join(probeFolder, provider === "claude" ? "probe.cjs" : "codex.js");
    NodeFS.writeFileSync(probe, PROBE);
    const shim = NodePath.join(npm, "codex.cmd");
    NodeFS.writeFileSync(
      shim,
      '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n',
    );
    const keyVariable = provider === "claude" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
    const folderVariable = provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
    NodeFS.writeFileSync(
      NodePath.join(probeFolder, "probe.json"),
      JSON.stringify({
        variables: [keyVariable, folderVariable, "HOME", "USERPROFILE", "TEMP", "HTTPS_PROXY"],
        threadFile: NodePath.join(cwd, "written.txt"),
        outsideFile: NodePath.join(home, "outside.txt"),
        hookFile: NodePath.join(cwd, ".git", "hooks", "pre-commit"),
        secretFile: NodePath.join(home, "secret.txt"),
        ownerConfigFile,
      }),
    );
    const context = yield* Layer.build(
      layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            ServerSettings.layerTest({ threadIsolation: true }),
            ProcessRunner.layer,
            ServerConfig.layerTest(cwd, { prefix: "t3-srt-win-state-" }),
          ),
        ),
        Layer.provideMerge(NodeHttpServer.layerTest),
      ),
    ).pipe(
      Effect.provideService(HostProcess.HomeDirectory, home),
      Effect.provideService(HostProcess.Environment, hostEnv),
    );
    const isolation = yield* Effect.service(ThreadIsolation).pipe(Effect.provide(context));
    // Node runs a script by the path it is given there: its real path reads folders above it.
    const start =
      provider === "claude"
        ? { command: process.execPath, args: [...NODE_KEEPS_PATHS, probe, ...ARGS] }
        : { command: shim, args: ARGS };
    return { isolation, root, home, cwd, ownerConfigFile, keyVariable, folderVariable, start };
  });

const icacls = (folder: string) =>
  NodeChildProcess.execFileSync("icacls", [folder], { encoding: "utf8" });

/** Launches the stand-in as `provider` through the real wrap, and checks what it found. */
const probeAs = (provider: "claude" | "codex") =>
  Effect.gen(function* () {
    const host = yield* windowsHost(provider);
    const { isolation, cwd } = host;
    const [detected, status] = yield* Effect.timed(isolation.status);
    yield* say(`${provider}: first detect took ${Duration.format(detected)}`);
    yield* say(`${provider}: status ${JSON.stringify(status)}`);
    assert.strictEqual(status?.backend, "srt", "srt must be usable; run the setup test first");
    const key = `live-${provider}`;
    const [wrapping, launch] = yield* Effect.timed(
      isolation.wrap({
        provider,
        command: host.start.command,
        args: host.start.args,
        cwd,
        env: { PATH: hostEnv.PATH ?? "", [host.keyVariable]: SECRET_VALUE },
        key,
        thread: `thread-${provider}`,
      }),
    );
    yield* say(`${provider}: wrap took ${Duration.format(wrapping)}`);
    // Not its environment: that is the server's own, which may hold the runner's secrets.
    yield* say(`${provider}: launch ${JSON.stringify([launch?.command, ...(launch?.args ?? [])])}`);
    assert.strictEqual(launch?.backend, "srt");
    assert.isFalse(
      launch!.args.some((arg) => arg.includes(SECRET_VALUE)),
      "a secret is on argv",
    );
    const [running, ran] = yield* Effect.timed(
      Effect.promise(
        () =>
          new Promise<{ readonly code: number | null; readonly stdout: string; stderr: string }>(
            (resolve) => {
              const child = NodeChildProcess.execFile(
                launch!.command,
                [...launch!.args],
                { cwd, env: launch!.env, encoding: "utf8" },
                (_error, stdout, stderr) => resolve({ code: child.exitCode, stdout, stderr }),
              );
            },
          ),
      ),
    );
    yield* say(`${provider}: exit ${ran.code} after ${Duration.format(running)}`);
    yield* say(`${provider}: stdout\n${ran.stdout}`);
    yield* say(`${provider}: stderr\n${ran.stderr}`);
    // What runs inside: the launcher and the Node that runs it, and here the provider too.
    const launcherFile = launch!.args.at(-2)!;
    const runtimeFolder = NodePath.dirname(process.execPath);
    const launcherAcl = icacls(launcherFile);
    const runtimeAcl = icacls(runtimeFolder);
    yield* say(`${provider}: launcher ACL while held\n${launcherAcl}`);
    yield* say(`${provider}: Node's folder ACL while held\n${runtimeAcl}`);
    const during = icacls(cwd);
    yield* say(`${provider}: thread folder ACL while held\n${during}`);
    yield* isolation.release(key);
    const after = icacls(cwd);
    yield* say(`${provider}: thread folder ACL after release\n${after}`);
    const line = ran.stdout.split(/\r?\n/).find((entry) => entry.startsWith("T3PROBE "));
    assert.isDefined(line, "the stand-in printed no report");
    const report = JSON.parse(line!.slice("T3PROBE ".length)) as {
      readonly user: string;
      readonly argv: ReadonlyArray<string>;
      readonly env: Readonly<Record<string, string | null>>;
      readonly [outcome: string]: unknown;
    };
    assert.strictEqual(report.user.toLowerCase(), "srt-sandbox");
    assert.deepEqual(report.argv, ARGS);
    assert.strictEqual(report.env[host.keyVariable], SECRET_VALUE);
    assert.isTrue(
      report.env[host.folderVariable]?.endsWith(provider === "claude" ? ".claude" : ".codex"),
    );
    assert.strictEqual(report.env.USERPROFILE, report.env.HOME);
    assert.match(report.env.HTTPS_PROXY ?? "", /^http:\/\/[^@]+@127\.0\.0\.1:600[89]\d$/);
    assert.strictEqual(report.writeThread, "ok");
    assert.match(String(report.writeOutside), /^denied:/);
    assert.match(String(report.writeHooks), /^denied:/);
    assert.match(String(report.readSecret), /^denied:/);
    assert.strictEqual(report.readOwnerConfig, "ok");
    assert.match(String(report.directConnect), /^(blocked:|timeout)/);
    assert.strictEqual(report.allowedTunnel, 200);
    assert.strictEqual(report.refusedTunnel, 403);
    assert.include(during.toLowerCase(), "srt-sandbox");
    assert.include(launcherAcl.toLowerCase(), "srt-sandbox");
    // A per-user Node is granted; one every account reads already needs no grant.
    if (runtimeFolder.toLowerCase().startsWith((hostEnv.USERPROFILE ?? "").toLowerCase())) {
      assert.include(runtimeAcl.toLowerCase(), "srt-sandbox");
    }
    assert.notInclude(after.toLowerCase(), "srt-sandbox");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

// A Windows CI run exists only to run the live cases: skipping them there is a failure.
describe.runIf(
  HostProcess.Platform.defaultValue() === "win32" && process.env.GITHUB_ACTIONS === "true",
)("srt-win live on a Windows CI runner", () => {
  it("is not skipped", () => {
    assert.isTrue(
      live,
      "T3CODE_WINDOWS_LIVE=1 did not reach the test, so the live cases would skip",
    );
  });
});

describe.skipIf(!live)(
  "srt-win live: runs only on Windows with T3CODE_WINDOWS_LIVE=1, as it sets up the machine",
  () => {
    it.live("sets srt up through the setup the Settings button calls", () =>
      Effect.gen(function* () {
        const { isolation } = yield* windowsHost("claude");
        const before = yield* isolation.status;
        yield* say(`status before setup ${JSON.stringify(before)}`);
        const [took, outcome] = yield* Effect.timed(isolation.setUp);
        yield* say(`setup: ${outcome} after ${Duration.format(took)}`);
        assert.strictEqual(outcome, "done");
        const after = yield* isolation.status;
        yield* say(`status after setup ${JSON.stringify(after)}`);
        assert.strictEqual(after?.backend, "srt");
        assert.isUndefined(after?.canSetUp);
        assert.isTrue(after?.canRemove);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    it.live("runs a Claude stand-in as the sandbox account under the thread's rules", () =>
      probeAs("claude"),
    );

    it.live("runs a Codex stand-in as the sandbox account under the thread's rules", () =>
      probeAs("codex"),
    );

    // Last, as it undoes the setup the tests above use.
    it.live("removes srt through the removal the Settings button calls", () =>
      Effect.gen(function* () {
        const { isolation } = yield* windowsHost("claude");
        assert.strictEqual((yield* isolation.status)?.backend, "srt");
        const [took, outcome] = yield* Effect.timed(isolation.remove);
        yield* say(`remove: ${outcome} after ${Duration.format(took)}`);
        assert.strictEqual(outcome, "done");
        const after = yield* isolation.status;
        yield* say(`status after removal ${JSON.stringify(after)}`);
        assert.notStrictEqual(after?.backend, "srt");
        assert.isTrue(after?.canSetUp);
        assert.isUndefined(after?.canRemove);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  },
);

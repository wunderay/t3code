#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as NetService from "@t3tools/shared/Net";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { windowsSystemTar } from "./lib/windows-tar.ts";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

export class CliArchiveSmokeError extends Schema.TaggedError<CliArchiveSmokeError>()(
  "CliArchiveSmokeError",
  { step: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `CLI archive smoke test failed while ${this.step}: ${this.detail}`;
  }
}

const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const runExecutable = Effect.fn("runExecutable")(function* (
  executable: string,
  args: ReadonlyArray<string>,
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(executable, args, {
      cwd,
      env: environment,
      extendEnv: false,
      forceKillAfter: "5 seconds",
    }),
  );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [collect(child.stdout), collect(child.stderr), child.exitCode.pipe(Effect.map(Number))],
    { concurrency: "unbounded" },
  );
  return { stdout, stderr, exitCode };
});

interface SmokeInput {
  readonly archive?: string | undefined;
  readonly bundle?: string | undefined;
  readonly expectVersion: string;
  readonly requireCoordinator?: boolean;
}

const prepareSmokeTarget = Effect.fn("prepareSmokeTarget")(function* (
  input: SmokeInput,
  scratch: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  if ((input.archive === undefined) === (input.bundle === undefined)) {
    return yield* new CliArchiveSmokeError({
      step: "selecting a runtime",
      detail: "pass exactly one of --archive or --bundle",
    });
  }
  if (input.bundle !== undefined) {
    const bundle = path.resolve(input.bundle);
    const contentDir = path.dirname(bundle);
    for (const required of [bundle, path.join(contentDir, "client/index.html")]) {
      const isFile = yield* fs.stat(required).pipe(
        Effect.map((info) => info.type === "File"),
        Effect.orElseSucceed(() => false),
      );
      if (!isFile)
        return yield* new CliArchiveSmokeError({
          step: "checking the server bundle layout",
          detail: `missing file ${required}`,
        });
    }
    return {
      executable: yield* HostProcess.ExecutablePath,
      argsPrefix: [bundle],
      contentDir,
      label: `bundle ${bundle}`,
      servingStep: "serving from the bundled server",
    };
  }

  // Windows bsdtar reads zip; Git Bash's GNU tar does not.
  const tar = platform === "win32" ? windowsSystemTar() : "tar";
  const archive = input.archive;
  if (archive === undefined)
    return yield* new CliArchiveSmokeError({
      step: "selecting a runtime",
      detail: "missing --archive",
    });
  const extract = yield* spawner
    .spawn(ChildProcess.make(tar, ["-xf", archive, "-C", scratch]))
    .pipe(Effect.flatMap((child) => child.exitCode));
  if (Number(extract) !== 0) {
    return yield* new CliArchiveSmokeError({
      step: "extracting the archive",
      detail: `tar exited with ${String(extract)}`,
    });
  }
  const [root] = yield* fs.readDirectory(scratch);
  if (root === undefined) {
    return yield* new CliArchiveSmokeError({
      step: "extracting the archive",
      detail: "the archive was empty",
    });
  }
  const contentDir = path.join(scratch, root);
  const executable = path.join(contentDir, platform === "win32" ? "t3.exe" : "t3");
  const bundledLibatomic = path.join(contentDir, "lib/libatomic.so.1");
  for (const required of [
    executable,
    path.join(contentDir, "client/index.html"),
    ...(platform === "linux" ? [bundledLibatomic, `${bundledLibatomic}.LICENSE`] : []),
  ]) {
    if (!(yield* fs.exists(required))) {
      return yield* new CliArchiveSmokeError({
        step: "checking the archive layout",
        detail: `missing ${path.relative(contentDir, required)}`,
      });
    }
  }

  // The runner has libatomic installed; fresh Ubuntu servers do not.
  if (platform === "linux") {
    const ldd = yield* spawner.string(ChildProcess.make("ldd", [executable]));
    // Older glibc prints the path as given, newer prints it resolved; compare both resolved.
    const loaded = /libatomic\.so\.1 => (\/.*) \(0x[0-9a-f]+\)/.exec(ldd)?.[1];
    if (
      loaded === undefined ||
      (yield* fs.realPath(loaded)) !== (yield* fs.realPath(bundledLibatomic))
    ) {
      return yield* new CliArchiveSmokeError({
        step: "checking that t3 loads the bundled libatomic",
        detail: ldd,
      });
    }
  }

  return {
    executable,
    argsPrefix: [] as string[],
    contentDir,
    label: root,
    servingStep: "serving from the extracted archive",
  };
});

const waitUntil = Effect.fn("cliSmoke.waitUntil")(function* (probe: Effect.Effect<boolean>) {
  const polling = Effect.gen(function* () {
    while (!(yield* probe)) yield* Effect.sleep(Duration.millis(250));
    return true;
  });
  return yield* polling.pipe(
    Effect.timeout(Duration.seconds(30)),
    Effect.orElseSucceed(() => false),
  );
});

export const smokeCliArchive = Effect.fn("smokeCliArchive")(function* (input: SmokeInput) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scratch = yield* fs.makeTempDirectory({ prefix: "t3-cli-smoke-" });
  // Windows can briefly retain executable locks; cleanup retries but must not fail a successful smoke check.
  yield* Effect.addFinalizer(() =>
    fs.remove(scratch, { recursive: true }).pipe(
      Effect.retry({ times: 10, schedule: Schedule.spaced("500 millis") }),
      Effect.catch((error) =>
        Effect.logWarning(`[cli-smoke] could not remove ${scratch}: ${error.message}`),
      ),
    ),
  );
  const target = yield* prepareSmokeTarget(input, scratch);
  const home = path.join(scratch, "home");
  yield* fs.makeDirectory(home, { recursive: true });
  const supervisorDatabase = path.resolve(scratch, "coordinator.sqlite");
  const environment = {
    PATH: "",
    HOME: home,
    USERPROFILE: home,
    TMPDIR: scratch,
    TEMP: scratch,
    T3CODE_HOME: home,
    T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
    T3CODE_TELEMETRY_ENABLED: "false",
    T3CODE_OTEL_SDK_DISABLED: "true",
    ...(input.requireCoordinator ? { T3_COORDINATOR_DATABASE: supervisorDatabase } : {}),
  };

  const version = yield* runExecutable(
    target.executable,
    [...target.argsPrefix, "--version"],
    target.contentDir,
    environment,
  );
  if (version.exitCode !== 0 || !version.stdout.includes(input.expectVersion)) {
    return yield* new CliArchiveSmokeError({
      step: "running --version",
      detail: `exit ${String(version.exitCode)}\n${version.stdout}${version.stderr}`,
    });
  }

  // The service launcher loads outside the embedded CLI; without T3CODE_HOME it exits right away.
  if (input.archive !== undefined) {
    const { contentDir } = target;
    const launcher = yield* runExecutable(target.executable, ["__service-launcher"], contentDir, {
      PATH: "",
      HOME: contentDir,
      USERPROFILE: contentDir,
      TMPDIR: contentDir,
      TEMP: contentDir,
    });
    if (launcher.exitCode !== 1 || !launcher.stderr.includes("T3CODE_HOME is required")) {
      return yield* new CliArchiveSmokeError({
        step: "running __service-launcher",
        detail: `exit ${String(launcher.exitCode)}\n${launcher.stdout}${launcher.stderr}`,
      });
    }
  }

  const net = yield* NetService.NetService;
  const port = yield* net.findAvailablePort(47700);
  const server = yield* spawner.spawn(
    ChildProcess.make(
      target.executable,
      [
        ...target.argsPrefix,
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--no-browser",
      ],
      {
        cwd: target.contentDir,
        env: environment,
        extendEnv: false,
        forceKillAfter: "5 seconds",
      },
    ),
  );
  let stopped = false;
  const stopServer = Effect.gen(function* () {
    if (stopped) return;
    stopped = true;
    yield* server.kill({ killSignal: "SIGTERM", forceKillAfter: "5 seconds" }).pipe(Effect.ignore);
    yield* server.exitCode.pipe(Effect.timeout(Duration.seconds(10)), Effect.ignore);
  });
  yield* Effect.addFinalizer(() => stopServer);
  const output = yield* Effect.forkScoped(
    Effect.all([collect(server.stdout), collect(server.stderr)], { concurrency: "unbounded" }),
  );
  const httpClient = yield* HttpClient.HttpClient;
  // Probes can hang during server initialization; bound each request as SSH readiness does.
  const probe = httpClient.execute(HttpClientRequest.get(`http://127.0.0.1:${String(port)}/`)).pipe(
    Effect.map((response) => response.status === 200),
    Effect.timeout(Duration.seconds(2)),
    Effect.orElseSucceed(() => false),
  );
  const ready = yield* waitUntil(probe);
  const coordinatorReady =
    ready && input.requireCoordinator
      ? yield* waitUntil(
          fs.readFile(supervisorDatabase).pipe(
            Effect.map(
              (bytes) => new TextDecoder().decode(bytes.subarray(0, 16)) === "SQLite format 3\0",
            ),
            Effect.orElseSucceed(() => false),
          ),
        )
      : true;
  yield* stopServer;
  const [stdout, stderr] = yield* Fiber.join(output).pipe(
    Effect.timeout(Duration.seconds(5)),
    Effect.orElseSucceed(() => ["", ""] as const),
  );
  if (!ready) {
    return yield* new CliArchiveSmokeError({
      step: target.servingStep,
      detail: `no 200 from / within 30s\n${stdout}${stderr}`,
    });
  }
  if (!coordinatorReady) {
    return yield* new CliArchiveSmokeError({
      step: "checking the Coordinator supervisor",
      detail: `no valid SQLite format 3 header at ${supervisorDatabase} within 30s\n${stdout}${stderr}`,
    });
  }
  yield* Effect.log(
    `[cli-smoke] ${target.label}: --version${input.archive === undefined ? "" : " and __service-launcher"} passed, and serve answered on ${String(port)}${input.requireCoordinator ? "; Coordinator initialized its isolated SQLite database" : ""}.`,
  );
});

const command = Command.make(
  "smoke-cli-archive",
  {
    archive: Flag.String("archive").pipe(Flag.optional),
    bundle: Flag.String("bundle").pipe(
      Flag.withDescription("Bundled Node server entry, such as apps/server/dist/bin.mjs."),
      Flag.optional,
    ),
    expectVersion: Flag.String("expect-version"),
    requireCoordinator: Flag.Boolean("require-coordinator").pipe(Flag.withDefault(false)),
  },
  (input) =>
    smokeCliArchive({
      archive: Option.getOrUndefined(input.archive),
      bundle: Option.getOrUndefined(input.bundle),
      expectVersion: input.expectVersion,
      requireCoordinator: input.requireCoordinator,
    }).pipe(Effect.scoped),
).pipe(Command.withDescription("Run an isolated CLI archive or bundled Node server smoke check."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Logger.layer([Logger.consolePretty()]),
        NodeServices.layer,
        NetService.layer,
        FetchHttpClient.layer,
      ),
    ),
    NodeRuntime.runMain,
  );
}

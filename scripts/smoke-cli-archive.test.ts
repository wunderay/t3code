import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import { CliArchiveSmokeError, smokeCliArchive } from "./smoke-cli-archive.ts";

interface RecordedCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: {
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly extendEnv?: boolean;
  };
}

const handle = (
  stdout = "",
  kill = Effect.void,
  exitCode = Effect.succeed(ChildProcessSpawner.ExitCode(0)),
  stderr = "",
) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode,
    isRunning: Effect.succeed(false),
    kill: () => kill,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: stdout ? Stream.make(new TextEncoder().encode(stdout)) : Stream.empty,
    stderr: stderr ? Stream.make(new TextEncoder().encode(stderr)) : Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

const network = Layer.sync(NetService.NetService, () => ({
  ...NetService.make(),
  findAvailablePort: () => Effect.succeed(47777),
}));

it.layer(NodeServices.layer)("isolated server smoke", (it) => {
  it.effect(
    "runs a Node bundle through the host executable and checks its isolated supervisor database",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fs.makeTempDirectoryScoped({
            prefix: "t3-smoke-bundle-fixture-",
          });
          const bundle = path.join(directory, "bin.mjs");
          yield* fs.writeFileString(bundle, "bundle fixture");
          yield* fs.makeDirectory(path.join(directory, "client"));
          yield* fs.writeFileString(path.join(directory, "client/index.html"), "client fixture");
          const commands: RecordedCommand[] = [];
          let killed = 0;
          const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
          const spawner = Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) => {
              const recorded = command as unknown as RecordedCommand;
              commands.push(recorded);
              if (recorded.args.includes("--version")) return Effect.succeed(handle("1.2.3\n"));
              return Effect.gen(function* () {
                const database = recorded.options.env?.T3_COORDINATOR_DATABASE;
                if (!database) return assert.fail("Missing isolated supervisor database path");
                yield* fs.writeFileString(database, "SQLite format 3\0fixture");
                return handle(
                  "",
                  Effect.sync(() => {
                    killed += 1;
                  }).pipe(
                    Effect.andThen(Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0))),
                    Effect.asVoid,
                  ),
                  Deferred.await(exited),
                );
              });
            }),
          );
          const client = HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response("client", { status: 200 })),
            ),
          );
          yield* smokeCliArchive({ bundle, expectVersion: "1.2.3", requireCoordinator: true }).pipe(
            Effect.scoped,
            Effect.provide(
              Layer.mergeAll(
                spawner,
                network,
                Layer.succeed(HttpClient.HttpClient, client),
                Layer.succeed(HostProcess.ExecutablePath, "/absolute/node"),
              ),
            ),
          );
          assert.lengthOf(commands, 2);
          assert.equal(commands[0]?.command, "/absolute/node");
          assert.deepStrictEqual(commands[0]?.args, [bundle, "--version"]);
          assert.deepStrictEqual(commands[1]?.args, [
            bundle,
            "serve",
            "--host",
            "127.0.0.1",
            "--port",
            "47777",
            "--no-browser",
          ]);
          const environment = commands[1]?.options.env;
          assert.equal(environment?.PATH, "");
          assert.equal(environment?.HOME, environment?.T3CODE_HOME);
          assert.equal(environment?.T3CODE_TELEMETRY_ENABLED, "false");
          assert.equal(environment?.T3CODE_OTEL_SDK_DISABLED, "true");
          assert.equal(commands[1]?.options.extendEnv, false);
          assert.equal(killed, 1);
          assert.isTrue(path.isAbsolute(environment?.T3_COORDINATOR_DATABASE ?? ""));
          assert.isFalse(yield* fs.exists(environment?.T3_COORDINATOR_DATABASE ?? ""));
          assert.equal(yield* fs.readFileString(bundle), "bundle fixture");
        }),
      ),
  );

  it.effect("preserves archive extraction and executable argument behavior", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const commands: RecordedCommand[] = [];
        const spawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            const recorded = command as unknown as RecordedCommand;
            commands.push(recorded);
            return Effect.gen(function* () {
              if (recorded.command === "tar") {
                const scratch = recorded.args[recorded.args.indexOf("-C") + 1];
                if (!scratch) return assert.fail("Missing extraction destination");
                const content = path.join(scratch, "t3-1.2.3-darwin-arm64");
                yield* fs.makeDirectory(path.join(content, "client"), { recursive: true });
                yield* fs.writeFileString(path.join(content, "t3"), "executable fixture");
                yield* fs.writeFileString(
                  path.join(content, "client/index.html"),
                  "client fixture",
                );
              }
              if (recorded.args[0] === "__service-launcher")
                return handle(
                  "",
                  Effect.void,
                  Effect.succeed(ChildProcessSpawner.ExitCode(1)),
                  "T3CODE_HOME is required\n",
                );
              return handle(recorded.args.includes("--version") ? "1.2.3\n" : "");
            });
          }),
        );
        const client = HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response("client"))),
        );
        yield* smokeCliArchive({ archive: "/release/archive.tar.gz", expectVersion: "1.2.3" }).pipe(
          Effect.scoped,
          Effect.provide(
            Layer.mergeAll(
              spawner,
              network,
              Layer.succeed(HttpClient.HttpClient, client),
              Layer.succeed(HostProcess.Platform, "darwin"),
            ),
          ),
        );
        assert.equal(commands[0]?.command, "tar");
        assert.equal(commands[0]?.args[1], "/release/archive.tar.gz");
        assert.deepStrictEqual(commands[1]?.args, ["--version"]);
        assert.deepStrictEqual(commands[2]?.args, ["__service-launcher"]);
        assert.isUndefined(commands[2]?.options.env?.T3CODE_HOME);
        assert.deepStrictEqual(commands[3]?.args, [
          "serve",
          "--host",
          "127.0.0.1",
          "--port",
          "47777",
          "--no-browser",
        ]);
        assert.isUndefined(commands[3]?.options.env?.T3_COORDINATOR_DATABASE);
      }),
    ),
  );

  it.effect("rejects absent or conflicting runtime inputs before spawning", () =>
    Effect.gen(function* () {
      let spawned = false;
      const spawner = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => {
          spawned = true;
          return Effect.succeed(handle());
        }),
      );
      for (const input of [
        { expectVersion: "1.2.3" },
        { archive: "archive", bundle: "bundle", expectVersion: "1.2.3" },
      ]) {
        const error = yield* smokeCliArchive(input).pipe(
          Effect.scoped,
          Effect.flip,
          Effect.provide(
            Layer.mergeAll(
              spawner,
              network,
              Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make(() => Effect.die("HTTP must not run")),
              ),
            ),
          ),
        );
        assert.instanceOf(error, CliArchiveSmokeError);
        assert.equal(error.step, "selecting a runtime");
      }
      assert.isFalse(spawned);
    }),
  );

  it.effect("rejects a non-SQLite supervisor artifact and still stops its own server", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-smoke-invalid-sqlite-" });
        const bundle = path.join(directory, "bin.mjs");
        yield* fs.writeFileString(bundle, "bundle fixture");
        yield* fs.makeDirectory(path.join(directory, "client"));
        yield* fs.writeFileString(path.join(directory, "client/index.html"), "client fixture");
        const probed = yield* Deferred.make<void>();
        let killed = 0;
        const spawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            const recorded = command as unknown as RecordedCommand;
            if (recorded.args.includes("--version")) return Effect.succeed(handle("1.2.3\n"));
            return Effect.gen(function* () {
              const database = recorded.options.env?.T3_COORDINATOR_DATABASE;
              if (!database) return assert.fail("Missing isolated database path");
              yield* fs.writeFileString(database, "ordinary file");
              return handle(
                "",
                Effect.sync(() => {
                  killed += 1;
                }),
              );
            });
          }),
        );
        const client = HttpClient.make((request) =>
          Deferred.succeed(probed, undefined).pipe(
            Effect.as(HttpClientResponse.fromWeb(request, new Response("client"))),
          ),
        );
        const fiber = yield* smokeCliArchive({
          bundle,
          expectVersion: "1.2.3",
          requireCoordinator: true,
        }).pipe(
          Effect.scoped,
          Effect.flip,
          Effect.provide(
            Layer.mergeAll(spawner, network, Layer.succeed(HttpClient.HttpClient, client)),
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(probed);
        yield* TestClock.adjust("31 seconds");
        const error = yield* Fiber.join(fiber);
        assert.instanceOf(error, CliArchiveSmokeError);
        assert.equal(error.step, "checking the Coordinator supervisor");
        assert.equal(killed, 1);
      }),
    ),
  );
});

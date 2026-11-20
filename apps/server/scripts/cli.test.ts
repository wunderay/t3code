import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import {
  CoordinatorBuildOutputMissingError,
  coordinatorExecutableName,
  resolveResourceMonitorRustTargets,
} from "../../../scripts/build-desktop-artifact.ts";
import { DEVELOPMENT_ICON_OVERRIDES } from "../../../scripts/lib/brand-assets.ts";
import { buildServer, ServerCliUnsupportedNativeTargetError } from "./cli.ts";

function mockProcess(exitCode: number) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

const cachedSupervisor = ConfigProvider.layer(
  ConfigProvider.fromEnv({
    env: { T3CODE_DESKTOP_REUSE_COORDINATOR: "true" },
  }),
);

it.layer(NodeServices.layer)("server CLI build", (it) => {
  it.effect(
    "stages host-native supervisor assets after bundling without losing the web client",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-server-cli-build-" });
          for (const target of [
            { host: "linux", platform: "linux", arch: "x64" },
            { host: "darwin", platform: "mac", arch: "arm64" },
            { host: "win32", platform: "win", arch: "arm64" },
          ] as const) {
            const root = path.join(directory, target.host);
            const server = path.join(root, "apps/server");
            const dist = path.join(server, "dist");
            const name = coordinatorExecutableName(target.platform);
            const rustTarget = resolveResourceMonitorRustTargets(target.platform, target.arch)[0]!;
            const nativeDirectory = path.join(
              root,
              "native/coordinator/target",
              rustTarget,
              "release",
            );
            yield* fs.makeDirectory(nativeDirectory, { recursive: true });
            yield* fs.writeFileString(path.join(nativeDirectory, name), rustTarget);
            yield* fs.makeDirectory(path.join(root, "apps/web/dist"), { recursive: true });
            yield* fs.writeFileString(path.join(root, "apps/web/dist/index.html"), "web client");
            for (const icon of DEVELOPMENT_ICON_OVERRIDES) {
              const source = path.join(root, icon.sourceRelativePath);
              const webTarget = path.join(
                root,
                "apps/web",
                icon.targetRelativePath.replace("dist/client/", "dist/"),
              );
              yield* fs.makeDirectory(path.dirname(source), { recursive: true });
              yield* fs.writeFileString(source, "development icon");
              yield* fs.writeFileString(webTarget, "production icon");
            }
            const commands: Array<{
              readonly command: string;
              readonly args: ReadonlyArray<string>;
            }> = [];
            const spawner = Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make((command) => {
                const recorded = command as unknown as (typeof commands)[number];
                commands.push(recorded);
                return Effect.gen(function* () {
                  assert.deepStrictEqual(recorded.args, ["--run", "build:bundle"]);
                  yield* fs.remove(dist, { recursive: true, force: true });
                  yield* fs.makeDirectory(dist, { recursive: true });
                  yield* fs.writeFileString(path.join(dist, "bin.mjs"), "bundled server");
                  return mockProcess(0);
                });
              }),
            );
            yield* buildServer(root, { verbose: false }).pipe(
              Effect.provide(
                Layer.mergeAll(
                  spawner,
                  cachedSupervisor,
                  Layer.succeed(HostProcess.Platform, target.host),
                  Layer.succeed(HostProcess.Architecture, target.arch),
                ),
              ),
            );
            assert.lengthOf(commands, 1);
            assert.equal(yield* fs.readFileString(path.join(dist, "bin.mjs")), "bundled server");
            assert.equal(
              yield* fs.readFileString(path.join(dist, "client/index.html")),
              "web client",
            );
            assert.equal(
              yield* fs.readFileString(path.join(dist, "coordinator", name)),
              rustTarget,
            );
            for (const icon of DEVELOPMENT_ICON_OVERRIDES) {
              assert.equal(
                yield* fs.readFileString(path.join(server, icon.targetRelativePath)),
                "development icon",
              );
            }
          }
        }),
      ),
  );

  it.effect("fails the server build when its requested native companion is absent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-server-cli-native-missing-" });
        const spawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.succeed(mockProcess(0))),
        );
        const error = yield* buildServer(root, { verbose: false }).pipe(
          Effect.flip,
          Effect.provide(
            Layer.mergeAll(
              spawner,
              cachedSupervisor,
              Layer.succeed(HostProcess.Platform, "linux"),
              Layer.succeed(HostProcess.Architecture, "x64"),
            ),
          ),
        );
        assert.instanceOf(error, CoordinatorBuildOutputMissingError);
        assert.equal(error.rustTarget, "x86_64-unknown-linux-gnu");
      }),
    ),
  );

  it.effect("rejects unsupported native build targets before spawning a bundler", () =>
    Effect.gen(function* () {
      let spawned = false;
      const spawner = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => {
          spawned = true;
          return Effect.succeed(mockProcess(0));
        }),
      );
      const error = yield* buildServer("/unused", { verbose: false }).pipe(
        Effect.flip,
        Effect.provide(
          Layer.mergeAll(
            spawner,
            Layer.succeed(HostProcess.Platform, "linux"),
            Layer.succeed(HostProcess.Architecture, "riscv64"),
          ),
        ),
      );
      assert.instanceOf(error, ServerCliUnsupportedNativeTargetError);
      assert.isFalse(spawned);
    }),
  );
});

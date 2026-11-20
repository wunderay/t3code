import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, type ProviderAuthState } from "@t3tools/contracts";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { makeCliLoginAuth } from "./CliLoginAuth.ts";

const instanceId = ProviderInstanceId.make("claude_work");

const makeHarness = (options: { readonly exitCode?: number; readonly holdChange?: boolean } = {}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    // The CLI exits when the test says, after the client's response has returned, as a real one does.
    const cliExit = yield* Deferred.make<number>();
    // Holding the re-probe keeps "verifying" observable.
    const changeGate = yield* Deferred.make<void>();
    if (!options.holdChange) yield* Deferred.succeed(changeGate, undefined);
    if (options.exitCode !== undefined) yield* Deferred.succeed(cliExit, options.exitCode);
    const configDir = `${yield* fileSystem.makeTempDirectoryScoped()}/account`;
    const changed: boolean[] = [];
    const commands: Array<{ args: ReadonlyArray<string>; stdin: string }> = [];
    const written: Array<string | Buffer> = [];
    let spawned: PtyAdapter.PtySpawnInput | undefined;
    let data: ((data: string) => void) | undefined;
    let exit: ((event: PtyAdapter.PtyExitEvent) => void) | undefined;
    const processStarted = yield* Deferred.make<void>();
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const call = {
          args: ChildProcess.isStandardCommand(command) ? command.args.map(String) : [],
          stdin: "",
        };
        commands.push(call);
        Deferred.doneUnsafe(processStarted, Effect.void);
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(900_000_010),
          exitCode: Deferred.await(cliExit).pipe(Effect.map(ChildProcessSpawner.ExitCode)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.forEach((bytes: Uint8Array) =>
            Effect.sync(() => {
              call.stdin += new TextDecoder().decode(bytes);
            }),
          ),
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    );
    const auth = yield* makeCliLoginAuth({
      instanceId,
      command: "claude",
      cwd: "/state",
      env: { CLAUDE_CONFIG_DIR: configDir },
      configDir,
      methods: [
        { id: "claudeai", name: "Claude", description: null, args: ["auth", "login"] },
        {
          id: "apiKey",
          name: "API key",
          description: null,
          args: ["login", "--with-api-key"],
          stdinField: { name: "apiKey", label: "API key" },
        },
      ],
      logoutArgs: ["auth", "logout"],
      onChanged: (signedIn) =>
        Deferred.await(changeGate).pipe(
          Effect.andThen(
            Effect.sync(() => {
              changed.push(signedIn);
            }),
          ),
        ),
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(PtyAdapter.PtyAdapter, {
        spawn: (input) =>
          Effect.sync(() => {
            spawned = input;
            return {
              pid: 123,
              write: (value) => {
                written.push(value);
              },
              resize: () => {},
              kill: () => {},
              onData: (callback) => {
                data = callback;
                return () => {};
              },
              onExit: (callback) => {
                exit = callback;
                return () => {};
              },
            };
          }),
      }),
    );
    const state = (predicate: (state: ProviderAuthState) => boolean) =>
      auth.subscribe("owner").pipe(
        Stream.filter(predicate),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
        // A state that never comes fails here instead of hanging until the suite's timeout.
        Effect.timeoutOrElse({
          duration: "5 seconds",
          orElse: () => Effect.die(new Error("The expected sign-in state never arrived.")),
        }),
        TestClock.withLive,
      );
    return {
      auth,
      configDir,
      changed,
      commands,
      written,
      state,
      spawned: () => spawned,
      data: (value: string) => data?.(value),
      exit: (exitCode: number) => exit?.({ exitCode, signal: null }),
      folderExists: fileSystem.exists(configDir),
      cliExit: (code: number) => Deferred.succeed(cliExit, code),
      releaseChange: Deferred.succeed(changeGate, undefined),
      processStarted: Deferred.await(processStarted),
    };
  });

const services = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(services));

it.effect("runs the CLI's login in a terminal for the account folder, creating it first", () =>
  run(
    Effect.gen(function* () {
      const h = yield* makeHarness({ holdChange: true });
      const flow = yield* h.auth.start("owner", Effect.void, "claudeai");
      yield* h.state((value) => value.interaction?.type === "terminal");
      assert.isTrue(yield* h.folderExists);
      assert.deepEqual(h.spawned(), {
        shell: "claude",
        args: ["auth", "login"],
        cwd: "/state",
        cols: 80,
        rows: 24,
        env: { CLAUDE_CONFIG_DIR: h.configDir },
      });
      h.data("Paste code here if prompted > ");
      yield* h.state(
        (value) =>
          value.interaction?.type === "terminal" &&
          value.interaction.output === "Paste code here if prompted > ",
      );
      yield* h.auth.respond!("owner", {
        instanceId,
        flowId: flow.flowId!,
        interactionId: "terminal",
        response: { type: "terminal", data: "code#state\r" },
      });
      assert.deepEqual(h.written, ["code#state\r"]);
      h.exit(0);
      yield* h.state((value) => value.phase === "verifying");
      yield* h.releaseChange;
      yield* h.state((value) => value.phase === "succeeded");
      assert.deepEqual(h.changed, [true]);
    }),
  ),
);

it.effect("fails the sign-in when the CLI's login exits non-zero", () =>
  run(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.auth.start("owner", Effect.void, "claudeai");
      yield* h.state((value) => value.interaction?.type === "terminal");
      h.exit(1);
      const failed = yield* h.state((value) => value.phase === "failed");
      assert.strictEqual(
        failed.message,
        "The provider's sign-in command did not finish successfully.",
      );
      assert.deepEqual(h.changed, []);
    }),
  ),
);

it.effect("pipes an API key to the CLI's stdin and never into its arguments", () =>
  run(
    Effect.gen(function* () {
      const h = yield* makeHarness({ holdChange: true });
      const flow = yield* h.auth.start("owner", Effect.void, "apiKey");
      const prompt = yield* h.state((value) => value.interaction?.type === "credentials");
      assert.deepEqual(prompt.methods?.[1]?.type, "credentials");
      yield* h.auth.respond!("owner", {
        instanceId,
        flowId: flow.flowId!,
        interactionId: "credentials",
        response: { type: "credentials", values: { apiKey: " sk-test " } },
      });
      // The CLI holds its exit and the re-probe is held, so "verifying" stays observable.
      yield* h.state((value) => value.phase === "verifying");
      yield* h.cliExit(0);
      yield* h.releaseChange;
      yield* h.state((value) => value.phase === "succeeded");
      assert.deepEqual(h.commands, [{ args: ["login", "--with-api-key"], stdin: "sk-test" }]);
      assert.deepEqual(h.changed, [true]);
    }),
  ),
);

it.effect("signs out with the CLI's logout and reports a failed logout", () =>
  run(
    Effect.gen(function* () {
      const h = yield* makeHarness({ exitCode: 0 });
      const state = yield* h.auth.logout(Effect.void);
      assert.strictEqual(state.phase, "idle");
      assert.deepEqual(h.commands, [{ args: ["auth", "logout"], stdin: "" }]);
      assert.deepEqual(h.changed, [false]);

      // Instances on one folder share a login; another folder is another account.
      assert.deepEqual(h.auth.credentialBinding, { owner: "provider", key: `cli:${h.configDir}` });
      const failing = yield* makeHarness({ exitCode: 1 });
      assert.notDeepEqual(failing.auth.credentialBinding, h.auth.credentialBinding);
      const result = yield* failing.auth.logout(Effect.void).pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      assert.deepEqual(failing.changed, []);
    }),
  ),
);

it.effect("bounds a CLI that never exits, so logout fails and sign-in can start again", () =>
  run(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const logout = yield* h.auth.logout(Effect.void).pipe(Effect.flip, Effect.forkChild);
      yield* h.processStarted;
      yield* TestClock.adjust("60 seconds");
      const error = yield* Fiber.join(logout);
      assert.strictEqual(error.detail, "The provider CLI did not finish in time. Try again.");
      assert.deepEqual(h.changed, []);
      yield* h.auth.start("owner", Effect.void, "claudeai");
      yield* h.state((value) => value.interaction?.type === "terminal");
    }),
  ),
);

it.effect("bounds an API-key login whose CLI never exits", () =>
  run(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const flow = yield* h.auth.start("owner", Effect.void, "apiKey");
      yield* h.state((value) => value.interaction?.type === "credentials");
      yield* h.auth.respond!("owner", {
        instanceId,
        flowId: flow.flowId!,
        interactionId: "credentials",
        response: { type: "credentials", values: { apiKey: "sk-test" } },
      });
      yield* h.processStarted;
      yield* TestClock.adjust("60 seconds");
      const failed = yield* h.state((value) => value.phase === "failed");
      assert.strictEqual(failed.message, "The provider CLI did not finish in time. Try again.");
    }),
  ),
);

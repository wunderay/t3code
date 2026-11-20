import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
// @effect-diagnostics-next-line nodeBuiltinImport:off - injected native child fixture exercises supervisor-owned stdio and scoped shutdown.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
// @effect-diagnostics-next-line nodeBuiltinImport:off - a scripted child stands in for the store process.
import * as NodeStream from "node:stream";
import * as ServerConfig from "../config.ts";
import * as Supervisor from "./Supervisor.ts";

const platform = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "coordinator-supervisor-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

// A store last seen on: what these tests of the transport talk to.
const storeOn = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.writeFileString(path.join(config.stateDir, "coordinator.sqlite.enabled"), "1\n");
});

it.effect("an invalid explicit supervisor path never starts a child", () =>
  Effect.gen(function* () {
    const supervisor = yield* Supervisor.Supervisor;
    assert.isFalse(supervisor.available);
    const result = yield* supervisor.request("snapshot", {}).pipe(Effect.result);
    assert.equal(result._tag, "Failure");
  }).pipe(
    Effect.provide(Supervisor.layer),
    Effect.provideService(HostProcess.Environment, { T3_COORDINATOR_EXECUTABLE: "relative-path" }),
    Effect.provide(platform),
  ),
);

it.live(
  "one scoped stdio child serves consecutive requests and rejects mismatched or failed replies",
  () =>
    Effect.gen(function* () {
      yield* storeOn;
      for (const reply of ["wrong-id", "rust-error", "valid"] as const) {
        let starts = 0;
        const fixture = `let pending=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',chunk=>{pending+=chunk;let end;while((end=pending.indexOf('\\n'))>=0){const request=JSON.parse(pending.slice(0,end));pending=pending.slice(end+1);process.stdout.write(JSON.stringify({id:${reply === "wrong-id" ? "'stale'" : "request.id"},${reply === "rust-error" ? "error:{code:-32003,message:'denied'}" : "result:{protocolVersion:1}"}})+'\\n');}});`;
        yield* Effect.gen(function* () {
          const supervisor = yield* Supervisor.Supervisor;
          for (let call = 0; call < 2; call++) {
            const result = yield* supervisor.request("snapshot", {}).pipe(Effect.result);
            assert.equal(result._tag, reply === "valid" ? "Success" : "Failure");
          }
          assert.equal(starts, 1);
        }).pipe(
          Effect.provide(Supervisor.layer),
          Effect.provideService(HostProcess.Environment, {
            T3_COORDINATOR_EXECUTABLE: process.execPath,
          }),
          Effect.provideService(Supervisor.SupervisorSpawn, (_executable, _args, options) => {
            starts++;
            assert.isTrue(options.windowsHide);
            assert.isFalse(Boolean(options.shell));
            return NodeChildProcess.spawn(process.execPath, ["-e", fixture], options);
          }),
          Effect.scoped,
        );
      }
    }).pipe(Effect.provide(platform)),
);

it.effect(
  "finds the target companion beside the bootstrap resource monitor without Electron resourcesPath",
  () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const hostPlatform = yield* HostProcess.Platform;
      const monitor = path.join(config.stateDir, "packaged", "resource-monitor", "monitor");
      const expected = path.resolve(
        path.dirname(monitor),
        "../coordinator",
        hostPlatform === "win32" ? "t3-coordinator.exe" : "t3-coordinator",
      );
      const available = yield* Effect.gen(function* () {
        return (yield* Supervisor.Supervisor).available;
      }).pipe(
        Effect.provide(Supervisor.layer),
        Effect.provideService(ServerConfig.ServerConfig, {
          ...config,
          resourceMonitorPath: monitor,
        }),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          exists: (candidate) => Effect.succeed(candidate === expected),
        }),
        Effect.provideService(HostProcess.Environment, {}),
        Effect.scoped,
      );
      assert.isTrue(available);
    }).pipe(Effect.provide(platform)),
);

type Script = "answer" | "configured" | "exit" | "silent" | "flood" | "trailing" | "throw";
type ScriptedChild = ReturnType<typeof scriptedChild>;

// A store child driven through its pipes: it answers each request, exits, never replies, floods
// stdout past the reply bound, or writes more after its reply line.
const scriptedChild = (script: Script, received: () => void) => {
  const child = Object.assign(new NodeEvents.EventEmitter(), {
    stdin: new NodeStream.PassThrough(),
    stdout: new NodeStream.PassThrough(),
    stderr: new NodeStream.PassThrough(),
    exitCode: null as number | null,
    kills: 0,
    exit: () => {
      if (child.exitCode !== null) return;
      child.exitCode = 1;
      child.emit("exit", 1, null);
    },
    kill: () => {
      child.kills++;
      child.exit();
      return true;
    },
  });
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (line: string) => {
    received();
    const { id } = JSON.parse(line) as { id: string };
    if (script === "answer") child.stdout.write(`${JSON.stringify({ id, result: {} })}\n`);
    if (script === "configured")
      child.stdout.write(
        `${JSON.stringify({
          id,
          result: {
            configuration: { enabled: true, coordinatorPaused: false, coordinatorThreadId: "lead" },
            pause: { active: true },
          },
        })}\n`,
      );
    if (script === "exit") child.exit();
    if (script === "flood") child.stdout.write(Buffer.alloc(1_048_577, 32));
    if (script === "trailing")
      child.stdout.write(`${JSON.stringify({ id, result: {} })}\n{"id":"next"}`);
  });
  return child;
};

// Children are spawned from `scripts` in order, then answering ones; "throw" makes spawn throw.
const scripted = <A>(
  scripts: ReadonlyArray<Script>,
  test: (
    supervisor: Supervisor.Supervisor["Service"],
    children: ReadonlyArray<ScriptedChild>,
    received: Deferred.Deferred<void>,
  ) => Effect.Effect<A>,
) =>
  Effect.gen(function* () {
    yield* storeOn;
    const children: Array<ScriptedChild> = [];
    const received = yield* Deferred.make<void>();
    return yield* Effect.gen(function* () {
      return yield* test(yield* Supervisor.Supervisor, children, received);
    }).pipe(
      Effect.provide(Supervisor.layer),
      Effect.provideService(HostProcess.Environment, {
        T3_COORDINATOR_EXECUTABLE: process.execPath,
      }),
      Effect.provideService(Supervisor.SupervisorSpawn, () => {
        const child = scriptedChild(scripts[children.length] ?? "answer", () =>
          Deferred.doneUnsafe(received, Effect.void),
        );
        children.push(child);
        if (scripts[children.length - 1] === "throw") throw new Error("spawn failed");
        return child as unknown as NodeChildProcess.ChildProcessWithoutNullStreams;
      }),
      Effect.scoped,
    );
  }).pipe(Effect.provide(platform));

const outcome = (supervisor: Supervisor.Supervisor["Service"]) =>
  supervisor.request("snapshot", {}).pipe(
    Effect.result,
    Effect.map((result) => result._tag),
  );

it.effect("a store child that exited is respawned by a later request after a growing wait", () =>
  scripted(
    Array.from({ length: 8 }, () => "exit"),
    (supervisor, children) =>
      Effect.gen(function* () {
        assert.equal(yield* outcome(supervisor), "Failure");
        // Each loss in a row doubles the wait, up to a minute; no child starts before it ends.
        for (const [loss, seconds] of [1, 2, 4, 8, 16, 32, 60, 60].entries()) {
          yield* TestClock.adjust(`${seconds * 1_000 - 1} millis`);
          assert.equal(yield* outcome(supervisor), "Failure");
          assert.equal(children.length, loss + 1);
          yield* TestClock.adjust("1 milli");
          assert.equal(yield* outcome(supervisor), loss < 7 ? "Failure" : "Success");
          assert.equal(children.length, loss + 2);
        }
        // A reply resets the wait: the next loss waits one second again.
        children[8]!.exit();
        yield* TestClock.adjust("1 second");
        assert.equal(yield* outcome(supervisor), "Success");
        assert.equal(children.length, 10);
      }),
  ),
);

it.effect("a spawn that throws counts as a lost child", () =>
  scripted(["throw"], (supervisor, children) =>
    Effect.gen(function* () {
      assert.equal(yield* outcome(supervisor), "Failure");
      assert.equal(yield* outcome(supervisor), "Failure");
      assert.equal(children.length, 1);
      yield* TestClock.adjust("1 second");
      assert.equal(yield* outcome(supervisor), "Success");
    }),
  ),
);

it.effect("a store child that times out, sends a bad reply or fails a pipe is replaced", () =>
  Effect.gen(function* () {
    yield* scripted(["silent"], (supervisor, children, received) =>
      Effect.gen(function* () {
        const pending = yield* outcome(supervisor).pipe(Effect.forkChild);
        yield* Deferred.await(received);
        yield* TestClock.adjust("15 seconds");
        assert.equal(yield* Fiber.join(pending), "Failure");
        assert.equal(children[0]!.kills, 1);
        assert.equal(yield* outcome(supervisor), "Success");
        assert.equal(children.length, 2);
      }),
    );
    for (const script of ["flood", "trailing"] as const)
      yield* scripted([script], (supervisor, children) =>
        Effect.gen(function* () {
          assert.equal(yield* outcome(supervisor), "Failure");
          assert.equal(children[0]!.kills, 1);
          yield* TestClock.adjust("1 second");
          assert.equal(yield* outcome(supervisor), "Success");
          assert.equal(children.length, 2);
        }),
      );
    // A failing process or pipe drops the idle child too.
    for (const failed of [
      (child: ScriptedChild) => child,
      (child: ScriptedChild) => child.stdin,
      (child: ScriptedChild) => child.stdout,
    ])
      yield* scripted([], (supervisor, children) =>
        Effect.gen(function* () {
          assert.equal(yield* outcome(supervisor), "Success");
          failed(children[0]!).emit("error", new Error("broken"));
          assert.equal(children[0]!.kills, 1);
          yield* TestClock.adjust("1 second");
          assert.equal(yield* outcome(supervisor), "Success");
          assert.equal(children.length, 2);
        }),
      );
  }),
);

it.effect("remembers from any snapshot whether the Coordinator is on, so others need not ask", () =>
  scripted(["configured"], (supervisor) =>
    Effect.gen(function* () {
      // Last seen on: unknown until a snapshot says.
      assert.isNull(yield* supervisor.lastSeen!);
      yield* supervisor.request("snapshot", {}).pipe(Effect.orDie);
      assert.deepEqual(yield* supervisor.lastSeen!, {
        enabled: true,
        coordinatorThreadId: "lead",
        paused: true,
      });
    }),
  ),
);

it.live("knows the Coordinator is off before any read once a store was last seen off", () =>
  Effect.gen(function* () {
    const fixture = `let pending=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',chunk=>{pending+=chunk;let end;while((end=pending.indexOf('\\n'))>=0){const request=JSON.parse(pending.slice(0,end));pending=pending.slice(end+1);process.stdout.write(JSON.stringify({id:request.id,result:{configuration:{enabled:false,coordinatorPaused:false},pause:{active:false}}})+'\\n');}});`;
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const database = path.join(config.stateDir, "coordinator.sqlite");
    let starts = 0;
    const built = <A, E>(
      use: (supervisor: Supervisor.Supervisor["Service"]) => Effect.Effect<A, E>,
    ) =>
      Effect.gen(function* () {
        return yield* use(yield* Supervisor.Supervisor);
      }).pipe(
        Effect.provide(Supervisor.layer),
        Effect.provideService(HostProcess.Environment, {
          T3_COORDINATOR_EXECUTABLE: process.execPath,
          T3_COORDINATOR_DATABASE: database,
        }),
        Effect.provideService(Supervisor.SupervisorSpawn, (_executable, _args, options) => {
          starts++;
          return NodeChildProcess.spawn(process.execPath, ["-e", fixture], options);
        }),
        Effect.scoped,
      );
    // A store made before the switch was kept: unknown, so read once.
    yield* fs.writeFileString(database, "");
    yield* built((supervisor) =>
      Effect.gen(function* () {
        assert.isNull(yield* supervisor.lastSeen!);
        yield* supervisor.request("snapshot", {});
        assert.isFalse((yield* supervisor.lastSeen!)!.enabled);
      }),
    );
    assert.equal((yield* fs.readFileString(`${database}.enabled`)).trim(), "0");
    // Seen off: the next start knows it without a child.
    yield* built((supervisor) =>
      Effect.map(supervisor.lastSeen!, (seen) => assert.isFalse(seen!.enabled)),
    );
    assert.equal(starts, 1);
  }).pipe(Effect.provide(platform)),
);

it.live("off, no request but the switch starts the store or reaches it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // Every arm of the store's dispatch, alternations ("a" | "b" =>) included.
    const methods = [
      ...(yield* fs.readFileString(
        path.resolve(import.meta.dirname, "../../../../native/coordinator/src/lib.rs"),
      )).matchAll(/^\s+((?:"[a-z][a-z_.]*"\s*\|\s*)*"[a-z][a-z_.]*")\s*=>/gm),
    ].flatMap((match) => [...match[1]!.matchAll(/"([a-z][a-z_.]*)"/g)].map((name) => name[1]!));
    assert.isAbove(methods.length, 50);
    assert.includeMembers(methods, ["assignments.update", "assignments.ack", "snapshot"]);
    let starts = 0;
    yield* Effect.gen(function* () {
      const supervisor = yield* Supervisor.Supervisor;
      for (const method of methods.filter((each) => each !== "configure")) {
        const result = yield* supervisor.request(method, {}).pipe(Effect.result);
        assert.equal(result._tag === "Failure" && result.failure.reason, "policy", method);
      }
      assert.equal(starts, 0);
      // The switch alone may start it.
      yield* supervisor.request("configure", {}).pipe(Effect.ignore);
      assert.equal(starts, 1);
    }).pipe(
      Effect.provide(Supervisor.layer),
      Effect.provideService(HostProcess.Environment, {
        T3_COORDINATOR_EXECUTABLE: process.execPath,
      }),
      Effect.provideService(Supervisor.SupervisorSpawn, () => {
        starts++;
        throw new Error("spawn failed");
      }),
      Effect.scoped,
    );
  }).pipe(Effect.provide(platform)),
);

it.live("a torn or unknown marker is read as unknown, so the store is read once", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const text of ["", "1", "garbage", "0\n"]) {
      yield* fs.writeFileString(path.join(config.stateDir, "coordinator.sqlite.enabled"), text);
      const seen = yield* Effect.gen(function* () {
        return yield* (yield* Supervisor.Supervisor).lastSeen!;
      }).pipe(
        Effect.provide(Supervisor.layer),
        Effect.provideService(HostProcess.Environment, {
          T3_COORDINATOR_EXECUTABLE: process.execPath,
        }),
        Effect.scoped,
      );
      // Only "0" itself says off.
      assert.equal(seen?.enabled, text.trim() === "0" ? false : undefined, JSON.stringify(text));
    }
  }).pipe(Effect.provide(platform)),
);

/** A store whose switch follows `configure`; it answers a snapshot and the switch with its state. */
const switchedStore = (initially: boolean) => {
  let enabled = initially;
  const children: Array<ScriptedChild> = [];
  const spawn = () => {
    const child = scriptedChild("silent", () => undefined);
    child.stdin.on("data", (line: string) => {
      const { id, method, params } = JSON.parse(line) as {
        id: string;
        method: string;
        params: { enabled?: boolean };
      };
      if (method === "configure" && typeof params.enabled === "boolean") enabled = params.enabled;
      const state = {
        configuration: { enabled, coordinatorPaused: false, coordinatorThreadId: "lead" },
        pause: { active: false },
      };
      const reply = `${JSON.stringify({ id, result: method === "tick" ? {} : state })}\n`;
      child.stdout.write(reply);
    });
    children.push(child);
    return child as unknown as NodeChildProcess.ChildProcessWithoutNullStreams;
  };
  return { children, spawn };
};

const withStore = <A, E>(
  store: ReturnType<typeof switchedStore>,
  test: (supervisor: Supervisor.Supervisor["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    return yield* test(yield* Supervisor.Supervisor);
  }).pipe(
    Effect.provide(Supervisor.layer),
    Effect.provideService(HostProcess.Environment, { T3_COORDINATOR_EXECUTABLE: process.execPath }),
    Effect.provideService(Supervisor.SupervisorSpawn, store.spawn),
    Effect.scoped,
  );

it.effect("an older snapshot answered after the switch never closes what the switch opened", () =>
  Effect.gen(function* () {
    yield* storeOn;
    const store = switchedStore(false);
    yield* withStore(store, (supervisor) =>
      Effect.gen(function* () {
        // Sent in this order: a read of the old state, then the owner's switch.
        const older = yield* supervisor.request("snapshot", {}).pipe(Effect.forkChild);
        const switched = yield* supervisor
          .request("configure", { enabled: true })
          .pipe(Effect.forkChild);
        yield* Fiber.join(older);
        yield* Fiber.join(switched);
        assert.isTrue((yield* supervisor.lastSeen!)!.enabled);
        yield* supervisor.request("tick", {});
      }),
    );
  }).pipe(Effect.provide(platform)),
);

it.effect("switched off, the store process ends, and only switching on again starts one", () =>
  Effect.gen(function* () {
    yield* storeOn;
    const store = switchedStore(true);
    yield* withStore(store, (supervisor) =>
      Effect.gen(function* () {
        yield* supervisor.request("snapshot", {});
        yield* supervisor.request("configure", { enabled: false });
        assert.equal(store.children.length, 1);
        assert.equal(store.children[0]!.kills, 1);
        // Off: nothing else is sent, and nothing starts a store.
        assert.equal((yield* supervisor.request("tick", {}).pipe(Effect.result))._tag, "Failure");
        assert.equal(store.children.length, 1);
        yield* supervisor.request("configure", { enabled: true });
        yield* supervisor.request("tick", {});
        assert.equal(store.children.length, 2);
      }),
    );
  }).pipe(Effect.provide(platform)),
);

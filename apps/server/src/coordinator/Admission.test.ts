import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { DEFAULT_COORDINATOR_LABELS, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";
import * as Admission from "./Admission.ts";
import * as Supervisor from "./Supervisor.ts";

// The owner: T3 Code threads work as they would without the Coordinator, enabled or not.
it.effect(
  "an ordinary thread is not routed, limited or capped; only the Coordinator's own is held",
  () => {
    const methods: Array<string> = [];
    const supervisor = Supervisor.Supervisor.of({
      available: true,
      request: (method) =>
        Effect.sync(() => {
          methods.push(method);
          return {
            protocolVersion: 1,
            revision: 1,
            configuration: {
              enabled: true,
              coordinatorPaused: false,
              labels: DEFAULT_COORDINATOR_LABELS,
              permissionMode: "ask",
              placement: "automatic",
              coordinatorTitle: null,
              coordinatorProvider: "replay",
              coordinatorModel: "model",
              coordinatorProjectId: "project",
              coordinatorThreadId: "coordinator-lead:one",
            },
            pause: { active: false, revision: 0 },
            cards: [],
            goals: [],
            pendingActions: [],
            catalog: [],
            overrides: [],
            permissions: [],
          };
        }),
    });
    const turn = (threadId: string) => ({
      runId: `run:${threadId}`,
      threadId,
      projectId: "project",
      driver: "replay",
      selection: { instanceId: ProviderInstanceId.make("replay"), model: "model" },
      runtimeMode: "approval-required" as const,
      asksFirst: true,
    });
    return Effect.gen(function* () {
      const admission = yield* Admission.Admission;
      yield* admission.admit(turn("owner"));
      // Not even the configuration is read: no route, board, limit or cap, Coordinator on or off.
      assert.deepEqual(methods, []);
      // The Coordinator's own thread runs while the store names it.
      yield* admission.admit(turn("coordinator-lead:one"));
      // Any instance and model may hold the thread, not only the one chosen in Settings.
      yield* admission.admit({
        ...turn("coordinator-lead:one"),
        selection: { instanceId: ProviderInstanceId.make("other"), model: "other" },
      });
      // It runs only asking first, and only on a provider that can.
      const unasked = yield* admission
        .admit({ ...turn("coordinator-lead:one"), runtimeMode: "auto-accept-edits" })
        .pipe(Effect.flip);
      assert.include(unasked.message, "approval required");
      const cannotAsk = yield* admission
        .admit({ ...turn("coordinator-lead:one"), asksFirst: false })
        .pipe(Effect.flip);
      assert.include(cannotAsk.message, "can't ask before");
      const former = yield* admission.admit(turn("coordinator-lead:old")).pipe(Effect.flip);
      assert.equal(former.operation, "coordinator-admission");
      yield* admission.admit(turn("owner"));
      assert.deepEqual(
        methods,
        Array.from({ length: 5 }, () => "snapshot"),
      );
    }).pipe(
      Effect.provide(
        Admission.layerWithoutDependencies.pipe(
          Layer.provide(Layer.succeed(Supervisor.Supervisor, supervisor)),
        ),
      ),
    );
  },
);

it.effect("names the Coordinator in its refusals as the owner named it", () => {
  const refusal = (labels: typeof DEFAULT_COORDINATOR_LABELS) =>
    Effect.gen(function* () {
      const admission = yield* Admission.Admission;
      const refused = yield* admission
        .admit({
          runId: "run",
          threadId: "coordinator-lead:one",
          projectId: "project",
          driver: "replay",
          selection: { instanceId: ProviderInstanceId.make("replay"), model: "model" },
          runtimeMode: "auto-accept-edits",
          asksFirst: true,
        })
        .pipe(Effect.flip);
      return refused.message;
    }).pipe(
      Effect.provide(
        Admission.layerWithoutDependencies.pipe(
          Layer.provide(
            Layer.succeed(
              Supervisor.Supervisor,
              Supervisor.Supervisor.of({
                available: true,
                request: () =>
                  Effect.succeed({
                    protocolVersion: 1,
                    revision: 1,
                    configuration: {
                      enabled: true,
                      coordinatorPaused: false,
                      labels,
                      permissionMode: "ask",
                      placement: "automatic",
                      coordinatorTitle: null,
                      coordinatorProvider: "replay",
                      coordinatorModel: "model",
                      coordinatorProjectId: "project",
                      coordinatorThreadId: "coordinator-lead:one",
                    },
                    pause: { active: false, revision: 0 },
                    cards: [],
                    goals: [],
                    pendingActions: [],
                    catalog: [],
                    overrides: [],
                    permissions: [],
                  }),
              }),
            ),
          ),
        ),
      ),
    );
  return Effect.gen(function* () {
    assert.equal(
      yield* refusal(DEFAULT_COORDINATOR_LABELS),
      "The Conductor's thread runs only with approval required. Set its mode back to approval required.",
    );
    assert.equal(
      yield* refusal({
        ...DEFAULT_COORDINATOR_LABELS,
        coordinatorSingular: "Claudia",
        coordinatorNameKind: "given",
      }),
      "Claudia's thread runs only with approval required. Set its mode back to approval required.",
    );
  });
});

it.effect(
  "a former Coordinator thread's run while it is off is refused and starts no store",
  () => {
    let spawns = 0;
    return Effect.gen(function* () {
      const admission = yield* Admission.Admission;
      const refused = yield* admission
        .admit({
          runId: "run",
          threadId: "coordinator-lead:old",
          projectId: "project",
          driver: "replay",
          selection: { instanceId: ProviderInstanceId.make("replay"), model: "model" },
          runtimeMode: "approval-required",
          asksFirst: true,
        })
        .pipe(Effect.flip);
      assert.equal(refused.reason, "policy");
      assert.equal(spawns, 0);
    }).pipe(
      Effect.provide(Admission.layer),
      Effect.provideService(Supervisor.SupervisorSpawn, () => {
        spawns++;
        throw new Error("No store process in this test.");
      }),
      Effect.provideService(HostProcess.Environment, {
        T3_COORDINATOR_EXECUTABLE: process.execPath,
      }),
      Effect.provide(
        ServerConfig.ServerConfig.layerTest(process.cwd(), {
          prefix: "coordinator-admission-",
        }).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );
  },
);

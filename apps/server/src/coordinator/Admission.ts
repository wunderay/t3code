import {
  CoordinatorError,
  coordinatorInText,
  CoordinatorSnapshot,
  type ModelSelection,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Supervisor from "./Supervisor.ts";

export class Admission extends Context.Service<
  Admission,
  {
    readonly admit: (input: {
      readonly runId: string;
      readonly threadId: string;
      readonly projectId: string;
      readonly driver: string;
      readonly selection: ModelSelection;
      readonly runtimeMode?: RuntimeMode;
      /** The provider asks before it runs a command or changes a file. */
      readonly asksFirst?: boolean;
    }) => Effect.Effect<void, CoordinatorError>;
  }
>()("t3/coordinator/Admission") {}

const decodeSnapshot = Schema.decodeUnknownEffect(CoordinatorSnapshot);

const make = Effect.gen(function* () {
  const supervisor = yield* Supervisor.Supervisor;
  const admit = Effect.fn("Coordinator.Admission.admit")(function* (
    input: Parameters<Admission["Service"]["admit"]>[0],
  ) {
    // The Coordinator's thread is always created under this prefix, so a person's own thread is
    // told apart without reading the store: its runs start as they would without the Coordinator.
    if (!input.threadId.startsWith("coordinator-lead:")) return;
    // A Coordinator thread runs only while it is the one the store names, on its instance and model.
    const refused = new CoordinatorError({ operation: "coordinator-admission", reason: "policy" });
    if (!supervisor.available) return yield* refused;
    const raw = yield* supervisor.request("snapshot", { limit: 100 });
    const snapshot = yield* decodeSnapshot(raw).pipe(
      Effect.mapError(
        (cause) => new CoordinatorError({ operation: "admission", reason: "invalid", cause }),
      ),
    );
    // The thread runs on whatever instance and model it is set to.
    if (
      !snapshot.configuration.enabled ||
      snapshot.configuration.coordinatorThreadId !== input.threadId ||
      snapshot.configuration.coordinatorProjectId !== input.projectId
    )
      return yield* refused;
    const named = (start: boolean) => coordinatorInText(snapshot.configuration.labels, start);
    // Its own thread changes no files and runs no commands: it starts only where it asks first,
    // and the host declines what it asks.
    if (input.asksFirst !== true)
      return yield* new CoordinatorError({
        operation: "coordinator-thread",
        reason: "unsupported",
        detail: `This provider can't ask before it runs a command or changes a file, so it can't hold ${named(false)}'s thread. Choose another in Settings.`,
      });
    if (input.runtimeMode !== "approval-required")
      return yield* new CoordinatorError({
        operation: "coordinator-thread",
        reason: "policy",
        detail: `${named(true)}'s thread runs only with approval required. Set its mode back to approval required.`,
      });
  });
  return Admission.of({ admit });
});
export const layerWithoutDependencies = Layer.effect(Admission, make);
export const layer = layerWithoutDependencies.pipe(Layer.provide(Supervisor.layer));

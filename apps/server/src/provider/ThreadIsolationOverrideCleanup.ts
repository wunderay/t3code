import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";

/** A deleted thread's isolation choices go with it, so no later thread with its id takes them. */
export const forgetDeletedThreads = Effect.fn("ThreadIsolationOverrideCleanup.forget")(function* <
  E,
>(events: Stream.Stream<OrchestrationV2DomainEvent, E>) {
  const settings = yield* ServerSettings.ServerSettingsService;
  yield* Stream.runForEach(events, (event) =>
    event.type !== "thread.deleted"
      ? Effect.void
      : settings.getSettings.pipe(
          Effect.flatMap((current) =>
            current.threadIsolationOverrides[event.threadId] === undefined
              ? Effect.void
              : settings.updateSettings({
                  threadIsolationOverrides: { [event.threadId]: null },
                }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not remove a deleted thread's isolation choices.", cause),
          ),
        ),
  );
});

export const start = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* forkParked(forgetDeletedThreads(orchestrator.streamDomainEvents));
});

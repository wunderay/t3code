import { assert, it } from "@effect/vitest";
import { type OrchestrationV2DomainEvent, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";
import { forgetDeletedThreads } from "./ThreadIsolationOverrideCleanup.ts";

const deleted = ThreadId.make("thread-deleted");
const kept = ThreadId.make("thread-kept");
const event = (type: string, threadId: ThreadId) =>
  ({ type, threadId }) as unknown as OrchestrationV2DomainEvent;

it.effect("removes a deleted thread's isolation choices and keeps the others'", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* forgetDeletedThreads(
      Stream.make(event("thread.archived", kept), event("thread.deleted", deleted)),
    );
    assert.deepEqual((yield* settings.getSettings).threadIsolationOverrides, {
      [kept]: { network: "provider" },
    });
  }).pipe(
    Effect.provide(
      ServerSettings.layerTest({
        threadIsolationOverrides: {
          [deleted]: { network: "any" },
          [kept]: { network: "provider" },
        },
      }),
    ),
  ),
);

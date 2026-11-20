import { AgentIsolation, AgentIsolationError } from "@t3tools/shared/AgentIsolation";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ThreadIsolation } from "./threadIsolation.ts";

/** Thread isolation for providers whose packages start their own agent process. */
export const layer = Layer.effect(
  AgentIsolation,
  Effect.gen(function* () {
    const isolation = yield* ThreadIsolation;
    // Each launch its own key, so its private folder and release are its own.
    let launches = 0;
    return {
      wrap: Effect.fn("AgentIsolation.wrap")(function* (input) {
        launches += 1;
        const key = `agent:${input.provider}:${input.threadId}:${launches}`;
        yield* Effect.addFinalizer(() => isolation.release(key));
        const launch = yield* isolation
          .wrap({
            provider: input.provider,
            command: input.command,
            args: input.args,
            cwd: input.cwd,
            env: input.env,
            key,
            thread: input.threadId,
            readable: input.readable,
            shell: input.shell,
          })
          .pipe(Effect.mapError((error) => new AgentIsolationError({ detail: error.detail })));
        return launch === undefined
          ? undefined
          : { command: launch.command, args: launch.args, env: launch.env };
      }),
    };
  }),
);

import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

export const disableOptionalEgress = Config.Boolean("T3CODE_DISABLE_OPTIONAL_EGRESS").pipe(
  Config.withDefault(false),
  Effect.orDie,
);

export const disableActivityPublishing = Config.Boolean("T3CODE_DISABLE_ACTIVITY_PUBLISHING").pipe(
  Config.withDefault(false),
  Effect.orDie,
);

export const disableClaudeReporting = Config.Boolean("T3CODE_DISABLE_CLAUDE_REPORTING").pipe(
  Config.orElse(() => Config.Boolean("T3CODE_DISABLE_OPTIONAL_EGRESS")),
  Config.withDefault(false),
  Effect.orDie,
);

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** Written by evals/coordinator-fleet; Settings marks the models whose runs in it passed. */
export const FLEET_RESULTS_FILE = "coordinator-fleet.json";

/** The run a pass stands for: at least this many events, contexts as fresh, steps as few. */
export const FLEET_STANDARD = { events: 300, freshEvery: 3, maxSteps: 12 } as const;

export const FleetResults = Schema.Struct({
  protocolVersion: Schema.Literal(2),
  runs: Schema.Array(
    Schema.Struct({
      model: Schema.String,
      seed: Schema.Number,
      events: Schema.Number,
      freshEvery: Schema.Number,
      maxSteps: Schema.Number,
      missed: Schema.Number,
      wrong: Schema.Number,
      refused: Schema.Number,
      at: Schema.String,
    }),
  ),
});
export type FleetResults = typeof FleetResults.Type;
type FleetRun = FleetResults["runs"][number];

/** A run as hard as the standard one, at least. */
const standardRun = (run: FleetRun) =>
  run.events >= FLEET_STANDARD.events &&
  run.freshEvery <= FLEET_STANDARD.freshEvery &&
  run.maxSteps <= FLEET_STANDARD.maxSteps;

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(FleetResults));

/**
 * The models whose every standard run missed nothing and answered nothing wrong, judged from the
 * runs' own counts; a file that does not decode marks none.
 */
export const passedModels = (text: string) =>
  decode(text).pipe(
    Effect.map((results) => {
      const standard = results.runs.filter(standardRun);
      return [...new Set(standard.map((run) => run.model))].filter((model) =>
        standard
          .filter((run) => run.model === model)
          .every((run) => run.missed === 0 && run.wrong === 0),
      );
    }),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );

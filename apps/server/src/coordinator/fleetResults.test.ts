import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { passedModels } from "./fleetResults.ts";

const run = {
  seed: 1,
  events: 300,
  freshEvery: 3,
  maxSteps: 12,
  missed: 0,
  wrong: 0,
  refused: 0,
  at: "2026-11-12T00:00:00Z",
};
const file = (...runs: ReadonlyArray<object>) => JSON.stringify({ protocolVersion: 2, runs });

it.effect.each([
  [
    "a model by its standard runs' counts, not a flag",
    file(
      { ...run, model: "model-a" },
      { ...run, model: "model-b", missed: 2, passed: true },
      { ...run, model: "model-c", wrong: 1 },
    ),
    ["model-a"],
  ],
  [
    "none for a run easier than the standard one",
    file(
      { ...run, model: "short", events: 20 },
      { ...run, model: "stale", freshEvery: 1000 },
      { ...run, model: "long", maxSteps: 100 },
    ),
    [],
  ],
  [
    "a model only when every standard run of it passed, whatever its smoke runs did",
    file(
      { ...run, model: "model-a" },
      { ...run, model: "model-a", seed: 2, missed: 1 },
      { ...run, model: "model-b" },
      { ...run, model: "model-b", events: 20, wrong: 3 },
    ),
    ["model-b"],
  ],
  ["none from a file that does not decode", '{"protocolVersion":1,"models":[]}', []],
  ["none from text that is not JSON", "not json", []],
] as const)("marks %s", ([, text, models]) =>
  passedModels(text).pipe(Effect.map((passed) => expect(passed).toEqual(models))),
);

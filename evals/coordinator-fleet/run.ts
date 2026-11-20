#!/usr/bin/env node
// An eval script, not server code: it reads and writes result files and calls a model API.
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as Schema from "effect/Schema";
import {
  FLEET_RESULTS_FILE,
  FLEET_STANDARD,
  FleetResults,
} from "../../apps/server/src/coordinator/fleetResults.ts";
import { chatEndpoint, chatModel } from "../shared/chat.ts";
import { runFleet } from "./fleet.ts";
import { makeScript } from "./script.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string", multiple: true },
    "base-url": { type: "string" },
    "api-key-env": { type: "string" },
    results: { type: "string" },
    seed: { type: "string", default: "1" },
    events: { type: "string", default: String(FLEET_STANDARD.events) },
    "fresh-every": { type: "string", default: String(FLEET_STANDARD.freshEvery) },
    "max-steps": { type: "string", default: String(FLEET_STANDARD.maxSteps) },
  },
});
const numbers = ["seed", "events", "fresh-every", "max-steps"].map((flag) =>
  Number(values[flag as "seed"]),
);
if (
  !values.out ||
  !values.model?.length ||
  numbers.some((value) => !Number.isSafeInteger(value) || value < 1)
)
  throw new Error(
    "Use --out <directory> --model <id> [--model <id>] [--base-url <url> --api-key-env <NAME>] [--results <file>] [--seed n] [--events n] [--fresh-every n] [--max-steps n].",
  );
const [seed, events, freshEvery, maxSteps] = numbers as [number, number, number, number];
const out = values.out;
const resultsFile = values.results ?? NodePath.join(out, FLEET_RESULTS_FILE);

const endpoint = chatEndpoint(values["base-url"], values["api-key-env"]);
const decodeResults = Schema.decodeUnknownSync(Schema.fromJsonString(FleetResults));

const script = makeScript({ seed, events });
NodeFS.mkdirSync(out, { recursive: true });
const rows = [];
for (const model of values.model) {
  const result = await runFleet({
    model: chatModel(endpoint, model),
    script,
    freshEvery,
    maxSteps,
  });
  NodeFS.writeFileSync(
    NodePath.join(out, `${model.replace(/[^\w.-]/g, "_")}.json`),
    JSON.stringify(result, null, 2),
  );
  rows.push({ model, ...result });
  console.log(
    `${model}: ${result.passed ? "passed" : "failed"}, ${result.missed} missed, ${result.wrong} wrong, ${result.refused} refused`,
  );
}

const at = new Date().toISOString();
const earlier = NodeFS.existsSync(resultsFile)
  ? decodeResults(NodeFS.readFileSync(resultsFile, "utf8")).runs
  : [];
const runs = rows.map(({ model, events, missed, wrong, refused }) => ({
  model,
  seed,
  events,
  freshEvery,
  maxSteps,
  missed,
  wrong,
  refused,
  at,
}));
// A run replaces only an earlier one of the same model and settings; Settings judges the counts.
const same = (a: (typeof runs)[number], b: (typeof runs)[number]) =>
  a.model === b.model &&
  a.seed === b.seed &&
  a.events === b.events &&
  a.freshEvery === b.freshEvery &&
  a.maxSteps === b.maxSteps;
const merged: FleetResults = {
  protocolVersion: 2,
  runs: [...earlier.filter((entry) => !runs.some((run) => same(run, entry))), ...runs],
};
NodeFS.writeFileSync(resultsFile, `${JSON.stringify(merged, null, 2)}\n`);
NodeFS.writeFileSync(
  NodePath.join(out, "summary.md"),
  [
    `# Coordinator fleet: seed ${seed}, ${events} events, fresh context every ${freshEvery} wakes`,
    "",
    "| Model | Passed | Missed | Wrong | Refused | Calls | Turns | Tokens |",
    "| ----- | ------ | ------ | ----- | ------- | ----- | ----- | ------ |",
    ...rows.map(
      (row) =>
        `| ${row.model} | ${row.passed ? "yes" : "no"} | ${row.missed} | ${row.wrong} | ${row.refused} | ${row.calls} | ${row.turns} | ${row.tokens} |`,
    ),
    "",
  ].join("\n"),
);

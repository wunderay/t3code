import { assert, it } from "@effect/vitest";
import * as Option from "effect/Option";
import {
  DEFAULT_COORDINATOR_LABELS,
  type CoordinatorConfiguration,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  allowances,
  holdReason,
  largestThreadMemory,
  machineSlots,
  ownedBy,
  parseBench,
  routeCandidates,
  trackBlocked,
  turnTokens,
  workTimes,
} from "./route.ts";

const model = (id: string, destination: string, extra: Record<string, unknown> = {}) =>
  ({
    id: `catalog:${destination}:${id}`,
    sourceId: "source",
    provider: destination === "cloud:claude" ? "claude" : "codex",
    model: id,
    destination,
    account: destination === "cloud:claude" ? "claude" : "codex",
    aliases: [],
    efforts: ["low", "high"],
    state: "eligible",
    compatible: true,
    accessible: true,
    policyAllowed: true,
    qualificationVerified: true,
    identityVerified: true,
    contextTokens: null,
    outputTokens: null,
    priceMicros: null,
    pricingProvenance: null,
    evidence: [],
    stale: false,
    missingRefreshes: 0,
    discoveredAt: 0,
    revision: 1,
    ...extra,
  }) as const;

const configuration = (
  placement: (typeof CoordinatorConfiguration.Type)["placement"] = "automatic",
): typeof CoordinatorConfiguration.Type => ({
  enabled: true,
  coordinatorPaused: false,
  labels: DEFAULT_COORDINATOR_LABELS,
  permissionMode: "ask",
  placement,
  coordinatorTitle: null,
  coordinatorProvider: null,
  coordinatorModel: null,
});

const providers = [
  { instanceId: "codex", driver: "codex" },
  { instanceId: "claude", driver: "claudeAgent" },
] as unknown as ReadonlyArray<ServerProvider>;

const candidates = (input: Partial<Parameters<typeof routeCandidates>[0]> = {}) =>
  routeCandidates({
    catalog: [
      model("gpt", "local"),
      model("opus", "cloud:claude"),
      model("old", "local", { state: "validating" }),
      model("gone", "local", { stale: true }),
    ],
    configuration: configuration(),
    providers,
    projectId: "project",
    environmentId: "local",
    pin: {},
    target: {},
    ladder: undefined,
    perLogin: null,
    ownerRunning: new Map(),
    ...input,
  }).map((pool) => pool.map(({ route }) => `${route.model}/${route.effort}@${route.destination}`));

it("routes every qualified local and cloud catalog entry at each of its efforts", () => {
  assert.deepEqual(candidates(), [
    ["gpt/low@local", "gpt/high@local", "opus/low@cloud:claude", "opus/high@cloud:claude"],
  ]);
});

it("placement, the owner's pin, the planner's target and the ladder narrow the candidates", () => {
  assert.deepEqual(candidates({ configuration: configuration("local-only") }), [
    ["gpt/low@local", "gpt/high@local"],
  ]);
  // Preferring cloud scores cloud alone first, then everything.
  assert.deepEqual(candidates({ configuration: configuration("prefer-cloud") })[0], [
    "opus/low@cloud:claude",
    "opus/high@cloud:claude",
  ]);
  assert.deepEqual(candidates({ pin: { effort: "high" } }), [
    ["gpt/high@local", "opus/high@cloud:claude"],
  ]);
  // A target nothing fits is ignored; a pin nothing fits leaves nothing.
  assert.deepEqual(candidates({ target: { model: "missing" } })[0]?.length, 4);
  assert.deepEqual(candidates({ pin: { model: "missing" } }), [[]]);
  assert.deepEqual(
    candidates({
      ladder: {
        exclude: [{ provider: "codex", model: "gpt", effort: null }],
        excludeProfiles: [],
        minScore: null,
        minTier: null,
      },
    }),
    [["opus/low@cloud:claude", "opus/high@cloud:claude"]],
  );
});

it("the owner's running threads count on their login, and only an owner's limit bounds it", () => {
  const [pool] = routeCandidates({
    catalog: [model("gpt", "local")],
    configuration: configuration(),
    providers,
    projectId: "project",
    environmentId: "local",
    pin: {},
    target: {},
    ladder: undefined,
    perLogin: 3,
    ownerRunning: new Map([["codex", 2]]),
  });
  assert.deepEqual(
    pool?.map(({ candidate }) => [candidate.loginMaxParallel, candidate.ownerRunning]),
    [
      [3, 2],
      [3, 2],
    ],
  );
});

it("reads the bench from a party.toml-shaped file", () => {
  assert.deepEqual(
    parseBench(`
[[account]]
name = "primary"
bench = { low = [1, 1] }   # not a member

[[member]]
name = "olympia"   # a comment
model = "claude-opus-5-5"
bench = { low = [47, 0.40], high = [61, 1.09] }

[[member]]
name = "cloud twin"
model = "claude-opus-5-5"
bench = { low = [10, 9] }
`),
    [
      { model: "claude-opus-5-5", effort: "low", score: 47, costMicros: 400_000 },
      { model: "claude-opus-5-5", effort: "high", score: 61, costMicros: 1_090_000 },
    ],
  );
});

it("an allowance comes from a provider's session and weekly windows", () => {
  assert.deepEqual<unknown>(
    allowances([
      {
        instanceId: "claude",
        usageLimits: {
          checkedAt: "2026-11-12T00:00:00.000Z",
          windows: [
            {
              id: "s",
              kind: "session",
              label: "5h",
              usedPercent: 40,
              resetsAt: "2026-11-12T05:00:00.000Z",
            },
            { id: "w", kind: "weekly", label: "7d", usedPercent: 10 },
          ],
        },
      },
      { instanceId: "codex" },
    ] as unknown as ReadonlyArray<ServerProvider>),
    [
      {
        id: "claude",
        checkedAt: Date.parse("2026-11-12T00:00:00.000Z"),
        remaining: 60,
        resetsAt: Date.parse("2026-11-12T05:00:00.000Z"),
        longRemaining: 90,
        longResetsAt: null,
      },
    ],
  );
});

it("time worked runs from dispatch and leaves out waiting on the owner", () => {
  const blocked = trackBlocked({ startedAt: 0 }, true, 10_000);
  assert.deepEqual(blocked, { startedAt: 0, blockedSince: 10_000 });
  // Still blocked: the wait keeps its start.
  assert.equal(trackBlocked(blocked, true, 20_000), blocked);
  const resumed = trackBlocked(blocked, false, 40_000);
  assert.deepEqual(resumed, { startedAt: 0, blockedSeconds: 30 });
  const assignment = { receipt: resumed, progressAt: null } as never;
  assert.deepEqual(workTimes(assignment, 100_000), {
    startedAt: 0,
    blockedSeconds: 30,
    seconds: 70,
  });
  // A wait not yet over counts up to now.
  assert.equal(workTimes({ receipt: blocked, progressAt: null } as never, 30_000).seconds, 10);
});

it("use counts every finished turn's tokens, and is unknown when one reported none", () => {
  const usage = (extra: Record<string, unknown>) => ({
    usageScope: "main_agent",
    usageStatus: "complete",
    hasSubagents: false,
    inputTokens: 100,
    cachedInputTokens: 30,
    cacheCreationTokens: 10,
    outputTokens: 20,
    ...extra,
  });
  const turns = [
    {
      status: "completed",
      model: "gpt",
      turnTokenUsage: usage({ otherUsage: { inputTokens: 5, outputTokens: 1 } }),
    },
    { status: "completed", turnTokenUsage: usage({ localCommand: true }) },
    { status: "running" },
  ] as never;
  assert.deepEqual(turnTokens(turns), {
    model: "gpt",
    totals: {
      uncachedInputTokens: 65,
      cachedInputTokens: 30,
      cacheCreationTokens: 10,
      outputTokens: 21,
      reasoningTokens: 0,
    },
  });
  assert.isUndefined(turnTokens([{ status: "failed" }] as never));
  assert.isUndefined(
    turnTokens([
      { status: "completed", turnTokenUsage: usage({ usageStatus: "partial" }) },
    ] as never),
  );
});

it("the bench file is read only while the server's own user owns it", () => {
  assert.isTrue(ownedBy(Option.some(501), 501));
  assert.isFalse(ownedBy(Option.some(0), 501));
  assert.isFalse(ownedBy(Option.none(), 501));
  // Windows reports no user ids.
  assert.isTrue(ownedBy(Option.none(), undefined));
});

it("this machine runs a local thread per CPU while another provider thread's memory fits", () => {
  const machine = { cpus: 12, availableMemory: 8e9, largestThread: 2e9, ownerLimit: null };
  assert.equal(machineSlots(machine), 12);
  assert.equal(machineSlots({ ...machine, availableMemory: 1e9 }), 0);
  // Nothing measured, or a failed reading, holds nothing.
  assert.equal(machineSlots({ ...machine, availableMemory: 1e9, largestThread: null }), 12);
  assert.equal(machineSlots({ ...machine, availableMemory: null }), 12);
  assert.equal(machineSlots({ ...machine, ownerLimit: 4 }), 4);
  const process = (
    pid: number,
    category: string,
    residentBytes: number,
    childPids: number[] = [],
  ) => ({
    identity: { pid },
    childPids,
    category,
    residentBytes,
  });
  assert.equal(
    largestThreadMemory([
      process(1, "server", 900),
      process(2, "provider-root", 100, [3]),
      process(3, "server-child", 250),
      process(4, "provider-root", 300),
    ]),
    350,
  );
  assert.isNull(largestThreadMemory([process(1, "server", 900)]));
});

it("a hold's reason is one plain line, never blank", () => {
  assert.equal(
    holdReason("\u001b[31mLimit\u001b[0m reached\r\n  try later"),
    "Limit reached try later",
  );
  assert.equal(holdReason("  \r "), "The provider's usage limit was reached.");
  assert.equal(holdReason(undefined), "The provider's usage limit was reached.");
});

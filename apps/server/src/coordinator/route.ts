import * as Option from "effect/Option";
import type {
  OrchestrationV2ProviderTurn,
  UsageTokenTotals,
  CoordinatorAssignment,
  CoordinatorCatalogModel,
  CoordinatorConfiguration,
  CoordinatorRouteSelection,
  ServerProvider,
} from "@t3tools/contracts";

/** The router keys bench entries and outcomes by effort; a model without efforts is this one. */
const NO_EFFORT = "default";
/** The assignment row is the reservation; its expiry only bounds how stale a dispatch may be. */
export const RESERVATION_MS = 24 * 3_600_000;

type Route = typeof CoordinatorRouteSelection.Type;

export interface Ladder {
  readonly exclude: ReadonlyArray<{ provider: string; model: string; effort: string | null }>;
  readonly excludeProfiles: ReadonlyArray<{ profileId: string; effort: string | null }>;
  readonly minScore: number | null;
  readonly minTier: number | null;
}

export interface Candidate {
  readonly profileId: string;
  readonly instance: string;
  readonly provider: string;
  readonly model: string;
  readonly family: string;
  readonly effort: string;
  readonly destination: string;
  readonly account: string | null;
  // Only a limit the owner set; no number bounds a login otherwise.
  readonly loginMaxParallel?: number;
  readonly ownerRunning: number;
}

export const routeEffort = (route: Route) => route.effort ?? NO_EFFORT;

// A provider's driver stands for its model family: two logins of one driver share it.
export const familyOf = (providers: ReadonlyArray<ServerProvider>, instance: string | null) =>
  providers.find((provider) => provider.instanceId === instance)?.driver ?? instance ?? "unknown";

const matches = (route: Route, pin: Route) =>
  (["profileId", "provider", "model", "effort", "account", "destination"] as const).every(
    (key) => !pin[key] || pin[key] === route[key],
  );

/** Every catalog route the dispatch gate could accept, one per effort, as the router scores them. */
export const routeCandidates = (input: {
  readonly catalog: ReadonlyArray<typeof CoordinatorCatalogModel.Type>;
  readonly configuration: typeof CoordinatorConfiguration.Type;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly projectId: string;
  readonly environmentId: string;
  readonly pin: Route;
  readonly target: Route;
  readonly ladder: Ladder | undefined;
  readonly perLogin: number | null;
  // The owner's own running threads count toward their login's limit.
  readonly ownerRunning: ReadonlyMap<string, number>;
}) => {
  const placement = input.configuration.placement;
  const all = input.catalog
    .filter(
      (item) =>
        !item.stale &&
        item.compatible &&
        item.accessible &&
        item.policyAllowed &&
        (item.state === "eligible" ||
          (item.destination.startsWith("cloud:") &&
            item.model === "provider-selected" &&
            input.configuration.allowUnverifiedCloudModels === true)) &&
        (placement !== "local-only" || item.destination === "local") &&
        (placement !== "cloud-only" || item.destination.startsWith("cloud:")),
    )
    .flatMap((item) => {
      const binding = input.configuration.guildBindings?.find(
        (mapped) =>
          mapped.providerInstanceId === item.provider &&
          (mapped.cloud
            ? mapped.cloud.destination === item.destination &&
              mapped.cloud.projectId === input.projectId
            : item.destination === "local" &&
              (mapped.environmentId === null || mapped.environmentId === input.environmentId)),
      );
      const profileId = input.pin.profileId ?? binding?.profileId ?? item.id;
      return (item.efforts.length ? item.efforts : [null]).map((effort) => ({
        route: {
          profileId,
          provider: item.provider,
          model: item.model,
          effort,
          account: item.account,
          destination: item.destination,
        },
        candidate: {
          profileId,
          instance: item.provider,
          provider: item.provider,
          model: item.model,
          family: familyOf(input.providers, item.provider),
          effort: effort ?? NO_EFFORT,
          destination: item.destination,
          account: item.account,
          ...(input.perLogin === null ? {} : { loginMaxParallel: input.perLogin }),
          ownerRunning: input.ownerRunning.get(item.account ?? item.provider) ?? 0,
        } satisfies Candidate,
      }));
    })
    .filter(
      ({ route }) =>
        matches(route, input.pin) &&
        !input.ladder?.exclude.some(
          (key) =>
            key.provider === route.provider &&
            key.model === route.model &&
            (key.effort === null || key.effort === route.effort),
        ) &&
        !input.ladder?.excludeProfiles.some(
          (key) => key.profileId === route.profileId && key.effort === route.effort,
        ),
    );
  // The Coordinator's target is a preference: it narrows the choice only while something fits it.
  const preferred = all.filter(({ route }) => matches(route, input.target));
  const chosen = preferred.length ? preferred : all;
  const cloud = chosen.filter(({ route }) => route.destination.startsWith("cloud:"));
  return placement === "prefer-cloud" && cloud.length ? [cloud, chosen] : [chosen];
};

/** The router's allowance rows, from the usage windows each provider already reports. */
export const allowances = (providers: ReadonlyArray<ServerProvider>) =>
  providers.flatMap((provider) => {
    const windows = provider.usageLimits?.unavailable ? [] : (provider.usageLimits?.windows ?? []);
    const short = windows.find((window) => window.kind === "session");
    const long = windows.find((window) => window.kind === "weekly");
    const first = short ?? long;
    if (!first) return [];
    const at = (resetsAt: string | undefined) => (resetsAt ? Date.parse(resetsAt) : null);
    return [
      {
        id: provider.instanceId,
        checkedAt: Date.parse(provider.usageLimits!.checkedAt),
        remaining: 100 - first.usedPercent,
        resetsAt: at(first.resetsAt),
        ...(short && long
          ? { longRemaining: 100 - long.usedPercent, longResetsAt: at(long.resetsAt) }
          : {}),
      },
    ];
  });

/**
 * The bench from a file shaped like the Guild's party.toml: each `[[member]]` names a `model` and
 * `bench = { effort = [score, USD per attempt], ... }`. Members sharing a model share its bench.
 */
export const parseBench = (text: string) => {
  const entries = new Map<
    string,
    { model: string; effort: string; score: number; costMicros: number }
  >();
  let model: string | undefined;
  let member = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line.startsWith("[")) {
      member = line === "[[member]]";
      model = undefined;
      continue;
    }
    if (!member) continue;
    const named = /^model\s*=\s*"([^"]+)"/.exec(line);
    if (named) model = named[1];
    const bench = /^bench\s*=\s*\{(.*)\}/.exec(line);
    if (!bench || !model) continue;
    for (const [, effort, score, usd] of bench[1]!.matchAll(
      /([\w-]+)\s*=\s*\[\s*([\d.]+)\s*,\s*([\d.]+)\s*\]/g,
    )) {
      const costMicros = Math.round(Number(usd) * 1_000_000);
      const key = `${model}/${effort}`;
      if (costMicros > 0 && !entries.has(key))
        entries.set(key, { model, effort: effort!, score: Number(score), costMicros });
    }
  }
  return [...entries.values()];
};

/** One assignment's round on the route that wrote the goal's change. */
export const outcomeRound = (input: {
  readonly id: string;
  readonly goalId: string;
  readonly route: Route;
  readonly rank: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly blockedSeconds?: number;
  // Null when the destination reported none; the router then counts the bench's estimate.
  readonly usedMicros: number | null;
  readonly finish?: "merged" | "failed" | "reverted";
  // False for a failure that says nothing of the route's skill, such as a usage limit.
  readonly counted?: boolean;
}) =>
  input.route.provider && input.route.model
    ? {
        assignmentId: input.id,
        goalId: input.goalId,
        instance: input.route.provider,
        model: input.route.model,
        effort: routeEffort(input.route),
        rank: input.rank,
        usedMicros: input.usedMicros,
        startedAt: input.startedAt,
        endedAt: Math.max(input.startedAt, input.endedAt),
        blockedSeconds: input.blockedSeconds ?? 0,
        ...(input.finish ? { finish: input.finish } : {}),
        ...(input.counted === false ? { counted: false } : {}),
      }
    : undefined;

/** Time an assignment worked: from its dispatch, less what it waited on the owner. */
export const workTimes = (assignment: typeof CoordinatorAssignment.Type, now: number) => {
  const receipt = assignment.receipt ?? {};
  const startedAt =
    typeof receipt.startedAt === "number" ? receipt.startedAt : (assignment.progressAt ?? now);
  const since = typeof receipt.blockedSince === "number" ? receipt.blockedSince : undefined;
  const blockedSeconds =
    (typeof receipt.blockedSeconds === "number" ? receipt.blockedSeconds : 0) +
    (since === undefined ? 0 : Math.floor((now - since) / 1000));
  return {
    startedAt,
    blockedSeconds,
    seconds: Math.max(0, Math.floor((now - startedAt) / 1000) - blockedSeconds),
  };
};

/** Keeps in the receipt how long an assignment has waited on the owner, across status changes. */
export const trackBlocked = (receipt: Record<string, unknown>, blocked: boolean, now: number) => {
  const { blockedSince, ...rest } = receipt;
  if (typeof blockedSince !== "number")
    return blocked ? { ...receipt, blockedSince: now } : receipt;
  if (blocked) return receipt;
  const seconds = typeof rest.blockedSeconds === "number" ? rest.blockedSeconds : 0;
  return { ...rest, blockedSeconds: seconds + Math.floor((now - blockedSince) / 1000) };
};

/**
 * The tokens a thread's turns used and the model they ran, or undefined when a finished turn
 * reported no complete count, so a sum would undercount. A local command's counters are not
 * model work.
 */
export const turnTokens = (
  turns: ReadonlyArray<OrchestrationV2ProviderTurn>,
): { readonly model: string | undefined; readonly totals: UsageTokenTotals } | undefined => {
  const totals = {
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  };
  let model: string | undefined;
  for (const turn of turns) {
    if (turn.status === "pending" || turn.status === "running") continue;
    const usage = turn.turnTokenUsage;
    if (usage?.localCommand) continue;
    if (usage?.usageStatus !== "complete") return undefined;
    const cached = usage.cachedInputTokens ?? 0;
    const created = usage.cacheCreationTokens ?? 0;
    totals.uncachedInputTokens +=
      Math.max(0, usage.inputTokens - cached - created) + (usage.otherUsage?.inputTokens ?? 0);
    totals.cachedInputTokens += cached;
    totals.cacheCreationTokens += created;
    totals.outputTokens += usage.outputTokens + (usage.otherUsage?.outputTokens ?? 0);
    totals.reasoningTokens += usage.reasoningTokens ?? 0;
    model ??= usage.models?.[0] ?? turn.model;
  }
  return { model, totals };
};

/** Whether a file is the server user's own; where the platform has no user ids, it is. */
export const ownedBy = (fileUid: Option.Option<number>, uid: number | undefined) =>
  uid === undefined || Option.getOrUndefined(fileUid) === uid;

/** The largest memory one provider thread's process tree holds now, from resource telemetry. */
export const largestThreadMemory = (
  processes: ReadonlyArray<{
    readonly identity: { readonly pid: number };
    readonly childPids: ReadonlyArray<number>;
    readonly category: string;
    readonly residentBytes: number;
  }>,
) => {
  const byPid = new Map(processes.map((process) => [process.identity.pid, process]));
  const tree = (pid: number, seen: Set<number>): number => {
    const process = byPid.get(pid);
    if (!process || seen.has(pid)) return 0;
    seen.add(pid);
    return process.childPids.reduce((sum, child) => sum + tree(child, seen), process.residentBytes);
  };
  const sizes = processes
    .filter((process) => process.category === "provider-root")
    .map((process) => tree(process.identity.pid, new Set()));
  return sizes.length ? Math.max(...sizes) : null;
};

/**
 * How many local threads this machine can run: one per logical CPU, since each drives a provider
 * CLI and the builds and tests it starts; and none while less memory is available than the
 * largest provider thread measured now holds, since another like it would not fit. Nothing
 * measured, or a failed reading, holds nothing. An owner's limit, if set, bounds it too.
 */
export const machineSlots = (machine: {
  readonly cpus: number;
  readonly availableMemory: number | null;
  readonly largestThread: number | null;
  readonly ownerLimit: number | null;
}) => {
  const full =
    machine.availableMemory !== null &&
    machine.largestThread !== null &&
    machine.availableMemory < machine.largestThread;
  const slots = full ? 0 : machine.cpus;
  return machine.ownerLimit === null ? slots : Math.min(slots, machine.ownerLimit);
};

/** A provider's error as a hold's reason: one plain line, never blank. */
export const holdReason = (error: string | null | undefined) => {
  const plain = (error ?? "").replace(/\u001b\[[0-9;]*[A-Za-z]|[\u0000-\u001f\u007f]+/g, " ");
  return (
    plain.replace(/\s+/g, " ").trim().slice(0, 500) || "The provider's usage limit was reached."
  );
};

import {
  coordinatorInText,
  DEFAULT_COORDINATOR_LABELS,
  type CoordinatorBoard,
  type CoordinatorCommand,
  type CoordinatorSnapshot,
  WS_METHODS,
} from "@t3tools/contracts";
import { formatUsd } from "@t3tools/shared/usageFormat";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import type { EnvironmentThreadShell } from "./models.ts";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/reactivity";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createCoordinatorEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const snapshot = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:coordinator:snapshot",
    tag: WS_METHODS.coordinatorSubscribe,
    idleTtlMs: 0,
  });
  return {
    snapshot,
    // Read only while a dashboard or the owner's settings show it; each snapshot change refreshes it.
    board: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:coordinator:board",
      tag: WS_METHODS.coordinatorBoard,
      idleTtlMs: 0,
      refreshTrigger: ({ environmentId }) => snapshot({ environmentId, input: {} }),
    }),
    command: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:coordinator:command",
      tag: WS_METHODS.coordinatorCommand,
    }),
  };
}

const TERMINAL_ASSIGNMENT = new Set(["completed", "verified", "cancelled", "failed"]);

/**
 * Whether the Coordinator manages a thread other than its own: one it started, or, while the
 * owner lets it manage others, one it has taken on — work assigned there or a grant for it. Any
 * other thread is left exactly as without the Coordinator.
 */
export function coordinatorManages(
  snapshot: Pick<CoordinatorSnapshot, "configuration" | "cards" | "assignments" | "grants">,
  threadId: string,
): boolean {
  if (threadId.startsWith("coordinator:")) return true;
  if (snapshot.configuration.manageOtherThreads !== true) return false;
  const cards = snapshot.cards.filter((card) => card.threadId === threadId);
  return (
    cards.some((card) => card.assignmentId !== null) ||
    (snapshot.assignments ?? []).some(
      (assignment) =>
        !TERMINAL_ASSIGNMENT.has(assignment.status) &&
        cards.some((card) => card.id === assignment.cardId),
    ) ||
    (snapshot.grants ?? []).some(
      (grant) => grant.scope.kind === "thread" && grant.scope.id === threadId,
    )
  );
}

/** Returns only known Codex task identifiers on the fixed, trusted host. */
export function codexCloudTaskUrl(environmentId: string, threadId: string): string | null {
  if (environmentId !== "cloud:codex" || !/^task_[A-Za-z0-9_-]+$/.test(threadId)) return null;
  return `https://chatgpt.com/codex/tasks/${threadId}`;
}

// By category, so the set cannot drift: controls, formatters (bidi, zero-width, tags), line and
// paragraph separators, private use and lone surrogates, plus the Hangul fillers and variation
// selectors that render as nothing. Newline and tab are kept below.
const HIDDEN_CHARACTERS =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cs}\u115f\u1160\u3164\uffa0\p{Variation_Selector}]/gu;

/** Text as shown: characters that reorder or hide what is on screen appear as inert escapes. */
const visible = (text: string) =>
  text.replace(HIDDEN_CHARACTERS, (character) =>
    character === "\n" || character === "\t"
      ? character
      : `\\u{${(character.codePointAt(0) ?? 0).toString(16).toUpperCase()}}`,
  );

/**
 * What a pending permission request asks and where it came from, for its approval row. Only a
 * request holding its whole operation, shown in full, may be approved from the row; any other is
 * reviewed in its thread. A reason is shown beside the operation, never in its place. Both are
 * display text; the stored operation is what is approved.
 */
export function coordinatorPermissionOrigin(
  request: Readonly<Record<string, unknown>>,
  snapshot: {
    readonly cards: ReadonlyArray<{ readonly id: string; readonly purpose: string }>;
    readonly projects?: ReadonlyArray<{ readonly id: string; readonly title: string }> | undefined;
  },
): {
  environmentId: string;
  threadId: string;
  thread: string;
  project: string;
  detail: string | null;
  operation: string | null;
} | null {
  const { cardId, detail, environmentId, operation, projectId, threadId } = request;
  if (
    typeof environmentId !== "string" ||
    typeof threadId !== "string" ||
    typeof projectId !== "string"
  )
    return null;
  return {
    environmentId,
    threadId,
    thread: snapshot.cards.find((card) => card.id === cardId)?.purpose ?? threadId,
    project: snapshot.projects?.find((project) => project.id === projectId)?.title ?? projectId,
    // A prompt that only repeats the start of the operation adds nothing beside it.
    detail:
      typeof detail === "string" &&
      detail.trim() &&
      !(typeof operation === "string" && operation.startsWith(detail))
        ? visible(detail.trim())
        : null,
    operation: typeof operation === "string" && operation.trim() ? visible(operation) : null,
  };
}

const COORDINATOR_REFUSALS: Record<string, (name: string) => string> = {
  "coordinator-provider:unsupported": () =>
    "This provider can't coordinate. Choose a Claude or Codex instance.",
  "coordinator-restrictions:unsupported": (name) =>
    `This provider couldn't confirm that ${name} would run without shell, web, MCP servers or user instruction files on this server.`,
  "coordinator-restrictions:destination": (name) =>
    `Couldn't check this provider's restrictions for ${name}. Try again.`,
  "coordinator-model:unavailable": (name) =>
    `This model isn't available for ${name}. Check the provider's sign-in and model list.`,
};

/** Plain-language text for a refused coordinator choice, in the user's labels; null for any other failure. */
export function coordinatorRefusal(
  error: unknown,
  labels: CoordinatorSnapshot["configuration"]["labels"],
): string | null {
  if (
    typeof error !== "object" ||
    error === null ||
    !("operation" in error) ||
    !("reason" in error)
  )
    return null;
  return (
    COORDINATOR_REFUSALS[`${String(error.operation)}:${String(error.reason)}`]?.(
      coordinatorInText(labels),
    ) ?? null
  );
}

/** What to tell the owner when one of their actions fails: the store's own words where it gave some. */
export function coordinatorFailure(
  error: unknown,
  labels: CoordinatorSnapshot["configuration"]["labels"],
): string {
  const refusal = coordinatorRefusal(error, labels);
  if (refusal) return refusal;
  if (typeof error === "object" && error !== null) {
    if ("detail" in error && typeof error.detail === "string") return error.detail;
    const cause = "cause" in error ? error.cause : undefined;
    if (typeof cause === "object" && cause !== null && "message" in cause)
      return String(cause.message);
  }
  return "That didn't work. Try again.";
}

/** The heading of the Coordinator's thread while it holds no messages. */
export function coordinatorEmptyHeading(labels: CoordinatorSnapshot["configuration"]["labels"]) {
  return `What should ${coordinatorInText(labels)} take on?`;
}

/** A label at the start of a sentence or field name. */
export function capitalizedLabel(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

const shownTime = (epochMillis: number) =>
  DateTime.formatLocal(DateTime.makeUnsafe(epochMillis), {
    dateStyle: "medium",
    timeStyle: "short",
  });

/** The one line saying why the Coordinator cannot work or keeps failing; null while all is well. */
export function coordinatorAvailabilityLine(
  availability: CoordinatorSnapshot["availability"],
  fallback: string,
  now: number = DateTime.toEpochMillis(DateTime.nowUnsafe()),
): string | null {
  if (!availability || (availability.available && !availability.reason)) return null;
  const { attempts, nextAttemptAt, since } = availability;
  const details = [
    since === undefined ? null : `since ${shownTime(since)}`,
    attempts === undefined ? null : `${attempts} ${attempts === 1 ? "attempt" : "attempts"}`,
    nextAttemptAt === undefined || nextAttemptAt <= now
      ? null
      : `next attempt ${shownTime(nextAttemptAt)}`,
  ].filter((detail) => detail !== null);
  const reason = availability.reason ?? fallback;
  return details.length === 0 ? reason : `${reason} ${capitalizedLabel(details.join(", "))}.`;
}

/**
 * The person's guidance save. Notes without a draft are left out, so saving never puts back
 * notes the Coordinator changed after the editor opened.
 */
export function coordinatorGuidanceSave(
  threadId: string,
  customPrompt: string,
  memory: string,
  notesDraft: string | undefined,
): Extract<CoordinatorCommand, { type: "guidance.save" }> {
  return {
    type: "guidance.save",
    threadId,
    customPrompt,
    memory,
    ...(notesDraft === undefined ? {} : { coordinatorNotes: notesDraft }),
  };
}

/**
 * What the Coordinator's work holds for the owner: approvals the rules and the Coordinator left to
 * them, grants their words did not cover, finished work its result check held, and reviewed
 * changes waiting for them to merge where they switched automatic merge off. A person's own
 * thread is not here: its requests wait in that thread, as without the Coordinator.
 */
export function coordinatorNeedsOwner(
  snapshot: Pick<
    CoordinatorSnapshot,
    "permissionRequests" | "grantProposals" | "resultChecks" | "ownerMerges" | "budgetsReached"
  > &
    Partial<Pick<CoordinatorSnapshot, "projects" | "goals" | "configuration">>,
): Array<
  | {
      readonly kind: "approval";
      readonly id: string;
      readonly request: Readonly<Record<string, unknown>>;
      readonly reason: string;
    }
  | {
      readonly kind: "grant";
      readonly id: string;
      readonly grant: NonNullable<CoordinatorSnapshot["grantProposals"]>[number]["grant"];
      readonly reason: string;
    }
  | { readonly kind: "result"; readonly id: string; readonly head: string; readonly reason: string }
  | {
      readonly kind: "merge";
      readonly id: string;
      readonly reason: string;
      /** The owner's go-ahead merges it; otherwise they merge it on the host. */
      readonly canMerge: boolean;
    }
  /** A goal's cap is lifted only by the owner removing it; a project's also at the day's end. */
  | {
      readonly kind: "budget";
      readonly id: string;
      readonly reason: string;
      readonly goalId?: string;
    }
> {
  return [
    ...(snapshot.permissionRequests ?? []).flatMap((request) =>
      typeof request.id === "string" &&
      typeof request.assignmentId === "string" &&
      request.route === "owner"
        ? [
            {
              kind: "approval" as const,
              id: request.id,
              request,
              reason:
                request.passedToOwner === true
                  ? `${coordinatorInText(snapshot.configuration?.labels ?? DEFAULT_COORDINATOR_LABELS, true)} passed this to you.`
                  : typeof request.reason === "string"
                    ? request.reason
                    : "The rules leave this to you.",
            },
          ]
        : [],
    ),
    ...(snapshot.grantProposals ?? []).map((proposal) => ({
      kind: "grant" as const,
      id: proposal.grant.id,
      grant: proposal.grant,
      reason: proposal.reason,
    })),
    ...(snapshot.resultChecks ?? []).map((check) => ({
      kind: "result" as const,
      id: check.assignmentId,
      head: check.head,
      reason: check.blocking.join("; ") || "Its result check did not pass.",
    })),
    ...(snapshot.ownerMerges ?? []).map((merge) => ({
      kind: "merge" as const,
      id: merge.goalId,
      reason: `${merge.purpose} (into ${merge.target})${merge.reason ? `: ${merge.reason}` : ""}`,
      canMerge: merge.action === "merge",
    })),
    ...(snapshot.budgetsReached ?? []).map((budget) => {
      // The store stops at the first dimension reached, use before time.
      const used =
        budget.cap.micros !== null && budget.micros >= budget.cap.micros
          ? `${formatUsd(budget.micros / 1e6)} of ${formatUsd(budget.cap.micros / 1e6)} used`
          : `${coordinatorDuration(budget.seconds)} of ${coordinatorDuration(budget.cap.seconds)} worked`;
      if (budget.goalId !== undefined) {
        const purpose =
          snapshot.goals?.find((goal) => goal.id === budget.goalId)?.purpose ?? budget.goalId;
        return {
          kind: "budget" as const,
          id: `goal:${budget.goalId}`,
          goalId: budget.goalId,
          reason: `Goal "${purpose}" reached its cap, ${used}: nothing new starts for it until you remove the cap.`,
        };
      }
      const title =
        snapshot.projects?.find((project) => project.id === budget.projectId)?.title ??
        budget.projectId;
      return {
        kind: "budget" as const,
        id: `project:${budget.projectId}`,
        reason: `${title} reached its daily budget, ${used}: nothing new starts there until midnight UTC, or until you raise the budget in Settings.`,
      };
    }),
  ];
}

/** A cloud run with no new commit on its branch for this long is stalled, as the host judges it. */
export const COORDINATOR_CLOUD_STALL_MS = 3 * 3_600_000;

/**
 * The host's time now, from its clock when it answered plus what has passed here since: the
 * viewer's clock may be off, but it measures elapsed time well enough.
 */
export function coordinatorHostNow(hostNow: number, receivedAt: number, clientNow: number) {
  return hostNow + Math.max(0, clientNow - receivedAt);
}

/** Seconds as the dashboard shows them: to the minute, a known zero as 0, unknown as unknown. */
export function coordinatorDuration(seconds: number | null): string {
  if (seconds === null) return "unknown";
  if (seconds <= 0) return "0m";
  if (seconds < 60) return "under 1m";
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}` : `${minutes}m`;
}

const CLOUD_STATE: Record<string, string> = {
  out: "in the cloud",
  stalled: "stalled: no commit for 3 h",
  lost: "lost",
  unstopped: "not stopped",
  collected: "collected",
  ended: "ended",
  abandoned: "abandoned",
};

/** A dashboard row's state in words: its assignment's status, then what its thread or run says. */
export function coordinatorRowState(row: {
  readonly state: string;
  readonly detail: string | null;
  readonly cloud: unknown;
}): string {
  if (!row.detail || row.detail === row.state) return row.state;
  return `${row.state} · ${(row.cloud ? CLOUD_STATE[row.detail] : undefined) ?? row.detail}`;
}

export type CoordinatorPlace = "local" | "codex-cloud" | "claude-cloud";

/** What a thread's own shell says about it, for its row on the dashboard. */
export interface CoordinatorThreadFacts {
  readonly state: string;
  readonly since: number | null;
  readonly pullRequest: { readonly number: number; readonly url: string } | null;
}

const epoch = (iso: string | null | undefined) => {
  const value = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(value) ? value : null;
};

export function coordinatorThreadFacts(
  shell: Pick<
    EnvironmentThreadShell,
    "runtime" | "latestRun" | "updatedAt" | "pullRequests" | "hasPendingApprovals"
  >,
): CoordinatorThreadFacts {
  const status = shell.runtime?.status ?? "idle";
  const pullRequest = shell.pullRequests.at(-1);
  return {
    state: shell.hasPendingApprovals ? "waiting for approval" : status,
    since:
      status === "idle"
        ? (epoch(shell.latestRun?.completedAt) ?? epoch(shell.updatedAt))
        : (epoch(shell.runtime?.activityStartedAt) ?? epoch(shell.latestRun?.startedAt)),
    pullRequest: pullRequest ? { number: pullRequest.number, url: pullRequest.url } : null,
  };
}

const placeOf = (destination: string | null | undefined): CoordinatorPlace =>
  destination === "cloud:codex" || destination === "codex-cloud"
    ? "codex-cloud"
    : destination === "cloud:claude" || destination === "claude-cloud"
      ? "claude-cloud"
      : "local";

/**
 * The dashboard of the Coordinator's work: open goals in order of dependency, each delegated
 * thread or cloud run with who runs it, where, its state and what it used, and what waits for the
 * owner. Settled work is only counted. Nothing is estimated here: a value the host has not
 * recorded is null.
 */
export function coordinatorDashboard(
  snapshot: CoordinatorSnapshot,
  board: CoordinatorBoard,
  facts: (threadId: string) => CoordinatorThreadFacts | undefined,
  now: number,
) {
  const owner = coordinatorNeedsOwner(snapshot);
  const waits = new Map<string, string[]>();
  for (const item of owner) {
    const assignmentId =
      item.kind === "approval"
        ? item.request.assignmentId
        : item.kind === "result"
          ? item.id
          : undefined;
    if (typeof assignmentId === "string")
      waits.set(assignmentId, [...(waits.get(assignmentId) ?? []), item.reason]);
  }
  const assignments = new Map(board.assignments.map((item) => [item.id, item]));
  const runs = new Map(board.runs.map((run) => [run.assignmentId, run]));
  const spend = new Map(board.spend.map((row) => [row.assignmentId, row]));
  const goalsById = new Map(board.goals.map((goal) => [goal.id, goal]));
  // A card names its assignment once bound; until then its open assignment says it is delegated.
  const openByCard = new Map(
    board.assignments
      .filter((item) => !TERMINAL_ASSIGNMENT.has(item.status))
      .map((item) => [item.cardId, item.id]),
  );
  const work = board.cards
    .flatMap((card) => {
      const assignmentId = card.assignmentId ?? openByCard.get(card.id);
      return assignmentId === undefined ||
        card.settled ||
        card.archived ||
        card.threadId === snapshot.configuration.coordinatorThreadId
        ? []
        : [{ card, assignmentId }];
    })
    .map(({ card, assignmentId }) => {
      const assignment = assignments.get(assignmentId);
      const run = runs.get(assignmentId);
      const thread = run ? undefined : facts(card.threadId);
      const used = spend.get(assignmentId);
      const goalId = assignment?.goalId ?? null;
      const head = run?.branchHead ?? null;
      const lastMove = run?.movedAt ?? run?.startedAt ?? null;
      return {
        cardId: card.id,
        threadId: card.threadId,
        environmentId: card.environmentId,
        title: card.purpose,
        goalId,
        goal: goalId === null ? null : (goalsById.get(goalId)?.purpose ?? null),
        provider: assignment?.route.provider ?? card.provider,
        model: assignment?.actualModel ?? assignment?.route.model ?? run?.model ?? card.model,
        login: run?.login ?? assignment?.route.account ?? null,
        place: run ? placeOf(run.kind) : placeOf(assignment?.route.destination ?? card.destination),
        state: assignment?.status ?? card.status,
        detail: run
          ? run.state === "out" && lastMove !== null && now - lastMove >= COORDINATOR_CLOUD_STALL_MS
            ? "stalled"
            : run.state
          : (thread?.state ?? null),
        since: run?.startedAt ?? thread?.since ?? null,
        use: { micros: used?.micros ?? null, seconds: used?.seconds ?? null },
        cloud: run
          ? {
              startedAt: run.startedAt,
              endedAt: run.endedAt,
              head,
              movedAt: head === null ? null : run.movedAt,
            }
          : null,
        pullRequest: thread?.pullRequest ?? null,
        waits: waits.get(assignmentId) ?? [],
        blocker: card.blocker,
      };
    });
  const goalFacts = new Map(board.costs.map((goal) => [goal.goalId, goal]));
  const merges = new Map(board.merges.map((merge) => [merge.goalId, merge]));
  // Null while a merging goal's merge waits for nothing it has said.
  const mergeOf = (goalId: string) => {
    const merge = merges.get(goalId);
    return merge?.reason ? { reason: merge.reason, owner: merge.owner === 1 } : null;
  };
  const depth = new Map<string, number>();
  const depthOf = (id: string, seen: ReadonlySet<string>): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    const dependencies = (goalsById.get(id)?.dependencies ?? []).filter(
      (dependency) => goalsById.has(dependency) && !seen.has(dependency),
    );
    const value =
      dependencies.length === 0
        ? 0
        : 1 +
          Math.max(
            ...dependencies.map((dependency) => depthOf(dependency, new Set([...seen, id]))),
          );
    depth.set(id, value);
    return value;
  };
  const goals = board.goals
    .map((goal, index) => {
      const known = goalFacts.get(goal.id);
      return {
        id: goal.id,
        index,
        depth: depthOf(goal.id, new Set()),
        purpose: goal.purpose,
        status: goal.status ?? "active",
        dependencies: (goal.dependencies ?? []).filter((dependency) => goalsById.has(dependency)),
        // Routing's measure, like the time: a revert counts twice. A budget counts actual spend.
        use: { micros: known?.useMicros ?? null },
        // The host's measure, the router's: blocked time left out, a revert counted twice.
        elapsed: known && known.seconds !== null ? known.seconds * 1_000 : null,
        merge: mergeOf(goal.id),
        repairs: known?.repairs ?? 0,
        reverts: known?.reverts ?? 0,
        cap: { micros: goal.budgetMicros ?? null, seconds: goal.budgetSeconds ?? null },
      };
    })
    .sort((a, b) => a.depth - b.depth || a.index - b.index);
  const projectIds = [
    ...new Set([...board.budgets, ...board.today].map((row) => row.projectId)),
  ].sort();
  const projects = projectIds.map((projectId) => {
    const cap = board.budgets.find((row) => row.projectId === projectId);
    const today = board.today.find((row) => row.projectId === projectId);
    return {
      id: projectId,
      title: snapshot.projects?.find((project) => project.id === projectId)?.title ?? projectId,
      today: { micros: today?.micros ?? 0, seconds: today?.seconds ?? 0 },
      cap: { micros: cap?.micros ?? null, seconds: cap?.seconds ?? null },
    };
  });
  return {
    goals,
    work,
    projects,
    unresolved: board.unresolved,
    kept: board.kept,
    // Done but reverted: their cost as routing counts it, the revert counted twice.
    reverted: board.reverted.map((goal) => {
      const known = goalFacts.get(goal.goalId);
      return {
        id: goal.goalId,
        purpose: goal.purpose ?? goal.goalId,
        use: known?.useMicros ?? null,
        elapsed: known && known.seconds !== null ? known.seconds * 1_000 : null,
      };
    }),
    merged: board.merged,
    // Merged by hand at a head no review saw: done, and the owner is shown it.
    handMerged: board.merged.flatMap((goal) =>
      goal.unreviewed === 1
        ? [{ id: goal.goalId, purpose: goal.purpose ?? goal.goalId, head: goal.head ?? null }]
        : [],
    ),
    needsOwner: owner.length,
    settled: board.settled,
  };
}

import { describe, expect, it } from "@effect/vitest";
import {
  type CoordinatorBoard,
  type CoordinatorSnapshot,
  DEFAULT_COORDINATOR_LABELS,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  codexCloudTaskUrl,
  COORDINATOR_CLOUD_STALL_MS,
  coordinatorAvailabilityLine,
  coordinatorHostNow,
  coordinatorManages,
  coordinatorDashboard,
  coordinatorDuration,
  coordinatorEmptyHeading,
  coordinatorRowState,
  coordinatorFailure,
  coordinatorGuidanceSave,
  coordinatorNeedsOwner,
  coordinatorPermissionOrigin,
  coordinatorRefusal,
} from "./coordinator.ts";

describe("codexCloudTaskUrl", () => {
  it("only builds trusted URLs for valid native Codex task IDs", () => {
    expect(codexCloudTaskUrl("cloud:codex", "task_e_123abc")).toBe(
      "https://chatgpt.com/codex/tasks/task_e_123abc",
    );
    expect(codexCloudTaskUrl("cloud:codex", "task_e_123/../../other")).toBeNull();
    expect(codexCloudTaskUrl("cloud:codex", "https://evil.example")).toBeNull();
    expect(codexCloudTaskUrl("local", "task_e_123abc")).toBeNull();
  });
});

describe("coordinatorAvailabilityLine", () => {
  it("shows a store that is down or planning that keeps failing, and nothing once recovered", () => {
    const at = (epochMillis: number) =>
      DateTime.formatLocal(DateTime.makeUnsafe(epochMillis), {
        dateStyle: "medium",
        timeStyle: "short",
      });
    expect(coordinatorAvailabilityLine({ available: true }, "Unavailable.")).toBeNull();
    expect(coordinatorAvailabilityLine(undefined, "Unavailable.")).toBeNull();
    expect(coordinatorAvailabilityLine({ available: false }, "Unavailable.")).toBe("Unavailable.");
    expect(
      coordinatorAvailabilityLine(
        { available: false, reason: "The supervisor is not responding.", since: 0 },
        "Unavailable.",
      ),
    ).toBe(`The supervisor is not responding. Since ${at(0)}.`);
    // Planning failures leave the Coordinator available: its commands still work.
    expect(
      coordinatorAvailabilityLine(
        {
          available: true,
          reason: "Planning failed (destination).",
          since: 0,
          attempts: 3,
          nextAttemptAt: 420_000,
        },
        "Unavailable.",
        60_000,
      ),
    ).toBe(
      `Planning failed (destination). Since ${at(0)}, 3 attempts, next attempt ${at(420_000)}.`,
    );
    // A retry already due, or under way, names no past time.
    expect(
      coordinatorAvailabilityLine(
        {
          available: true,
          reason: "Planning failed (destination).",
          since: 0,
          attempts: 1,
          nextAttemptAt: 60_000,
        },
        "Unavailable.",
        90_000,
      ),
    ).toBe(`Planning failed (destination). Since ${at(0)}, 1 attempt.`);
  });
});

describe("coordinatorRefusal", () => {
  it("names the role by the labels set in settings", () => {
    const error = { operation: "coordinator-model", reason: "unavailable" };
    const labels = { ...DEFAULT_COORDINATOR_LABELS, coordinatorSingular: "Maestro" };
    expect(coordinatorRefusal(error, labels)).toBe(
      "This model isn't available for the Maestro. Check the provider's sign-in and model list.",
    );
    expect(coordinatorRefusal(error, { ...labels, coordinatorNameKind: "given" })).toBe(
      "This model isn't available for Maestro. Check the provider's sign-in and model list.",
    );
    expect(coordinatorRefusal({ operation: "cycle", reason: "invalid" }, labels)).toBeNull();
  });
});

describe("coordinatorPermissionOrigin", () => {
  it("tells same-category requests from different threads apart", () => {
    const snapshot = {
      cards: [{ id: "env:one", purpose: "Fix the login form" }],
      projects: [{ id: "web", title: "Web app" }],
    };
    const request = (threadId: string, projectId: string, detail?: string, operation?: string) => ({
      id: `env:request-${threadId}`,
      category: "command",
      ...(detail === undefined ? {} : { detail }),
      ...(operation === undefined ? {} : { operation }),
      cardId: `env:${threadId}`,
      threadId,
      projectId,
      environmentId: "env",
    });
    expect(
      coordinatorPermissionOrigin(request("one", "web", "vp test run", "vp test run"), snapshot),
    ).toEqual({
      environmentId: "env",
      threadId: "one",
      thread: "Fix the login form",
      project: "Web app",
      detail: null,
      operation: "vp test run",
    });
    expect(coordinatorPermissionOrigin(request("two", "api", "rm -rf dist"), snapshot)).toEqual({
      environmentId: "env",
      threadId: "two",
      thread: "two",
      project: "api",
      detail: "rm -rf dist",
      operation: null,
    });
    expect(coordinatorPermissionOrigin(request("three", "api"), snapshot)?.detail).toBeNull();
    expect(
      coordinatorPermissionOrigin({ id: "env:request", category: "command" }, snapshot),
    ).toBeNull();
  });

  it("offers inline approval only for the whole operation, its reason shown beside it", () => {
    const origin = (fields: Record<string, unknown>) =>
      coordinatorPermissionOrigin(
        { cardId: "c", environmentId: "env", projectId: "p", threadId: "t", ...fields },
        { cards: [] },
      );
    // A reason with its command: both kept, the command is what is approved.
    expect(origin({ detail: "Need permission to continue", operation: "vp test" })).toMatchObject({
      detail: "Need permission to continue",
      operation: "vp test",
    });
    // Only a reason, or nothing: no operation, so the row sends the user to the thread.
    expect(origin({ detail: "Need permission to continue" })?.operation).toBeNull();
    expect(origin({ operation: "  " })?.operation).toBeNull();
    // A consequential suffix past any shown prompt stays in the operation the row shows whole.
    const long = `vp test ${"a".repeat(600)} && rm -rf ~`;
    expect(origin({ detail: long.slice(0, 500), operation: long })).toMatchObject({
      detail: null,
      operation: long,
    });
    // A bidi override or terminal escape cannot reorder or hide what is shown.
    expect(
      origin({ detail: "Run \u001b[8mquietly", operation: "echo safe \u202E;~ fr- mr" }),
    ).toMatchObject({
      detail: "Run \\u{1B}[8mquietly",
      operation: "echo safe \\u{202E};~ fr- mr",
    });
    // Line separators, tag characters and variation selectors are hidden too; an astral one
    // escapes whole. Ordinary text, accents and CJK pass through, newline and tab included.
    expect(origin({ operation: "ls\u2028rm\u{E0072}\uFE0F -la\n\tcafé 日本 😀" })?.operation).toBe(
      "ls\\u{2028}rm\\u{E0072}\\u{FE0F} -la\n\tcafé 日本 😀",
    );
  });
});

describe("coordinatorGuidanceSave", () => {
  it("sends the notes only when the person drafted them, as drafted, an empty draft clearing them", () => {
    expect(coordinatorGuidanceSave("head", "Be brief.", "", undefined)).not.toHaveProperty(
      "coordinatorNotes",
    );
    expect(coordinatorGuidanceSave("head", "Be brief.", "", "")).toEqual({
      type: "guidance.save",
      threadId: "head",
      customPrompt: "Be brief.",
      memory: "",
      coordinatorNotes: "",
    });
    expect(coordinatorGuidanceSave("head", "", "", "Uses pnpm.")).toHaveProperty(
      "coordinatorNotes",
      "Uses pnpm.",
    );
  });
});

describe("coordinatorNeedsOwner", () => {
  it("holds only what the Coordinator's work leaves to the owner", () => {
    const grant = { id: "grant", scope: { kind: "project" as const, id: "project" } };
    const delegated = { assignmentId: "work", threadId: "t", route: "owner" };
    const items = coordinatorNeedsOwner({
      permissionRequests: [
        { ...delegated, id: "danger", reason: "On the danger list: forced push" },
        { ...delegated, id: "passed", passedToOwner: true },
        // A rule answers it, the Coordinator holds it, or it is a person's own thread's.
        { ...delegated, id: "rule", route: "rule" },
        { ...delegated, id: "coordinator", route: "coordinator" },
        { id: "person", threadId: "p", assignmentId: null, route: "owner" },
      ],
      grantProposals: [{ grant, reason: "The owner's message does not name src" }],
      resultChecks: [
        { assignmentId: "a", base: "b", head: "h", passed: false, blocking: ["Outside: docs"] },
      ],
      ownerMerges: [
        { goalId: "g", purpose: "Ship it", head: "h", target: "main", action: "merge" },
        {
          goalId: "pinned",
          purpose: "Pin it",
          head: "h",
          target: "main",
          reason: "The host cannot merge exactly the reviewed commit.",
          action: null,
        },
      ],
      budgetsReached: [
        { projectId: "app", cap: { micros: 2e6, seconds: null }, micros: 2.5e6, seconds: 60 },
        { goalId: "slow", cap: { micros: null, seconds: 3600 }, micros: 0, seconds: 3600 },
      ],
      projects: [{ id: "app", title: "App" }],
    });
    expect(items.map(({ kind, id, reason }) => [kind, id, reason])).toEqual([
      ["approval", "danger", "On the danger list: forced push"],
      ["approval", "passed", "The Conductor passed this to you."],
      ["grant", "grant", "The owner's message does not name src"],
      ["result", "a", "Outside: docs"],
      ["merge", "g", "Ship it (into main)"],
      ["merge", "pinned", "Pin it (into main): The host cannot merge exactly the reviewed commit."],
      [
        "budget",
        "project:app",
        "App reached its daily budget, $2.50 of $2.00 used: nothing new starts there until midnight UTC, or until you raise the budget in Settings.",
      ],
      [
        "budget",
        "goal:slow",
        'Goal "slow" reached its cap, 1h of 1h worked: nothing new starts for it until you remove the cap.',
      ],
    ]);
    // Only a merge the owner's go-ahead does has the button; the others they merge on the host.
    expect(items.flatMap((item) => (item.kind === "merge" ? [item.canMerge] : []))).toEqual([
      true,
      false,
    ]);
  });
});

describe("coordinatorDashboard", () => {
  const card = (id: string, assignmentId: string | null, extra: object = {}) => ({
    id,
    threadId: id,
    environmentId: "env",
    projectId: "project",
    purpose: `Work ${id}`,
    status: "running",
    instructionRevision: 1,
    profileId: null,
    provider: "codex",
    model: "luna",
    effort: null,
    destination: "local",
    assignmentId,
    blocker: null,
    nextStep: null,
    dependencies: [],
    acceptanceCriteria: [],
    evidence: [],
    summaryUpdatedAt: null,
    settled: false,
    archived: false,
    stale: false,
    verified: false,
    revision: 1,
    ...extra,
  });
  const assignment = (id: string, goalId: string, destination: string) =>
    ({
      id,
      cardId: id,
      goalId,
      status: "running",
      route: { provider: "claude", model: "opus", account: "work", destination },
      actualModel: null,
    }) as unknown as NonNullable<CoordinatorSnapshot["assignments"]>[number];
  const run = (assignmentId: string, extra: object) => ({
    id: 1,
    assignmentId,
    kind: "claude-cloud" as const,
    branch: "coordinator/x",
    model: "opus",
    effort: null,
    login: "/home/me/.claude-work",
    state: "out" as const,
    startedAt: 0,
    endedAt: null,
    branchHead: null,
    movedAt: null,
    ...extra,
  });
  // The snapshot's lists are pages; the dashboard reads the board's whole lists instead.
  const snapshot = {
    configuration: { coordinatorThreadId: "coordinator" },
    cards: [],
    goals: [],
    assignments: [],
    permissionRequests: [{ id: "r", assignmentId: "local", route: "owner", reason: "Forced push" }],
    projects: [{ id: "project", title: "App" }],
  } as unknown as CoordinatorSnapshot;
  const now = COORDINATOR_CLOUD_STALL_MS + 1;
  const board = {
    cards: [
      card("local", "local"),
      // Not bound to its card yet: its open assignment still makes it delegated work.
      card("quiet", null),
      card("pushing", "pushing"),
      card("done", "done", { settled: true }),
      card("mine", null),
      card("coordinator", "coordinator"),
    ],
    goals: [
      { id: "after", purpose: "After", dependencies: ["first", "merged"] },
      { id: "first", purpose: "First", status: "merging" },
    ],
    merges: [{ goalId: "first", reason: "Automatic merge is off here.", owner: 1 }],
    merged: [
      { goalId: "reviewed", purpose: "Reviewed", head: null, unreviewed: null },
      { goalId: "byhand", purpose: "By hand", head: "1".repeat(40), unreviewed: 1 },
    ],
    reverted: [{ goalId: "old", purpose: "Old export" }],
    kept: [],
    assignments: [
      assignment("local", "first", "local"),
      assignment("quiet", "after", "cloud:claude"),
      assignment("pushing", "after", "cloud:claude"),
    ],
    weights: { use: 1, time: 1 },
    limits: { inFlight: null, perLogin: null, localSlots: null },
    budgets: [{ projectId: "project", micros: 1_000, seconds: null }],
    today: [{ projectId: "project", micros: 300, seconds: 90 }],
    dayStartedAt: 0,
    now: COORDINATOR_CLOUD_STALL_MS + 1,
    spend: [
      { assignmentId: "local", goalId: "first", micros: 100, seconds: 30 },
      { assignmentId: "quiet", goalId: "after", micros: 200, seconds: 60 },
    ],
    costs: [
      { goalId: "after", repairs: 1, rounds: 2, seconds: 5_400, useMicros: 900, reverts: 1 },
      { goalId: "first", repairs: null, rounds: null, seconds: null, useMicros: null, reverts: 0 },
      { goalId: "old", repairs: 0, rounds: 2, seconds: 600, useMicros: 2_000, reverts: 1 },
    ],
    runs: [run("quiet", {}), run("pushing", { branchHead: "abc", movedAt: now - 60_000 })],
    unresolved: [],
    settled: 4,
  } as unknown as CoordinatorBoard;

  it("shows delegated open work only, and a cloud run's progress only as its commits show it", () => {
    const dashboard = coordinatorDashboard(
      snapshot,
      board,
      (threadId) =>
        threadId === "local" ? { state: "running", since: 7, pullRequest: null } : undefined,
      now,
    );
    // Settled work is counted, and a person's own thread and the Coordinator's are not listed.
    expect(dashboard.work.map((row) => row.cardId)).toEqual(["local", "quiet", "pushing"]);
    expect(dashboard.settled).toBe(4);
    const [local, quiet, pushing] = dashboard.work;
    expect(local).toMatchObject({
      place: "local",
      provider: "claude",
      model: "opus",
      since: 7,
      detail: "running",
      use: { micros: 100, seconds: 30 },
      waits: ["Forced push"],
    });
    expect(quiet).toMatchObject({
      place: "claude-cloud",
      login: "/home/me/.claude-work",
      detail: "stalled",
      cloud: { head: null, movedAt: null },
    });
    expect(coordinatorRowState(quiet!)).toBe("running · stalled: no commit for 3 h");
    expect(coordinatorRowState(local!)).toBe("running");
    expect(pushing).toMatchObject({
      detail: "out",
      use: { micros: null, seconds: null },
      cloud: { head: "abc", movedAt: now - 60_000 },
    });
  });

  it("orders goals by dependency and keeps use and time apart", () => {
    const dashboard = coordinatorDashboard(snapshot, board, () => undefined, now);
    expect(dashboard.goals.map((goal) => goal.id)).toEqual(["first", "after"]);
    expect(dashboard.goals[0]).toMatchObject({
      elapsed: null,
      status: "merging",
      merge: { reason: "Automatic merge is off here.", owner: true },
    });
    expect(dashboard.goals[1]?.merge).toBeNull();
    // A reverted goal is done, yet its doubled cost stays in view.
    expect(dashboard.reverted).toEqual([
      { id: "old", purpose: "Old export", use: 2_000, elapsed: 600_000 },
    ]);
    // A hand merge no review saw is shown with the head that landed; a reviewed merge is not.
    expect(dashboard.handMerged).toEqual([
      { id: "byhand", purpose: "By hand", head: "1".repeat(40) },
    ]);
    // A dependency already done is not open work.
    expect(dashboard.goals[1]).toMatchObject({
      dependencies: ["first"],
      // Routing's use, a revert doubled, not the 200 actually spent that the budget counts.
      use: { micros: 900 },
      // The host's time as routing counts it, not the client's guess from a start.
      elapsed: 5_400_000,
      repairs: 1,
      reverts: 1,
    });
    expect(dashboard.projects).toEqual([
      {
        id: "project",
        title: "App",
        today: { micros: 300, seconds: 90 },
        cap: { micros: 1_000, seconds: null },
      },
    ]);
  });
});

describe("coordinatorHostNow", () => {
  it("measures from the host's clock, whatever the viewer's clock says", () => {
    // The viewer's clock runs 3 hours ahead: what passed here counts, not its reading.
    const ahead = 3 * 3_600_000;
    expect(coordinatorHostNow(1_000_000, 5_000 + ahead, 65_000 + ahead)).toBe(1_060_000);
    // A minute tick taken just before the answer arrived never runs time backwards.
    expect(coordinatorHostNow(1_000_000, 5_000, 0)).toBe(1_000_000);
  });
});

describe("coordinatorDuration", () => {
  it("shows a known zero as zero and never rounds a short time up to a minute", () => {
    expect(coordinatorDuration(0)).toBe("0m");
    expect(coordinatorDuration(20)).toBe("under 1m");
    expect(coordinatorDuration(5_400)).toBe("1h 30m");
    expect(coordinatorDuration(7_200)).toBe("2h");
    expect(coordinatorDuration(null)).toBe("unknown");
  });
});

describe("coordinatorFailure", () => {
  it("tells the owner why their action failed, in the store's words where it gave some", () => {
    const labels = DEFAULT_COORDINATOR_LABELS;
    const failure = (error: unknown) => coordinatorFailure(error, labels);
    expect(
      failure({
        operation: "grants.set",
        reason: "policy",
        cause: { code: -32003, message: "Grant expiry must be in the future" },
      }),
    ).toBe("Grant expiry must be in the future");
    expect(failure({ operation: "configure", reason: "invalid", detail: "Choose one." })).toBe(
      "Choose one.",
    );
    expect(failure(new Error("lost"))).toBe("That didn't work. Try again.");
  });
});

describe("coordinatorManages", () => {
  it("covers threads it started, and others only once taken on while the owner lets it", () => {
    const card = (threadId: string, assignmentId: string | null) =>
      ({ id: `env:${threadId}`, threadId, assignmentId }) as never;
    const snapshot = (manageOtherThreads: boolean) =>
      ({
        configuration: { manageOtherThreads },
        cards: [card("assigned", "work"), card("person", null), card("pending", null)],
        assignments: [{ id: "queued", cardId: "env:pending", status: "queued" }],
        grants: [{ id: "g", scope: { kind: "thread", id: "granted" } }],
      }) as unknown as CoordinatorSnapshot;
    expect(coordinatorManages(snapshot(false), "coordinator:work")).toBe(true);
    expect(coordinatorManages(snapshot(false), "assigned")).toBe(false);
    // On: only threads it has taken on, never a thread merely because the setting is on.
    expect(coordinatorManages(snapshot(true), "person")).toBe(false);
    expect(coordinatorManages(snapshot(true), "untracked")).toBe(false);
    expect(coordinatorManages(snapshot(true), "assigned")).toBe(true);
    expect(coordinatorManages(snapshot(true), "pending")).toBe(true);
    expect(coordinatorManages(snapshot(true), "granted")).toBe(true);
  });
});

describe("coordinatorEmptyHeading", () => {
  it("asks what the Coordinator should take on, by the name the owner set and its kind", () => {
    const given = { ...DEFAULT_COORDINATOR_LABELS, coordinatorNameKind: "given" as const };
    expect(coordinatorEmptyHeading(DEFAULT_COORDINATOR_LABELS)).toBe(
      "What should the Conductor take on?",
    );
    expect(
      coordinatorEmptyHeading({ ...DEFAULT_COORDINATOR_LABELS, coordinatorSingular: "Maestro" }),
    ).toBe("What should the Maestro take on?");
    expect(coordinatorEmptyHeading(given)).toBe("What should Conductor take on?");
    expect(coordinatorEmptyHeading({ ...given, coordinatorSingular: "Claudia" })).toBe(
      "What should Claudia take on?",
    );
  });
});

import { assert, it } from "@effect/vitest";
import { CoordinatorError, type CoordinatorSnapshot, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as CoordinatorRole from "./CoordinatorRole.ts";
import * as Supervisor from "./Supervisor.ts";

const snapshot = (overrides: Partial<CoordinatorSnapshot> = {}): CoordinatorSnapshot => ({
  protocolVersion: 1,
  revision: 30,
  configuration: {
    enabled: true,
    coordinatorPaused: false,
    labels: {
      coordinatorSingular: "Coordinator",
      coordinatorPlural: "Coordinators",
      threadSingular: "thread",
      threadPlural: "threads",
      profileSingular: "profile",
      profilePlural: "profiles",
    },
    permissionMode: "ask",
    placement: "automatic",
    coordinatorTitle: null,
    coordinatorProvider: null,
    coordinatorModel: null,
    coordinatorThreadId: "thread:coordinator",
  },
  pause: { active: false, revision: 0 },
  cards: [],
  goals: [
    { id: "goal:open", purpose: "Ship it", status: "active", revision: 10 },
    {
      id: "goal:stuck",
      purpose: "Fix it",
      status: "blocked",
      evidence: ["Review failed"],
      revision: 21,
    },
  ],
  pendingActions: [],
  catalog: [],
  overrides: [],
  permissions: [],
  decisions: [
    {
      id: "d:old",
      summary: "Old",
      provenance: "x",
      cardIds: [],
      goalIds: [],
      expiresAt: null,
      revision: 5,
    },
    {
      id: "d:new",
      summary: "New",
      provenance: "x",
      cardIds: [],
      goalIds: [],
      expiresAt: null,
      revision: 25,
    },
  ],
  ...overrides,
});

const card = (threadId: string, assignmentId: string | null) => ({
  id: `environment:${threadId}`,
  threadId,
  environmentId: "environment",
  projectId: "project:a",
  purpose: "Work",
  status: "running",
  instructionRevision: 0,
  profileId: null,
  provider: null,
  model: null,
  effort: null,
  destination: null,
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
});
// The store's errors, as the supervisor passes them on.
const storeError = (method: string, code: number) =>
  Effect.fail(new CoordinatorError({ operation: method, reason: "policy", cause: { code } }));
const NOT_FOUND = -32004;

const role = (
  requests: Ref.Ref<ReadonlyArray<{ method: string; params: unknown }>>,
  stored: Record<string, unknown> = {},
  configuration: Partial<CoordinatorSnapshot["configuration"]> = {},
  extra: Partial<CoordinatorSnapshot> = {},
) =>
  CoordinatorRole.layerWithoutDependencies.pipe(
    Layer.provide(
      Layer.succeed(Supervisor.Supervisor, {
        available: true,
        request: (method, params) => {
          const { id, cursor, threadId } = params as {
            id?: string;
            cursor?: string;
            threadId?: string;
          };
          const reply =
            method === "snapshot"
              ? Effect.succeed(
                  snapshot({
                    configuration: { ...snapshot().configuration, ...configuration },
                    ...extra,
                  }),
                )
              : method === "goals.list"
                ? // A second page the snapshot never shows.
                  Effect.succeed(
                    cursor === undefined
                      ? { items: snapshot().goals, nextCursor: "goal:stuck" }
                      : {
                          items: [
                            {
                              id: "goal:far",
                              purpose: "Far",
                              status: "active",
                              authorizedScope: ["project:far"],
                            },
                          ],
                          nextCursor: null,
                        },
                  )
                : method === "goals.get"
                  ? id === "goal:flaky"
                    ? storeError(method, -32603)
                    : stored[id!] === undefined
                      ? storeError(method, NOT_FOUND)
                      : Effect.succeed({ goal: stored[id!] })
                  : method === "goals.upsert"
                    ? Effect.succeed({
                        goal: { ...(params as { goal: object }).goal, revision: 31 },
                      })
                    : method === "cards.find"
                      ? threadId === "thread:assigned"
                        ? Effect.succeed({ card: card(threadId, "assignment:1") })
                        : threadId === "thread:person"
                          ? Effect.succeed({ card: card(threadId, null) })
                          : storeError(method, NOT_FOUND)
                      : method === "assignments.list"
                        ? Effect.succeed({ items: extra.assignments ?? [], nextCursor: null })
                        : method === "events.position"
                          ? Effect.succeed({ runId: "run:earlier" })
                          : method === "events.read"
                            ? Effect.succeed({ events: [], nextCursor: 0, more: false })
                            : Effect.succeed({});
          return Ref.update(requests, (all) => [...all, { method, params }]).pipe(
            Effect.andThen(reply),
          );
        },
      }),
    ),
  );

it.effect("plans goals without widening their scope or replacing set criteria", () =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<ReadonlyArray<{ method: string; params: unknown }>>([]);
    const result = yield* CoordinatorRole.CoordinatorRole.pipe(
      Effect.flatMap((service) =>
        service.plan([
          { id: "goal:open", purpose: "Ship it well", acceptanceCriteria: ["Mine"] },
          {
            id: "goal:new",
            purpose: "Start",
            acceptanceCriteria: ["Tests pass"],
            touches: ["apps/web"],
          },
        ]),
      ),
      Effect.provide(
        role(requests, {
          "goal:open": {
            id: "goal:open",
            purpose: "Ship it",
            authorizedScope: ["project:a"],
            acceptanceCriteria: ["The owner's"],
            touches: ["apps/server"],
            revision: 10,
          },
        }),
      ),
    );
    const upserts = (yield* Ref.get(requests))
      .filter((request) => request.method === "goals.upsert")
      .map((request) => request.params as { goal: Record<string, unknown>; actor: string });
    assert.deepEqual(
      upserts.map(({ goal, actor }) => [
        goal.id,
        goal.authorizedScope,
        goal.acceptanceCriteria,
        goal.touches,
        actor,
      ]),
      [
        // What a goal touches is kept unless the plan says it again.
        ["goal:open", ["project:a"], ["The owner's"], ["apps/server"], "coordinator"],
        ["goal:new", [], ["Tests pass"], ["apps/web"], "coordinator"],
      ],
    );
    assert.deepEqual(
      result.goals.map((goal) => goal.authorizedScope),
      [["project:a"], []],
    );
  }),
);

it.effect("pages what is blocked, with the owner's instructions and grants from the store", () =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<ReadonlyArray<{ method: string; params: unknown }>>([]);
    const grant = { id: "grant", scope: { kind: "project" as const, id: "p" }, folders: ["docs"] };
    const status = yield* CoordinatorRole.CoordinatorRole.pipe(
      Effect.flatMap((service) => service.status(0)),
      Effect.provide(
        role(
          requests,
          {},
          {},
          {
            guidance: {
              threadId: "thread:coordinator",
              customPrompt: "Merge only green work.",
              memory: "Prefers pnpm.",
              revision: 2,
            },
            grants: [grant],
          },
        ),
      ),
    );
    assert.deepEqual(status.blocked, [{ kind: "goal", id: "goal:stuck", reason: "Review failed" }]);
    assert.equal(status.nextCursor, null);
    // What a compaction cut from the transcript comes back on the next status call.
    assert.deepEqual(status.instructions, {
      customPrompt: "Merge only green work.",
      memory: "Prefers pnpm.",
      notes: "",
    });
    assert.deepEqual(status.grants, [grant]);
  }),
);

it.effect("what is blocked comes with the host's reason, and blocked work is counted", () =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<ReadonlyArray<{ method: string; params: unknown }>>([]);
    const decision = { provenance: "x", cardIds: [], goalIds: ["goal:stuck"], expiresAt: null };
    const work = {
      id: "work",
      idempotencyKey: "work",
      cardId: "environment:thread:work",
      goalId: "goal:open",
      route: { provider: "replay", model: "model", destination: "local" },
      instructionRevision: 0,
      pauseRevision: 0,
      grantRevision: 0,
      reservation: {
        id: "reservation",
        owner: "t3:local",
        expiresAt: 1,
        policyRevision: "policy",
        sharedCapacity: true,
      },
      status: "blocked",
      brief: "Build it.",
      returnRoute: "coordinator",
      receipt: null,
      executionId: null,
      actualModel: null,
      actualEffort: null,
      identityVerified: true,
      groupPauseRevision: null,
      pauseStatus: null,
      resumeSupported: true,
      independentlyPaused: false,
      progressAt: null,
      lastContactAt: null,
      progressDeadline: null,
      checkIns: 0,
      attempts: 1,
      revision: 1,
    };
    const status = yield* CoordinatorRole.CoordinatorRole.pipe(
      Effect.flatMap((service) => service.status(0)),
      Effect.provide(
        role(requests, {}, {}, {
          cards: [
            {
              ...card("thread:work", "work"),
              blocker: "A destination permission or clarification request needs a response.",
            },
          ],
          assignments: [work, { ...work, id: "held", cardId: "environment:thread:held" }],
          resultChecks: [
            {
              assignmentId: "held",
              base: "b",
              head: "h",
              passed: false,
              blocking: ["changed outside the grant's folders: README.md"],
            },
          ],
          decisions: [
            { ...decision, id: "review-blocked:goal:stuck", summary: "Earlier.", revision: 7 },
            {
              ...decision,
              id: "review-blocked:goal:stuck",
              summary: "Independent review is pending.",
              revision: 9,
            },
            // A decision that names the goal without blocking it is no reason.
            { ...decision, id: "note:goal:stuck", summary: "A note.", revision: 12 },
          ],
        } as never),
      ),
    );
    assert.deepEqual(status.blocked, [
      { kind: "goal", id: "goal:stuck", reason: "Independent review is pending." },
      {
        kind: "assignment",
        id: "work",
        reason:
          "Thread thread:work: A destination permission or clarification request needs a response.",
      },
      {
        kind: "assignment",
        id: "held",
        reason: "its result is held for the owner: changed outside the grant's folders: README.md",
      },
    ]);
    assert.equal(status.counts.blocked, 3);
  }),
);

it.effect("stops a plan when the store fails to read a goal, saving nothing over it", () =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<ReadonlyArray<{ method: string; params: unknown }>>([]);
    const failed = yield* CoordinatorRole.CoordinatorRole.pipe(
      Effect.flatMap((service) => service.plan([{ id: "goal:flaky", purpose: "Overwrite" }])),
      Effect.flip,
      Effect.provide(role(requests)),
    );
    assert.equal(failed._tag, "CoordinatorError");
    assert.isFalse((yield* Ref.get(requests)).some((request) => request.method === "goals.upsert"));
  }),
);

it.effect("reads every page of goals for the scope, and asks the store who started a thread", () =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<ReadonlyArray<{ method: string; params: unknown }>>([]);
    const { state, assigned, person, unknown } = yield* CoordinatorRole.CoordinatorRole.pipe(
      Effect.flatMap((service) =>
        Effect.all({
          state: service.state,
          assigned: service.started(ThreadId.make("thread:assigned")),
          person: service.started(ThreadId.make("thread:person")),
          unknown: service.started(ThreadId.make("thread:unknown")),
        }),
      ),
      Effect.provide(role(requests)),
    );
    assert.isTrue(state.scope.has("project:far"));
    assert.deepEqual([assigned, person, unknown], [true, false, false]);
  }),
);

it.effect("answering its status proves the Coordinator's instance gave it its tools", () =>
  Effect.gen(function* () {
    const proofs = (configuration: Partial<CoordinatorSnapshot["configuration"]>) =>
      Effect.gen(function* () {
        const requests = yield* Ref.make<ReadonlyArray<{ method: string; params: unknown }>>([]);
        yield* CoordinatorRole.CoordinatorRole.pipe(
          Effect.flatMap((service) => service.status(0)),
          Effect.provide(role(requests, {}, configuration)),
        );
        return (yield* Ref.get(requests))
          .filter((request) => request.method === "proof.record")
          .map((request) => request.params);
      });
    const chosen = { coordinatorProvider: "any", coordinatorModel: "model" };
    assert.deepEqual(yield* proofs(chosen), [{ provider: "any", model: "model", proved: true }]);
    const proved = { provider: "any", model: "model", proved: true, at: 1 };
    assert.deepEqual(yield* proofs({ ...chosen, threadProof: proved }), []);
  }),
);

it.effect.each([
  ["confirms what an earlier turn read once it completed", true],
  ["leaves what a stopped turn read to be read again", false],
] as const)("%s", ([, completed]) =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<ReadonlyArray<{ method: string; params: unknown }>>([]);
    yield* Effect.gen(function* () {
      const service = yield* CoordinatorRole.CoordinatorRole;
      yield* service.inbox(undefined, {
        runId: "run:now",
        completed: (runId) => Effect.succeed(completed && runId === "run:earlier"),
      });
    }).pipe(Effect.provide(role(requests)));
    const inbox = (yield* Ref.get(requests)).filter(({ method }) => method.startsWith("events."));
    assert.deepStrictEqual(inbox, [
      { method: "events.position", params: {} },
      ...(completed ? [{ method: "events.confirm", params: { runId: "run:earlier" } }] : []),
      { method: "events.read", params: { runId: "run:now", limit: 20 } },
    ]);
  }),
);

it.effect("off, or for an ordinary thread, the role costs the store nothing once it was read", () =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<ReadonlyArray<{ method: string; params: unknown }>>([]);
    const seen = yield* Ref.make<Supervisor.CoordinatorSeen | null>(null);
    const layer = CoordinatorRole.layerWithoutDependencies.pipe(
      Layer.provide(
        Layer.succeed(Supervisor.Supervisor, {
          available: true,
          request: (method, params) =>
            Ref.update(requests, (all) => [...all, { method, params }]).pipe(Effect.as(snapshot())),
          lastSeen: Ref.get(seen),
        }),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* CoordinatorRole.CoordinatorRole;
      yield* Ref.set(requests, []);
      // Before any snapshot: an ordinary thread is never the Coordinator's.
      assert.deepEqual(yield* service.holds(ThreadId.make("person")), {
        holds: false,
        paused: false,
      });
      yield* Ref.set(seen, {
        enabled: false,
        coordinatorThreadId: "coordinator-lead:x",
        paused: true,
      });
      assert.deepEqual(yield* service.holds(ThreadId.make("coordinator-lead:x")), {
        holds: false,
        paused: true,
      });
      yield* Ref.set(seen, {
        enabled: true,
        coordinatorThreadId: "coordinator-lead:x",
        paused: false,
      });
      assert.isTrue((yield* service.holds(ThreadId.make("coordinator-lead:x"))).holds);
      assert.isFalse((yield* service.holds(ThreadId.make("person"))).holds);
      assert.deepEqual(yield* Ref.get(requests), []);
    }).pipe(Effect.provide(layer));
  }),
);

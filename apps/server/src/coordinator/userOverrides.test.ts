import { expect, it } from "@effect/vitest";
import { resolveUserOverride, userOverrideParameters } from "./userOverrides.ts";

it.each(["global", "project", "thread", "assignment"] as const)(
  "returns %s routing to automatic through the native clear operation",
  (kind) => {
    const scope = { kind, id: kind === "global" ? null : "same-id" };
    expect(userOverrideParameters({ id: "stored-override", scope, selection: {} })).toEqual({
      actor: "user",
      clear: true,
      scope,
    });
  },
);

it("preserves exact partial pins and explicit null fields instead of clearing their scope", () => {
  const override = {
    id: "project-pin",
    scope: { kind: "project" as const, id: "project" },
    selection: { provider: "chosen-account", model: "exact-model", account: null },
  };
  expect(userOverrideParameters(override)).toEqual({ actor: "user", override });
  expect(userOverrideParameters({ ...override, selection: { model: null } })).toEqual({
    actor: "user",
    clear: true,
    scope: override.scope,
  });
});

const card = {
  id: "env:thread",
  threadId: "thread",
  environmentId: "env",
  projectId: "project",
  purpose: "Build fixtures",
  provider: "chosen-account",
  destination: "local",
  effort: "high",
};
const models = [
  {
    provider: "chosen-account",
    id: "new-model",
    names: ["Advertised Model"],
    efforts: ["low", "high"],
  },
];
const resolve = (purpose: string) =>
  resolveUserOverride({ purpose, authorizedScope: ["project"], cards: [card], models });

it("binds exact source-user model and effort while preserving account and destination", () => {
  const result = resolve(
    "Please use model Advertised Model with effort low for thread Build fixtures.",
  );
  expect(result).toMatchObject({
    type: "resolved",
    model: "new-model",
    effort: "low",
    card: { provider: "chosen-account", destination: "local" },
  });
  expect(resolve("use model new-model for thread")).toMatchObject({
    type: "resolved",
    effort: "high",
  });
});

it("refuses negative, ambiguous, unsupported, and out-of-scope selections without substitution", () => {
  expect(resolve("Do not use model new-model for thread")).toEqual({ type: "none" });
  expect(resolve("Use SQLite for persistence")).toEqual({ type: "none" });
  expect(resolve("use model unknown for thread")).toMatchObject({ type: "needs-details" });
  expect(resolve("use model new-model with effort maximum for thread")).toMatchObject({
    type: "needs-details",
  });
  expect(
    resolveUserOverride({
      purpose: "use model new-model for Build fixtures",
      authorizedScope: ["project"],
      cards: [card, { ...card, id: "env:other", threadId: "other" }],
      models,
    }),
  ).toMatchObject({ type: "needs-details" });
  expect(
    resolveUserOverride({
      purpose: "use model new-model for thread",
      authorizedScope: [],
      cards: [card],
      models,
    }),
  ).toMatchObject({ type: "needs-details" });
});

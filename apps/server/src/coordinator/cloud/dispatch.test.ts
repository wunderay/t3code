import { assert, it } from "@effect/vitest";
import { cloudBlocker } from "./dispatch.ts";

const claude = {
  destination: "cloud:claude",
  allowed: true,
  bound: true,
  routeModel: "opus",
  model: "opus",
  effort: "high",
};

it("both clouds stay off until cloud runs are allowed", () => {
  assert.isUndefined(cloudBlocker(claude));
  assert.include(cloudBlocker({ ...claude, allowed: false }) ?? "", "not allowed");
  const codex = {
    ...claude,
    destination: "cloud:codex",
    routeModel: "provider-selected",
    model: null,
  };
  assert.isUndefined(cloudBlocker(codex));
  assert.include(cloudBlocker({ ...codex, allowed: false }) ?? "", "not allowed");
});

it("Claude cloud needs an exact model and effort; Codex cloud the provider-selected model", () => {
  assert.include(cloudBlocker({ ...claude, effort: null }) ?? "", "exact model and effort");
  assert.include(cloudBlocker({ ...claude, bound: false }) ?? "", "no cloud binding");
  assert.include(
    cloudBlocker({ ...claude, destination: "cloud:codex", routeModel: "gpt-5", model: "gpt-5" }) ??
      "",
    "provider-selected",
  );
});

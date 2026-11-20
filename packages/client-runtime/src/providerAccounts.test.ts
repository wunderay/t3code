import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { planProviderAccount } from "./providerAccounts.ts";

const claude = ProviderDriverKind.make("claudeAgent");
const codex = ProviderDriverKind.make("codex");

// Callers pass the platform's random UUID; distinct values stand in for it here.
let nonces = 0;
const nonce = () => `${(++nonces).toString(16).padStart(6, "0")}00-0000-4000-8000-000000000000`;

describe("planProviderAccount", () => {
  const folder = (plan: ReturnType<typeof planProviderAccount>) =>
    plan.instance.config as { homePath?: string; shadowHomePath?: string };

  it("gives each new account its own folder, even when names collide", () => {
    const first = planProviderAccount({
      driver: claude,
      name: "Work",
      existingIds: [],
      nonce: nonce(),
    });
    const second = planProviderAccount({
      driver: claude,
      name: "Work",
      existingIds: [first.instanceId],
      nonce: nonce(),
    });
    expect(first.instanceId).toBe("claudeAgent_work");
    expect(second.instanceId).toBe("claudeAgent_work_2");
    expect(folder(first).homePath).toMatch(/^~\/\.claude-work-[0-9a-f]{6}$/);
    expect(folder(second).homePath).toMatch(/^~\/\.claude-work_2-[0-9a-f]{6}$/);
  });

  it("gives a name added again after removal a fresh folder, not the old login", () => {
    const before = planProviderAccount({
      driver: claude,
      name: "Work",
      existingIds: [],
      nonce: nonce(),
    });
    const after = planProviderAccount({
      driver: claude,
      name: "Work",
      existingIds: [],
      nonce: nonce(),
    });
    expect(after.instanceId).toBe(before.instanceId);
    expect(folder(after).homePath).not.toBe(folder(before).homePath);
  });

  it("keeps Codex accounts on the shared home so threads can move between them", () => {
    const plan = planProviderAccount({
      driver: codex,
      name: "Personal",
      apiKey: "sk-test",
      existingIds: [],
      nonce: nonce(),
    });
    expect(plan.instance.config).toEqual({
      enabled: true,
      setupMode: "existing",
      shadowHomePath: expect.stringMatching(/^~\/\.codex-personal-[0-9a-f]{6}$/),
    });
    // Codex takes a key through its own sign-in, never as an instance variable.
    expect(plan.instance.environment).toBeUndefined();
  });

  it("uses an already-signed-in folder as the account's home", () => {
    expect(
      planProviderAccount({
        driver: claude,
        name: " Work ",
        folder: " ~/.claude-willy ",
        existingIds: ["claudeAgent_work"],
        nonce: nonce(),
      }),
    ).toEqual({
      instanceId: "claudeAgent_work_2",
      instance: {
        driver: "claudeAgent",
        enabled: true,
        displayName: "Work",
        config: { enabled: true, homePath: "~/.claude-willy" },
      },
    });
    expect(
      planProviderAccount({
        driver: codex,
        name: "Old",
        folder: "~/.codex-old",
        existingIds: [],
        nonce: nonce(),
      }).instance.config,
    ).toEqual({ enabled: true, setupMode: "existing", homePath: "~/.codex-old" });
  });

  it("stores a Claude API key only as a sensitive variable", () => {
    const plan = planProviderAccount({
      driver: claude,
      name: "API",
      apiKey: " sk-ant-test ",
      existingIds: [],
      nonce: nonce(),
    });
    expect(plan.instance.environment).toEqual([
      { name: "ANTHROPIC_API_KEY", value: "sk-ant-test", sensitive: true },
    ]);
  });
});

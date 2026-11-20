import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ManagedPolicySummary,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { planClaudeAccountSave } from "./claude-accounts";

const claude = ProviderDriverKind.make("claudeAgent");
const work = ProviderInstanceId.make("claudeAgent_work");

describe("planClaudeAccountSave", () => {
  it("edits the name and folder without dropping the instance's other settings", () => {
    const providerInstances: ServerSettings["providerInstances"] = {
      [work]: {
        driver: claude,
        displayName: "Work",
        accentColor: "#ff0000",
        enabled: false,
        environment: [{ name: "TOKEN", value: "", sensitive: true, valueRedacted: true }],
        config: { homePath: "~/.claude-work", binaryPath: "/opt/claude", launchArgs: "--chrome" },
      },
    };
    const edit = (name: string, configDir: string) =>
      planClaudeAccountSave({
        providerInstances,
        policy: undefined,
        instanceId: work,
        driver: claude,
        draft: { name, configDir },
      });

    expect(edit("Willy", "~/.claude-willy")).toEqual({
      mutation: {
        operation: "upsert",
        instanceId: work,
        instance: {
          ...providerInstances[work],
          displayName: "Willy",
          config: {
            binaryPath: "/opt/claude",
            launchArgs: "--chrome",
            homePath: "~/.claude-willy",
          },
        },
      },
    });
    // Clearing both falls back to the driver's label and the default ~/.claude folder.
    expect(edit("", "")).toEqual({
      mutation: {
        operation: "upsert",
        instanceId: work,
        instance: {
          driver: claude,
          accentColor: "#ff0000",
          enabled: false,
          environment: providerInstances[work]!.environment,
          config: { binaryPath: "/opt/claude", launchArgs: "--chrome" },
        },
      },
    });
    expect(
      planClaudeAccountSave({
        providerInstances: { [work]: { driver: claude, config: { homePath: "~/.claude-work" } } },
        policy: undefined,
        instanceId: work,
        driver: claude,
        draft: { name: "", configDir: "" },
      }),
    ).toEqual({
      mutation: { operation: "upsert", instanceId: work, instance: { driver: claude } },
    });
  });

  it("replaces or removes the API key as a sensitive variable, keeping other variables", () => {
    const providerInstances: ServerSettings["providerInstances"] = {
      [work]: {
        driver: claude,
        environment: [
          { name: "ANTHROPIC_API_KEY", value: "", sensitive: true, valueRedacted: true },
          { name: "OTHER", value: "1", sensitive: false },
        ],
      },
    };
    const edit = (apiKey?: string) => {
      const plan = planClaudeAccountSave({
        providerInstances,
        policy: undefined,
        instanceId: work,
        driver: claude,
        draft: { name: "", configDir: "", ...(apiKey === undefined ? {} : { apiKey }) },
      });
      return "mutation" in plan && plan.mutation.operation === "upsert"
        ? plan.mutation.instance.environment
        : undefined;
    };
    expect(edit()).toEqual(providerInstances[work]!.environment);
    expect(edit(" sk-new ")).toEqual([
      { name: "OTHER", value: "1", sensitive: false },
      { name: "ANTHROPIC_API_KEY", value: "sk-new", sensitive: true },
    ]);
    expect(edit("")).toEqual([{ name: "OTHER", value: "1", sensitive: false }]);
  });

  it("keeps the driver of a default instance that settings do not hold yet", () => {
    const codex = ProviderDriverKind.make("codex");
    const plan = planClaudeAccountSave({
      providerInstances: {},
      policy: undefined,
      instanceId: ProviderInstanceId.make("codex"),
      driver: codex,
      draft: { name: "Work", configDir: "" },
    });
    expect(plan).toEqual({
      mutation: {
        operation: "upsert",
        instanceId: "codex",
        instance: { driver: "codex", displayName: "Work" },
      },
    });
  });

  it("refuses instances the managed policy pins", () => {
    const policy: ManagedPolicySummary = {
      organization: "Example Corp",
      lockedSettings: ["providerInstances.claudeAgent_work.config.homePath"],
    };
    expect(
      planClaudeAccountSave({
        providerInstances: { [work]: { driver: claude } },
        policy,
        instanceId: work,
        driver: claude,
        draft: { name: "Work", configDir: "~/.claude-other" },
      }),
    ).toEqual({ error: "Managed by Example Corp." });
  });
});

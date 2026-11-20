import {
  isManagedSettingPath,
  ProviderDriverKind,
  type ManagedPolicySummary,
  type ProviderInstanceId,
  type ProviderInstanceConfig,
  type ProviderInstanceMutation,
  type ServerSettings,
} from "@t3tools/contracts";

export const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

export interface ClaudeAccountDraft {
  readonly name: string;
  readonly configDir: string;
  /** Unset keeps the stored key, a value replaces it, and an empty string removes it. */
  readonly apiKey?: string;
}

const API_KEY_VARIABLE = "ANTHROPIC_API_KEY";

export function hasClaudeApiKey(instance: ProviderInstanceConfig | undefined): boolean {
  return instance?.environment?.some((variable) => variable.name === API_KEY_VARIABLE) ?? false;
}

function configRecord(instance: ProviderInstanceConfig | undefined): Record<string, unknown> {
  const config = instance?.config;
  return config !== null && typeof config === "object" ? (config as Record<string, unknown>) : {};
}

export function claudeConfigDir(instance: ProviderInstanceConfig | undefined): string {
  const homePath = configRecord(instance).homePath;
  return typeof homePath === "string" ? homePath : "";
}

/** Edits an account's name, folder and Claude API key, keeping every field the form doesn't show. */
export function planClaudeAccountSave(input: {
  readonly providerInstances: ServerSettings["providerInstances"];
  readonly policy: ManagedPolicySummary | undefined;
  readonly instanceId: ProviderInstanceId;
  /** The row's driver: a default instance not yet in settings keeps it. */
  readonly driver: ProviderDriverKind;
  readonly draft: ClaudeAccountDraft;
}): { readonly mutation: ProviderInstanceMutation } | { readonly error: string } {
  const name = input.draft.name.trim();
  const configDir = input.draft.configDir.trim();
  const instanceId = input.instanceId;
  if (input.policy && isManagedSettingPath(input.policy, `providerInstances.${instanceId}`)) {
    return { error: `Managed by ${input.policy.organization}.` };
  }
  const current: ProviderInstanceConfig = Object.hasOwn(input.providerInstances, instanceId)
    ? input.providerInstances[instanceId]!
    : { driver: input.driver };
  const { displayName: _displayName, config: _config, environment, ...rest } = current;
  const apiKey = input.draft.apiKey?.trim();
  const nextEnvironment =
    apiKey === undefined
      ? environment
      : [
          ...(environment ?? []).filter((variable) => variable.name !== API_KEY_VARIABLE),
          ...(apiKey ? [{ name: API_KEY_VARIABLE, value: apiKey, sensitive: true }] : []),
        ];
  const { homePath: _homePath, ...config } = configRecord(current);
  const nextConfig = configDir ? { ...config, homePath: configDir } : config;
  const instance: ProviderInstanceConfig = {
    ...rest,
    ...(name ? { displayName: name } : {}),
    ...(Object.keys(nextConfig).length > 0 ? { config: nextConfig } : {}),
    ...(nextEnvironment && nextEnvironment.length > 0 ? { environment: nextEnvironment } : {}),
  };
  return { mutation: { operation: "upsert", instanceId, instance } };
}

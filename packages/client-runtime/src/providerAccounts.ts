import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";

import { deriveAvailableInstanceId, deriveInstanceId } from "./providerInstanceIds.ts";

/** Drivers whose CLI keeps each login in its own folder, so T3 can add an account and sign it in. */
export const ACCOUNT_DRIVERS = [
  { driver: ProviderDriverKind.make("claudeAgent"), label: "Claude", folderPrefix: "~/.claude-" },
  { driver: ProviderDriverKind.make("codex"), label: "Codex", folderPrefix: "~/.codex-" },
] as const;

/**
 * A new instance with a config folder of its own on the environment's machine (`~` is the server's
 * home). A Claude API key is stored as a sensitive variable; anything else signs in afterwards.
 */
export function planProviderAccount(input: {
  readonly driver: ProviderDriverKind;
  readonly name: string;
  readonly apiKey?: string;
  /** A folder already signed in on the environment, used as the account's home instead of a new one. */
  readonly folder?: string;
  readonly existingIds: Iterable<string>;
  /** A random UUID from the platform (React Native has no Web Crypto); it makes the folder unique. */
  readonly nonce: string;
}): { readonly instanceId: ProviderInstanceId; readonly instance: ProviderInstanceConfig } {
  const account = ACCOUNT_DRIVERS.find((candidate) => candidate.driver === input.driver);
  if (!account) throw new Error(`${input.driver} has no in-app accounts.`);
  const name = input.name.trim() || account.label;
  const id = deriveAvailableInstanceId(
    (label) => deriveInstanceId(account.driver, label) || `${account.driver}_account`,
    name,
    new Set(input.existingIds),
  );
  // Removing an account keeps its folder and login, so a re-added name must not land on it.
  const suffix = input.nonce.replaceAll("-", "").slice(0, 6);
  const existing = input.folder?.trim();
  const folder =
    existing || `${account.folderPrefix}${id.slice(account.driver.length + 1)}-${suffix}`;
  const apiKey = input.apiKey?.trim();
  return {
    instanceId: ProviderInstanceId.make(id),
    instance: {
      driver: account.driver,
      enabled: true,
      displayName: name,
      config:
        account.driver === "claudeAgent"
          ? { enabled: true, homePath: folder }
          : // An existing Codex folder is a whole Codex home; a new one shares ~/.codex's state.
            {
              enabled: true,
              setupMode: "existing",
              [existing ? "homePath" : "shadowHomePath"]: folder,
            },
      ...(apiKey && account.driver === "claudeAgent"
        ? { environment: [{ name: "ANTHROPIC_API_KEY", value: apiKey, sensitive: true }] }
        : {}),
    },
  };
}

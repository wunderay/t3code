import { ACCOUNT_DRIVERS, planProviderAccount } from "@t3tools/client-runtime/provider-accounts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthProvidersManageScope,
  type EnvironmentId,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { useState, type ReactNode } from "react";

import {
  useEnvironmentSettings,
  usePersistEnvironmentProviderInstanceMutation,
} from "../../hooks/useSettings";
import { randomUUID } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup } from "../ui/wizard";
import { ProviderWizardAuthenticationStep } from "./ProviderWizardAuthenticationStep";
import { SettingsRow } from "./settingsLayout";

/** Adds a Claude or Codex account with its own config folder, then signs it in on the environment. */
export function AddProviderAccountDialog({
  environmentId,
  environmentLabel,
  driver,
  onClose,
  onCreated,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly driver: ProviderDriverKind;
  readonly onClose: () => void;
  readonly onCreated?:
    | ((instanceId: ProviderInstanceId, driver: ProviderDriverKind) => void)
    | undefined;
}) {
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const settings = useEnvironmentSettings(environmentId);
  const persist = usePersistEnvironmentProviderInstanceMutation(environmentId);
  const label = ACCOUNT_DRIVERS.find((account) => account.driver === driver)?.label ?? driver;
  const isClaude = driver === "claudeAgent";
  const [name, setName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [pending, setPending] = useState(false);
  const [instanceId, setInstanceId] = useState<ProviderInstanceId | null>(null);

  const create = async () => {
    if (pending || !name.trim() || !readEnvironmentScope(environmentId, AuthProvidersManageScope))
      return;
    setPending(true);
    const plan = planProviderAccount({
      driver,
      name,
      ...(isClaude ? { apiKey } : {}),
      nonce: randomUUID(),
      existingIds: Object.keys(settings.providerInstances ?? {}),
    });
    const result = await persist({ operation: "create", ...plan });
    setPending(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not add the account",
        description: error instanceof Error ? error.message : "The settings update failed.",
      });
      return;
    }
    onCreated?.(plan.instanceId, driver);
    if (isClaude && apiKey.trim()) {
      toastManager.add({ type: "success", title: `${plan.instance.displayName} added` });
      onClose();
      return;
    }
    setInstanceId(plan.instanceId);
  };

  const header = (
    <WizardHeader
      title={`Add ${label} account`}
      description={`Each account gets its own ${label} config folder on ${environmentLabel}, and signs in there.`}
    />
  );
  if (instanceId)
    return (
      <AccountSignInDialog
        environmentId={environmentId}
        environmentLabel={environmentLabel}
        instanceId={instanceId}
        header={header}
        onClose={onClose}
      />
    );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <WizardPopup size="wide">
        {header}
        <>
          <WizardPanel>
            <form
              id="add-provider-account"
              className="grid gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void create();
              }}
            >
              <SettingsRow
                title="Account name"
                description="Shown in the provider list and model picker."
                control={
                  <Input
                    aria-label="Account name"
                    value={name}
                    disabled={pending}
                    placeholder="e.g. Personal or Work"
                    onChange={(event) => setName(event.target.value)}
                  />
                }
              />
              {isClaude ? (
                <SettingsRow
                  title="API key"
                  description="Optional. Leave empty to sign in with Claude next; a key is stored as a secret."
                  control={
                    <Input
                      aria-label="Anthropic API key"
                      type="password"
                      autoComplete="off"
                      value={apiKey}
                      disabled={pending}
                      onChange={(event) => setApiKey(event.target.value)}
                    />
                  }
                />
              ) : null}
            </form>
          </WizardPanel>
          <WizardFooter>
            <Button variant="outline" size="sm" disabled={pending} onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              form="add-provider-account"
              disabled={pending || !name.trim() || !canManageProviders}
            >
              {pending ? "Adding account…" : isClaude && apiKey.trim() ? "Add" : "Continue"}
            </Button>
          </WizardFooter>
        </>
      </WizardPopup>
    </Dialog>
  );
}

/**
 * While the environment runs this account's sign-in, closing would leave that login running until it
 * expires, so the dialog stays open until the user cancels it from the sign-in row.
 */
function AccountSignInDialog({
  environmentId,
  environmentLabel,
  instanceId,
  header,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly header: ReactNode;
  readonly onClose: () => void;
}) {
  const phase = useEnvironmentQuery(
    serverEnvironment.providerAuthState({ environmentId, input: { instanceId } }),
  ).data?.phase;
  const signingIn = phase === "starting" || phase === "waiting" || phase === "verifying";
  return (
    <Dialog open onOpenChange={(open) => !open && !signingIn && onClose()}>
      <WizardPopup size="wide" showCloseButton={!signingIn}>
        {header}
        <ProviderWizardAuthenticationStep
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          instanceId={instanceId}
          onFinish={onClose}
        />
      </WizardPopup>
    </Dialog>
  );
}

import type { MenuAction } from "@react-native-menu/menu";
import { ACCOUNT_DRIVERS, planProviderAccount } from "@t3tools/client-runtime/provider-accounts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  defaultInstanceIdForDriver,
  isManagedSettingPath,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderInstanceMutation,
  type ServerProvider,
} from "@t3tools/contracts";
import { useRef, useState } from "react";
import { TextInput, View } from "react-native";

import { uuidv4 } from "../../lib/uuid";
import * as Dialog from "../../components/ui/Dialog";
import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { Menu } from "../../components/ui/Menu";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  CLAUDE_DRIVER,
  claudeConfigDir,
  hasClaudeApiKey,
  planClaudeAccountSave,
  type ClaudeAccountDraft,
} from "./claude-accounts";
import type { SettingsTarget } from "./settings-environment-filter";

export function useProviderInstanceMutation(environment: SettingsTarget) {
  const mutate = useAtomCommand(serverEnvironment.mutateProviderInstance, {
    reportFailure: false,
    reportDefect: false,
  });
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(providerInstanceMutation: ProviderInstanceMutation) {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    const result = await mutate({
      environmentId: environment.environmentId,
      input: { patch: {}, providerInstanceMutation },
    });
    pendingRef.current = false;
    setPending(false);
    if (result._tag === "Success") return true;
    if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not save the account.");
    }
    return false;
  }
  return { run, pending, error, setError };
}

/** An account row without in-app sign-in: the provider is unavailable or its environment holds a key. */
export function SettingsOnlyAccount({
  environment,
  provider,
}: {
  readonly environment: SettingsTarget;
  readonly provider: ServerProvider;
}) {
  const [editing, setEditing] = useState(false);
  const { run, pending, error } = useProviderInstanceMutation(environment);
  const instance = environment.serverConfig.settings.providerInstances[provider.instanceId];
  const isClaude = provider.driver === CLAUDE_DRIVER;
  const configDir = isClaude ? claudeConfigDir(instance) || "Default config folder" : null;
  const name =
    provider.displayName ??
    ACCOUNT_DRIVERS.find((account) => account.driver === provider.driver)?.label ??
    provider.driver;
  const status = !provider.enabled
    ? "Turned off"
    : provider.auth.status === "authenticated"
      ? "Signed in"
      : provider.auth.status === "unauthenticated"
        ? "Not signed in"
        : !provider.installed
          ? "Not installed"
          : null;
  const removable =
    provider.instanceId !== defaultInstanceIdForDriver(provider.driver) &&
    !isManagedSettingPath(
      environment.serverConfig.managedPolicy,
      `providerInstances.${provider.instanceId}`,
    );
  const actions: MenuAction[] = [
    { id: "edit", title: "Edit", image: "pencil" },
    ...(removable
      ? [
          {
            id: "remove",
            title: "Remove",
            image: "trash",
            attributes: { destructive: true },
          } satisfies MenuAction,
        ]
      : []),
  ];
  function remove() {
    Dialog.alert(
      `Remove ${name}?`,
      `It leaves the model picker on ${environment.label}. The config folder and its sign-in stay on the server.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            void run({ operation: "remove", instanceId: provider.instanceId });
          },
        },
      ],
    );
  }
  return (
    <View className="border-t border-border-subtle">
      <View className="min-h-16 flex-row items-center gap-3 px-4 py-3">
        <View className="min-w-0 shrink grow gap-0.5">
          <Text textRole="body" className="text-foreground" numberOfLines={1}>
            {name}
          </Text>
          <Text textRole="footnote" className="text-foreground-muted" numberOfLines={2}>
            {[status, configDir].filter(Boolean).join(" · ")}
          </Text>
        </View>
        {editing ? null : (
          <Menu
            accessible
            accessibilityRole="button"
            accessibilityLabel={`${name} options`}
            title={name}
            actions={actions}
            onPressAction={({ nativeEvent }) => {
              if (pending) return;
              if (nativeEvent.event === "edit") setEditing(true);
              else if (nativeEvent.event === "remove") remove();
            }}
          >
            <ControlPill
              icon="ellipsis"
              accessibilityLabel={`${name} options`}
              disabled={pending}
            />
          </Menu>
        )}
      </View>
      {editing ? (
        <AccountForm
          environment={environment}
          instanceId={provider.instanceId}
          driver={provider.driver}
          onDone={() => setEditing(false)}
        />
      ) : error ? (
        <Text accessibilityRole="alert" className="px-4 pb-3 text-danger-foreground">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

/** Adds an account with its own config folder on the server; it signs in from its row. */
export function AddProviderAccount({
  environment,
  driver,
  label,
}: {
  readonly environment: SettingsTarget;
  readonly driver: ProviderDriverKind;
  readonly label: string;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [folder, setFolder] = useState("");
  const { run, pending, error, setError } = useProviderInstanceMutation(environment);
  const isClaude = driver === "claudeAgent";
  function add() {
    if (!name.trim()) {
      setError("Enter a name for this account.");
      return;
    }
    const plan = planProviderAccount({
      driver,
      name,
      ...(isClaude ? { apiKey } : {}),
      folder,
      nonce: uuidv4(),
      existingIds: Object.keys(environment.serverConfig.settings.providerInstances),
    });
    const policy = environment.serverConfig.managedPolicy;
    if (policy && isManagedSettingPath(policy, `providerInstances.${plan.instanceId}`)) {
      setError(`Managed by ${policy.organization}.`);
      return;
    }
    void run({ operation: "create", ...plan }).then((saved) => {
      if (!saved) return;
      setAdding(false);
      setName("");
      setApiKey("");
      setFolder("");
    });
  }
  const input = (
    value: string,
    onChange: (value: string) => void,
    placeholder: string,
    secret = false,
  ) => (
    <TextInput
      accessibilityLabel={placeholder}
      className="rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground"
      placeholderTextColorClassName="accent-foreground-muted"
      placeholder={placeholder}
      secureTextEntry={secret}
      autoCapitalize="none"
      autoCorrect={false}
      editable={!pending}
      value={value}
      onChangeText={onChange}
    />
  );
  return (
    <View className="border-t border-border-subtle">
      {adding ? (
        <View className="gap-2 px-4 py-3">
          <Text textRole="footnote" className="text-foreground-muted">
            {`The account gets its own ${label} config folder on ${environment.label}, or uses one already signed in there. Sign it in from its row once added.`}
          </Text>
          {input(name, setName, "Account name, e.g. Work")}
          {input(folder, setFolder, "Existing config folder (optional)")}
          {isClaude ? input(apiKey, setApiKey, "Anthropic API key (optional)", true) : null}
          {error ? (
            <Text accessibilityRole="alert" className="text-danger-foreground">
              {error}
            </Text>
          ) : null}
          <View className="flex-row justify-end gap-2">
            <ControlPill
              variant="pill"
              label="Cancel"
              disabled={pending}
              onPress={() => setAdding(false)}
            />
            <ControlPill variant="primary" label="Add" disabled={pending} onPress={add} />
          </View>
        </View>
      ) : (
        <ListActionRow
          icon="plus"
          label={`Add ${label} account`}
          description={`Sign in to another ${label} account or add an API key.`}
          onPress={() => setAdding(true)}
        />
      )}
    </View>
  );
}

/** Renames an account; for Claude also changes its folder and replaces or removes its API key. */
export function AccountForm({
  environment,
  instanceId,
  driver,
  onDone,
}: {
  readonly environment: SettingsTarget;
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly onDone: () => void;
}) {
  const instance = environment.serverConfig.settings.providerInstances[instanceId];
  const isClaude = driver === CLAUDE_DRIVER;
  const [draft, setDraft] = useState<ClaudeAccountDraft>({
    name: instance?.displayName ?? "",
    // Codex keeps its folder untouched here: a shadow home and its shared home change together on web.
    configDir: claudeConfigDir(instance),
  });
  const { run, pending, error, setError } = useProviderInstanceMutation(environment);
  function save(next: ClaudeAccountDraft = draft) {
    const plan = planClaudeAccountSave({
      providerInstances: environment.serverConfig.settings.providerInstances,
      policy: environment.serverConfig.managedPolicy,
      instanceId,
      driver,
      draft: next,
    });
    if ("error" in plan) {
      setError(plan.error);
      return;
    }
    void run(plan.mutation).then((saved) => {
      if (saved) onDone();
    });
  }
  function field(
    key: keyof ClaudeAccountDraft,
    label: string,
    placeholder: string,
    secret = false,
  ) {
    return (
      <TextInput
        accessibilityLabel={label}
        className="rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground"
        placeholderTextColorClassName="accent-foreground-muted"
        placeholder={placeholder}
        secureTextEntry={secret}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!pending}
        value={draft[key] ?? ""}
        onChangeText={(value) =>
          setDraft((current) => ({
            ...current,
            // An emptied key field means "keep it"; Remove API key clears it.
            [key]: key === "apiKey" && value === "" ? undefined : value,
          }))
        }
      />
    );
  }
  return (
    <View className="gap-2 px-4 py-3">
      {field("name", "Account name", "Name, e.g. Work")}
      {isClaude ? (
        <>
          <Text textRole="footnote" className="text-foreground-muted">
            {`The CLAUDE_CONFIG_DIR folder on ${environment.label} this account uses.`}
          </Text>
          {field("configDir", "Claude config folder", "Config folder, e.g. ~/.claude-work")}
          {field("apiKey", "Replace API key", "Replace API key (optional)", true)}
        </>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" className="text-danger-foreground">
          {error}
        </Text>
      ) : null}
      <View className="flex-row justify-end gap-2">
        {isClaude && hasClaudeApiKey(instance) ? (
          <ControlPill
            variant="pill"
            label="Remove API key"
            disabled={pending}
            onPress={() => save({ ...draft, apiKey: "" })}
          />
        ) : null}
        <ControlPill variant="pill" label="Cancel" disabled={pending} onPress={onDone} />
        <ControlPill variant="primary" label="Save" disabled={pending} onPress={() => save()} />
      </View>
    </View>
  );
}

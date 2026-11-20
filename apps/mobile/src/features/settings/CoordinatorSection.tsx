import {
  COORDINATOR_GOAL_PURPOSE_MAX_CHARS,
  COORDINATOR_GUIDANCE_MAX_CHARS,
  COORDINATOR_NOTES_MAX_CHARS,
  COORDINATOR_PERMISSION_CATEGORIES,
  COORDINATOR_PERMISSION_SCOPES,
  COORDINATOR_DEFAULT_REPAIR_ATTEMPTS,
  COORDINATOR_REPAIR_LIMIT_PROVENANCE,
  DEFAULT_COORDINATOR_LABELS,
  coordinatorInText,
  coordinatorName,
  describeCoordinatorGrant,
} from "@t3tools/contracts";
import {
  capitalizedLabel,
  coordinatorAvailabilityLine,
  coordinatorGuidanceSave,
  coordinatorPermissionOrigin,
  coordinatorRefusal,
} from "@t3tools/client-runtime/state/coordinator";
import { useAtomValue } from "@effect/atom-react";
import {
  EnvironmentId,
  type CoordinatorCommand,
  type CoordinatorSnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { Fragment, useState } from "react";
import { TextInput, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { useEnvironments } from "../../state/environments";
import { coordinatorEnvironment } from "../../state/coordinator";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { uuidv4 } from "../../lib/uuid";
import { SettingsSection } from "./components/SettingsSection";
import { CoordinatorDashboardSwitch } from "./CoordinatorDashboard";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";

const LABELS = [
  ["coordinatorSingular", "Name"],
  ["coordinatorPlural", "Plural name"],
  ["threadSingular", "Work thread title"],
  ["threadPlural", "Work thread plural"],
  ["profileSingular", "Agent profile title"],
  ["profilePlural", "Agent profile plural"],
] as const;

export const MODES = [
  ["ask", "Ask for me"],
  ["approve", "Approve for me"],
  ["full", "Full approval"],
  ["custom", "Custom permissions"],
] as const;

const OVERRIDE_SCOPES = ["global", "project", "thread", "assignment"] as const;

export function Field({
  label,
  value,
  onChange,
  disabled = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
}) {
  return (
    <View className="gap-1">
      <Text>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        editable={!disabled}
        className="rounded border border-border p-2 text-foreground"
        value={value}
        onChangeText={onChange}
      />
    </View>
  );
}

// Without a notes draft the editor shows the stored notes, which the Coordinator may change.
const guidanceDrafts = new Map<
  string,
  { prompt: string; memory: string; notes: string | undefined }
>();

function PermissionPreview({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const allowed = useAtomValue(coordinatorEnvironment.command.permissionAtom(environmentId));
  const execute = useAtomCommand(coordinatorEnvironment.command);
  const [scope, setScope] = useState<"global" | "project" | "environment" | "thread">("global");
  const [scopeId, setScopeId] = useState("");
  const [category, setCategory] = useState("file-read");
  const [current, setCurrent] = useState<0 | 1 | 2>(0);
  const [requested, setRequested] = useState<"unknown" | 0 | 1 | 2>("unknown");
  const [preview, setPreview] = useState<CoordinatorSnapshot["permissionPreview"]>(undefined);
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  return (
    <View className="gap-2">
      <Text>Hypothetical policy preview</Text>
      <Text>
        Evaluates saved policy for the selected scope and request bounds; it does not change
        permissions or represent a live request.
      </Text>
      <Text>Scope: {scope}</Text>
      {COORDINATOR_PERMISSION_SCOPES.map((value) => (
        <Button
          key={value}
          label={value}
          disabled={pending}
          onPress={() => {
            setScope(value);
            setPreview(undefined);
          }}
        />
      ))}
      {scope !== "global" && (
        <Field
          label="Scope ID"
          disabled={pending}
          value={scopeId}
          onChange={(value) => {
            setScopeId(value);
            setPreview(undefined);
          }}
        />
      )}
      <Text>Category: {category}</Text>
      {COORDINATOR_PERMISSION_CATEGORIES.map((value) => (
        <Button
          key={value}
          label={value}
          disabled={pending}
          onPress={() => {
            setCategory(value);
            setPreview(undefined);
          }}
        />
      ))}
      <Text>Current access: {current}</Text>
      {([0, 1, 2] as const).map((value) => (
        <Button
          key={value}
          label={String(value)}
          disabled={pending}
          onPress={() => {
            setCurrent(value);
            setPreview(undefined);
          }}
        />
      ))}
      <Text>Requested access: {requested}</Text>
      {(["unknown", 0, 1, 2] as const).map((value) => (
        <Button
          key={value}
          label={String(value)}
          disabled={pending}
          onPress={() => {
            setRequested(value);
            setPreview(undefined);
          }}
        />
      ))}
      <Button
        label="Preview saved policy"
        disabled={!allowed || pending || (scope !== "global" && !scopeId.trim())}
        onPress={async () => {
          setPending(true);
          setPreview(undefined);
          await execute({
            environmentId,
            input: {
              type: "permissions.preview",
              scope: { kind: scope, id: scope === "global" ? null : scopeId },
              category,
              currentAccess: current,
              ...(requested === "unknown" ? {} : { requestedAccess: requested }),
            },
          })
            .then((result) => {
              if (result._tag === "Success" && result.value.permissionPreview) {
                setPreview(result.value.permissionPreview);
                setNotice("");
              } else setNotice("Could not evaluate policy.");
            })
            .catch(() => setNotice("Could not evaluate policy."))
            .finally(() => setPending(false));
        }}
      />
      {preview && (
        <Text>
          Hypothetical result: {preview.effect}. {preview.reason ?? ""} Maximum access{" "}
          {preview.maxAccess}; policies {preview.policyIds.join(", ") || "none"}; revision{" "}
          {preview.policyRevision}
          {preview.accessIncreaseUnknown ? "; requested access unknown" : ""}.
        </Text>
      )}
      {notice ? <Text>{notice}</Text> : null}
    </View>
  );
}

export function GuidanceEditor({
  environmentId,
  threadId,
  guidance,
  labels,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly guidance: CoordinatorSnapshot["guidance"];
  readonly labels: CoordinatorSnapshot["configuration"]["labels"];
}) {
  const allowed = useAtomValue(coordinatorEnvironment.command.permissionAtom(environmentId));
  const execute = useAtomCommand(coordinatorEnvironment.command);
  const draftKey = `${environmentId}:${threadId}`;
  const [prompt, setPrompt] = useState(
    () =>
      guidanceDrafts.get(draftKey)?.prompt ??
      (guidance?.threadId === threadId ? guidance.customPrompt : ""),
  );
  const [memory, setMemory] = useState(
    () =>
      guidanceDrafts.get(draftKey)?.memory ??
      (guidance?.threadId === threadId ? guidance.memory : ""),
  );
  const [notesDraft, setNotesDraft] = useState(() => guidanceDrafts.get(draftKey)?.notes);
  const notes =
    notesDraft ?? (guidance?.threadId === threadId ? (guidance.coordinatorNotes ?? "") : "");
  const changePrompt = (value: string) => {
    setPrompt(value);
    guidanceDrafts.set(draftKey, { prompt: value, memory, notes: notesDraft });
  };
  const changeMemory = (value: string) => {
    setMemory(value);
    guidanceDrafts.set(draftKey, { prompt, memory: value, notes: notesDraft });
  };
  const changeNotes = (value: string) => {
    setNotesDraft(value);
    guidanceDrafts.set(draftKey, { prompt, memory, notes: value });
  };
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const serializedLength = Array.from(JSON.stringify({ customPrompt: prompt, memory })).length;
  const tooLong =
    Array.from(prompt).length > COORDINATOR_GUIDANCE_MAX_CHARS ||
    Array.from(memory).length > COORDINATOR_GUIDANCE_MAX_CHARS ||
    serializedLength > COORDINATOR_GUIDANCE_MAX_CHARS ||
    Array.from(notes).length > COORDINATOR_NOTES_MAX_CHARS;
  return (
    <View className="gap-2">
      <Text>
        Custom prompt and memory guide {coordinatorInText(labels)}. They do not grant access or
        override model and destination pins.
      </Text>
      <Text>Custom prompt (Markdown)</Text>
      <TextInput
        accessibilityLabel="Custom prompt (Markdown)"
        multiline
        value={prompt}
        onChangeText={changePrompt}
        className="rounded border border-border p-2 text-foreground"
      />
      <Button label="Clear prompt draft" onPress={() => changePrompt("")} />
      <Text>Memory (Markdown)</Text>
      <TextInput
        accessibilityLabel="Memory (Markdown)"
        multiline
        value={memory}
        onChangeText={changeMemory}
        className="rounded border border-border p-2 text-foreground"
      />
      <Button label="Clear memory draft" onPress={() => changeMemory("")} />
      <Text>{labels.coordinatorSingular} notes</Text>
      <TextInput
        accessibilityLabel={`${labels.coordinatorSingular} notes`}
        multiline
        value={notes}
        onChangeText={changeNotes}
        className="rounded border border-border p-2 text-foreground"
      />
      <Text>
        {coordinatorInText(labels, true)} writes these notes itself: lasting facts and corrections
        about you and your projects. Each change it makes is listed in its decisions. Edit or clear
        them here; they are saved with the prompt and memory.
      </Text>
      <Button label="Clear notes draft" onPress={() => changeNotes("")} />
      <Text>
        {Array.from(notes).length}/{COORDINATOR_NOTES_MAX_CHARS} notes characters.{" "}
        {Array.from(prompt).length}/{COORDINATOR_GUIDANCE_MAX_CHARS} prompt characters;{" "}
        {Array.from(memory).length}/{COORDINATOR_GUIDANCE_MAX_CHARS} memory characters; serialized
        total {serializedLength}/{COORDINATOR_GUIDANCE_MAX_CHARS}. Clear a draft and save to remove
        stored text.
      </Text>
      {tooLong && (
        <Text>
          The serialized total and each field must be within {COORDINATOR_GUIDANCE_MAX_CHARS}{" "}
          characters, the notes within {COORDINATOR_NOTES_MAX_CHARS}. Your draft is preserved.
        </Text>
      )}
      <Button
        label="Save prompt and memory"
        disabled={!allowed || pending || tooLong}
        onPress={async () => {
          setPending(true);
          await execute({
            environmentId,
            input: coordinatorGuidanceSave(threadId, prompt, memory, notesDraft),
          })
            .then((result) => {
              if (result._tag === "Success") {
                const latest = guidanceDrafts.get(draftKey);
                if (
                  latest?.prompt === prompt &&
                  latest.memory === memory &&
                  latest.notes === notesDraft
                ) {
                  guidanceDrafts.delete(draftKey);
                  setNotesDraft(undefined);
                }
              }
              setNotice(
                result._tag === "Success"
                  ? "Saved."
                  : `Could not save. Check ${coordinatorInText(labels)} and the context budget.`,
              );
            })
            .catch(() =>
              setNotice(
                `Could not save. Check ${coordinatorInText(labels)} and the context budget.`,
              ),
            )
            .finally(() => setPending(false));
        }}
      />
      {notice ? <Text>{notice}</Text> : null}
    </View>
  );
}

export function RepairLimitControl({
  environmentId,
  goal,
  decisions,
}: {
  readonly environmentId: EnvironmentId;
  readonly goal: CoordinatorSnapshot["goals"][number];
  readonly decisions: NonNullable<CoordinatorSnapshot["decisions"]>;
}) {
  const allowed = useAtomValue(coordinatorEnvironment.command.permissionAtom(environmentId));
  const execute = useAtomCommand(coordinatorEnvironment.command);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const decision = decisions.find(
    (item) =>
      item.id === `repair-limit:${goal.id}` &&
      item.provenance === COORDINATOR_REPAIR_LIMIT_PROVENANCE &&
      item.goalIds.includes(goal.id),
  );
  if (!decision || goal.status !== "blocked") return null;
  return (
    <View className="gap-2">
      <Text>{decision.summary}</Text>
      <Button
        label="Allow 3 more repairs"
        disabled={!allowed || pending || goal.revision === undefined}
        onPress={async () => {
          if (goal.revision === undefined) return;
          setPending(true);
          await execute({
            environmentId,
            input: {
              type: "goal.upsert",
              goal: {
                ...goal,
                status: "active",
                maxAttempts:
                  (goal.maxAttempts ?? COORDINATOR_DEFAULT_REPAIR_ATTEMPTS) +
                  COORDINATOR_DEFAULT_REPAIR_ATTEMPTS,
              },
            },
          })
            .then((result) => {
              setNotice(
                result._tag === "Success"
                  ? "Additional repairs allowed."
                  : "Could not allow additional repairs.",
              );
            })
            .catch(() => {
              setNotice("Could not allow additional repairs.");
            })
            .finally(() => {
              setPending(false);
            });
        }}
      />
      {goal.revision === undefined ? (
        <Text>Reload the goal before allowing more repairs.</Text>
      ) : null}
      {notice ? <Text>{notice}</Text> : null}
    </View>
  );
}

export function MobileCoordinatorPauseControls() {
  const { environments } = useEnvironments();
  return (
    <>
      {environments.map((environment) => (
        <CoordinatorSection
          key={environment.environmentId}
          environmentId={environment.environmentId}
          compact
        />
      ))}
    </>
  );
}

export function CoordinatorSection({
  environmentId,
  compact = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly compact?: boolean;
}) {
  const { data, error } = useEnvironmentQuery(
    coordinatorEnvironment.snapshot({ environmentId, input: {} }),
  );
  const selectDetail = useSelectWorkspaceDetail();
  const allowed = useAtomValue(coordinatorEnvironment.command.permissionAtom(environmentId));
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const execute = useAtomCommand(coordinatorEnvironment.command);
  const [pending, setPending] = useState(false);
  const [purpose, setPurpose] = useState("");
  const [labels, setLabels] = useState<Partial<CoordinatorSnapshot["configuration"]["labels"]>>({});
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [destination, setDestination] = useState("");
  const [checkIn, setCheckIn] = useState<string | null>(null);
  const [overrideScopeKind, setOverrideScopeKind] =
    useState<(typeof OVERRIDE_SCOPES)[number]>("global");
  const [overrideTargetId, setOverrideTargetId] = useState("");
  const [overrideProvider, setOverrideProvider] = useState("");
  const [overrideModel, setOverrideModel] = useState("");
  const [overrideAccount, setOverrideAccount] = useState("");
  const [overrideProfile, setOverrideProfile] = useState("");
  const [overrideBindingSelected, setOverrideBindingSelected] = useState(false);
  const [category, setCategory] = useState("file-read");
  const [ruleEffect, setRuleEffect] = useState<"allow" | "ask" | "deny">("ask");
  const [presetName, setPresetName] = useState("");
  const [rules, setRules] = useState<
    Array<{ key: string; category: string; effect: "allow" | "ask" | "deny"; resource: null }>
  >([]);
  const [bindingName, setBindingName] = useState("");
  const [bindingNames, setBindingNames] = useState<Record<string, string>>({});
  const [guildProvider, setGuildProvider] = useState("codex");
  const [guildAccount, setGuildAccount] = useState("");
  const [profileId, setProfileId] = useState("");
  const [capacityModel, setCapacityModel] = useState("");
  const [cloud, setCloud] = useState({
    projectId: "",
    guildModel: "",
    repository: "",
    environment: "",
    branch: "",
    head: "",
    base: "",
  });
  const [scope, setScope] =
    useState<CoordinatorSnapshot["permissions"][number]["scope"]["kind"]>("global");
  const [scopeId, setScopeId] = useState("");
  const [maxAccess, setMaxAccess] = useState("");
  const [allowIncrease, setAllowIncrease] = useState(false);
  const [policyExpiry, setPolicyExpiry] = useState("");
  const [commandNotice, setCommandNotice] = useState<string | null>(null);
  const send = async (input: CoordinatorCommand) => {
    setPending(true);
    const result = await execute({ environmentId, input }).finally(() => {
      setPending(false);
    });
    setCommandNotice(
      result._tag === "Success"
        ? input.type === "stop.all" || input.type === "assignment.cancel"
          ? "Cancellation requested; check destination status."
          : null
        : (coordinatorRefusal(
            Cause.squash(result.cause),
            data?.configuration.labels ?? DEFAULT_COORDINATOR_LABELS,
          ) ?? "Could not complete the action."),
    );
    return result._tag === "Success";
  };
  if (compact) {
    if (!data?.configuration.enabled) return null;
    return (
      <View className="flex-row gap-2">
        {data.configuration.coordinatorThreadId && (
          <Button
            label={coordinatorName(data.configuration)}
            onPress={() =>
              selectDetail({
                name: "Thread",
                params: {
                  environmentId: String(environmentId),
                  threadId: data.configuration.coordinatorThreadId!,
                },
              })
            }
          />
        )}
        <Button
          label={data.pause.active ? "Resume all" : "Pause all"}
          disabled={!allowed || pending}
          onPress={() => {
            void send({ type: data.pause.active ? "resume.all" : "pause.all" });
          }}
        />
      </View>
    );
  }
  if (data === null)
    return (
      <SettingsSection title={DEFAULT_COORDINATOR_LABELS.coordinatorSingular}>
        <Text>{error ?? `Loading ${coordinatorInText(DEFAULT_COORDINATOR_LABELS)}…`}</Text>
      </SettingsSection>
    );
  const config = data.configuration;
  const nameKind = labels.coordinatorNameKind ?? config.labels.coordinatorNameKind ?? "role";
  const overrideScope = {
    kind: overrideScopeKind,
    id: overrideScopeKind === "global" ? null : overrideTargetId.trim(),
  };
  const overrideTargetMissing = overrideScope.kind !== "global" && !overrideScope.id;
  const currentOverride = data.overrides.find(
    (item) => item.scope.kind === overrideScope.kind && item.scope.id === overrideScope.id,
  );
  const disabled = !allowed || pending;
  const configure = (configuration: Partial<CoordinatorSnapshot["configuration"]>) =>
    send({ type: "configure", configuration });
  const availabilityLine = coordinatorAvailabilityLine(
    data.availability,
    `${coordinatorInText(config.labels, true)} is unavailable.`,
  );
  return (
    <SettingsSection title={config.labels.coordinatorSingular}>
      <View className="gap-3 p-3">
        {data.configuration.coordinatorThreadId && (
          <GuidanceEditor
            key={`${environmentId}:${data.configuration.coordinatorThreadId}`}
            environmentId={environmentId}
            threadId={data.configuration.coordinatorThreadId}
            guidance={data.guidance}
            labels={config.labels}
          />
        )}
        <Text>
          Give {coordinatorInText(config.labels)} a desired outcome. You can still open and direct
          every work thread.
        </Text>
        {availabilityLine && <Text>{availabilityLine}</Text>}
        <CoordinatorDashboardSwitch labels={config.labels} />
        <Button
          label={`${config.enabled ? "Disable" : "Enable"} ${config.labels.coordinatorSingular}`}
          disabled={disabled}
          onPress={() => {
            void configure({ enabled: !config.enabled });
          }}
        />
        <Button
          label={data.pause.active ? "Resume all" : "Pause all"}
          disabled={disabled}
          onPress={() => {
            void send({ type: data.pause.active ? "resume.all" : "pause.all" });
          }}
        />
        <Button
          label="Stop all supervised work"
          disabled={disabled}
          onPress={() => {
            void send({ type: "stop.all" });
          }}
        />
        <Text>
          Stop requests cancellation; cloud or unreachable work may remain running until confirmed.
          Pause keeps work resumable where supported.
        </Text>
        <Button
          label={`${config.coordinatorPaused ? "Resume" : "Pause"} ${config.labels.coordinatorSingular}`}
          disabled={disabled}
          onPress={() => {
            void configure({ coordinatorPaused: !config.coordinatorPaused });
          }}
        />
        {config.enabled && <Text>Grants · {data.grants?.length ?? 0}</Text>}
        {config.enabled &&
          data.grants?.map((grant) => (
            <View key={grant.id} className="gap-1">
              <Text>
                {describeCoordinatorGrant(
                  grant,
                  grant.scope.kind === "project"
                    ? data.projects?.find((project) => project.id === grant.scope.id)?.title
                    : undefined,
                )}
              </Text>
              <Button
                label="Withdraw"
                disabled={disabled}
                onPress={() => {
                  void send({ type: "grant.withdraw", grantId: grant.id });
                }}
              />
            </View>
          ))}
        {LABELS.map(([key, label]) =>
          // A given name has no plural; sentences that would need one avoid it.
          key === "coordinatorPlural" && nameKind === "given" ? null : (
            <Fragment key={key}>
              <Field
                label={label}
                value={labels[key] ?? config.labels[key]}
                onChange={(value) => setLabels({ ...labels, [key]: value })}
              />
              {key === "coordinatorSingular" ? (
                <SegmentedControl
                  options={[
                    { value: "role", label: "Role (the Conductor)" },
                    { value: "given", label: "Given name (Claudia)" },
                  ]}
                  selected={nameKind}
                  onSelect={(kind) =>
                    setLabels({
                      ...labels,
                      coordinatorNameKind: kind,
                      // A given name hides the plural, so it keeps the stored one.
                      ...(kind === "given" && {
                        coordinatorPlural: config.labels.coordinatorPlural,
                      }),
                    })
                  }
                />
              ) : null}
            </Fragment>
          ),
        )}
        <Button
          label="Save titles"
          disabled={disabled || LABELS.some(([key]) => !(labels[key] ?? config.labels[key]).trim())}
          onPress={() => {
            void configure({ labels: { ...config.labels, ...labels } });
          }}
        />
        <Button
          label="Restore default titles"
          disabled={disabled}
          onPress={() => {
            setLabels(DEFAULT_COORDINATOR_LABELS);
            void configure({ labels: DEFAULT_COORDINATOR_LABELS });
          }}
        />
        <Text>
          {config.labels.coordinatorSingular} project:{" "}
          {data.projects?.find((project) => project.id === config.coordinatorProjectId)?.title ??
            "Not selected"}
        </Text>
        {data.projects?.map((project) => (
          <Button
            key={project.id}
            label={project.title}
            disabled={disabled}
            onPress={() => {
              void configure({ coordinatorProjectId: project.id });
            }}
          />
        ))}
        <Text>Choose a provider</Text>
        {serverConfig?.providers.map((item) => (
          <Button
            key={item.instanceId}
            label={item.displayName ?? item.instanceId}
            disabled={disabled}
            onPress={() => {
              setProvider(item.instanceId);
              setModel("");
            }}
          />
        ))}
        <Field label="Provider instance" value={provider} onChange={setProvider} />
        {serverConfig?.providers
          .find((item) => item.instanceId === provider)
          ?.models.map((item) => (
            <Button
              key={item.slug}
              label={
                data.fleetPassed?.includes(item.slug)
                  ? `${item.name} · passed the fleet eval`
                  : item.name
              }
              disabled={disabled}
              onPress={() => setModel(item.slug)}
            />
          ))}
        <Field
          label={`${config.labels.coordinatorSingular} model`}
          value={model}
          onChange={setModel}
        />
        <Button
          label={`Set ${config.labels.coordinatorSingular} model`}
          disabled={disabled || !provider || !model}
          onPress={() => {
            void configure({ coordinatorProvider: provider, coordinatorModel: model });
          }}
        />
        <Text>{capitalizedLabel(config.labels.profilePlural)} and Guild bindings</Text>
        {config.guildBindings?.map((binding) => (
          <View key={binding.id} className="gap-1">
            <Text>
              {binding.guildProvider}/{binding.guildAccount ?? binding.profileId}
            </Text>
            <Field
              label={`${capitalizedLabel(config.labels.profileSingular)} name`}
              value={bindingNames[binding.id] ?? binding.name}
              onChange={(name) => setBindingNames({ ...bindingNames, [binding.id]: name })}
            />
            <Button
              label={`Save ${config.labels.profileSingular} name`}
              disabled={
                disabled ||
                !bindingNames[binding.id]?.trim() ||
                bindingNames[binding.id]!.length > 80
              }
              onPress={() => {
                void configure({
                  guildBindings: config.guildBindings?.map((item) =>
                    item.id === binding.id
                      ? { ...item, name: bindingNames[binding.id]!.trim() }
                      : item,
                  ),
                });
              }}
            />
            <Button
              label="Remove binding"
              disabled={disabled}
              onPress={() => {
                void configure({
                  guildBindings:
                    config.guildBindings?.filter((item) => item.id !== binding.id) ?? [],
                });
              }}
            />
          </View>
        ))}
        <Field
          label={`${capitalizedLabel(config.labels.profileSingular)} name`}
          value={bindingName}
          onChange={setBindingName}
        />
        <Field label="Guild provider" value={guildProvider} onChange={setGuildProvider} />
        <Field label="Guild account" value={guildAccount} onChange={setGuildAccount} />
        <Field label="Guild profile" value={profileId} onChange={setProfileId} />
        <Field
          label="Local capacity template model (optional)"
          value={capacityModel}
          onChange={setCapacityModel}
        />
        <Text>
          The capacity template accounts for an unregistered manual model without changing the
          selected model.
        </Text>
        <Text>Optional Codex cloud binding: complete all fields or leave them blank.</Text>
        {(
          [
            ["projectId", "Cloud project ID"],
            ["guildModel", "Guild model"],
            ["repository", "Repository"],
            ["environment", "Cloud environment"],
            ["branch", "Branch"],
            ["head", "Head"],
            ["base", "Base"],
          ] as const
        ).map(([key, label]) => (
          <Field
            key={key}
            label={label}
            value={cloud[key]}
            onChange={(value) => setCloud({ ...cloud, [key]: value })}
          />
        ))}
        <Button
          label={`Add ${config.labels.profileSingular} binding`}
          disabled={
            disabled ||
            !bindingName.trim() ||
            !provider.trim() ||
            !guildProvider.trim() ||
            (!guildAccount.trim() && !profileId.trim()) ||
            (Object.values(cloud).some(Boolean) && !Object.values(cloud).every(Boolean))
          }
          onPress={() => {
            void configure({
              guildBindings: [
                ...(config.guildBindings ?? []),
                {
                  id: uuidv4(),
                  name: bindingName.trim(),
                  providerInstanceId: provider,
                  guildProvider,
                  guildAccount: guildAccount || null,
                  profileId: profileId || null,
                  environmentId: null,
                  ...(capacityModel.trim() ? { guildModel: capacityModel.trim() } : {}),
                  ...(Object.values(cloud).every(Boolean)
                    ? { cloud: { ...cloud, destination: "cloud:codex" } }
                    : {}),
                },
              ],
            });
          }}
        />
        <Button
          label={
            config.allowUnverifiedCloudModels
              ? "Disallow provider-selected cloud models"
              : "Allow provider-selected cloud models"
          }
          disabled={disabled}
          onPress={() => {
            void configure({ allowUnverifiedCloudModels: !config.allowUnverifiedCloudModels });
          }}
        />
        <Button
          label={
            config.manageOtherThreads
              ? `Let ${coordinatorInText(config.labels)} manage only threads it started`
              : `Let ${coordinatorInText(config.labels)} manage threads it did not start`
          }
          disabled={disabled}
          onPress={() => {
            void configure({ manageOtherThreads: !config.manageOtherThreads });
          }}
        />
        {data.projects?.map((project) => {
          const manual = config.manualMergeProjects ?? [];
          const off = manual.includes(project.id);
          return (
            <Button
              key={project.id}
              label={
                off
                  ? `Merge reviewed work in ${project.title} automatically`
                  : `Let me merge reviewed work in ${project.title}`
              }
              disabled={disabled}
              onPress={() => {
                void configure({
                  manualMergeProjects: off
                    ? manual.filter((id) => id !== project.id)
                    : [...manual, project.id],
                });
              }}
            />
          );
        })}
        <Field
          label="Check in on unsettled threads every (minutes)"
          value={checkIn ?? String(config.checkInMinutes ?? 15)}
          onChange={setCheckIn}
          disabled={disabled}
        />
        <Button
          label="Save check-in interval"
          disabled={
            disabled ||
            checkIn === null ||
            !(Number(checkIn) >= 1) ||
            !Number.isInteger(Number(checkIn))
          }
          onPress={() => {
            void configure({ checkInMinutes: Number(checkIn) });
            setCheckIn(null);
          }}
        />
        <Text>Permissions: {MODES.find(([mode]) => mode === config.permissionMode)?.[1]}</Text>
        <Text>
          Approve for me can handle routine requests within existing access. Broader or unverifiable
          requests are sent to you.
        </Text>
        {MODES.map(([permissionMode, label]) => (
          <Button
            key={permissionMode}
            label={label}
            disabled={disabled}
            onPress={() => {
              void configure({ permissionMode });
            }}
          />
        ))}
        <PermissionPreview environmentId={environmentId} />
        {config.permissionMode === "custom" && (
          <View className="gap-2">
            <Text>Scope: {scope}</Text>
            {COORDINATOR_PERMISSION_SCOPES.map((value) => (
              <Button key={value} label={value} onPress={() => setScope(value)} />
            ))}
            {scope !== "global" && <Field label="Scope ID" value={scopeId} onChange={setScopeId} />}
            <Text>Maximum access: {maxAccess || "inherit"}</Text>
            {["", "0", "1", "2"].map((value) => (
              <Button
                key={value || "inherit"}
                label={value || "Inherit access"}
                onPress={() => setMaxAccess(value)}
              />
            ))}
            <Button
              label={allowIncrease ? "Disallow access increases" : "Allow access increases"}
              onPress={() => setAllowIncrease(!allowIncrease)}
            />
            <Field
              label="Expiry (ISO date, optional)"
              value={policyExpiry}
              onChange={setPolicyExpiry}
            />
            <Text>Permission category: {category}</Text>
            {COORDINATOR_PERMISSION_CATEGORIES.map((value) => (
              <Button key={value} label={value} onPress={() => setCategory(value)} />
            ))}
            <Text>
              Resource-specific and network rules are unavailable because request details are not
              supported.
            </Text>
            {(["allow", "ask", "deny"] as const).map((value) => (
              <Button
                key={value}
                label={`${ruleEffect === value ? "Selected: " : ""}${value}`}
                disabled={disabled}
                onPress={() => setRuleEffect(value)}
              />
            ))}
            <Button
              label="Add rule"
              disabled={disabled}
              onPress={() =>
                setRules([
                  ...rules,
                  { key: uuidv4(), category, effect: ruleEffect, resource: null },
                ])
              }
            />
            {rules.map((rule) => (
              <View key={rule.key} className="gap-1">
                <Text>
                  {rule.effect}: {rule.category}
                </Text>
                <Button
                  label="Remove rule"
                  disabled={disabled}
                  onPress={() => setRules(rules.filter((item) => item.key !== rule.key))}
                />
              </View>
            ))}
            <Text>Saved policies may overlap; destination restrictions also apply.</Text>
            {data.permissions.map((policy) => (
              <Text key={policy.id}>
                Saved: {policy.mode}, {policy.scope.kind} {policy.scope.id ?? ""}, expires{" "}
                {policy.expiresAt ? new Date(policy.expiresAt).toLocaleString() : "never"}
              </Text>
            ))}
            <Text>
              Draft policy: {scope}
              {scope !== "global" ? ` ${scopeId || "(choose ID)"}` : ""}; maximum access{" "}
              {maxAccess || "inherited"};{" "}
              {allowIncrease ? "access increases allowed" : "no access increases"}; expires{" "}
              {policyExpiry || "never"}. Unmatched requests ask.
            </Text>
            <Button
              label="Save custom permissions"
              disabled={
                disabled ||
                !category ||
                (scope !== "global" && !scopeId.trim()) ||
                (!!policyExpiry && !Number.isFinite(Date.parse(policyExpiry))) ||
                (!!maxAccess && !Number.isInteger(Number(maxAccess)))
              }
              onPress={() => {
                void send({
                  type: "permissions.set",
                  policy: {
                    id: `custom-${scope}-${scopeId || "global"}`,
                    mode: "custom",
                    scope: { kind: scope, id: scope === "global" ? null : scopeId },
                    rules: rules.map(({ key: _, ...rule }) => rule),
                    delegateApproval: true,
                    allowAccessIncrease: allowIncrease,
                    ...(maxAccess ? { maxAccess: Number(maxAccess) } : {}),
                    ...(policyExpiry ? { expiresAt: Date.parse(policyExpiry) } : {}),
                  },
                });
              }}
            />
            <Field label="Preset name" value={presetName} onChange={setPresetName} />
            <Button
              label="Save reusable preset"
              disabled={
                disabled || !presetName.trim() || presetName.trim().length > 80 || !rules.length
              }
              onPress={() => {
                void send({
                  type: "permissions.preset.save",
                  preset: {
                    id: uuidv4(),
                    name: presetName.trim(),
                    rules: rules.map(({ key: _, ...rule }) => rule),
                    delegateApproval: true,
                    allowAccessIncrease: allowIncrease,
                    ...(maxAccess ? { maxAccess: Number(maxAccess) } : {}),
                  },
                });
              }}
            />
            <Text>Saving a preset grants nothing. Apply it explicitly to the selected scope.</Text>
            {(data.permissionPresets ?? []).map((preset) => (
              <View key={preset.id} className="gap-1">
                <Text>{preset.name}</Text>
                <Button
                  label="Apply preset"
                  disabled={disabled || (scope !== "global" && !scopeId.trim())}
                  onPress={() => {
                    void send({
                      type: "permissions.preset.apply",
                      presetId: preset.id,
                      scope: { kind: scope, id: scope === "global" ? null : scopeId },
                    });
                  }}
                />
                <Button
                  label="Delete preset"
                  disabled={disabled}
                  onPress={() => {
                    void send({ type: "permissions.preset.delete", presetId: preset.id });
                  }}
                />
              </View>
            ))}
          </View>
        )}
        <Text>Placement: {config.placement}</Text>
        {(["automatic", "prefer-cloud", "cloud-only", "local-only"] as const).map((placement) => (
          <Button
            key={placement}
            label={placement}
            disabled={disabled}
            onPress={() => {
              void configure({ placement });
            }}
          />
        ))}
        <Field label="What would you like built?" value={purpose} onChange={setPurpose} />
        {Array.from(purpose).length > COORDINATOR_GOAL_PURPOSE_MAX_CHARS && (
          <Text>
            Keep the goal within 4,000 characters; reference a file or thread for longer
            requirements.
          </Text>
        )}
        <Button
          label="Add goal"
          disabled={
            disabled ||
            !purpose.trim() ||
            Array.from(purpose).length > COORDINATOR_GOAL_PURPOSE_MAX_CHARS
          }
          onPress={async () => {
            const submitted = purpose;
            if (
              await send({
                type: "goal.upsert",
                goal: {
                  id: uuidv4(),
                  purpose: submitted.trim(),
                  status: "active",
                  authorizedScope: config.coordinatorProjectId ? [config.coordinatorProjectId] : [],
                },
              })
            )
              setPurpose((current) => (current === submitted ? "" : current));
          }}
        />
        <Button
          label="Check in and coordinate"
          disabled={disabled || !config.enabled || data.pause.active}
          onPress={() => {
            void send({ type: "cycle.run" });
          }}
        />
        <Text>Model override scope: {overrideScopeKind}</Text>
        {OVERRIDE_SCOPES.map((value) => (
          <Button
            key={value}
            label={value}
            disabled={disabled}
            onPress={() => {
              setOverrideScopeKind(value);
              setOverrideTargetId("");
            }}
          />
        ))}
        {overrideScopeKind !== "global" && (
          <Field
            label={
              overrideScopeKind === "project"
                ? "Project ID"
                : overrideScopeKind === "assignment"
                  ? "Assignment ID"
                  : "Thread ID"
            }
            value={overrideTargetId}
            onChange={setOverrideTargetId}
            disabled={disabled}
          />
        )}
        <Text>
          Assignment overrides take precedence over thread, project, then global overrides. Global
          applies to future work. Enter the exact ID for any other scope.
        </Text>
        <Text>Override provider: {overrideProvider || "Leave unchanged"}</Text>
        {serverConfig?.providers.map((item) => (
          <Button
            key={item.instanceId}
            label={item.displayName ?? item.instanceId}
            disabled={disabled}
            onPress={() => setOverrideProvider(item.instanceId)}
          />
        ))}
        <Text>Named Guild binding (optional)</Text>
        {config.guildBindings?.map((binding) => (
          <Button
            key={binding.id}
            label={binding.name}
            disabled={disabled}
            onPress={() => {
              setOverrideBindingSelected(true);
              setOverrideProvider(binding.providerInstanceId);
              setOverrideAccount(binding.guildAccount ?? "");
              setOverrideProfile(binding.profileId ?? "");
            }}
          />
        ))}
        <Field
          label="Override account (optional)"
          value={overrideAccount}
          onChange={setOverrideAccount}
        />
        <Field
          label="Override profile ID (optional)"
          value={overrideProfile}
          onChange={setOverrideProfile}
        />
        {serverConfig?.providers
          .find((item) => item.instanceId === overrideProvider)
          ?.models.map((item) => (
            <Button
              key={item.slug}
              label={item.name}
              disabled={disabled}
              onPress={() => setOverrideModel(item.slug)}
            />
          ))}
        <Field
          label="Override model (optional)"
          value={overrideModel}
          onChange={setOverrideModel}
        />
        <Text>
          Blank fields keep existing selections in this scope. Return to automatic removes only this
          scope&apos;s override; broader overrides still apply.
        </Text>
        <Field label="Reasoning effort" value={effort} onChange={setEffort} />
        <Field label="Destination" value={destination} onChange={setDestination} />
        <Button
          label="Apply manual model override"
          disabled={
            disabled ||
            overrideTargetMissing ||
            (!currentOverride &&
              !overrideProvider &&
              !overrideAccount &&
              !overrideProfile &&
              !overrideModel &&
              !effort &&
              !destination)
          }
          onPress={() => {
            void send({
              type: "override.set",
              override: {
                id: currentOverride?.id ?? uuidv4(),
                scope: overrideScope,
                selection: {
                  ...currentOverride?.selection,
                  ...(overrideProvider ? { provider: overrideProvider } : {}),
                  ...(overrideAccount || overrideBindingSelected
                    ? { account: overrideAccount || null }
                    : {}),
                  ...(overrideProfile || overrideBindingSelected
                    ? { profileId: overrideProfile || null }
                    : {}),
                  ...(overrideModel ? { model: overrideModel } : {}),
                  ...(effort ? { effort } : {}),
                  ...(destination ? { destination } : {}),
                },
              },
            });
          }}
        />
        <Button
          label="Return to automatic routing"
          disabled={disabled || overrideTargetMissing || !currentOverride}
          onPress={() => {
            void send({
              type: "override.set",
              override: {
                id: currentOverride?.id ?? uuidv4(),
                scope: overrideScope,
                selection: {},
              },
            });
          }}
        />
        {(data.permissionRequests ?? []).map((request) => {
          const origin = coordinatorPermissionOrigin(request, data);
          return (
            typeof request.id === "string" && (
              <View key={request.id} className="gap-2">
                <Text>
                  Permission request:{" "}
                  {typeof request.category === "string"
                    ? request.category
                    : "Review requested access"}
                </Text>
                {origin?.detail && (
                  <Text numberOfLines={2} className="text-xs">
                    Reason: {origin.detail}
                  </Text>
                )}
                {origin?.operation ? (
                  <>
                    <Text className="text-xs">
                      {request.category === "command" ? "Command" : "Request"}
                    </Text>
                    <Text selectable className="font-mono text-xs">
                      {origin.operation}
                    </Text>
                  </>
                ) : (
                  <Text className="text-xs">
                    This request doesn't show its whole operation. Review it in its thread to
                    approve it.
                  </Text>
                )}
                {origin && (
                  <>
                    <Text>
                      {origin.thread} · {origin.project}
                    </Text>
                    <Button
                      label="Review in thread"
                      onPress={() =>
                        selectDetail({
                          name: "Thread",
                          params: {
                            environmentId: origin.environmentId,
                            threadId: origin.threadId,
                          },
                        })
                      }
                    />
                  </>
                )}
                {origin?.operation && (
                  <Button
                    label="Approve"
                    disabled={disabled}
                    onPress={() => {
                      void send({
                        type: "permission.respond",
                        requestId: request.id as string,
                        decision: "approve",
                      });
                    }}
                  />
                )}
                <Button
                  label="Deny"
                  disabled={disabled}
                  onPress={() => {
                    void send({
                      type: "permission.respond",
                      requestId: request.id as string,
                      decision: "deny",
                    });
                  }}
                />
              </View>
            )
          );
        })}
        {data.goals.map((goal) => (
          <View key={goal.id} className="gap-1">
            <Text>
              {goal.status ?? "active"}: {goal.purpose}
            </Text>
            <RepairLimitControl
              environmentId={environmentId}
              goal={goal}
              decisions={data.decisions ?? []}
            />
          </View>
        ))}
        {data.cards
          .filter((card) => !card.archived)
          .map((card) => (
            <View key={card.id} className="gap-1">
              <Text>{card.purpose}</Text>
              <Text>
                {card.status}
                {card.stale ? " · stale" : ""}
                {card.blocker ? ` · ${card.blocker}` : ""}
              </Text>
              {card.assignmentId && !card.settled && (
                <Button
                  label="Cancel assignment"
                  disabled={disabled}
                  onPress={() => {
                    void send({ type: "assignment.cancel", assignmentId: card.assignmentId! });
                  }}
                />
              )}
              <Button
                label={card.settled ? "Reopen" : "Settle verified work"}
                disabled={disabled || (!card.settled && !card.verified)}
                onPress={() => {
                  void send({
                    type: card.settled ? "thread.reopen" : "thread.settle",
                    threadId: card.threadId,
                  });
                }}
              />
            </View>
          ))}
        {commandNotice && <Text>{commandNotice}</Text>}
        <Text>Model discovery and eligibility</Text>
        {(data.catalogSources ?? []).map((source) => (
          <View key={source.id} className="gap-1">
            <Text>
              {source.id}:{" "}
              {source.discoverySupported === false
                ? "discovery unsupported"
                : source.refreshing
                  ? "refreshing"
                  : source.stale
                    ? "stale"
                    : source.lastSuccessAt
                      ? "available"
                      : "unknown"}
              ; failures {source.failures ?? 0}; last success{" "}
              {source.lastSuccessAt ? new Date(source.lastSuccessAt).toLocaleString() : "unknown"}
            </Text>
            <Button
              label={
                source.automaticDiscovery === false
                  ? "Enable automatic discovery"
                  : "Disable automatic discovery"
              }
              disabled={disabled || source.discoverySupported === false}
              onPress={() => {
                void send({
                  type: "catalog.source.set",
                  sourceId: source.id,
                  automaticDiscovery: !(source.automaticDiscovery ?? true),
                });
              }}
            />
            <Button
              label={
                source.automaticEligibility === false
                  ? "Enable automatic eligibility"
                  : "Disable automatic eligibility"
              }
              disabled={disabled}
              onPress={() => {
                void send({
                  type: "catalog.source.set",
                  sourceId: source.id,
                  automaticEligibility: !(source.automaticEligibility ?? true),
                });
              }}
            />
          </View>
        ))}
        {data.catalog.map((model) => (
          <View key={model.id} className="gap-1">
            <Text>
              {model.provider} / {model.model}: {model.state}
              {model.stale ? " - stale" : ""}
              {model.compatible ? "" : " - incompatible"}
              {model.accessible ? "" : " - inaccessible"}
              {model.policyAllowed ? "" : " - policy blocked"}
              {model.qualificationVerified ? "" : " - qualification unverified"}
              {model.identityVerified ? "" : " - identity unverified"}
              {model.priceMicros === null ? " - price unknown" : ""}
            </Text>
            {model.evidence.length > 0 && <Text>{model.evidence.join("; ")}</Text>}
            <Button
              label={model.manuallyQuarantined ? "Remove manual quarantine" : "Quarantine model"}
              disabled={disabled}
              onPress={() => {
                void send({
                  type: "catalog.model.set",
                  modelId: model.id,
                  quarantined: !model.manuallyQuarantined,
                });
              }}
            />
          </View>
        ))}
        <Button
          label="Discover models"
          disabled={disabled}
          onPress={() => {
            void send({ type: "catalog.refresh" });
          }}
        />
      </View>
    </SettingsSection>
  );
}

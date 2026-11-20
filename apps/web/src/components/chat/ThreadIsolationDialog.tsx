import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef, ThreadIsolationOverride } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { useNativeFolderPicker } from "~/hooks/useNativeFolderPicker";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "~/hooks/useSettings";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useServerConfigs, useThreadShell } from "~/state/entities";
import { serverEnvironment } from "~/state/server";

import {
  BACKEND_CHOICES,
  ChoiceSelect,
  isFolderField,
  LIST_FIELDS,
  ListEditor,
  NETWORK_CHOICES,
  threadNotIsolatedReason,
  threadStartedUnisolated,
  UNISOLATED_CHOICES,
  useLatestEdit,
  unisolatedChoice,
  withOverride,
} from "../settings/ThreadIsolationPolicyFields";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

/** Which thread has its isolation choices open; the thread menu closes as it opens them. */
const threadIsolationDialogAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("thread-isolation:dialog-thread"),
);

export function openThreadIsolationDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(threadIsolationDialogAtom, threadRef);
}

export function ThreadIsolationDialogHost() {
  const threadRef = useAtomValue(threadIsolationDialogAtom);
  if (threadRef === null) return null;
  return (
    <ThreadIsolationDialog
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      threadRef={threadRef}
      onClose={() => appAtomRegistry.set(threadIsolationDialogAtom, null)}
    />
  );
}

const NO_OVERRIDE: ThreadIsolationOverride = {};

function ThreadIsolationDialog({
  threadRef,
  onClose,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly onClose: () => void;
}) {
  const policy = useEnvironmentSettings(
    threadRef.environmentId,
    (settings) => settings.threadIsolationPolicy,
  );
  const storedOverride = useEnvironmentSettings(
    threadRef.environmentId,
    (settings) => settings.threadIsolationOverrides[threadRef.threadId] ?? NO_OVERRIDE,
  );
  const updateSettings = useUpdateEnvironmentSettings(threadRef.environmentId);
  // The settings write takes a thread's choices whole, so they are written whole.
  const { value: override, edit } = useLatestEdit(storedOverride, (next, _previous, options) =>
    updateSettings(
      {
        threadIsolationOverrides: {
          [threadRef.threadId]: Object.keys(next).length === 0 ? null : next,
        },
      },
      options,
    ),
  );
  const config = useServerConfigs().get(threadRef.environmentId);
  const os = config?.environment.platform.os;
  const shell = useThreadShell(threadRef);
  const driver = useAtomValue(
    serverEnvironment.providersValueAtom(threadRef.environmentId),
    (providers) =>
      providers?.find((provider) => provider.instanceId === shell?.providerInstanceId)?.driver,
  );
  const browseFolder = useNativeFolderPicker(threadRef.environmentId);
  const started = threadStartedUnisolated(config?.threadIsolation, threadRef.threadId);
  const missing = driver === undefined ? undefined : config?.threadIsolation?.partlyKnown?.[driver];
  const notIsolated = threadNotIsolatedReason(
    config?.threadIsolation,
    override.backend ?? policy.backend,
    driver,
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Thread isolation for this thread</DialogTitle>
          <DialogDescription>
            What this thread may reach and receive, in place of the choices in Settings. They apply
            from its next session; a thread cannot change them itself.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {started === undefined ? null : (
            <p className="mb-2 text-sm text-warning-foreground">
              This thread&apos;s last session started without isolation: {started}.
            </p>
          )}
          {notIsolated === undefined || notIsolated === started ? null : (
            <p className="mb-4 text-sm text-warning-foreground">
              With these choices it starts without isolation: {notIsolated}.
            </p>
          )}
          <label className="mb-4 flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Sandbox</span>
            <ChoiceSelect
              choices={BACKEND_CHOICES}
              value={override.backend ?? null}
              inherited={policy.backend}
              disabled={false}
              wide
              label="Sandbox for this thread"
              onChange={(backend) =>
                edit((current) => withOverride(current, "backend", backend ?? undefined))
              }
            />
          </label>
          <label className="mb-4 flex flex-col gap-1.5 text-sm">
            <span className="font-medium">If it cannot be sandboxed</span>
            <ChoiceSelect
              choices={UNISOLATED_CHOICES}
              value={
                override.refuseUnisolated === undefined
                  ? null
                  : unisolatedChoice(override.refuseUnisolated)
              }
              inherited={unisolatedChoice(policy.refuseUnisolated)}
              disabled={false}
              wide
              label="If this thread cannot be sandboxed"
              onChange={(choice) =>
                edit((current) =>
                  withOverride(
                    current,
                    "refuseUnisolated",
                    choice === null ? undefined : choice === "refuse",
                  ),
                )
              }
            />
          </label>
          {os === "windows" ? (
            <p className="mb-4 text-muted-foreground text-sm">
              srt on Windows applies only the defaults below: any other choice stops Claude and
              Codex threads until it is reset here or in Settings.
            </p>
          ) : null}
          <div className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">Network access</span>
              <ChoiceSelect
                choices={NETWORK_CHOICES}
                value={override.network ?? null}
                inherited={policy.network}
                disabled={false}
                wide
                label="Network access for this thread"
                onChange={(network) =>
                  edit((current) => withOverride(current, "network", network ?? undefined))
                }
              />
            </label>
            {LIST_FIELDS.map((field) => (
              <div key={field.key} className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium">{field.title}</span>
                <ListEditor
                  listKey={field.key}
                  entries={override[field.key]}
                  inherited={policy[field.key]}
                  placeholder={field.placeholder}
                  disabled={false}
                  wide
                  label={`${field.title} for this thread`}
                  onBrowse={isFolderField(field.key) ? browseFolder : undefined}
                  onChange={(update, options) =>
                    edit(
                      (current) => withOverride(current, field.key, update(current[field.key])),
                      options,
                    )
                  }
                />
              </div>
            ))}
            {missing === undefined ? null : (
              <p className="text-muted-foreground text-xs">
                T3 Code&apos;s code does not name this agent&apos;s own {missing}: add what it needs
                here or in Settings.
              </p>
            )}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

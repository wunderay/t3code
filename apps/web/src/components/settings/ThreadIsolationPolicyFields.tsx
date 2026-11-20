import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type ThreadIsolationBackendChoice,
  type ThreadIsolationNetwork,
  type ThreadIsolationOverride,
  type ThreadIsolationStatus,
} from "@t3tools/contracts";
import { useRef, useState } from "react";

import { XIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { reconcileSnoozeDraft } from "./SnoozePresetsSettings.logic";
import { Button, InlineButton } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export const NETWORK_CHOICES: ReadonlyArray<{
  readonly value: ThreadIsolationNetwork;
  readonly label: string;
}> = [
  { value: "provider", label: "Provider only" },
  { value: "listed", label: "Common and listed hosts" },
  { value: "any", label: "Any host" },
];

export const BACKEND_CHOICES: ReadonlyArray<{
  readonly value: ThreadIsolationBackendChoice;
  readonly label: string;
}> = [
  { value: "automatic", label: "Automatic (srt, then Docker)" },
  { value: "srt", label: "srt" },
  { value: "docker", label: "Docker" },
];

export type UnisolatedChoice = "start" | "refuse";
export const UNISOLATED_CHOICES: ReadonlyArray<{
  readonly value: UnisolatedChoice;
  readonly label: string;
}> = [
  { value: "start", label: "Start them, marked" },
  { value: "refuse", label: "Refuse them" },
];
export const unisolatedChoice = (refuse: boolean): UnisolatedChoice =>
  refuse ? "refuse" : "start";

/**
 * The status line: the backend threads start under, or why none; and the providers that start
 * without isolation under it, grouped by reason.
 */
export function threadIsolationStatusText(
  status: ThreadIsolationStatus | undefined,
): string | undefined {
  if (status === undefined) return undefined;
  const head =
    status.backend === "srt"
      ? "In use: srt."
      : status.backend === "docker"
        ? `In use: Docker${status.detail ? `, because ${status.detail}` : ""}.`
        : `Threads start without isolation: ${status.detail}.`;
  const groups = new Map<string, Array<string>>();
  for (const [driver, reason] of Object.entries(
    status.backend === null ? {} : status[status.backend].notIsolated,
  )) {
    const name = PROVIDER_DISPLAY_NAMES[driver as ProviderDriverKind] ?? driver;
    groups.set(reason, [...(groups.get(reason) ?? []), name]);
  }
  const without = [...groups].map(([reason, names]) => `${names.join(", ")}: ${reason}`);
  // Threads that did start without isolation, counted by reason.
  const started = new Map<string, number>();
  for (const reason of Object.values(status.threads ?? {})) {
    started.set(reason, (started.get(reason) ?? 0) + 1);
  }
  const threads = [...started].map(
    ([reason, count]) => `${count} ${count === 1 ? "thread" : "threads"}: ${reason}`,
  );
  return [
    head,
    ...(without.length === 0 ? [] : [`Without isolation: ${without.join("; ")}.`]),
    ...(threads.length === 0 ? [] : [`Started without isolation: ${threads.join("; ")}.`]),
  ].join(" ");
}

/** Why this thread's last session started without isolation, if it did. */
export const threadStartedUnisolated = (
  status: ThreadIsolationStatus | undefined,
  threadId: string,
): string | undefined => status?.threads?.[threadId];

/** Why a thread of this provider starts without isolation under this backend choice, if it does. */
export function threadNotIsolatedReason(
  status: ThreadIsolationStatus | undefined,
  choice: ThreadIsolationBackendChoice,
  driver: string | undefined,
): string | undefined {
  if (status === undefined) return undefined;
  const { srt, docker } = status;
  const backend =
    choice === "automatic"
      ? srt.unavailable === undefined
        ? "srt"
        : docker.unavailable === undefined
          ? "docker"
          : null
      : status[choice].unavailable === undefined
        ? choice
        : null;
  if (backend === null) {
    // In the server's words, so a thread's recorded reason and this one read the same.
    return choice === "automatic"
      ? `neither srt nor Docker can be used here: ${srt.unavailable}, and ${docker.unavailable}`
      : `${choice === "srt" ? "srt" : "Docker"} cannot be used here: ${status[choice].unavailable}`;
  }
  return driver === undefined ? undefined : status[backend].notIsolated[driver];
}

export type ListKey = "hosts" | "environment" | "writableFolders" | "readableFolders";

export const LIST_FIELDS: ReadonlyArray<{
  readonly key: ListKey;
  readonly title: string;
  readonly description: string;
  readonly placeholder: string;
}> = [
  {
    key: "hosts",
    title: "Allowed hosts",
    description: "More host:port a thread reaches when network access lists hosts.",
    placeholder: "api.example.com:443",
  },
  {
    key: "environment",
    title: "Environment variables",
    description: "Variables of the server's environment a thread receives besides its sign-in.",
    placeholder: "GITHUB_TOKEN",
  },
  {
    key: "writableFolders",
    title: "Writable folders",
    description: "Folders on this machine a thread may change besides its own.",
    placeholder: "/srv/shared",
  },
  {
    key: "readableFolders",
    title: "Readable folders",
    description: "Folders on this machine a thread may read besides its own.",
    placeholder: "/srv/reference",
  },
];

export const isFolderField = (key: ListKey) =>
  key === "writableFolders" || key === "readableFolders";

/** Hosts and variable names, separated by spaces or commas, which neither may contain. */
const parseNames = (text: string): ReadonlyArray<string> =>
  text
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

/**
 * One list of the isolation policy, edited entry by entry so a folder may hold any character:
 * an entry is added with Enter, on leaving the field or with Browse… (folders), and removed
 * with its ×. For a thread, a list it does not set shows the one in Settings; adding to it
 * starts the thread's own list from that one.
 */
export function ListEditor({
  listKey,
  entries,
  inherited,
  placeholder,
  disabled,
  label,
  wide,
  onBrowse,
  onChange,
}: {
  readonly listKey: ListKey;
  /** Its own entries; undefined: a thread takes `inherited`, the list in Settings. */
  readonly entries: ReadonlyArray<string> | undefined;
  readonly inherited?: ReadonlyArray<string> | undefined;
  readonly placeholder: string;
  readonly disabled: boolean;
  readonly label: string;
  readonly wide?: boolean;
  /** Folders only: the OS-native picker, where the folder is on this machine. */
  readonly onBrowse?: (() => Promise<string | null>) | undefined;
  /**
   * Applies a change to the list as it is when the change lands, not as it was rendered: a
   * folder picked after an entry was added keeps that entry. undefined takes Settings' list.
   */
  readonly onChange: (
    update: (entries: ReadonlyArray<string> | undefined) => ReadonlyArray<string> | undefined,
    options?: { readonly onSaved?: () => void },
  ) => void;
}) {
  const [draft, setDraft] = useState("");
  const [announced, setAnnounced] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const add = (added: ReadonlyArray<string>) => {
    // Announced once saved: a change that fails is not one that happened.
    onChange((current) => withEntries(current, inherited, added) ?? current, {
      onSaved: () => setAnnounced(`Added ${added.join(", ")} to ${label.toLowerCase()}.`),
    });
  };
  const remove = (entry: string) => {
    onChange((current) => current?.filter((other) => other !== entry), {
      onSaved: () => setAnnounced(`Removed ${entry} from ${label.toLowerCase()}.`),
    });
    // Its button is gone; the field that adds keeps the keyboard in the list.
    input.current?.focus();
  };
  const addDraft = () => {
    const added = typedEntries(draft, listKey);
    setDraft("");
    if (added.length > 0) add(added);
  };
  return (
    <div className={cn("flex flex-col gap-1.5", wide ? "w-full" : "w-full sm:w-72")}>
      {entries === undefined && inherited !== undefined ? (
        <p className="text-muted-foreground text-xs">
          As in Settings: {inherited.length === 0 ? "none" : inherited.join(", ")}
        </p>
      ) : null}
      {entries !== undefined && entries.length === 0 && inherited !== undefined ? (
        <p className="text-muted-foreground text-xs">None for this thread.</p>
      ) : null}
      {entries !== undefined && entries.length > 0 ? (
        <ul className="flex flex-wrap gap-1" aria-label={label}>
          {entries.map((entry) => (
            <li
              key={entry}
              className="inline-flex min-w-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs"
            >
              <span className="min-w-0 break-all">{entry}</span>
              <InlineButton
                aria-label={`Remove ${entry}`}
                disabled={disabled}
                onClick={() => remove(entry)}
              >
                <XIcon aria-hidden className="size-3" />
              </InlineButton>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex w-full items-center gap-2">
        <Input
          ref={input}
          size="sm"
          className="w-full"
          value={draft}
          placeholder={placeholder}
          disabled={disabled}
          aria-label={`Add to ${label.toLowerCase()}`}
          onValueChange={(next) => setDraft(next)}
          onBlur={addDraft}
          onKeyDown={(event) => {
            // Enter that confirms an IME composition is not an entry.
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Enter") addDraft();
            // The first Escape drops what is typed; with nothing to drop it reaches the dialog.
            if (event.key === "Escape" && draft !== "") {
              event.stopPropagation();
              setDraft("");
            }
          }}
        />
        {onBrowse === undefined ? null : (
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            aria-label={`Browse for ${label.toLowerCase()}`}
            onClick={() => {
              onBrowse().then(
                (picked) => {
                  if (picked !== null) add([picked]);
                },
                (cause: unknown) =>
                  toastManager.add({
                    type: "error",
                    title: "Could not choose a folder",
                    description: cause instanceof Error ? cause.message : String(cause),
                  }),
              );
            }}
          >
            Browse…
          </Button>
        )}
      </div>
      {inherited === undefined ? null : entries === undefined ? (
        <InlineButton
          tone="muted"
          disabled={disabled}
          onClick={() => onChange((current) => current ?? [...inherited])}
        >
          Set for this thread
        </InlineButton>
      ) : (
        <InlineButton tone="muted" disabled={disabled} onClick={() => onChange(() => undefined)}>
          Use the list in Settings
        </InlineButton>
      )}
      <span aria-live="polite" className="sr-only">
        {announced}
      </span>
    </div>
  );
}

/**
 * A list with entries added, or undefined when nothing changes. A thread taking the list in
 * Settings gets its own, starting from that one, so nothing it had is dropped.
 */
export function withEntries(
  entries: ReadonlyArray<string> | undefined,
  inherited: ReadonlyArray<string> | undefined,
  added: ReadonlyArray<string>,
): ReadonlyArray<string> | undefined {
  const current = entries ?? inherited ?? [];
  const fresh = added.filter(
    (entry, index) => !current.includes(entry) && added.indexOf(entry) === index,
  );
  return fresh.length > 0 || (entries === undefined && inherited !== undefined && added.length > 0)
    ? [...current, ...fresh]
    : undefined;
}

/** What is typed adds: a folder whole, whatever it holds; hosts and names split as listed. */
export const typedEntries = (text: string, key: ListKey): ReadonlyArray<string> =>
  isFolderField(key) ? (text.trim() === "" ? [] : [text.trim()]) : parseNames(text);

/**
 * A stored value edited in steps before the server confirms them, as the snooze options are:
 * each step applies to the draft the last one left; a value from the server that equals a write
 * in flight confirms it and those before it, and any other value replaces the draft; a failed
 * write shows the server's value again.
 */
export function pendingEdits<T>(initial: T) {
  let draft = initial;
  let seen = initial;
  let pending: ReadonlyArray<T> = [];
  return {
    current: () => draft,
    edit: (update: (value: T) => T) => {
      draft = update(draft);
      pending = [...pending, draft];
      return draft;
    },
    receive: (value: T) => {
      if (value === seen) return;
      seen = value;
      const reconciled = reconcileSnoozeDraft(pending, value);
      if (reconciled.adopt) {
        draft = value;
        pending = [];
      } else {
        pending = reconciled.pending;
      }
    },
    fail: () => {
      draft = seen;
      pending = [];
    },
  };
}

/** A stored value edited in steps; see pendingEdits. `save` reports back how the write went. */
export function useLatestEdit<T>(
  value: T,
  save: (
    next: T,
    previous: T,
    options: { readonly onFailed: () => void; readonly onSaved?: () => void },
  ) => void,
) {
  const [edits] = useState(() => pendingEdits(value));
  const [, setVersion] = useState(0);
  edits.receive(value);
  const edit = (
    update: (current: T) => T,
    options?: { readonly onSaved?: (() => void) | undefined },
  ) => {
    const previous = edits.current();
    const next = edits.edit(update);
    setVersion((version) => version + 1);
    save(next, previous, {
      onFailed: () => {
        edits.fail();
        setVersion((version) => version + 1);
      },
      ...(options?.onSaved ? { onSaved: options.onSaved } : {}),
    });
  };
  return { value: edits.current(), edit };
}

/** One of a few choices; for a thread, also "As in Settings" (null) showing the global one. */
export function ChoiceSelect<T extends string>({
  choices,
  value,
  inherited,
  disabled,
  label,
  wide,
  onChange,
}: {
  readonly choices: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  /** null: the thread takes the global choice. */
  readonly value: T | null;
  /** Shown for a thread: the global choice it would take. */
  readonly inherited?: T;
  readonly disabled: boolean;
  readonly label: string;
  readonly wide?: boolean;
  readonly onChange: (value: T | null) => void;
}) {
  const labelOf = (choice: T | null) =>
    choice === null
      ? `As in Settings: ${choices.find((entry) => entry.value === inherited)?.label ?? ""}`
      : (choices.find((entry) => entry.value === choice)?.label ?? choice);
  return (
    <Select
      value={value ?? "inherit"}
      disabled={disabled}
      onValueChange={(next) => {
        if (next === "inherit") onChange(null);
        const choice = choices.find((entry) => entry.value === next);
        if (choice) onChange(choice.value);
      }}
    >
      <SelectTrigger size="sm" className={wide ? "w-full" : "w-full sm:w-72"} aria-label={label}>
        <SelectValue>
          {(selected: string | null) =>
            labelOf(selected === "inherit" || selected === null ? null : (selected as T))
          }
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {inherited !== undefined ? (
          <SelectItem hideIndicator value="inherit">
            {labelOf(null)}
          </SelectItem>
        ) : null}
        {choices.map((choice) => (
          <SelectItem hideIndicator key={choice.value} value={choice.value}>
            {choice.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/** The override with one field set, or cleared to take the global value. */
export function withOverride<K extends keyof ThreadIsolationOverride>(
  override: ThreadIsolationOverride,
  key: K,
  value: ThreadIsolationOverride[K] | undefined,
): ThreadIsolationOverride {
  const next: Record<string, unknown> = { ...override };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next as ThreadIsolationOverride;
}

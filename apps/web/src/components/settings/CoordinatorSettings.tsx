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
  coordinatorFailure,
  coordinatorGuidanceSave,
  coordinatorNeedsOwner,
  coordinatorPermissionOrigin,
  coordinatorRefusal,
} from "@t3tools/client-runtime/state/coordinator";
import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  CoordinatorCommand,
  CoordinatorSnapshot,
  ProjectId,
} from "@t3tools/contracts";
import { workspaceRelativeFilePath } from "@t3tools/shared/path";
import { Link } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import { Fragment, useState } from "react";
import { useNativeFolderPicker } from "../../hooks/useNativeFolderPicker";
import { randomUUID } from "../../lib/utils";
import { coordinatorEnvironment } from "../../state/coordinator";
import { serverEnvironment } from "../../state/server";
import { useProject } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  CoordinatorDashboardSwitch,
  CoordinatorOwnerPanel,
  DangerLifts,
} from "./CoordinatorBoardSettings";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { ListEditor } from "./ThreadIsolationPolicyFields";

type Configuration = CoordinatorSnapshot["configuration"];
type Policy = CoordinatorSnapshot["permissions"][number];

const PERMISSIONS = [
  ["ask", "Ask for me"],
  ["approve", "Approve for me"],
  ["full", "Full approval"],
  ["custom", "Custom permissions"],
] as const;

const OVERRIDE_SCOPES = ["global", "project", "thread", "assignment"] as const;

const LABELS = [
  ["coordinatorSingular", "Name"],
  ["coordinatorPlural", "Plural name"],
  ["threadSingular", "Work thread title"],
  ["threadPlural", "Work thread plural"],
  ["profileSingular", "Agent profile title"],
  ["profilePlural", "Agent profile plural"],
] as const;

/** What the Coordinator's work holds for the owner, at the top of its thread while the rest goes on. */
export function NeedsYou({
  environmentId,
  data,
}: {
  readonly environmentId: EnvironmentId;
  readonly data: CoordinatorSnapshot;
}) {
  const allowed = useAtomValue(coordinatorEnvironment.command.permissionAtom(environmentId));
  const execute = useAtomCommand(coordinatorEnvironment.command);
  const [failure, setFailure] = useState<string | null>(null);
  const items = coordinatorNeedsOwner(data);
  if (items.length === 0) return null;
  const send = (input: CoordinatorCommand) => {
    setFailure(null);
    void execute({ environmentId, input }).then((result) => {
      if (result._tag === "Failure")
        setFailure(coordinatorFailure(Cause.squash(result.cause), data.configuration.labels));
    });
  };
  return (
    <section
      aria-label="Needs you"
      className="max-h-72 shrink-0 space-y-2 overflow-auto border-b border-warning/30 bg-warning-surface px-4 py-3 text-sm"
    >
      <h2 className="font-medium">Needs you · {items.length}</h2>
      {failure && (
        <p role="alert" className="text-destructive">
          {failure}
        </p>
      )}
      {items.map((item) => {
        if (item.kind === "approval") {
          const origin = coordinatorPermissionOrigin(item.request, data);
          return (
            <div key={`approval:${item.id}`} className="space-y-1 rounded border bg-background p-2">
              <p>
                Approval in {origin?.thread ?? "a thread"}: {item.reason}
              </p>
              {origin?.operation && (
                <pre className="max-h-24 overflow-auto font-mono text-xs break-all whitespace-pre-wrap">
                  {origin.operation}
                </pre>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {origin?.operation && (
                  <Button
                    size="sm"
                    disabled={!allowed}
                    onClick={() =>
                      send({ type: "permission.respond", requestId: item.id, decision: "approve" })
                    }
                  >
                    Approve
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!allowed}
                  onClick={() =>
                    send({ type: "permission.respond", requestId: item.id, decision: "deny" })
                  }
                >
                  Deny
                </Button>
                {origin && (
                  <Link
                    className="text-xs"
                    to="/$environmentId/$threadId"
                    params={{ environmentId: origin.environmentId, threadId: origin.threadId }}
                  >
                    Review in thread
                  </Link>
                )}
              </div>
            </div>
          );
        }
        if (item.kind === "grant")
          return (
            <div key={`grant:${item.id}`} className="space-y-1 rounded border bg-background p-2">
              <p>Grant asked for: {item.reason}</p>
              {/* Grant sends this grant as it stands, so all its authority is shown. */}
              <p>
                {describeCoordinatorGrant(
                  item.grant,
                  item.grant.scope.kind === "project"
                    ? data.projects?.find((project) => project.id === item.grant.scope.id)?.title
                    : undefined,
                )}
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={!allowed}
                  onClick={() => send({ type: "grant.set", grant: item.grant })}
                >
                  Grant
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!allowed}
                  onClick={() => send({ type: "grant.dismiss", grantId: item.id })}
                >
                  Dismiss
                </Button>
              </div>
            </div>
          );
        if (item.kind === "merge")
          return (
            <div key={`merge:${item.id}`} className="space-y-1 rounded border bg-background p-2">
              <p>Reviewed and waiting for you to merge: {item.reason}</p>
              {item.canMerge ? (
                <Button
                  size="sm"
                  disabled={!allowed}
                  onClick={() => send({ type: "goal.merge", goalId: item.id })}
                >
                  Merge
                </Button>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Merge it yourself; {coordinatorInText(data.configuration.labels)} sees the merge.
                </p>
              )}
            </div>
          );
        if (item.kind === "budget") {
          const { goalId } = item;
          return (
            <div key={`budget:${item.id}`} className="space-y-1 rounded border bg-background p-2">
              <p>{item.reason}</p>
              {goalId !== undefined && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!allowed}
                  onClick={() =>
                    send({
                      type: "board.budget",
                      target: { goalId },
                      cap: { micros: null, seconds: null },
                    })
                  }
                >
                  Remove cap
                </Button>
              )}
            </div>
          );
        }
        return (
          <div key={`result:${item.id}`} className="space-y-1 rounded border bg-background p-2">
            <p>Finished work held by its result check: {item.reason}</p>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={!allowed}
                onClick={() =>
                  send({ type: "result.accept", assignmentId: item.id, head: item.head })
                }
              >
                Release to merge
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!allowed}
                onClick={() => send({ type: "result.discard", assignmentId: item.id })}
              >
                Discard
              </Button>
            </div>
          </div>
        );
      })}
    </section>
  );
}

export function ThreadPermissions({
  environmentId,
  threadId,
  labels,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly labels: Configuration["labels"];
}) {
  const allowed = useAtomValue(coordinatorEnvironment.command.permissionAtom(environmentId));
  const execute = useAtomCommand(coordinatorEnvironment.command);
  const [mode, setMode] = useState<Policy["mode"]>("ask");
  const [category, setCategory] = useState("file-read");
  const [effect, setEffect] = useState<"ask" | "allow" | "deny">("ask");
  const [expiry, setExpiry] = useState("");
  const [notice, setNotice] = useState("");
  return (
    <details className="border-b px-3 py-2 text-sm">
      <summary>{labels.coordinatorSingular} permissions for this thread</summary>
      <div className="flex flex-wrap items-end gap-2">
        <label>
          Mode
          <select value={mode} onChange={(event) => setMode(event.target.value as Policy["mode"])}>
            {PERMISSIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <p>
          Approve for me can handle routine requests within existing access; broader or unverifiable
          requests are sent to you.
        </p>
        {mode === "custom" && (
          <>
            <label>
              Category
              <select value={category} onChange={(event) => setCategory(event.target.value)}>
                {COORDINATOR_PERMISSION_CATEGORIES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <p>
              Resource-specific and network rules are unavailable because request details are not
              supported.
            </p>
            <label>
              Decision
              <select
                value={effect}
                onChange={(event) => setEffect(event.target.value as typeof effect)}
              >
                <option value="ask">Ask</option>
                <option value="allow">Allow</option>
                <option value="deny">Deny</option>
              </select>
            </label>
          </>
        )}
        <label>
          Expires
          <Input
            type="datetime-local"
            value={expiry}
            onChange={(event) => setExpiry(event.target.value)}
          />
        </label>
        <Button
          size="sm"
          disabled={!allowed || (mode === "custom" && !category.trim())}
          onClick={async () => {
            const result = await execute({
              environmentId,
              input: {
                type: "permissions.set",
                policy: {
                  id: `thread-${threadId}`,
                  mode,
                  scope: { kind: "thread", id: threadId },
                  ...(mode === "custom" ? { rules: [{ category, effect, resource: null }] } : {}),
                  ...(expiry ? { expiresAt: new Date(expiry).getTime() } : {}),
                },
              },
            });
            setNotice(result._tag === "Success" ? "Saved." : "Could not save permissions.");
          }}
        >
          Save
        </Button>
        {notice && <span role="status">{notice}</span>}
      </div>
    </details>
  );
}

function RepairLimitControl({
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
    <div className="space-y-2 text-sm">
      <p role="status">{decision.summary}</p>
      <Button
        size="sm"
        disabled={!allowed || pending || goal.revision === undefined}
        onClick={async () => {
          if (goal.revision === undefined) return;
          setPending(true);
          try {
            const result = await execute({
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
            });
            setNotice(
              result._tag === "Success"
                ? "Additional repairs allowed."
                : "Could not allow additional repairs.",
            );
          } catch {
            setNotice("Could not allow additional repairs.");
          }
          setPending(false);
        }}
      >
        Allow 3 more repairs
      </Button>
      {goal.revision === undefined && (
        <p role="status">Reload the goal before allowing more repairs.</p>
      )}
      {notice && <p role="status">{notice}</p>}
    </div>
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
  const [requested, setRequested] = useState("unknown");
  const [preview, setPreview] = useState<CoordinatorSnapshot["permissionPreview"]>(undefined);
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  return (
    <details className="space-y-2 text-sm">
      <summary>Hypothetical policy preview</summary>
      <p>
        Evaluates saved policy for the selected scope and request bounds; it does not change
        permissions or represent a live request.
      </p>
      <label>
        Scope{" "}
        <select
          disabled={pending}
          value={scope}
          onChange={(event) => {
            setScope(event.target.value as typeof scope);
            setPreview(undefined);
          }}
        >
          {COORDINATOR_PERMISSION_SCOPES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      {scope !== "global" && (
        <label>
          Scope ID{" "}
          <Input
            disabled={pending}
            value={scopeId}
            onChange={(event) => {
              setScopeId(event.target.value);
              setPreview(undefined);
            }}
          />
        </label>
      )}
      <label>
        Category{" "}
        <select
          disabled={pending}
          value={category}
          onChange={(event) => {
            setCategory(event.target.value);
            setPreview(undefined);
          }}
        >
          {COORDINATOR_PERMISSION_CATEGORIES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <label>
        Current access{" "}
        <select
          disabled={pending}
          value={current}
          onChange={(event) => {
            setCurrent(Number(event.target.value) as 0 | 1 | 2);
            setPreview(undefined);
          }}
        >
          {[0, 1, 2].map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <label>
        Requested access{" "}
        <select
          disabled={pending}
          value={requested}
          onChange={(event) => {
            setRequested(event.target.value);
            setPreview(undefined);
          }}
        >
          <option value="unknown">Unknown</option>
          {[0, 1, 2].map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <Button
        type="button"
        disabled={!allowed || pending || (scope !== "global" && !scopeId.trim())}
        onClick={async () => {
          setPending(true);
          setPreview(undefined);
          try {
            const result = await execute({
              environmentId,
              input: {
                type: "permissions.preview",
                scope: { kind: scope, id: scope === "global" ? null : scopeId },
                category,
                currentAccess: current,
                ...(requested === "unknown"
                  ? {}
                  : { requestedAccess: Number(requested) as 0 | 1 | 2 }),
              },
            });
            if (result._tag === "Success" && result.value.permissionPreview) {
              setPreview(result.value.permissionPreview);
              setNotice("");
            } else setNotice("Could not evaluate policy.");
          } catch {
            setNotice("Could not evaluate policy.");
          }
          setPending(false);
        }}
      >
        Preview saved policy
      </Button>
      {preview && (
        <p role="status">
          Hypothetical result: {preview.effect}. {preview.reason ?? ""} Maximum access{" "}
          {preview.maxAccess}; policies {preview.policyIds.join(", ") || "none"}; revision{" "}
          {preview.policyRevision}
          {preview.accessIncreaseUnknown ? "; requested access unknown" : ""}.
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </details>
  );
}

function GuidanceEditor({
  environmentId,
  threadId,
  guidance,
  labels,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly guidance: CoordinatorSnapshot["guidance"];
  readonly labels: Configuration["labels"];
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
    <details className="space-y-2 text-sm">
      <summary>Custom prompt and memory</summary>
      <p>
        These notes guide {coordinatorInText(labels)}. They do not grant access or override model
        and destination pins.
      </p>
      <label className="block">
        Custom prompt (Markdown)
        <textarea
          className="block min-h-24 w-full rounded border p-2"
          value={prompt}
          onChange={(event) => changePrompt(event.target.value)}
        />
      </label>
      <Button type="button" variant="outline" size="sm" onClick={() => changePrompt("")}>
        Clear prompt draft
      </Button>
      <label className="block">
        Memory (Markdown)
        <textarea
          className="block min-h-24 w-full rounded border p-2"
          value={memory}
          onChange={(event) => changeMemory(event.target.value)}
        />
      </label>
      <Button type="button" variant="outline" size="sm" onClick={() => changeMemory("")}>
        Clear memory draft
      </Button>
      <label className="block">
        {labels.coordinatorSingular} notes
        <textarea
          className="block min-h-24 w-full rounded border p-2"
          value={notes}
          onChange={(event) => changeNotes(event.target.value)}
        />
      </label>
      <p>
        {coordinatorInText(labels, true)} writes these notes itself: lasting facts and corrections
        about you and your projects. Each change it makes is listed in its decisions. Edit or clear
        them here; they are saved with the prompt and memory.
      </p>
      <Button type="button" variant="outline" size="sm" onClick={() => changeNotes("")}>
        Clear notes draft
      </Button>
      <p>
        {Array.from(notes).length}/{COORDINATOR_NOTES_MAX_CHARS} notes characters.{" "}
        {Array.from(prompt).length}/{COORDINATOR_GUIDANCE_MAX_CHARS} prompt characters;{" "}
        {Array.from(memory).length}/{COORDINATOR_GUIDANCE_MAX_CHARS} memory characters; serialized
        total {serializedLength}/{COORDINATOR_GUIDANCE_MAX_CHARS}. Clear a draft and save to remove
        stored text.
      </p>
      {tooLong && (
        <p role="alert">
          The serialized total and each field must be within {COORDINATOR_GUIDANCE_MAX_CHARS}{" "}
          characters, the notes within {COORDINATOR_NOTES_MAX_CHARS}. Your draft is preserved.
        </p>
      )}
      <Button
        type="button"
        disabled={!allowed || pending || tooLong}
        onClick={async () => {
          setPending(true);
          try {
            const result = await execute({
              environmentId,
              input: coordinatorGuidanceSave(threadId, prompt, memory, notesDraft),
            });
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
          } catch {
            setNotice(`Could not save. Check ${coordinatorInText(labels)} and the context budget.`);
          }
          setPending(false);
        }}
      >
        Save prompt and memory
      </Button>
      {notice && <p role="status">{notice}</p>}
    </details>
  );
}

export function PauseControl({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { data } = useEnvironmentQuery(
    coordinatorEnvironment.snapshot({ environmentId, input: {} }),
  );
  const allowed = useAtomValue(coordinatorEnvironment.command.permissionAtom(environmentId));
  const command = useAtomCommand(coordinatorEnvironment.command);
  const [pending, setPending] = useState(false);
  if (!data?.configuration.enabled) return null;
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2">
      <Link
        to="/$environmentId/$threadId"
        params={{ environmentId, threadId: data.configuration.coordinatorThreadId ?? "" }}
        className="truncate text-xs"
      >
        {coordinatorName(data.configuration)}
      </Link>
      <Button
        size="sm"
        variant="outline"
        disabled={!allowed || pending}
        onClick={async () => {
          setPending(true);
          await command({
            environmentId,
            input: { type: data.pause.active ? "resume.all" : "pause.all" },
          }).finally(() => {
            setPending(false);
          });
        }}
      >
        {data.pause.active ? "Resume all" : "Pause all"}
      </Button>
    </div>
  );
}

const NO_GRANT = {
  projectId: "",
  folders: [] as ReadonlyArray<string>,
  access: "1",
  expires: "",
  lifts: [] as ReadonlyArray<string>,
};
/** The grants in force, each withdrawable, and a form to make one. */
export function Grants({
  environmentId,
  data,
  disabled,
  send,
}: {
  readonly environmentId: EnvironmentId;
  readonly data: CoordinatorSnapshot;
  readonly disabled: boolean;
  readonly send: (input: CoordinatorCommand) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(NO_GRANT);
  const grants = data.grants ?? [];
  const projectTitle = (id: string | null) =>
    data.projects?.find((project) => project.id === id)?.title;
  const expiresAt = draft.expires ? Date.parse(draft.expires) : null;
  const root = useProject(
    draft.projectId ? { environmentId, projectId: draft.projectId as ProjectId } : null,
  )?.workspaceRoot;
  const pickFolder = useNativeFolderPicker(environmentId);
  return (
    <fieldset disabled={disabled} className="space-y-2">
      <legend className="mb-1 text-sm font-medium">Grants · {grants.length}</legend>
      <p className="text-xs text-muted-foreground">
        Where the threads {coordinatorInText(data.configuration.labels)} starts may work, what they
        may delete, and their access. Folders and files are relative to the project.
      </p>
      {grants.map((grant) => (
        <div key={grant.id} className="flex items-center justify-between gap-3 text-sm">
          <span className="min-w-0 break-words">
            {describeCoordinatorGrant(
              grant,
              grant.scope.kind === "project" ? projectTitle(grant.scope.id) : undefined,
            )}
            {grant.sourceMessageId ? " · from your message" : ""}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void send({ type: "grant.withdraw", grantId: grant.id });
            }}
          >
            Withdraw
          </Button>
        </div>
      ))}
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          Project
          <select
            className="block w-full rounded border p-2"
            value={draft.projectId}
            onChange={(event) => setDraft({ ...draft, projectId: event.target.value })}
          >
            <option value="">Choose a project</option>
            {data.projects?.map((project) => (
              <option key={project.id} value={project.id}>
                {project.title}
              </option>
            ))}
          </select>
        </label>
        <div className="space-y-1 text-sm">
          Folders it may create, edit and delete in; the project folder is the whole project
          <ListEditor
            listKey="writableFolders"
            entries={draft.folders}
            placeholder="A folder in the project"
            disabled={disabled}
            label="Granted folders"
            wide
            onBrowse={
              pickFolder &&
              (async () => {
                const picked = await pickFolder();
                if (picked === null) return null;
                const folder = workspaceRelativeFilePath(picked, root);
                if (folder === null)
                  throw new Error(
                    root
                      ? `${picked} is outside the project folder ${root}.`
                      : "Choose a project first.",
                  );
                return folder;
              })
            }
            onChange={(update, options) => {
              setDraft((current) => ({ ...current, folders: update(current.folders) ?? [] }));
              options?.onSaved?.();
            }}
          />
        </div>
        <label className="space-y-1 text-sm">
          Access
          <select
            className="block w-full rounded border p-2"
            value={draft.access}
            onChange={(event) => setDraft({ ...draft, access: event.target.value })}
          >
            <option value="0">Read only</option>
            <option value="1">Edits and commands in its worktree</option>
            <option value="2">Full access</option>
          </select>
        </label>
        <label className="space-y-1 text-sm">
          Expires (optional)
          <Input
            type="datetime-local"
            value={draft.expires}
            onChange={(event) => setDraft({ ...draft, expires: event.target.value })}
          />
        </label>
      </div>
      <DangerLifts
        environmentId={environmentId}
        lifts={draft.lifts}
        onChange={(lifts) => setDraft({ ...draft, lifts })}
      />
      <Button
        size="sm"
        disabled={
          !draft.projectId ||
          draft.folders.length === 0 ||
          (expiresAt !== null && !Number.isFinite(expiresAt))
        }
        onClick={async () => {
          const made = await send({
            type: "grant.set",
            grant: {
              id: randomUUID(),
              scope: { kind: "project", id: draft.projectId },
              folders: draft.folders,
              delete: draft.folders,
              maxAccess: Number(draft.access) as 0 | 1 | 2,
              lifts: draft.lifts,
              expiresAt,
            },
          });
          if (made) setDraft(NO_GRANT);
        }}
      >
        Make grant
      </Button>
    </fieldset>
  );
}

export function CoordinatorSettings() {
  const { environment, scope } = useSettingsScope();
  if (scope.kind !== "environment" || !environment) {
    return (
      <SettingsSection id="coordinator" title={DEFAULT_COORDINATOR_LABELS.coordinatorSingular}>
        <div className="space-y-3">
          <p>Choose one environment to manage {coordinatorInText(DEFAULT_COORDINATOR_LABELS)}.</p>
          <CoordinatorDashboardSwitch labels={DEFAULT_COORDINATOR_LABELS} />
        </div>
      </SettingsSection>
    );
  }
  return (
    <CoordinatorForm key={environment.environmentId} environmentId={environment.environmentId} />
  );
}

export function CoordinatorForm({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const { data, error, isPending } = useEnvironmentQuery(
    coordinatorEnvironment.snapshot({ environmentId, input: {} }),
  );
  const allowed = useAtomValue(coordinatorEnvironment.command.permissionAtom(environmentId));
  const execute = useAtomCommand(coordinatorEnvironment.command);
  const [pending, setPending] = useState(false);
  const [purpose, setPurpose] = useState("");
  const [draft, setDraft] = useState<Partial<Configuration>>({});
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [destination, setDestination] = useState("");
  const [overrideScopeKind, setOverrideScopeKind] =
    useState<(typeof OVERRIDE_SCOPES)[number]>("global");
  const [overrideTargetId, setOverrideTargetId] = useState("");
  const [overrideProvider, setOverrideProvider] = useState("");
  const [overrideBindingSelected, setOverrideBindingSelected] = useState(false);
  const [overrideAccount, setOverrideAccount] = useState("");
  const [overrideProfile, setOverrideProfile] = useState("");
  const [rules, setRules] = useState<
    Array<NonNullable<Policy["rules"]>[number] & { readonly key: string }>
  >([]);
  const [presetName, setPresetName] = useState("");
  const [category, setCategory] = useState("file-read");
  const [ruleEffect, setRuleEffect] = useState<"allow" | "ask" | "deny">("ask");
  const [notice, setNotice] = useState<string | null>(null);
  const [bindingName, setBindingName] = useState("");
  const [bindingProvider, setBindingProvider] = useState("");
  const [bindingGuildProvider, setBindingGuildProvider] = useState("codex");
  const [bindingAccount, setBindingAccount] = useState("");
  const [bindingProfile, setBindingProfile] = useState("");
  const [bindingCapacityModel, setBindingCapacityModel] = useState("");
  const [cloud, setCloud] = useState({
    projectId: "",
    guildModel: "",
    repository: "",
    environment: "",
    branch: "",
    head: "",
    base: "",
  });
  const [policyScope, setPolicyScope] = useState<Policy["scope"]["kind"]>("global");
  const [policyId, setPolicyId] = useState("");
  const [policyExpiry, setPolicyExpiry] = useState("");
  const [maxAccess, setMaxAccess] = useState("");
  const [allowIncrease, setAllowIncrease] = useState(false);
  const send = async (input: CoordinatorCommand) => {
    setPending(true);
    setNotice(null);
    const result = await execute({ environmentId, input }).finally(() => {
      setPending(false);
    });
    if (result._tag === "Success") {
      setNotice(
        input.type === "stop.all" || input.type === "assignment.cancel"
          ? "Cancellation requested; check destination status."
          : "Saved.",
      );
      return true;
    }
    setNotice(
      coordinatorRefusal(
        Cause.squash(result.cause),
        data?.configuration.labels ?? DEFAULT_COORDINATOR_LABELS,
      ) ?? "Could not save changes.",
    );
    return false;
  };
  const disabled = !allowed || pending;
  if (data === null) {
    return (
      <SettingsSection id="coordinator" title={DEFAULT_COORDINATOR_LABELS.coordinatorSingular}>
        <p role="status">
          {error ??
            (isPending
              ? `Loading ${coordinatorInText(DEFAULT_COORDINATOR_LABELS)}…`
              : `${coordinatorInText(DEFAULT_COORDINATOR_LABELS, true)} is unavailable.`)}
        </p>
      </SettingsSection>
    );
  }
  const config = { ...data.configuration, ...draft };
  const overrideScope = {
    kind: overrideScopeKind,
    id: overrideScopeKind === "global" ? null : overrideTargetId.trim(),
  };
  const overrideTargetMissing = overrideScope.kind !== "global" && !overrideScope.id;
  const currentOverride = data.overrides.find(
    (item) => item.scope.kind === overrideScope.kind && item.scope.id === overrideScope.id,
  );
  const labels = config.labels;
  const providers = serverConfig?.providers ?? [];
  const selectedProvider = providers.find(
    (provider) => provider.instanceId === config.coordinatorProvider,
  );
  const availabilityLine = coordinatorAvailabilityLine(
    data.availability,
    `${coordinatorInText(labels, true)} can't run on this environment.`,
  );
  return (
    <SettingsSection id="coordinator" title={labels.coordinatorSingular}>
      <div className="space-y-5">
        {data.configuration.coordinatorThreadId && (
          <GuidanceEditor
            key={`${environmentId}:${data.configuration.coordinatorThreadId}`}
            environmentId={environmentId}
            threadId={data.configuration.coordinatorThreadId}
            guidance={data.guidance}
            labels={labels}
          />
        )}
        <p className="text-sm text-muted-foreground">
          Describe the outcome you want. {coordinatorInText(labels, true)} delegates research,
          building, and review while you retain direct control of every work thread.
        </p>
        {availabilityLine && <p role="status">{availabilityLine}</p>}
        <div className="flex flex-wrap items-center gap-3">
          <Switch
            aria-label={`Enable ${labels.coordinatorSingular}`}
            checked={data.configuration.enabled}
            disabled={disabled}
            onCheckedChange={(enabled) => {
              void send({ type: "configure", configuration: { enabled: Boolean(enabled) } });
            }}
          />
          <span>Enable {labels.coordinatorSingular}</span>
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => {
              void send({ type: data.pause.active ? "resume.all" : "pause.all" });
            }}
          >
            {data.pause.active ? "Resume all" : "Pause all"}
          </Button>
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => {
              void send({
                type: "configure",
                configuration: { coordinatorPaused: !data.configuration.coordinatorPaused },
              });
            }}
          >
            {data.configuration.coordinatorPaused ? "Resume" : "Pause"} {labels.coordinatorSingular}
          </Button>
        </div>
        <Button
          variant="outline"
          disabled={disabled}
          onClick={() => {
            void send({ type: "stop.all" });
          }}
        >
          Stop all supervised work
        </Button>
        <p className="text-xs text-muted-foreground">
          Stop requests cancellation; cloud or unreachable work may remain running until confirmed.
          Pause keeps work resumable where supported.
        </p>
        <p className="text-xs text-muted-foreground">
          A group pause blocks new assignments and requests interruption of running work.
          Unreachable or unsupported destinations remain visible below.
        </p>
        <CoordinatorDashboardSwitch labels={labels} />
        <CoordinatorOwnerPanel
          environmentId={environmentId}
          projects={data.projects ?? []}
          disabled={disabled}
          off={!data.configuration.enabled}
          labels={labels}
        />
        {data.configuration.enabled && (
          <Grants environmentId={environmentId} data={data} disabled={disabled} send={send} />
        )}
        <fieldset disabled={disabled} className="space-y-3">
          <legend className="mb-2 text-sm font-medium">
            {labels.coordinatorSingular} and routing
          </legend>
          <label className="block space-y-1 text-sm">
            Project
            <select
              className="block w-full rounded border p-2"
              value={config.coordinatorProjectId ?? ""}
              onChange={(event) =>
                setDraft({ ...draft, coordinatorProjectId: event.target.value || null })
              }
            >
              <option value="">Choose a project</option>
              {data.projects?.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.title}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1 text-sm">
            Provider
            <select
              className="block w-full rounded border p-2"
              value={config.coordinatorProvider ?? ""}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  coordinatorProvider: event.target.value || null,
                  coordinatorModel: null,
                })
              }
            >
              <option value="">Choose a provider</option>
              {providers.map((provider) => (
                <option key={provider.instanceId} value={provider.instanceId}>
                  {provider.displayName ?? provider.instanceId}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1 text-sm">
            {labels.coordinatorSingular} model
            <Input
              list={`coordinator-models-${environmentId}`}
              value={config.coordinatorModel ?? ""}
              onChange={(event) =>
                setDraft({ ...draft, coordinatorModel: event.target.value || null })
              }
            />
            <datalist id={`coordinator-models-${environmentId}`}>
              {selectedProvider?.models.map((model) => (
                <option key={model.slug} value={model.slug}>
                  {data.fleetPassed?.includes(model.slug)
                    ? `${model.name} · passed the fleet eval`
                    : model.name}
                </option>
              ))}
            </datalist>
          </label>
          <label className="block space-y-1 text-sm">
            Placement
            <select
              className="block w-full rounded border p-2"
              value={config.placement}
              onChange={(event) =>
                setDraft({ ...draft, placement: event.target.value as Configuration["placement"] })
              }
            >
              <option value="automatic">Automatic</option>
              <option value="prefer-cloud">Prefer cloud</option>
              <option value="cloud-only">Cloud only</option>
              <option value="local-only">Local only</option>
            </select>
          </label>
          <label className="block space-y-1 text-sm">
            Permissions
            <select
              className="block w-full rounded border p-2"
              value={config.permissionMode}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  permissionMode: event.target.value as Configuration["permissionMode"],
                })
              }
            >
              {PERMISSIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <p className="text-xs text-muted-foreground">
            Approve for me can handle routine requests within existing access. Broader or
            unverifiable requests are sent to you.
          </p>
          <label className="flex items-center gap-2 text-sm">
            <Switch
              aria-label="Allow provider-selected cloud models"
              checked={config.allowUnverifiedCloudModels ?? false}
              onCheckedChange={(checked) =>
                setDraft({ ...draft, allowUnverifiedCloudModels: Boolean(checked) })
              }
            />
            Allow provider-selected cloud models
          </label>
          <p className="text-xs text-muted-foreground">
            Some native cloud services choose their own model and cannot pause individual tasks.
            Exact model pins remain enforced; unsupported destinations report their limits.
          </p>
          <label className="flex items-center gap-2 text-sm">
            <Switch
              aria-label={`${coordinatorInText(labels, true)} may manage threads it did not start`}
              checked={config.manageOtherThreads ?? false}
              onCheckedChange={(checked) =>
                setDraft({ ...draft, manageOtherThreads: Boolean(checked) })
              }
            />
            {coordinatorInText(labels, true)} may manage threads it did not start
          </label>
          <p className="text-xs text-muted-foreground">
            Off, it changes only the threads it started. On, it may change any thread inside a
            goal's scope.
          </p>
          {data.projects?.map((project) => {
            const manual = config.manualMergeProjects ?? [];
            return (
              <label key={project.id} className="flex items-center gap-2 text-sm">
                <Switch
                  aria-label={`Merge reviewed work automatically in ${project.title}`}
                  checked={!manual.includes(project.id)}
                  onCheckedChange={(checked) =>
                    setDraft({
                      ...draft,
                      manualMergeProjects: checked
                        ? manual.filter((id) => id !== project.id)
                        : [...manual, project.id],
                    })
                  }
                />
                Merge reviewed work automatically in {project.title}
              </label>
            );
          })}
          <p className="text-xs text-muted-foreground">
            Off, a change that passed review waits for you under Needs you.
          </p>
          <label className="block space-y-1 text-sm">
            Check in on unsettled threads every (minutes)
            <Input
              type="number"
              min={1}
              step={1}
              value={config.checkInMinutes ?? 15}
              onChange={(event) => {
                const minutes = Number(event.target.value);
                if (Number.isInteger(minutes) && minutes >= 1)
                  setDraft({ ...draft, checkInMinutes: minutes });
              }}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            Besides waking it when something changes, the host sends {coordinatorInText(labels)} one
            digest of every unsettled thread at least this often.
          </p>
          <label className="block space-y-1 text-sm">
            Free the slot of work waiting on you after (minutes)
            <Input
              type="number"
              min={1}
              step={1}
              value={config.parkMinutes ?? 30}
              onChange={(event) => {
                const minutes = Number(event.target.value);
                if (Number.isInteger(minutes) && minutes >= 1)
                  setDraft({ ...draft, parkMinutes: minutes });
              }}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            The work stays parked, never answered for you, and carries on when you answer it.
          </p>
          <p role="status" className="text-xs">
            {data.configuration.threadProof?.proved
              ? `Working: its first turn asked for its status on ${data.configuration.threadProof.provider} ${data.configuration.threadProof.model}.`
              : data.configuration.threadProof
                ? `Not working: ${data.configuration.threadProof.reason ?? "it has no T3 tools."}`
                : "Not proved yet: its first turn must ask for its status."}
          </p>
          <label className="block space-y-1 text-sm">
            {labels.coordinatorSingular} thread name
            <Input
              maxLength={80}
              placeholder={labels.coordinatorSingular}
              value={config.coordinatorTitle ?? ""}
              onChange={(event) =>
                setDraft({ ...draft, coordinatorTitle: event.target.value || null })
              }
            />
          </label>
          <details>
            <summary className="cursor-pointer text-sm">Rename titles</summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {LABELS.map(([key, label]) =>
                // A given name has no plural; sentences that would need one avoid it.
                key === "coordinatorPlural" && labels.coordinatorNameKind === "given" ? null : (
                  <Fragment key={key}>
                    <label className="space-y-1 text-sm">
                      {label}
                      <Input
                        maxLength={80}
                        value={labels[key]}
                        onChange={(event) =>
                          setDraft({ ...draft, labels: { ...labels, [key]: event.target.value } })
                        }
                      />
                    </label>
                    {key === "coordinatorSingular" ? (
                      <ToggleGroup
                        aria-label="Kind of name"
                        variant="segmented"
                        className="self-end"
                        value={[labels.coordinatorNameKind ?? "role"]}
                        onValueChange={(next) => {
                          const kind = next[0];
                          if (kind === "role" || kind === "given") {
                            setDraft({
                              ...draft,
                              // A given name hides the plural, so it keeps the stored one.
                              labels: {
                                ...labels,
                                coordinatorNameKind: kind,
                                ...(kind === "given" && {
                                  coordinatorPlural: data.configuration.labels.coordinatorPlural,
                                }),
                              },
                            });
                          }
                        }}
                      >
                        <Toggle value="role">Role (the Conductor)</Toggle>
                        <Toggle value="given">Given name (Claudia)</Toggle>
                      </ToggleGroup>
                    ) : null}
                  </Fragment>
                ),
              )}
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDraft({ ...draft, labels: DEFAULT_COORDINATOR_LABELS })}
            >
              Restore default titles
            </Button>
          </details>
          <Button
            onClick={async () => {
              if (await send({ type: "configure", configuration: draft })) setDraft({});
            }}
          >
            Save settings
          </Button>
        </fieldset>
        <details>
          <summary className="cursor-pointer text-sm">
            {capitalizedLabel(labels.profilePlural)} and Guild accounts
          </summary>
          <fieldset disabled={disabled} className="mt-3 space-y-3">
            <p className="text-xs text-muted-foreground">
              Bind each provider to its actual Guild profile or account so local and cloud work
              share the correct allowance and capacity limits. These are names, not credentials.
            </p>
            {config.guildBindings?.map((binding) => (
              <div key={binding.id} className="flex items-center justify-between gap-2 text-sm">
                <label>
                  {capitalizedLabel(labels.profileSingular)} name
                  <Input
                    value={binding.name}
                    maxLength={80}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        guildBindings: config.guildBindings?.map((item) =>
                          item.id === binding.id ? { ...item, name: event.target.value } : item,
                        ),
                      })
                    }
                  />
                </label>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setDraft({
                      ...draft,
                      guildBindings: config.guildBindings?.filter((item) => item.id !== binding.id),
                    })
                  }
                >
                  Remove
                </Button>
              </div>
            ))}
            <label className="block text-sm">
              {capitalizedLabel(labels.profileSingular)} name
              <Input value={bindingName} onChange={(event) => setBindingName(event.target.value)} />
            </label>
            <label className="block text-sm">
              T3 provider
              <select
                className="block w-full rounded border p-2"
                value={bindingProvider}
                onChange={(event) => setBindingProvider(event.target.value)}
              >
                <option value="">Choose a provider</option>
                {providers.map((provider) => (
                  <option key={provider.instanceId} value={provider.instanceId}>
                    {provider.displayName ?? provider.instanceId}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              Guild provider
              <select
                className="block w-full rounded border p-2"
                value={bindingGuildProvider}
                onChange={(event) => setBindingGuildProvider(event.target.value)}
              >
                <option value="codex">Codex</option>
                <option value="claude">Claude</option>
              </select>
            </label>
            <label className="block text-sm">
              Guild account
              <Input
                value={bindingAccount}
                onChange={(event) => setBindingAccount(event.target.value)}
              />
            </label>
            <label className="block text-sm">
              Guild profile
              <Input
                value={bindingProfile}
                onChange={(event) => setBindingProfile(event.target.value)}
              />
            </label>
            <label className="block text-sm">
              Local capacity template model (optional)
              <Input
                value={bindingCapacityModel}
                onChange={(event) => setBindingCapacityModel(event.target.value)}
              />
            </label>
            <p className="text-xs text-muted-foreground">
              Used for capacity accounting for unregistered manual models; it does not change the
              selected model.
            </p>
            <details>
              <summary>Codex cloud binding (optional)</summary>
              {(
                [
                  ["projectId", "Project ID"],
                  ["guildModel", "Guild model"],
                  ["repository", "Repository"],
                  ["environment", "Cloud environment"],
                  ["branch", "Branch"],
                  ["head", "Head"],
                  ["base", "Base"],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="block text-sm">
                  {label}
                  <Input
                    value={cloud[key]}
                    onChange={(event) => setCloud({ ...cloud, [key]: event.target.value })}
                  />
                </label>
              ))}
            </details>
            <Button
              variant="outline"
              disabled={
                !bindingName.trim() ||
                !bindingProvider ||
                (!bindingAccount && !bindingProfile) ||
                (Object.values(cloud).some(Boolean) && !Object.values(cloud).every(Boolean))
              }
              onClick={() => {
                setDraft({
                  ...draft,
                  guildBindings: [
                    ...(config.guildBindings ?? []),
                    {
                      id: randomUUID(),
                      name: bindingName.trim(),
                      providerInstanceId: bindingProvider,
                      guildProvider: bindingGuildProvider,
                      guildAccount: bindingAccount || null,
                      profileId: bindingProfile || null,
                      environmentId: null,
                      ...(bindingCapacityModel.trim()
                        ? { guildModel: bindingCapacityModel.trim() }
                        : {}),
                      ...(Object.values(cloud).every(Boolean)
                        ? { cloud: { ...cloud, destination: "cloud:codex" } }
                        : {}),
                    },
                  ],
                });
                setBindingName("");
                setBindingAccount("");
                setBindingProfile("");
                setBindingCapacityModel("");
              }}
            >
              Add {labels.profileSingular}
            </Button>
            <Button
              disabled={config.guildBindings?.some((item) => !item.name.trim())}
              onClick={() => {
                void send({
                  type: "configure",
                  configuration: { guildBindings: config.guildBindings ?? [] },
                });
              }}
            >
              Save {labels.profileSingular} bindings
            </Button>
          </fieldset>
        </details>
        <PermissionPreview environmentId={environmentId} />
        {config.permissionMode === "custom" && (
          <fieldset disabled={disabled} className="space-y-3">
            <legend className="text-sm font-medium">Custom permissions</legend>
            <p className="text-xs">Unmatched requests ask you; deny takes precedence.</p>
            <label className="block text-sm">
              Scope
              <select
                className="block w-full rounded border p-2"
                value={policyScope}
                onChange={(event) => setPolicyScope(event.target.value as Policy["scope"]["kind"])}
              >
                {COORDINATOR_PERMISSION_SCOPES.map((scope) => (
                  <option key={scope} value={scope}>
                    {scope}
                  </option>
                ))}
              </select>
            </label>
            {policyScope !== "global" && (
              <label className="block text-sm">
                Scope ID
                <Input value={policyId} onChange={(event) => setPolicyId(event.target.value)} />
              </label>
            )}
            <label className="block text-sm">
              Maximum access level
              <select
                className="block w-full rounded border p-2"
                value={maxAccess}
                onChange={(event) => setMaxAccess(event.target.value)}
              >
                <option value="">Inherit</option>
                <option value="0">0</option>
                <option value="1">1</option>
                <option value="2">2</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={allowIncrease}
                onChange={(event) => setAllowIncrease(event.target.checked)}
              />
              Allow access increases
            </label>
            <label className="block text-sm">
              Expires at (optional)
              <Input
                type="datetime-local"
                value={policyExpiry}
                onChange={(event) => setPolicyExpiry(event.target.value)}
              />
            </label>
            <label className="block text-sm">
              Permission category
              <select
                className="block w-full rounded border p-2"
                value={category}
                onChange={(event) => setCategory(event.target.value)}
              >
                {COORDINATOR_PERMISSION_CATEGORIES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-xs text-muted-foreground">
              Resource-specific and network rules are unavailable because request details are not
              supported.
            </p>
            <label className="block text-sm">
              Decision
              <select
                className="block w-full rounded border p-2"
                value={ruleEffect}
                onChange={(event) => setRuleEffect(event.target.value as typeof ruleEffect)}
              >
                <option value="ask">Ask</option>
                <option value="allow">Allow</option>
                <option value="deny">Deny</option>
              </select>
            </label>
            <Button
              variant="outline"
              onClick={() =>
                setRules([
                  ...rules,
                  {
                    key: randomUUID(),
                    category,
                    effect: ruleEffect,
                    resource: null,
                  },
                ])
              }
            >
              Add rule
            </Button>
            {rules.map((rule, index) => (
              <div key={rule.key} className="flex items-center justify-between gap-2 text-sm">
                <span>
                  {rule.effect}: {rule.category} {rule.resource ?? "all resources"}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setRules(rules.filter((_, i) => i !== index))}
                >
                  Remove
                </Button>
              </div>
            ))}
            <Button
              disabled={policyScope !== "global" && !policyId.trim()}
              onClick={() => {
                void send({
                  type: "permissions.set",
                  policy: {
                    id: `custom-${policyScope}-${policyId || "global"}`,
                    mode: "custom",
                    scope: { kind: policyScope, id: policyScope === "global" ? null : policyId },
                    rules: rules.map(({ key: _, ...rule }) => rule),
                    delegateApproval: true,
                    allowAccessIncrease: allowIncrease,
                    ...(maxAccess ? { maxAccess: Number(maxAccess) } : {}),
                    ...(policyExpiry ? { expiresAt: new Date(policyExpiry).getTime() } : {}),
                  },
                });
              }}
            >
              Save custom permissions
            </Button>
            <p className="text-xs text-muted-foreground">
              Saved policies may overlap; destination restrictions also apply.
            </p>
            {data.permissions.map((policy) => (
              <p key={policy.id} className="text-xs">
                Saved: {policy.mode}, {policy.scope.kind} {policy.scope.id ?? ""}, expires{" "}
                {policy.expiresAt ? new Date(policy.expiresAt).toLocaleString() : "never"}
              </p>
            ))}
            <p>
              Draft policy: {policyScope}
              {policyScope !== "global" ? ` ${policyId || "(choose ID)"}` : ""}; maximum access{" "}
              {maxAccess || "inherited"};{" "}
              {allowIncrease ? "access increases allowed" : "no access increases"}; expires{" "}
              {policyExpiry || "never"}. Unmatched requests ask.
            </p>
            <label className="block text-sm">
              Preset name
              <Input value={presetName} onChange={(event) => setPresetName(event.target.value)} />
            </label>
            <Button
              variant="outline"
              disabled={
                disabled || !presetName.trim() || presetName.trim().length > 80 || !rules.length
              }
              onClick={() => {
                void send({
                  type: "permissions.preset.save",
                  preset: {
                    id: randomUUID(),
                    name: presetName.trim(),
                    rules: rules.map(({ key: _, ...rule }) => rule),
                    delegateApproval: true,
                    allowAccessIncrease: allowIncrease,
                    ...(maxAccess ? { maxAccess: Number(maxAccess) } : {}),
                  },
                });
              }}
            >
              Save reusable preset
            </Button>
            <p className="text-xs text-muted-foreground">
              Saving a preset grants nothing. Apply it explicitly to the selected scope.
            </p>
            {(data.permissionPresets ?? []).map((preset) => (
              <div key={preset.id} className="flex flex-wrap gap-2">
                <span>{preset.name}</span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled || (policyScope !== "global" && !policyId.trim())}
                  onClick={() => {
                    void send({
                      type: "permissions.preset.apply",
                      presetId: preset.id,
                      scope: { kind: policyScope, id: policyScope === "global" ? null : policyId },
                    });
                  }}
                >
                  Apply
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => {
                    void send({ type: "permissions.preset.delete", presetId: preset.id });
                  }}
                >
                  Delete preset
                </Button>
              </div>
            ))}
          </fieldset>
        )}
        <form
          className="space-y-3"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!purpose.trim() || Array.from(purpose).length > COORDINATOR_GOAL_PURPOSE_MAX_CHARS)
              return;
            if (
              await send({
                type: "goal.upsert",
                goal: {
                  id: randomUUID(),
                  purpose: purpose.trim(),
                  status: "active",
                  authorizedScope: config.coordinatorProjectId ? [config.coordinatorProjectId] : [],
                },
              })
            )
              setPurpose("");
          }}
        >
          <label className="block space-y-1 text-sm">
            What would you like built?
            <textarea
              className="block min-h-24 w-full rounded border p-2"
              value={purpose}
              disabled={disabled}
              onChange={(event) => setPurpose(event.target.value)}
            />
          </label>
          {Array.from(purpose).length > COORDINATOR_GOAL_PURPOSE_MAX_CHARS && (
            <p role="alert">
              Keep the goal within 4,000 characters; reference a file or thread for longer
              requirements.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              disabled={
                disabled ||
                !purpose.trim() ||
                Array.from(purpose).length > COORDINATOR_GOAL_PURPOSE_MAX_CHARS
              }
            >
              Add goal
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={disabled || !data.configuration.enabled || data.pause.active}
              onClick={() => {
                void send({ type: "cycle.run" });
              }}
            >
              Check in and coordinate
            </Button>
          </div>
        </form>
        <details>
          <summary className="cursor-pointer text-sm">Manual model override</summary>
          <fieldset disabled={disabled} className="mt-3 space-y-3">
            <label className="block text-sm">
              Override scope
              <select
                className="block w-full rounded border p-2"
                value={overrideScopeKind}
                onChange={(event) => {
                  setOverrideScopeKind(event.target.value as typeof overrideScopeKind);
                  setOverrideTargetId("");
                }}
              >
                {OVERRIDE_SCOPES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            {overrideScopeKind !== "global" && (
              <label className="block text-sm">
                {overrideScopeKind === "project"
                  ? "Project ID"
                  : overrideScopeKind === "assignment"
                    ? "Assignment ID"
                    : "Thread ID"}
                <Input
                  value={overrideTargetId}
                  onChange={(event) => setOverrideTargetId(event.target.value)}
                />
              </label>
            )}
            <p className="text-xs text-muted-foreground">
              Assignment overrides take precedence over thread, project, then global overrides.
              Global applies to future work. Enter the exact ID for any other scope.
            </p>
            <label className="block text-sm">
              Provider (optional)
              <select
                className="block w-full rounded border p-2"
                value={overrideProvider}
                onChange={(event) => setOverrideProvider(event.target.value)}
              >
                <option value="">Leave unchanged</option>
                {providers.map((item) => (
                  <option key={item.instanceId} value={item.instanceId}>
                    {item.displayName ?? item.instanceId}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              Named Guild binding (optional)
              <select
                className="block w-full rounded border p-2"
                value=""
                onChange={(event) => {
                  const binding = config.guildBindings?.find(
                    (item) => item.id === event.target.value,
                  );
                  if (binding) {
                    setOverrideBindingSelected(true);
                    setOverrideProvider(binding.providerInstanceId);
                    setOverrideAccount(binding.guildAccount ?? "");
                    setOverrideProfile(binding.profileId ?? "");
                  }
                }}
              >
                <option value="">Choose a binding</option>
                {config.guildBindings?.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              Account (optional)
              <Input
                value={overrideAccount}
                onChange={(event) => setOverrideAccount(event.target.value)}
              />
            </label>
            <label className="block text-sm">
              Profile ID (optional)
              <Input
                value={overrideProfile}
                onChange={(event) => setOverrideProfile(event.target.value)}
              />
            </label>
            <p className="text-xs text-muted-foreground">
              Blank fields keep existing selections in this scope. Return to automatic removes only
              this scope&apos;s override; broader overrides still apply.
            </p>
            <label className="block text-sm">
              Model
              <Input
                list={`coordinator-override-models-${environmentId}`}
                value={model}
                onChange={(event) => setModel(event.target.value)}
              />
              <datalist id={`coordinator-override-models-${environmentId}`}>
                {providers
                  .find((item) => item.instanceId === overrideProvider)
                  ?.models.map((item) => (
                    <option key={item.slug} value={item.slug}>
                      {item.name}
                    </option>
                  ))}
              </datalist>
            </label>
            <label className="block text-sm">
              Reasoning effort
              <Input value={effort} onChange={(event) => setEffort(event.target.value)} />
            </label>
            <label className="block text-sm">
              Destination
              <Input value={destination} onChange={(event) => setDestination(event.target.value)} />
            </label>
            <div className="flex gap-2">
              <Button
                disabled={
                  overrideTargetMissing ||
                  (!currentOverride &&
                    !overrideProvider &&
                    !overrideAccount &&
                    !overrideProfile &&
                    !model &&
                    !effort &&
                    !destination)
                }
                onClick={() => {
                  void send({
                    type: "override.set",
                    override: {
                      id: currentOverride?.id ?? randomUUID(),
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
                        ...(model ? { model } : {}),
                        ...(effort ? { effort } : {}),
                        ...(destination ? { destination } : {}),
                      },
                    },
                  });
                }}
              >
                Apply override
              </Button>
              <Button
                variant="outline"
                disabled={overrideTargetMissing || !currentOverride}
                onClick={() => {
                  void send({
                    type: "override.set",
                    override: {
                      id: currentOverride?.id ?? randomUUID(),
                      scope: overrideScope,
                      selection: {},
                    },
                  });
                }}
              >
                Return to automatic
              </Button>
            </div>
          </fieldset>
        </details>
        {(data.permissionRequests ?? []).map((request) => {
          const origin = coordinatorPermissionOrigin(request, data);
          return (
            typeof request.id === "string" && (
              <div key={request.id} className="space-y-2 rounded border p-3">
                <p>
                  Permission request:{" "}
                  {typeof request.category === "string"
                    ? request.category
                    : "Review requested access"}
                </p>
                {origin?.detail && (
                  <p className="line-clamp-2 text-xs break-words">
                    <span className="font-medium">Reason: </span>
                    {origin.detail}
                  </p>
                )}
                {origin?.operation ? (
                  <div className="space-y-1">
                    <p className="text-xs font-medium">
                      {request.category === "command" ? "Command" : "Request"}
                    </p>
                    <pre className="max-h-40 overflow-auto font-mono text-xs break-all whitespace-pre-wrap">
                      {origin.operation}
                    </pre>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    This request doesn't show its whole operation. Review it in its thread to
                    approve it.
                  </p>
                )}
                {origin && (
                  <p className="flex gap-1 text-xs text-muted-foreground">
                    <span className="line-clamp-2 min-w-0 break-words">
                      {origin.thread} · {origin.project} ·
                    </span>
                    <Link
                      className="shrink-0"
                      to="/$environmentId/$threadId"
                      params={{ environmentId: origin.environmentId, threadId: origin.threadId }}
                    >
                      Review in thread
                    </Link>
                  </p>
                )}
                <div className="flex gap-2">
                  {origin?.operation && (
                    <Button
                      disabled={disabled}
                      onClick={() => {
                        void send({
                          type: "permission.respond",
                          requestId: request.id as string,
                          decision: "approve",
                        });
                      }}
                    >
                      Approve
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    disabled={disabled}
                    onClick={() => {
                      void send({
                        type: "permission.respond",
                        requestId: request.id as string,
                        decision: "deny",
                      });
                    }}
                  >
                    Deny
                  </Button>
                </div>
              </div>
            )
          );
        })}
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Goals</h3>
          {data.goals.length === 0 ? (
            <p className="text-sm text-muted-foreground">No goals yet.</p>
          ) : (
            data.goals.map((goal) => (
              <div key={goal.id} className="text-sm">
                <strong>{goal.status ?? "active"}</strong>: {goal.purpose}
                <RepairLimitControl
                  environmentId={environmentId}
                  goal={goal}
                  decisions={data.decisions ?? []}
                />
              </div>
            ))
          )}
        </div>
        <div className="space-y-2">
          <h3 className="text-sm font-medium">{labels.threadPlural}</h3>
          {data.cards
            .filter((card) => !card.settled && !card.archived)
            .map((card) => (
              <div key={card.id} className="space-y-1 border-b py-2 text-sm">
                <p>{card.purpose}</p>
                <p className="text-xs text-muted-foreground">
                  {card.status} · {card.destination ?? card.environmentId} ·{" "}
                  {card.model ?? "model unknown"}
                  {card.stale ? " · stale" : ""}
                </p>
                {card.blocker && <p>{card.blocker}</p>}
                {card.assignmentId && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={disabled}
                    onClick={() => {
                      void send({ type: "assignment.cancel", assignmentId: card.assignmentId! });
                    }}
                  >
                    Cancel assignment
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled || !card.verified}
                  onClick={() => {
                    void send({ type: "thread.settle", threadId: card.threadId });
                  }}
                >
                  Settle verified work
                </Button>
              </div>
            ))}
        </div>
        <details>
          <summary className="cursor-pointer text-sm">Settled history</summary>
          {data.cards
            .filter((card) => card.settled)
            .map((card) => (
              <div key={card.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                <span>{card.purpose}</span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => {
                    void send({ type: "thread.reopen", threadId: card.threadId });
                  }}
                >
                  Reopen
                </Button>
              </div>
            ))}
        </details>
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => {
              void send({ type: "catalog.refresh" });
            }}
          >
            Discover models
          </Button>
          <span className="text-xs">{data.catalog.length} catalog entries</span>
        </div>
        <details>
          <summary>Model discovery and eligibility</summary>
          {(data.catalogSources ?? []).map((source) => (
            <div key={source.id} className="space-y-1 border-b py-2 text-sm">
              <p>
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
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={disabled || source.discoverySupported === false}
                onClick={() => {
                  void send({
                    type: "catalog.source.set",
                    sourceId: source.id,
                    automaticDiscovery: !(source.automaticDiscovery ?? true),
                  });
                }}
              >
                {source.automaticDiscovery === false
                  ? "Enable automatic discovery"
                  : "Disable automatic discovery"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() => {
                  void send({
                    type: "catalog.source.set",
                    sourceId: source.id,
                    automaticEligibility: !(source.automaticEligibility ?? true),
                  });
                }}
              >
                {source.automaticEligibility === false
                  ? "Enable automatic eligibility"
                  : "Disable automatic eligibility"}
              </Button>
            </div>
          ))}
          {data.catalog.map((model) => (
            <div key={model.id} className="space-y-1 border-b py-2 text-sm">
              <p>
                {model.provider} / {model.model}: {model.state}
                {model.stale ? " · stale" : ""}
                {model.compatible ? "" : " · incompatible"}
                {model.accessible ? "" : " · inaccessible"}
                {model.policyAllowed ? "" : " · policy blocked"}
                {model.qualificationVerified ? "" : " · qualification unverified"}
                {model.identityVerified ? "" : " · identity unverified"}
                {model.priceMicros === null ? " · price unknown" : ""}
              </p>
              {model.evidence.length > 0 && <p>{model.evidence.join("; ")}</p>}
              <Button
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() => {
                  void send({
                    type: "catalog.model.set",
                    modelId: model.id,
                    quarantined: !model.manuallyQuarantined,
                  });
                }}
              >
                {model.manuallyQuarantined ? "Remove manual quarantine" : "Quarantine model"}
              </Button>
            </div>
          ))}
        </details>
        {notice && (
          <p role="status" className="text-sm">
            {notice}
          </p>
        )}
      </div>
    </SettingsSection>
  );
}

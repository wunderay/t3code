import { useAtomValue } from "@effect/atom-react";
import {
  COORDINATOR_PERMISSION_CATEGORIES,
  coordinatorInText,
  type CoordinatorBoard,
  type CoordinatorLabels,
  type CoordinatorCommand,
  type EnvironmentId,
} from "@t3tools/contracts";
import { formatUsd } from "@t3tools/shared/usageFormat";
import { type ReactNode, useState } from "react";
import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { randomUUID } from "../../lib/utils";
import { coordinatorEnvironment } from "../../state/coordinator";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";

type Limits = CoordinatorBoard["limits"];
const LIMITS: ReadonlyArray<readonly [keyof Limits, string]> = [
  ["inFlight", "Work in flight at once"],
  ["perLogin", "Work per login at once"],
  ["localSlots", "Threads on this machine at once"],
];

/** Blank is "none"; anything else must be a whole number of at least one. */
const wholeOrNone = (text: string): number | null | undefined => {
  if (!text.trim()) return null;
  const value = Number(text);
  return Number.isInteger(value) && value >= 1 ? value : undefined;
};
/** Blank is no cap; 0 is a cap of nothing, so no new work; a negative or non-number is refused. */
export const amountOrNone = (text: string, unit: number): number | null | undefined => {
  if (!text.trim()) return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? Math.round(value * unit) : undefined;
};
const shown = (value: number | null, unit: number) => (value === null ? "" : String(value / unit));

/** The dashboard switch, which is this device's alone. */
export function CoordinatorDashboardSwitch({
  labels,
}: {
  readonly labels: typeof CoordinatorLabels.Type;
}) {
  const enabled = useClientSettings((settings) => settings.coordinatorDashboard);
  const thread = `${coordinatorInText(labels)}'s thread`;
  return (
    <div className="flex items-center gap-3">
      <Switch
        aria-label={`Show a dashboard in ${thread}`}
        checked={enabled}
        onCheckedChange={(checked) => {
          void updateClientSettings({ coordinatorDashboard: Boolean(checked) });
        }}
      />
      <span className="text-sm">
        Show a dashboard of what is being worked on, and by whom, beside {thread} on this device
      </span>
    </div>
  );
}

/** An owner action that is hard to undo: asked once more, with what it does, before it is sent. */
function ConfirmedAction({
  label,
  title,
  description,
  confirm,
  disabled,
  onConfirm,
}: {
  readonly label: string;
  readonly title: string;
  readonly description: ReactNode;
  readonly confirm: string;
  readonly disabled: boolean;
  readonly onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" disabled={disabled} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription>{description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              {confirm}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

const NO_RULE = { label: "", category: "*", words: "", when: "" };
const CONDITIONS = [
  ["", "Any"],
  ["outside-workspace", "Reaching outside the worktree"],
  ["delete-outside-grant", "Deleting outside the delete list"],
] as const;

/** What a delegated thread asks that always comes to the owner: theirs to edit. */
function DangerList({
  rules,
  disabled,
  send,
}: {
  readonly rules: NonNullable<CoordinatorBoard["danger"]>;
  readonly disabled: boolean;
  readonly send: (input: CoordinatorCommand) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(NO_RULE);
  const words = draft.words.split(/\s+/).filter(Boolean);
  const valid =
    draft.label.trim() !== "" && (draft.category !== "*" || words.length > 0 || draft.when !== "");
  return (
    <fieldset disabled={disabled} className="space-y-2">
      <legend className="mb-1 text-sm font-medium">Danger list · {rules.length}</legend>
      <p className="text-xs text-muted-foreground">
        What a delegated thread asks for that always comes to you, whatever its grant. A rule
        matches its kind of request, its words in this order in a command or one of them in a path
        (* matches anything), and its condition.
      </p>
      {rules.map((rule) => (
        <div key={rule.id} className="flex items-center justify-between gap-3 text-sm">
          <span className="min-w-0 break-words">
            {rule.label}
            <span className="block text-xs text-muted-foreground">
              {[rule.category ?? "*", rule.words?.join(" "), rule.when].filter(Boolean).join(" · ")}
            </span>
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void send({ type: "danger.set", rules: rules.filter((item) => item.id !== rule.id) });
            }}
          >
            Remove
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-sm">
          Label
          <Input
            value={draft.label}
            onChange={(event) => setDraft({ ...draft, label: event.target.value })}
          />
        </label>
        <label className="space-y-1 text-sm">
          Kind of request
          <select
            className="block rounded border p-2"
            value={draft.category}
            onChange={(event) => setDraft({ ...draft, category: event.target.value })}
          >
            {COORDINATOR_PERMISSION_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {category === "*" ? "Any" : category}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-sm">
          Words
          <Input
            placeholder="git push --force*"
            value={draft.words}
            onChange={(event) => setDraft({ ...draft, words: event.target.value })}
          />
        </label>
        <label className="space-y-1 text-sm">
          Condition
          <select
            className="block rounded border p-2"
            value={draft.when}
            onChange={(event) => setDraft({ ...draft, when: event.target.value })}
          >
            {CONDITIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <Button
          size="sm"
          disabled={!valid}
          onClick={async () => {
            const added = await send({
              type: "danger.set",
              rules: [
                ...rules,
                {
                  id: randomUUID(),
                  label: draft.label.trim(),
                  category: draft.category,
                  words,
                  when: CONDITIONS.find(([value]) => value === draft.when)?.[0] || null,
                },
              ],
            });
            if (added) setDraft(NO_RULE);
          }}
        >
          Add rule
        </Button>
      </div>
      <ConfirmedAction
        label="Reset to the shipped list…"
        title="Reset the danger list?"
        description="Your changes to the list go, and the list T3 Code ships comes back, with whatever later versions add to it."
        confirm="Reset the list"
        disabled={disabled}
        onConfirm={() => {
          void send({ type: "danger.reset" });
        }}
      />
    </fieldset>
  );
}

/** The danger rules to lift for one grant, read from the board only once the owner opens it. */
export function DangerLifts({
  environmentId,
  lifts,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly lifts: ReadonlyArray<string>;
  readonly onChange: (lifts: ReadonlyArray<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-sm">
        Danger list rules to lift for this grant · {lifts.length}
      </summary>
      {open && <DangerLiftList environmentId={environmentId} lifts={lifts} onChange={onChange} />}
    </details>
  );
}

function DangerLiftList({
  environmentId,
  lifts,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly lifts: ReadonlyArray<string>;
  readonly onChange: (lifts: ReadonlyArray<string>) => void;
}) {
  const { data: board, error } = useEnvironmentQuery(
    coordinatorEnvironment.board({ environmentId, input: {} }),
  );
  if (!board?.danger)
    return (
      <p role="status" className="text-xs text-muted-foreground">
        {error ?? "Loading the danger list…"}
      </p>
    );
  return (
    <div className="space-y-1 pt-2">
      {board.danger.map((rule) => (
        <div key={rule.id} className="flex items-center gap-2 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              aria-describedby={rule.words ? `danger-words-${rule.id}` : undefined}
              checked={lifts.includes(rule.id)}
              onChange={(event) =>
                onChange(
                  event.target.checked ? [...lifts, rule.id] : lifts.filter((id) => id !== rule.id),
                )
              }
            />
            {rule.label}
          </label>
          {/* Many rules share a label (four ways to force push): the words tell them apart. */}
          {rule.words && (
            <code id={`danger-words-${rule.id}`} className="text-xs text-muted-foreground">
              {rule.words.join(" ")}
            </code>
          )}
        </div>
      ))}
    </div>
  );
}

/** The owner's controls, read from the board only while this panel is open. */
export function CoordinatorOwnerPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly projects: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly disabled: boolean;
  /** Off, the board is empty and its controls wait for the switch. */
  readonly off: boolean;
  readonly labels: typeof CoordinatorLabels.Type;
}) {
  const [open, setOpen] = useState(false);
  const { off, labels, ...board } = props;
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-sm font-medium">
        Weights, limits, budgets, danger list and cloud runs to check
      </summary>
      {open && (
        <div className="space-y-2 pt-3">
          {off && (
            <p role="status" className="text-xs text-muted-foreground">
              {coordinatorInText(labels, true)} is off; these can be set once it is on.
            </p>
          )}
          <CoordinatorBoardSettings {...board} disabled={board.disabled || off} />
        </div>
      )}
    </details>
  );
}

/** What only the owner sets: how use weighs against time, optional limits and daily budgets. */
function CoordinatorBoardSettings({
  environmentId,
  projects,
  disabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly projects: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly disabled: boolean;
}) {
  const { data: board, error } = useEnvironmentQuery(
    coordinatorEnvironment.board({ environmentId, input: {} }),
  );
  const allowed = useAtomValue(coordinatorEnvironment.command.permissionAtom(environmentId));
  const execute = useAtomCommand(coordinatorEnvironment.command);
  const [weights, setWeights] = useState<{ use?: string; time?: string }>({});
  const [limits, setLimits] = useState<Partial<Record<keyof Limits, string>>>({});
  const [caps, setCaps] = useState<Record<string, { usd?: string; hours?: string }>>({});
  const [notice, setNotice] = useState<string | null>(null);
  if (!board)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {error ?? "Loading routing and budgets…"}
      </p>
    );
  const off = disabled || !allowed;
  const send = async (input: CoordinatorCommand) => {
    setNotice(null);
    const result = await execute({ environmentId, input });
    setNotice(result._tag === "Success" ? "Saved." : "Could not save.");
    return result._tag === "Success";
  };
  const use = Number(weights.use ?? board.weights.use);
  const time = Number(weights.time ?? board.weights.time);
  const weightsValid =
    Number.isFinite(use) && Number.isFinite(time) && use >= 0 && time >= 0 && use + time > 0;
  const limitValues = LIMITS.map(
    ([key]) =>
      [key, limits[key] === undefined ? board.limits[key] : wholeOrNone(limits[key])] as const,
  );
  const limitsValid = limitValues.every(([, value]) => value !== undefined);
  return (
    <div className="space-y-5">
      <fieldset disabled={off} className="space-y-2">
        <legend className="mb-1 text-sm font-medium">How use weighs against time</legend>
        <p className="text-xs text-muted-foreground">
          Routing measures each candidate on what it uses and on how long it takes to be merged and
          done, kept apart; these weights say how much each counts.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          {(["use", "time"] as const).map((key) => (
            <label key={key} className="space-y-1 text-sm">
              {key === "use" ? "Use" : "Time"}
              <Input
                type="number"
                min={0}
                step="any"
                value={weights[key] ?? String(board.weights[key])}
                onChange={(event) => setWeights({ ...weights, [key]: event.target.value })}
              />
            </label>
          ))}
          <Button
            size="sm"
            disabled={off || !weightsValid}
            onClick={async () => {
              if (await send({ type: "router.weights.set", weights: { use, time } }))
                setWeights({});
            }}
          >
            Save weights
          </Button>
        </div>
      </fieldset>
      <fieldset disabled={off} className="space-y-2">
        <legend className="mb-1 text-sm font-medium">Limits</legend>
        <p className="text-xs text-muted-foreground">
          None is set unless you set one: work is otherwise bounded by each login's remaining
          allowance and this machine's processors and memory. Leave a field blank for no limit.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          {LIMITS.map(([key, label]) => (
            <label key={key} className="space-y-1 text-sm">
              {label}
              <Input
                type="number"
                min={1}
                step={1}
                placeholder="No limit"
                value={limits[key] ?? (board.limits[key] === null ? "" : String(board.limits[key]))}
                onChange={(event) => setLimits({ ...limits, [key]: event.target.value })}
              />
            </label>
          ))}
          <Button
            size="sm"
            disabled={off || !limitsValid}
            onClick={async () => {
              const set = Object.fromEntries(
                limitValues.filter(([, value]) => typeof value === "number"),
              );
              if (await send({ type: "board.limits", limits: set })) setLimits({});
            }}
          >
            Save limits
          </Button>
        </div>
      </fieldset>
      <fieldset disabled={off} className="space-y-2">
        <legend className="mb-1 text-sm font-medium">Daily budget per project</legend>
        <p className="text-xs text-muted-foreground">
          At a cap nothing new starts in that project until the next day; reviews of work already
          done still run. Leave both blank for no budget; 0 means no new work in that project.
        </p>
        {projects.length === 0 && <p className="text-sm text-muted-foreground">No projects.</p>}
        {projects.map((project) => {
          const cap = board.budgets.find((row) => row.projectId === project.id);
          const today = board.today.find((row) => row.projectId === project.id);
          const draft = caps[project.id] ?? {};
          const micros = amountOrNone(draft.usd ?? shown(cap?.micros ?? null, 1e6), 1e6);
          const seconds = amountOrNone(draft.hours ?? shown(cap?.seconds ?? null, 3600), 3600);
          return (
            <div
              key={project.id}
              className="grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end sm:gap-3"
            >
              <span className="min-w-0 text-sm sm:truncate">
                {project.title}
                <span className="block text-xs text-muted-foreground">
                  Today: {formatUsd((today?.micros ?? 0) / 1e6)},{" "}
                  {((today?.seconds ?? 0) / 3600).toFixed(1)} h
                </span>
              </span>
              <label className="space-y-1 text-sm">
                Use, US dollars
                <Input
                  type="number"
                  min={0}
                  step="any"
                  placeholder="None"
                  value={draft.usd ?? shown(cap?.micros ?? null, 1e6)}
                  onChange={(event) =>
                    setCaps({ ...caps, [project.id]: { ...draft, usd: event.target.value } })
                  }
                />
              </label>
              <label className="space-y-1 text-sm">
                Time worked, hours
                <Input
                  type="number"
                  min={0}
                  step="any"
                  placeholder="None"
                  value={draft.hours ?? shown(cap?.seconds ?? null, 3600)}
                  onChange={(event) =>
                    setCaps({ ...caps, [project.id]: { ...draft, hours: event.target.value } })
                  }
                />
              </label>
              <Button
                size="sm"
                variant="outline"
                disabled={off || micros === undefined || seconds === undefined}
                onClick={async () => {
                  if (micros === undefined || seconds === undefined) return;
                  if (
                    await send({
                      type: "board.budget",
                      target: { projectId: project.id },
                      cap: { micros, seconds },
                    })
                  ) {
                    setCaps(
                      Object.fromEntries(Object.entries(caps).filter(([id]) => id !== project.id)),
                    );
                  }
                }}
              >
                Save budget
              </Button>
              {(micros === undefined || seconds === undefined) && (
                <p role="alert" className="text-xs text-destructive-foreground sm:col-span-4">
                  Enter a number of at least 0, or leave the field blank for no cap.
                </p>
              )}
            </div>
          );
        })}
      </fieldset>
      {board.danger && <DangerList rules={board.danger} disabled={off} send={send} />}
      <section className="space-y-2">
        <h3 className="text-sm font-medium">Merged changes · {board.merged.length}</h3>
        <p className="text-xs text-muted-foreground">
          Reverting a goal opens pull requests that take back its change and every merged change
          built on it, newest first.
        </p>
        {board.merged.map((item) => (
          <div key={item.goalId} className="flex items-center justify-between gap-3 text-sm">
            <span className="min-w-0 truncate">
              {item.purpose ?? item.goalId}
              {item.unreviewed === 1
                ? ` · merged by hand, not reviewed${item.head ? ` at ${item.head.slice(0, 12)}` : ""}`
                : ""}
            </span>
            <ConfirmedAction
              label="Revert…"
              title="Revert this goal?"
              description={
                <>
                  This opens pull requests that take back “{item.purpose ?? item.goalId}” and every
                  merged change built on it, newest first. Undoing it means merging those changes
                  again. The revert counts twice in the goal's cost.
                </>
              }
              confirm="Open revert pull requests"
              disabled={off}
              onConfirm={() => {
                void send({ type: "goal.revert", goalId: item.goalId });
              }}
            />
          </div>
        ))}
      </section>
      <section className="space-y-2">
        <h3 className="text-sm font-medium">Worktrees kept · {board.kept.length}</h3>
        <p className="text-xs text-muted-foreground">
          Kept after settling because they hold files git does not track unchanged.
        </p>
        {board.kept.map((item) => (
          <div key={item.threadId} className="space-y-1 rounded border p-2 text-sm">
            <p className="text-xs break-all">{item.summary}</p>
            <ConfirmedAction
              label="Remove…"
              title="Remove this worktree?"
              description={
                <>
                  {item.summary} Removing it deletes those files with it; they cannot be brought
                  back.
                </>
              }
              confirm="Remove with its files"
              disabled={off}
              onConfirm={() => {
                void send({
                  type: "worktree.remove",
                  threadId: item.threadId,
                  shown: item.summary,
                });
              }}
            />
          </div>
        ))}
      </section>
      <section className="space-y-2">
        <h3 className="text-sm font-medium">Cloud runs to check · {board.unresolved.length}</h3>
        <p className="text-xs text-muted-foreground">
          Nothing collects these and nothing has shown that they ended. Check each in its cloud,
          then say so here.
        </p>
        {board.unresolved.map((run) => (
          <div key={run.id} className="space-y-1 rounded border p-2 text-sm">
            <p>
              {run.label} · {run.kind === "codex-cloud" ? "Codex cloud" : "Claude Code cloud"} ·{" "}
              {run.state}
            </p>
            <p className="text-xs text-muted-foreground">
              {run.why}. Branch {run.branch}
              {run.branchHead ? `, last commit ${run.branchHead.slice(0, 7)}` : ""}.
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={off}
              onClick={() => {
                void send({ type: "cloud.ended", assignmentId: run.assignmentId, id: run.id });
              }}
            >
              It has ended
            </Button>
          </div>
        ))}
      </section>
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
    </div>
  );
}

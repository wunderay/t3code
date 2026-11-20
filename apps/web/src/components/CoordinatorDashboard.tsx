import {
  COORDINATOR_CLOUD_STALL_MS,
  type CoordinatorPlace,
  coordinatorDashboard,
  coordinatorDuration,
  coordinatorHostNow,
  coordinatorRowState,
  coordinatorThreadFacts,
} from "@t3tools/client-runtime/state/coordinator";
import type { CoordinatorSnapshot, EnvironmentId } from "@t3tools/contracts";
import { formatUsd } from "@t3tools/shared/usageFormat";
import { Link } from "@tanstack/react-router";
import { useNowMinute } from "../hooks/useNowMinute";
import { coordinatorEnvironment } from "../state/coordinator";
import { useQuietThreadShells } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { Badge } from "./ui/badge";
import { UsageShareBar } from "./usage/UsageShareBar";

type Dashboard = ReturnType<typeof coordinatorDashboard>;

const PLACES: ReadonlyArray<{ place: CoordinatorPlace; label: string; color: string }> = [
  { place: "local", label: "This machine", color: "var(--color-info)" },
  { place: "codex-cloud", label: "Codex cloud", color: "var(--contrast-foreground)" },
  { place: "claude-cloud", label: "Claude Code cloud", color: "#d97757" },
];

const usd = (micros: number | null) => (micros === null ? "unknown" : formatUsd(micros / 1e6));

/** One measure against its cap, or against the largest of its kind when no cap is set. */
function Meter({
  label,
  value,
  cap,
  scale,
  format,
}: {
  readonly label: string;
  readonly value: number | null;
  readonly cap: number | null;
  readonly scale: number;
  readonly format: (value: number | null) => string;
}) {
  const of = cap ?? scale;
  const share = value === null || of <= 0 ? 0 : Math.min(1, value / of);
  const over = cap !== null && value !== null && value >= cap;
  return (
    <div className="min-w-0 flex-1 space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="truncate tabular-nums">
          {format(value)}
          {cap !== null && <span className="text-muted-foreground"> of {format(cap)}</span>}
        </span>
      </div>
      <div
        role="img"
        aria-label={`${label}: ${format(value)}${cap === null ? "" : ` of ${format(cap)}`}`}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={over ? "h-full bg-destructive" : "h-full bg-foreground/60"}
          style={{ width: `${share * 100}%` }}
        />
      </div>
    </div>
  );
}

/** A cloud run's life on one line: its start, the last commit seen, and now; stalled time hatched. */
function CloudTimeline({
  cloud,
  now,
}: {
  readonly cloud: NonNullable<Dashboard["work"][number]["cloud"]>;
  readonly now: number;
}) {
  const end = cloud.endedAt ?? now;
  const span = Math.max(1, end - cloud.startedAt);
  const at = (time: number) => Math.min(100, Math.max(0, ((time - cloud.startedAt) / span) * 100));
  const lastMove = cloud.movedAt ?? cloud.startedAt;
  const stallFrom = lastMove + COORDINATOR_CLOUD_STALL_MS;
  const description =
    cloud.movedAt === null
      ? `No commit on its branch yet, ${coordinatorDuration((end - cloud.startedAt) / 1_000)} since it started.`
      : `Last commit ${cloud.head?.slice(0, 7) ?? ""} ${coordinatorDuration((end - cloud.movedAt) / 1_000)} ago, ${coordinatorDuration((end - cloud.startedAt) / 1_000)} since it started.`;
  return (
    <div className="space-y-0.5">
      <svg
        viewBox="0 0 100 8"
        preserveAspectRatio="none"
        className="h-2 w-full text-muted-foreground"
        role="img"
        aria-label={description}
      >
        <line x1="0" y1="4" x2="100" y2="4" stroke="currentColor" strokeOpacity="0.4" />
        {stallFrom < end && (
          <rect
            x={at(stallFrom)}
            y="1"
            width={100 - at(stallFrom)}
            height="6"
            className="fill-destructive/40"
          />
        )}
        <rect x="0" y="2" width="1" height="4" fill="currentColor" />
        {cloud.movedAt !== null && (
          <rect
            x={at(cloud.movedAt) - 0.75}
            y="0"
            width="1.5"
            height="8"
            className="fill-success"
          />
        )}
      </svg>
      <p className="text-2xs text-muted-foreground">{description}</p>
    </div>
  );
}

const PLACE_LABEL = Object.fromEntries(PLACES.map((item) => [item.place, item.label]));

function WorkRow({ row, now }: { readonly row: Dashboard["work"][number]; readonly now: number }) {
  const stalled = row.detail === "stalled";
  const title = <span className="line-clamp-2 font-medium">{row.title}</span>;
  return (
    <li className="space-y-1.5 border-b py-2.5 last:border-b-0">
      {row.place === "local" ? (
        <Link
          to="/$environmentId/$threadId"
          params={{ environmentId: row.environmentId, threadId: row.threadId }}
          className="block hover:underline"
        >
          {title}
        </Link>
      ) : (
        title
      )}
      <div className="flex flex-wrap items-center gap-1">
        <Badge variant="outline" size="sm">
          {PLACE_LABEL[row.place]}
        </Badge>
        <Badge
          variant={row.waits.length > 0 ? "warning" : stalled ? "error" : "secondary"}
          size="sm"
        >
          {coordinatorRowState(row)}
        </Badge>
        {row.since !== null && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {coordinatorDuration(Math.max(0, now - row.since) / 1_000)}
          </span>
        )}
      </div>
      <p className="truncate text-xs text-muted-foreground">
        {[row.provider, row.model, row.login].filter(Boolean).join(" · ") || "Route not chosen yet"}
      </p>
      {row.goal && row.goal !== row.title && (
        <p className="line-clamp-1 text-xs text-muted-foreground">Goal: {row.goal}</p>
      )}
      {row.pullRequest && (
        <a href={row.pullRequest.url} target="_blank" rel="noreferrer" className="text-xs">
          Pull request #{row.pullRequest.number}
        </a>
      )}
      {row.cloud && <CloudTimeline cloud={row.cloud} now={now} />}
      <p className="text-xs text-muted-foreground tabular-nums">
        Spent {usd(row.use.micros)} · worked {coordinatorDuration(row.use.seconds)}
      </p>
      {row.waits.map((reason) => (
        <p key={reason} className="text-xs text-warning-foreground">
          Waits for you: {reason}
        </p>
      ))}
      {row.blocker && <p className="text-xs text-destructive-foreground">{row.blocker}</p>}
    </li>
  );
}

function DashboardBody({
  dashboard,
  labels,
  now,
}: {
  readonly dashboard: Dashboard;
  readonly labels: CoordinatorSnapshot["configuration"]["labels"];
  readonly now: number;
}) {
  const useScale = Math.max(0, ...dashboard.goals.map((goal) => goal.use.micros ?? 0));
  const timeScale = Math.max(0, ...dashboard.goals.map((goal) => goal.elapsed ?? 0));
  const goalPurpose = new Map(dashboard.goals.map((goal) => [goal.id, goal.purpose]));
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-2 text-center">
        {[
          ["Active", dashboard.work.length],
          ["Needs you", dashboard.needsOwner],
          ["Settled", dashboard.settled],
        ].map(([label, value]) => (
          <div key={label} className="rounded-md border px-2 py-1.5">
            <p className="text-lg font-medium tabular-nums">{value}</p>
            <p className="text-xs text-muted-foreground">{label}</p>
          </div>
        ))}
      </div>
      <UsageShareBar
        label={`Where ${labels.threadPlural} run`}
        segments={PLACES.map((item) => ({
          label: item.label,
          value: dashboard.work.filter((row) => row.place === item.place).length,
          color: item.color,
        }))}
        format={(value) => String(value)}
      />
      {dashboard.goals.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">Goals, in order of dependency</h3>
          <p className="text-xs text-muted-foreground">
            Cost as routing counts it: waiting on you left out, a revert counted twice.
          </p>
          <ol className="space-y-3">
            {dashboard.goals.map((goal) => (
              <li
                key={goal.id}
                className="space-y-1.5"
                style={{ paddingLeft: `${goal.depth * 0.75}rem` }}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="line-clamp-2 text-sm">{goal.purpose}</span>
                  <span className="flex shrink-0 gap-1">
                    {goal.reverts > 0 && (
                      <Badge variant="warning" size="sm">
                        reverted
                      </Badge>
                    )}
                    <Badge
                      variant={
                        goal.status === "blocked"
                          ? "error"
                          : goal.merge?.owner
                            ? "warning"
                            : goal.status === "merging"
                              ? "info"
                              : "secondary"
                      }
                      size="sm"
                    >
                      {goal.merge?.owner ? "held for you" : goal.status}
                    </Badge>
                  </span>
                </div>
                {goal.merge && (
                  <p
                    className={
                      goal.merge.owner
                        ? "text-xs text-warning-foreground"
                        : "text-xs text-muted-foreground"
                    }
                  >
                    {goal.merge.owner ? "Held for you" : "Merge waiting"}: {goal.merge.reason}
                  </p>
                )}
                {goal.dependencies.length > 0 && (
                  <p className="line-clamp-1 text-xs text-muted-foreground">
                    After {goal.dependencies.map((id) => goalPurpose.get(id) ?? id).join(", ")}
                  </p>
                )}
                {/* Use and time are two costs; neither is folded into the other. */}
                <div className="flex gap-3">
                  <Meter
                    label="Cost in use"
                    value={goal.use.micros}
                    cap={goal.cap.micros}
                    scale={useScale}
                    format={usd}
                  />
                  <Meter
                    label="Cost in time"
                    value={goal.elapsed === null ? null : goal.elapsed / 1_000}
                    cap={goal.cap.seconds}
                    scale={timeScale / 1_000}
                    format={coordinatorDuration}
                  />
                </div>
                {(goal.repairs > 0 || goal.reverts > 0) && (
                  <p className="text-xs text-warning-foreground">
                    Rework: {goal.repairs} {goal.repairs === 1 ? "repair" : "repairs"}
                    {goal.reverts > 0
                      ? `, ${goal.reverts} ${goal.reverts === 1 ? "revert" : "reverts"} (cost counted twice)`
                      : ""}
                  </p>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
      <section className="space-y-1">
        <h3 className="text-sm font-medium">Who works on what · {dashboard.work.length}</h3>
        {dashboard.work.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing delegated is open.</p>
        ) : (
          <ul>
            {dashboard.work.map((row) => (
              <WorkRow key={row.cardId} row={row} now={now} />
            ))}
          </ul>
        )}
      </section>
      {dashboard.projects.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">Spent today against the daily budget</h3>
          {dashboard.projects.map((project) => (
            <div key={project.id} className="space-y-1">
              <p className="truncate text-xs">{project.title}</p>
              <div className="flex gap-3">
                <Meter
                  label="Spent"
                  value={project.today.micros}
                  cap={project.cap.micros}
                  scale={project.today.micros}
                  format={usd}
                />
                <Meter
                  label="Worked"
                  value={project.today.seconds}
                  cap={project.cap.seconds}
                  scale={project.today.seconds}
                  format={coordinatorDuration}
                />
              </div>
            </div>
          ))}
        </section>
      )}
      {dashboard.reverted.length > 0 && (
        <section className="space-y-1">
          <h3 className="text-sm font-medium">Reverted · {dashboard.reverted.length}</h3>
          <p className="text-xs text-muted-foreground">
            Done and taken back; the revert counts twice in their cost.
          </p>
          {dashboard.reverted.map((goal) => (
            <p key={goal.id} className="text-xs">
              <span className="line-clamp-1">{goal.purpose}</span>
              <span className="text-muted-foreground tabular-nums">
                Cost in use {usd(goal.use)} · cost in time{" "}
                {coordinatorDuration(goal.elapsed === null ? null : goal.elapsed / 1_000)}
              </span>
            </p>
          ))}
        </section>
      )}
      {dashboard.handMerged.length > 0 && (
        <section className="space-y-1">
          <h3 className="text-sm font-medium">
            Merged by hand, not reviewed · {dashboard.handMerged.length}
          </h3>
          {dashboard.handMerged.map((goal) => (
            <p key={goal.id} className="text-xs">
              <span className="line-clamp-1">{goal.purpose}</span>
              <span className="text-muted-foreground tabular-nums">
                Merged by hand, not reviewed{goal.head ? ` at ${goal.head.slice(0, 12)}` : ""}
              </span>
            </p>
          ))}
        </section>
      )}
      {dashboard.kept.length > 0 && (
        <section className="space-y-1">
          <h3 className="text-sm font-medium">Worktrees kept · {dashboard.kept.length}</h3>
          {dashboard.kept.map((item) => (
            <p key={item.threadId} className="text-xs text-muted-foreground">
              {item.summary}
            </p>
          ))}
          <p className="text-xs">
            Remove one in{" "}
            <Link to="/settings/coordinator" hash="coordinator">
              Settings
            </Link>
            .
          </p>
        </section>
      )}
      {dashboard.unresolved.length > 0 && (
        <p className="text-xs text-warning-foreground">
          {dashboard.unresolved.length} cloud {dashboard.unresolved.length === 1 ? "run" : "runs"}{" "}
          may still be running. Check{" "}
          <Link to="/settings/coordinator" hash="coordinator">
            Settings
          </Link>
          .
        </p>
      )}
    </div>
  );
}

/** What the Coordinator's work is and who does it, beside its chat; read only while shown. */
export function CoordinatorDashboard({
  environmentId,
  data,
}: {
  readonly environmentId: EnvironmentId;
  readonly data: CoordinatorSnapshot;
}) {
  const {
    data: board,
    dataUpdatedAt,
    error,
  } = useEnvironmentQuery(coordinatorEnvironment.board({ environmentId, input: {} }));
  const minute = useNowMinute();
  const shells = useQuietThreadShells();
  const now = board
    ? coordinatorHostNow(board.now, dataUpdatedAt, Date.parse(`${minute}:00.000Z`))
    : 0;
  const byThread = new Map(
    shells
      .filter((shell) => shell.environmentId === environmentId)
      .map((shell) => [shell.id as string, shell]),
  );
  return (
    <aside
      aria-label="Dashboard"
      className="max-h-[45%] shrink-0 overflow-y-auto border-b bg-background px-4 py-3 lg:max-h-none lg:w-[22rem] lg:border-b-0 lg:border-l xl:w-[26rem]"
    >
      <h2 className="mb-3 text-sm font-medium">Dashboard</h2>
      {board ? (
        <DashboardBody
          dashboard={coordinatorDashboard(
            data,
            board,
            (threadId) => {
              const shell = byThread.get(threadId);
              return shell ? coordinatorThreadFacts(shell) : undefined;
            },
            now,
          )}
          labels={data.configuration.labels}
          now={now}
        />
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          {error ?? "Loading…"}
        </p>
      )}
    </aside>
  );
}

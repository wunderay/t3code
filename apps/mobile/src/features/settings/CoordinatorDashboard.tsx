import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  coordinatorDashboard,
  coordinatorRowState,
  coordinatorThreadFacts,
  coordinatorDuration,
  coordinatorHostNow,
} from "@t3tools/client-runtime/state/coordinator";
import {
  coordinatorInText,
  type CoordinatorLabels,
  type CoordinatorSnapshot,
  type EnvironmentId,
} from "@t3tools/contracts";
import { formatUsd } from "@t3tools/shared/usageFormat";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Linking, ScrollView, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { useNowMinuteMs } from "../../lib/clock";
import { Button } from "../../components/ui/Button";
import { coordinatorEnvironment } from "../../state/coordinator";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useThreadShells } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";

const PLACE = {
  local: "This machine",
  "codex-cloud": "Codex cloud",
  "claude-cloud": "Claude Code cloud",
};
const usd = (micros: number | null) => (micros === null ? "unknown" : formatUsd(micros / 1e6));

export function useCoordinatorDashboardEnabled(): boolean {
  const preferences = useAtomValue(mobilePreferencesAtom);
  return AsyncResult.isSuccess(preferences) && preferences.value.coordinatorDashboard === true;
}

/** This device's switch for the dashboard in the Coordinator's thread. */
export function CoordinatorDashboardSwitch({
  labels,
}: {
  readonly labels: typeof CoordinatorLabels.Type;
}) {
  const enabled = useCoordinatorDashboardEnabled();
  const save = useAtomSet(updateMobilePreferencesAtom);
  return (
    <Button
      label={`${enabled ? "Hide" : "Show"} the dashboard in ${coordinatorInText(labels)}'s thread on this device`}
      onPress={() => save({ coordinatorDashboard: !enabled })}
    />
  );
}

/** One measure against its cap, or against the largest of its kind; use and time stay apart. */
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
  return (
    <View className="min-w-0 flex-1 gap-1">
      <Text className="text-xs text-foreground-muted">
        {label} {format(value)}
        {cap === null ? "" : ` of ${format(cap)}`}
      </Text>
      <View className="h-1.5 overflow-hidden rounded-full bg-subtle">
        <View
          className={
            cap !== null && value !== null && value >= cap
              ? "h-full bg-danger"
              : "h-full bg-foreground-muted"
          }
          style={{ width: `${share * 100}%` }}
        />
      </View>
    </View>
  );
}

/** The Coordinator's work and who does it, above its chat; read only while shown. */
export function CoordinatorDashboard({
  environmentId,
  data,
}: {
  readonly environmentId: EnvironmentId;
  readonly data: CoordinatorSnapshot;
}) {
  const [open, setOpen] = useState(false);
  const {
    data: board,
    successResult,
    error,
  } = useEnvironmentQuery(open ? coordinatorEnvironment.board({ environmentId, input: {} }) : null);
  const clientNow = useNowMinuteMs();
  const now = board
    ? coordinatorHostNow(board.now, successResult?.timestamp ?? clientNow, clientNow)
    : clientNow;
  const shells = useThreadShells();
  const byThread = new Map(
    shells
      .filter((shell) => shell.environmentId === environmentId)
      .map((shell) => [shell.id as string, shell]),
  );
  const dashboard = board
    ? coordinatorDashboard(
        data,
        board,
        (threadId) => {
          const shell = byThread.get(threadId);
          return shell ? coordinatorThreadFacts(shell) : undefined;
        },
        now,
      )
    : null;
  const useScale = Math.max(0, ...(dashboard?.goals.map((goal) => goal.use.micros ?? 0) ?? []));
  const timeScale = Math.max(0, ...(dashboard?.goals.map((goal) => goal.elapsed ?? 0) ?? []));
  return (
    <View className="border-b border-border-subtle">
      <Button label={open ? "Hide dashboard" : "Dashboard"} onPress={() => setOpen(!open)} />
      {open && (
        <ScrollView style={{ maxHeight: 420 }} contentContainerStyle={{ padding: 12, gap: 12 }}>
          {!dashboard ? (
            <Text>{error ?? "Loading…"}</Text>
          ) : (
            <>
              <Text>
                {dashboard.work.length} active · {dashboard.needsOwner} need you ·{" "}
                {dashboard.settled} settled
              </Text>
              {dashboard.goals.map((goal) => (
                <View key={goal.id} className="gap-1" style={{ paddingLeft: goal.depth * 12 }}>
                  <Text>
                    {goal.purpose} · {goal.merge?.owner ? "held for you" : goal.status}
                    {goal.reverts > 0 ? " · reverted" : ""}
                  </Text>
                  {goal.merge && (
                    <Text className="text-xs">
                      {goal.merge.owner ? "Held for you" : "Merge waiting"}: {goal.merge.reason}
                    </Text>
                  )}
                  <View className="flex-row gap-3">
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
                  </View>
                  {goal.repairs + goal.reverts > 0 && (
                    <Text className="text-xs">
                      Rework: {goal.repairs} repairs, {goal.reverts} reverts
                    </Text>
                  )}
                </View>
              ))}
              {dashboard.work.map((row) => (
                <View key={row.cardId} className="gap-0.5 border-t border-border-subtle pt-2">
                  <Text>{row.title}</Text>
                  <Text className="text-xs text-foreground-muted">
                    {PLACE[row.place]} · {coordinatorRowState(row)}
                    {row.since === null
                      ? ""
                      : ` · ${coordinatorDuration(Math.max(0, now - row.since) / 1_000)}`}
                  </Text>
                  <Text className="text-xs text-foreground-muted">
                    {[row.provider, row.model, row.login].filter(Boolean).join(" · ")}
                  </Text>
                  {row.cloud && (
                    <Text className="text-xs text-foreground-muted">
                      {row.cloud.movedAt === null
                        ? "No commit on its branch yet"
                        : `Last commit ${coordinatorDuration((now - row.cloud.movedAt) / 1_000)} ago`}
                    </Text>
                  )}
                  <Text className="text-xs text-foreground-muted">
                    Spent {usd(row.use.micros)} · worked {coordinatorDuration(row.use.seconds)}
                  </Text>
                  {row.pullRequest && (
                    <Text
                      className="text-xs"
                      onPress={() => void Linking.openURL(row.pullRequest!.url)}
                    >
                      Pull request #{row.pullRequest.number}
                    </Text>
                  )}
                  {row.waits.map((reason) => (
                    <Text key={reason} className="text-xs">
                      Waits for you: {reason}
                    </Text>
                  ))}
                </View>
              ))}
              {dashboard.reverted.map((goal) => (
                <Text key={goal.id} className="text-xs">
                  Reverted: {goal.purpose} · cost in use {usd(goal.use)} · cost in time{" "}
                  {coordinatorDuration(goal.elapsed === null ? null : goal.elapsed / 1_000)}{" "}
                  (counted twice)
                </Text>
              ))}
              {dashboard.handMerged.map((goal) => (
                <Text key={goal.id} className="text-xs">
                  {goal.purpose}: merged by hand, not reviewed
                  {goal.head ? ` at ${goal.head.slice(0, 12)}` : ""}
                </Text>
              ))}
              {dashboard.kept.map((item) => (
                <Text key={item.threadId} className="text-xs text-foreground-muted">
                  {item.summary}
                </Text>
              ))}
              {dashboard.unresolved.length > 0 && (
                <Text className="text-xs">
                  {dashboard.unresolved.length} cloud{" "}
                  {dashboard.unresolved.length === 1 ? "run" : "runs"} may still be running. Check
                  them in {coordinatorInText(data.configuration.labels)}'s settings on web or
                  desktop.
                </Text>
              )}
              {dashboard.projects.map((project) => (
                <View key={project.id} className="gap-1">
                  <Text>{project.title}: spent today against its budget</Text>
                  <View className="flex-row gap-3">
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
                  </View>
                </View>
              ))}
            </>
          )}
        </ScrollView>
      )}
    </View>
  );
}

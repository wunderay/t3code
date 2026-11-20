import {
  COORDINATOR_PERMISSION_CATEGORIES,
  coordinatorInText,
  describeCoordinatorGrant,
} from "@t3tools/contracts";
import {
  coordinatorFailure,
  coordinatorManages,
  coordinatorNeedsOwner,
  coordinatorPermissionOrigin,
} from "@t3tools/client-runtime/state/coordinator";
import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import {
  EnvironmentId,
  type CoordinatorCommand,
  type CoordinatorSnapshot,
} from "@t3tools/contracts";
import { useState, type ReactNode } from "react";
import { View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { coordinatorEnvironment } from "../../state/coordinator";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Field, MODES } from "./CoordinatorSection";
import { CoordinatorDashboard, useCoordinatorDashboardEnabled } from "./CoordinatorDashboard";

export function MobileCoordinatorThreadBoundary({
  environmentId,
  threadId,
  children,
}: {
  readonly environmentId?: string;
  readonly threadId?: string;
  readonly children: ReactNode;
}) {
  if (!environmentId || !threadId) return children;
  return (
    <MobileCoordinatorThread environmentId={EnvironmentId.make(environmentId)} threadId={threadId}>
      {children}
    </MobileCoordinatorThread>
  );
}

function MobileCoordinatorThread({
  environmentId,
  threadId,
  children,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly children: ReactNode;
}) {
  const { data } = useEnvironmentQuery(
    coordinatorEnvironment.snapshot({ environmentId, input: {} }),
  );
  const allowed = useAtomValue(coordinatorEnvironment.command.permissionAtom(environmentId));
  const execute = useAtomCommand(coordinatorEnvironment.command);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [showPermissions, setShowPermissions] = useState(false);
  const [mode, setMode] = useState<CoordinatorSnapshot["permissions"][number]["mode"]>("ask");
  const [permissionCategory, setPermissionCategory] = useState("file-read");
  const [permissionEffect, setPermissionEffect] = useState<"ask" | "allow" | "deny">("ask");
  const [expiry, setExpiry] = useState("");
  const [needsFailure, setNeedsFailure] = useState<string | null>(null);
  const dashboard = useCoordinatorDashboardEnabled();
  // The chat never waits on the snapshot, and a thread it does not manage is left as it is.
  // Every branch keeps the chat third among the same siblings, so it is mounted once.
  if (
    !data ||
    !data.configuration.enabled ||
    (data.configuration.coordinatorThreadId !== threadId && !coordinatorManages(data, threadId))
  )
    return (
      <>
        {null}
        {null}
        {children}
      </>
    );
  if (data.configuration.coordinatorThreadId !== threadId)
    return (
      <>
        <View className="gap-2 p-2">
          <Button
            label={`${data.configuration.labels.coordinatorSingular} permissions`}
            onPress={() => setShowPermissions(!showPermissions)}
          />
          {showPermissions && (
            <View className="gap-2">
              <Text>
                Approve for me can handle routine requests within existing access; broader or
                unverifiable requests are sent to you.
              </Text>
              {MODES.map(([value, label]) => (
                <Button
                  key={value}
                  label={`${mode === value ? "Selected: " : ""}${label}`}
                  disabled={!allowed || pending}
                  onPress={() => setMode(value)}
                />
              ))}
              {mode === "custom" && (
                <>
                  <Text>Permission category: {permissionCategory}</Text>
                  {COORDINATOR_PERMISSION_CATEGORIES.map((value) => (
                    <Button
                      key={value}
                      label={value}
                      onPress={() => setPermissionCategory(value)}
                    />
                  ))}
                  <Text>
                    Resource-specific and network rules are unavailable because request details are
                    not supported.
                  </Text>
                  {(["ask", "allow", "deny"] as const).map((value) => (
                    <Button
                      key={value}
                      label={`${permissionEffect === value ? "Selected: " : ""}${value}`}
                      onPress={() => setPermissionEffect(value)}
                    />
                  ))}
                </>
              )}
              <Field label="Expiry (ISO date, optional)" value={expiry} onChange={setExpiry} />
              <Button
                label="Save thread permissions"
                disabled={
                  !allowed ||
                  pending ||
                  (mode === "custom" && !permissionCategory.trim()) ||
                  (!!expiry && !Number.isFinite(Date.parse(expiry)))
                }
                onPress={async () => {
                  setPending(true);
                  const result = await execute({
                    environmentId,
                    input: {
                      type: "permissions.set",
                      policy: {
                        id: `thread-${threadId}`,
                        mode,
                        scope: { kind: "thread", id: threadId },
                        ...(mode === "custom"
                          ? {
                              rules: [
                                {
                                  category: permissionCategory,
                                  effect: permissionEffect,
                                  resource: null,
                                },
                              ],
                            }
                          : {}),
                        ...(expiry ? { expiresAt: Date.parse(expiry) } : {}),
                      },
                    },
                  }).finally(() => {
                    setPending(false);
                  });
                  setNotice(result._tag === "Success" ? "Saved." : "Could not save permissions.");
                }}
              />
              {notice && <Text>{notice}</Text>}
            </View>
          )}
        </View>
        {null}
        {children}
      </>
    );
  // The Coordinator is its thread: the chat, with what waits for the owner above it.
  return (
    <>
      <NeedsYou
        data={data}
        disabled={!allowed}
        failure={needsFailure}
        send={(input) => {
          setNeedsFailure(null);
          void execute({ environmentId, input }).then((result) => {
            if (result._tag === "Failure")
              setNeedsFailure(
                coordinatorFailure(Cause.squash(result.cause), data.configuration.labels),
              );
          });
        }}
      />
      {dashboard ? <CoordinatorDashboard environmentId={environmentId} data={data} /> : null}
      {children}
    </>
  );
}

/** What the Coordinator's work holds for the owner, above its thread while the rest goes on. */
function NeedsYou({
  data,
  disabled,
  failure,
  send,
}: {
  readonly data: CoordinatorSnapshot;
  readonly disabled: boolean;
  readonly failure: string | null;
  readonly send: (input: CoordinatorCommand) => void;
}) {
  const items = coordinatorNeedsOwner(data);
  if (items.length === 0) return null;
  return (
    <View className="gap-2 p-2">
      <Text>Needs you · {items.length}</Text>
      {failure && <Text>{failure}</Text>}
      {items.map((item) => (
        <View key={`${item.kind}:${item.id}`} className="gap-1">
          {item.kind === "approval" ? (
            <Approval
              id={item.id}
              origin={coordinatorPermissionOrigin(item.request, data)}
              reason={item.reason}
              disabled={disabled}
              send={send}
            />
          ) : item.kind === "grant" ? (
            <>
              <Text>Grant asked for: {item.reason}</Text>
              {/* Grant sends this grant as it stands, so all its authority is shown. */}
              <Text>
                {describeCoordinatorGrant(
                  item.grant,
                  item.grant.scope.kind === "project"
                    ? data.projects?.find((project) => project.id === item.grant.scope.id)?.title
                    : undefined,
                )}
              </Text>
              <Button
                label="Grant"
                disabled={disabled}
                onPress={() => send({ type: "grant.set", grant: item.grant })}
              />
              <Button
                label="Dismiss"
                disabled={disabled}
                onPress={() => send({ type: "grant.dismiss", grantId: item.id })}
              />
            </>
          ) : item.kind === "budget" ? (
            <>
              <Text>{item.reason}</Text>
              {item.goalId !== undefined && (
                <Button
                  label="Remove cap"
                  disabled={disabled}
                  onPress={() =>
                    send({
                      type: "board.budget",
                      target: { goalId: item.goalId! },
                      cap: { micros: null, seconds: null },
                    })
                  }
                />
              )}
            </>
          ) : item.kind === "merge" ? (
            <>
              <Text>Reviewed and waiting for you to merge: {item.reason}</Text>
              {item.canMerge ? (
                <Button
                  label="Merge"
                  disabled={disabled}
                  onPress={() => send({ type: "goal.merge", goalId: item.id })}
                />
              ) : (
                <Text>
                  Merge it yourself; {coordinatorInText(data.configuration.labels)} sees the merge.
                </Text>
              )}
            </>
          ) : (
            <>
              <Text>Finished work held by its result check: {item.reason}</Text>
              <Button
                label="Release to merge"
                disabled={disabled}
                onPress={() =>
                  send({ type: "result.accept", assignmentId: item.id, head: item.head })
                }
              />
              <Button
                label="Discard"
                disabled={disabled}
                onPress={() => send({ type: "result.discard", assignmentId: item.id })}
              />
            </>
          )}
        </View>
      ))}
    </View>
  );
}

/** Approve only an operation shown whole and escaped; any other is reviewed in its thread. */
function Approval({
  id,
  origin,
  reason,
  disabled,
  send,
}: {
  readonly id: string;
  readonly origin: ReturnType<typeof coordinatorPermissionOrigin>;
  readonly reason: string;
  readonly disabled: boolean;
  readonly send: (input: CoordinatorCommand) => void;
}) {
  return (
    <>
      <Text>
        Approval in {origin ? `${origin.thread} · ${origin.project}` : "a thread"}: {reason}
      </Text>
      {origin?.operation ? (
        <>
          <Text selectable className="font-mono text-xs">
            {origin.operation}
          </Text>
          <Button
            label="Approve"
            disabled={disabled}
            onPress={() => send({ type: "permission.respond", requestId: id, decision: "approve" })}
          />
        </>
      ) : (
        <Text className="text-xs">
          This request doesn't show its whole operation. Review it in its thread to approve it.
        </Text>
      )}
      <Button
        label="Deny"
        disabled={disabled}
        onPress={() => send({ type: "permission.respond", requestId: id, decision: "deny" })}
      />
    </>
  );
}

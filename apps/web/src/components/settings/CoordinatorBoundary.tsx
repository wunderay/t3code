import {
  coordinatorEmptyHeading,
  coordinatorManages,
} from "@t3tools/client-runtime/state/coordinator";
import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  coordinatorName,
  DEFAULT_COORDINATOR_LABELS,
  ThreadId,
  type CoordinatorLabels,
  type EnvironmentId,
} from "@t3tools/contracts";
import { WaypointsIcon } from "lucide-react";
import { Navigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { createContext, lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";
import { coordinatorEnvironment } from "../../state/coordinator";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";

// Loaded only once a snapshot calls for them, so a client with the Coordinator off never does.
const settings = () => import("./CoordinatorSettings");
const NeedsYou = lazy(() => settings().then((module) => ({ default: module.NeedsYou })));
const ThreadPermissions = lazy(() =>
  settings().then((module) => ({ default: module.ThreadPermissions })),
);
const PauseControl = lazy(() => settings().then((module) => ({ default: module.PauseControl })));
const CoordinatorDashboard = lazy(() =>
  import("../CoordinatorDashboard").then((module) => ({ default: module.CoordinatorDashboard })),
);

const lastSeenOnKey = (environmentId: EnvironmentId) => `t3code:coordinator-on:${environmentId}`;
const lastSeenOn = (environmentId: EnvironmentId) => {
  try {
    return getLocalStorageItem(lastSeenOnKey(environmentId), Schema.Boolean) === true;
  } catch {
    return false;
  }
};

function usePrimarySnapshot() {
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const query = useEnvironmentQuery(
    environmentId ? coordinatorEnvironment.snapshot({ environmentId, input: {} }) : null,
  );
  const enabled = query.data?.configuration.enabled;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- remembers the switch in localStorage for the next start's landing
  useEffect(() => {
    if (environmentId === null || enabled === undefined) return;
    try {
      setLocalStorageItem(lastSeenOnKey(environmentId), enabled, Schema.Boolean);
    } catch {
      // Without storage the next start lands as if the Coordinator were off.
    }
  }, [environmentId, enabled]);
  return { environmentId, ...query };
}

// How long the draft is held, from when the hold begins, for a snapshot that does not come.
const SNAPSHOT_WAIT_MS = 1500;

/**
 * The index never waits on the snapshot, and one that shows the Coordinator on moves to its
 * thread. Its draft waits only where the Coordinator was last seen on, so off pays no round trip,
 * and only briefly while the connection is coming or up, so a snapshot that cannot come never
 * blanks the index.
 */
export function CoordinatorLanding({
  children,
}: {
  readonly children: (holdDraft: boolean) => ReactNode;
}) {
  const { environmentId, data, error, isPending } = usePrimarySnapshot();
  // A first connect or an open one: after a failure, offline or idle, the snapshot is not coming.
  const phase = usePrimaryEnvironment()?.connection.phase;
  const coming = phase === undefined || phase === "connecting" || phase === "connected";
  const holding =
    environmentId !== null && coming && !data && !error && isPending && lastSeenOn(environmentId);
  const [waited, setWaited] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a timer bounds the hold on a snapshot that does not come
  useEffect(() => {
    if (!holding) return;
    const timer = setTimeout(() => setWaited(true), SNAPSHOT_WAIT_MS);
    return () => clearTimeout(timer);
  }, [holding]);
  if (environmentId && data?.configuration.enabled && data.configuration.coordinatorThreadId) {
    return (
      <Navigate
        to="/$environmentId/$threadId"
        params={{ environmentId, threadId: data.configuration.coordinatorThreadId }}
        replace
      />
    );
  }
  return children(holding && !waited);
}

/** The labels inside the Coordinator's own thread, which opens on its own empty state; else null. */
export const CoordinatorThreadLabels = createContext<typeof CoordinatorLabels.Type | null>(null);

/** The Coordinator's one mark, the same in its empty state, its thread's header and its row. */
export function CoordinatorMark({ className }: { readonly className?: string }) {
  return <WaypointsIcon aria-hidden className={cn("shrink-0 text-primary", className)} />;
}

/** What the Coordinator's thread shows above the composer before its first message. */
export function CoordinatorEmptyState({
  labels,
}: {
  readonly labels: typeof CoordinatorLabels.Type;
}) {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col items-center">
      <span className="mb-4 inline-flex size-10 items-center justify-center rounded-full bg-primary/10 [@media(max-height:28rem)]:hidden">
        <CoordinatorMark className="size-5" />
      </span>
      <h1 className="w-full text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl">
        {coordinatorEmptyHeading(labels)}
      </h1>
      <p className="mt-2 max-w-xl text-balance text-center text-muted-foreground text-sm">
        Plans the work, hands it to {labels.threadPlural} and follows them to merge. Dangerous or
        irreversible steps come to you.
      </p>
    </div>
  );
}

/** The Coordinator's thread on the primary environment while it is on, as a thread key. */
export const CoordinatorThreadKey = createContext<string | null>(null);

export function CoordinatorThreadKeyProvider({ children }: { readonly children: ReactNode }) {
  const thread = useCoordinatorThread();
  return (
    <CoordinatorThreadKey
      value={
        thread
          ? scopedThreadKey(scopeThreadRef(thread.environmentId, ThreadId.make(thread.threadId)))
          : null
      }
    >
      {children}
    </CoordinatorThreadKey>
  );
}

export function CoordinatorThreadBoundary({
  environmentId,
  threadId,
  children,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly children: ReactNode;
}) {
  // The chat never waits on the snapshot; Coordinator parts appear once it arrives.
  const { data } = useEnvironmentQuery(
    coordinatorEnvironment.snapshot({ environmentId, input: {} }),
  );
  const dashboard = useClientSettings((settings) => settings.coordinatorDashboard);
  // Switched off, the retained thread is an ordinary chat: no panel, chunk or board query.
  const own =
    data?.configuration.enabled === true && data.configuration.coordinatorThreadId === threadId;
  // One tree whatever arrives, so the chat is mounted once: on other threads the wrappers are
  // `contents` and lay out nothing, as on main; on the Coordinator's they are its layout.
  return (
    <div className={own ? "flex h-full min-h-0 flex-col" : "contents"}>
      {own && data ? (
        <Suspense fallback={null}>
          <NeedsYou environmentId={environmentId} data={data} />
        </Suspense>
      ) : null}
      <div className={own ? "flex min-h-0 flex-1 flex-col lg:flex-row" : "contents"}>
        {!own && data?.configuration.enabled && coordinatorManages(data, threadId) ? (
          <Suspense fallback={null}>
            <ThreadPermissions
              environmentId={environmentId}
              threadId={threadId}
              labels={data.configuration.labels}
            />
          </Suspense>
        ) : null}
        {own && data && dashboard ? (
          <Suspense fallback={null}>
            <CoordinatorDashboard environmentId={environmentId} data={data} />
          </Suspense>
        ) : null}
        {/* A column, as the chat's own slot is, so the chat fills it and its composer sits low. */}
        <div className={own ? "flex min-h-0 min-w-0 flex-1 flex-col lg:order-first" : "contents"}>
          <CoordinatorThreadLabels value={own && data ? data.configuration.labels : null}>
            {children}
          </CoordinatorThreadLabels>
        </div>
      </div>
    </div>
  );
}

/** The Coordinator's thread while it is on, for the command palette to open as the sidebar does. */
export function useCoordinatorThread() {
  const { environmentId, data } = usePrimarySnapshot();
  const threadId = data?.configuration.enabled ? data.configuration.coordinatorThreadId : null;
  return environmentId && data && threadId
    ? { environmentId, threadId, name: coordinatorName(data.configuration) }
    : null;
}

/** The primary environment's labels, the shipped ones until its snapshot arrives. */
export function useCoordinatorLabels() {
  return usePrimarySnapshot().data?.configuration.labels ?? DEFAULT_COORDINATOR_LABELS;
}

export function CoordinatorPauseControl() {
  const { environmentId, data } = usePrimarySnapshot();
  if (environmentId === null || !data?.configuration.enabled) return null;
  return (
    <Suspense fallback={null}>
      <PauseControl environmentId={environmentId} />
    </Suspense>
  );
}

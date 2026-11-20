import { createCoordinatorEnvironmentAtoms } from "@t3tools/client-runtime/state/coordinator";
import {
  DEFAULT_COORDINATOR_LABELS,
  type CoordinatorLabels,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";
import { useEnvironmentQuery } from "./query";

export const coordinatorEnvironment = createCoordinatorEnvironmentAtoms(connectionAtomRuntime);

// The labels a snapshot last showed, so a list that only names the Coordinator subscribes to
// nothing: with it off, Settings loads no more than it did before it had a page.
export const seenCoordinatorLabels = Atom.family((_environmentId: EnvironmentId | null) =>
  Atom.make<typeof CoordinatorLabels.Type>(DEFAULT_COORDINATOR_LABELS).pipe(Atom.keepAlive),
);

export function rememberCoordinatorLabels(
  environmentId: EnvironmentId,
  labels: typeof CoordinatorLabels.Type,
) {
  appAtomRegistry.set(seenCoordinatorLabels(environmentId), labels);
}

/** The labels last seen for an environment, the shipped ones until a snapshot shows them. */
export function useSeenCoordinatorLabels(environmentId: EnvironmentId | null) {
  return useAtomValue(seenCoordinatorLabels(environmentId));
}

/** An environment's labels for the Coordinator, the shipped ones until its snapshot arrives. */
export function useCoordinatorLabels(environmentId: EnvironmentId | null) {
  const { data } = useEnvironmentQuery(
    environmentId ? coordinatorEnvironment.snapshot({ environmentId, input: {} }) : null,
  );
  const labels = data?.configuration.labels;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the Settings list's name for the Coordinator current without a query of its own
  useEffect(() => {
    if (environmentId && labels) rememberCoordinatorLabels(environmentId, labels);
  }, [environmentId, labels]);
  return labels ?? DEFAULT_COORDINATOR_LABELS;
}

import { DEFAULT_COORDINATOR_LABELS, EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const { snapshot } = vi.hoisted(() => ({ snapshot: vi.fn() }));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@t3tools/client-runtime/state/coordinator", () => ({
  createCoordinatorEnvironmentAtoms: () => ({ snapshot }),
}));

import { appAtomRegistry } from "./atom-registry";
import { rememberCoordinatorLabels, seenCoordinatorLabels } from "./coordinator";

it("names the Coordinator from the last snapshot seen, without subscribing to one", () => {
  const environmentId = EnvironmentId.make("local");
  expect(appAtomRegistry.get(seenCoordinatorLabels(environmentId))).toEqual(
    DEFAULT_COORDINATOR_LABELS,
  );
  const labels = { ...DEFAULT_COORDINATOR_LABELS, coordinatorSingular: "Quartermaster" };
  rememberCoordinatorLabels(environmentId, labels);
  expect(appAtomRegistry.get(seenCoordinatorLabels(environmentId))).toEqual(labels);
  expect(snapshot).not.toHaveBeenCalled();
});

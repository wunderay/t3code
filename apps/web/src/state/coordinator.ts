import { createCoordinatorEnvironmentAtoms } from "@t3tools/client-runtime/state/coordinator";
import { connectionAtomRuntime } from "../connection/runtime";

export const coordinatorEnvironment = createCoordinatorEnvironmentAtoms(connectionAtomRuntime);

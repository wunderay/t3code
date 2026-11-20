import {
  type DesktopEnvironmentBootstrap,
  type EnvironmentId,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
} from "@t3tools/contracts";

import { isDesktopLocalConnectionTarget } from "../connection/desktopLocal";
import { useDesktopLocalBootstraps } from "../connection/useDesktopLocalBootstraps";
import { readLocalApi } from "../localApi";
import {
  type EnvironmentPresentation,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../state/environments";
import { parseWslUncPath } from "../wslPaths";

/**
 * Where the desktop app's folder picker browses for an environment, as adding a project picks
 * it: undefined when the folder is not on this machine (a browser client, a remote server),
 * where folders are typed instead; otherwise the desktop-local instance to target, or null for
 * the primary environment.
 */
export function nativeFolderPickerTarget(input: {
  readonly hasDesktopBridge: boolean;
  readonly environmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly environment: Pick<EnvironmentPresentation, "entry" | "displayUrl"> | undefined;
  readonly bootstraps: ReadonlyArray<
    Pick<DesktopEnvironmentBootstrap, "id" | "httpBaseUrl" | "runningDistro">
  >;
}): { readonly target: string | null; readonly distro?: string | null } | undefined {
  if (!input.hasDesktopBridge) return undefined;
  const environment = input.environment;
  const instance =
    environment !== undefined &&
    environment.displayUrl !== null &&
    isDesktopLocalConnectionTarget(environment.entry.target)
      ? input.bootstraps.find((bootstrap) => bootstrap.httpBaseUrl === environment.displayUrl)
      : undefined;
  if (instance !== undefined) {
    return { target: instance.id, distro: instance.runningDistro ?? null };
  }
  return input.environmentId === input.primaryEnvironmentId ? { target: null } : undefined;
}

/**
 * A picked folder as the server names it, or why it is not on the server's machine: a WSL path
 * picked from Windows is the server's own only in the WSL distro it runs in.
 */
export function pickedFolderPath(
  picked: string,
  distro: string | null,
): { readonly path: string } | { readonly problem: string } {
  const wsl = parseWslUncPath(picked);
  if (wsl !== null) {
    return distro !== null && wsl.distro.toLowerCase() === distro.toLowerCase()
      ? { path: wsl.linuxPath }
      : {
          problem: `That folder is in WSL's ${wsl.distro}, ${distro === null ? "not on this environment's machine" : `not in ${distro}, where this environment runs`}.`,
        };
  }
  if (distro !== null && /^(?:[A-Za-z]:[\\/]|\\\\)/.test(picked)) {
    return {
      problem: `That folder is on Windows, not in WSL's ${distro}, where this environment runs.`,
    };
  }
  return { path: picked };
}

/** Opens the OS-native folder picker for this environment, or undefined where there is none. */
export function useNativeFolderPicker(
  environmentId: EnvironmentId,
): (() => Promise<string | null>) | undefined {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const bootstraps = useDesktopLocalBootstraps();
  const picker = nativeFolderPickerTarget({
    hasDesktopBridge: typeof window !== "undefined" && window.desktopBridge !== undefined,
    environmentId,
    primaryEnvironmentId,
    environment: environments.find((candidate) => candidate.environmentId === environmentId),
    bootstraps,
  });
  if (picker === undefined) return undefined;
  return async () => {
    const picked = await readLocalApi()?.dialogs.pickFolder(
      picker.target === null ? undefined : { targetEnvironmentId: picker.target },
    );
    if (!picked) return null;
    // The primary environment's distro, when it runs in WSL, is the bridge's to say.
    const distro =
      picker.distro ??
      window.desktopBridge
        ?.getLocalEnvironmentBootstraps()
        .find((bootstrap) => bootstrap.id === PRIMARY_LOCAL_ENVIRONMENT_ID)?.runningDistro ??
      null;
    const resolved = pickedFolderPath(picked, distro);
    if ("problem" in resolved) throw new Error(resolved.problem);
    return resolved.path;
  };
}

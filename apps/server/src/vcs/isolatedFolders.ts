import * as Effect from "effect/Effect";

/**
 * Folders an isolated thread could write. The server's own git calls there, outside the
 * sandbox, must not run what the thread wrote: a nested repository's fsmonitor (reached through
 * submodule status) or a submodule fetch. Applied only while thread isolation is on, checked
 * at each call, so with it off git runs exactly as without it.
 */
const folders = new Set<string>();
let active: Effect.Effect<boolean> = Effect.succeed(false);

export const addIsolatedFolder = (folder: string) => {
  folders.add(folder.replace(/\/+$/, ""));
};

/** Thread isolation tells whether it is on, and loads the folders it recorded when it is. */
export const setIsolationActive = (check: Effect.Effect<boolean>) => {
  active = check;
};

/**
 * Git runs nothing a nested repository the thread made supplies, and no hook: a hook the thread
 * cannot write still runs scripts, package scripts and tools from the checkout it can. The
 * repository's own config and other configuration that runs commands are read-only to it.
 */
const HARDENED: ReadonlyArray<readonly [string, string]> = [
  ["core.fsmonitor", "false"],
  ["core.hooksPath", "/dev/null"],
  ["diff.ignoreSubmodules", "all"],
  ["status.submoduleSummary", "false"],
  ["submodule.recurse", "false"],
  ["fetch.recurseSubmodules", "false"],
  ["push.recurseSubmodules", "no"],
  ["protocol.ext.allow", "never"],
];

const related = (cwd: string, folder: string) =>
  cwd === folder || cwd.startsWith(`${folder}/`) || folder.startsWith(`${cwd}/`);

/** The configuration git runs with in `cwd`; none outside isolated folders or with isolation off. */
export const isolatedGitConfig = (
  cwd: string | undefined,
): Effect.Effect<ReadonlyArray<readonly [string, string]>> =>
  cwd === undefined
    ? Effect.succeed([])
    : Effect.map(active, (on) => {
        const at = cwd.replace(/\/+$/, "");
        return on && [...folders].some((folder) => related(at, folder)) ? HARDENED : [];
      });

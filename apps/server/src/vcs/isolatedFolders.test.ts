// @effect-diagnostics nodeBuiltinImport:off -- runs the real git against a repository a thread could have written.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { addIsolatedFolder, setIsolationActive } from "./isolatedFolders.ts";
import { explicitBareRepositoryEnv, isolatedFolderGitEnv } from "./VcsProcess.ts";

const folders: Array<string> = [];
afterEach(() => {
  for (const folder of folders.splice(0)) NodeFS.rmSync(folder, { recursive: true, force: true });
  setIsolationActive(Effect.succeed(false));
});

const git = (cwd: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = {}) =>
  NodeChildProcess.execFileSync(
    "git",
    ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args],
    { cwd, env: { ...process.env, ...env }, stdio: "pipe" },
  );

/** The reviewer's case: a nested repository whose fsmonitor runs when the outer one is polled. */
const nestedRepository = () => {
  const outer = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-iso-")));
  folders.push(outer);
  const marker = NodePath.join(outer, "..", `${NodePath.basename(outer)}-PWNED`);
  folders.push(marker);
  git(outer, ["init", "-q"]);
  const sub = NodePath.join(outer, "sub");
  NodeFS.mkdirSync(sub);
  git(sub, ["init", "-q"]);
  NodeFS.writeFileSync(NodePath.join(sub, "f"), "x");
  git(sub, ["add", "f"]);
  git(sub, ["commit", "-qm", "x"]);
  git(sub, ["config", "core.fsmonitor", `touch ${marker}; true`]);
  git(outer, ["add", "sub"]);
  return { outer, marker };
};

// What the server's status poll runs with.
const statusPoll = (cwd: string) =>
  Effect.gen(function* () {
    const base = { GIT_OPTIONAL_LOCKS: "0", ...explicitBareRepositoryEnv(process.env, "linux") };
    git(cwd, ["status", "--porcelain=2", "--branch", "-z"], {
      ...base,
      ...(yield* isolatedFolderGitEnv({ ...process.env, ...base }, cwd, "linux")),
    });
  });

it.effect(
  "runs a nested repository's fsmonitor on the host in a folder that was never isolated",
  () =>
    Effect.gen(function* () {
      const { outer, marker } = nestedRepository();
      yield* statusPoll(outer);
      assert.isTrue(NodeFS.existsSync(marker));
    }),
);

it.effect("leaves git as it is in a recorded folder while isolation is off", () =>
  Effect.gen(function* () {
    const { outer, marker } = nestedRepository();
    addIsolatedFolder(outer);
    yield* statusPoll(outer);
    assert.isTrue(NodeFS.existsSync(marker));
  }),
);

it.effect("runs nothing a thread's nested repository supplies", () =>
  Effect.gen(function* () {
    const { outer, marker } = nestedRepository();
    addIsolatedFolder(outer);
    setIsolationActive(Effect.succeed(true));
    yield* statusPoll(outer);
    assert.isFalse(NodeFS.existsSync(marker));
  }),
);

it.effect("runs no hook in an isolated folder: a hook runs scripts the thread can write", () =>
  Effect.gen(function* () {
    const repository = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-iso-")),
    );
    const marker = `${repository}-PWNED`;
    folders.push(repository, marker);
    git(repository, ["init", "-q"]);
    // Set up as husky does: the hook is the owner's, and what it runs is in the checkout.
    git(repository, ["config", "core.hooksPath", ".husky"]);
    NodeFS.mkdirSync(NodePath.join(repository, ".husky"));
    NodeFS.mkdirSync(NodePath.join(repository, "scripts"));
    const hook = (name: string, body: string) =>
      NodeFS.writeFileSync(NodePath.join(repository, ".husky", name), `#!/bin/sh\n${body}\n`, {
        mode: 0o755,
      });
    hook("pre-commit", "sh scripts/check.sh");
    hook("post-commit", "sh scripts/check.sh");
    const script = NodePath.join(repository, "scripts", "check.sh");
    NodeFS.writeFileSync(script, "true\n");
    git(repository, ["add", "."]);
    git(repository, ["commit", "-qm", "owner"]);
    // The thread changes only the script, which it may write.
    NodeFS.writeFileSync(script, `touch ${marker}\n`);
    addIsolatedFolder(repository);
    const commit = Effect.gen(function* () {
      const base = explicitBareRepositoryEnv(process.env, "linux");
      git(repository, ["commit", "-qam", "thread"], {
        ...base,
        ...(yield* isolatedFolderGitEnv({ ...process.env, ...base }, repository, "linux")),
      });
    });
    setIsolationActive(Effect.succeed(true));
    yield* commit;
    assert.isFalse(NodeFS.existsSync(marker));
    // With isolation off the same commit runs the hooks, as it always did.
    setIsolationActive(Effect.succeed(false));
    NodeFS.appendFileSync(script, "\n");
    yield* commit;
    assert.isTrue(NodeFS.existsSync(marker));
  }),
);

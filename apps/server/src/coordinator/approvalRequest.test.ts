import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { approvalBounds, resolvedApprovalBounds } from "./approvalRequest.ts";

const root = "/work/tree";

it.effect("an approval's paths and access are read from the operation its provider stated", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const bounds = (operation: string | undefined, at: string | undefined = root) =>
      approvalBounds(path, operation, at);
    const unknown = { requestedAccess: 2 as const, accessIncreaseUnknown: true, unparsed: true };
    // Claude: the tool and its input.
    assert.deepEqual(bounds(`Edit {"file_path":"/work/tree/src/a.ts","new_string":"x"}`), {
      requestedAccess: 1,
      accessIncreaseUnknown: false,
      resource: "src/a.ts",
      paths: ["src/a.ts"],
      deletes: [],
      outsideWorkspace: false,
      unparsed: false,
    });
    assert.deepInclude(bounds(`Read {"file_path":"/work/tree/README.md"}`), {
      requestedAccess: 0,
      resource: "README.md",
    });
    assert.deepInclude(bounds(`Write {"file_path":"/etc/hosts","content":""}`), {
      resource: "/etc/hosts",
      outsideWorkspace: true,
    });
    assert.deepInclude(bounds(`Bash {"command":"rm -f src/old.ts && git rm -r docs"}`), {
      requestedAccess: 1,
      resource: ".",
      deletes: ["src/old.ts", "docs"],
      command: "rm -f src/old.ts && git rm -r docs",
      outsideWorkspace: false,
    });
    assert.deepInclude(bounds(`Bash {"command":"rm -rf ~/.cache"}`), {
      deletes: ["~/.cache"],
      outsideWorkspace: true,
      unparsed: true,
    });
    // Wrappers are unwrapped; what is not on the closed list is left unparsed for the
    // Coordinator, and what reaches outside shows as outside, whatever the wrapper.
    const shell = (command: string) => bounds(`Bash ${JSON.stringify({ command })}`);
    assert.deepInclude(shell(`bash -lc "rm -rf /"`), {
      deletes: ["/"],
      outsideWorkspace: true,
    });
    assert.deepInclude(shell(`sh -c 'env FOO=1 rm src/a.ts'`), {
      deletes: ["src/a.ts"],
      unparsed: false,
    });
    for (const command of [
      "xargs rm < list",
      "find . -delete",
      "cd .. && x",
      "/bin/rm src/a.ts",
      "rm $HOME",
      "cat <(ls)",
      "echo `id`",
      "git clean -fd",
      "env",
      "bash script.sh",
      "sh -c 'echo $(id)'",
      'echo "unterminated',
    ])
      assert.equal(shell(command).unparsed, true, command);
    assert.deepInclude(shell("cd .. && x"), { outsideWorkspace: true });
    assert.deepInclude(shell("echo hi > /etc/x"), {
      paths: [".", "/etc/x", "hi"],
      outsideWorkspace: true,
      unparsed: false,
    });
    assert.deepInclude(shell("vp test 2>&1 | tail -n 20 > out.txt"), {
      outsideWorkspace: false,
      unparsed: false,
    });
    // A path an option carries is reached, in its short, joined and long forms.
    for (const command of [
      "sort -o /outside/file inside.txt",
      "sort -o/outside/file inside.txt",
      "sort -ro../file inside.txt",
      "sort -o=/outside/file inside.txt",
      "sort --output /outside/file inside.txt",
      "sort --output=/outside/file inside.txt",
      "sort --output=.. inside.txt",
    ])
      assert.equal(shell(command).outsideWorkspace, true, command);
    // Which letter of a cluster takes a value is not known, so every tail is a path reached,
    // and so is an argument that starts with a dash.
    assert.deepInclude(shell("sort --output=123 -oab -n5 -la inside.txt"), {
      paths: [".", "123", "inside.txt", "--output=123", "-oab", "ab", "b", "-n5", "5", "-la", "a"],
      outsideWorkspace: false,
    });
    // A tail stops being a candidate where the cluster's letters end.
    assert.deepEqual(shell("sort -m'fix: a thing' x").paths, [
      ".",
      "x",
      "-mfix: a thing",
      "fix: a thing",
      "ix: a thing",
      "x: a thing",
      ": a thing",
    ]);
    // Where `..` leads after a named folder depends on what that folder is: not the rule's.
    for (const command of [
      "sort -o link/../x inside.txt",
      "cat a/./../b",
      "cat x > d/../y",
      "cat .../../x",
    ])
      assert.equal(shell(command).unparsed, true, command);
    for (const operation of [
      `Write {"file_path":"/work/tree/link/../x","content":""}`,
      `Glob {"pattern":"/work/tree/link/../*"}`,
      `{"command":"ls","cwd":"/work/tree/link/.."}`,
    ])
      assert.equal(bounds(operation).unparsed, true, operation);
    for (const command of ["cat ../x", "cat ./a/b", "cat a..b/c"])
      assert.equal(shell(command).unparsed, false, command);
    // A backslash in double quotes stays in the name, as in single quotes.
    for (const command of [
      String.raw`sort -o"out\file" inside.txt`,
      String.raw`sort -o'out\file' inside.txt`,
    ])
      assert.include(shell(command).paths ?? [], String.raw`out\file`, command);
    assert.include(shell(String.raw`cat "a\"b"`).paths ?? [], 'a"b');
    // An escaped backslash before a line end keeps both; a lone one joins the lines.
    assert.include(shell('sort -o"out\\\\\nfile" inside.txt').paths ?? [], "out\\\nfile");
    assert.include(shell('sort -o"out\\\nfile" inside.txt').paths ?? [], "outfile");
    // An unquoted backslash before a line end joins the lines, as the shell does.
    assert.equal(shell("cat .\\\n./x").outsideWorkspace, true);
    assert.equal(shell("cat x\\").unparsed, true);
    assert.include(shell("echo ok #\\\nrm -f src/a.ts").deletes ?? [], "src/a.ts");
    assert.include(shell("cat a#b").paths ?? [], "a#b");
    for (const gap of ["\r", "\f", "\v", "\u00a0"])
      assert.include(shell(`echo ok${gap}#; rm -f src/a.ts`).deletes ?? [], "src/a.ts", gap);
    // Flags joined to a remover delete nothing of their own.
    assert.deepInclude(shell("rm -rf build"), { deletes: ["build"], outsideWorkspace: false });
    // Discarded output reaches no file: a routine command stays the rule's to answer.
    assert.deepInclude(shell("npm test 2>/dev/null"), {
      paths: [".", "test"],
      outsideWorkspace: false,
      unparsed: false,
    });
    // A pattern that starts outside the folder reads where it starts.
    assert.deepInclude(bounds(`Glob {"pattern":"/etc/**/*.conf"}`), {
      paths: [".", "/etc"],
      outsideWorkspace: true,
    });
    // Codex: the command and its folder; the network asks for more than the sandbox gives.
    assert.deepInclude(bounds(`{"command":"vp test && git status","cwd":"/work/tree/src"}`), {
      requestedAccess: 1,
      resource: "src",
      unparsed: false,
      outsideWorkspace: false,
    });
    assert.deepInclude(
      bounds(`{"command":"curl x","cwd":"/work/tree","networkApprovalContext":{"host":"x"}}`),
      { requestedAccess: 2, accessIncreaseUnknown: false },
    );
    assert.deepInclude(bounds(`{"command":"ls","cwd":"/tmp"}`), {
      resource: "/tmp",
      outsideWorkspace: true,
    });
    // Anything else is a request for full access whose reach is unknown.
    for (const operation of [
      undefined,
      "vp test && rm -rf ~",
      `WebFetch {"url":"https://example.com"}`,
      `{"permissions":{"network":true}}`,
      `Edit {"file_path":7}`,
    ])
      assert.deepEqual(bounds(operation), unknown, operation);
    assert.deepEqual(approvalBounds(path, `Bash {"command":"ls"}`, undefined), unknown);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a path through a link out of the checkout counts as outside it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = yield* fs.makeTempDirectoryScoped();
    const tree = path.join(base, "tree");
    const elsewhere = path.join(base, "elsewhere");
    yield* fs.makeDirectory(path.join(tree, "src"), { recursive: true });
    yield* fs.makeDirectory(elsewhere);
    yield* fs.symlink(elsewhere, path.join(tree, "src", "out"));
    const edit = (file: string) =>
      resolvedApprovalBounds(`Write {"file_path":${JSON.stringify(file)},"content":""}`, tree);
    // The file need not exist: its nearest existing folder is what is resolved.
    assert.deepInclude(yield* edit(path.join(tree, "src", "new", "a.ts")), {
      resource: "src/new/a.ts",
      outsideWorkspace: false,
    });
    // An output file an option carries is resolved too, in every form.
    yield* fs.symlink(path.join(elsewhere, "file"), path.join(tree, "escape"));
    yield* fs.symlink(path.join(elsewhere, "file"), path.join(tree, "123"));
    yield* fs.symlink(path.join(elsewhere, "file"), path.join(tree, "-escape"));
    yield* fs.symlink(path.join(elsewhere, "file"), path.join(tree, "--escape"));
    for (const command of [
      "sort -oescape inside.txt",
      "sort -o123 inside.txt",
      "sort --output=123 inside.txt",
      "sort -o 123 inside.txt",
      "sort -ro123 inside.txt",
      "sort -o -escape inside.txt",
      "sort --output --escape inside.txt",
      "cat -- -escape",
    ])
      assert.equal(
        (yield* resolvedApprovalBounds(`Bash ${JSON.stringify({ command })}`, tree))
          .outsideWorkspace,
        true,
        command,
      );
    assert.equal(
      (yield* resolvedApprovalBounds(`Bash {"command":"sort -n5 -r inside.txt"}`, tree))
        .outsideWorkspace,
      false,
    );
    const escaped = yield* edit(path.join(tree, "src", "out", "a.ts"));
    assert.equal(escaped.outsideWorkspace, true);
    assert.isTrue(escaped.resource?.endsWith(path.join("elsewhere", "a.ts")));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

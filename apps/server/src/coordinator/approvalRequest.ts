import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** What an approval asks for, read from the operation its provider stated. */
export interface ApprovalBounds {
  readonly requestedAccess: 0 | 1 | 2;
  readonly accessIncreaseUnknown: boolean;
  /** Paths relative to the thread's checkout; one outside it stays absolute. */
  readonly resource?: string;
  readonly paths?: ReadonlyArray<string>;
  readonly deletes?: ReadonlyArray<string>;
  readonly command?: string;
  readonly outsideWorkspace?: boolean;
  /** Not a command the host answers by rule: the Coordinator answers it, or the owner. */
  readonly unparsed?: boolean;
}

const UNKNOWN: ApprovalBounds = { requestedAccess: 2, accessIncreaseUnknown: true, unparsed: true };

const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

const parseObject = (text: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

interface Segment {
  readonly words: Array<string>;
  readonly redirects: Array<string>;
}

/**
 * A command as a shell would split it, quotes removed. Undefined when it cannot be read whole;
 * `dynamic` when the shell would expand or nest something, so its reach is not in the text.
 */
const lex = (text: string): { segments: Array<Segment>; dynamic: boolean } | undefined => {
  const segments: Array<Segment> = [];
  let segment: Segment = { words: [], redirects: [] };
  let word = "";
  let started = false;
  let redirect = false;
  let dynamic = false;
  const end = () => {
    if (started) {
      // Output sent to /dev/null reaches no file.
      if (!redirect) segment.words.push(word);
      else if (word !== "/dev/null") segment.redirects.push(word);
      redirect = false;
    }
    word = "";
    started = false;
  };
  const close = () => {
    end();
    if (segment.words.length || segment.redirects.length) segments.push(segment);
    segment = { words: [], redirects: [] };
  };
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (character === "'") {
      const closing = text.indexOf("'", index + 1);
      if (closing < 0) return undefined;
      word += text.slice(index + 1, closing);
      started = true;
      index = closing;
    } else if (character === '"') {
      let closing = index + 1;
      for (; closing < text.length && text[closing] !== '"'; closing++) {
        if (text[closing] === "\\") closing++;
        else if ("$`".includes(text[closing]!)) dynamic = true;
      }
      if (closing >= text.length) return undefined;
      // Inside double quotes a backslash is itself, except before these; one joins two lines.
      for (let at = index + 1; at < closing; at++) {
        const next = text[at + 1] ?? "";
        if (text[at] !== "\\" || !'$`"\\\n'.includes(next)) word += text[at];
        else if (++at && next !== "\n") word += next;
      }
      started = true;
      index = closing;
    } else if (character === "#" && !started) {
      // A comment runs to the line's end, backslash and all; the next line is a command.
      const line = text.indexOf("\n", index);
      if (line < 0) break;
      index = line - 1;
    } else if (character === "\\") {
      // Before a line end it joins the two lines; ending the text it escapes nothing.
      if (index + 1 >= text.length) return undefined;
      if (text[++index] !== "\n") {
        word += text[index];
        started = true;
      }
    } else if (character === " " || character === "\t") {
      // Only these break a word in the shell; a carriage return stays inside one.
      end();
    } else if ("|&;\n".includes(character)) {
      close();
    } else if (character === ">" || character === "<") {
      // `2>` names a descriptor; `>&1` duplicates one and names no file.
      if (/^\d+$/.test(word)) [word, started] = ["", false];
      end();
      if (text[index + 1] === "(") dynamic = true;
      while (text[index + 1] === ">") index++;
      if (text[index + 1] === "&") {
        index++;
        while (/\d/.test(text[index + 1] ?? "")) index++;
      } else redirect = true;
    } else {
      if ("$`*?[{}()~".includes(character)) dynamic = true;
      word += character;
      started = true;
    }
  }
  close();
  return { segments, dynamic };
};

const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);
const READERS = new Set([
  "cat",
  "head",
  "tail",
  "wc",
  "ls",
  "grep",
  "rg",
  "diff",
  "stat",
  "file",
  "tree",
  "pwd",
  "echo",
  "true",
  "false",
  "which",
  "sort",
  "uniq",
  "cut",
  "basename",
  "dirname",
  "mkdir",
  "touch",
]);
const REMOVERS = new Set(["rm", "rmdir", "unlink"]);
const FIND_ACTIONS = new Set([
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-delete",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
]);
const GIT_READS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "rev-parse",
  "ls-files",
  "blame",
  "grep",
  "describe",
  "merge-base",
  "show-ref",
  "cat-file",
]);
/** Build, test, format and lint tools, by the subcommands that only do that. */
const TOOLS: Record<string, ReadonlySet<string> | undefined> = {
  vp: new Set(["test", "check", "fmt", "lint", "run", "typecheck"]),
  npm: new Set(["test", "run"]),
  pnpm: new Set(["test", "run"]),
  yarn: new Set(["test", "run"]),
  cargo: new Set(["build", "test", "check", "clippy", "fmt", "doc"]),
  go: new Set(["build", "test", "vet", "fmt"]),
};
const STANDALONE = new Set([
  "pytest",
  "tsc",
  "eslint",
  "prettier",
  "oxlint",
  "ruff",
  "black",
  "mypy",
]);

/**
 * The commands of a segment after its wrappers (`env`, `bash -lc`, `sh -c`): each with its name
 * and operands, or undefined when one of them is not on the closed list the host answers.
 */
const unwrap = (words: ReadonlyArray<string>): Array<Array<string>> | undefined => {
  let rest = [...words];
  while (rest[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0])) rest = rest.slice(1);
  const [name, ...args] = rest;
  if (name === undefined) return [];
  if (name === "env") {
    const inner = args.filter((arg) => !arg.startsWith("-"));
    return inner.length ? unwrap(inner) : undefined;
  }
  if (SHELLS.has(name)) {
    const flag = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
    const script = flag < 0 ? undefined : args[flag + 1];
    const inner = script === undefined ? undefined : lex(script);
    if (!inner || inner.dynamic || inner.segments.some((part) => part.redirects.length))
      return undefined;
    const commands = inner.segments.map((part) => unwrap(part.words));
    return commands.every((command) => command !== undefined) ? commands.flat() : undefined;
  }
  return [rest];
};

/** Operands, with the value of `--output=x`. */
const operandsOf = (args: ReadonlyArray<string>) =>
  args.flatMap((arg) => {
    if (!arg.startsWith("-") || arg === "-" || arg === "--") return [arg];
    const at = arg.startsWith("--") ? arg.indexOf("=") : -1;
    return at < 0 || at === arg.length - 1 ? [] : [arg.slice(at + 1)];
  });

/** No path is longer, so a longer tail names no file. */
const PATH_MAX = 4096;

/**
 * What an option may carry: a dash argument may itself be the value of the option before it,
 * and in a short cluster (`-ofile`, `-ro../x`) any letter may take the tail as its value. A tail
 * of flags reads as a file in the working folder: further out than it is at worst, never inside.
 */
const carriedBy = (args: ReadonlyArray<string>) =>
  args.flatMap((arg) => {
    if (!arg.startsWith("-") || arg === "-" || arg === "--") return [];
    if (arg.startsWith("--")) return [arg];
    // The value starts after any of the leading letters or digits, or after an `=` there.
    const letters = /^-[A-Za-z0-9]*=?/.exec(arg)![0].length;
    const tails = Array.from({ length: Math.min(letters, arg.length - 1) - 1 }, (_, index) =>
      arg.slice(index + 2),
    );
    return [arg, ...tails].filter((tail) => tail.length <= PATH_MAX);
  });

/** A `..` after a named folder: where it leads depends on what that folder really is. */
const climbsOut = (target: string) =>
  /(^|\/)(?!\.{1,2}(\/|$))[^/]+\/+(\.\/+)*\.\.(\/|$)/.test(target);

/** Whether the host may answer this one command by rule, given its operands. */
const listed = (command: ReadonlyArray<string>) => {
  const [name, sub, ...more] = command;
  if (!name || name.includes("/")) return false;
  if (name === "cd" || READERS.has(name) || REMOVERS.has(name) || STANDALONE.has(name)) return true;
  if (name === "find") return !command.some((arg) => FIND_ACTIONS.has(arg));
  if (name === "git") return sub !== undefined && (GIT_READS.has(sub) || sub === "rm");
  if (/^python3?$/.test(name)) return sub === "-m" && more[0] === "pytest";
  return sub !== undefined && TOOLS[name]?.has(sub) === true;
};

/** The drivers whose approval requests state an operation `approvalBounds` reads. */
export const statesOperation = (driver: string) => driver === "codex" || driver === "claudeAgent";

/**
 * Codex states a command with its folder, Claude a tool and its input
 * (`claudeApprovalOperation`). Anything else is answered by its kind alone, as a request for
 * full access whose reach is unknown.
 */
export const approvalBounds = (
  path: Path.Path,
  operation: string | undefined,
  root: string | undefined,
  real: (absolute: string) => string = (absolute) => absolute,
): ApprovalBounds => {
  if (!operation || !root) return UNKNOWN;
  let access: 0 | 1 | 2;
  let command: string | undefined;
  let cwd = root;
  let targets: ReadonlyArray<unknown> = [];
  const tool = /^([A-Za-z][\w.-]*) (\{[\s\S]*\})$/.exec(operation);
  const claude = tool ? parseObject(tool[2]!) : undefined;
  const codex = tool ? undefined : parseObject(operation);
  if (tool && claude) {
    const name = tool[1]!;
    if (name === "Bash" && typeof claude.command === "string") {
      access = 1;
      command = claude.command;
    } else if (READ_TOOLS.has(name) || WRITE_TOOLS.has(name)) {
      access = READ_TOOLS.has(name) ? 0 : 1;
      targets = [claude.file_path ?? claude.notebook_path ?? claude.path ?? root];
      // A pattern that starts outside the folder reads where it starts.
      const pattern = name === "Glob" ? claude.pattern : undefined;
      if (typeof pattern === "string" && (pattern.startsWith("/") || pattern.includes("..")))
        targets = [...targets, pattern.split(/[*?[{]/)[0] || "/"];
    } else return UNKNOWN;
  } else if (codex && (typeof codex.command === "string" || Array.isArray(codex.command))) {
    command = Array.isArray(codex.command) ? codex.command.join(" ") : `${codex.command}`;
    if (typeof codex.cwd === "string") cwd = codex.cwd;
    // A command that needs the network asks for more than its sandbox gives.
    access = codex.networkApprovalContext || codex.proposedNetworkPolicyAmendments ? 2 : 1;
  } else return UNKNOWN;
  if (!targets.every((target) => typeof target === "string")) return UNKNOWN;
  // A tool's own path or folder that climbs out through a link is not read by its spelling.
  let unparsed = [cwd, ...(targets as ReadonlyArray<string>)].some(climbsOut);
  const reached: Array<string> = [];
  const removed: Array<string> = [];
  if (command) {
    // Each command's folder, operands and redirect targets are what it reaches.
    const lexed = lex(command);
    if (!lexed || lexed.dynamic) unparsed = true;
    let at = cwd;
    const resolveAt = (target: string) =>
      /^[~$]/.test(target) ? target : path.resolve(at, target);
    for (const segment of lexed?.segments ?? []) {
      reached.push(...segment.redirects.map(resolveAt));
      const commands = unwrap(segment.words);
      if (!commands) unparsed = true;
      for (const words of commands ?? [segment.words]) {
        if (!listed(words)) unparsed = true;
        const [name, sub] = words;
        const git = name === "git";
        const args = words.slice(git ? 2 : 1);
        const operands = operandsOf(args).map(resolveAt);
        const carried = carriedBy(args);
        if ([...segment.redirects, ...args].some(climbsOut)) unparsed = true;
        reached.push(at, ...operands, ...carried.map(resolveAt));
        if ((name && REMOVERS.has(name)) || (git && sub === "rm")) removed.push(...operands);
        if (name === "cd") at = operands[0] ?? root;
      }
    }
  }
  // A home folder or a variable could name any folder, so it counts as outside.
  const relative = (target: string) => {
    if (/^[~$]/.test(target)) return target;
    const absolute = real(path.resolve(cwd, target));
    const inside = path.relative(real(root), absolute);
    return inside.startsWith("..") || path.isAbsolute(inside)
      ? absolute
      : inside.split(path.sep).join("/") || ".";
  };
  const paths = [
    ...new Set((command ? [cwd, ...reached] : (targets as ReadonlyArray<string>)).map(relative)),
  ];
  const deletes = removed.map(relative);
  return {
    requestedAccess: access,
    accessIncreaseUnknown: false,
    resource: paths[0]!,
    paths,
    deletes,
    ...(command ? { command } : {}),
    unparsed,
    outsideWorkspace: [...paths, ...deletes].some(
      (item) => path.isAbsolute(item) || /^[~$]/.test(item),
    ),
  };
};

/**
 * The real path of a path that may not exist yet: its nearest existing folder, resolved. A link
 * whose target does not exist yet is followed too, since writing through it creates that target.
 */
const nearestReal = Effect.fn("nearestReal")(function* (target: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const followed = new Set<string>();
  const rest: Array<string> = [];
  for (let current = target; ;) {
    const found = yield* fs.realPath(current).pipe(Effect.option);
    if (found._tag === "Some") return path.join(found.value, ...rest.toReversed());
    const link = yield* fs.readLink(current).pipe(Effect.option);
    if (link._tag === "Some" && !followed.has(current)) {
      followed.add(current);
      current = path.resolve(path.dirname(current), link.value);
      continue;
    }
    if (path.dirname(current) === current) return target;
    rest.push(path.basename(current));
    current = path.dirname(current);
  }
});

/**
 * As `approvalBounds`, with every path through its real location, so a link inside the
 * checkout that leads out of it counts as outside.
 */
export const resolvedApprovalBounds = Effect.fn("resolvedApprovalBounds")(function* (
  operation: string | undefined,
  root: string | undefined,
) {
  const path = yield* Path.Path;
  const asked = new Set<string>();
  approvalBounds(path, operation, root, (absolute) => {
    asked.add(absolute);
    return absolute;
  });
  const real = new Map<string, string>();
  for (const absolute of asked) real.set(absolute, yield* nearestReal(absolute));
  return approvalBounds(path, operation, root, (absolute) => real.get(absolute) ?? absolute);
});

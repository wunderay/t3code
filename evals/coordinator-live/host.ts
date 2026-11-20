// An eval harness, not server code: it starts a T3 Code server as a child process, drives it over
// its WebSocket and MCP endpoints, and reads the puppet provider's files.
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalFetch:off globalTimers:off globalRandom:off cryptoRandomUUID:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import type { ToolSpec } from "../shared/chat.ts";

const PUPPET = NodePath.join(import.meta.dirname, "puppet.mjs");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Json = Record<string, any>;

/** The toy project the ad-hoc test used: a small Node library with tests and a README. */
const TOY: Record<string, string> = {
  "package.json": `{\n  "name": "toy",\n  "version": "0.1.0",\n  "type": "module",\n  "scripts": { "test": "node --test" }\n}\n`,
  "src/math.js": "export const add = (a, b) => a + b;\nexport const subtract = (a, b) => a - b;\n",
  "src/greet.js": "export const greet = (name) => `Hello, ${name}!`;\n",
  "test/math.test.js": `import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { add, subtract } from "../src/math.js";\n\ntest("add", () => assert.equal(add(2, 3), 5));\ntest("subtract", () => assert.equal(subtract(5, 3), 2));\n`,
  "README.md":
    "# Toy\n\nA toy library: `src/math.js` (add, subtract) and `src/greet.js` (greet).\nRun the tests with `npm test`.\n",
  "docs/notes.md": "# Notes\n\n- multiply and divide are not written yet.\n- greet has no test.\n",
  ".gitignore": "node_modules/\n",
};

export const git = (cwd: string, ...args: Array<string>) =>
  NodeChildProcess.execFileSync(
    "git",
    ["-c", "user.name=Toy Owner", "-c", "user.email=owner@example.invalid", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
/** Whether `npm test` passes in a checkout. */
export const testsPass = (cwd: string) =>
  NodeChildProcess.spawnSync("npm", ["test"], { cwd, stdio: "ignore" }).status === 0;

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = NodeNet.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as NodeNet.AddressInfo;
      server.close(() => resolve(port));
    });
  });

/** A call on the server's WebSocket RPC, as the web client makes it, with the owner's session. */
const connect = async (origin: string, token: string) => {
  const response = await fetch(`${origin}/api/auth/websocket-ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  const { ticket } = (await response.json()) as { ticket: string };
  const socket = new WebSocket(
    `${origin.replace("http", "ws")}/ws?orchestrationProtocol=2&wsTicket=${encodeURIComponent(ticket)}`,
  );
  const waiting = new Map<
    string,
    { resolve: (exit: Json) => void; onChunk?: (value: Json) => void }
  >();
  let next = 1;
  socket.addEventListener("message", (event) => {
    const decoded = JSON.parse(String(event.data));
    for (const message of Array.isArray(decoded) ? decoded : [decoded]) {
      if (message._tag === "Ping") socket.send(JSON.stringify({ _tag: "Pong" }));
      const entry = waiting.get(String(message.requestId));
      if (!entry) continue;
      if (message._tag === "Chunk") {
        for (const value of message.values) entry.onChunk?.(value);
        socket.send(JSON.stringify({ _tag: "Ack", requestId: message.requestId }));
      } else if (["Exit", "Defect", "ClientProtocolError"].includes(message._tag)) {
        waiting.delete(String(message.requestId));
        entry.resolve(message._tag === "Exit" ? message.exit : { _tag: "Failure", cause: message });
      }
    }
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error(`could not open ${origin}/ws`)), {
      once: true,
    });
  });
  const call = (tag: string, payload: Json, onChunk?: (value: Json) => void) =>
    new Promise<Json>((resolve) => {
      const id = String(next++);
      waiting.set(id, { resolve, ...(onChunk ? { onChunk } : {}) });
      socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    });
  /** The value of a call that succeeded; throws what the server said otherwise. */
  const value = async (tag: string, payload: Json) => {
    const exit = await call(tag, payload);
    if (exit._tag === "Success") return exit.value as Json;
    throw new Error(`${tag}: ${JSON.stringify(exit)}`);
  };
  return { call, value, close: () => socket.close() };
};

/** The MCP endpoint with the credential the host gave one provider session, as its own client. */
const mcpClient = async (meta: Json) => {
  const env = Object.fromEntries(
    (meta.mcpServers ?? []).flatMap((server: Json) =>
      (server.env ?? []).map((item: Json) => [item.name, item.value]),
    ),
  );
  const endpoint = env.T3_ACP_MCP_ENDPOINT as string;
  const authorization = env.T3_ACP_MCP_AUTHORIZATION as string;
  if (!endpoint || !authorization)
    throw new Error(`Session ${meta.sid} was given no T3 MCP server.`);
  let sessionId: string | undefined;
  let id = 1;
  const post = async (body: Json) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify(body),
    });
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    const text = await response.text();
    if (!response.ok) throw new Error(`MCP ${response.status}: ${text}`);
    if (!response.headers.get("content-type")?.includes("text/event-stream"))
      return text ? (JSON.parse(text) as Json) : {};
    const messages = text
      .split(/\r?\n\r?\n/)
      .map((event) =>
        event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n"),
      )
      .filter(Boolean)
      .map((data) => JSON.parse(data) as Json);
    return messages.findLast((message) => message.id !== undefined && !message.method) ?? {};
  };
  const request = (method: string, params: Json) =>
    post({ jsonrpc: "2.0", id: id++, method, params });
  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "coordinator-live-eval", version: "0" },
  });
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  return request;
};

export interface Session {
  readonly sid: string;
  readonly home: string;
  readonly cwd: string;
  readonly meta: Json;
  readonly state: string;
  readonly turn: number;
}
export type Host = Awaited<ReturnType<typeof startHost>>;

// Every server started and not yet stopped, from the moment it is spawned.
const stops = new Set<() => Promise<unknown>>();
export const stopHosts = () => Promise.all([...stops].map((stop) => stop()));

/**
 * One isolated server on a fresh toy repository in `dir`, the Coordinator switched on and its own
 * thread on the puppet provider. `threads` puts delegated work on the puppet too, or on Claude.
 */
export const startHost = async (options: {
  readonly dir: string;
  readonly server: string;
  readonly threads: "scripted" | "real";
  readonly onBoard: (board: Json) => void;
}) => {
  const { dir, server, threads } = options;
  const repo = NodePath.join(dir, "repo");
  const state = NodePath.join(dir, "state");
  const puppetDir = NodePath.join(dir, "puppet");
  for (const [file, text] of Object.entries(TOY)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(repo, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(repo, file), text);
  }
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "toy: math and greet");
  const base = git(repo, "rev-parse", "HEAD");
  NodeFS.mkdirSync(NodePath.join(state, "userdata"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(puppetDir, "sessions"), { recursive: true });
  const bin = NodePath.join(dir, "kiro-cli");
  NodeFS.writeFileSync(
    bin,
    `#!/bin/sh\nPUPPET_DIR=${JSON.stringify(puppetDir)} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(PUPPET)} "$@"\n`,
    { mode: 0o755 },
  );
  const off = (driver: string) => ({ driver, enabled: false, config: { enabled: false } });
  NodeFS.writeFileSync(
    NodePath.join(state, "userdata", "settings.json"),
    JSON.stringify({
      providerInstances: {
        puppet: {
          driver: "kiro",
          displayName: "Puppet",
          enabled: true,
          config: { enabled: true, binaryPath: bin },
        },
        ...(threads === "real" ? {} : { claudeAgent: off("claudeAgent") }),
        codex: off("codex"),
      },
    }),
  );

  const env = {
    ...process.env,
    T3CODE_HOME: state,
    T3CODE_TELEMETRY_ENABLED: "false",
    T3CODE_DISABLE_OPTIONAL_EGRESS: "true",
    NODE_NO_WARNINGS: "1",
  };
  const cli = (...args: Array<string>) =>
    NodeChildProcess.execFileSync(process.execPath, [server, ...args, "--base-dir", state], {
      env,
      encoding: "utf8",
    }).trim();
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const log = NodeFS.openSync(NodePath.join(dir, "server.log"), "a");
  const child = NodeChildProcess.spawn(
    process.execPath,
    [server, "serve", "--host", "127.0.0.1", "--port", String(port), "--base-dir", state, repo],
    { cwd: repo, env, stdio: ["ignore", log, log] },
  );
  const pid = child.pid!;
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  const stop = async () => {
    client?.close();
    // The server's own children (the supervisor, provider CLIs) are captured now, by PID.
    const children = (pids: Array<number>): Array<number> =>
      pids.flatMap((each) => {
        try {
          const found = NodeFS.readFileSync(`/proc/${each}/task/${each}/children`, "utf8")
            .split(/\s+/)
            .filter(Boolean)
            .map(Number);
          return [...found, ...children(found)];
        } catch {
          return [];
        }
      });
    const tree = [pid, ...children([pid])];
    const alive = (each: number) => {
      try {
        process.kill(each, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (const each of tree) if (alive(each)) process.kill(each, "SIGTERM");
    for (let i = 0; i < 60 && tree.some(alive); i++) await sleep(250);
    for (const each of tree) if (alive(each)) process.kill(each, "SIGKILL");
    if (stops.delete(stop)) NodeFS.closeSync(log);
    return { pid, stopped: !alive(pid) };
  };
  stops.add(stop);
  try {
    for (let i = 0; ; i++) {
      if (child.exitCode !== null) throw new Error(`the server exited; see ${dir}/server.log`);
      const up = NodeFS.existsSync(NodePath.join(state, "userdata", "server-runtime.json"))
        ? await fetch(origin).then(
            (r) => r.ok,
            () => false,
          )
        : false;
      if (up) break;
      if (i > 240) throw new Error("the server did not start within 2 minutes");
      await sleep(500);
    }
    const token = cli("auth", "session", "issue", "--label", "eval-owner", "--token-only");
    cli("project", "add", "--title", "Toy", repo);
    client = await connect(origin, token);
    const owner = client;
    let latest: Json = {};
    // The host pushes every board change on this stream; each one is graded, none polled.
    void owner.call("coordinator.subscribe", {}, (board) => {
      latest = board;
      options.onBoard(board);
    });
    const command = async (body: Json) => {
      const board = await owner.value("coordinator.command", body);
      options.onBoard(board);
      return board;
    };
    const configuration = {
      enabled: true,
      coordinatorProvider: "puppet",
      coordinatorModel: "default",
    };
    let board = await command({ type: "configure", configuration });
    const project = board.projects.find((item: Json) => item.title === "Toy");
    board = await command({
      type: "configure",
      configuration: { ...configuration, coordinatorProjectId: project.id },
    });
    // The owner's word that the puppet takes work, which the host asks of any ACP provider.
    board = await command({
      type: "catalog.source.set",
      sourceId: "puppet",
      automaticEligibility: threads === "scripted",
    });
    const claude = () =>
      board.catalog.some(
        (item: Json) => item.provider === "claudeAgent" && item.state === "eligible",
      );
    if (threads === "real")
      for (let i = 0; !claude(); i++) {
        if (i === 20)
          throw new Error(
            "Claude is not routable here: --threads real needs it installed and signed in.",
          );
        await sleep(3_000);
        board = await command({ type: "catalog.refresh" });
      }
    const coordinatorThread: string =
      board.guidance?.threadId ??
      board.cards.find((card: Json) => card.threadId.startsWith("coordinator-lead:"))?.threadId;

    const sessions = (): Array<Session> =>
      NodeFS.readdirSync(NodePath.join(puppetDir, "sessions")).flatMap((sid) => {
        const home = NodePath.join(puppetDir, "sessions", sid);
        try {
          const meta = JSON.parse(NodeFS.readFileSync(NodePath.join(home, "meta.json"), "utf8"));
          const state = NodeFS.readFileSync(NodePath.join(home, "state"), "utf8").trim();
          return [
            { sid, home, cwd: meta.cwd, meta, state, turn: Number(state.split(" ")[1] ?? 0) },
          ];
        } catch {
          return [];
        }
      });
    // Only the Coordinator's thread runs in the project's own checkout; delegated work has worktrees.
    const coordinatorSession = () =>
      sessions()
        .filter((session) => session.cwd === repo)
        .toSorted((a, b) => a.meta.at - b.meta.at)
        .at(-1);
    const prompt = (session: Session) =>
      JSON.parse(
        NodeFS.readFileSync(
          NodePath.join(session.home, "prompts", `${String(session.turn).padStart(4, "0")}.json`),
          "utf8",
        ),
      ).text as string;
    const send = (session: Session, body: Json) => {
      const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
      const file = NodePath.join(session.home, "cmd", name);
      NodeFS.writeFileSync(`${file}.tmp`, JSON.stringify(body));
      NodeFS.renameSync(`${file}.tmp`, file);
      return name;
    };
    let mcp: { sid: string; request: Awaited<ReturnType<typeof mcpClient>> } | undefined;
    const coordinatorMcp = async () => {
      const session = coordinatorSession();
      if (!session) throw new Error("The Coordinator's thread has no provider session yet.");
      if (mcp?.sid !== session.sid)
        mcp = { sid: session.sid, request: await mcpClient(session.meta) };
      return mcp.request;
    };
    const ownerMessage = async (text: string) => {
      const message = {
        type: "message.dispatch",
        threadId: coordinatorThread,
        messageId: crypto.randomUUID(),
        text,
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      };
      // Queued behind a running turn, as the composer does.
      await owner
        .value("orchestration.dispatchCommand", {
          ...message,
          commandId: crypto.randomUUID(),
          dispatchMode: { type: "queue_after_active" },
        })
        .catch(() =>
          owner.value("orchestration.dispatchCommand", {
            ...message,
            commandId: crypto.randomUUID(),
            dispatchMode: { type: "start_immediately" },
          }),
        );
    };

    return {
      repo,
      base,
      pid,
      projectId: project.id as string,
      stop,
      board: () => latest,
      /** The turn the host started in the Coordinator's thread, exactly as it sent it. */
      pendingTurn: () => {
        const session = coordinatorSession();
        return session?.state.startsWith("turn")
          ? { turn: session.turn, text: prompt(session) }
          : undefined;
      },
      /** The tools the Coordinator's thread is offered, as the host lists them. */
      tools: async (): Promise<Array<ToolSpec>> => {
        const request = await coordinatorMcp();
        const tools: Array<Json> = [];
        let cursor: string | undefined;
        do {
          const page = await request("tools/list", cursor ? { cursor } : {});
          tools.push(...page.result.tools);
          cursor = page.result.nextCursor;
        } while (cursor);
        return tools.map((tool) => ({
          name: tool.name,
          description: tool.description ?? "",
          parameters: tool.inputSchema,
        }));
      },
      /** One tool call with the Coordinator thread's own credential; the text a provider gets. */
      call: async (name: string, input: unknown) => {
        const reply = await (await coordinatorMcp())("tools/call", { name, arguments: input });
        if (reply.error) return JSON.stringify({ error: reply.error });
        return (reply.result.content ?? [])
          .map((part: Json) => (part.type === "text" ? part.text : `[${part.type}]`))
          .join("\n");
      },
      endTurn: async (text: string) => {
        const session = coordinatorSession();
        if (!session?.state.startsWith("turn")) return;
        send(session, { op: "end", text });
        for (let i = 0; i < 40 && coordinatorSession()?.state === session.state; i++)
          await sleep(100);
      },
      ownerMessage,
      ownerCommand: command,
      /** The owner answers an approval in its own thread, as the thread's approval card does. */
      ownerAnswer: (threadId: string, requestId: string, decision: "accept" | "decline") =>
        owner.value("orchestration.dispatchCommand", {
          type: "runtime-request.respond",
          threadId,
          commandId: crypto.randomUUID(),
          requestId,
          decision,
        }),
      /** The runtime requests a thread holds, with how each ended. */
      runtimeRequests: async (threadId: string) =>
        (
          (await owner.value("orchestration.getThreadProjection", { threadId }))
            .runtimeRequests as Array<Json>
        ).map((item) => ({
          id: String(item.id),
          status: String(item.status),
          decision: item.decision,
        })),
      /** Delegated puppet sessions in a turn, with the prompt the host sent them. */
      delegatedTurns: () =>
        sessions()
          .filter((session) => session.cwd !== repo && session.state.startsWith("turn"))
          .map((session) => ({ session, text: prompt(session) })),
      /** Asks the host's permission for a command in a delegated turn; resolves with its answer. */
      ask: async (session: Session, command: string, until: number) => {
        const reply = NodePath.join(
          session.home,
          "replies",
          send(session, { op: "permission", command }),
        );
        while (Date.now() < until && !NodeFS.existsSync(reply)) await sleep(250);
        return NodeFS.existsSync(reply)
          ? (JSON.parse(NodeFS.readFileSync(reply, "utf8")) as Json)
          : undefined;
      },
      finishThread: (session: Session, text: string) => send(session, { op: "end", text }),
    };
  } catch (error) {
    await stop();
    throw error;
  }
};

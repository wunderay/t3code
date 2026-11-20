#!/usr/bin/env node
// A provider CLI with no model: it speaks the Kiro CLI's surface (ACP over stdio) to T3 Code and
// does only what files in PUPPET_DIR/sessions/<sid> tell it (cmd/*.json: end or permission). It
// writes each prompt verbatim to prompts/, its state to state, and the host's answers to replies/.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

const dir = process.env.PUPPET_DIR;
const argv = process.argv.slice(2);
// Three models, so a reviewer can run on a model other than its author's.
const MODELS = ["puppet-a", "puppet-b", "puppet-c"];

if (argv[0] === "--version") {
  console.log("kiro-cli 2.32.0");
  process.exit(0);
}
if (argv[0] === "whoami") {
  console.log(JSON.stringify({ accountType: "BuilderId", email: "puppet@localhost" }));
  process.exit(0);
}
if (argv[0] === "chat" && argv.includes("--list-models")) {
  const models = MODELS.map((id) => ({ model_id: id, model_name: id }));
  console.log(JSON.stringify({ models, default_model: MODELS[0] }));
  process.exit(0);
}
if (argv[0] !== "acp" || !dir) {
  console.error("puppet: unsupported invocation", argv.join(" "));
  process.exit(2);
}

const writeFile = (file, text) => {
  NodeFS.writeFileSync(`${file}.tmp`, text, { mode: 0o600 });
  NodeFS.renameSync(`${file}.tmp`, file);
};
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

let sid;
let home;
let model = MODELS[0];
let turn = 0;
let nextId = 1;
let running;
const awaiting = new Map();
const configOptions = () => [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: model,
    options: MODELS.map((value) => ({ value, name: value })),
  },
];
const update = (body) =>
  write({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: body } });
const finish = (result) => {
  if (!running) return;
  write({ jsonrpc: "2.0", id: running, ...result });
  running = undefined;
  writeFile(NodePath.join(home, "state"), "idle\n");
};

const commands = {
  end: (command) => {
    if (command.text)
      update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: command.text },
      });
    finish({ result: { stopReason: "end_turn" } });
  },
  // Asks permission as a provider does before a command. ACP states no operation, so the host
  // answers it by its kind alone.
  permission: (command, name) => {
    const id = `puppet-${nextId++}`;
    const toolCall = {
      toolCallId: `tool-${turn}-${nextId++}`,
      title: command.command,
      kind: "execute",
      status: "pending",
      rawInput: { command: command.command },
    };
    update({ sessionUpdate: "tool_call", ...toolCall });
    awaiting.set(id, name);
    write({
      jsonrpc: "2.0",
      id,
      method: "session/request_permission",
      params: {
        sessionId: sid,
        toolCall,
        options: [
          { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject_once", name: "Reject", kind: "reject_once" },
        ],
      },
    });
  },
};

setInterval(() => {
  if (!home || !running) return;
  const cmdDir = NodePath.join(home, "cmd");
  for (const name of NodeFS.readdirSync(cmdDir)
    .filter((each) => each.endsWith(".json"))
    .sort()) {
    if (!running) return;
    const command = JSON.parse(NodeFS.readFileSync(NodePath.join(cmdDir, name), "utf8"));
    NodeFS.rmSync(NodePath.join(cmdDir, name));
    commands[command.op]?.(command, name);
  }
}, 100);

const openSession = (params, id) => {
  // Short: the host refuses a permission request id over 256 characters, and holds this id thrice.
  sid = id ?? `p${process.pid.toString(36)}${(Date.now() % 46656).toString(36)}`;
  home = NodePath.join(dir, "sessions", sid);
  for (const sub of ["prompts", "cmd", "replies"])
    NodeFS.mkdirSync(NodePath.join(home, sub), { recursive: true, mode: 0o700 });
  turn = NodeFS.readdirSync(NodePath.join(home, "prompts")).length;
  const meta = {
    sid,
    pid: process.pid,
    at: Date.now(),
    cwd: params.cwd,
    mcpServers: params.mcpServers,
  };
  writeFile(NodePath.join(home, "meta.json"), JSON.stringify(meta));
  writeFile(NodePath.join(home, "state"), "idle\n");
};

for await (const line of NodeReadline.createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const message = JSON.parse(line);
  if (message.method === undefined && message.id !== undefined) {
    const name = awaiting.get(message.id);
    awaiting.delete(message.id);
    if (name && home)
      writeFile(
        NodePath.join(home, "replies", name),
        JSON.stringify(message.error ?? message.result),
      );
    continue;
  }
  const reply = (result) => write({ jsonrpc: "2.0", id: message.id, result });
  switch (message.method) {
    case "initialize":
      reply({
        protocolVersion: 1,
        agentInfo: { name: "kiro", version: "2.32.0" },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: true },
          mcpCapabilities: { http: true, sse: false },
        },
        authMethods: [],
      });
      break;
    case "session/new":
      openSession(message.params);
      reply({ sessionId: sid, configOptions: configOptions() });
      break;
    case "session/load":
    case "session/resume":
      openSession(message.params, message.params.sessionId);
      reply({ configOptions: configOptions() });
      break;
    case "session/set_config_option":
      if (message.params.configId === "model") model = String(message.params.value);
      reply({ configOptions: configOptions() });
      break;
    case "session/set_model":
      model = String(message.params.modelId);
      reply({});
      break;
    case "session/set_mode":
      reply({});
      break;
    case "session/prompt": {
      turn += 1;
      running = message.id;
      const text = (message.params.prompt ?? [])
        .map((block) => (block.type === "text" ? block.text : `[${block.type}]`))
        .join("\n");
      writeFile(
        NodePath.join(home, "prompts", `${String(turn).padStart(4, "0")}.json`),
        JSON.stringify({ turn, text }),
      );
      writeFile(NodePath.join(home, "state"), `turn ${turn}\n`);
      break;
    }
    case "session/cancel":
      finish({ result: { stopReason: "cancelled" } });
      break;
    default:
      if (message.id !== undefined)
        write({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Method not found" },
        });
  }
}
process.exit(0);

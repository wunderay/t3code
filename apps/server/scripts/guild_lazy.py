"""Thread-owned Guild executor and tool-only provider harness boundary."""
from __future__ import annotations

import base64
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
from multiprocessing.connection import Client, Listener
import queue
import re
import shutil
import stat
import subprocess
import sys
import threading
import time
import uuid

MAX_MESSAGE = 384 * 1024 * 1024
GUILD_INSTRUCTIONS = "Use only the Guild MCP tools for project files and code execution. Tool file paths must be relative to the project root. Built-in host shell, patch and file tools have no execution environment. Use read_file/list_files to inspect, write_file to save complete UTF-8 files, and execute with an argv array to run commands. Chat and file inspection do not start a sandbox; file writes and execution use the same Guild sandbox throughout this thread."
DEVICES = {"con", "prn", "aux", "nul", "conin$", "conout$", *["com" + str(i) for i in range(1, 10)], *["lpt" + str(i) for i in range(1, 10)]}


def load_bridge():
    spec = importlib.util.spec_from_file_location("t3_guild_transport", Path(__file__).with_name("guild_sandbox.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def thread_key(thread):
    return hashlib.sha256(("thread:" + thread).encode()).hexdigest()[:24]


def control_dir(config, thread):
    return Path(config["state"]) / "t3" / "threads" / thread_key(thread)


def source_files(git, root, cached=None):
    root = root.resolve(strict=True)
    bridge = load_bridge()
    result, fingerprints = {}, {}
    for name in git(root, "ls-files", "-z", "--cached", "--others", "--exclude-standard").stdout.split(b"\0"):
        if not name:
            continue
        name = name.decode("utf-8")
        path = workspace_path(root, name, source=True)
        try:
            info = path.stat()
        except FileNotFoundError:
            continue
        fingerprint = (info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_ino)
        fingerprints[name] = fingerprint
        if cached and cached[1].get(name) == fingerprint:
            result[name] = cached[0][name]
        else:
            result[name] = hashlib.sha256(bridge.read_file(path)).hexdigest()
    return result, fingerprints


def workspace_path(root, name, *, source=False, directory=False):
    parts = name.replace("\\", "/").split("/")
    if not parts or any(p in ("", ".", "..") or ":" in p or p.rstrip(" .") != p or p.split(".")[0].casefold() in DEVICES for p in parts):
        raise RuntimeError("unsafe workspace path")
    if parts[0].casefold() in (".git", ".t3-guild-session", ".t3-guild-tools"):
        raise RuntimeError("private workspace metadata is unavailable")
    path = root
    for index, part in enumerate(parts):
        path /= part
        try:
            info = path.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise RuntimeError("workspace reparse points are unavailable")
        if index < len(parts) - 1:
            if not stat.S_ISDIR(info.st_mode):
                raise RuntimeError("workspace parent is not a directory")
        elif directory:
            if not stat.S_ISDIR(info.st_mode):
                raise RuntimeError("workspace path is not a directory")
        elif not stat.S_ISREG(info.st_mode) or (not source and info.st_nlink != 1):
            raise RuntimeError("workspace special files and handback hardlinks are unavailable")
    return path


TOOL_SCHEMAS = [
    {"name": "read_file", "description": "Read a UTF-8 project file using a path relative to the project root. Does not start a sandbox before the first code write or execution.",
     "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"], "additionalProperties": False}},
    {"name": "list_files", "description": "List tracked and unignored project file paths without starting a sandbox.",
     "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}},
    {"name": "write_file", "description": "Write a complete UTF-8 project file using a path relative to the project root in the thread's shared Guild sandbox. Creates the sandbox on the first write; completed changes are returned to the local project without overwriting concurrent edits.",
     "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"], "additionalProperties": False}},
    {"name": "execute", "description": "Execute code or a command inside the thread's shared Guild sandbox. Supply an argv array, for example [\"git\",\"status\",\"--short\"] or [\"python3\",\"-c\",\"print(1)\"]. Starts isolation on the first execution, even for commands that might only read. Default cwd is the project root. No command executes on the host.",
     "inputSchema": {"type": "object", "properties": {"argv": {"type": "array", "items": {"type": "string"}, "minItems": 1}, "timeout": {"type": "integer", "minimum": 1, "maximum": 900}}, "required": ["argv"], "additionalProperties": False}},
]


WORKER = r'''
import base64,contextlib,hashlib,json,os,pathlib,stat,subprocess,sys,tempfile
original_popen=subprocess.Popen
class HiddenProcess(original_popen):
 def __init__(self,*a,**kw):
  kw['creationflags']=kw.get('creationflags',0)|getattr(subprocess,'CREATE_NO_WINDOW',0)
  super().__init__(*a,**kw)
subprocess.Popen=HiddenProcess
root=pathlib.Path.cwd();setup=json.loads(sys.stdin.readline());tools=setup['tools'];export_program=setup['export']
devices={'con','prn','aux','nul','conin$','conout$',*[f'com{i}' for i in range(1,10)],*[f'lpt{i}' for i in range(1,10)]}
def path_for(name):
 parts=name.replace('\\','/').split('/')
 if not parts or any(p in ('','.','..') or ':' in p or p.rstrip(' .')!=p or p.split('.')[0].casefold() in devices for p in parts): raise RuntimeError('unsafe workspace path')
 if parts[0].casefold() in ('.git','.t3-guild-session','.t3-guild-tools'): raise RuntimeError('private metadata')
 p=root
 for part in parts:
  p=p/part
  try: s=p.lstat()
  except FileNotFoundError: continue
  if stat.S_ISLNK(s.st_mode) or getattr(s,'st_file_attributes',0)&0x400: raise RuntimeError('workspace link refused')
 if p.exists() and (not p.is_file() or p.stat().st_nlink!=1): raise RuntimeError('workspace file refused')
 return p
def export(d):
 r=subprocess.run([*tools['python3'],'-I','-B','-c',export_program],input=json.dumps(d),text=True,capture_output=True)
 if r.returncode: raise RuntimeError('sandbox export failed; work retained')
 return json.loads(r.stdout)
print(json.dumps({'ready':True}),flush=True)
for line in sys.stdin:
 try:
  d=json.loads(line);op=d['op'];a=d.get('arguments',{});result={}
  if op=='close': break
  if op=='export': result=export(a)
  elif op=='sync':
   for name,data in a['files'].items():
    p=path_for(name)
    if data is None: p.unlink(missing_ok=True)
    else:
     content=base64.b64decode(data,validate=True)
     if len(content)>33554432: raise RuntimeError('file too large')
     p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(content)
  elif op=='write_file':
   p=path_for(a['path']);content=a['content'].encode('utf-8')
   if len(content)>33554432: raise RuntimeError('file too large')
   p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(content);result={'writtenBytes':len(content)}
  elif op=='read_file':
   with path_for(a['path']).open('rb') as f: content=f.read(33554433)
   if len(content)>33554432: raise RuntimeError('file too large')
   result={'content':content.decode('utf-8')}
  elif op=='list_files':
   r=subprocess.run([*tools['git'],'-c','core.fsmonitor=false','ls-files','-z','--cached','--others','--exclude-standard'],capture_output=True,check=True)
   result={'files':[n.decode('utf-8') for n in r.stdout.split(b'\0') if n and not n.startswith((b'.t3-guild-',b'.git/'))]}
  elif op=='execute':
   argv=a['argv'];limit=a.get('timeout',180)
   if not isinstance(argv,list) or not argv or not all(isinstance(v,str) and '\0' not in v for v in argv) or not isinstance(limit,int) or not 1<=limit<=900: raise RuntimeError('invalid command')
   argv=[*tools.get(argv[0],[argv[0]]),*argv[1:]]
   with tempfile.TemporaryFile() as out,tempfile.TemporaryFile() as err:
    try: r=subprocess.run(argv,stdin=subprocess.DEVNULL,stdout=out,stderr=err,timeout=limit);code=r.returncode
    except subprocess.TimeoutExpired: code=124
    out.seek(0);err.seek(0);stdout=out.read(4194305);stderr=err.read(4194305)
    result={'exitCode':code,'stdout':stdout[:4194304].decode('utf-8','replace'),'stderr':stderr[:4194304].decode('utf-8','replace'),'truncated':len(stdout)>4194304 or len(stderr)>4194304}
  else: raise RuntimeError('unknown operation')
  print(json.dumps({'result':result}),flush=True)
 except Exception as e: print(json.dumps({'error':str(e)}),flush=True)
'''


class Executor:
    def __init__(self, args, config):
        self.args, self.config = args, config
        self.bridge = load_bridge()
        self.control = control_dir(config, args.thread)
        self.control.mkdir(parents=True, exist_ok=True)
        self.source = Path(args.workspace).resolve(strict=True)
        self.record_path = self.control / "session.json"
        self.replies = queue.Queue()
        self.process = None
        self.cached = None
        self.run_done = threading.Event()
        self.cancelled = threading.Event()

    def request(self, op, arguments):
        self.process.stdin.write(json.dumps({"op": op, "arguments": arguments}).encode() + b"\n")
        self.process.stdin.flush()
        reply = self.replies.get(timeout=1000)
        if isinstance(reply, BaseException):
            raise reply
        if "error" in reply:
            raise RuntimeError(reply["error"])
        return reply["result"]

    def export(self):
        exported = self.request("export", {"git": self.tools["git"], "baseline": self.baseline["files"],
            "head": self.baseline["head"], "maxFile": self.bridge.MAX_FILE, "maxSnapshot": self.bridge.MAX_SNAPSHOT})
        self.baseline = self.bridge.handback(self.git, self.source, self.baseline, exported, self.control / "transfer")
        self.bridge.write_json(self.control / "baseline.json", self.baseline)
        self.record = {**self.record, "pending": False}
        self.bridge.write_json(self.record_path, self.record)
        self.cached = None

    def start(self):
        self.native = self.bridge.runtime(self.config)
        self.git = self.bridge.git_runner(self.config)
        if Path(self.git(self.source, "rev-parse", "--show-toplevel").stdout.decode().strip()).resolve() != self.source:
            raise RuntimeError("Guild requires the repository root as project workspace")
        info = json.loads(self.native.image_path(self.config["image"]).read_text())
        self.tools = info["manifest"]["tools"]
        volume = self.native.PREFIX + "t3-thread-" + thread_key(self.args.thread)
        self.box = self.native.Box(self.config["image"], volume)
        self.data = self.native._dir("volumes", volume) / "data"
        if self.record_path.exists():
            self.record = json.loads(self.record_path.read_text())
            if self.record["source"] != str(self.source) or self.record["volume"] != volume:
                raise RuntimeError("thread sandbox identity changed")
            self.baseline = json.loads((self.control / "baseline.json").read_text())
        else:
            if self.native.volume_exists(volume):
                raise RuntimeError("thread volume has no matching controller record")
            self.cached = source_files(self.git, self.source)
            self.baseline = {"files": self.cached[0], "head": self.git(self.source, "rev-parse", "HEAD").stdout.decode().strip(), "index": self.bridge.index_digest(self.git, self.source)}
            self.box.create()
            self.git(None, "clone", "--no-hardlinks", "--no-checkout", "--", str(self.source), str(self.data))
            for name in self.baseline["files"]:
                target = workspace_path(self.data, name)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(self.bridge.read_file(workspace_path(self.source, name, source=True)))
            self.git(self.data, "read-tree", self.baseline["head"])
            patch = self.git(self.source, "diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", "HEAD").stdout
            if patch:
                self.git(self.data, "apply", "--cached", "--binary", "-", data=patch)
            self.record = {"source": str(self.source), "volume": volume, "pending": False, "thread": self.args.thread}
            self.bridge.write_json(self.control / "baseline.json", self.baseline)
            self.bridge.write_json(self.record_path, self.record)
        (self.control / "transfer").mkdir(exist_ok=True)
        original_launch = self.native.launch
        bridge = self.bridge
        executor = self

        class Transport:
            def __init__(self, process):
                self.child = process

            @property
            def returncode(self):
                return self.child.returncode

            def communicate(self, payload, timeout):
                self.child.stdin.write(payload + b"\n")
                self.child.stdin.flush()
                executor.process = self.child
                executor.replies.put({"transport": True})
                for line in self.child.stdout:
                    try:
                        executor.replies.put(json.loads(line))
                    except ValueError:
                        executor.replies.put(RuntimeError("invalid Guild worker response"))
                executor.replies.put(RuntimeError("Guild executor stopped; retained work needs recovery"))
                self.child.wait()
                return b"", b""

        def launch(name, root, spec, argv, **kwargs):
            process = original_launch(name, root, spec, argv, **kwargs)
            if name != volume + "-executor":
                return process
            threading.Thread(target=lambda: process.stderr.read(), daemon=True).start()
            return Transport(process)

        self.native.launch = launch
        self.native.BOOTSTRAP = "import json,os,sys,subprocess\n" + self.native.GUARD + bridge.STREAM_BOOTSTRAP

        def run():
            try:
                self.box.run(["python3", "-I", "-B", "-u", "-c", WORKER], network="bridge", timeout=82800,
                    stdin="", name=volume + "-executor", secret_env={"PYTHONIOENCODING": "utf-8"},
                    proceed=lambda: not self.cancelled.is_set())
            except BaseException as error:
                import traceback
                traceback.print_exc()
                self.replies.put(error)
            finally:
                self.run_done.set()
                self.replies.put(RuntimeError("Guild executor stopped; work was retained"))

        self.run_thread = threading.Thread(target=run, daemon=True)
        self.run_thread.start()
        # STREAM_BOOTSTRAP forwards subsequent lines into the worker after its initial launch frame.
        # The native worker first needs its bounded tool/export configuration.
        reply = self.replies.get(timeout=1000)
        if isinstance(reply, BaseException):
            raise reply
        if not reply.get("transport"):
            raise RuntimeError("Guild worker transport could not start")
        self.process.stdin.write(json.dumps({"tools": self.tools, "export": bridge.EXPORT}).encode() + b"\n")
        self.process.stdin.flush()
        reply = self.replies.get(timeout=1000)
        if isinstance(reply, BaseException):
            raise reply
        if not reply.get("ready"):
            raise RuntimeError("Guild worker did not initialize")
        if self.record.get("pending"):
            self.export()

    def call(self, name, arguments):
        if self.process is None:
            self.start()
        if self.record.get("pending"):
            if name in ("read_file", "list_files"):
                return self.request(name, arguments)
            self.export()
        if self.git(self.source, "rev-parse", "HEAD").stdout.decode().strip() != self.baseline["head"] or self.bridge.index_digest(self.git, self.source) != self.baseline["index"]:
            raise RuntimeError("host Git state changed outside this thread; retained sandbox was not overwritten")
        self.cached = source_files(self.git, self.source, self.cached)
        changes = {name: base64.b64encode(self.bridge.read_file(workspace_path(self.source, name, source=True))).decode() if name in self.cached[0] else None
                   for name in set(self.baseline["files"]) | set(self.cached[0]) if self.baseline["files"].get(name) != self.cached[0].get(name)}
        if changes:
            self.request("sync", {"files": changes})
            self.baseline = {**self.baseline, "files": self.cached[0]}
            self.bridge.write_json(self.control / "baseline.json", self.baseline)
        if name in ("write_file", "execute"):
            self.record = {**self.record, "pending": True}
            self.bridge.write_json(self.record_path, self.record)
        result = self.request(name, arguments)
        if name in ("write_file", "execute"):
            self.export()
        return result

    def close(self):
        if self.process is not None:
            with contextlib.suppress(OSError):
                self.process.stdin.write(b'{"op":"close"}\n')
                self.process.stdin.flush()
                self.process.stdin.close()
            if not self.run_done.wait(30):
                self.native.stop_container(self.box.volume + "-executor")
                self.run_done.wait(30)

    def cancel(self):
        self.cancelled.set()
        if hasattr(self, "native") and hasattr(self, "box"):
            self.native.stop_container(self.box.volume + "-executor")


def pipe_address(config, thread):
    identity = hashlib.sha256((str(Path(config["state"]).resolve()) + ":" + thread).encode()).hexdigest()[:32]
    return r"\\.\pipe\t3-guild-" + identity


def daemon(args, config):
    bridge = load_bridge()
    control = control_dir(config, args.thread)
    with bridge.controller_lock(config, "thread-executor", args.thread):
        executor = Executor(args, config)
        key = bytes.fromhex((control / "key").read_text())
        with Listener(pipe_address(config, args.thread), family="AF_PIPE", authkey=key) as listener:
            bridge.write_json(control / "daemon.json", {"pid": os.getpid(), "source": str(Path(args.workspace).resolve())})
            connections = queue.Queue()

            def accept():
                try:
                    while True:
                        connections.put(listener.accept())
                except (OSError, EOFError):
                    pass

            threading.Thread(target=accept, daemon=True).start()
            try:
                while True:
                    try:
                        connection = connections.get(timeout=600)
                    except queue.Empty:
                        break
                    with connection:
                        operation_done = threading.Event()
                        try:
                            request = json.loads(connection.recv_bytes(MAX_MESSAGE))
                            if request.get("workspace") != str(executor.source):
                                raise RuntimeError("thread workspace changed")
                            if request["name"] not in {tool["name"] for tool in TOOL_SCHEMAS}:
                                raise RuntimeError("unknown Guild operation")

                            def watch_disconnect(connection=connection, operation_done=operation_done):
                                try:
                                    connection.recv_bytes(1)
                                except (OSError, EOFError):
                                    if not operation_done.is_set():
                                        executor.cancel()

                            threading.Thread(target=watch_disconnect, daemon=True).start()
                            result = executor.call(request["name"], request["arguments"])
                            operation_done.set()
                            connection.send_bytes(json.dumps({"result": result}).encode())
                        except Exception as error:
                            operation_done.set()
                            with contextlib.suppress(OSError, EOFError):
                                connection.send_bytes(json.dumps({"error": str(error)}).encode())
                        if executor.cancelled.is_set() or executor.run_done.is_set() or executor.process is None:
                            break
            finally:
                executor.close()


def call_executor(args, config, name, arguments):
    control = control_dir(config, args.thread)
    control.mkdir(parents=True, exist_ok=True)
    key_path = control / "key"
    try:
        with key_path.open("x", encoding="ascii") as stream:
            stream.write(os.urandom(32).hex())
    except FileExistsError:
        pass
    key = bytes.fromhex(key_path.read_text())
    address = pipe_address(config, args.thread)
    try:
        connection = Client(address, family="AF_PIPE", authkey=key)
    except (FileNotFoundError, ConnectionRefusedError):
        subprocess.Popen([config["python"], "-I", "-B", str(Path(__file__).resolve()), "--mode", "executor", "--config", str(args.config),
            "--thread", args.thread, "--workspace", str(Path(args.workspace).resolve())],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=(control / "executor.log").open("ab"),
            creationflags=subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS)
        import ctypes
        deadline = time.monotonic() + 30
        while True:
            if ctypes.windll.kernel32.WaitNamedPipeW(address, 1000):
                break
            if time.monotonic() > deadline:
                raise RuntimeError("Guild executor could not start; inspect its local executor.log")
            time.sleep(.05)
        connection = Client(address, family="AF_PIPE", authkey=key)
    with connection:
        connection.send_bytes(json.dumps({"name": name, "arguments": arguments, "workspace": str(Path(args.workspace).resolve())}).encode())
        response = json.loads(connection.recv_bytes(MAX_MESSAGE))
    if "error" in response:
        raise RuntimeError(response["error"])
    return response["result"]


def tool_call(args, config, name, arguments):
    if name not in {tool["name"] for tool in TOOL_SCHEMAS}:
        raise RuntimeError("unknown Guild tool")
    record = control_dir(config, args.thread) / "session.json"
    if name in ("write_file", "execute") or record.exists():
        return call_executor(args, config, name, arguments)
    root = Path(args.workspace).resolve(strict=True)
    if name == "read_file":
        return {"content": load_bridge().read_file(workspace_path(root, arguments["path"], source=True)).decode("utf-8")}
    return {"files": load_bridge().tracked_files(load_bridge().git_runner(config), root)}


def mcp(args, config):
    for line in sys.stdin:
        request = json.loads(line)
        if "id" not in request:
            continue
        try:
            method = request["method"]
            if method == "initialize":
                result = {"protocolVersion": request.get("params", {}).get("protocolVersion", "2025-06-18"), "capabilities": {"tools": {}}, "serverInfo": {"name": "guild-thread", "version": "1"}}
            elif method == "tools/list":
                result = {"tools": TOOL_SCHEMAS}
            elif method == "tools/call":
                params = request["params"]
                try:
                    value = tool_call(args, config, params["name"], params.get("arguments", {}))
                    result = {"content": [{"type": "text", "text": json.dumps(value)}]}
                except Exception as error:
                    result = {"isError": True, "content": [{"type": "text", "text": str(error)}]}
            elif method == "ping":
                result = {}
            else:
                raise RuntimeError("unsupported Guild MCP method")
            reply = {"jsonrpc": "2.0", "id": request["id"], "result": result}
        except Exception as error:
            reply = {"jsonrpc": "2.0", "id": request["id"], "error": {"code": -32602, "message": str(error)}}
        print(json.dumps(reply), flush=True)


CODEX_LOCKED_FEATURES = {
    "multi_agent": False, "multi_agent_v2": False, "hooks": False, "plugins": False,
    "apps": False, "remote_plugin": False, "plugin_discovery_prefetch": False,
    "request_permissions_tool": False, "deferred_executor": False, "runtime_agent_instances": False,
    "shell_snapshot": False, "shell_snapshot_v2": False, "code_mode_prewarm": False,
    "skill_search": False, "skill_mcp_dependency_install": False, "skip_host_skill_discovery": True,
}


def mcp_server(args):
    return {"command": sys.executable, "args": ["-I", "-B", str(Path(__file__).resolve()), "--mode", "mcp", "--config", str(args.config),
        "--workspace", str(Path(args.workspace).resolve()), "--thread", args.thread]}


def codex_frame(value, profile, server):
    method = value.get("method", "")
    if method in ("thread/start", "thread/resume", "thread/fork", "turn/start"):
        params = value.setdefault("params", {})
        params["environments"] = []
        params["cwd"] = str(profile / "workspace")
        if method == "turn/start":
            params["sandboxPolicy"] = {"type": "readOnly"}
        else:
            params["sandbox"] = "read-only"
            params["developerInstructions"] = (params.get("developerInstructions") or "") + "\n\n" + GUILD_INSTRUCTIONS
        params["config"] = {"features": CODEX_LOCKED_FEATURES, "mcp_servers": {"guild": server},
                            "web_search": "disabled", "notify": []}
        params.pop("dynamicTools", None)
    if method.startswith(("environment/", "config/", "plugin/", "mcpServer/")) and method not in ("mcpServerStatus/list",):
        raise RuntimeError("host execution/configuration changes are unavailable with Guild isolation")
    return value


def claude_frame(value, server):
    request = value.get("request", {})
    if value.get("type") == "control_request" and request.get("subtype") == "mcp_set_servers":
        request["servers"] = {"guild": {"type": "stdio", **server}}
    if value.get("type") == "control_request" and request.get("subtype") in ("set_permission_mode",):
        request["mode"] = "bypassPermissions"
    return value


def isolated_arguments(provider, arguments, server, private_home):
    result = []
    index = 0
    claude_removed = {"--mcp-config", "--tools", "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools",
                      "--settings", "--setting-sources", "--plugin-dir", "--add-dir", "--permission-mode", "--agent", "--agents"}
    claude_flags = {"--print", "-p", "--verbose", "--include-partial-messages", "--fork-session", "--no-session-persistence",
                    "--replay-user-messages", "--enable-auth-status", "--allow-dangerously-skip-permissions", "--disable-slash-commands", "--strict-mcp-config"}
    claude_values = {"--output-format", "--input-format", "--model", "--effort", "--max-turns", "--max-budget-usd",
                     "--system-prompt", "--append-system-prompt", "--session-id", "--resume", "--resume-session-at", "--permission-prompt-tool",
                     "--fallback-model", "--betas"}
    while index < len(arguments):
        part = arguments[index]
        if provider == "codex" and (part.startswith(("--config=", "-c=", "--enable=", "--disable=", "--code-mode-host=")) or (part.startswith("-c") and part != "-c")):
            raise RuntimeError("attached Codex configuration options are unavailable with Guild isolation")
        if provider == "claude" and part in claude_removed:
            index += 2
            continue
        if provider == "claude" and part.startswith(tuple(flag + "=" for flag in claude_removed)):
            index += 1
            continue
        if provider == "claude":
            if part in claude_values and index + 1 < len(arguments):
                value = arguments[index + 1]
                if part in ("--resume", "--session-id", "--resume-session-at") and not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value):
                    raise RuntimeError("Claude session must be an ID, not a host path")
                if part == "--permission-prompt-tool" and value != "stdio":
                    raise RuntimeError("Claude permission callbacks must use the T3 stdio transport")
                result += [part, value]
                index += 2
                continue
            if part not in claude_flags:
                raise RuntimeError("unsupported Claude launch option with Guild isolation: " + part.split("=")[0])
        if provider == "codex" and part in ("-c", "--config") and index + 1 < len(arguments):
            setting = arguments[index + 1]
            if not setting.startswith(("model_providers.openai_token_sharing", "model_provider=", "model_provider =", "model=", "model =", "model_reasoning_effort=")):
                index += 2
                continue
        if provider == "codex" and part in ("--enable", "--disable", "--code-mode-host"):
            raise RuntimeError("custom Codex feature/host overrides are unavailable with Guild isolation")
        if provider == "codex" and part not in ("app-server", "--stdio", "--strict-config", "-c", "--config") and not (index > 0 and arguments[index - 1] in ("-c", "--config")):
            raise RuntimeError("unsupported Codex launch option with Guild isolation")
        result.append(part)
        index += 1
    if provider == "claude":
        if "--append-system-prompt" in result:
            result[result.index("--append-system-prompt") + 1] += "\n\n" + GUILD_INSTRUCTIONS
        else:
            result += ["--append-system-prompt", GUILD_INSTRUCTIONS]
        return [*result, "--tools", "", "--disable-slash-commands", "--strict-mcp-config", "--mcp-config", json.dumps({"mcpServers": {"guild": {"type": "stdio", **server}}}),
                "--setting-sources", "", "--settings", json.dumps({"disableAllHooks": True}), "--permission-mode", "bypassPermissions"]
    for name, enabled in CODEX_LOCKED_FEATURES.items():
        result += ["-c", "features." + name + "=" + str(enabled).lower()]
    result += ["-c", "mcp_servers=" + "{guild={command=" + json.dumps(server["command"]) + ",args=" + json.dumps(server["args"]) + ',tool_timeout_sec=1200,default_tools_approval_mode="approve"}}',
               "-c", 'web_search="disabled"', "-c", "notify=[]", "-c", 'cli_auth_credentials_store="file"']
    return result


def harness(args, config):
    bridge = load_bridge()
    source = Path(args.workspace).resolve(strict=True)
    control = control_dir(config, args.thread)
    profile = control / ("harness-" + args.provider)
    (profile / "workspace").mkdir(parents=True, exist_ok=True)
    manifest = json.loads(Path(config["state"]).joinpath("native-manifest.json").read_text())
    executable = Path(manifest["tools"][args.provider][0])
    expected = manifest["files"].get(str(executable))
    if not expected or hashlib.file_digest(executable.open("rb"), "sha256").hexdigest() != expected:
        raise RuntimeError("provider binary changed; requalify the Guild installation")
    if Path(args.binary).name.casefold() not in (args.provider, args.provider + ".cmd", args.provider + ".exe") and Path(args.binary) != executable:
        raise RuntimeError("custom provider binaries require Guild qualification")
    required = {"PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "SYSTEMDRIVE", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOME",
        "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL",
        "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE",
        "DISABLE_TELEMETRY", "DISABLE_ERROR_REPORTING", "DO_NOT_TRACK", "OTEL_SDK_DISABLED", "CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY",
        "T3CODE_PRIVACY_SETTINGS_PATH", "T3CODE_HOME", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE"}
    environment = {name: value for name, value in os.environ.items() if name.upper() in required}
    original_home = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex")))
    auth_path = original_home / "auth.json"
    auth_before = None
    if args.provider == "codex":
        version = subprocess.run([str(executable), "--version"], capture_output=True, text=True, check=True).stdout.strip()
        if version != "codex-cli 0.166.0":
            raise RuntimeError("Guild's lazy host-tool refusal boundary requires qualified Codex 0.166.0")
        if auth_path.is_file():
            auth_before = bridge.read_file(auth_path)
            (profile / "auth.json").write_bytes(auth_before)
        # Only authentication and model catalog metadata cross into the isolated profile.
        if (original_home / "models_cache.json").is_file():
            shutil.copyfile(original_home / "models_cache.json", profile / "models_cache.json")
        environment["CODEX_HOME"] = str(profile)
    else:
        environment["CLAUDE_CONFIG_DIR"] = str(profile)
        environment.update({"ENABLE_CLAUDEAI_MCP_SERVERS": "false", "CLAUDE_CODE_AUTO_CONNECT_IDE": "0"})
    for key in list(environment):
        if key.startswith(("NODE_OPTIONS", "BUN_OPTIONS", "CLAUDE_CODE_SUBAGENT", "CODEX_CONFIG")):
            environment.pop(key)
    server = mcp_server(args)
    if args.provider == "codex":
        server = {**server, "tool_timeout_sec": 1200, "default_tools_approval_mode": "approve"}
    arguments = isolated_arguments(args.provider, args.arguments, server, profile)
    if config.get("disableOptionalEgress", False):
        if args.provider == "codex":
            arguments += bridge.CODEX_PRIVACY_ARGS
        environment.update({"DISABLE_TELEMETRY": "1", "DISABLE_ERROR_REPORTING": "1", "DO_NOT_TRACK": "1", "OTEL_SDK_DISABLED": "true", "CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY": "1"})
    process = subprocess.Popen([str(executable), *arguments], cwd=profile / "workspace", env=environment,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=sys.stderr, creationflags=subprocess.CREATE_NO_WINDOW)
    key = bridge.digest((args.provider + ":" + args.thread).encode())[:24]
    stop = Path(config["state"]) / "t3" / key / "stop"
    finished = threading.Event()

    def feed():
        try:
            pending = b""
            while not finished.is_set():
                data = os.read(sys.stdin.fileno(), 65536)
                if not data:
                    break
                pending += data
                while b"\n" in pending:
                    line, pending = pending.split(b"\n", 1)
                    value = json.loads(line)
                    try:
                        value = codex_frame(value, profile, server) if args.provider == "codex" else claude_frame(value, server)
                    except RuntimeError as error:
                        if "id" in value:
                            print(json.dumps({"jsonrpc": "2.0", "id": value["id"], "error": {"code": -32601, "message": str(error)}}), flush=True)
                        continue
                    process.stdin.write(json.dumps(value).encode() + b"\n")
                    process.stdin.flush()
        except (BrokenPipeError, OSError):
            pass
        finally:
            with contextlib.suppress(OSError):
                process.stdin.close()

    def watch():
        while not finished.wait(.1):
            if stop.exists():
                process.terminate()
                return

    threading.Thread(target=feed, daemon=True).start()
    threading.Thread(target=watch, daemon=True).start()
    try:
        for line in process.stdout:
            try:
                value = bridge.remap(json.loads(line), str(profile / "workspace"), str(source))
                sys.stdout.buffer.write(json.dumps(value, ensure_ascii=False).encode() + b"\n")
            except ValueError:
                sys.stdout.buffer.write(line)
            sys.stdout.buffer.flush()
        return process.wait()
    finally:
        finished.set()
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=15)
        if args.provider == "codex" and auth_before is not None and (profile / "auth.json").is_file() and auth_path.read_bytes() == auth_before:
            auth_after = (profile / "auth.json").read_bytes()
            if auth_after != auth_before:
                temporary = auth_path.with_name("auth.t3-" + uuid.uuid4().hex)
                temporary.write_bytes(auth_after)
                temporary.replace(auth_path)


def main():
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("mcp", "executor"), required=True)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--thread", required=True)
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    return daemon(args, config) if args.mode == "executor" else mcp(args, config)


if __name__ == "__main__":
    main()

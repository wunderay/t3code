"""Native Guild sandbox transport for T3's Codex and Claude stdio protocols."""
from __future__ import annotations

import argparse
import base64
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import tomllib
import urllib.parse
import uuid


if os.name == "nt" and not getattr(subprocess.Popen, "_t3_hidden", False):
    class HiddenProcess(subprocess.Popen):
        _t3_hidden = True

        def __init__(self, *arguments, **options):
            options["creationflags"] = options.get("creationflags", 0) | subprocess.CREATE_NO_WINDOW
            startup = options.get("startupinfo") or subprocess.STARTUPINFO()
            startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startup.wShowWindow = subprocess.SW_HIDE
            options["startupinfo"] = startup
            super().__init__(*arguments, **options)

    subprocess.Popen = HiddenProcess


MAX_FILE = 32 * 1024 * 1024
MAX_SNAPSHOT = 256 * 1024 * 1024
SESSION = ".t3-guild-session"
TOOLS = ".t3-guild-tools"
CODEX_PRIVACY_ARGS = [part for value in (
    'analytics.enabled=false', 'feedback.enabled=false', 'otel.exporter="none"',
    'otel.trace_exporter="none"', 'otel.metrics_exporter="none"', 'otel.log_user_prompt=false',
) for part in ("-c", value)]


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    temporary.write_text(json.dumps(value, sort_keys=True), encoding="utf-8")
    temporary.replace(path)


def safe_path(root: Path, relative: str, *, source_read: bool = False) -> Path:
    parts = relative.replace("\\", "/").split("/")
    if not parts or any(p in ("", ".", "..") or ":" in p for p in parts):
        raise RuntimeError("unsafe workspace path")
    if parts[0].casefold() in (".git", SESSION, TOOLS):
        raise RuntimeError("workspace handback contains private metadata")
    path = root.joinpath(*parts)
    for item in (path, *path.parents):
        if item == root.parent:
            break
        if item.is_symlink() or item.is_junction():
            raise RuntimeError("workspace handback refuses reparse points")
    if not path.resolve().is_relative_to(root.resolve()):
        raise RuntimeError("workspace path escaped its checkout")
    if path.exists() and (not path.is_file() or (not source_read and path.stat().st_nlink != 1)):
        raise RuntimeError("workspace handback refuses special files and hardlinks")
    return path


def read_file(path: Path) -> bytes:
    with path.open("rb") as stream:
        data = stream.read(MAX_FILE + 1)
    if len(data) > MAX_FILE:
        raise RuntimeError("workspace file exceeds the sandbox transfer limit")
    return data


def remap(value, source: str, destination: str):
    if isinstance(value, str):
        for old, new in ((source, destination), (source.replace("\\", "/"), destination.replace("\\", "/"))):
            value = re.sub(re.escape(old) + r"(?=$|[/\\\s\"'])", lambda _: new, value,
                           flags=re.IGNORECASE if re.match(r"^[a-zA-Z]:", old) else 0)
        return value
    if isinstance(value, list):
        return [remap(v, source, destination) for v in value]
    if isinstance(value, dict):
        return {k: remap(v, source, destination) for k, v in value.items()}
    return value


def is_terminal(provider: str, value) -> bool:
    return isinstance(value, dict) and (
        (provider == "codex" and value.get("method") == "turn/completed")
        or (provider == "claude" and value.get("type") == "result")
    )


def codex_external_policy(value):
    if value.get("method") == "turn/start":
        params = value.get("params", {})
        policy = params.get("sandboxPolicy")
        if isinstance(policy, dict) and policy.get("type") in ("workspaceWrite", "dangerFullAccess"):
            # The Guild LPAC already owns filesystem and network confinement.
            params["sandboxPolicy"] = {"type": "externalSandbox", "networkAccess": "enabled"}
    return value


# Host coordination tools can delegate to unsandboxed providers or read other projects.
COORDINATION_TOOLS = frozenset()


MAILBOX_CLIENT = r'''
import json,os,pathlib,sys,time,uuid
root=pathlib.Path(os.environ['T3_GUILD_MAILBOX']);root.mkdir(exist_ok=True)
def request(payload):
 key=uuid.uuid4().hex;source=root/(key+'.request');reply=root/(key+'.response')
 tmp=root/(key+'.tmp');tmp.write_text(json.dumps(payload),encoding='utf-8');tmp.replace(source)
 deadline=time.monotonic()+4000
 while not reply.exists():
  if time.monotonic()>deadline: raise RuntimeError('T3 sandbox bridge did not respond')
  time.sleep(.05)
 result=json.loads(reply.read_text(encoding='utf-8'));reply.unlink()
 if result.get('failure'): raise RuntimeError('T3 sandbox bridge refused the request')
 return result.get('response')
if sys.argv[1]=='auth':
 response=request({'kind':'auth'});sys.stdout.write(response);sys.stdout.flush()
else:
 for line in sys.stdin:
  payload=json.loads(line);response=request({'kind':'mcp','server':sys.argv[1],'payload':payload})
  if response is not None: print(json.dumps(response),flush=True)
'''


class CallbackBroker:
    def __init__(self, native, root: Path, python: str, script: str):
        self.native, self.root, self.python, self.script = native, root, python, script
        self.servers = {}
        self.auth = None
        self.closed = threading.Event()
        self.thread = threading.Thread(target=self.serve, daemon=True)

    def transform(self, value):
        if isinstance(value, list):
            return [self.transform(v) for v in value]
        if not isinstance(value, dict):
            return value
        result = {}
        for key, child in value.items():
            if key in ("t3-code", "mcp_servers.t3-code") and isinstance(child, dict) and "url" in child:
                endpoint = urllib.parse.urlsplit(child["url"])
                if endpoint.scheme != "http" or endpoint.hostname not in ("127.0.0.1", "localhost", "::1") \
                        or not endpoint.port or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment \
                        or not endpoint.path.startswith("/mcp"):
                    raise RuntimeError("T3 MCP bridge requires an exact local MCP endpoint")
                headers = child.get("headers", child.get("http_headers", {}))
                authorization = headers.get("Authorization")
                if not isinstance(authorization, str) or not authorization.startswith("Bearer "):
                    raise RuntimeError("T3 MCP bridge requires scoped bearer authentication")
                self.servers["t3-code"] = (child["url"], authorization)
                replacement = {"command": self.python, "args": ["-I", "-B", self.script, "t3-code"]}
                if key == "t3-code":
                    replacement["type"] = "stdio"
                else:
                    replacement["tool_timeout_sec"] = 4000
                result[key] = replacement
            else:
                result[key] = self.transform(child)
        return result

    def managed_auth(self, arguments: list[str]) -> list[str]:
        for i, argument in enumerate(arguments[:-1]):
            if argument not in ("-c", "--config"):
                continue
            try:
                config = tomllib.loads(arguments[i + 1])
            except tomllib.TOMLDecodeError:
                continue
            auth = config.get("model_providers", {}).get("openai_token_sharing", {}).get("auth")
            if not isinstance(auth, dict):
                continue
            command, argv = auth.get("command"), auth.get("args")
            if not isinstance(command, str) or not isinstance(argv, list) \
                    or not all(isinstance(a, str) for a in argv) or "__managed-chatgpt-token" not in argv:
                raise RuntimeError("unrecognized managed Codex token callback")
            self.auth = [command, *argv]
            inline = "{command=" + json.dumps(self.python) + ",args=" + json.dumps(["-I", "-B", self.script, "auth"]) \
                     + ",timeout_ms=30000,refresh_interval_ms=0}"
            return [*arguments, "-c", "model_providers.openai_token_sharing.auth=" + inline]
        return arguments

    def mcp(self, server: str, payload: dict):
        if server not in self.servers:
            raise RuntimeError("unregistered MCP callback")
        method = payload.get("method")
        if method not in ("initialize", "ping", "notifications/initialized", "tools/list", "tools/call"):
            return {"jsonrpc": "2.0", "id": payload.get("id"), "error": {"code": -32601, "message": "Unavailable in Guild sandboxes"}}
        if method == "tools/call" and payload.get("params", {}).get("name") not in COORDINATION_TOOLS:
            return {"jsonrpc": "2.0", "id": payload.get("id"), "error": {"code": -32601, "message": "Host execution tools are unavailable in Guild sandboxes"}}
        if method == "notifications/initialized":
            return None
        result = {}
        if method == "initialize":
            result = {"protocolVersion": payload.get("params", {}).get("protocolVersion", "2025-06-18"),
                      "capabilities": {"tools": {}},
                      "serverInfo": {"name": "t3-guild-sandbox", "version": "1"}}
        elif method == "tools/list":
            result = {"tools": []}
        return {"jsonrpc": "2.0", "id": payload.get("id"), "result": result}

    def serve(self):
        active = set()
        guard = threading.Lock()
        slots = threading.BoundedSemaphore(4)
        def respond(path):
            try:
                value = json.loads(self.native._read_owned(path, self.root))
                if value.get("kind") == "mcp":
                    response = self.mcp(value["server"], value["payload"])
                elif value.get("kind") == "auth" and self.auth is not None:
                    result = subprocess.run(self.auth, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                            stderr=subprocess.PIPE, timeout=30, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                    if result.returncode or len(result.stdout) > 65536:
                        raise RuntimeError("managed authentication callback failed")
                    response = result.stdout.decode("utf-8")
                    json.loads(response)
                else:
                    raise RuntimeError("unknown sandbox callback")
                write_json(path.with_suffix(".response"), {"response": response})
            except Exception:
                write_json(path.with_suffix(".response"), {"failure": True})
            finally:
                path.unlink(missing_ok=True)
                with guard:
                    active.discard(path.name)
                slots.release()
        while not self.closed.wait(.05):
            if not self.root.is_dir():
                continue
            for path in self.root.glob("*.request"):
                with guard:
                    if re.fullmatch(r"[0-9a-f]{32}\.request", path.name) and path.name not in active and slots.acquire(blocking=False):
                        active.add(path.name)
                        threading.Thread(target=respond, args=(path,), daemon=True).start()


def runtime(config: dict):
    state = str(Path(config["state"]).resolve())
    os.environ["GUILD_STATE"] = state
    os.environ["GUILD_LITE_STATE"] = state
    sys.path.insert(0, config["guildSource"])
    from guild import srt_windows as native
    if native.VERSION != config["runtimeVersion"]:
        raise RuntimeError("Guild runtime version changed; requalify the T3 sandbox installation")
    original_run = native.run
    def long_path_run(argv, *arguments, **options):
        # Claude's escaped project directory can put descendants beyond Win32 MAX_PATH.
        if Path(argv[0]).name.casefold() == "icacls.exe" and Path(argv[1]).is_absolute():
            absolute = str(Path(argv[1]).absolute())
            extended = absolute if absolute.startswith("\\\\?\\") else "\\\\?\\" + absolute
            argv = [argv[0], extended, *argv[2:]]
        return original_run(argv, *arguments, **options)
    native.run = long_path_run
    native.require_host()
    return native


def git_runner(config: dict):
    spec = importlib.util.spec_from_file_location("t3_guild_git", config["gitLauncher"])
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    hooks = Path(config["state"]) / "empty-hooks"
    hooks.mkdir(parents=True, exist_ok=True)

    def git(cwd: Path | None, *args: str, data: bytes = b"", check: bool = True):
        result = module.run_git(
            ["-c", f"core.hooksPath={hooks}", "-c", "core.fsmonitor=false", "-c", "core.autocrlf=false", *args],
            cwd=cwd, input=data, capture=True, timeout=180,
            environ={**os.environ, "GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "Never"},
        )
        if check and result.returncode:
            raise RuntimeError("Guild sandbox Git operation failed: " + " ".join(args[:2]))
        return result
    return git


def tracked_files(git, source: Path) -> list[str]:
    raw = git(source, "ls-files", "-z", "--cached", "--others", "--exclude-standard").stdout
    return sorted(set(p.decode("utf-8", "strict") for p in raw.split(b"\0") if p))


def snapshot(git, source: Path) -> dict[str, str]:
    files = {}
    for name in tracked_files(git, source):
        path = safe_path(source, name, source_read=True)
        if path.exists():
            files[name] = digest(read_file(path))
    return files


def index_path(git, source: Path) -> Path:
    path = Path(git(source, "rev-parse", "--path-format=absolute", "--git-path", "index").stdout.decode().strip())
    return path


def index_digest(git, source: Path) -> str:
    return git(source, "write-tree").stdout.decode().strip()


def refresh_codex_account(executable: Path, home: Path, source: Path, private=False) -> None:
    path = home / "auth.json"
    if not path.is_file():
        return
    auth = json.loads(path.read_text(encoding="utf-8"))
    access = auth.get("tokens", {}).get("access_token")
    if not access:
        return
    try:
        body = access.split(".")[1]
        expires = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4))).get("exp", 0)
    except (ValueError, IndexError):
        expires = 0
    if expires > time.time() + 180:
        return
    process = subprocess.Popen([str(executable), *(CODEX_PRIVACY_ARGS if private else []), "-c", 'cli_auth_credentials_store="file"', "app-server"],
                               cwd=source, env={**os.environ, "CODEX_HOME": str(home)},
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    messages = queue.Queue(maxsize=16)
    def receive():
        try:
            for line in process.stdout:
                if len(line) > 1024 * 1024:
                    break
                messages.put(json.loads(line), timeout=60)
        except (ValueError, queue.Full):
            pass
        finally:
            with contextlib.suppress(queue.Full):
                messages.put_nowait(None)
    reader = threading.Thread(target=receive, daemon=True)
    reader.start()
    def send(value):
        process.stdin.write((json.dumps(value) + "\n").encode())
        process.stdin.flush()
    try:
        send({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "t3-code", "version": "0.1.5"}}})
        while True:
            value = messages.get(timeout=60)
            if value is None or value.get("error"):
                raise RuntimeError("Codex account renewal failed; sign in with that CLI or select a managed account")
            if value.get("id") == 1:
                send({"method": "initialized"})
                send({"id": 2, "method": "account/read", "params": {"refreshToken": True}})
            if value.get("id") == 2:
                if not value.get("result", {}).get("account"):
                    raise RuntimeError("Codex needs an authenticated host account")
                return
    finally:
        process.stdin.close()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)
        reader.join(timeout=2)
        process.stdout.close()


# This program runs inside the LPAC. Git configuration and repository content never execute on the controller.
EXPORT = r'''
import os,sys,json,base64,hashlib,subprocess,pathlib,stat
d=json.load(sys.stdin);root=pathlib.Path.cwd();tools=d['git'];limit=d['maxFile'];total=0
def git(*args):
 p=subprocess.run([*tools,'-c','core.fsmonitor=false',*args],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 if p.returncode: raise RuntimeError('sandbox Git export failed')
 return p.stdout
names=git('ls-files','-z','--cached','--others','--exclude-standard').split(b'\0');files={}
for raw in names:
 if not raw: continue
 name=raw.decode('utf-8');parts=pathlib.PurePosixPath(name).parts
 if not parts or parts[0].lower() in ('.git','.t3-guild-session','.t3-guild-tools') or '..' in parts: continue
 path=root.joinpath(*parts)
 if not path.exists(): continue
 if any(p.is_symlink() or p.is_junction() for p in (root.joinpath(*parts[:i]) for i in range(1,len(parts)+1))): raise RuntimeError('sandbox export refuses reparse points')
 st=path.stat()
 if not stat.S_ISREG(st.st_mode) or st.st_nlink!=1 or st.st_size>limit: raise RuntimeError('sandbox export refused a file')
 data=path.read_bytes();sha=hashlib.sha256(data).hexdigest()
 files[name]={'sha':sha}
 if d['baseline'].get(name)!=sha:
  total+=len(data)
  if total>d['maxSnapshot']: raise RuntimeError('sandbox snapshot exceeds transfer limit')
  files[name]['data']=base64.b64encode(data).decode('ascii')
head=git('rev-parse','HEAD').decode().strip();bundle=None
if head!=d['head']:
 path=pathlib.Path(os.environ['TMP'])/'handback.bundle'
 git('bundle','create',str(path),'HEAD','^'+d['head'])
 total+=path.stat().st_size
 if total>d['maxSnapshot']: raise RuntimeError('sandbox Git bundle exceeds transfer limit')
 bundle=base64.b64encode(path.read_bytes()).decode('ascii')
patch=git('diff','--cached','--binary','--no-ext-diff','--no-textconv',head)
if total+len(patch)>d['maxSnapshot']: raise RuntimeError('sandbox snapshot exceeds transfer limit')
print(json.dumps({'files':files,'head':head,'bundle':bundle,'indexPatch':base64.b64encode(patch).decode('ascii')}))
'''


def handback(git, source: Path, baseline: dict, exported: dict, transfer: Path) -> dict:
    if git(source, "rev-parse", "HEAD").stdout.decode().strip() != baseline["head"]:
        raise RuntimeError("The host branch changed during the sandbox session; sandbox work was retained")
    if index_digest(git, source) != baseline["index"]:
        raise RuntimeError("The host staging area changed during the sandbox session; sandbox work was retained")
    files = exported["files"]
    changed = {name for name in set(baseline["files"]) | set(files)
               if baseline["files"].get(name) != files.get(name, {}).get("sha")}
    for name in changed:
        path = safe_path(source, name)
        current = digest(read_file(path)) if path.exists() else None
        if current != baseline["files"].get(name):
            raise RuntimeError("A host file changed during the sandbox session; sandbox work was retained")
        safe_path(source, name)
    head = exported["head"]
    if not re.fullmatch(r"[a-f0-9]{40}", head):
        raise RuntimeError("sandbox returned an invalid commit identity")
    prepared = {}
    for name in changed:
        item = files.get(name)
        if item is None:
            prepared[name] = None
        else:
            data = base64.b64decode(item["data"], validate=True)
            if len(data) > MAX_FILE or digest(data) != item["sha"]:
                raise RuntimeError("sandbox file integrity check failed")
            prepared[name] = data
    bundle_bytes = base64.b64decode(exported["bundle"], validate=True) if head != baseline["head"] else b""
    patch = base64.b64decode(exported["indexPatch"], validate=True)
    if sum(len(value) for value in prepared.values() if value is not None) + len(bundle_bytes) + len(patch) > MAX_SNAPSHOT:
        raise RuntimeError("sandbox snapshot exceeds transfer limit")
    if head != baseline["head"]:
        bundle = transfer / "changes.bundle"
        bundle.write_bytes(bundle_bytes)
        git(source, "bundle", "verify", str(bundle))
        git(source, "fetch", "--no-tags", "--no-write-fetch-head", str(bundle), "HEAD")
        git(source, "merge-base", "--is-ancestor", baseline["head"], head)
    temporary_index = transfer / "index"
    # Validate the incoming index separately before changing the host's ref, files or staging area.
    old_index = index_path(git, source)
    index_bytes = old_index.read_bytes() if old_index.exists() else b""
    temporary_index.write_bytes(index_bytes)
    old_override = os.environ.get("GIT_INDEX_FILE")
    os.environ["GIT_INDEX_FILE"] = str(temporary_index)
    try:
        git(source, "read-tree", head)
        if patch:
            git(source, "apply", "--cached", "--binary", "-", data=patch)
    finally:
        if old_override is None:
            os.environ.pop("GIT_INDEX_FILE", None)
        else:
            os.environ["GIT_INDEX_FILE"] = old_override
    backup = {name: read_file(safe_path(source, name)) if safe_path(source, name).exists() else None
              for name in changed}
    applied = []
    try:
        for name, data in prepared.items():
            target = safe_path(source, name)
            if data is None:
                target.unlink(missing_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                temp = target.with_name(target.name + ".t3-guild-" + uuid.uuid4().hex)
                temp.write_bytes(data)
                temp.replace(target)
            applied.append(name)
        if head != baseline["head"]:
            git(source, "update-ref", "HEAD", head, baseline["head"])
        temporary_index.replace(old_index)
    except BaseException:
        for name in reversed(applied):
            target = safe_path(source, name)
            if backup[name] is None:
                target.unlink(missing_ok=True)
            else:
                target.write_bytes(backup[name])
        if head != baseline["head"]:
            git(source, "update-ref", "HEAD", baseline["head"], head, check=False)
        raise
    return {"files": {name: item["sha"] for name, item in files.items()},
            "head": head, "index": index_digest(git, source)}


STREAM_BOOTSTRAP = r'''
frame=bytearray()
while True:
 byte=os.read(0,1)
 if not byte or byte==b'\n': break
 frame.extend(byte)
d=json.loads(frame)
for p,t in d['files'].items():
 parent=os.path.dirname(p)
 if not os.path.isdir(parent): os.makedirs(parent,exist_ok=True)
 with open(p,'w',encoding='utf-8') as f: f.write(t)
os.environ.update(d['env'])
p=subprocess.Popen(d['argv'],stdin=subprocess.PIPE,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
import threading,ctypes,ctypes.wintypes as w,msvcrt
closed=threading.Event()
def feed():
 peek=ctypes.WinDLL('kernel32',use_last_error=True).PeekNamedPipe
 peek.argtypes=[w.HANDLE,w.LPVOID,w.DWORD,w.LPVOID,ctypes.POINTER(w.DWORD),w.LPVOID];peek.restype=w.BOOL
 handle=w.HANDLE(msvcrt.get_osfhandle(0))
 try:
  while not closed.is_set():
   available=w.DWORD()
   if not peek(handle,None,0,None,ctypes.byref(available),None): break
   if not available.value: closed.wait(.02);continue
   data=os.read(0,min(available.value,65536));p.stdin.write(data);p.stdin.flush()
 except (BrokenPipeError,OSError): pass
 finally:
  try: p.stdin.close()
  except OSError: pass
  if p.poll() is None and not any(a in ('--version','--help') for a in d['argv']): p.terminate()
thread=threading.Thread(target=feed,daemon=True);thread.start()
code=p.wait();closed.set();thread.join(timeout=1);sys.exit(code)
'''


class StreamingProcess:
    def __init__(self, process, transform, synchronize, stop_path, stop_callback, passive=False):
        self.process, self.transform, self.synchronize = process, transform, synchronize
        self.stop_path = stop_path
        self.stop_callback, self.passive = stop_callback, passive
        self.cancelled = threading.Event()
        self.closed = threading.Event()

    @property
    def returncode(self):
        return self.process.returncode

    def communicate(self, payload, timeout):
        process = self.process
        process.stdin.write(payload + b"\n")
        process.stdin.flush()
        gate = threading.Lock()
        failures = []

        def feed():
            import ctypes
            import ctypes.wintypes as w
            import msvcrt
            peek = ctypes.WinDLL("kernel32", use_last_error=True).PeekNamedPipe
            peek.argtypes = [w.HANDLE, w.LPVOID, w.DWORD, w.LPVOID, ctypes.POINTER(w.DWORD), w.LPVOID]
            peek.restype = w.BOOL
            handle = w.HANDLE(msvcrt.get_osfhandle(sys.stdin.fileno()))
            pending = b""
            eof = False
            try:
                while not self.closed.is_set():
                    available = w.DWORD()
                    if not peek(handle, None, 0, None, ctypes.byref(available), None):
                        eof = True
                        break
                    if not available.value:
                        self.closed.wait(.02)
                        continue
                    pending += os.read(sys.stdin.fileno(), min(available.value, 65536))
                    while b"\n" in pending:
                        line, pending = pending.split(b"\n", 1)
                        with gate:
                            process.stdin.write(self.transform(line + b"\n", incoming=True))
                            process.stdin.flush()
            except (BrokenPipeError, OSError):
                pass
            finally:
                if not self.passive and eof:
                    self.cancelled.set()
                with contextlib.suppress(OSError):
                    process.stdin.close()

        def watch_stop():
            while not self.closed.wait(.05):
                if self.stop_path.exists():
                    self.cancelled.set()
                    self.stop_callback()
                    return

        def errors():
            for data in iter(lambda: process.stderr.read1(65536), b""):
                sys.stderr.buffer.write(data)
                sys.stderr.buffer.flush()

        feeder = threading.Thread(target=feed, daemon=True)
        error_reader = threading.Thread(target=errors, daemon=True)
        feeder.start()
        error_reader.start()
        threading.Thread(target=watch_stop, daemon=True).start()
        try:
            for line in process.stdout:
                translated = self.transform(line, incoming=False)
                with gate:
                    self.synchronize(line, final=False)
                sys.stdout.buffer.write(translated)
                sys.stdout.buffer.flush()
            process.wait(timeout=timeout)
            if not self.cancelled.is_set():
                with gate:
                    self.synchronize(b"", final=True)
        except BaseException as exc:
            failures.append(exc)
        finally:
            self.closed.set()
            feeder.join(timeout=2)
            error_reader.join(timeout=2)
        if failures:
            raise failures[0]
        return b"", b""


def refresh_image(config: dict, native) -> None:
    source = json.loads(Path(config["sourceImage"]).read_text(encoding="utf-8"))["manifest"]
    roots = [Path(p) for p in source["roots"]]
    source["files"] = native._inventory(roots)
    target = Path(config["state"]) / "native-manifest.json"
    write_json(target, source)
    inventory = native._inventory
    # Import validates the same immutable snapshot, not a second independently generated manifest.
    native._inventory = lambda requested: source["files"] if requested == roots else inventory(requested)
    try:
        identity = native.import_image(config["image"], target)
    finally:
        native._inventory = inventory
    print(json.dumps({"image": config["image"], "identity": identity, "files": len(source["files"])}))


def run(args, config: dict, native) -> int:
    source = Path(args.workspace).resolve(strict=True)
    git = git_runner(config)
    top = Path(git(source, "rev-parse", "--show-toplevel").stdout.decode().strip()).resolve()
    if source != top:
        raise RuntimeError("Guild sandboxes currently require the repository root as the project workspace")
    info = json.loads(native.image_path(config["image"]).read_text(encoding="utf-8"))
    tools = info["manifest"]["tools"]
    if args.provider not in tools:
        raise RuntimeError("the prepared Guild image does not declare this provider")
    requested = Path(args.binary)
    if requested.name.casefold() not in (args.provider, args.provider + ".cmd", args.provider + ".exe"):
        if not requested.is_absolute() or requested.suffix.casefold() != ".exe":
            raise RuntimeError("custom provider launchers must be standalone native executables")
    key = digest((args.provider + ":" + args.thread).encode())[:24]
    control = Path(config["state"]) / "t3" / key
    control.mkdir(parents=True, exist_ok=True)
    record_path = control / "session.json"
    if record_path.exists() and json.loads(record_path.read_text()).get("pending"):
        recover(args, config, native, quiet=True)
    stop_path = control / "stop"
    if stop_path.exists():
        return 130
    previous = json.loads(record_path.read_text()) if record_path.exists() else None
    box = native.Box(config["image"], previous["volume"] if previous else native.PREFIX + "t3-" + key)
    data = native._dir("volumes", box.volume) / "data"
    run_name = box.volume + "-t3"
    record = {"pending": True, "launched": False, "volume": box.volume, "run": run_name, "source": str(source), "provider": args.provider}
    saved_session = control / "saved-session"
    if previous:
        if previous["volume"] != box.volume or previous["source"] != str(source):
            raise RuntimeError("sandbox session identity or workspace changed")
        old = data / SESSION
        already_saved = saved_session.exists()
        saved_session.mkdir(exist_ok=True)
        if old.exists() and not already_saved:
            for path in old.rglob("*"):
                if path.is_symlink() or path.is_junction() or (path.is_file() and path.stat().st_nlink != 1):
                    raise RuntimeError("retained provider session contains a link")
                target = saved_session / path.relative_to(old)
                if path.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(read_file(path))
    elif native.volume_exists(box.volume):
        raise RuntimeError("sandbox volume has no matching controller record")
    write_json(record_path, record)
    if previous:
        box.remove()
    box.create()
    if json.loads((native._dir("volumes", box.volume) / "image.json").read_text()) != native._image_identity(info):
        raise RuntimeError("the prepared image changed during sandbox setup")
    git(None, "clone", "--no-hardlinks", "--no-checkout", "--", str(source), str(data))
    baseline = {"files": snapshot(git, source), "head": git(source, "rev-parse", "HEAD").stdout.decode().strip(),
                "index": index_digest(git, source)}
    write_json(control / "baseline.json", baseline)
    for name in baseline["files"]:
        target = safe_path(data, name)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(read_file(safe_path(source, name, source_read=True)))
    git(data, "read-tree", baseline["head"])
    patch = git(source, "diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", "HEAD").stdout
    if patch:
        git(data, "apply", "--cached", "--binary", "-", data=patch)
    session = data / SESSION
    session.mkdir()
    if previous:
        shutil.copytree(saved_session, session, dirs_exist_ok=True)
        shutil.rmtree(saved_session)
    executable_source = requested.resolve(strict=True) if requested.is_absolute() and requested.suffix.casefold() == ".exe" else Path(tools[args.provider][0])
    tool_root = data / TOOLS
    tool_root.mkdir()
    package_root = executable_source.parent.parent
    packaged_codex = args.provider == "codex" and (package_root / "codex-package.json").is_file()
    source_root = package_root if packaged_codex else executable_source.parent
    sources = source_root.rglob("*") if packaged_codex else source_root.glob("*.exe")
    for sibling in sources:
        if sibling.is_symlink() or sibling.is_junction():
            raise RuntimeError("provider package contains a reparse point")
        if not sibling.is_file():
            continue
        destination = tool_root / sibling.relative_to(source_root)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(sibling, destination)
        expected = info["manifest"]["files"].get(str(sibling))
        if expected is not None and native._hash(destination) != expected:
            raise RuntimeError("provider package changed while preparing its sandbox copy")
    executable = tool_root / executable_source.relative_to(source_root)
    provider_argv = [str(executable)]
    exclude = data / ".git/info/exclude"
    with exclude.open("a", encoding="utf-8") as stream:
        stream.write("\n/" + SESSION + "/\n/" + TOOLS + "/\n")
    home = Path(os.environ.get("CODEX_HOME" if args.provider == "codex" else "CLAUDE_CONFIG_DIR",
                               str(Path.home() / (".codex" if args.provider == "codex" else ".claude"))))
    if args.provider == "codex" and not any("openai_token_sharing" in a for a in args.arguments):
        refresh_codex_account(executable_source, home, source, config.get("disableOptionalEgress", False))
    files = {}
    access_env = {}
    private_home = "/home/guild/.codex" if args.provider == "codex" else "/home/guild/.claude"
    for filename in (("auth.json", "config.toml") if args.provider == "codex" else (".credentials.json", ".claude.json")):
        path = home / filename
        if path.is_file():
            text = path.read_text(encoding="utf-8")
            if filename == "auth.json":
                auth = json.loads(text)
                if isinstance(auth.get("tokens"), dict):
                    auth["tokens"]["refresh_token"] = ""
                text = json.dumps(auth)
            if filename == ".credentials.json":
                oauth = json.loads(text).get("claudeAiOauth", {})
                if oauth.get("accessToken"):
                    access_env["CLAUDE_CODE_OAUTH_TOKEN"] = oauth["accessToken"]
                continue
            files[private_home + "/" + filename] = text
    if args.provider == "claude" and (Path.home() / ".claude.json").is_file():
        files["/home/guild/.claude.json"] = (Path.home() / ".claude.json").read_text(encoding="utf-8")
    original_bootstrap, original_launch = native.BOOTSTRAP, native.launch
    private_root = native._dir("runs", run_name) / "home"
    callback_script = str(private_root / "t3-callback.py")
    files["/home/guild/t3-callback.py"] = MAILBOX_CLIENT
    if args.provider == "codex":
        import ssl
        custom_ca = os.environ.get("CODEX_CA_CERTIFICATE") or os.environ.get("SSL_CERT_FILE")
        ca = Path(custom_ca).read_text(encoding="utf-8") if custom_ca else "".join(
            ssl.DER_cert_to_PEM_cert(cert)
            for cert, encoding, trust in ssl.enum_certificates("ROOT")
            if encoding == "x509_asn" and (trust is True or "1.3.6.1.5.5.7.3.1" in trust)
        )
        if not ca:
            raise RuntimeError("Codex requires the host's trusted TLS certificates")
        files["/home/guild/t3-ca.pem"] = ca
        # Codex selects rustls for a CA bundle; Schannel cannot initialize inside LPAC.
        access_env["CODEX_CA_CERTIFICATE"] = str(private_root / "t3-ca.pem")
    broker = CallbackBroker(native, private_root / "callbacks", tools["python3"][0], callback_script)
    native.BOOTSTRAP = "import json,os,sys,subprocess\n" + native.GUARD + STREAM_BOOTSTRAP
    transfer = control / "transfer"
    transfer.mkdir(exist_ok=True)
    clean = False
    streaming = None

    def synchronize(line: bytes, *, final: bool):
        nonlocal baseline
        try:
            terminal = is_terminal(args.provider, json.loads(line)) if line else False
        except (ValueError, UnicodeError):
            terminal = False
        if not final and not terminal:
            return
        native.BOOTSTRAP = original_bootstrap
        try:
            result, _ = box.run(["python3", "-I", "-B", "-c", EXPORT],
                                stdin=json.dumps({"git": tools["git"], "baseline": baseline["files"],
                                                  "head": baseline["head"], "maxFile": MAX_FILE, "maxSnapshot": MAX_SNAPSHOT}),
                                timeout=180, name=box.volume + "-export-" + uuid.uuid4().hex[:8])
        finally:
            native.BOOTSTRAP = "import json,os,sys,subprocess\n" + native.GUARD + STREAM_BOOTSTRAP
        if result.code:
            raise RuntimeError("sandbox workspace export failed; work was retained")
        exported = json.loads(result.out)
        baseline = handback(git, source, baseline, exported, transfer)
        write_json(control / "baseline.json", baseline)

    def transform(line: bytes, *, incoming: bool) -> bytes:
        try:
            value = json.loads(line)
        except (ValueError, UnicodeError):
            return line
        value = remap(value, str(source if incoming else data), str(data if incoming else source))
        if incoming:
            if args.provider == "codex":
                value = codex_external_policy(value)
            value = broker.transform(value)
        return json.dumps(value, ensure_ascii=False).encode("utf-8") + b"\n"

    def launch(name, root, spec, argv, **kwargs):
        nonlocal streaming
        if name == run_name and stop_path.exists():
            raise InterruptedError("sandbox startup was cancelled")
        process = original_launch(name, root, spec, argv, **kwargs)
        if name == run_name:
            record["launched"] = True
            write_json(record_path, record)
            streaming = StreamingProcess(process, transform, synchronize, stop_path,
                                         lambda: native.stop_container(run_name),
                                         passive=any(a in ("--version", "--help") for a in args.arguments))
            return streaming
        return process

    native.launch = launch
    from guild import srt_windows_relay as relay_transport
    original_relay = relay_transport.relay
    @contextlib.contextmanager
    def observed_relay(*arguments, **options):
        with original_relay(*arguments, **options) as handle:
            stop_recording = threading.Event()
            def capture():
                count = -1
                while not stop_recording.wait(.2):
                    if count != len(handle.events):
                        count = len(handle.events)
                        write_json(control / "relay-events.json", [
                            {key: event[key] for key in ("event", "code", "host", "status", "method") if key in event}
                            for event in handle.events
                        ])
            recorder = threading.Thread(target=capture, daemon=True)
            recorder.start()
            try:
                yield handle
            finally:
                stop_recording.set()
                recorder.join(timeout=2)
                write_json(control / "relay-events.json", [
                    {key: event[key] for key in ("event", "code", "host", "status", "method", "hello_header", "hello_error", "hello_size") if key in event}
                    for event in handle.events
                ])
    relay_transport.relay = observed_relay
    environment = {"CODEX_HOME" if args.provider == "codex" else "CLAUDE_CONFIG_DIR": private_home,
                   "CODEX_INTERNAL_ORIGINATOR_OVERRIDE": "t3-code",
                   "T3_GUILD_MAILBOX": str(private_root / "callbacks"), **access_env}
    if config.get("disableOptionalEgress", False):
        environment.update({"DISABLE_TELEMETRY": "1", "DISABLE_ERROR_REPORTING": "1", "DO_NOT_TRACK": "1",
                            "CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY": "1", "OTEL_SDK_DISABLED": "true"})
    for key in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"):
        if os.environ.get(key):
            environment[key] = os.environ[key]
    links = {private_home + ("/sessions" if args.provider == "codex" else "/projects"):
             "/workspace/" + SESSION + ("/codex" if args.provider == "codex" else "/claude")}
    try:
        arguments = broker.managed_auth(args.arguments) if args.provider == "codex" else args.arguments
        if args.provider == "codex":
            if config.get("disableOptionalEgress", False):
                arguments = [*arguments, *CODEX_PRIVACY_ARGS]
            arguments = [*arguments, "-c", 'cli_auth_credentials_store="file"']
        broker.thread.start()
        result, _ = box.run([*provider_argv, *remap(arguments, str(source), str(data))], network="bridge", files=files,
                            secret_env=environment, links=links, timeout=3600, name=run_name)
        clean = streaming is not None and not streaming.cancelled.is_set()
        return result.code
    finally:
        broker.closed.set()
        broker.thread.join(timeout=2)
        native.BOOTSTRAP, native.launch = original_bootstrap, original_launch
        relay_transport.relay = original_relay
        write_json(record_path, {**record, "pending": not clean})
        if clean:
            shutil.rmtree(transfer)


@contextlib.contextmanager
def controller_lock(config, provider, thread):
    import msvcrt
    key = digest((provider + ":" + thread).encode())[:24]
    path = Path(config["state"]) / "t3" / key / "owner.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as stream:
        stream.seek(0)
        if not stream.read(1):
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        try:
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError as exc:
            raise RuntimeError("another controller still owns this sandbox session") from exc
        try:
            yield
        finally:
            stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)


def recover(args, config, native, *, quiet=False):
    key = digest((args.provider + ":" + args.thread).encode())[:24]
    control = Path(config["state"]) / "t3" / key
    record_path = control / "session.json"
    record = json.loads(record_path.read_text(encoding="utf-8"))
    if not record.get("pending"):
        if not quiet:
            print("No pending sandbox handback.")
        return 0
    box = native.Box(config["image"], record["volume"])
    if native.container_exists(record["run"]):
        if not native.stop_container(record["run"]):
            raise RuntimeError("sandbox termination is unconfirmed; retained state is unchanged")
        run_info = json.loads((native._dir("runs", record["run"]) / "run.json").read_text())
        with native.lease(run_info["slot"], wait=False):
            pass
    if record.get("launched") is False:
        write_json(record_path, {**record, "pending": False})
        return 0
    baseline = json.loads((control / "baseline.json").read_text(encoding="utf-8"))
    info = json.loads(native.image_path(config["image"]).read_text(encoding="utf-8"))
    result, _ = box.run(["python3", "-I", "-B", "-c", EXPORT], stdin=json.dumps({
        "git": info["manifest"]["tools"]["git"], "baseline": baseline["files"], "head": baseline["head"],
        "maxFile": MAX_FILE, "maxSnapshot": MAX_SNAPSHOT,
    }), timeout=180)
    if result.code:
        raise RuntimeError("sandbox recovery export failed; retained work is unchanged")
    transfer = control / "transfer"
    transfer.mkdir(exist_ok=True)
    updated = handback(git_runner(config), Path(record["source"]), baseline, json.loads(result.out), transfer)
    write_json(control / "baseline.json", updated)
    write_json(record_path, {**record, "pending": False})
    shutil.rmtree(transfer)
    if not quiet:
        print("Recovered sandbox work without overwriting host edits.")
    return 0


def with_reporting_privacy(config, provider, privacy_path):
    if not privacy_path or provider not in ("codex", "claude"):
        return config
    allowed = False
    try:
        privacy = json.loads(Path(privacy_path).read_text(encoding="utf-8")).get("privacy", {})
        allowed = privacy.get("codexReporting" if provider == "codex" else "claudeReporting") is True
    except (OSError, ValueError, AttributeError):
        pass
    return {**config, "disableOptionalEgress": not allowed}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--refresh-image", action="store_true")
    parser.add_argument("--recover", action="store_true")
    parser.add_argument("--credential", action="store_true")
    parser.add_argument("--provider", choices=("codex", "claude"))
    parser.add_argument("--workspace")
    parser.add_argument("--thread")
    parser.add_argument("--binary")
    parser.add_argument("arguments", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.arguments[:1] == ["--"]:
        args.arguments = args.arguments[1:]
    config = json.loads(args.config.read_text(encoding="utf-8"))
    privacy_path = os.environ.get("T3CODE_PRIVACY_SETTINGS_PATH") or config.get("privacySettingsPath")
    config = with_reporting_privacy(config, args.provider, privacy_path)
    if args.credential:
        if not config.get("claudeCredential"):
            raise RuntimeError("no Guild Claude credential is configured")
        os.environ["GUILD_STATE"] = config["state"]
        os.environ["GUILD_LITE_STATE"] = config["state"]
        sys.path.insert(0, config["guildSource"])
        from guild.agents import windows_credential
        sys.stdout.write(windows_credential(config["claudeCredential"]))
        return 0
    if config.get("lifecycle") == "thread-lazy-v1" and not args.refresh_image and not args.recover:
        spec = importlib.util.spec_from_file_location("t3_guild_lazy", Path(__file__).with_name("guild_lazy.py"))
        lazy = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(lazy)
        return lazy.harness(args, config)
    native = runtime(config)
    if args.refresh_image:
        refresh_image(config, native)
        return 0
    if args.recover:
        if not args.provider or not args.thread:
            parser.error("provider and thread are required for recovery")
        with controller_lock(config, args.provider, args.thread):
            return recover(args, config, native)
    if not all((args.provider, args.workspace, args.thread, args.binary)):
        parser.error("provider, workspace, thread and binary are required")
    with controller_lock(config, args.provider, args.thread):
        return run(args, config, native)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print("Guild sandbox: " + str(exc), file=sys.stderr)
        raise SystemExit(1)

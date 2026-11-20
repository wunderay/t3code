"""Controller handback tests. Repository fixtures contain only test-authored content."""
import base64
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

spec = importlib.util.spec_from_file_location("guild_sandbox", Path(__file__).with_name("guild_sandbox.py"))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
lazy_spec = importlib.util.spec_from_file_location("guild_lazy", Path(__file__).with_name("guild_lazy.py"))
lazy = importlib.util.module_from_spec(lazy_spec)
lazy_spec.loader.exec_module(lazy)


class SandboxHandbackTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="t3-guild-test-")
        self.root = Path(self.temporary.name)
        launcher = os.environ["T3_TEST_GIT_LAUNCHER"]
        self.git_argv = [sys.executable, "-B", launcher, "--"]
        self.git = bridge.git_runner({"gitLauncher": launcher, "state": str(self.root / "state")})
        self.source = self.root / "source"
        self.source.mkdir()
        self.git(self.source, "init", "-b", "main")
        self.git(self.source, "config", "user.name", "Test Fixture")
        self.git(self.source, "config", "user.email", "fixture@example.invalid")
        (self.source / "file.txt").write_bytes(b"before\n")
        self.git(self.source, "add", "file.txt")
        self.git(self.source, "commit", "-m", "test fixture")
        self.baseline = {
            "files": bridge.snapshot(self.git, self.source),
            "head": self.git(self.source, "rev-parse", "HEAD").stdout.decode().strip(),
            "index": bridge.index_digest(self.git, self.source),
        }
        self.guest = self.root / "guest"
        self.git(None, "clone", "--no-hardlinks", str(self.source), str(self.guest))
        self.git(self.guest, "config", "user.name", "Test Fixture")
        self.git(self.guest, "config", "user.email", "fixture@example.invalid")
        self.transfer = self.root / "transfer"
        self.transfer.mkdir()

    def tearDown(self):
        self.temporary.cleanup()

    def export(self, *, deny_ancestors=False, max_snapshot=None):
        payload = {"git": self.git_argv, "baseline": self.baseline["files"], "head": self.baseline["head"],
                   "maxFile": bridge.MAX_FILE,
                   "maxSnapshot": bridge.MAX_SNAPSHOT if max_snapshot is None else max_snapshot}
        program = bridge.EXPORT
        if deny_ancestors:
            program = '''
import pathlib
original_symlink=pathlib.Path.is_symlink
def scoped_symlink(path):
 if not path.is_relative_to(pathlib.Path.cwd()): raise PermissionError('private ancestor')
 return original_symlink(path)
pathlib.Path.is_symlink=scoped_symlink
''' + program
        result = subprocess.run([sys.executable, "-I", "-B", "-c", program], cwd=self.guest,
                                input=json.dumps(payload), text=True, capture_output=True,
                                env={**os.environ, "TMP": str(self.transfer)}, check=True)
        return json.loads(result.stdout)

    def test_export_does_not_query_private_ancestors_outside_workspace(self):
        exported = self.export(deny_ancestors=True)
        self.assertIn("file.txt", exported["files"])

    def test_source_hardlinks_are_copied_but_never_accepted_for_handback(self):
        outside = self.root / "outside.txt"
        outside.write_bytes(b"shared source bytes\n")
        linked = self.source / "linked.txt"
        os.link(outside, linked)
        files = bridge.snapshot(self.git, self.source)
        self.assertEqual(files["linked.txt"], bridge.digest(outside.read_bytes()))
        copied = self.guest / "copied.txt"
        copied.write_bytes(bridge.read_file(bridge.safe_path(self.source, "linked.txt", source_read=True)))
        copied.write_bytes(b"guest edit\n")
        with self.assertRaisesRegex(RuntimeError, "hardlinks"):
            bridge.safe_path(self.source, "linked.txt")
        self.assertEqual(outside.read_bytes(), b"shared source bytes\n")

    def test_lazy_inspection_never_allocates_an_executor_and_writes_share_thread_identity(self):
        config = {"state": str(self.root / "state"), "gitLauncher": os.environ["T3_TEST_GIT_LAUNCHER"]}
        args = SimpleNamespace(thread="same-thread", workspace=str(self.source), config=self.root / "config.json")
        with mock.patch.object(lazy, "call_executor", side_effect=AssertionError("read started an executor")):
            self.assertEqual(lazy.tool_call(args, config, "read_file", {"path": "file.txt"})["content"], "before\n")
            self.assertIn("file.txt", lazy.tool_call(args, config, "list_files", {})["files"])
        self.assertFalse(lazy.control_dir(config, args.thread).exists())
        with mock.patch.object(lazy, "call_executor", return_value={"writtenBytes": 1}) as executor:
            for provider in ("codex", "claude"):
                args.provider = provider
                lazy.tool_call(args, config, "write_file", {"path": "new.txt", "content": "x"})
            self.assertEqual(executor.call_count, 2)
        for name in ("../outside.txt", "file.txt:ads", "NUL", "CON.txt", "folder/COM1.log", "file.txt.", ".git/config"):
            with self.assertRaises(RuntimeError):
                lazy.workspace_path(self.source, name, source=True)

    def test_provider_frames_cannot_restore_host_tools_or_external_mcp_servers(self):
        server = {"command": "qualified-python", "args": ["guild-only"]}
        profile = self.root / "profile"
        for method in ("thread/start", "thread/resume", "thread/fork", "turn/start"):
            frame = {"method": method, "params": {"cwd": str(self.source), "environments": [{"environmentId": "local"}],
                     "config": {"features": {"multi_agent": True}, "mcp_servers": {"host": {"command": "unsafe"}}},
                     "dynamicTools": [{"name": "host"}]}}
            secured = lazy.codex_frame(frame, profile, server)["params"]
            self.assertEqual(secured["environments"], [])
            self.assertEqual(secured["cwd"], str(profile / "workspace"))
            self.assertEqual(secured["config"]["mcp_servers"], {"guild": server})
            self.assertFalse(secured["config"]["features"]["multi_agent"])
            self.assertNotIn("dynamicTools", secured)
        with self.assertRaises(RuntimeError):
            lazy.codex_frame({"method": "environment/add"}, profile, server)
        updated = lazy.claude_frame({"type": "control_request", "request": {"subtype": "mcp_set_servers", "servers": {"host": {"command": "unsafe"}}}}, server)
        self.assertEqual(list(updated["request"]["servers"]), ["guild"])
        for provider, arguments in (
            ("codex", ["app-server", "--code-mode-host=C:/host.exe"]),
            ("codex", ["app-server", "--config=notify=['host.exe']"]),
            ("codex", ["app-server", "-cfeatures.multi_agent=true"]),
            ("claude", ["--system-prompt-file", "C:/host.txt"]),
            ("claude", ["--append-system-prompt-file=C:/host.txt"]),
            ("claude", ["--resume", "C:/host.json"]),
        ):
            with self.assertRaises(RuntimeError):
                lazy.isolated_arguments(provider, arguments, server, profile)

    def test_failed_handback_is_recovered_before_any_host_sync(self):
        config = {"state": str(self.root / "state")}
        args = SimpleNamespace(thread="conflicted-thread", workspace=str(self.source))
        executor = lazy.Executor(args, config)
        executor.process = object()
        executor.record = {"pending": True}
        executor.export = mock.Mock(side_effect=RuntimeError("host file changed"))
        executor.request = mock.Mock(return_value={"content": "retained agent edit"})
        with self.assertRaisesRegex(RuntimeError, "host file changed"):
            executor.call("write_file", {"path": "file.txt", "content": "next edit"})
        executor.request.assert_not_called()
        self.assertEqual(executor.call("read_file", {"path": "file.txt"}), {"content": "retained agent edit"})
        executor.request.assert_called_once_with("read_file", {"path": "file.txt"})

    def test_snapshot_limit_counts_transferred_changes_instead_of_unchanged_source(self):
        self.assertEqual(self.export(max_snapshot=1)["files"]["file.txt"],
                         {"sha": self.baseline["files"]["file.txt"]})
        (self.guest / "file.txt").write_bytes(b"larger than one byte\n")
        with self.assertRaises(subprocess.CalledProcessError):
            self.export(max_snapshot=1)
        exported = self.export()
        previous_limit = bridge.MAX_SNAPSHOT
        bridge.MAX_SNAPSHOT = 1
        try:
            with self.assertRaisesRegex(RuntimeError, "transfer limit"):
                bridge.handback(self.git, self.source, self.baseline, exported, self.transfer)
        finally:
            bridge.MAX_SNAPSHOT = previous_limit
        self.assertEqual((self.source / "file.txt").read_bytes(), b"before\n")
        self.assertEqual(bridge.index_digest(self.git, self.source), self.baseline["index"])

    def test_file_conflict_preserves_host_and_staging(self):
        (self.guest / "file.txt").write_bytes(b"agent\n")
        exported = self.export()
        (self.source / "file.txt").write_bytes(b"human\n")
        with self.assertRaisesRegex(RuntimeError, "host file changed"):
            bridge.handback(self.git, self.source, self.baseline, exported, self.transfer)
        self.assertEqual((self.source / "file.txt").read_text(), "human\n")
        self.assertEqual(bridge.index_digest(self.git, self.source), self.baseline["index"])

    def test_saved_reporting_controls_are_independent_and_fail_closed(self):
        path = self.root / "settings.json"
        path.write_text(json.dumps({"privacy": {"codexReporting": True, "claudeReporting": False}}))
        config = {"disableOptionalEgress": True}
        self.assertFalse(bridge.with_reporting_privacy(config, "codex", str(path))["disableOptionalEgress"])
        self.assertTrue(bridge.with_reporting_privacy(config, "claude", str(path))["disableOptionalEgress"])
        path.write_text(json.dumps({"privacy": {"codexReporting": "true"}}))
        self.assertTrue(bridge.with_reporting_privacy(config, "codex", str(path))["disableOptionalEgress"])
        path.write_text("malformed")
        self.assertTrue(bridge.with_reporting_privacy(config, "codex", str(path))["disableOptionalEgress"])

    def test_commits_staging_additions_and_deletions_survive_handback(self):
        (self.guest / "file.txt").unlink()
        (self.guest / "new.txt").write_bytes(b"committed\n")
        self.git(self.guest, "add", "-A")
        self.git(self.guest, "commit", "-m", "guest commit")
        (self.guest / "new.txt").write_bytes(b"staged\n")
        self.git(self.guest, "add", "new.txt")
        (self.guest / "new.txt").write_bytes(b"working\n")
        updated = bridge.handback(self.git, self.source, self.baseline, self.export(), self.transfer)
        self.assertFalse((self.source / "file.txt").exists())
        self.assertEqual((self.source / "new.txt").read_text(), "working\n")
        self.assertEqual(self.git(self.source, "show", ":new.txt").stdout, b"staged\n")
        self.assertEqual(self.git(self.source, "show", "HEAD:new.txt").stdout, b"committed\n")
        self.assertEqual(updated["index"], bridge.index_digest(self.git, self.source))

    def test_host_staging_conflict_refuses_before_writing_files(self):
        (self.guest / "file.txt").write_bytes(b"agent\n")
        (self.source / "extra.txt").write_bytes(b"human\n")
        self.git(self.source, "add", "extra.txt")
        with self.assertRaisesRegex(RuntimeError, "staging area changed"):
            bridge.handback(self.git, self.source, self.baseline, self.export(), self.transfer)
        self.assertEqual((self.source / "file.txt").read_text(), "before\n")

    def test_transfer_paths_and_contents_are_checked(self):
        for name in ("../escape", "C:/escape", ".git/config", ".t3-guild-session/auth.json"):
            with self.assertRaises(RuntimeError):
                bridge.safe_path(self.source, name)
        (self.guest / "file.txt").write_bytes(b"agent\n")
        exported = self.export()
        exported["files"]["file.txt"]["data"] = base64.b64encode(b"tampered").decode()
        with self.assertRaisesRegex(RuntimeError, "integrity check"):
            bridge.handback(self.git, self.source, self.baseline, exported, self.transfer)
        self.assertEqual((self.source / "file.txt").read_text(), "before\n")

    def test_protocol_paths_and_terminal_detection(self):
        value = {"params": {"cwd": str(self.source), "text": "task"}}
        mapped = bridge.remap(value, str(self.source), str(self.guest))
        self.assertEqual(mapped["params"]["cwd"], str(self.guest))
        self.assertEqual(mapped["params"]["text"], "task")
        sibling = str(self.source) + "-other/file.txt"
        self.assertEqual(bridge.remap(sibling, str(self.source), str(self.guest)), sibling)
        self.assertTrue(bridge.is_terminal("codex", {"method": "turn/completed"}))
        self.assertTrue(bridge.is_terminal("claude", {"type": "result"}))
        self.assertFalse(bridge.is_terminal("codex", {"method": "item/completed"}))

    def test_codex_uses_outer_sandbox_and_preserves_read_only_and_approval(self):
        for policy in ("workspaceWrite", "dangerFullAccess"):
            request = {"method": "turn/start", "params": {"sandboxPolicy": {"type": policy}, "approvalPolicy": "on-request"}}
            mapped = bridge.codex_external_policy(request)
            self.assertEqual(mapped["params"]["sandboxPolicy"], {"type": "externalSandbox", "networkAccess": "enabled"})
            self.assertEqual(mapped["params"]["approvalPolicy"], "on-request")
        request = {"method": "turn/start", "params": {"sandboxPolicy": {"type": "readOnly"}}}
        self.assertEqual(bridge.codex_external_policy(request)["params"]["sandboxPolicy"], {"type": "readOnly"})

    def test_callbacks_do_not_expose_host_data_or_indirect_host_execution(self):
        broker = bridge.CallbackBroker(None, self.root, "python.exe", "callback.py")
        config = {"config": {"mcp_servers.t3-code": {
            "url": "http://127.0.0.1:12345/mcp", "http_headers": {"Authorization": "Bearer fixture"}
        }}}
        mapped = broker.transform(config)["config"]["mcp_servers.t3-code"]
        self.assertEqual(mapped["command"], "python.exe")
        self.assertNotIn("fixture", json.dumps(mapped))
        self.assertEqual(broker.mcp("t3-code", {"id": 1, "method": "tools/list"})["result"]["tools"], [])
        for name in ("terminal_exec", "delegate_task", "schedule_task", "create_threads", "t3_thread_send", "t3_thread_read", "request_secret"):
            rejected = broker.mcp("t3-code", {"id": 7, "method": "tools/call", "params": {"name": name}})
            self.assertEqual(rejected["error"]["code"], -32601)
        for endpoint in ("http://10.0.0.1:12345/mcp", "https://example.com/mcp", "http://localhost:12345/other", "http://localhost:12345/mcp?secret=x"):
            config["config"]["mcp_servers.t3-code"]["url"] = endpoint
            with self.assertRaisesRegex(RuntimeError, "exact local MCP endpoint"):
                broker.transform(config)

    def test_managed_auth_uses_only_the_t3_supplied_callback(self):
        broker = bridge.CallbackBroker(None, self.root, "python.exe", "callback.py")
        args = ["app-server", "-c", 'model_providers.openai_token_sharing={auth={command="t3.exe",args=["__managed-chatgpt-token","fixture"]}}']
        mapped = broker.managed_auth(args)
        self.assertEqual(broker.auth, ["t3.exe", "__managed-chatgpt-token", "fixture"])
        self.assertIn('command="python.exe"', mapped[-1])
        self.assertNotIn('t3.exe', mapped[-1])


if __name__ == "__main__":
    unittest.main()

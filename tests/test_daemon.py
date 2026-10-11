"""Tests for the parts of the daemon that do not need a running game."""
import json
import os
import subprocess
import sys
import threading
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import daemon  # noqa: E402

# The text `wevtutil qe Application ... /f:text` produced for the real crash of 2026-10-10 (labels mangled by the code page).
CRASH_EVENT = """Event[0]
  Log Name: Application
  Source: Application Error
  Date: 2026-10-10T02:27:18.2550000Z
  Event ID: 1000
  Description:
\u00b4\u00ed\u00ce\u00f3Ó¦ÓÃ³ÌÐòÃû³Æ£º Jump Space.exe£¬°æ±¾£º 6000.3.9.39253£¬Ê±¼ä´Á£º 0x698bc852
\u00b9ÊÕÏÄ£¿éÃû³Æ£º frida-agent.dll£¬ °æ±¾£º 0.0.0.0£¬Ê±¼ä´Á£º 0x6ac7a58b
Òì³£´úÂë£º 0xc0000005
¹ÊÕÏÆ«ÒÆ£º 0x000000000009c9dc
½ø³Ì ID£º 0xB5C4
Faulting Â·¾¶£º D:\\SteamLibrary\\steamapps\\common\\JumpSpace\\Jump Space.exe
"""


class CrashFacts(unittest.TestCase):
    def test_pulls_module_exception_and_offset_out_of_a_localized_event(self):
        facts = daemon.crash_facts(CRASH_EVENT)
        self.assertIn("Jump Space.exe", facts)
        self.assertIn("frida-agent.dll", facts)
        self.assertIn("0xc0000005", facts)
        self.assertIn("0x000000000009c9dc", facts)
        self.assertNotIn("\u00b4", facts)  # only plain ASCII survives

    def test_no_event_means_no_facts(self):
        self.assertEqual(daemon.crash_facts(""), "")
        self.assertEqual(daemon.crash_facts("Event[0]\n  Log Name: Application\n"), "")


class ExitReport(unittest.TestCase):
    def test_reports_recent_calls_and_the_windows_event(self):
        lines = []
        done = threading.Event()

        def fake_log(*parts):
            lines.append(" ".join(str(p) for p in parts))
            if len(lines) >= 2:
                done.set()

        completed = mock.Mock(stdout=CRASH_EVENT.encode("cp936", errors="replace"))
        with mock.patch.object(daemon, "log", fake_log), mock.patch.object(daemon.subprocess, "run", return_value=completed):
            daemon.report_game_exit(1234, [("02:27:10", "status"), ("02:27:11", "cheats")], wait=0)
            self.assertTrue(done.wait(5))
        text = "\n".join(lines)
        self.assertIn("status@02:27:10, cheats@02:27:11", text)
        self.assertIn("frida-agent.dll", text)

    def test_a_failing_lookup_is_reported_not_raised(self):
        lines = []
        done = threading.Event()

        def fake_log(*parts):
            lines.append(" ".join(str(p) for p in parts))
            if len(lines) >= 2:
                done.set()

        with mock.patch.object(daemon, "log", fake_log), mock.patch.object(daemon.subprocess, "run", side_effect=OSError("no wevtutil")):
            daemon.report_game_exit(1, [], wait=0)
            self.assertTrue(done.wait(5))
        self.assertIn("lookup failed", "\n".join(lines))


class LauncherWithoutConsole(unittest.TestCase):
    def test_every_module_the_launcher_imports_survives_pythonw(self):
        # pythonw.exe (what the one-click .bat uses) has no console: sys.stdout / sys.stderr are None.
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        code = "import sys; sys.stdout = None; sys.stderr = None; import jsc, daemon, webui, trainer; sys.exit(0)"
        done = subprocess.run([sys.executable, "-c", code], cwd=root, capture_output=True, timeout=60)
        self.assertEqual(done.returncode, 0, done.stderr.decode("utf-8", errors="replace"))


class ServiceLifetime(unittest.TestCase):
    """The service keeps the game's single Frida session: letting go of a live game poisons its exit."""

    def test_only_one_daemon_may_exist(self):
        name = "Local\\JumpSpaceTrainerDaemonTest%d" % os.getpid()
        self.assertTrue(daemon.acquire_single_instance(name))
        self.assertFalse(daemon.acquire_single_instance(name))  # the second one is told it is not alone

    def test_it_ends_itself_only_when_there_is_no_game_and_no_window(self):
        now = 10_000.0
        quiet = now - daemon.IDLE_EXIT_AFTER - 1
        busy = now - 5
        self.assertTrue(daemon.should_idle_exit(now, quiet, present=False))
        self.assertFalse(daemon.should_idle_exit(now, quiet, present=True))  # a game is running: keep the session
        self.assertFalse(daemon.should_idle_exit(now, busy, present=False))  # somebody is looking at the window
        self.assertFalse(daemon.should_idle_exit(now, quiet + 10, present=False))

    def test_a_full_stop_is_refused_while_a_game_is_attached(self):
        bridge = daemon.Bridge()
        bridge.session = mock.Mock()
        with mock.patch.object(daemon, "stop_service") as stop:
            with self.assertRaises(daemon.GameRunning):
                daemon.request_shutdown(bridge)
        stop.assert_not_called()

    def test_a_full_stop_is_refused_while_the_game_is_starting_or_merely_present(self):
        bridge = daemon.Bridge()
        bridge.starting = True
        with self.assertRaises(daemon.GameRunning):
            daemon.request_shutdown(bridge)
        bridge.starting = False
        with mock.patch.object(daemon, "find_pid", return_value=777), self.assertRaises(daemon.GameRunning):
            daemon.request_shutdown(bridge)

    def test_a_full_stop_is_allowed_when_there_is_no_game(self):
        bridge = daemon.Bridge()
        stopped = threading.Event()
        with mock.patch.object(daemon, "find_pid", return_value=None), \
                mock.patch.object(daemon, "stop_service", side_effect=lambda b: stopped.set()):
            self.assertEqual(daemon.request_shutdown(bridge), "stopping")
            self.assertTrue(stopped.wait(2))

    def test_the_pipe_reports_a_refused_stop_with_its_own_code_and_counts_as_activity(self):
        bridge = daemon.Bridge()
        bridge.session = mock.Mock()
        bridge.last_client = 0
        sent = []

        class FakeConn:
            def __init__(self):
                self.requests = [json.dumps({"method": "_shutdown", "args": []}).encode()]

            def recv_bytes(self):
                if not self.requests:
                    raise EOFError
                return self.requests.pop(0)

            def send_bytes(self, data):
                sent.append(json.loads(data.decode()))

            def close(self):
                pass

        daemon.handle(bridge, FakeConn())
        self.assertEqual(sent[0]["code"], "GAME_RUNNING")
        self.assertFalse(sent[0]["ok"])
        self.assertGreater(bridge.last_client, time.time() - 5)


class ReloadRace(unittest.TestCase):
    """During a reload the old script is gone for a few seconds; the supervisor used to load a second one on top."""

    def test_supervisor_style_load_leaves_an_existing_agent_alone(self):
        bridge = daemon.Bridge()
        bridge.session = mock.Mock()
        bridge.script = mock.Mock()
        with mock.patch.object(daemon.frida, "Compiler") as compiler:
            bridge.load_script(only_if_missing=True)
        compiler.assert_not_called()
        bridge.session.create_script.assert_not_called()

    def test_explicit_reload_still_replaces_it(self):
        bridge = daemon.Bridge()
        bridge.session = mock.Mock()
        old = mock.Mock()
        old.list_exports_sync.return_value = []
        bridge.script = old
        with mock.patch.object(daemon.frida, "Compiler") as compiler, \
                mock.patch.object(daemon.time, "sleep"), mock.patch.object(daemon, "log"):
            compiler.return_value.build.return_value = "bundle"
            bridge.load_script()
        old.unload.assert_called_once()
        bridge.session.create_script.assert_called_once()


class ShutdownIsFinal(unittest.TestCase):
    """Closing the trainer used to detach and — a second later, before the process died — attach again."""

    def test_supervisor_does_not_reattach_after_shutdown(self):
        bridge = daemon.Bridge()
        bridge.shutdown()
        with mock.patch.object(daemon, "find_pid", return_value=123), mock.patch.object(bridge, "attach") as attach:
            daemon.supervisor(bridge)  # returns at once instead of looping
        attach.assert_not_called()

    def test_attach_and_load_refuse_while_stopping(self):
        bridge = daemon.Bridge()
        bridge.stopping = True
        with mock.patch.object(daemon, "find_pid", return_value=123), mock.patch.object(daemon.frida, "attach") as frida_attach:
            with self.assertRaises(daemon.BridgeError):
                bridge.attach()
            frida_attach.assert_not_called()
        with self.assertRaises(daemon.BridgeError):
            bridge.load_script()

    def test_attach_that_races_with_shutdown_lets_go_again(self):
        bridge = daemon.Bridge()
        session = mock.Mock()

        def attach_then_stop(pid):
            bridge.stopping = True
            return session

        with mock.patch.object(daemon, "find_pid", return_value=123), mock.patch.object(daemon.frida, "attach", side_effect=attach_then_stop):
            with self.assertRaises(daemon.BridgeError):
                bridge.attach()
        session.detach.assert_called_once()
        self.assertIsNone(bridge.session)

    def test_watcher_exits_when_stopping(self):
        bridge = daemon.Bridge()
        bridge.stopping = True
        daemon.watcher(bridge)  # must return rather than loop forever


class HookComesOutBeforeUnload(unittest.TestCase):
    """Frida removing a hook the main thread is still running crashed the game; the agent takes it out first."""

    def test_script_is_quiesced_after_dispose_and_before_unload(self):
        events = []
        script = mock.Mock()
        script.list_exports_sync.return_value = ["dispose", "quiesce", "pumpStatus"]
        script.exports_sync.dispose.side_effect = lambda: events.append("dispose")
        script.exports_sync.quiesce.side_effect = lambda: events.append("quiesce")
        script.unload.side_effect = lambda: events.append("unload")
        bridge = daemon.Bridge()
        bridge.script = script
        with mock.patch.object(daemon, "log"):
            bridge._dispose_script()
        self.assertEqual(events, ["dispose", "quiesce", "unload"])
        self.assertIsNone(bridge.script)

    def test_a_stuck_agent_does_not_block_the_unload_forever(self):
        release = threading.Event()
        script = mock.Mock()
        script.list_exports_sync.return_value = ["quiesce"]
        script.exports_sync.quiesce.side_effect = lambda: release.wait(5)
        bridge = daemon.Bridge()
        bridge.script = script
        with mock.patch.object(daemon, "QUIESCE_TIMEOUT", 0.2), mock.patch.object(daemon, "log") as log:
            started = time.time()
            bridge._dispose_script()
            elapsed = time.time() - started
        release.set()
        self.assertLess(elapsed, 2)
        script.unload.assert_called_once()
        self.assertTrue(any("dispose error" in str(c) for c in log.call_args_list))


class QuitHandling(unittest.TestCase):
    def bridge_with_pump(self, state):
        bridge = daemon.Bridge()
        bridge.pid = 4242
        bridge.script = mock.Mock()
        calls = []

        def call(method, args, timeout=0):
            calls.append(method)
            if method == "pumpStatus":
                return json.dumps({"state": state["value"]})
            return "ok"

        bridge.call = call
        return bridge, calls

    def test_a_quit_is_noticed_once_and_shown_to_the_ui(self):
        state = {"value": "running"}
        bridge, calls = self.bridge_with_pump(state)
        with mock.patch.object(daemon, "log") as log:
            bridge.check_pump()
            self.assertEqual(bridge.pump_state, "running")
            state["value"] = "quitting"
            bridge.check_pump()
            bridge.check_pump()
        self.assertEqual(bridge.pump_state, "quitting")
        self.assertEqual(bridge.info()["pumpState"], "quitting")
        self.assertEqual(sum("quitting" in str(c) for c in log.call_args_list), 1)  # logged one time only
        self.assertNotIn("resumePump", calls)

    def test_a_cancelled_quit_puts_the_hook_back_while_the_game_is_still_running(self):
        state = {"value": "quitting"}
        bridge, calls = self.bridge_with_pump(state)
        with mock.patch.object(daemon, "log"), mock.patch.object(daemon, "find_pid", return_value=4242):
            bridge.check_pump()
            bridge.quit_seen_at -= daemon.QUIT_RESUME_AFTER + 1  # the quit never finished
            bridge.check_pump()
        self.assertIn("resumePump", calls)
        self.assertIsNone(bridge.quit_seen_at)

    def test_no_resume_when_the_game_is_really_gone(self):
        state = {"value": "quitting"}
        bridge, calls = self.bridge_with_pump(state)
        with mock.patch.object(daemon, "log"), mock.patch.object(daemon, "find_pid", return_value=None):
            bridge.check_pump()
            bridge.quit_seen_at -= daemon.QUIT_RESUME_AFTER + 1
            bridge.check_pump()
        self.assertNotIn("resumePump", calls)

    def test_an_unreachable_agent_is_ignored(self):
        bridge = daemon.Bridge()
        bridge.call = mock.Mock(side_effect=daemon.BridgeError("gone"))
        bridge.check_pump()  # must not raise
        self.assertIsNone(bridge.pump_state)


class HotReloadIsOptIn(unittest.TestCase):
    def serve_started(self, **kwargs):
        started = []

        class FakeThread:
            def __init__(self, target=None, args=(), daemon=None):
                self.target = target

            def start(self):
                started.append(self.target.__name__)

        bridge = mock.Mock()
        with mock.patch.object(daemon.threading, "Thread", FakeThread), mock.patch.object(daemon, "log"):
            daemon.serve(bridge, b"key", background=True, **kwargs)
        return started

    def test_launcher_style_serve_never_watches_files(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("JUMPSPACE_WATCH", None)
            self.assertNotIn("watcher", self.serve_started())

    def test_environment_variable_turns_it_on(self):
        with mock.patch.dict(os.environ, {"JUMPSPACE_WATCH": "1"}):
            self.assertIn("watcher", self.serve_started())

    def test_explicit_argument_wins(self):
        with mock.patch.dict(os.environ, {"JUMPSPACE_WATCH": "1"}):
            self.assertNotIn("watcher", self.serve_started(watch=False))
        self.assertIn("watcher", self.serve_started(watch=True))


class ReloadSettles(unittest.TestCase):
    def test_a_replaced_script_is_followed_by_a_pause_before_the_new_one_attaches(self):
        bridge = daemon.Bridge()
        events = []
        bridge.session = mock.Mock()
        bridge.session.create_script.side_effect = lambda bundle: (events.append("create") or mock.Mock())
        bridge.script = mock.Mock()
        bridge._dispose_script = lambda: (events.append("unload"), setattr(bridge, "script", None))[0]
        with mock.patch.object(daemon.frida, "Compiler") as compiler, \
                mock.patch.object(daemon.time, "sleep", side_effect=lambda s: events.append(f"sleep {s}")), \
                mock.patch.object(daemon, "log"):
            compiler.return_value.build.return_value = "bundle"
            bridge.load_script()
        self.assertEqual(events[:3], ["unload", f"sleep {daemon.RELOAD_SETTLE}", "create"])

    def test_first_load_does_not_wait(self):
        bridge = daemon.Bridge()
        events = []
        bridge.session = mock.Mock()
        bridge.session.create_script.side_effect = lambda bundle: (events.append("create") or mock.Mock())
        with mock.patch.object(daemon.frida, "Compiler") as compiler, \
                mock.patch.object(daemon.time, "sleep", side_effect=lambda s: events.append(f"sleep {s}")), \
                mock.patch.object(daemon, "log"):
            compiler.return_value.build.return_value = "bundle"
            bridge.load_script()
        self.assertEqual(events, ["create"])


if __name__ == "__main__":
    unittest.main()

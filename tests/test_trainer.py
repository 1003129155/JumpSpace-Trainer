"""The launcher starts or reuses the background service and never detaches the game's Frida session."""
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import trainer  # noqa: E402

DETACHED_PROCESS = 0x00000008
CREATE_NEW_CONSOLE = 0x00000010
CREATE_NO_WINDOW = 0x08000000


class SpawnService(unittest.TestCase):
    def spawn(self, **kwargs):
        with mock.patch.object(trainer.subprocess, "Popen") as popen:
            trainer.spawn_service(**kwargs)
        return popen.call_args

    def test_the_service_is_its_own_process_without_a_window(self):
        call = self.spawn()
        args, kwargs = call
        self.assertIn("daemon.py", args[0][1])
        self.assertEqual(args[0][2], "--service")
        self.assertTrue(kwargs["creationflags"] & DETACHED_PROCESS)  # not tied to the launcher's lifetime
        self.assertTrue(kwargs["creationflags"] & CREATE_NO_WINDOW)
        self.assertEqual(kwargs["cwd"], trainer.ROOT)

    def test_debug_mode_gives_the_service_a_console_for_its_log(self):
        _, kwargs = self.spawn(debug=True)
        self.assertTrue(kwargs["creationflags"] & CREATE_NEW_CONSOLE)
        self.assertFalse(kwargs["creationflags"] & DETACHED_PROCESS)

    def test_python_exe_is_swapped_for_pythonw_so_no_console_flashes(self):
        with mock.patch.object(trainer.sys, "executable", r"C:\x\venv\Scripts\python.exe"):
            args, _ = self.spawn()
        self.assertTrue(args[0][0].endswith("pythonw.exe"))


class EnsureService(unittest.TestCase):
    def test_a_running_service_is_reused_not_duplicated(self):
        with mock.patch.object(trainer, "daemon_running", return_value=True), \
                mock.patch.object(trainer, "spawn_service") as spawn, mock.patch.object(trainer, "log"):
            self.assertTrue(trainer.ensure_service())
        spawn.assert_not_called()

    def test_a_missing_service_is_started_and_waited_for(self):
        answers = iter([False, False, False, True])
        with mock.patch.object(trainer, "daemon_running", side_effect=lambda: next(answers)), \
                mock.patch.object(trainer, "spawn_service") as spawn, \
                mock.patch.object(trainer.time, "sleep"), mock.patch.object(trainer, "log"):
            self.assertTrue(trainer.ensure_service())
        spawn.assert_called_once()

    def test_a_service_that_never_answers_is_reported(self):
        with mock.patch.object(trainer, "daemon_running", return_value=False), \
                mock.patch.object(trainer, "spawn_service"), \
                mock.patch.object(trainer.time, "sleep"), mock.patch.object(trainer, "log"):
            self.assertFalse(trainer.ensure_service(wait=0.0))


class ClosingTheWindow(unittest.TestCase):
    def test_closing_only_switches_cheats_off_and_never_stops_the_service(self):
        calls = []
        server = mock.Mock()
        fake_jsc = mock.Mock()
        fake_jsc.call.side_effect = lambda method, args, timeout=0: calls.append(method) or {"ok": True}
        with mock.patch.dict(sys.modules, {"jsc": fake_jsc}), \
                mock.patch.object(trainer.os, "_exit") as exit_, mock.patch.object(trainer, "log"):
            trainer.shutdown(server)
        self.assertEqual(calls, ["dispose"])  # never "_shutdown": detaching from a live game poisons its exit
        server.shutdown.assert_called_once()
        exit_.assert_called_once_with(0)

    def test_a_window_that_is_still_open_is_taken_down_with_the_launcher(self):
        window = mock.Mock()
        window.poll.return_value = None  # still running
        fake_jsc = mock.Mock()
        fake_jsc.call.return_value = {"ok": True}
        with mock.patch.dict(sys.modules, {"jsc": fake_jsc}), \
                mock.patch.object(trainer.os, "_exit"), mock.patch.object(trainer, "log"):
            trainer.shutdown(mock.Mock(), window)
        window.terminate.assert_called_once()

    def test_an_already_closed_window_is_left_alone(self):
        window = mock.Mock()
        window.poll.return_value = 0
        fake_jsc = mock.Mock()
        fake_jsc.call.return_value = {"ok": True}
        with mock.patch.dict(sys.modules, {"jsc": fake_jsc}), \
                mock.patch.object(trainer.os, "_exit"), mock.patch.object(trainer, "log"):
            trainer.shutdown(mock.Mock(), window)
        window.terminate.assert_not_called()


if __name__ == "__main__":
    unittest.main()

"""The same code runs from the source folder and from the packaged program (PyInstaller onedir)."""
import importlib
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import app  # noqa: E402
import daemon  # noqa: E402
import paths  # noqa: E402
import trainer  # noqa: E402


class Locations(unittest.TestCase):
    def reload_paths(self, **env):
        with mock.patch.dict(os.environ, env, clear=False):
            return importlib.reload(paths)

    def tearDown(self):
        os.environ.pop("JUMPSPACE_HOME", None)
        importlib.reload(paths)

    def test_from_source_everything_lives_in_the_project_folder(self):
        p = self.reload_paths()
        self.assertFalse(p.FROZEN)
        self.assertEqual(p.APP_DIR, p.SOURCE_DIR)
        self.assertEqual(p.RESOURCE_DIR, p.SOURCE_DIR)

    def test_packaged_writes_next_to_the_exe_and_reads_resources_from_the_bundle(self):
        with tempfile.TemporaryDirectory() as app_dir, tempfile.TemporaryDirectory() as bundle:
            exe = os.path.join(app_dir, "跳帮修改器.exe")
            with mock.patch.object(sys, "frozen", True, create=True), \
                    mock.patch.object(sys, "_MEIPASS", bundle, create=True), \
                    mock.patch.object(sys, "executable", exe):
                p = importlib.reload(paths)
                self.assertTrue(p.FROZEN)
                self.assertEqual(p.APP_DIR, app_dir)
                self.assertEqual(p.RESOURCE_DIR, bundle)
                self.assertEqual(p.app_path("daemon.log"), os.path.join(app_dir, "daemon.log"))
                self.assertEqual(p.resource_path("ui"), os.path.join(bundle, "ui"))

    def test_a_read_only_install_folder_falls_back_to_the_user_profile(self):
        with tempfile.TemporaryDirectory() as local, tempfile.TemporaryDirectory() as locked:
            exe = os.path.join(locked, "app.exe")
            real = paths.writable
            with mock.patch.object(sys, "frozen", True, create=True), mock.patch.object(sys, "executable", exe), \
                    mock.patch.dict(os.environ, {"LOCALAPPDATA": local}), \
                    mock.patch("os.makedirs", wraps=os.makedirs):
                importlib.reload(paths)
                with mock.patch.object(paths, "writable", side_effect=lambda d: False if d == locked else real(d)):
                    self.assertEqual(paths._app_dir(), os.path.join(local, "JumpSpaceTrainer"))

    def test_the_command_line_can_be_pointed_at_another_copy(self):
        with tempfile.TemporaryDirectory() as other:
            p = self.reload_paths(JUMPSPACE_HOME=other)
            self.assertEqual(p.app_path("daemon.key"), os.path.join(other, "daemon.key"))


class AgentBundle(unittest.TestCase):
    def test_from_source_the_agent_is_compiled_so_edits_take_effect(self):
        with mock.patch.object(daemon.paths, "FROZEN", False), mock.patch.dict(os.environ, {}, clear=False), \
                mock.patch.object(daemon.frida, "Compiler") as compiler:
            os.environ.pop("JUMPSPACE_PREBUILT", None)
            compiler.return_value.build.return_value = "compiled"
            self.assertEqual(daemon.agent_bundle(), "compiled")

    def test_packaged_it_uses_the_prebuilt_bundle_without_any_compiler(self):
        with tempfile.TemporaryDirectory() as resources:
            with open(os.path.join(resources, "agent.bundle.js"), "w", encoding="utf-8") as f:
                f.write("// prebuilt")
            with mock.patch.object(daemon.paths, "FROZEN", True), mock.patch.object(daemon.paths, "RESOURCE_DIR", resources), \
                    mock.patch.object(daemon.frida, "Compiler") as compiler:
                self.assertEqual(daemon.agent_bundle(), "// prebuilt")
                compiler.assert_not_called()

    def test_an_incomplete_package_is_reported_in_plain_words(self):
        with tempfile.TemporaryDirectory() as resources:
            with mock.patch.object(daemon.paths, "FROZEN", True), mock.patch.object(daemon.paths, "RESOURCE_DIR", resources):
                with self.assertRaises(daemon.BridgeError) as caught:
                    daemon.agent_bundle()
                self.assertIn("agent.bundle.js", str(caught.exception))


class PackagedService(unittest.TestCase):
    def test_the_packaged_program_starts_itself_as_the_service(self):
        with mock.patch.object(trainer.paths, "FROZEN", True), mock.patch.object(trainer.sys, "executable", r"C:\app\跳帮修改器.exe"), \
                mock.patch.object(trainer.subprocess, "Popen") as popen:
            trainer.spawn_service()
        args, kwargs = popen.call_args
        self.assertEqual(args[0], [r"C:\app\跳帮修改器.exe", "--service"])  # no daemon.py, no python
        self.assertEqual(kwargs["cwd"], trainer.paths.APP_DIR)


class Dispatch(unittest.TestCase):
    def run_app(self, *argv):
        calls = []
        fake_daemon = mock.Mock(main=lambda: calls.append("service"))
        fake_jsc = mock.Mock(main=lambda: calls.append("cli") or 0)
        fake_trainer = mock.Mock(run=lambda: calls.append("window"))
        with mock.patch.object(sys, "argv", ["app", *argv]), \
                mock.patch.dict(sys.modules, {"daemon": fake_daemon, "jsc": fake_jsc, "trainer": fake_trainer}):
            try:
                app.main()
            except SystemExit:
                pass
        return calls

    def test_no_arguments_opens_the_window(self):
        self.assertEqual(self.run_app(), ["window"])

    def test_service_flag_runs_the_background_service(self):
        self.assertEqual(self.run_app("--service"), ["service"])

    def test_a_command_word_runs_the_command_line_tool(self):
        self.assertEqual(self.run_app("status"), ["cli"])
        self.assertEqual(self.run_app("setCheat", "god", "true"), ["cli"])

    def test_unknown_flags_still_open_the_window(self):
        self.assertEqual(self.run_app("--debug"), ["window"])


if __name__ == "__main__":
    unittest.main()

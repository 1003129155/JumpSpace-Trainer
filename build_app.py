"""Build the packaged program: dist\\跳帮修改器\\跳帮修改器.exe (+ a zip of the folder).

  venv\\Scripts\\python.exe build_app.py [--no-zip]

What happens:
  1. the agent (agent.js + agent/*.js + frida-il2cpp-bridge) is compiled once into build\\agent.bundle.js, so the packaged
     program needs neither Node nor node_modules;
  2. PyInstaller turns app.py (+ the web UI and the bundle) into a self-contained folder. PyInstaller is taken from the
     system Python that created the venv; frida and the project's modules come from the venv.
"""
import glob
import os
import shutil
import subprocess
import sys
import zipfile

import frida

ROOT = os.path.dirname(os.path.abspath(__file__))
NAME = "跳帮修改器"
BUILD = os.path.join(ROOT, "build")
DIST = os.path.join(ROOT, "dist")


def system_python():
    """The interpreter the venv was created from (it has PyInstaller; the venv itself does not)."""
    home = None
    with open(os.path.join(ROOT, "venv", "pyvenv.cfg"), encoding="utf-8") as f:
        for line in f:
            if line.lower().startswith("home"):
                home = line.split("=", 1)[1].strip()
    exe = os.path.join(home, "python.exe") if home else sys.executable
    if not os.path.isfile(exe):
        raise SystemExit("找不到创建 venv 的 Python：" + str(exe))
    return exe


def build_agent():
    os.makedirs(BUILD, exist_ok=True)
    bundle = frida.Compiler().build(os.path.join(ROOT, "agent.js"), project_root=ROOT)
    target = os.path.join(BUILD, "agent.bundle.js")
    with open(target, "w", encoding="utf-8") as f:
        f.write(bundle)
    print(f"agent bundle: {len(bundle):,} bytes -> {target}")
    return target


def run_pyinstaller(bundle):
    python = system_python()
    site = os.path.join(ROOT, "venv", "Lib", "site-packages")
    env = dict(os.environ, PYTHONPATH=site + os.pathsep + ROOT, PYTHONUTF8="1")
    cmd = [
        python, "-m", "PyInstaller", "--noconfirm", "--clean", "--onedir", "--noconsole",
        "--name", NAME, "--distpath", DIST, "--workpath", os.path.join(BUILD, "pyinstaller"), "--specpath", BUILD,
        "--collect-all", "frida", "--paths", ROOT,
        "--add-data", f"{os.path.join(ROOT, 'ui')}{os.pathsep}ui",
        "--add-data", f"{bundle}{os.pathsep}.",
        "--exclude-module", "tkinter", "--exclude-module", "tool",
        os.path.join(ROOT, "app.py"),
    ]
    print("PyInstaller:", python)
    subprocess.run(cmd, cwd=ROOT, env=env, check=True)


def finish():
    folder = os.path.join(DIST, NAME)
    shutil.copyfile(os.path.join(ROOT, "README.md"), os.path.join(folder, "使用说明.md"))
    exe = os.path.join(folder, NAME + ".exe")
    size = sum(os.path.getsize(p) for p in glob.glob(os.path.join(folder, "**", "*"), recursive=True) if os.path.isfile(p))
    print(f"folder: {folder}  ({size / 1e6:.0f} MB)  exe: {os.path.isfile(exe)}")
    if "--no-zip" in sys.argv:
        return
    target = os.path.join(DIST, NAME + ".zip")
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for path in glob.glob(os.path.join(folder, "**", "*"), recursive=True):
            if os.path.isfile(path):
                z.write(path, os.path.join(NAME, os.path.relpath(path, folder)))
    print(f"zip: {target}  ({os.path.getsize(target) / 1e6:.0f} MB)")


if __name__ == "__main__":
    finish_only = "--finish-only" in sys.argv
    if not finish_only:
        run_pyinstaller(build_agent())
    finish()

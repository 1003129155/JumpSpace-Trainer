"""Where things live — one place, so the same code runs from the source folder and from the packaged program.

RESOURCE_DIR  read-only things that ship with the program: the web UI (ui/) and, packaged, the prebuilt agent bundle.
APP_DIR       everything the program writes: logs, history, save backups and the pipe key. Next to the program; when that
              folder cannot be written to (e.g. under Program Files) in %LOCALAPPDATA%\\JumpSpaceTrainer instead.
"""
import os
import sys

FROZEN = bool(getattr(sys, "frozen", False))
SOURCE_DIR = os.path.dirname(os.path.abspath(__file__))

# PyInstaller unpacks data files next to the bundled modules (sys._MEIPASS); from source it is simply this folder
RESOURCE_DIR = getattr(sys, "_MEIPASS", None) or SOURCE_DIR


def writable(path):
    try:
        os.makedirs(path, exist_ok=True)
        probe = os.path.join(path, ".write-test-%d" % os.getpid())
        with open(probe, "w") as f:
            f.write("x")
        os.remove(probe)
        return True
    except OSError:
        return False


def _app_dir():
    base = os.path.dirname(os.path.abspath(sys.executable)) if FROZEN else SOURCE_DIR
    if writable(base):
        return base
    fallback = os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "JumpSpaceTrainer")
    os.makedirs(fallback, exist_ok=True)
    return fallback


# JUMPSPACE_HOME points the command-line tools at another copy's folder, e.g. the packaged program's, to talk to its service
APP_DIR = os.environ.get("JUMPSPACE_HOME") or _app_dir()


def app_path(*parts):
    return os.path.join(APP_DIR, *parts)


def resource_path(*parts):
    return os.path.join(RESOURCE_DIR, *parts)

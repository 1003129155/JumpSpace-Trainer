"""One-click launcher for the Jump Space trainer.

Starts (or reuses) the background service that holds the Frida session, serves the web UI on 127.0.0.1 and
opens it in its own app-style window. When the window is closed every cheat is switched off and the launcher
exits — but the background service stays attached to the game until the game itself exits (it then ends on
its own). Detaching from a running game would make the game crash or hang when it quits.
"""
import os
import subprocess
import sys
import threading
import time
import traceback
import webbrowser

import paths

ROOT = paths.SOURCE_DIR
LOG = paths.app_path("trainer.log")

EDGE_PATHS = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
]


def log(*parts):
    line = time.strftime("%H:%M:%S ") + " ".join(str(p) for p in parts)
    try:
        print(line, flush=True)
    except (OSError, ValueError, AttributeError):  # pythonw has no console
        pass
    try:
        if os.path.exists(LOG) and os.path.getsize(LOG) > 500_000:
            os.replace(LOG, LOG + ".1")
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def message_box(text, title="跳帮修改器"):
    try:
        import ctypes

        ctypes.windll.user32.MessageBoxW(0, text, title, 0x10)
    except Exception:  # noqa: BLE001
        log("MESSAGE:", text)


def daemon_running():
    import jsc

    try:
        return bool(jsc.call("_bridge", [], timeout=3).get("ok"))
    except Exception:  # noqa: BLE001
        return False


def spawn_service(debug=False):
    """Start daemon.py --service as its own process, independent of this launcher and of any window."""
    exe = sys.executable
    if debug:
        flags = 0x00000010 | 0x00000200  # CREATE_NEW_CONSOLE | CREATE_NEW_PROCESS_GROUP: logs visible
    else:
        flags = 0x00000008 | 0x00000200 | 0x08000000  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
        if exe.lower().endswith("python.exe"):
            exe = exe[:-len("python.exe")] + "pythonw.exe"
    # packaged: the program itself is the service ("app.exe --service"); from source: daemon.py
    command = [exe, "--service"] if paths.FROZEN else [exe, os.path.join(ROOT, "daemon.py"), "--service"]
    return subprocess.Popen(
        command, cwd=paths.APP_DIR if paths.FROZEN else ROOT, creationflags=flags, close_fds=True,
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )


def ensure_service(debug=False, wait=20.0):
    """True once a service answers on the pipe (started by us or already there)."""
    if daemon_running():
        log("reusing the running background service")
        return True
    spawn_service(debug)
    log("started the background service")
    deadline = time.time() + wait
    while time.time() < deadline:
        time.sleep(0.4)
        if daemon_running():
            return True
    return False


def open_window(url):
    exe = next((p for p in EDGE_PATHS if os.path.exists(p)), None)
    if not exe:
        webbrowser.open(url)
        return None
    profile = os.path.join(os.environ.get("LOCALAPPDATA", paths.APP_DIR), "JumpSpaceTrainer", "browser")
    os.makedirs(profile, exist_ok=True)
    args = [
        exe, f"--app={url}", f"--user-data-dir={profile}", "--window-size=1400,900",
        "--no-first-run", "--no-default-browser-check", "--disable-features=Translate,msEdgeWelcomePage",
    ]
    return subprocess.Popen(args)


def main():
    import webui

    debug = "--debug" in sys.argv
    stop = threading.Event()

    if not ensure_service(debug):
        raise RuntimeError("后台服务没有启动，详情见 daemon.log")

    server = webui.create_server(on_shutdown=stop.set)
    url = f"http://127.0.0.1:{server.port}/?t={server.token}"
    threading.Thread(target=server.serve_forever, daemon=True).start()
    log("UI server on port", server.port)

    proc = open_window(url)
    started = time.time()
    try:
        while not stop.is_set():
            time.sleep(0.5)
            if proc is not None and proc.poll() is not None and time.time() - started > 4:
                log("app window closed")
                break
            # fallback when the window process handed over to an existing browser instance:
            # the page polls constantly, so silence means it is gone
            seen = server.gateway.last_seen
            if proc is None or proc.poll() is not None:
                if seen and time.time() - seen > 20:
                    log("UI stopped polling")
                    break
    except KeyboardInterrupt:
        pass
    finally:
        shutdown(server, proc)


def shutdown(server, proc=None):
    """Window closed: cheats off, UI server down. The background service deliberately stays (see the module doc)."""
    log("shutting down: cheats off")
    try:
        import jsc

        jsc.call("dispose", [], timeout=20)
    except Exception as e:  # noqa: BLE001
        log("cleanup problem:", e)
    try:
        server.shutdown()
    except Exception:  # noqa: BLE001
        pass
    if proc is not None and proc.poll() is None:  # closed from inside the page: take the window down with us
        try:
            proc.terminate()
        except Exception:  # noqa: BLE001
            pass
    log("bye (the background service keeps running until the game exits)")
    os._exit(0)


def run():
    """Entry used by `python trainer.py` and by the packaged program."""
    try:
        main()
    except Exception:  # noqa: BLE001
        log("fatal:\n" + traceback.format_exc())
        message_box("修改器启动失败：\n\n" + traceback.format_exc().strip().splitlines()[-1] + "\n\n详情见 trainer.log")
        sys.exit(1)


if __name__ == "__main__":
    run()

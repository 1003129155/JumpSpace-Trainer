"""Bridge between local tools and the running Jump Space process.

Attaches Frida to the game, loads agent.js (plus agent/*.js) and relays commands
that arrive over an authenticated local named pipe (see jsc.py). If the game exits
or restarts the daemon keeps running and attaches again as soon as the game is back.

NEVER detach from a running game. On this machine a Frida detach leaves dangling hooks
of Frida's own in the process, and the game then crashes or hangs when it quits (proven
with a bare attach + empty script + detach). So the one-click launcher runs this file as
a background *service* (`--service`) that outlives the UI window and keeps its single
Frida session until the game has exited; it stops by itself afterwards.

Hot reload of the agent (for development) is opt-in: run `python daemon.py` directly,
or set JUMPSPACE_WATCH=1. The one-click launcher never reloads: replacing a live hook
inside a running game is the riskiest thing this tool does, so normal use avoids it.

Run on the host for single-player or LAN sessions.
"""
import collections
import ctypes
import glob
import json
import os
import re
import secrets
import subprocess
import sys
import threading
import time
import traceback
from multiprocessing.connection import Listener

import frida

import paths

ROOT = paths.SOURCE_DIR  # the source folder: only used to compile the agent and to watch it in development
PIPE = r"\\.\pipe\jumpspace-bridge"
KEYFILE = paths.app_path("daemon.key")
LOGFILE = paths.app_path("daemon.log")
GAME = "Jump Space.exe"
CALL_TIMEOUT = 150  # seconds; the slowest agent call (batch spawn) is bounded below this
RELOAD_SETTLE = 4.0  # seconds to let Frida finish tearing down the old hook before the new one is attached
QUIESCE_TIMEOUT = 8.0  # seconds the agent gets to take its hook out before the script is unloaded
QUIT_RESUME_AFTER = 15.0  # a quit that has not ended the game after this long was cancelled: put the hook back
IDLE_EXIT_AFTER = 90.0  # service mode: seconds without a window and without a game before the process ends itself
MUTEX_NAME = "Local\\JumpSpaceTrainerDaemon"

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, OSError):
    pass

_log_lock = threading.Lock()


def log(*parts):
    line = time.strftime("%H:%M:%S ") + " ".join(str(p) for p in parts)
    with _log_lock:
        try:
            print(line, flush=True)
        except OSError:
            pass
        try:
            if os.path.exists(LOGFILE) and os.path.getsize(LOGFILE) > 2_000_000:
                os.replace(LOGFILE, LOGFILE + ".1")
            with open(LOGFILE, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except OSError:
            pass


def find_pid():
    for p in frida.get_local_device().enumerate_processes():
        if p.name.lower() == GAME.lower():
            return p.pid
    return None


# Do not inject while Unity / IL2CPP is still initializing; give a fresh process time to settle.
STARTUP_GRACE = 30.0


def process_age(pid):
    """Seconds since the process was created (Windows), or None when unknown."""
    try:
        import ctypes
        from ctypes import wintypes

        k32 = ctypes.windll.kernel32
        handle = k32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return None
        try:
            created, exited, kernel, user = (wintypes.FILETIME() for _ in range(4))
            if not k32.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(kernel), ctypes.byref(user)):
                return None
            ticks = (created.dwHighDateTime << 32) | created.dwLowDateTime  # 100 ns since 1601
            return time.time() - (ticks / 1e7 - 11644473600)
        finally:
            k32.CloseHandle(handle)
    except Exception:  # noqa: BLE001
        return None


def agent_bundle():
    """The agent as one script: the prebuilt file when packaged (no Node, no node_modules needed), otherwise compiled
    from the sources so edits take effect."""
    prebuilt = paths.resource_path("agent.bundle.js")
    if os.path.isfile(prebuilt) and (paths.FROZEN or os.environ.get("JUMPSPACE_PREBUILT") == "1"):
        with open(prebuilt, "r", encoding="utf-8") as f:
            return f.read()
    if paths.FROZEN:
        raise BridgeError("安装包不完整：缺少 agent.bundle.js")
    return frida.Compiler().build(os.path.join(ROOT, "agent.js"), project_root=ROOT)


def agent_files():
    files = [os.path.join(ROOT, "agent.js")]
    files += glob.glob(os.path.join(ROOT, "agent", "**", "*.js"), recursive=True)
    return files


def agent_signature():
    sig = []
    for p in agent_files():
        try:
            sig.append((p, os.path.getmtime(p), os.path.getsize(p)))
        except OSError:
            pass
    return tuple(sorted(sig))


class BridgeError(RuntimeError):
    """An expected failure (game not running, agent missing); shown to the user as-is."""


class GameRunning(BridgeError):
    """Stopping the background now would detach Frida from a live game, which poisons the game's exit."""


class Bridge:
    def __init__(self):
        self.session = None
        self.script = None
        self.pid = None
        self.attached_at = None
        self.last_error = None
        self.starting = False  # a game process exists but is still inside its startup grace period
        self.reloads = 0
        self.reload_lock = threading.RLock()
        self.recent_calls = collections.deque(maxlen=16)  # (time, method) — context for a crash report
        self.stopping = False  # set by shutdown(): nothing may attach or reload any more
        self.pump_state = None  # what the agent says about its hook: running / quitting / quiesced
        self.quit_seen_at = None
        self.last_client = time.time()  # the last time a window or command line talked to us

    # ------------------------------------------------------------------ state
    @property
    def ready(self):
        return self.session is not None and self.script is not None

    def info(self):
        return {
            "game": GAME,
            "attached": self.session is not None,
            "starting": self.starting,
            "agentLoaded": self.script is not None,
            "pid": self.pid,
            "attachedAt": self.attached_at,
            "lastError": self.last_error,
            "reloads": self.reloads,
            "pumpState": self.pump_state,
            "daemonTime": time.time(),
        }

    # ----------------------------------------------------------------- attach
    def attach(self):
        if self.stopping:
            raise BridgeError("修改器正在退出")
        pid = find_pid()
        if pid is None:
            raise BridgeError(f"{GAME} 没有运行")
        session = frida.attach(pid)
        if self.stopping:  # shutdown() began while we were attaching: let go again
            try:
                session.detach()
            except Exception:  # noqa: BLE001
                pass
            raise BridgeError("修改器正在退出")
        session.on("detached", lambda reason, crash: self.on_detached(session, reason, crash))
        self.session = session
        self.pid = pid
        self.attached_at = time.time()
        self.last_error = None
        log("attached to pid", pid)

    def on_detached(self, session, reason, crash):
        if session is not self.session:
            return
        log("detached from game:", reason, crash or "")
        if reason == "process-terminated":
            report_game_exit(self.pid, list(self.recent_calls))
        self.session = None
        self.script = None
        self.pid = None
        self.attached_at = None

    # ----------------------------------------------------------------- script
    def _dispose_script(self):
        script = self.script
        if script is None:
            return
        try:
            exported = script.list_exports_sync()
            if "dispose" in exported:
                script.exports_sync.dispose()  # cheats off, Addressables handles released
            elif "releaseCatalog" in exported:
                script.exports_sync.release_catalog()
            if "quiesce" in exported:
                # Unloading removes the hook from another thread while the game's main thread keeps running it
                # thousands of times a second. Let the agent take the hook out from the main thread first.
                self.call_script(script, "quiesce", [], QUIESCE_TIMEOUT)
        except Exception as e:  # noqa: BLE001
            log("dispose error:", e)
        try:
            script.unload()
        except Exception as e:  # noqa: BLE001
            log("unload error:", e)
        self.script = None

    def on_message(self, message, data):
        t = message.get("type")
        if t == "log":
            log("[agent]", message.get("payload"))
        elif t == "error":
            log("[agent-error]", message.get("description"), message.get("stack", ""))
        else:
            log("[agent-msg]", message)

    def load_script(self, only_if_missing=False):
        with self.reload_lock:
            if self.stopping:
                raise BridgeError("修改器正在退出")
            if only_if_missing and self.script is not None:
                return  # someone else (a reload in progress) already put an agent in place while we waited for the lock
            if self.session is None:
                raise BridgeError(f"{GAME} 没有运行")
            # Build first: a syntax error must not take the working agent down.
            bundle = agent_bundle()
            replacing = self.script is not None
            self._dispose_script()
            if replacing:
                time.sleep(RELOAD_SETTLE)  # swapping a hook straight back in while Frida is still cleaning up is what crashed the game once
            script = self.session.create_script(bundle)
            script.on("message", self.on_message)
            script.on("destroyed", lambda: log("agent script destroyed"))
            script.load()
            self.script = script
            self.reloads += 1
            log("agent loaded (%d bytes)" % len(bundle))

    def shutdown(self):
        self.stopping = True  # first: the supervisor must not re-attach the moment we let go
        with self.reload_lock:
            self._dispose_script()
            if self.session is not None:
                try:
                    self.session.detach()
                except Exception:  # noqa: BLE001
                    pass
                self.session = None

    # ------------------------------------------------------------------- call
    def call(self, method, args, timeout=CALL_TIMEOUT):
        script = self.script
        if script is None:
            raise BridgeError("工具尚未连接游戏（游戏未运行，或正在重新连接）")
        self.recent_calls.append((time.strftime("%H:%M:%S"), method))
        return self.call_script(script, method, args, timeout)

    @staticmethod
    def call_script(script, method, args, timeout):
        fn = getattr(script.exports_sync, method)
        result = {}

        def run():
            try:
                result["value"] = fn(*args)
            except Exception as e:  # noqa: BLE001
                result["error"] = e

        worker = threading.Thread(target=run, daemon=True)
        worker.start()
        worker.join(timeout)
        if worker.is_alive():
            raise BridgeError(f"游戏没有在 {timeout:g} 秒内响应（是否暂停或卡住？）")
        if "error" in result:
            raise result["error"]
        return result["value"]

    def check_pump(self):
        """Notice that the game began quitting (the agent took its hook out to keep the exit clean) and, if the quit
        was cancelled and the game is still there, ask the agent to put the hook back."""
        try:
            raw = self.call("pumpStatus", [], timeout=5)
            info = json.loads(raw) if isinstance(raw, str) else raw
        except Exception:  # noqa: BLE001
            return
        state = info.get("state")
        self.pump_state = state
        if state != "quitting":
            self.quit_seen_at = None
            return
        if self.quit_seen_at is None:
            self.quit_seen_at = time.time()
            log("the game is quitting: the agent removed its hook")
        elif time.time() - self.quit_seen_at > QUIT_RESUME_AFTER and find_pid() == self.pid:
            log("the quit was cancelled: putting the hook back")
            self.quit_seen_at = None
            try:
                self.call("resumePump", [], timeout=20)
            except Exception as e:  # noqa: BLE001
                log("could not resume:", e)


# ------------------------------------------------------------------ crash report
def crash_facts(event_text):
    """Application, faulting module, exception code and offset from a `wevtutil ... /f:text` event.

    The labels come back in the system language (often garbled), but the values are plain ASCII.
    """
    desc = event_text.split("Description:", 1)[1] if "Description:" in event_text else ""
    facts = [re.sub(r"[^\x20-\x7e]+", " ", ln).strip() for ln in desc.splitlines()[:6]]
    return " | ".join(f for f in facts if f)


def report_game_exit(pid, calls, window_ms=180000, wait=9):
    """The game process vanished: say why, if Windows knows (runs on its own thread)."""

    def work():
        time.sleep(wait)  # Windows Error Reporting writes its event a few seconds after the crash
        lines = ["last agent calls: " + (", ".join(f"{m}@{t}" for t, m in calls[-10:]) or "none")]
        try:
            query = f"*[System[Provider[@Name='Application Error'] and TimeCreated[timediff(@SystemTime) <= {window_ms}]]]"
            out = subprocess.run(
                ["wevtutil", "qe", "Application", f"/q:{query}", "/c:2", "/rd:true", "/f:text"],
                capture_output=True, timeout=20, creationflags=0x08000000,  # CREATE_NO_WINDOW
            ).stdout
            text = out.decode("utf-8", errors="replace")
            if not text.strip():
                text = out.decode("gbk", errors="replace")
            lines.append("windows crash event: " + (crash_facts(text) or "none found (the game was probably closed normally)"))
        except Exception as e:  # noqa: BLE001
            lines.append(f"windows crash event lookup failed: {e}")
        for line in lines:
            log("[exit-report]", line)

    threading.Thread(target=work, daemon=True).start()


# ---------------------------------------------------------------- supervisors
def supervisor(bridge):
    """Attach whenever the game is running and we are not attached."""
    last_state = None
    rounds = 0
    while not bridge.stopping:
        rounds += 1
        try:
            if bridge.ready and rounds % 2 == 0:
                bridge.check_pump()
            if not bridge.ready:
                if bridge.session is None:
                    pid = find_pid()
                    age = process_age(pid) if pid is not None else None
                    if pid is not None and age is not None and age < STARTUP_GRACE:
                        bridge.starting = True  # wait for the engine to settle before injecting
                    elif pid is not None:
                        bridge.starting = False
                        bridge.attach()
                    else:
                        bridge.starting = False
                if bridge.session is not None and bridge.script is None:
                    bridge.load_script(only_if_missing=True)
            else:
                bridge.starting = False
            state = "ready" if bridge.ready else ("starting" if bridge.starting else "waiting")
            if state != last_state:
                log("state:", state)
                last_state = state
        except BridgeError as e:
            bridge.last_error = str(e)
        except Exception as e:  # noqa: BLE001
            bridge.last_error = f"{type(e).__name__}: {e}"
            log("attach failed:", traceback.format_exc().strip().splitlines()[-1])
            time.sleep(3)
        time.sleep(1.0)


def watcher(bridge):
    """Reload the agent when agent.js or agent/*.js change."""
    last = agent_signature()
    while not bridge.stopping:
        time.sleep(1.0)
        current = agent_signature()
        if current == last:
            continue
        # let editors finish writing several files
        while True:
            time.sleep(0.4)
            again = agent_signature()
            if again == current:
                break
            current = again
        last = current
        if not bridge.ready:
            continue
        log("change detected in agent sources - reloading")
        try:
            bridge.load_script()
        except Exception:  # noqa: BLE001
            bridge.last_error = "agent reload failed"
            log("reload failed:\n" + traceback.format_exc())


# ------------------------------------------------------------------ pipe server
def handle(bridge, conn):
    try:
        while True:
            try:
                raw = conn.recv_bytes()
            except (EOFError, OSError):
                break
            try:
                req = json.loads(raw.decode("utf-8"))
                method = req["method"]
                args = req.get("args", [])
                bridge.last_client = time.time()
                if method == "_bridge":
                    res = bridge.info()
                elif method == "_reload":
                    bridge.load_script()
                    res = "reloaded"
                elif method == "_shutdown":
                    res = request_shutdown(bridge)
                else:
                    res = bridge.call(method, args)
                out = {"ok": True, "result": res}
            except GameRunning as e:
                out = {"ok": False, "error": str(e), "code": "GAME_RUNNING"}
            except BridgeError as e:
                out = {"ok": False, "error": str(e), "code": "NOT_CONNECTED"}
            except Exception as e:  # noqa: BLE001
                out = {"ok": False, "error": f"{type(e).__name__}: {e}"}
            conn.send_bytes(json.dumps(out, ensure_ascii=False).encode("utf-8"))
    finally:
        try:
            conn.close()
        except OSError:
            pass


_mutex_handle = None  # kept for the life of the process


def acquire_single_instance(name=None):
    """True if we are the only daemon. Two of them would attach two Frida sessions to the same game."""
    global _mutex_handle
    kernel32 = ctypes.windll.kernel32
    kernel32.CreateMutexW.restype = ctypes.c_void_p
    handle = kernel32.CreateMutexW(None, False, name or MUTEX_NAME)
    first = kernel32.GetLastError() != 183  # ERROR_ALREADY_EXISTS
    if first:
        _mutex_handle = handle
    return first


def game_present(bridge):
    return bridge.session is not None or bridge.starting or find_pid() is not None


def should_idle_exit(now, last_client, present):
    """Service mode ends itself once there is neither a game nor anyone looking at the trainer."""
    return (not present) and now - last_client > IDLE_EXIT_AFTER


def stop_service(bridge):
    time.sleep(0.3)  # let the reply to the request that asked for this go out first
    bridge.shutdown()
    log("service stopped")
    os._exit(0)


def request_shutdown(bridge):
    """Stop the whole background process - but only while no game is attached: letting go of a running game
    leaves it unable to quit cleanly."""
    if game_present(bridge):
        raise GameRunning("游戏正在运行：为避免游戏退出时崩溃，修改器会保持后台待命，游戏退出后自动结束")
    threading.Thread(target=stop_service, args=(bridge,), daemon=True).start()
    return "stopping"


def idle_monitor(bridge):
    while not bridge.stopping:
        time.sleep(5)
        try:
            if should_idle_exit(time.time(), bridge.last_client, game_present(bridge)):
                log("no game and nobody using the trainer: stopping")
                stop_service(bridge)
        except Exception as e:  # noqa: BLE001
            log("idle monitor:", e)


def watch_requested():
    return os.environ.get("JUMPSPACE_WATCH") == "1"


def serve(bridge, key, background=False, watch=None):
    """Run the supervisor, the pipe server and (only when asked for) the agent file watcher."""
    watch = watch_requested() if watch is None else watch
    threading.Thread(target=supervisor, args=(bridge,), daemon=True).start()
    if watch:
        threading.Thread(target=watcher, args=(bridge,), daemon=True).start()
        log("hot reload of the agent: on")
    else:
        log("hot reload of the agent: off")

    def loop():
        log("listening on", PIPE)
        with Listener(PIPE, family="AF_PIPE", authkey=key) as lst:
            while True:
                try:
                    conn = lst.accept()
                except Exception as e:  # noqa: BLE001  (failed authentication etc.)
                    log("accept error:", e)
                    continue
                threading.Thread(target=handle, args=(bridge, conn), daemon=True).start()

    if background:
        threading.Thread(target=loop, daemon=True).start()
    else:
        loop()


def write_key():
    key = secrets.token_bytes(32)
    with open(KEYFILE, "wb") as f:
        f.write(key)
    return key


def main():
    service = "--service" in sys.argv
    if not acquire_single_instance():
        log("another daemon is already running - nothing to do")
        return
    key = write_key()  # only after we know we are the one: this would lock the running daemon's clients out
    bridge = Bridge()
    if service:
        log("service mode: this process keeps the game's single Frida session until the game exits")
        threading.Thread(target=idle_monitor, args=(bridge,), daemon=True).start()
    try:
        # running the daemon by hand is the development path (hot reload); the service never reloads
        serve(bridge, key, watch=(not service) and "--no-watch" not in sys.argv)
    except KeyboardInterrupt:
        pass
    except Exception:  # noqa: BLE001
        log("fatal:\n" + traceback.format_exc())
    finally:
        if not service:
            bridge.shutdown()


if __name__ == "__main__":
    main()

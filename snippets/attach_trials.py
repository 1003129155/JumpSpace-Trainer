"""DEV TOOL: attach to the running game, load the agent, let go again — N times — and watch that the game survives.

  python snippets/attach_trials.py [N] [--close]

--close: afterwards attach once more and close the game with the trainer attached (the real-world sequence: open and close the
trainer a few times, then quit the game) and report whether Windows logged a crash.
--close-detached: close the game with nothing attached (trainer closed, then quit the game).
--settle S: seconds to wait after the game starts (default 75).

This is exactly what starting and closing the trainer does to the game. Stop the trainer first (it would attach too).
Each cycle: attach, load the agent, let the pump serve a few calls, shutdown (quiesce -> unload -> detach). Afterwards the game
must still be running and Windows must not have logged a crash for it.
"""
import datetime
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import daemon  # noqa: E402

N = int(next((a for a in sys.argv[1:] if a.isdigit() and sys.argv[sys.argv.index(a) - 1] != "--settle"), "8"))


def ps(command):
    return subprocess.run(["powershell", "-NoProfile", "-Command", command], capture_output=True, text=True, timeout=60).stdout.strip()


def main():
    pid = daemon.find_pid()
    if pid is None:
        os.startfile("steam://rungameid/1757300")  # noqa: S606
        t0 = time.time()
        while daemon.find_pid() is None and time.time() - t0 < 90:
            time.sleep(1)
        pid = daemon.find_pid()
        if pid is None:
            print("the game did not start")
            return 1
        print("game started, waiting for it to settle", flush=True)
        time.sleep(int(sys.argv[sys.argv.index("--settle") + 1]) if "--settle" in sys.argv else 75)
    since = datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    for i in range(1, N + 1):
        bridge = daemon.Bridge()
        bridge.attach()
        bridge.load_script()
        calls = 0
        for _ in range(6):
            bridge.call("pumpStatus", [], timeout=10)
            bridge.call("status", [], timeout=20)
            calls += 2
            time.sleep(0.4)
        t = time.time()
        bridge.shutdown()
        alive = daemon.find_pid() == pid
        print(f"cycle {i}: {calls} calls, shutdown took {time.time() - t:.1f}s, game alive: {alive}", flush=True)
        if not alive:
            break
        time.sleep(2)
    if "--close" in sys.argv or "--close-detached" in sys.argv:
        if "--close" in sys.argv:
            bridge = daemon.Bridge()
            bridge.attach()
            bridge.load_script()
        time.sleep(6)
        started = time.time()
        ps("(Get-Process -Name 'Jump Space' | Select-Object -First 1).CloseMainWindow() | Out-Null")
        while daemon.find_pid() == pid and time.time() - started < 25:
            time.sleep(0.1)
        if daemon.find_pid() == pid:
            print(f"HANG: the game did not exit within 25s after {N} attach cycles (Responding="
                  f"{ps('(Get-Process -Id %d).Responding' % pid)})", flush=True)
            subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True)
        else:
            print(f"closed the game after {N} attach cycles: exited in {time.time() - started:.1f}s", flush=True)
        time.sleep(13)
    events = ps("Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=[datetime]'%s'} -ErrorAction SilentlyContinue | Where-Object { $_.ProviderName -eq 'Application Error' -and $_.Message -match 'Jump Space' } | Measure-Object | Select-Object -ExpandProperty Count" % since)
    print("crash events for the game since the start:", events or "0")
    return 0


sys.exit(main())

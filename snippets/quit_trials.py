"""DEV TOOL: close the game N times with the trainer attached and count how many exits crash.

  python snippets/quit_trials.py [N] [--probe] [--uptime SECONDS]

--uptime waits until the game process is that old before closing it: closing a game that is still on its loading screen
exits differently from closing one that has settled (the crashes seen so far all happened after ~2-3 minutes).

Needs the trainer (启动修改器.bat) running. Each trial: launch the game through Steam, wait until the daemon has attached,
ask the game to close (what clicking the window's X does), and look for a Windows crash event afterwards.
Results are appended to out/quit_trials.txt.
"""
import datetime
import json
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import jsc  # noqa: E402

N = int(next((a for a in sys.argv[1:] if a.isdigit() and sys.argv[sys.argv.index(a) - 1] != "--uptime"), "3"))
PROBE = "--probe" in sys.argv
UPTIME = int(sys.argv[sys.argv.index("--uptime") + 1]) if "--uptime" in sys.argv else 0
LOG = os.path.join(ROOT, "out", "quit_trials.txt")


def ps(command, timeout=60):
    return subprocess.run(["powershell", "-NoProfile", "-Command", command], capture_output=True, text=True, timeout=timeout).stdout.strip()


def game_pid():
    out = ps("(Get-Process -Name 'Jump Space' -ErrorAction SilentlyContinue | Select-Object -First 1).Id")
    return int(out) if out.isdigit() else None


def say(text):
    line = datetime.datetime.now().strftime("%H:%M:%S ") + text
    print(line, flush=True)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def bridge():
    try:
        r = jsc.call("_bridge", [], timeout=5)
        return r.get("result") if r.get("ok") else None
    except Exception:  # noqa: BLE001
        return None


def crash_events(since_iso):
    command = (
        "Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=[datetime]'%s'} -ErrorAction SilentlyContinue | "
        "Where-Object { $_.ProviderName -eq 'Application Error' -and $_.Message -match 'Jump Space' } | "
        "ForEach-Object { ($_.TimeCreated.ToString('HH:mm:ss.fff')) + ' ' + (($_.Message -split \"`n\")[0..3] -join ' | ') }" % since_iso
    )
    return ps(command)


def one_trial(i):
    if game_pid():
        say(f"trial {i}: a game is already running - skipped")
        return None
    os.startfile("steam://rungameid/1757300")  # noqa: S606
    t_start = time.time()
    while not game_pid():
        if time.time() - t_start > 90:
            say(f"trial {i}: the game never started")
            return None
        time.sleep(1)
    pid = game_pid()
    while True:
        b = bridge()
        if b and b.get("attached") and b.get("agentLoaded") and b.get("pid") == pid:
            break
        if time.time() - t_start > 180:
            say(f"trial {i}: trainer never attached")
            return None
        time.sleep(2)
    time.sleep(6)
    while UPTIME and time.time() - t_start < UPTIME and game_pid() == pid:
        time.sleep(1)
    if PROBE:
        r = jsc.call("evalFree", [open(os.path.join(ROOT, "snippets", "crash_probe.js"), encoding="utf-8").read()], timeout=60)
        say(f"trial {i}: probe -> {r.get('result') or r.get('error')}")
    st = jsc.call("pumpStatus", [], timeout=10)
    quit_info = json.loads(st["result"]).get("quit") if st.get("ok") else None
    t0 = datetime.datetime.now()
    epoch = int(time.time() * 1000)
    ps("(Get-Process -Name 'Jump Space' | Select-Object -First 1).CloseMainWindow() | Out-Null")
    while game_pid() == pid and time.time() - epoch / 1000 < 60:
        time.sleep(0.1)
    took = time.time() - epoch / 1000
    time.sleep(13)
    events = crash_events(t0.strftime("%Y-%m-%dT%H:%M:%S"))
    verdict = "CRASH" if events else "clean"
    say(f"trial {i}: {verdict}  exit after {took:.1f}s  attach-to-close {int(epoch / 1000 - t_start)}s  quit-watch={quit_info}  close_epoch={epoch}")
    if events:
        say("   " + events.replace("\n", "\n   "))
    return bool(events)


def main():
    say(f"=== {N} trials, probe={'on' if PROBE else 'off'}, close at uptime >= {UPTIME}s ===")
    crashes = clean = 0
    for i in range(1, N + 1):
        r = one_trial(i)
        if r is True:
            crashes += 1
        elif r is False:
            clean += 1
        time.sleep(4)
    say(f"=== done: {clean} clean, {crashes} crashed ===")


main()

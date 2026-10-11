"""DEV TOOL: does a bare Frida attach + empty script + detach — no hooks, no CModule — poison the game's later exit?

  python snippets/bare_detach_trial.py [--no-script]

Launches the game, waits, attaches, (loads an empty script), detaches, then closes the game with nothing attached.
"""
import datetime
import os
import subprocess
import sys
import time

import frida

PY_PS = lambda c: subprocess.run(["powershell", "-NoProfile", "-Command", c], capture_output=True, text=True, timeout=60).stdout.strip()


def pid_of():
    for p in frida.get_local_device().enumerate_processes():
        if p.name == "Jump Space.exe":
            return p.pid


if pid_of() is None:
    os.startfile("steam://rungameid/1757300")  # noqa: S606
    t0 = time.time()
    while pid_of() is None and time.time() - t0 < 90:
        time.sleep(1)
    time.sleep(45)
pid = pid_of()
since = datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
s = frida.attach(pid)
if "--no-script" not in sys.argv:
    sc = s.create_script("rpc.exports = { ping() { return 1; } };")
    sc.load()
    sc.exports_sync.ping()
    sc.unload()
s.detach()
print("attached, (script), detached; waiting 6s", flush=True)
time.sleep(6)
t = time.time()
PY_PS("(Get-Process -Name 'Jump Space' | Select-Object -First 1).CloseMainWindow() | Out-Null")
while pid_of() == pid and time.time() - t < 25:
    time.sleep(0.1)
if pid_of() == pid:
    print("HANG: the game did not exit within 25s", flush=True)
    subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True)
else:
    print(f"exited in {time.time() - t:.1f}s", flush=True)
time.sleep(13)
n = PY_PS("Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=[datetime]'%s'} -ErrorAction SilentlyContinue | Where-Object { $_.ProviderName -eq 'Application Error' -and $_.Message -match 'Jump Space' } | ForEach-Object { ($_.Message -split \"`n\")[0..3] -join ' | ' }" % since)
print("crash events:", n or "none")

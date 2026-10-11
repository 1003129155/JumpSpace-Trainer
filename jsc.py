"""Tiny client for daemon.py.

  jsc.py <method> [arg ...]      arguments that start with @ are read from that file
  jsc.py evalMain @script.js     run a JS file on the Unity main thread
"""
import json
import os
import sys
from multiprocessing.connection import Client

import paths

ROOT = paths.SOURCE_DIR
PIPE = r"\\.\pipe\jumpspace-bridge"

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):  # pythonw (the one-click launcher) has no console: the streams are None
        pass


def call(method, args, timeout=120):
    with open(paths.app_path("daemon.key"), "rb") as f:
        key = f.read()
    with Client(PIPE, family="AF_PIPE", authkey=key) as c:
        c.send_bytes(json.dumps({"method": method, "args": args}).encode("utf-8"))
        if not c.poll(timeout):
            raise TimeoutError("工具响应超时；刷道具任务可能仍在执行，请检查游戏后再操作")
        return json.loads(c.recv_bytes().decode("utf-8"))


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    method = sys.argv[1]
    args = []
    for a in sys.argv[2:]:
        if a.startswith("@") and os.path.isfile(a[1:]):
            with open(a[1:], "r", encoding="utf-8") as f:
                a = f.read()
        args.append(a)
    try:
        r = call(method, args)
    except (OSError, EOFError, TimeoutError) as e:
        print(f"ERROR: {e}；请确认游戏和 daemon.py 已启动", file=sys.stderr)
        return 1
    if r.get("ok"):
        res = r.get("result")
        print(res if isinstance(res, str) else json.dumps(res, ensure_ascii=False, indent=1))
        if method in ("spawn", "previewSpawn", "unlockBlueprint", "previewUnlockBlueprint", "addBlueprint", "previewAddBlueprint", "unlockShip", "previewUnlockShip"):
            result = json.loads(res) if isinstance(res, str) else res
            return 0 if result.get("ok") else 1
        return 0
    print("ERROR:", r.get("error"), file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())

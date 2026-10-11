"""Read out/crashprobe.txt (written by snippets/crash_probe.js) and resolve every address to module+offset.

  python snippets/read_crashprobe.py [out/crashprobe.txt] [close_epoch_ms]

With the epoch (ms) of the moment the game was asked to close, times are shown relative to it.
"""
import json
import sys

path = sys.argv[1] if len(sys.argv) > 1 else "out/crashprobe.txt"
epoch = int(sys.argv[2]) if len(sys.argv) > 2 else None

modules = []  # (base, size, name) — from the last map in the file
records = []
for line in open(path, encoding="utf-8", errors="replace"):
    line = line.rstrip("\n")
    if line.startswith("# module map"):
        modules = []
    elif line.startswith("MOD "):
        _, base, size, name = line.split(" ", 3)
        modules.append((int(base, 16), int(size), name))
    elif line.startswith("{"):
        records.append(json.loads(line))


def where(value):
    try:
        v = int(value, 16) if isinstance(value, str) else int(value)
    except ValueError:
        return value
    for base, size, name in modules:
        if base <= v < base + size:
            return f"{name}+{v - base:#x}"
    return f"{v:#x}"


for i, r in enumerate(records, 1):
    rel = f"{(r['t'] - epoch) / 1000:+.3f}s after close" if epoch else str(r["t"])
    mem = r["memory"]
    print(f"--- #{i} {rel} tid={r['tid']} {r['type']} at {where(r['address'])}  {mem['op'] + ' ' + mem['address'] if mem else ''}")
    regs = r["regs"]
    print("   rsp", regs["rsp"], "rcx", regs["rcx"], "rax", regs["rax"], "rdx", regs["rdx"])
    print("   backtrace:", " <- ".join(where(a) for a in r["bt"][:12]))
    chain = [where(v) for v in r["stack"] if where(v) and "+" in str(where(v))]
    print("   stack return-address candidates:", ", ".join(chain[:14]))

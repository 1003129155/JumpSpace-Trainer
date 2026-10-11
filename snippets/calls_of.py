"""Dev tool (read-only): which methods does a game method call?  Disassembles it inside the running game with Frida and
maps every direct call target back to a name from the il2cpp dump (out/Assembly-CSharp.txt).

  python snippets/calls_of.py <name fragment> [<name fragment> ...]

Needs the game + background service running. Memory is only read. It shows *which* methods a function calls, not under
which conditions, so treat it as a hint about structure, not as a decompiler.
"""
import bisect
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import jsc  # noqa: E402

DUMP = os.path.join(ROOT, "out", "Assembly-CSharp.txt")

JS = r"""
(() => {
  const mod = Process.getModuleByName("GameAssembly.dll");
  const targets = %s;
  const out = {};
  for (const [rva, size, label] of targets) {
    let p = mod.base.add(rva);
    const end = p.add(size);
    const calls = [];
    let n = 0;
    while (p.compare(end) < 0 && n++ < 9000) {
      let ins;
      try { ins = Instruction.parse(p); } catch (e) { break; }
      if (ins.mnemonic === "call") {
        const op = ins.operands[0];
        if (op && op.type === "imm") {
          calls.push("d:" + ptr(String(op.value)).sub(mod.base).toString(16));
        } else if (op && op.type === "mem" && op.value.base === "rip") {
          // call [rip+disp]: read the pointer the game stored there
          try {
            const slot = ins.next.add(op.value.disp);
            const target = slot.readPointer();
            const inside = target.compare(mod.base) >= 0 && target.compare(mod.base.add(mod.size)) < 0;
            calls.push(inside ? "p:" + target.sub(mod.base).toString(16) : "x:" + ins.opStr);
          } catch (e) { calls.push("x:" + ins.opStr); }
        } else {
          calls.push("x:" + ins.opStr);
        }
      }
      p = ins.next;
    }
    out[label] = { instructions: n, calls };
  }
  return JSON.stringify(out);
})()
"""


RESOLVE_JS = r"""
(() => {
  const mod = Process.getModuleByName("GameAssembly.dll");
  const wanted = new Set(%s);
  const found = {};
  for (const asm of Il2Cpp.domain.assemblies) {
    let classes;
    try { classes = asm.image.classes; } catch (e) { continue; }
    for (const c of classes) {
      let methods;
      try { methods = c.methods; } catch (e) { continue; }
      for (const m of methods) {
        let va;
        try { va = m.virtualAddress; } catch (e) { continue; }
        if (!va || va.isNull()) continue;
        const rva = va.sub(mod.base).toString(16);
        if (wanted.has(rva) && !found[rva]) found[rva] = asm.name + "::" + c.type.name + "." + m.name;
      }
    }
  }
  return JSON.stringify(found);
})()
"""


def load_index():
    entries = []
    cls = None
    cls_re = re.compile(r"^(?:class|struct|interface|enum) (\S+)")
    m_re = re.compile(r"^\s+(?:static )?(.+?) ([\w<>.`,\[\]|]+)\((.*)\); // rva 0x([0-9a-f]+)")
    with open(DUMP, encoding="utf-8", errors="replace") as f:
        for line in f:
            c = cls_re.match(line)
            if c:
                cls = c.group(1)
                continue
            m = m_re.match(line)
            if m and cls:
                entries.append((int(m.group(4), 16), cls + "." + m.group(2)))
    entries.sort()
    return entries


def main(patterns):
    entries = load_index()
    rvas = [e[0] for e in entries]
    targets = []
    for i, (rva, name) in enumerate(entries):
        if any(p in name for p in patterns):
            nxt = entries[i + 1][0] if i + 1 < len(entries) else rva + 4096
            size = min(max(nxt - rva, 16), 24000)
            targets.append([rva, size, f"{name} @0x{rva:x}"])
    if not targets:
        raise SystemExit("no method matches " + repr(patterns))
    r = jsc.call("evalFree", [JS % json.dumps(targets)], timeout=180)
    if not r.get("ok"):
        raise SystemExit("ERROR: %s" % r.get("error"))
    data = json.loads(r["result"]) if isinstance(r["result"], str) else r["result"]

    def name_of(rva):
        j = bisect.bisect_right(rvas, rva) - 1
        if j >= 0 and rvas[j] == rva:
            return entries[j][1]
        return resolved.get("%x" % rva)

    unknown = set()
    for info in data.values():
        for c in info["calls"]:
            kind, _, rest = c.partition(":")
            if kind in ("d", "p"):
                v = int(rest, 16)
                j = bisect.bisect_right(rvas, v) - 1
                if not (j >= 0 and rvas[j] == v):
                    unknown.add(rest)
    resolved = {}
    if unknown:
        rr = jsc.call("evalFree", [RESOLVE_JS % json.dumps(sorted(unknown))], timeout=300)
        if rr.get("ok"):
            resolved = json.loads(rr["result"]) if isinstance(rr["result"], str) else rr["result"]

    for label, info in data.items():
        print("=" * 100)
        print(label, f"({info['instructions']} instructions, {len(info['calls'])} calls)")
        seen = {}
        for c in info["calls"]:
            kind, _, rest = c.partition(":")
            if kind in ("d", "p"):
                nm = name_of(int(rest, 16)) or f"<native 0x{int(rest, 16):x}>"
                key = nm
            else:
                key = f"<indirect {rest}>"
            seen[key] = seen.get(key, 0) + 1
        hidden = 0
        for key, n in seen.items():
            if os.environ.get("NAMED") and key.startswith("<"):
                hidden += n
                continue
            print(f"  {n:3d}x {key}")
        if hidden:
            print(f"  ({hidden} calls to unnamed native helpers hidden)")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main(sys.argv[1:])

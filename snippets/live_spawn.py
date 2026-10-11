"""Dev tool: run the CURRENT spawn code of agent.js (and agent/unlocks.js) against the live game without restarting it.

  python snippets/live_spawn.py <test.js>     run a test script (see snippets/spawn_tests/) and print what it reports

The injected agent is never reloaded, so new spawn code cannot take effect in the running game. This harness cuts the
"targeted spawn workflow" block out of agent.js (backpack / ground spawning, the task helpers), puts it in front of the test
script together with the live_unlocks shim (so `X.blueprintGame()` builds generated items) and runs the result on the
game's main thread. The test script is an async body: it gets everything the block defines (spawnGround, consumeTask,
rootObject, ...), `spawnRpc.spawn(...)` / `spawnRpc.previewSpawn(...)` as the agent exposes them, plus `onMain`, `resolveItem`,
`U`, `safe`, and reports with `return`.

WRITES to the live game when a test spawns something: the tests clean up after themselves, but do not run them while
something precious lies on the floor in front of the player.
"""
import json
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "snippets"))
import jsc  # noqa: E402
import live_unlocks as L  # noqa: E402

MARK_FROM = "// ---------------------------------------------------- targeted spawn workflow"
MARK_TO = "let spawnBusy = false;"

PRELUDE = r"""
const GJB = globalThis.JB;
const { onMain, resolveItem, catalog, itemDetails, resourceIndex, ser } = GJB;
const ITEM_CLASS = "Keepsake.PickupableItem_Data";
const CARGO_CLASS = "CargobayItem_Base_Data";
const catalogAssetHandles = [];
"""


def harness(test_source):
    with open(os.path.join(ROOT, "agent.js"), encoding="utf-8") as f:
        src = f.read()
    block = src[src.index(MARK_FROM):src.index(MARK_TO)]
    # the spawn RPCs themselves (the last methods of the exports object): `spawnRpc.spawn(...)` / `spawnRpc.previewSpawn(...)`
    first = src.index("  async previewSpawn(")
    last = src.index("\n});", first)
    block += "let spawnBusy = false;\nconst spawnRpc = {\n" + src[first:last] + "\n};\n"
    # an inner function scope: the block redefines names (bridgeError, delay ...) that the shim already has
    body = (
        "globalThis.__t = { state: 'running' };\n(() => {\n" + PRELUDE + block +
        "\n(async () => {\n"
        "  try { globalThis.__t = { state: 'done', result: await (async () => {\n" + test_source + "\n  })() }; }\n"
        "  catch (e) { globalThis.__t = { state: 'failed', error: String(e && e.stack || e) }; }\n"
        "})();\n"
        "})();\n"
        "return 'started';"
    )
    return L.build(body)


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    with open(sys.argv[1], encoding="utf-8") as f:
        test = f.read()
    r = jsc.call("evalMain", [harness(test)], timeout=120)
    if not r.get("ok"):
        raise SystemExit("ERROR: %s" % r.get("error"))
    deadline = time.time() + float(os.environ.get("SPAWN_TEST_TIMEOUT", "90"))
    while time.time() < deadline:
        r = jsc.call("evalFree", ["JSON.stringify(globalThis.__t)"], timeout=30)
        t = json.loads(r["result"]) if r.get("ok") and isinstance(r.get("result"), str) else {"state": "?"}
        if t.get("state") in ("done", "failed"):
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
            print(json.dumps(t, ensure_ascii=False, indent=1))
            return 0 if t["state"] == "done" else 1
        time.sleep(0.4)
    raise SystemExit("test did not finish in time")


if __name__ == "__main__":
    sys.exit(main())

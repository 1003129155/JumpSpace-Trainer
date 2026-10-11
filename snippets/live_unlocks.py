"""Dev tool: run the *current source* of agent/gear.js + unlocks.js + items.js (and blueprint_flow.js, gear_spec.js) against
the live game, without restarting it (the injected agent is never reloaded, so edits cannot take effect there).

  python snippets/live_unlocks.py read                  read-only: the gear list, slot usage, discovery history
  python snippets/live_unlocks.py gear <key|item> <tier>  read-only: the editor's view of a model (a recipe key of the gear list,
                                                        or an item name) at a tier (0-3): the generator's own item with the
                                                        game's text for its modules, the level cap, and the same maxed.
                                                        Nothing is recorded.
  python snippets/live_unlocks.py consistency [seeds]   read-only: do the editor's rules accept everything the game's own
                                                        generator makes? 8 models (one per category) x 4 tiers x seeds
  python snippets/live_unlocks.py roundtrip <key>       WRITES, leaves the profile as it was: make a blueprint into the
                                                        discovery history, then one into a slot, read the game's own numbers
                                                        for them and take it all back
  python snippets/live_unlocks.py rpc <method> <json arg>...   run one of the modules' RPCs (gearList, gearEdit, itemEdit,
                                                        makeBlueprint, removeRecipeBlueprints, itemList ...) exactly as the
                                                        trainer would call it, and print its reply. Arguments are JSON.
Do not run the writing modes while the crafting screen is open.

How: the source files are turned into one plain script (imports/exports stripped), the agent's own toolbox is put in front
(with `onMain` running in place: the script already runs on the game's main thread), and it is evaluated on the main thread
through the background service. The replies of the RPCs do not carry the `ok` of the real agent's wrapper: a failure is
reported as {ok: false, error: {code, message}}.
"""
import json
import os
import re
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import jsc  # noqa: E402

MODULES = ("blueprint_flow.js", "gear_spec.js", "gear.js", "unlocks.js", "items.js")


def read(name):
    with open(os.path.join(ROOT, "agent", name), encoding="utf-8") as f:
        return f.read()


def plain(source):
    """a module as plain script text: no imports, no exports"""
    return re.sub(r"^export ", "", re.sub(r"^import .*?;\n", "", source, flags=re.M), flags=re.M)


def build(body):
    sources = "\n".join(plain(read(name)) for name in MODULES)
    shim = r"""
const GJB = globalThis.JB;
// the agent's own toolbox, but the work runs where it already is (the main thread) and failures are thrown, not wrapped
const JB = Object.assign({}, GJB, { rpcSafe: (f) => f, onMain: async (f) => f() });
const ex = {};
ex.__expose = (x) => { ex.__internals = x; };
"""
    install = "\ninstallGear(JB, ex);\ninstallItems(JB, ex);\ninstallUnlocks(JB, ex);\nconst X = ex.__internals;\n"
    return "(() => {\n" + shim + sources + install + body + "\n})()"


READ = r"""
const game = X.gearGame();
const rows = X.gearRecipes().map(({ template, ...r }) => r);
const cats = [...new Set(rows.map((r) => r.categoryGuid))].map((g) => ({ g: g.slice(0, 8), name: rows.find((r) => r.categoryGuid === g).category, ...X.slotUsage(g) }));
const history = X.historyEntries().length;
game.release();
return JSON.stringify({ models: rows.length, categories: cats, history }, null, 1);
"""

GEAR = r"""
const key = %s;
const tier = %s;
const recipe = X.findGearRecipe(key) || X.itemEntity(globalThis.JB.resolveItem(key));
const game = X.gearGame();
const view = (b) => b && ({ errors: b.errors, cap: b.evaluation.cap, need: b.evaluation.need, level: b.evaluation.level,
  slots: b.evaluation.slots.map((s) => `${s.name} ${["普","稀","史","传"][s.rarity]} L${s.level}/${s.maxLevel}${s.instigator ? " ★" : ""} ${s.base ? "[基础]" : ""} rolls=${JSON.stringify(s.rolls)} | ${s.text}`) });
try {
  const seed = game.bestSeed(recipe, tier, 42);
  const preview = game.buildGear(recipe, { tier, seed });
  const out = { model: recipe.display, tier, seed, catalogSize: preview.catalog.size, preview: view(preview) };
  out.max = view(buildMax((s) => game.buildGear(recipe, s), preview));
  // a refused edit: the first module twice
  if (preview.spec.slots.length > 1) {
    const dup = { ...preview.spec, slots: preview.spec.slots.map((s, i) => (i === 1 ? { ...s, guid: preview.spec.slots[0].guid } : s)) };
    out.duplicate = view(game.buildGear(recipe, dup));
  }
  return JSON.stringify(out, null, 1);
} finally { game.release(); }
"""

CONSISTENCY = r"""
const SEEDS = Array.from({ length: %s }, (_, i) => 11 + i);
const rows = X.gearRecipes();
const byCategory = new Map();
for (const r of rows) if (!byCategory.has(r.categoryGuid)) byCategory.set(r.categoryGuid, r);
const picks = [...byCategory.values()].slice(0, 8);
const out = { models: picks.map((r) => r.display), builds: 0, withErrors: 0, errors: {}, noItem: 0, examples: [] };
for (const r of picks) {
  for (let tier = 0; tier < 4; tier++) {
    for (const seed of SEEDS) {
      const game = X.gearGame();
      try {
        const b = game.buildGear(r, { tier, seed });
        out.builds++;
        if (!b) { out.noItem++; continue; }
        if (b.errors.length) {
          out.withErrors++;
          for (const e of b.errors) out.errors[e] = (out.errors[e] || 0) + 1;
          if (out.examples.length < 3) out.examples.push({ model: r.display, tier, seed, errors: b.errors });
        }
      } finally { game.release(); }
    }
  }
}
return JSON.stringify(out, null, 1);
"""

ROUNDTRIP = r"""
const key = %s;
const recipe = X.findGearRecipe(key);
if (!recipe) return JSON.stringify({ error: "model not found" });
const hist = () => X.historyEntries().length;
const out = { model: recipe.display, category: recipe.category, historyBefore: hist(), slotsBefore: X.slotUsage(recipe.categoryGuid) };
const spec = { tier: 3, seed: 42 };
const made = [];
out.history = makeBlueprint(X.gearGame(), recipe, { save: false, spec });
out.historyAfterAdd = hist();
if (out.history.status === "found") made.push({ guid: out.history.instanceGuid, where: "history" });
out.slot = makeBlueprint(X.gearGame(), recipe, { save: true, spec });
out.slotsAfterSave = X.slotUsage(recipe.categoryGuid);
if (out.slot.status === "saved") made.push({ guid: out.slot.instanceGuid, where: "slot", level: out.slot.level, rarity: out.slot.rarity });
out.removed = X.dropMade(made);
out.historyAfter = hist();
out.slotsAfter = X.slotUsage(recipe.categoryGuid);
return JSON.stringify(out, null, 1);
"""


def call_rpc(method, args):
    """The RPCs are async: start one, let the game's main thread finish it, read the reply in a second call."""
    body = ('globalThis.__rpc = undefined; ex[%s](...%s).then((v) => { globalThis.__rpc = JSON.stringify(v); }, (e) => { globalThis.__rpc = JSON.stringify({ ok: false, error: { code: (e && e.code) || "GAME_ERROR", message: String((e && e.message) || e) } }); }); return "started";'
            % (json.dumps(method), json.dumps(args)))
    r = jsc.call("evalMain", [build(body)], timeout=180)
    if not r.get("ok"):
        raise SystemExit("ERROR: %s" % r.get("error"))
    for _ in range(240):
        r = jsc.call("evalMain", ["(() => globalThis.__rpc)()"], timeout=60)
        if r.get("ok") and r.get("result") and r["result"] != "undefined":
            res = r["result"]
            return json.loads(res) if isinstance(res, str) else res
        time.sleep(0.25)
    raise SystemExit("no reply")


def main():
    if len(sys.argv) > 2 and sys.argv[1] == "rpc":
        reply = call_rpc(sys.argv[2], [json.loads(a) for a in sys.argv[3:]])
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        return print(json.dumps(reply, ensure_ascii=False, indent=1))
    modes = ("read", "gear", "consistency", "roundtrip")
    if len(sys.argv) < 2 or sys.argv[1] not in modes:
        raise SystemExit(__doc__)
    mode = sys.argv[1]
    key = json.dumps(sys.argv[2] if len(sys.argv) > 2 else "")
    tier = str(int(sys.argv[3])) if len(sys.argv) > 3 else "0"
    if mode == "read":
        body = READ
    elif mode == "consistency":
        body = CONSISTENCY % (sys.argv[2] if len(sys.argv) > 2 else "2")
    elif mode == "gear":
        body = GEAR % (key, tier)
    else:
        body = ROUNDTRIP % key
    r = jsc.call("evalMain", [build(body)], timeout=180)
    if not r.get("ok"):
        raise SystemExit("ERROR: %s" % r.get("error"))
    res = r["result"]
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    print(res if isinstance(res, str) else json.dumps(res, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()

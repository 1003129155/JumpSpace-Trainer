"""Dev tool (read-only): which spawnable items have attributes (a generated item with a rarity, modules and a level)?

For every item of the game's catalog (pickups and ship parts) ask the game's own item generator for an item at the lowest and
the highest tier, in memory only, and report what comes back. Runs the CURRENT source of agent/unlocks.js through the
live_unlocks shim, so it needs the game and the background service, nothing else.

  python snippets/probe_item_attrs.py
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "snippets"))
import jsc  # noqa: E402
import live_unlocks as L  # noqa: E402

BODY = r"""
const out = [];
const wanted = [0, 3];
for (const it of globalThis.JB.catalog()) {
  const row = { name: it.name, category: it.category, display: it.display, tiers: {} };
  const guid = safe(() => it.d.field("m_AssetGUID").value.content, "");
  if (!guid) { row.error = "no guid"; out.push(row); continue; }
  const recipe = { template: it.d, targetGuid: guid, display: it.display };
  const bs = safe(() => it.d.field("m_BaseModuleSet").value, null);
  row.baseSet = !!(bs && !bs.isNull());
  row.baseCount = row.baseSet ? safe(() => { const l = bs.field("m_Modules").value; return l && !l.isNull() ? l.method("get_Count").invoke() : -1; }, -2) : 0;
  for (const tier of wanted) {
    const game = X.blueprintGame();
    try {
      const b = game.buildGear(recipe, { tier, seed: 1 });
      if (!b) row.tiers[tier] = null;
      else row.tiers[tier] = { slots: b.evaluation.slots.length, cap: b.evaluation.cap, level: b.evaluation.level, errors: b.errors.length, mods: b.catalog.size };
    } catch (e) {
      row.tiers[tier] = { error: String(e && e.message || e).slice(0, 120) };
    } finally { game.release(); }
  }
  out.push(row);
}
return JSON.stringify(out);
"""

r = jsc.call("evalMain", [L.build(BODY)], timeout=900)
if not r.get("ok"):
    raise SystemExit("ERROR: %s" % r.get("error"))
rows = json.loads(r["result"]) if isinstance(r["result"], str) else r["result"]
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
none = [x for x in rows if all(v is None for v in x["tiers"].values())]
err = [x for x in rows if any(isinstance(v, dict) and "error" in v for v in x["tiers"].values())]
has = [x for x in rows if any(isinstance(v, dict) and "slots" in v for v in x["tiers"].values())]
print("catalog:", len(rows), "| with attributes:", len(has), "| generator gives nothing:", len(none), "| errors:", len(err))
print("--- with attributes (name | category | tier0 slots/cap | tier3 slots/cap)")
for x in sorted(has, key=lambda x: (x["category"], x["name"])):
    t0, t3 = x["tiers"].get("0") or {}, x["tiers"].get("3") or {}
    print("%-46s %-7s base=%s/%s  %s/%s  %s/%s  %s" % (x["name"], x["category"], x["baseSet"], x["baseCount"], t0.get("slots"), t0.get("cap"), t3.get("slots"), t3.get("cap"), x["display"]))
print("--- generator gives nothing (first 40)")
for x in none[:40]:
    print("  ", x["name"], x["category"], x["display"])
print("--- errors (first 20)")
for x in err[:20]:
    print("  ", x["name"], json.dumps(x["tiers"], ensure_ascii=False)[:200])

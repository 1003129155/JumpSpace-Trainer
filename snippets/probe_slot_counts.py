"""Dev tool (read-only): how many module slots does the game's generator give per model and tier (over many seeds)?"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "snippets"))
import jsc  # noqa: E402
import live_unlocks as L  # noqa: E402

BODY = r"""
const picks = ["Pickupable_PDW_MK0", "MeleeWeapon_Crowbar", "Pickupable_Revolver_MK0", "Component_Reactor_4_1", "Component_Engine_1_1", "Component_ShieldGenerator_1_1", "Component_PilotCannon_1_1", "Component_Sensor_1_1", "Pickupable_TimedGrenade"];
const out = {};
for (const name of picks) {
  const it = globalThis.JB.resolveItem(name);
  const guid = it.d.field("m_AssetGUID").value.content;
  const recipe = { template: it.d, targetGuid: guid, display: it.display };
  out[name] = {};
  for (let tier = 0; tier < 4; tier++) {
    const counts = {};
    for (let seed = 1; seed <= 40; seed++) {
      const game = X.blueprintGame();
      try {
        const b = game.buildGear(recipe, { tier, seed });
        const key = b.evaluation.slots.length + "/" + b.evaluation.cap;
        counts[key] = (counts[key] || 0) + 1;
      } finally { game.release(); }
    }
    out[name][tier] = counts;
  }
}
return JSON.stringify(out);
"""
r = jsc.call("evalMain", [L.build(BODY)], timeout=600)
if not r.get("ok"):
    raise SystemExit("ERROR: %s" % r.get("error"))
data = json.loads(r["result"]) if isinstance(r["result"], str) else r["result"]
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
for name, tiers in data.items():
    print(name)
    for t, c in tiers.items():
        print("   tier", t, "  slots/cap:", ", ".join("%s x%d" % (k, v) for k, v in sorted(c.items())))

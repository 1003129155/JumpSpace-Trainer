"""Dev tool: serve the trainer UI against canned answers (no game, no daemon) to look at or screenshot a page.

  python snippets/ui_mock.py            # prints the URL (also written to out/dev_url.txt for snippets/shot.ps1)
  python snippets/ui_mock.py --stale    # answer like an OLD injected script (status without agentApi, no gear list)

The pages are filled with a few weapons and ship parts (blueprint page, items page), consumable recipes, saved blueprints and
a discovery history. Actions change the canned state the way the game would, so the pages can be clicked through. The
modules and their rules are a tiny stand-in for the game's; the operation log of a run is a temp file, not the real one.
"""
import json
import os
import sys
import tempfile
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import webui  # noqa: E402

STALE = "--stale" in sys.argv
TIER_NAMES = ["Common", "Rare", "Epic", "Legendary"]
TIER_LABELS = ["普通", "稀有", "史诗", "传说"]

# ---- the models of gear (what blueprints can be made of) ------------------------------------------------------------
CATEGORIES = [
    {"guid": "c-weapon", "name": "武器", "slots": {"used": 5, "total": 7}},
    {"guid": "c-special", "name": "特殊武器", "slots": {"used": 6, "total": 6}},
    {"guid": "c-reactor", "name": "反应堆", "slots": {"used": 1, "total": 4}},
    {"guid": "c-engine", "name": "引擎", "slots": {"used": 2, "total": 4}},
    {"guid": "c-shield", "name": "护盾再生器", "slots": {"used": 2, "total": 4}},
]


def gear_row(key, display, cat, target):
    c = next(x for x in CATEGORIES if x["guid"] == cat)
    return {"key": key, "name": "Blueprint_" + key, "display": display, "category": c["name"], "categoryGuid": cat, "targetGuid": "t-" + target, "targetName": target, "cost": 30}


GEAR = [
    gear_row("w-pdw", "Stinger MP-75", "c-weapon", "Pickupable_PDW_MK0"),
    gear_row("w-ar", "VSR 戟", "c-weapon", "Pickupable_AssaultRifle_MK0"),
    gear_row("w-semi", "Bulldog-SA7", "c-weapon", "Pickupable_SemiRifle_MK0"),
    gear_row("w-lmg", "铁带轻机枪\n", "c-weapon", "Pickupable_LMG_MK0"),
    gear_row("w-saw", "Missing loc: STC_Main.SAW LMG", "c-weapon", "Pickupable_SAW_LMG_Mk0"),
    gear_row("s-rail", "长矛轨道炮", "c-special", "Component_SpecialWeapon_Railgun_1"),
    gear_row("r-zero", "零波反应堆", "c-reactor", "Component_Reactor_4_1"),
    gear_row("r-fission", "裂变反应堆", "c-reactor", "Component_Reactor_1_1"),
    gear_row("e-drift", "漂移相位引擎", "c-engine", "Component_Engine_1_1"),
    gear_row("sh-light", "轻型护盾再生器", "c-shield", "Component_ShieldGenerator_1_1"),
]
HISTORY = [{"name": "零波反应堆", "category": "反应堆", "categoryGuid": "c-reactor", "rarity": "Common", "level": 1, "instanceGuid": "found-a3", "modules": []}]
OWNED = [
    {"categoryGuid": "c-weapon", "category": "武器", "slot": 0, "name": "VSR 戟", "rarity": "Common", "level": 1, "modules": [1, 2], "instanceGuid": "bp-1"},
    {"categoryGuid": "c-weapon", "category": "武器", "slot": 1, "name": "Bulldog-SA7", "rarity": "Legendary", "level": 12, "modules": [1, 2, 3, 4, 5], "instanceGuid": "bp-2"},
    {"categoryGuid": "c-reactor", "category": "反应堆", "slot": 0, "name": "裂变反应堆", "rarity": "Common", "level": 2, "modules": [1], "instanceGuid": "bp-3"},
]


def find(key):
    return next((r for r in GEAR if r["key"] == key), None)


def slots_of(cat):
    return next(c for c in CATEGORIES if c["guid"] == cat)["slots"]


# ---- consumable recipes ---------------------------------------------------------------------------------------------
def recipe(key, display, cat_name, unlocked, cost=10, kind="craftable"):
    return {"key": key, "name": "Craftable_" + key, "display": display, "category": cat_name, "categoryGuid": "c-" + cat_name, "kind": kind,
            "unlocked": unlocked, "unlockable": True, "targetName": "T_" + key, "targetGuid": "t-" + key, "cost": cost}


RECIPES = [
    recipe("t1", "灭火器", "维护", True, 5),
    recipe("t2", "船体修复工具", "维护", False, 20),
    recipe("t3", "维修包", "维护", False, 12),
    recipe("m1", "医疗兴奋剂", "物品", True, 5),
    recipe("m2", "医疗 EM-8", "物品", False, 15),
    recipe("a1", "步行弹药箱", "弹药", False, 10),
]

# ---- items (the items page) -----------------------------------------------------------------------------------------
GROUPS = {"weapon": "枪械", "melee": "近战武器", "consumable": "消耗品", "gadget": "战术装备", "resource": "资源 / 战利品", "component": "飞船部件", "internal": "内部 / 未完成"}


def item(name, display, group, category="pickup", slot="Weapon", gear=False, stack=1, backpack=True, carry="smg"):
    return {"name": name, "display": display, "category": category, "slot": slot, "carry": carry, "tier": 1, "maxStack": stack, "guid": "t-" + name,
            "hasFirstPerson": True, "canBackpack": backpack, "translated": True, "group": group, "groupLabel": GROUPS[group], "hidden": False, "gear": gear}


ITEMS = [
    item("Pickupable_PDW_MK0", "Stinger MP-75", "weapon", gear=True),
    item("Pickupable_AssaultRifle_MK0", "VSR 戟", "weapon", gear=True),
    item("Pickupable_SemiRifle_MK0", "Bulldog-SA7", "weapon", gear=True),
    item("MeleeWeapon_Crowbar", "撬棍", "melee", gear=True, carry="crowbar"),
    item("Pickupable_MedStim", "医疗兴奋剂", "consumable", slot="Utility", stack=3, carry="stim"),
    item("Pickupable_FireExtinguisher", "灭火器", "gadget", slot="Utility"),
    item("Pickupable_MateriaIngot_Crude", "粗糙魔晶锭", "resource", slot="Backpack", stack=50),
    item("Component_Reactor_4_1", "零波反应堆", "component", category="cargo", slot=None, gear=True, backpack=False),
    item("Component_Engine_1_1", "漂移相位引擎", "component", category="cargo", slot=None, gear=True, backpack=False),
    item("Pickupable_GenericWeapon", "UNNAMED", "internal"),
]
for _it in ITEMS:
    if _it["group"] == "internal":
        _it["hidden"] = True
        _it["translated"] = False

STATUS = {
    "ok": True, "unity": "6000.3.9f1", "pumpTicks": 1, "net": {"listening": True, "server": True, "host": True},
    "profile": {"ready": True, "level": 3, "rank": "探索者 I"},
    "player": {"id": "network:1", "clientId": "0", "name": "测试玩家", "local": True, "downed": False, "backpackAvailable": True, "health": 100, "maxHealth": 100, "shield": 25, "maxShield": 25, "invulnerable": False, "dead": False},
    "loadout": {"held": "铁带轻机枪", "heldName": "Pickupable_LMG_MK0", "ammo": {"current": 100, "max": 200}},
    "cheats": {k: False for k in ("god", "heal", "ammo", "ship", "revive", "solo", "materia", "speed", "jump")}, "materia": {"amount": 100, "max": 100},
}
if not STALE:
    STATUS["agentApi"] = 3

# ---- ventures (委托) --------------------------------------------------------------------------------------------------
def _venture(key, name, kind, state, description, xp=0, credits=0, ingots=0, unlocks=(), achievement=False, prerequisites=True, season=True):
    return {"key": key, "name": name, "kind": kind, "state": state, "description": description, "prerequisitesMet": prerequisites,
            "inSeason": season, "secret": False, "achievement": achievement, "experience": xp, "credits": credits, "ingots": ingots,
            "unlocks": [{"guid": f"{key}-{i}", "kind": k, "name": n} for i, (k, n) in enumerate(unlocks)]}


VENTURES = [
    _venture("v-alliance", "加入抵抗组织", "main", "active", "找到联系阿提兰抵抗联盟的方法", 700, 2000, 12, [("region", "夸拉之柱")], achievement=True),
    _venture("v-dart", "飞镖 DT-4", "ship", "active", "找到并带回飞镖 DT-4", unlocks=[("ship", "DT-4 飞镖")]),
    _venture("v-salvage", "替代来源", "side", "ready", "带回价值3个锭的回收物", 600, 300, 5, [("helmet", "打捞者头盔"), ("trait", "冲击裤")]),
    _venture("v-fire", "防火实地测试", "side", "idle", "扑灭10场火灾", 1000, 4000, 0, [("helmet", "火焰头盔"), ("trait", "火山碎屑绝缘体")], prerequisites=False),
    _venture("v-pumpkin", "南瓜狩猎", "side", "idle", "收集6个南瓜", 400, 600, 0, [("helmet", "南瓜头盔")], season=False),
    _venture("v-region", "伊卡里昂边域", "region", "active", "下载3个地图碎片", unlocks=[("region", "伊卡里昂边域")]),
    _venture("v-ship1", "修复飞船 - 第2部分", "main", "completed", "完成一个\"坠毁货物回收\"任务", 900, 500, 7, [("ship", "C-3 双体船 Mk.1")]),
]


# ---- the attribute editor: a tiny stand-in for the game's modules and rules ------------------------------------------
MODULES = [
    # guid, name, base?, instigator?, allowed rarities (min..max), max level per rarity
    ("dmg", "提升伤害", True, False, (0, 3), [4, 4, 5, 5]),
    ("rate", "提升射速", True, False, (0, 3), [4, 4, 5, 5]),
    ("mag", "增加弹匣容量", True, False, (0, 3), [4, 4, 5, 5]),
    ("fire", "点火线圈", False, True, (0, 3), [4, 4, 4, 4]),
    ("crit", "自适应弹药", False, False, (1, 3), [0, 4, 3, 2]),
    ("acid", "酸液注射器", False, True, (0, 3), [4, 4, 3, 3]),
    ("chaos", "混沌理论", False, True, (3, 3), [0, 0, 0, 3]),
]
CAPS = [5, 7, 10, 12]
TIER_COLORS = ["80E5B2", "33CCFF", "F28CFF", "FF7359"]
BY_GUID = {m[0]: m for m in MODULES}


def module_rows():
    return [
        {"guid": g, "name": n, "base": base, "school": not base, "instigator": ins, "minRarity": lo, "maxRarity": hi,
         "allowed": [True if base else lo <= r <= hi for r in range(4)], "maxLevel": [max(1, v) for v in ml], "rolls": [1, 1, 1, 1]}
        for g, n, base, ins, (lo, hi), ml in MODULES
    ]


def module_text(guid, rarity, level, roll):
    name = BY_GUID[guid][1]
    value = round(8 + rarity * 4 + (level - 1) * 3 + (1.0 if roll == "max" else 0.4) * 6)
    color = TIER_COLORS[rarity]
    return f'{name}：<b><span style="color:#{color}">+{value}%</span></b> 效果', f"{name}：+{value}%"


def evaluate(spec, preview=False):
    tier = int(spec.get("tier", 0))
    n = 2 + tier
    seed = int(spec.get("seed", 1))
    if preview or not spec.get("slots"):
        pool = [m[0] for m in MODULES if m[0] != "chaos" or tier == 3]
        slots = [{"guid": pool[(seed + i * 3) % len(pool)], "rarity": max(0, tier - (i // 2)), "level": 1, "roll": [0.4]} for i in range(n)]
        # keep each pick unique and allowed at its rarity
        seen = set()
        for i, sl in enumerate(slots):
            while sl["guid"] in seen or not (BY_GUID[sl["guid"]][2] or BY_GUID[sl["guid"]][4][0] <= sl["rarity"] <= BY_GUID[sl["guid"]][4][1]):
                sl["guid"] = pool[(pool.index(sl["guid"]) + 1) % len(pool)]
            seen.add(sl["guid"])
    else:
        slots = [dict(sl) for sl in spec["slots"]]
    errors, seen = [], set()
    if len(slots) != n:
        errors.append(f"这件装备有 {n} 个词条位，现在给了 {len(slots)} 个")
    for i, sl in enumerate(slots):
        g, name, base, _, (lo, hi), ml = BY_GUID[sl["guid"]]
        if sl["rarity"] > tier:
            errors.append(f"第 {i + 1} 个词条（{name}）：词条品质不能高于装备品质")
        if not base and not (lo <= sl["rarity"] <= hi):
            errors.append(f"第 {i + 1} 个词条（{name}）：这件装备上不能是这个品质")
        if sl["guid"] in seen:
            errors.append(f"词条「{name}」重复了")
        seen.add(sl["guid"])
        if not (1 <= int(sl.get("level", 1)) <= max(1, ml[sl["rarity"]])):
            errors.append(f"第 {i + 1} 个词条（{name}）：等级只能是 1–{max(1, ml[sl['rarity']])}")
    need = 1 + sum(int(sl.get("level", 1)) - 1 for sl in slots)
    cap = CAPS[tier]
    level = spec.get("level")
    level = cap if level == "max" else (need if level in (None, "") else max(int(level), need))
    if level > cap:
        errors.append(f"装备等级 {level} 超过了这件装备的上限 {cap}")
    out_slots = []
    for sl in slots:
        html, text = module_text(sl["guid"], sl["rarity"], int(sl.get("level", 1)), sl.get("roll"))
        out_slots.append({"guid": sl["guid"], "name": BY_GUID[sl["guid"]][1], "rarity": sl["rarity"], "level": int(sl.get("level", 1)),
                          "maxLevel": max(1, BY_GUID[sl["guid"]][5][sl["rarity"]]), "instigator": BY_GUID[sl["guid"]][3], "base": BY_GUID[sl["guid"]][2],
                          "rolls": [1.0 if sl.get("roll") == "max" else 0.4], "html": html, "text": text})
    ev = {"errors": errors, "cap": cap, "need": need, "level": level, "slots": out_slots if not errors else []}
    return {"tier": tier, "seed": seed, "level": spec.get("level"), "slots": slots}, ev


def edit(display, category, key, args):
    spec, action = args[1], args[2] if len(args) > 2 else "evaluate"
    if isinstance(spec, str):
        spec = json.loads(spec)
    if action == "preview":
        spec = {**spec, "slots": None}
    norm, ev = evaluate(spec, preview=action == "preview")
    if action == "max":
        cap = CAPS[norm["tier"]]
        slots = []
        for sl in norm["slots"]:  # every module at the highest rarity it comes in, not above the item's
            _, _, base, _, (lo, hi), _ = BY_GUID[sl["guid"]]
            best = max([r for r in range(norm["tier"] + 1) if base or lo <= r <= hi] or [sl["rarity"]])
            slots.append({**sl, "rarity": best, "roll": "max", "level": 1})
        points = cap - 1
        while points > 0:
            moved = False
            for sl in slots:
                if points > 0 and sl["level"] < max(1, BY_GUID[sl["guid"]][5][sl["rarity"]]):
                    sl["level"] += 1
                    points -= 1
                    moved = True
            if not moved:
                break
        norm, ev = evaluate({**norm, "slots": slots, "level": "max"})
    out = {"ok": True, "model": {"key": key, "display": display, "category": category}, "spec": norm, "evaluation": ev}
    if action == "preview":
        out["modules"] = module_rows()
    return out


def gear_edit(args):
    r = find(args[0])
    return edit(r["display"].strip(), r["category"], r["key"], args)


def item_edit(args):
    it = next(i for i in ITEMS if i["name"] == args[0])
    return edit(it["display"], "飞船部件" if it["category"] == "cargo" else "物品", it["name"], args)


def make_blueprint(args):
    key, mode, spec = args[0], args[1], args[2]
    if isinstance(spec, str):
        spec = json.loads(spec)
    norm, ev = evaluate(spec)
    r = find(key)
    if ev["errors"]:
        return {"ok": False, "error": {"code": "BLUEPRINT_INVALID", "message": "属性不符合游戏规则：" + "；".join(ev["errors"])}}
    tier = norm["tier"]
    grade = f"{TIER_LABELS[tier]}品质 · {ev['level']} 级"
    name = r["display"].strip()
    if mode == "slot":
        s = slots_of(r["categoryGuid"])
        if s["used"] >= s["total"]:
            return {"ok": False, "error": {"code": "BLUEPRINT_NOSLOT", "message": f"「{r['category']}」的蓝图槽已满（{s['used']}/{s['total']}），请先在游戏里清出一个槽位，或者先加入发现历史"}}
        s["used"] += 1
        guid = f"bp-{key}-{s['used']}"
        OWNED.append({"categoryGuid": r["categoryGuid"], "category": r["category"], "slot": s["used"] - 1, "name": name, "rarity": TIER_NAMES[tier], "level": ev["level"], "modules": [0] * len(norm["slots"]), "instanceGuid": guid})
        message = f"已存入「{r['category']}」蓝图槽 {s['used']}（{s['used']}/{s['total']}）：{name}（{grade}），现在可以在制作台制作"
        bp = {"status": "saved", "instanceGuid": guid, "level": ev["level"], "rarity": TIER_NAMES[tier], "slot": s["used"] - 1, "used": s["used"], "total": s["total"], "message": message}
    else:
        guid = f"found-{key}-{len(HISTORY)}"
        HISTORY.append({"name": name, "category": r["category"], "categoryGuid": r["categoryGuid"], "rarity": TIER_NAMES[tier], "level": ev["level"], "instanceGuid": guid, "modules": [0] * len(norm["slots"])})
        message = f"已加入发现历史：{name}（{grade}），在“我的蓝图”页（或游戏里的扫描台）保存为蓝图后即可制作"
        bp = {"status": "found", "instanceGuid": guid, "level": ev["level"], "rarity": TIER_NAMES[tier], "message": message}
    return {"ok": True, "blueprint": bp, "message": message}


def remove_made(args):
    done = []
    for m in args[0]:
        gone = False
        for lst in (HISTORY, OWNED):
            for e in list(lst):
                if e["instanceGuid"] == m["guid"]:
                    lst.remove(e)
                    gone = True
                    if lst is OWNED:
                        s = slots_of(e["categoryGuid"])
                        s["used"] = max(0, s["used"] - 1)
        done.append({"guid": m["guid"], "where": m["where"], "removed": gone, "reason": None if gone else "gone"})
    return {"ok": True, "blueprints": done, "changed": sum(1 for d in done if d["removed"])}


def spawn(args):
    name, n, dest = args[0], int(args[1]), args[2]
    spec = args[5] if len(args) > 5 else None
    if isinstance(spec, str):
        spec = json.loads(spec)
    out = {"ok": True, "requested": n, "backpack": n if dest == "backpack" else 0, "ground": n if dest == "ground" else 0, "item": name, "player": {"name": "测试玩家"}}
    if spec:
        norm, ev = evaluate(spec)
        if ev["errors"]:
            return {"ok": False, "requested": n, "backpack": 0, "ground": 0, "error": {"code": "GEAR_INVALID", "message": "属性不符合游戏规则：" + "；".join(ev["errors"])}}
        out["gear"] = {"tier": norm["tier"], "level": ev["level"], "modules": len(norm["slots"])}
    return out


def raw(method, args, timeout=130):
    if method == "_bridge":
        return {"ok": True, "result": {"attached": True, "agentLoaded": True, "pumpState": "running", "starting": False}}
    if method == "status":
        return STATUS
    if method == "gearList":
        if STALE:
            return {"ok": False, "error": {"code": "BRIDGE_ERROR", "message": "AttributeError: no such method"}}
        return {"ok": True, "gear": GEAR, "categories": CATEGORIES, "history": {"count": len(HISTORY), "max": 50}, "failed": []}
    if method == "recipes":
        return {"ok": True, "recipes": RECIPES, "failed": []}
    if method == "gearEdit":
        return gear_edit(args)
    if method == "itemEdit":
        return item_edit(args)
    if method == "makeBlueprint":
        return make_blueprint(args)
    if method == "removeRecipeBlueprints":
        return remove_made(args)
    if method == "unlockRecipes":
        keys = args[0] if args else []
        for k in keys:
            next(r for r in RECIPES if r["key"] == k)["unlocked"] = True
        return {"ok": True, "failed": 0, "changed": len(keys), "results": [{"ok": True, "key": k, "changed": True} for k in keys]}
    if method == "lockRecipes":
        for k in args[0] if args else []:
            next(r for r in RECIPES if r["key"] == k)["unlocked"] = False
        return {"ok": True, "failed": 0, "changed": len(args[0]), "results": [{"ok": True, "key": k, "changed": True} for k in args[0]], "blueprints": []}
    if method == "blueprints":
        caps = [{"categoryGuid": c["guid"], "category": c["name"], "max": c["slots"]["total"], "purchased": 0} for c in CATEGORIES]
        return {"ok": True, "owned": OWNED, "history": HISTORY, "capacities": caps}
    if method == "addBlueprint":
        guid = args[0]
        e = next((h for h in HISTORY if h["instanceGuid"] == guid), None)
        if e:
            HISTORY.remove(e)
            slots_of(e["categoryGuid"])["used"] += 1
            OWNED.append({**e, "slot": slots_of(e["categoryGuid"])["used"] - 1})
        return {"ok": True, "changed": bool(e)}
    if method == "itemList":
        if STALE:
            return {"ok": True, "items": [{k: v for k, v in i.items() if k != "gear"} for i in ITEMS], "groups": GROUPS, "counts": {}, "failures": []}
        return {"ok": True, "items": ITEMS, "groups": GROUPS, "counts": {}, "failures": []}
    if method == "itemInfo":
        return {"ok": True, "name": args[0], "description": "这是一件测试用的物品，说明由游戏提供。", "typeName": "测试"}
    if method == "players":
        return {"ok": True, "network": {}, "players": [STATUS["player"]]}
    if method == "previewSpawn":
        r = spawn(args)
        return r if not r["ok"] else {"ok": True, "player": r["player"], "requested": r["requested"], "backpack": r["backpack"], "ground": r["ground"], "freeSlots": 8}
    if method == "spawn":
        return spawn(args)
    if method == "equipHand":
        spec = args[1] if len(args) > 1 else None
        out = {"ok": True, "item": args[0], "display": args[0]}
        if spec:
            norm, ev = evaluate(json.loads(spec) if isinstance(spec, str) else spec)
            out["gear"] = {"tier": norm["tier"], "level": ev["level"], "modules": len(norm["slots"])}
        return out
    if method == "ventures":
        return {"ok": True, "ventures": VENTURES, "hidden": 28}
    if method == "completeVenture":
        v = next((x for x in VENTURES if x["key"] == (args[0] if args else "")), None)
        if not v:
            return {"ok": False, "error": {"code": "VENTURE_NOT_FOUND", "message": "没有找到这个委托，请刷新列表"}}
        if v["state"] == "completed":
            return {"ok": True, "changed": False, "venture": v}
        v["state"] = "completed"
        return {"ok": True, "changed": True, "venture": v}
    if method in ("progression", "cheats", "ships"):
        return {"ok": True}
    return {"ok": True, "changed": False}


def main():
    webui.DATA_DIR = tempfile.mkdtemp(prefix="jsb_mock_")  # the operation log of this run, not the real one
    webui.HISTORY_FILE = os.path.join(webui.DATA_DIR, "history.jsonl")
    server = webui.create_server(preferred_port=8790)
    server.gateway.raw = raw
    server.gateway.backups.ensure_recent = lambda reason: None
    url = f"http://127.0.0.1:{server.port}/?t={server.token}"
    os.makedirs(os.path.join(ROOT, "out"), exist_ok=True)
    with open(os.path.join(ROOT, "out", "dev_url.txt"), "w", encoding="utf-8") as f:
        f.write(url)
    print("mock UI:", url, flush=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    while True:
        time.sleep(3600)


if __name__ == "__main__":
    main()

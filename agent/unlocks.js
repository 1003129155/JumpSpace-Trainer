// Crafting recipes and ship designs with their in-game (localized) names, plus batch unlock on top of the single-item
// unlock flow in agent.js.
//
// Unlocking a recipe only makes the model known to the game. Consumables, ammo and tools (kind "craftable") are crafted
// straight from their recipe once it is unlocked. Weapons and ship parts (kind "blueprint") are crafted from *blueprints*
// kept in the profile, which have nothing to do with the recipe being unlocked: see gear.js and blueprint_flow.js.
export function installUnlocks(JB, ex) {
  const { U, onMain, safe, bridgeError, rpcSafe } = JB;
  const CRAFTABLE = "Keepsake.GameplayFeatures.Assembler.Craftable";
  const SHIP = "Keepsake.SpaceshipBlueprint";
  const MPM = () => U.cls("Keepsake.MetaProgression.MetaProgressionManager");

  const guidOf = (o) => safe(() => o.method("get_AssetGUID").invoke().content, "");
  const isClone = (o) => U.name(o).endsWith("(Clone)");
  const stripClone = (s) => String(s).replace(/\(Clone\)$/, "");

  // The game instantiates clones that share the asset GUID; prefer the original.
  function uniqueByGuid(objects) {
    const map = new Map();
    for (const o of objects) {
      const g = guidOf(o);
      if (!g) continue;
      const prev = map.get(g);
      if (!prev || (isClone(prev) && !isClone(o))) map.set(g, o);
    }
    return map;
  }

  async function ensureLoaded(category, cls) {
    const missing = await onMain(() => {
      const have = new Set(U.loaded(cls).map(guidOf));
      return JB.resourceIndex().entries.filter((e) => e.category === category && !have.has(e.key));
    });
    const failed = [];
    for (const e of missing) {
      try { await JB.loadCatalogAsset(e); } catch (err) { failed.push({ name: e.name, message: err.message }); }
    }
    return failed;
  }

  // ------------------------------------------------------------------ recipes
  // weapons and ship parts live in categories of kind "Blueprint"; everything else is crafted from the recipe itself
  const kindOf = (cat) => (!cat.isNull() && safe(() => String(cat.field("m_CategoryEntryKind").value), "") === "Blueprint" ? "blueprint" : "craftable");

  function recipeContext() {
    return {
      unlocked: new Set(JB.managedRows(MPM().method("get_UnlockedCraftables").invoke(), guidOf)),
      validTargets: new Set(JB.resourceIndex().entries.filter((e) => e.category === "pickup" || e.category === "cargo").map((e) => e.key)),
    };
  }

  // one recipe as the UI shows it
  function describeRecipe(guid, c, ctx) {
    const cat = c.field("m_Category").value;
    const target = c.field("m_CraftableObject").value;
    const targetGuid = target.isNull() ? null : safe(() => target.field("m_AssetGUID").value.content, null);
    const name = stripClone(U.name(c));
    return {
      key: guid,
      name,
      display: safe(() => c.method("get_DisplayName").invoke().content, "") || name,
      category: cat.isNull() ? "" : safe(() => cat.method("get_DisplayName").invoke().content, ""),
      categoryGuid: cat.isNull() ? "" : guidOf(cat),
      kind: kindOf(cat),
      unlocked: ctx.unlocked.has(guid),
      unlockable: !!targetGuid && ctx.validTargets.has(targetGuid),
      targetName: target.isNull() ? "" : stripClone(U.name(target)),
      targetGuid: targetGuid || "",
      cost: safe(() => c.field("m_MateriaCraftCost").value, 0),
    };
  }

  function recipeRows() {
    const ctx = recipeContext();
    return [...uniqueByGuid(U.loaded(CRAFTABLE))].map(([guid, c]) => describeRecipe(guid, c, ctx));
  }

  function shipRows() {
    const M = MPM();
    const owned = new Set(JB.managedRows(M.method("get_OwnedShips").invoke(), (s) => s.field("m_ShipBlueprintAssetGUID").value.content));
    const currentGuid = safe(() => {
      const cur = M.method("get_CurrentShip").invoke().method("get_Value").invoke();
      return cur.isNull() ? "" : cur.field("m_ShipBlueprintAssetGUID").value.content;
    }, "");
    const rows = [];
    for (const [guid, s] of uniqueByGuid(U.loaded(SHIP))) {
      const name = stripClone(U.name(s));
      rows.push({
        key: guid,
        name,
        display: safe(() => s.method("get_BlueprintName").invoke().content, "") || name,
        description: safe(() => s.method("get_BlueprintDescription").invoke().content, ""),
        shipType: safe(() => String(s.field("m_ShipType").value), ""),
        mark: safe(() => s.field("m_Mark").value, 0),
        health: safe(() => s.field("m_MaxHealth").value, 0),
        materiaCapacity: safe(() => s.field("m_MateriaCapacity").value, 0),
        speed: safe(() => s.field("m_DisplaySpeed").value, 0),
        maneuver: safe(() => s.field("m_DisplayManeuverability").value, 0),
        unlockedFlag: !!safe(() => M.method("HasUnlockedAsset").invoke(Il2Cpp.string(guid)), false),
        owned: owned.has(guid),
        current: guid === currentGuid,
      });
    }
    return rows;
  }

  function requireProfile() {
    if (!safe(() => MPM().method("get_InitialDataSuccessfullyLoaded").invoke(), false)) {
      throw bridgeError("PROFILE_NOT_READY", "本机存档尚未加载完成，请先进入游戏（大厅或飞船内）再试");
    }
  }

  const FATAL = new Set(["PROFILE_NOT_READY", "PLAYER_GONE", "NO_SESSION", "PROFILE_CHANGED", "LOCAL_PROFILE_ONLY"]);
  const asList = (v) => (Array.isArray(v) ? v : JSON.parse(String(v || "[]")));

  // Run the single-item unlock for each key; one failure does not hide the others.
  async function unlockBatch(kind, keys) {
    const list = asList(keys).map(String);
    if (!list.length) throw bridgeError("NOTHING_SELECTED", "请先选择要解锁的项目");
    if (list.length > 30) throw bridgeError("TOO_MANY", "一次最多解锁 30 项，请分批操作");
    const single = kind === "recipe" ? ex.unlockBlueprint : ex.unlockShip;
    const results = [];
    for (const key of list) {
      const r = JSON.parse(await single(key, "local"));
      results.push({ key, ok: !!r.ok, changed: !!r.changed, error: r.ok ? null : r.error.message, code: r.ok ? null : r.error.code });
      if (!r.ok && FATAL.has(r.error.code)) break;
    }
    return { results, changed: results.filter((x) => x.changed).length, failed: results.filter((x) => !x.ok).length };
  }

  // Undo for recipe unlocks made by this tool: lock the same asset again through
  // the game's own API and confirm by reading the unlocked-craftables list back.
  async function lockRecipe(key) {
    const plan = await JB.prepareRecipe(key, "local");
    if (!plan.alreadyUnlocked) return { key, ok: true, changed: false };
    await onMain(() => {
      const ctx = JB.localProfile(plan.player.id);
      if (ctx.saveId !== plan.saveId) throw bridgeError("PROFILE_CHANGED", "当前存档已切换，请重新操作");
      ctx.manager.method("SetAssetUnlocked").invoke(Il2Cpp.string(plan.recipe.targetGuid), false, true);
    });
    const deadline = Date.now() + 10000;
    for (;;) {
      const still = await onMain(() => JB.recipeUnlocked(JB.localProfile(plan.player.id).manager, plan.recipe.key));
      if (!still) return { key, ok: true, changed: true };
      if (Date.now() > deadline) throw bridgeError("LOCK_UNCONFIRMED", "已请求重新上锁，但配方仍显示为已解锁，请在游戏中确认");
      await JB.delay(100);
    }
  }

  Object.assign(ex, {
    // `made` (blueprints an older version of this tool put in together with the unlock) goes back with it
    lockRecipes: rpcSafe(async (keys, made) => {
      const list = asList(keys).map(String);
      const madeList = made ? asList(made) : [];
      if (list.length > 30 || (!list.length && !madeList.length)) throw bridgeError("BAD_SELECTION", "一次需要选择 1–30 项");
      // the blueprints go first: a later failure must not leave them behind
      const blueprints = madeList.length && JB.gearDropMade ? await onMain(() => JB.gearDropMade(madeList)) : [];
      const results = [];
      for (const key of list) {
        try {
          results.push(await lockRecipe(key));
        } catch (e) {
          results.push({ key, ok: false, changed: false, error: e.message, code: e.code || "GAME_ERROR" });
          if (FATAL.has(e.code)) break;
        }
      }
      return { results, blueprints, changed: results.filter((x) => x.changed).length, failed: results.filter((x) => !x.ok).length };
    }),

    // all crafting recipes with localized names, category and unlock state
    recipes: rpcSafe(async () => {
      const failed = await ensureLoaded("craftable", CRAFTABLE);
      return onMain(() => {
        requireProfile();
        return { recipes: recipeRows(), failed };
      });
    }),

    ships: rpcSafe(async () => {
      const failed = await ensureLoaded("shipBlueprint", SHIP);
      return onMain(() => {
        requireProfile();
        return { ships: shipRows(), failed };
      });
    }),

    unlockRecipes: rpcSafe((keys) => unlockBatch("recipe", keys)),
    unlockShips: rpcSafe((keys) => unlockBatch("ship", keys)),
  });
}

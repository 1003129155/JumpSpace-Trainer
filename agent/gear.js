// Gear: the weapons, melee weapons and ship parts that have attributes — a tier (Common green, Rare blue, Epic purple,
// Legendary red), modules ("词条") and a level — the things the game's item generator makes and a blueprint remembers.
// This is the game side of everything that makes gear with chosen attributes:
//   gearEdit / itemEdit   the backend of the attribute editor: builds the item in memory (nothing is recorded) and reports
//                         what the game makes of it (its own texts, the level cap, the modules that may go into each slot)
//   makeBlueprint         records such an item in the discovery history, or in a blueprint slot too
//   JB.gearAttachment     gives an item that is being spawned its attributes
// The rules of what may be combined are in gear_spec.js; what to do with a built item is decided in blueprint_flow.js.
import { makeBlueprint, removeMade, blueprintMessage, rarityIndex, RARITIES, STATUS, SETTLED } from "./blueprint_flow.js";
import { checkGear, buildMax, rollsFor, richToHtml, plainText } from "./gear_spec.js";

export function installGear(JB, ex) {
  const { U, onMain, safe, bridgeError, rpcSafe } = JB;
  const CRAFTABLE = "Keepsake.GameplayFeatures.Assembler.Craftable";
  const MPM = () => U.cls("Keepsake.MetaProgression.MetaProgressionManager");
  const HISTORY_MAX = 50; // the game keeps at most 50 entries in the discovery history and drops the oldest ones beyond that

  const guidOf = (o) => safe(() => o.method("get_AssetGUID").invoke().content, "");
  const isClone = (o) => U.name(o).endsWith("(Clone)");
  const stripClone = (s) => String(s).replace(/\(Clone\)$/, "");
  const asObject = (v) => (v && typeof v === "object" ? v : JSON.parse(String(v || "{}")));
  const asList = (v) => (Array.isArray(v) ? v : JSON.parse(String(v || "[]")));
  // the tier of the item to make: 0..3 (or its name); anything else is refused rather than guessed
  const tierArg = (value) => {
    const t = rarityIndex(value);
    if (t === null) throw bridgeError("BAD_RARITY", "品质只能是 普通 / 稀有 / 史诗 / 传说（0–3）");
    return t;
  };

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

  // the crafting recipes are Addressables that may not be in memory yet
  async function ensureLoaded() {
    const missing = await onMain(() => {
      const have = new Set(U.loaded(CRAFTABLE).map(guidOf));
      return JB.resourceIndex().entries.filter((e) => e.category === "craftable" && !have.has(e.key));
    });
    const failed = [];
    for (const e of missing) {
      try { await JB.loadCatalogAsset(e); } catch (err) { failed.push({ name: e.name, message: err.message }); }
    }
    return failed;
  }

  function requireProfile() {
    if (!safe(() => MPM().method("get_InitialDataSuccessfullyLoaded").invoke(), false)) {
      throw bridgeError("PROFILE_NOT_READY", "本机存档尚未加载完成，请先进入游戏（大厅或飞船内）再试");
    }
  }

  // ------------------------------------------------------------------- the models of gear
  // Weapons and ship parts have their blueprints in categories of kind "Blueprint". A model is whatever such a recipe
  // makes; the blueprint does not need the recipe to be unlocked.
  const isGearCategory = (cat) => !cat.isNull() && safe(() => String(cat.field("m_CategoryEntryKind").value), "") === "Blueprint";

  function describeGear(key, c, validTargets) {
    const cat = c.field("m_Category").value;
    if (!isGearCategory(cat)) return null;
    const target = c.field("m_CraftableObject").value;
    const targetGuid = target.isNull() ? null : safe(() => target.field("m_AssetGUID").value.content, null);
    if (!targetGuid || !validTargets.has(targetGuid)) return null; // the game cannot generate it
    const name = stripClone(U.name(c));
    return {
      key,
      name,
      display: safe(() => c.method("get_DisplayName").invoke().content, "") || name,
      category: safe(() => cat.method("get_DisplayName").invoke().content, ""),
      categoryGuid: guidOf(cat),
      targetGuid,
      targetName: stripClone(U.name(target)),
      cost: safe(() => c.field("m_MateriaCraftCost").value, 0),
      template: target, // the game object that gets crafted; stays inside the agent
    };
  }

  const validTargets = () => new Set(JB.resourceIndex().entries.filter((e) => e.category === "pickup" || e.category === "cargo").map((e) => e.key));

  function gearRecipes() {
    const valid = validTargets();
    const out = [];
    for (const [key, c] of uniqueByGuid(U.loaded(CRAFTABLE))) {
      const row = describeGear(key, c, valid);
      if (row) out.push(row);
    }
    return out;
  }

  function findGearRecipe(key) {
    const c = uniqueByGuid(U.loaded(CRAFTABLE)).get(key);
    return c ? describeGear(key, c, validTargets()) : null;
  }

  // an item of the catalog as a model of gear (the editor of the items page works on these)
  function itemEntity(it) {
    return {
      key: it.name, name: it.name, display: it.display, category: it.category === "cargo" ? "飞船部件" : "物品",
      targetGuid: safe(() => it.d.field("m_AssetGUID").value.content, ""), categoryGuid: "", template: it.d,
    };
  }

  // ------------------------------------------------------------------- the game's blueprint book
  const savedBlueprints = () => JB.managedRows(MPM().method("get_Blueprints").invoke(), (b) => b);
  const historyEntries = () => JB.managedRows(MPM().method("get_BlueprintHistory").invoke(), (e) => e);
  const dataOf = (b) => b.field("m_GeneratedData").value;

  // slot usage per blueprint category, as the game counts it
  function slotUsage(categoryGuid) {
    const total = safe(() => MPM().method("GetBlueprintCapacity").invoke(Il2Cpp.string(categoryGuid)), 0);
    const used = savedBlueprints().filter((b) => b.field("m_CategoryGuid").value.content === categoryGuid).length;
    return { used, total };
  }

  // ---------------------------------------------------- the game side of an item
  // The adapter blueprint_flow.js and the editor work through. Everything runs on the main thread; objects created here
  // are pinned until release() so the garbage collector cannot take them mid-way.
  function gearGame() {
    const M = MPM();
    const pins = [];
    const holds = [];
    const keep = (o) => { pins.push(o.ref(false)); return o; };
    const str = (s) => Il2Cpp.string(s);
    const ItemRarity = () => U.cls("Keepsake.GeneratedItems.ItemRarity");
    const tierObj = (i) => { const m = Memory.alloc(8); m.writeS32(i); holds.push(m); return new Il2Cpp.ValueType(m, ItemRarity().type); };
    const templates = new Map();
    const pinned = (entity) => { if (!templates.has(entity.targetGuid)) templates.set(entity.targetGuid, keep(entity.template)); return templates.get(entity.targetGuid); };
    const moduleCount = (item) => { const arr = item.field("m_Modules").value; return arr.isNull() ? 0 : arr.length; };

    return {
      // An item of the model at the given tier (0 Common .. 3 Legendary) from the game's own item generator
      // (modules rolled the way loot is). The same seed gives the same modules again.
      generate(entity, tier = 0, seed = null) {
        const template = pinned(entity);
        const kind = U.cls("CargobayItem_Base_Data").isAssignableFrom(template.class) ? "CargobayItem_Base_Data"
          : U.cls("Keepsake.PickupableItem_Data").isAssignableFrom(template.class) ? "Keepsake.PickupableItem_Data" : null;
        const generate = kind && U.cls("Keepsake.GeneratedItems.ItemGenerator").methods
          .find((m) => m.name === "Generate" && m.parameters.length === 4 && m.parameters[0].type.name === kind);
        if (!generate) throw bridgeError("GEAR_UNSUPPORTED", "这件物品不支持属性");
        // Nullable<ItemRarity> built in plain memory (boxing a Nullable would give a boxed ItemRarity, and the bridge
        // cannot set an enum field from a number): hasValue = true, the tier written at the value field's offset
        const nullable = Il2Cpp.corlib.class("System.Nullable`1").inflate(ItemRarity());
        const mem = Memory.alloc(Math.max(nullable.valueTypeSize, 8));
        mem.writeU64(0);
        const forced = new Il2Cpp.ValueType(mem, nullable.type);
        forced.field("hasValue").value = true;
        mem.add(nullable.field("value").offset - 0x10).writeS32(tier); // field offsets of a value type include the object header
        const rng = keep(Il2Cpp.corlib.class("System.Random").alloc());
        rng.method(".ctor", 1).invoke(Number.isInteger(seed) ? seed : Math.floor(Math.random() * 0x7fffffff));
        const result = generate.invoke(template, 1, rng, forced);
        holds.push(mem, forced, result); // the item below points into `result`'s memory
        if (!result.field("hasValue").value) return null;
        const item = result.field("value").value;
        holds.push(item);
        return item;
      },

      // The generator's number of modules depends on its seed for some models (a Legendary reactor has anything from one
      // to four). The first look at an item should be a full one: of `tries` seeds from `start`, the one with most modules.
      bestSeed(entity, tier, start, tries = 32) {
        let best = { seed: start, count: -1 };
        for (let i = 0; i < tries; i++) {
          const seed = (start + i) % 2147483647;
          const item = this.generate(entity, tier, seed);
          if (!item) break;
          const count = moduleCount(item);
          if (count > best.count) best = { seed, count };
        }
        return best.seed;
      },

      // ---- modules ("词条") -------------------------------------------------------------------------------
      // every module the generator can give this model: the template's own base set plus the school pools the game
      // finds relevant for it (checked against 160 generated items: nothing else ever appears)
      moduleCatalog(entity) {
        const gen = U.cls("Keepsake.GeneratedItems.ItemGenerator");
        const found = new Map();
        const base = safe(() => entity.template.field("m_BaseModuleSet").value, null);
        // where a module may sit: a school module inside its own rarity range; a base-set module at any tier (the
        // generator hands those out above their own range, and even at tiers the set lists as excluded when the tier is
        // forced - the rule here is "whatever the game's own generator produces")
        const allow = (row) => { row.allowed = RARITIES.map((_, r) => (row.school && r >= row.minRarity && r <= row.maxRarity) || row.base); };
        const add = (m, fromBase) => {
          const guid = guidOf(m);
          if (!guid) return;
          let row = found.get(guid);
          if (!row) {
            const idx = (f) => RARITIES.indexOf(String(m.field(f).value));
            row = {
              mod: m, guid, base: false, school: false,
              name: safe(() => m.method("get_DisplayName").invoke().content, guid.slice(0, 8)),
              minRarity: idx("m_MinRarity"), maxRarity: idx("m_MaxRarity"),
              instigator: !!safe(() => m.field("m_IsInstigator").value, false),
              maxLevel: RARITIES.map((_, r) => Math.max(1, safe(() => m.method("GetMaxUpgradeLevel").invoke(tierObj(r)), 1))),
              rolls: RARITIES.map((_, r) => safe(() => JB.managedRows(m.method("GetTweakableValuesForRarity").invoke(tierObj(r)), (x) => x).length, 0)),
            };
            found.set(guid, row);
          }
          if (fromBase) row.base = true; else row.school = true;
          allow(row);
        };
        for (const school of U.loaded("Keepsake.HyperSpace.System.Modifiers.ItemModule.ItemModuleSchool")) {
          const pool = safe(() => gen.method("GetPoolForSchool").invoke(school), null);
          const relevant = pool && safe(() => gen.method("GetRelevantModules").invoke(str(entity.targetGuid), pool), null);
          if (relevant) for (const m of JB.managedRows(relevant, (x) => x)) add(m, false);
        }
        const baseList = base && safe(() => base.field("m_Modules").value, null);
        if (baseList && !baseList.isNull()) for (const m of JB.managedRows(baseList, (x) => x)) add(m, true);
        return found;
      },

      // An item of spec.tier, shaped by `spec` (see gear_spec.js), built in memory only. No slots in the spec: the
      // generator's own modules are kept (the editor's first look). Returns null when the generator gives nothing, else
      // { item, errors, catalog, spec, evaluation } where `item` is only good to record when `errors` is empty.
      buildGear(entity, spec) {
        const catalog = this.moduleCatalog(entity);
        const tier = Number.isInteger(spec.tier) ? spec.tier : 0;
        const seed = Number.isInteger(spec.seed) ? spec.seed : Math.floor(Math.random() * 0x7fffffff);
        const item = this.generate(entity, tier, seed);
        if (!item) return null;
        const GM = U.cls("Keepsake.GeneratedItems.GeneratedModule");
        const rarityOffset = GM.field("m_Rarity").offset - 0x10; // field offsets of a value type include the object header
        const mods = U.list(item.field("m_Modules").value);
        const floatArray = (values) => {
          const arr = Il2Cpp.array(Il2Cpp.corlib.class("System.Single"), values.length);
          pins.push(arr.object.ref(false));
          values.forEach((v, j) => arr.set(j, v));
          return arr;
        };
        const generated = mods.map((gm) => {
          const rolls = gm.field("m_BaseValueRolls").value;
          return { guid: gm.field("m_ModuleGuid").value.content, rarity: RARITIES.indexOf(String(gm.field("m_Rarity").value)), level: gm.field("m_UpgradeLevel").value, roll: rolls.isNull() ? [] : U.list(rolls) };
        });
        const asked = Array.isArray(spec.slots) ? { ...spec, tier, seed } : { ...spec, tier, seed, slots: generated };
        const rules = { slotCount: mods.length, modules: catalog };
        const fail = (errors, cap) => ({ item, errors, catalog, spec: asked, evaluation: { errors, cap: cap ?? null, need: null, level: null, slots: [] } });

        // first the modules (the level cap depends on them), then the cap, then levels
        const first = checkGear(asked, { ...rules, cap: null });
        if (first.errors.length) return fail(first.errors);
        first.slots.forEach((slot, i) => {
          const gm = mods[i];
          gm.field("m_ModuleGuid").value = str(slot.guid);
          gm.handle.add(rarityOffset).writeS32(slot.rarity);
          gm.field("m_UpgradeLevel").value = 1;
          gm.field("m_BaseValueRolls").value = floatArray(rollsFor(slot, slot.rollCount, seed, i));
        });
        const cap = item.method("EffectiveMaxLevel").invoke();
        const last = checkGear(asked, { ...rules, cap });
        if (last.errors.length) return fail(last.errors, cap);
        last.slots.forEach((slot, i) => { mods[i].field("m_UpgradeLevel").value = slot.level; });
        item.field("m_Level").value = last.level;

        const slotsOut = last.slots.map((slot, i) => {
          const info = catalog.get(slot.guid);
          const gm = mods[i];
          const rolls = gm.field("m_BaseValueRolls").value;
          const rich = safe(() => info.mod.method("GetLocalizedDescription").invoke(tierObj(slot.rarity), slot.level, rolls).content, "");
          return {
            guid: slot.guid, name: info.name, rarity: slot.rarity, level: slot.level, maxLevel: info.maxLevel[slot.rarity],
            instigator: info.instigator, base: info.base, rolls: rolls.isNull() ? [] : U.list(rolls).map((x) => Math.round(x * 1000) / 1000),
            html: richToHtml(rich), text: plainText(rich),
          };
        });
        return { item, errors: [], catalog, spec: asked, evaluation: { errors: [], cap, need: last.need, level: last.level, slots: slotsOut } };
      },

      // ---- the blueprint book -----------------------------------------------------------------------------
      slots(categoryGuid) {
        const { used, total } = slotUsage(categoryGuid);
        let free = null;
        for (let s = 0; s < total && free === null; s++) {
          if (M.method("GetBlueprintInSlot").invoke(str(categoryGuid), s).isNull()) free = s;
        }
        return { used, total, free };
      },
      historyHas: (guid) => historyEntries().some((e) => dataOf(e).field("m_Guid").value.content === guid),
      historyEntry(guid) {
        for (const e of historyEntries()) {
          const d = dataOf(e);
          if (d.field("m_Guid").value.content === guid) return { item: d };
        }
        return null;
      },
      guidOf: (item) => item.field("m_Guid").value.content,
      describe: (item) => ({ level: item.field("m_Level").value, rarity: String(item.field("m_Rarity").value) }),
      // the game only keeps blueprints of items it has "found": record the item in the discovery history first
      recordFound: (item, categoryGuid) => M.method("AddToBlueprintHistory").invoke(item, str(categoryGuid), false),
      canSave: (item) => !!M.method("CanScanItem").invoke(item),
      saveInSlot: (item, categoryGuid, slot) => !!M.method("TrySetBlueprintInSlot").invoke(item, str(categoryGuid), slot),
      forget: (item) => !!M.method("RemoveBlueprintHistoryEntryByItem").invoke(item),
      inSlot(categoryGuid, slot) {
        const b = M.method("GetBlueprintInSlot").invoke(str(categoryGuid), slot);
        return b.isNull() ? null : { guid: dataOf(b).field("m_Guid").value.content };
      },
      blueprintByGuid(guid) {
        for (const b of savedBlueprints()) {
          const d = dataOf(b);
          if (d.field("m_Guid").value.content === guid) return { handle: b, level: d.field("m_Level").value, rarity: String(d.field("m_Rarity").value) };
        }
        return null;
      },
      removeBlueprint: (b) => !!M.method("RemoveBlueprint").invoke(b),

      release() {
        for (const p of pins.splice(0)) { try { p.free(); } catch (e) { /* already gone */ } }
        holds.length = 0;
        templates.clear();
      },
    };
  }

  // what this tool put in, as [{guid, where: "slot"|"history", level, rarity}]
  const dropMade = (made) => {
    if (!made.length) return [];
    const game = gearGame();
    try { return removeMade(game, made); } finally { game.release(); }
  };

  // ---------------------------------------------------------------- the editor's backend
  // `given`: the editor's spec. action "preview": the generator's own item of spec.tier (spec.seed picks which: the one
  // of a few seeds with most modules); "evaluate": the spec as given; "max": every module at its best rarity and roll, and
  // every upgrade the item's level cap pays for. Rule violations come back in `evaluation.errors` for the editor to show,
  // they are not failures of the call.
  function editGear(entity, given, action) {
    const tier = tierArg(given.tier);
    const game = gearGame();
    try {
      const edit = { ...given, tier };
      if (action === "preview") {
        delete edit.slots;
        delete edit.level;
        edit.seed = game.bestSeed(entity, tier, Number.isInteger(given.seed) ? given.seed : Math.floor(Math.random() * 2000000000));
      }
      let built = game.buildGear(entity, edit);
      if (!built) throw bridgeError("NO_ITEM", "游戏没能生成这件装备");
      if (action === "max" && !built.errors.length) built = buildMax((s) => game.buildGear(entity, s), built);
      const out = { model: { key: entity.key, display: entity.display, category: entity.category }, spec: built.spec, evaluation: built.evaluation };
      // the list of modules does not change while an item is edited: only the first look needs it
      if (action === "preview") out.modules = [...built.catalog.values()].map(({ mod, ...row }) => row).sort((a, b) => a.name.localeCompare(b.name, "zh"));
      return out;
    } finally {
      game.release();
    }
  }

  const resolveCatalogItem = (name) => {
    try { return JB.resolveItem(name); } catch (e) { throw bridgeError("ITEM_NOT_FOUND", e.message); }
  };

  // ---------------------------------------------------------------- what spawning an item needs
  // The attributes of an item that is being created. Every copy gets a fresh generated item (its own guid) built from the
  // same spec, set on the new pickup before the player can touch it.
  JB.gearAttachment = (it, spec) => {
    const given = asObject(spec);
    const tier = tierArg(given.tier);
    const entity = itemEntity(it);
    const build = (game) => {
      const built = game.buildGear(entity, { ...given, tier });
      if (!built) throw bridgeError("GEAR_UNSUPPORTED", `「${it.display}」不支持属性，请关闭“自定义属性”`);
      if (built.errors.length) throw bridgeError("GEAR_INVALID", `属性不符合游戏规则：${built.errors.join("；")}`);
      return built;
    };
    return {
      // main thread: can the item carry these attributes? (nothing is spawned yet)
      check() {
        const game = gearGame();
        try { const b = build(game); return { tier, level: b.evaluation.level, modules: b.evaluation.slots.length }; } finally { game.release(); }
      },
      // main thread: set a fresh generated item on a pickup that was just created
      apply(persistent) {
        const game = gearGame();
        try {
          const b = build(game);
          persistent.method("get_PickupableBlackboardData").invoke().field("m_GeneratedItem").value.method("set_Value").invoke(b.item);
        } finally { game.release(); }
      },
    };
  };

  // the guids of everything that has a blueprint recipe: the items that carry attributes
  JB.gearTargets = async () => {
    await ensureLoaded();
    return onMain(() => new Set(gearRecipes().map((r) => r.targetGuid)));
  };
  JB.gearDropMade = dropMade;

  Object.assign(ex, {
    // the models of gear for the blueprint page, with the blueprint slots and the discovery history
    gearList: rpcSafe(async () => {
      const failed = await ensureLoaded();
      return onMain(() => {
        requireProfile();
        const rows = gearRecipes();
        const cats = new Map();
        for (const r of rows) if (!cats.has(r.categoryGuid)) cats.set(r.categoryGuid, { guid: r.categoryGuid, name: r.category, slots: slotUsage(r.categoryGuid) });
        return { gear: rows.map(({ template, ...row }) => row), categories: [...cats.values()], history: { count: historyEntries().length, max: HISTORY_MAX }, failed };
      });
    }),

    gearEdit: rpcSafe(async (key, spec, action) => {
      const given = asObject(spec);
      tierArg(given.tier);
      await ensureLoaded();
      return onMain(() => {
        const recipe = findGearRecipe(String(key));
        if (!recipe) throw bridgeError("RECIPE_NOT_FOUND", "没有找到这件装备，请刷新列表");
        return editGear(recipe, given, action);
      });
    }),

    itemEdit: rpcSafe(async (name, spec, action) => {
      const given = asObject(spec);
      tierArg(given.tier);
      return onMain(() => editGear(itemEntity(resolveCatalogItem(name)), given, action));
    }),

    // A blueprint with the attributes of `spec`: recorded in the discovery history, or saved into a free slot too.
    // Whether the recipe is unlocked does not matter, and a model may have any number of blueprints.
    makeBlueprint: rpcSafe(async (key, mode, spec) => {
      const given = asObject(spec);
      const tier = tierArg(given.tier);
      const save = mode === "slot";
      await ensureLoaded();
      return onMain(() => {
        requireProfile();
        const recipe = findGearRecipe(String(key));
        if (!recipe) throw bridgeError("RECIPE_NOT_FOUND", "没有找到这件装备，请刷新列表");
        const r = makeBlueprint(gearGame(), recipe, { save, spec: { ...given, tier } });
        const message = blueprintMessage(r, recipe);
        if (!SETTLED.has(r.status)) throw bridgeError("BLUEPRINT_" + r.status.toUpperCase(), message);
        return { blueprint: { ...r, message }, message };
      });
    }),

    // undo for makeBlueprint: take back what it put in (unless the player has changed it since)
    removeRecipeBlueprints: rpcSafe(async (made) => {
      const list = asList(made);
      if (!list.length) throw bridgeError("NOTHING_SELECTED", "没有需要移除的蓝图");
      const blueprints = await onMain(() => { requireProfile(); return dropMade(list); });
      return { blueprints, changed: blueprints.filter((b) => b.removed).length };
    }),
  });

  // development tools reach the pieces below through this hook (see snippets/live_unlocks.py); nothing else defines it
  if (typeof ex.__expose === "function") ex.__expose({ gearGame, gearRecipes, findGearRecipe, itemEntity, slotUsage, dropMade, editGear, historyEntries, savedBlueprints });
}

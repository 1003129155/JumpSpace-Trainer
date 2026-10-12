// Unit tests for the feature modules in agent/*.js, run against a small fake of the
// game object model (no game, no Frida). Run with: npm test
import assert from "node:assert/strict";
import { test } from "node:test";

import { installProgression } from "../agent/progression.js";
import { installCheats } from "../agent/cheats.js";
import { installUnlocks } from "../agent/unlocks.js";
import { installGear } from "../agent/gear.js";
import { installItems } from "../agent/items.js";
import { fake, str, baseJB, call } from "./helpers.mjs";

// --------------------------------------------------------------- progression
function progressionWorld({ ready = true, credits = 1000, max = 5000, materia = { amount: 20, max: 250 } } = {}) {
  const state = { credits, sets: 0, saves: 0, materia: { ...materia }, level: 2, exp: 100, needed: 1000, xpAdds: [], refuseXp: false };
  const currency = fake({}, {
    m_AssetGUID: str("guid-credits"),
    m_DisplayName: fake({ GetLocalizedString: str("信用点") }),
    m_CurrencyGroup: "Credits",
    m_MaxAmount: max,
    m_Color: fake({}, { r: 1, g: 0.5, b: 0 }),
  });
  const ingots = fake({ get_Count: 0 });
  const manager = fake({
    get_InitialDataSuccessfullyLoaded: () => ready,
    get_CreditsCurrency: () => currency,
    get_IngotCurrencies: () => ingots,
    GetCurrency: () => state.credits,
    SetCurrency: (c, n) => { state.credits = n; state.sets++; },
    SaveDataToCloud: () => { state.saves++; },
    get_Level: () => fake({ get_Value: () => state.level }),
    get_Experience: () => fake({ get_Value: () => state.exp }),
    get_ExperienceToNextLevel: () => state.needed,
    get_PlayerRankString: str("幸存者"),
    GetExperienceToNextLevelFrom: () => state.needed,
    AddExperience: (n) => {
      state.xpAdds.push(n);
      if (state.refuseXp) return; // e.g. already at the maximum level
      state.exp += n;
      if (state.exp >= state.needed) { state.level++; state.exp -= state.needed; }
    },
  });
  const materiaClass = fake({
    get_GetShipMateriaAmount: () => state.materia.amount,
    get_GetMaxMateria: () => state.materia.max,
  });
  const controller = fake({
    get_NetworkObject: fake({ get_IsSpawned: true }),
    ModifyMateria: (d) => { state.materia.amount += d; },
  });
  const U = {
    cls: (name) => (name.endsWith("MetaProgressionManager") ? manager : materiaClass),
    name: () => "Currency_Credits",
    all: () => [controller],
  };
  return { state, JB: baseJB({ U }) };
}

test("setCurrency clamps to the game's maximum and reads the value back", async () => {
  const { JB, state } = progressionWorld({ credits: 100, max: 5000 });
  const ex = {};
  installProgression(JB, ex);
  const r = await call(ex, "setCurrency", "guid-credits", "999999");
  assert.equal(r.ok, true);
  assert.equal(state.credits, 5000);
  assert.equal(r.clamped, true);
  assert.equal(r.before, 100);
  assert.equal(r.after, 5000);
  assert.equal(state.sets, 1);
});

test("addCurrency never goes below zero and skips the write when nothing changes", async () => {
  const { JB, state } = progressionWorld({ credits: 50 });
  const ex = {};
  installProgression(JB, ex);
  let r = await call(ex, "addCurrency", "guid-credits", "-500");
  assert.equal(state.credits, 0);
  assert.equal(r.clamped, true);
  const writes = state.sets;
  r = await call(ex, "addCurrency", "guid-credits", "-10"); // already 0
  assert.equal(r.changed, false);
  assert.equal(state.sets, writes);
});

test("currency edits reject non-integers, unknown currencies and a missing profile", async () => {
  const ex = {};
  installProgression(progressionWorld().JB, ex);
  assert.equal((await call(ex, "setCurrency", "guid-credits", "12.5")).error.code, "INVALID_AMOUNT");
  assert.equal((await call(ex, "setCurrency", "guid-credits", "abc")).error.code, "INVALID_AMOUNT");
  assert.equal((await call(ex, "setCurrency", "no-such-guid", "5")).error.code, "CURRENCY_NOT_FOUND");
  const ex2 = {};
  installProgression(progressionWorld({ ready: false }).JB, ex2);
  assert.equal((await call(ex2, "setCurrency", "guid-credits", "5")).error.code, "PROFILE_NOT_READY");
});

test("progression snapshot reports localized names and the game's colour", async () => {
  const ex = {};
  installProgression(progressionWorld().JB, ex);
  const r = await call(ex, "progression");
  assert.equal(r.currencies[0].display, "信用点");
  assert.equal(r.currencies[0].color, "#ff8000");
  assert.deepEqual(r.materia, { amount: 20, max: 250 });
});

test("levelUp adds exactly the experience needed for each requested level", async () => {
  const { JB, state } = progressionWorld();
  const ex = {};
  installProgression(JB, ex);
  const r = await call(ex, "levelUp", "2");
  assert.equal(r.ok, true);
  assert.equal(r.before.level, 2);
  assert.equal(r.after.level, 4);
  assert.deepEqual(state.xpAdds, [900, 1000]);
  assert.equal(r.added, 1900);
  assert.equal(r.saveRequested, true);
});

test("levelUp stops instead of looping when the game refuses to level", async () => {
  const { JB, state } = progressionWorld();
  const ex = {};
  installProgression(JB, ex);
  state.refuseXp = true;
  const r = await call(ex, "levelUp", "5");
  assert.equal(r.ok, true);
  assert.equal(r.after.level, r.before.level);
  assert.equal(state.xpAdds.length, 1); // one attempt, then it gives up
  assert.equal((await call(ex, "levelUp", "11")).error.code, "INVALID_AMOUNT");
  assert.equal((await call(ex, "levelUp", "0")).error.code, "INVALID_AMOUNT");
});

test("ship materia edits are clamped to 0..max", async () => {
  const { JB, state } = progressionWorld();
  const ex = {};
  installProgression(JB, ex);
  let r = await call(ex, "setMateria", "9999");
  assert.equal(state.materia.amount, 250);
  assert.equal(r.clamped, true);
  r = await call(ex, "addMateria", "-9999");
  assert.equal(state.materia.amount, 0);
});

// -------------------------------------------------------------------- cheats
function cheatWorld() {
  const s = { invulnerable: false, health: 40, maxHealth: 100, shield: 3, maxShield: 25, dead: false, ammo: 10, maxAmmo: 440, inMag: 2, mag: 28 };
  const hc = fake({
    get_IsInvulnerable: () => s.invulnerable,
    set_IsInvulnerable: (v) => { s.invulnerable = v; },
    get_IsDead: () => s.dead,
    get_Health: () => s.health, get_MaxHealth: () => s.maxHealth, SetHealth: (v) => { s.health = v; },
    get_Shield: () => s.shield, get_MaxShieldLevel: () => s.maxShield, SetShield: (v) => { s.shield = v; },
  });
  const inMag = fake({ get_Value: () => s.inMag, set_Value: (v) => { s.inMag = v; } });
  const bb = fake({}, { m_MagSize: fake({ get_Value: () => s.mag }), m_AmmoInMag: inMag });
  const weapon = fake({ get_Ammo: () => s.ammo, set_Ammo: (v) => { s.ammo = v; } }, { m_PersistentPickupable: fake({}, { m_PickupableItemBlackboardData: bb }) });
  const player = fake({ get_CurrentPlayerSettings: () => ({ isNull: () => true }) }, {
    m_ItemInstantiator: fake({}, { m_FirstPersonItem: weapon }),
    m_ItemHandler: fake({ get_MaxAmmo: () => s.maxAmmo }),
  });
  s.debugSettings = { value: false }; // the debug settings' m_GodMode field: written through, so the object is shared
  const debugSettings = { isNull: () => false, field: () => s.debugSettings };
  const debugClass = fake({ get_Settings: () => debugSettings });
  const JB = baseJB({ localPlayer: () => player, healthOf: () => hc, U: { cls: (name) => (name === "Keepsake.PlayerDebugSettings" ? debugClass : fake()), all: () => [], name: () => "" } });
  return { s, JB };
}

test("god mode keeps the invulnerable flag on and restores it when switched off", async () => {
  const { s, JB } = cheatWorld();
  const ex = {};
  installCheats(JB, ex);
  await call(ex, "setCheat", "god", "true");
  JB._tickers.get("cheat:god").fn();
  assert.equal(s.invulnerable, true);
  await call(ex, "setCheat", "god", "false");
  assert.equal(s.invulnerable, false);
  assert.equal(JB._tickers.has("cheat:god"), false);
});

test("god mode also sets the game's debug god flag (a full radiation bar downs the character past IsInvulnerable) and puts the old value back", async () => {
  const { s, JB } = cheatWorld();
  const ex = {};
  installCheats(JB, ex);
  assert.equal(s.debugSettings.value, false);
  await call(ex, "setCheat", "god", "true");
  JB._tickers.get("cheat:god").fn();
  assert.equal(s.debugSettings.value, true);
  await call(ex, "setCheat", "god", "false");
  assert.equal(s.debugSettings.value, false);

  // a flag that was already on before the cheat is left on afterwards
  s.debugSettings.value = true;
  await call(ex, "setCheat", "god", "true");
  JB._tickers.get("cheat:god").fn();
  await call(ex, "setCheat", "god", "false");
  assert.equal(s.debugSettings.value, true);
});

test("heal lock tops up health and shield, and leaves a dead character alone", async () => {
  const { s, JB } = cheatWorld();
  const ex = {};
  installCheats(JB, ex);
  await call(ex, "setCheat", "heal", "true");
  s.dead = true;
  JB._tickers.get("cheat:heal").fn();
  assert.equal(s.health, 40);
  s.dead = false;
  JB._tickers.get("cheat:heal").fn();
  assert.equal(s.health, 100);
  assert.equal(s.shield, 25);
});

test("ammo lock fills magazine and reserve only when they are below max", async () => {
  const { s, JB } = cheatWorld();
  const ex = {};
  installCheats(JB, ex);
  await call(ex, "setCheat", "ammo", "true");
  JB._tickers.get("cheat:ammo").fn();
  assert.equal(s.inMag, 28);
  assert.equal(s.ammo, 440);
});

test("ship god mode keeps the ship's own god-mode flag on while a ship exists and clears it when switched off", async () => {
  const { JB } = cheatWorld();
  const s = { godmode: false, ships: [] };
  const flag = fake({ get_Value: () => s.godmode, set_Value: (v) => { s.godmode = v; } });
  const dc = fake({}, { m_Ship_StateBlackboardData: fake({}, { m_Godmode: flag }) });
  JB.U = { cls: () => fake({ op_Implicit: () => true }), all: (name) => (name === "Playership_DamageController" ? s.ships : []), name: () => "" };
  const ex = {};
  installCheats(JB, ex);
  await call(ex, "setCheat", "ship", "true");
  JB._tickers.get("cheat:ship").fn(); // no ship in the scene (lobby): nothing to do
  assert.equal(s.godmode, false);
  s.ships = [dc];
  const realNow = Date.now;
  Date.now = () => realNow() + 5000; // past the rescan pause
  try { JB._tickers.get("cheat:ship").fn(); } finally { Date.now = realNow; }
  assert.equal(s.godmode, true);
  await call(ex, "setCheat", "ship", "false");
  assert.equal(s.godmode, false);
});

test("unlimited revives keep the ship's count of used respawns at zero", async () => {
  const { JB } = cheatWorld();
  const s = { used: 2 };
  const used = fake({ get_Value: () => s.used, set_Value: (v) => { s.used = v; } });
  const dc = fake({}, { m_Ship_StateBlackboardData: fake({}, { m_PlayerRespawns: used }) });
  JB.U = { cls: () => fake({ op_Implicit: () => true }), all: (name) => (name === "Playership_DamageController" ? [dc] : []), name: () => "" };
  const ex = {};
  installCheats(JB, ex);
  await call(ex, "setCheat", "revive", "true");
  JB._tickers.get("cheat:revive").fn();
  assert.equal(s.used, 0);
  s.used = 1;
  assert.equal((await call(ex, "cheatOnce", "revive")).ok, true);
  assert.equal(s.used, 0);
});

test("solo doors keep a shield's required players at one and put the rule's number back when switched off", async () => {
  const { JB } = cheatWorld();
  const shield = (n, alive = true) => {
    const s = { n, alive };
    const required = fake({ get_Value: () => s.n, set_Value: (v) => { s.n = v; } });
    const c = fake({}, { m_InteractionBlackboardData: fake({}, { m_RequiredPlayersInTotal: required }) });
    c._s = s;
    return c;
  };
  const all = shield(4);
  const one = shield(1);
  const gone = shield(3, false);
  JB.U = {
    cls: () => fake({ op_Implicit: (o) => o._s.alive }),
    all: (name) => (name === "Keepsake.BlockingShield.MateriagunInteractionController" ? [all, one, gone] : []),
    name: () => "",
  };
  const ex = {};
  installCheats(JB, ex);
  await call(ex, "setCheat", "solo", "true");
  JB._tickers.get("cheat:solo").fn();
  assert.deepEqual([all._s.n, one._s.n, gone._s.n], [1, 1, 3]);
  await call(ex, "setCheat", "solo", "false");
  assert.deepEqual([all._s.n, one._s.n, gone._s.n], [4, 1, 3]);
});

test("legendary loot sets the loot rarity to Legendary while on and gives the game's own roll back when off", async () => {
  const { JB } = cheatWorld();
  const calls = [];
  JB.lootRarity = { set: (r) => calls.push(r) };
  const ex = {};
  installCheats(JB, ex);
  await call(ex, "setCheat", "legendary", "true");
  JB._tickers.get("cheat:legendary").fn();
  assert.deepEqual(calls, [3]);
  await call(ex, "setCheat", "legendary", "false");
  assert.deepEqual(calls, [3, null]);
});

test("unknown cheats are rejected and the summary reflects what is on", async () => {
  const { JB } = cheatWorld();
  const ex = {};
  installCheats(JB, ex);
  assert.equal((await call(ex, "setCheat", "fly", "true")).error.code, "UNKNOWN_CHEAT");
  await call(ex, "setCheat", "ammo", "true");
  assert.deepEqual({ ...JB.cheatSummary() }, { god: false, heal: false, ammo: true, ship: false, revive: false, solo: false, legendary: false, damage: false, spread: false, recoil: false, repair: false, shipspeed: false, shipturn: false, shipboost: false, materia: false, speed: false, jump: false });
  JB._disposers.forEach((d) => d());
  assert.equal(JB.cheatSummary().ammo, false);
});

// ------------------------------------------------------------------- unlocks
function unlockWorld(handler) {
  const ex = { unlockBlueprint: handler, unlockShip: handler };
  const JB = baseJB({ U: { cls: () => fake(), loaded: () => [], name: () => "" } });
  installUnlocks(JB, ex);
  return { ex, JB };
}

test("batch unlock needs a selection, caps its size and continues after a normal failure", async () => {
  const seen = [];
  const { ex } = unlockWorld(async (key) => {
    seen.push(key);
    return JSON.stringify(key === "b" ? { ok: false, error: { code: "RECIPE_NO_TARGET", message: "no target" } } : { ok: true, changed: true });
  });
  assert.equal((await call(ex, "unlockRecipes", [])).error.code, "NOTHING_SELECTED");
  assert.equal((await call(ex, "unlockRecipes", Array.from({ length: 31 }, (_, i) => String(i)))).error.code, "TOO_MANY");
  const r = await call(ex, "unlockRecipes", ["a", "b", "c"]);
  assert.deepEqual(seen, ["a", "b", "c"]);
  assert.equal(r.changed, 2);
  assert.equal(r.failed, 1);
});

test("batch unlock stops at a fatal error such as a missing profile", async () => {
  const seen = [];
  const { ex } = unlockWorld(async (key) => {
    seen.push(key);
    return JSON.stringify({ ok: false, error: { code: "PROFILE_NOT_READY", message: "not ready" } });
  });
  const r = await call(ex, "unlockShips", ["x", "y", "z"]);
  assert.deepEqual(seen, ["x"]);
  assert.equal(r.failed, 1);
});

// ------------------------------------------------------------ recipes and gear
// A recipe world: craftables (consumable or weapon/ship-part kind), the profile's unlocks, its saved blueprints and its
// discovery history (items found but not saved as blueprints yet).
function recipeWorld({ recipes, unlocked = [], saved = [], history = [], capacity = 4 }) {
  const state = { saved: saved.map((b) => ({ ...b })), history: history.map((h) => ({ ...h })), removed: [], forgotten: [] };
  const named = (o, name) => Object.assign(o, { __name: name });
  const cats = {};
  const craftables = recipes.map((r) => {
    cats[r.cat] = cats[r.cat] || fake({ get_DisplayName: str(r.catName), get_AssetGUID: str(r.cat) }, { m_CategoryEntryKind: r.kind === "blueprint" ? "Blueprint" : "Craftable" });
    return named(fake({ get_AssetGUID: str(r.key), get_DisplayName: str(r.display) }, {
      m_Category: cats[r.cat],
      m_CraftableObject: fake({}, { m_AssetGUID: str(r.target) }),
      m_MateriaCraftCost: r.cost || 30,
    }), "Craftable_" + r.key);
  });
  const rows = (items) => fake({ get_Count: () => items.length, get_Item: (i) => items[i] });
  const dataObject = (b) => fake({}, { m_TemplateGuid: str(b.template), m_Guid: str(b.guid), m_Level: b.level ?? 1, m_Rarity: b.rarity ?? "Common" });
  const blueprintObject = (b) => fake({}, { m_CategoryGuid: str(b.cat), m_SlotIndex: b.slot, m_GeneratedData: dataObject(b) });
  const historyObject = (h) => fake({}, { m_CategoryGuid: str(h.cat), m_GeneratedData: dataObject(h) });
  const manager = fake({
    get_InitialDataSuccessfullyLoaded: true,
    get_UnlockedCraftables: () => rows(craftables.filter((c) => unlocked.includes(c.method("get_AssetGUID").invoke().content))),
    get_Blueprints: () => rows(state.saved.map(blueprintObject)),
    get_BlueprintHistory: () => rows(state.history.map(historyObject)),
    GetBlueprintCapacity: () => capacity,
    GetBlueprintInSlot: (cat, slot) => { const b = state.saved.find((x) => x.cat === cat && x.slot === slot); return b ? blueprintObject(b) : { isNull: () => true }; },
    RemoveBlueprintHistoryEntryByItem: (item) => {
      const guid = item.field("m_Guid").value.content;
      const had = state.history.some((x) => x.guid === guid);
      state.history = state.history.filter((x) => x.guid !== guid);
      if (had) state.forgotten.push(guid);
      return had;
    },
    RemoveBlueprint: (b) => { const guid = b.field("m_GeneratedData").value.field("m_Guid").value.content; state.removed.push(guid); state.saved = state.saved.filter((x) => x.guid !== guid); return true; },
  });
  const managedRows = (collection, map) => { const out = []; const n = collection.method("get_Count").invoke(); for (let i = 0; i < n; i++) out.push(map(collection.method("get_Item").invoke(i))); return out; };
  const U = { cls: (name) => (name.endsWith("MetaProgressionManager") ? manager : fake()), loaded: () => craftables, name: (o) => o.__name || "" };
  const JB = baseJB({
    U, managedRows,
    resourceIndex: () => ({ entries: recipes.map((r) => ({ category: "pickup", key: r.target })) }),
    resolveItem: (name) => { throw new Error(`no item matches "${name}"`); },
  });
  const ex = {};
  installGear(JB, ex);
  installUnlocks(JB, ex);
  return { ex, JB, state };
}

const REACTORS = [
  { key: "r-fission", display: "裂变反应堆", cat: "cat-reactor", catName: "反应堆", kind: "blueprint", target: "tpl-fission" },
  { key: "r-scatter", display: "物质散射反应堆", cat: "cat-reactor", catName: "反应堆", kind: "blueprint", target: "tpl-scatter" },
  { key: "r-zero", display: "零波反应堆", cat: "cat-reactor", catName: "反应堆", kind: "blueprint", target: "tpl-zero" },
  { key: "r-extinguisher", display: "灭火器", cat: "cat-tools", catName: "维护", kind: "craftable", target: "tpl-ext" },
];
const FISSION_SAVED = { cat: "cat-reactor", slot: 0, template: "tpl-fission", guid: "bp-1" };
const ZERO_WAITING = { cat: "cat-reactor", template: "tpl-zero", guid: "found-zero", level: 1, rarity: "Common" };

test("the gear list is the weapons and ship parts, with the blueprint slots and the discovery history", async () => {
  const { ex } = recipeWorld({ recipes: REACTORS, saved: [FISSION_SAVED], history: [ZERO_WAITING] });
  const r = await call(ex, "gearList");
  assert.deepEqual(r.gear.map((g) => g.key).sort(), ["r-fission", "r-scatter", "r-zero"]); // no consumables
  const by = Object.fromEntries(r.gear.map((x) => [x.key, x]));
  assert.equal(by["r-zero"].display, "零波反应堆");
  assert.equal(by["r-zero"].category, "反应堆");
  assert.equal(by["r-zero"].categoryGuid, "cat-reactor");
  assert.equal(by["r-zero"].targetGuid, "tpl-zero");
  assert.ok(!("template" in by["r-zero"]), "game objects must not leave the agent");
  assert.deepEqual(r.categories, [{ guid: "cat-reactor", name: "反应堆", slots: { used: 1, total: 4 } }]);
  assert.deepEqual(r.history, { count: 1, max: 50 });
});

test("the gear list does not depend on what is unlocked or already saved", async () => {
  const keys = async (over) => (await call(recipeWorld({ recipes: REACTORS, ...over }).ex, "gearList")).gear.map((g) => g.key).sort();
  const bare = await keys({});
  assert.deepEqual(await keys({ unlocked: ["r-fission", "r-scatter", "r-zero"], saved: [FISSION_SAVED], history: [ZERO_WAITING] }), bare);
});

test("a model the game cannot generate is not offered", async () => {
  const world = recipeWorld({ recipes: REACTORS });
  world.JB.resourceIndex = () => ({ entries: [{ category: "pickup", key: "tpl-fission" }] }); // only one target is known to the game
  assert.deepEqual((await call(world.ex, "gearList")).gear.map((g) => g.key), ["r-fission"]);
  assert.equal((await call(recipeWorld({ recipes: REACTORS }).ex, "gearList")).gear.length, 3);
});

test("the editor and blueprint requests refuse what cannot work before touching the game", async () => {
  const { ex } = recipeWorld({ recipes: REACTORS, saved: [FISSION_SAVED] });
  assert.equal((await call(ex, "gearEdit", "r-scatter", { tier: 9 }, "preview")).error.code, "BAD_RARITY");
  assert.equal((await call(ex, "gearEdit", "r-scatter", JSON.stringify({ tier: "Mythic" }), "preview")).error.code, "BAD_RARITY");
  assert.equal((await call(ex, "gearEdit", "nope", { tier: 1 }, "preview")).error.code, "RECIPE_NOT_FOUND");
  assert.equal((await call(ex, "gearEdit", "r-extinguisher", { tier: 1 }, "preview")).error.code, "RECIPE_NOT_FOUND"); // a consumable has no attributes
  assert.equal((await call(ex, "makeBlueprint", "r-scatter", "history", { tier: 5 })).error.code, "BAD_RARITY");
  assert.equal((await call(ex, "makeBlueprint", "nope", "history", { tier: 1 })).error.code, "RECIPE_NOT_FOUND");
  assert.equal((await call(ex, "makeBlueprint", "r-extinguisher", "slot", JSON.stringify({ tier: 0 }))).error.code, "RECIPE_NOT_FOUND");
});

test("the item editor refuses a bad tier and an item the catalog does not know", async () => {
  const { ex } = recipeWorld({ recipes: REACTORS });
  assert.equal((await call(ex, "itemEdit", "Pickupable_PDW_MK0", { tier: 7 }, "preview")).error.code, "BAD_RARITY");
  const r = await call(ex, "itemEdit", "Pickupable_Nothing", { tier: 1 }, "preview");
  assert.equal(r.error.code, "ITEM_NOT_FOUND");
});

test("an item that is to carry attributes is checked before anything is spawned", async () => {
  const { JB } = recipeWorld({ recipes: REACTORS });
  const it = { name: "Pickupable_X", display: "测试枪", category: "pickup", d: fake({}, { m_AssetGUID: str("tpl-x") }) };
  assert.throws(() => JB.gearAttachment(it, { tier: 8 }), (e) => e.code === "BAD_RARITY");
  assert.throws(() => JB.gearAttachment(it, "{not json"), SyntaxError);
  const gear = JB.gearAttachment(it, JSON.stringify({ tier: 2 })); // a valid request is only built when it is checked or applied
  assert.equal(typeof gear.check, "function");
  assert.equal(typeof gear.apply, "function");
});

test("the guids of the models that carry attributes are known to the item list", async () => {
  const { JB } = recipeWorld({ recipes: REACTORS });
  assert.deepEqual([...(await JB.gearTargets())].sort(), ["tpl-fission", "tpl-scatter", "tpl-zero"]);
});

test("recipes are listed with their unlock state; weapons and parts are told apart from consumables", async () => {
  const { ex } = recipeWorld({ recipes: REACTORS, unlocked: ["r-fission", "r-extinguisher"], saved: [FISSION_SAVED] });
  const r = await call(ex, "recipes");
  const by = Object.fromEntries(r.recipes.map((x) => [x.key, x]));
  assert.equal(by["r-fission"].kind, "blueprint");
  assert.equal(by["r-fission"].unlocked, true);
  assert.equal(by["r-scatter"].unlocked, false);
  assert.equal(by["r-extinguisher"].kind, "craftable");
  assert.equal(by["r-extinguisher"].unlocked, true);
  assert.ok(!("blueprint" in by["r-fission"]), "the recipe list says nothing about blueprints any more");
  assert.ok(!("template" in by["r-fission"]), "game objects must not leave the agent");
});

test("unlocking only touches the unlock flag", async () => {
  const seen = [];
  const { ex, state } = recipeWorld({ recipes: REACTORS });
  ex.unlockBlueprint = async (key) => { seen.push(key); return JSON.stringify({ ok: true, changed: true }); };
  const r = await call(ex, "unlockRecipes", ["r-scatter", "r-extinguisher"], "slot", 3); // the old extra arguments are ignored
  assert.deepEqual(seen, ["r-scatter", "r-extinguisher"]);
  assert.equal(r.changed, 2);
  assert.deepEqual(r.results.map((x) => Object.keys(x).sort()), [["changed", "code", "error", "key", "ok"], ["changed", "code", "error", "key", "ok"]]);
  assert.equal(state.saved.length, 0);
  assert.equal(state.history.length, 0);
});

test("relocking can take back what an older version put in, unless the player changed it", async () => {
  const saved = [
    { cat: "cat-reactor", slot: 1, template: "tpl-scatter", guid: "made-1", level: 1, rarity: "Common" },
    { cat: "cat-reactor", slot: 2, template: "tpl-zero", guid: "made-2", level: 4, rarity: "Common" }, // upgraded since
  ];
  const { ex, state } = recipeWorld({ recipes: REACTORS, saved, history: [{ cat: "cat-reactor", template: "tpl-x", guid: "found-1", level: 1, rarity: "Common" }] });
  assert.equal((await call(ex, "lockRecipes", [], [])).error.code, "BAD_SELECTION");
  const r = await call(ex, "lockRecipes", [], [
    { guid: "made-1", where: "slot", level: 1, rarity: "Common" },
    { guid: "made-2", where: "slot", level: 1, rarity: "Common" },
    { guid: "found-1", where: "history" },
    { guid: "found-2", where: "history" }, // saved meanwhile: not in the history any more
  ]);
  assert.deepEqual(r.blueprints.map((b) => [b.guid, b.removed, b.reason]), [["made-1", true, null], ["made-2", false, "changed"], ["found-1", true, null], ["found-2", false, "gone"]]);
  assert.deepEqual(state.removed, ["made-1"]);
  assert.deepEqual(state.forgotten, ["found-1"]);
});

test("undoing a blueprint takes back what was made, and says what it could not", async () => {
  const saved = [{ cat: "cat-reactor", slot: 0, template: "tpl-scatter", guid: "made-1", level: 12, rarity: "Legendary" }];
  const { ex, state } = recipeWorld({ recipes: REACTORS, saved, history: [{ cat: "cat-reactor", template: "tpl-zero", guid: "found-1", level: 12, rarity: "Legendary" }] });
  const r = await call(ex, "removeRecipeBlueprints", [{ guid: "made-1", where: "slot", level: 12, rarity: "Legendary" }, { guid: "found-1", where: "history" }, { guid: "gone", where: "slot", level: 1, rarity: "Common" }]);
  assert.deepEqual(r.blueprints.map((b) => [b.guid, b.removed, b.reason]), [["made-1", true, null], ["found-1", true, null], ["gone", false, "gone"]]);
  assert.equal(r.changed, 2);
  assert.deepEqual(state.saved, []);
  assert.deepEqual(state.history, []);
  assert.equal((await call(ex, "removeRecipeBlueprints", [])).error.code, "NOTHING_SELECTED");
});

// --------------------------------------------------------------------- items
test("item list groups items and hides untranslated internal ones", async () => {
  const fullCatalog = async () => ({
    counts: {},
    failures: [],
    items: [
      { name: "Pickupable_SMG_MK0", display: "CX-305 Sideclip", category: "pickup", carry: "smg", slot: "Weapon" },
      { name: "MeleeWeapon_Crowbar", display: "撬棍", category: "pickup", carry: "crowbar", slot: "Weapon" },
      { name: "Pickupable_PizzaSliceBad", display: "烧焦披萨片", category: "pickup", carry: "pizza", slot: "Utility" },
      { name: "Pickupable_Mop", display: "拖把", category: "pickup", carry: "smg", slot: "Backpack" },
      { name: "Component_Engine_1_1", display: "漂移相位引擎", category: "cargo" },
      { name: "Pickupable_GenericWeapon", display: "UNNAMED", category: "pickup", carry: "smg", slot: "Backpack" },
      { name: "Pickupable_SAW_LMG_Mk0", display: "Missing loc: STC_Main.SAW LMG", category: "pickup", carry: "33", slot: "Weapon" },
    ],
  });
  const ex = {};
  installItems(baseJB({ fullCatalog }), ex);
  const r = await call(ex, "itemList");
  const by = Object.fromEntries(r.items.map((i) => [i.name, i]));
  assert.equal(by.Pickupable_SMG_MK0.group, "weapon");
  assert.equal(by.MeleeWeapon_Crowbar.group, "melee");
  assert.equal(by.Pickupable_PizzaSliceBad.group, "consumable");
  assert.equal(by.Pickupable_Mop.group, "novelty"); // a mop is not a gun even though it holds like one
  assert.equal(by.Component_Engine_1_1.group, "component");
  assert.equal(by.Pickupable_GenericWeapon.hidden, true);
  assert.equal(by.Pickupable_SAW_LMG_Mk0.hidden, true);
  assert.equal(by.Pickupable_SMG_MK0.hidden, false);
  assert.equal(by.Pickupable_SMG_MK0.groupLabel, "枪械");
});

test("the item list marks the items that carry attributes", async () => {
  const fullCatalog = async () => ({
    counts: {},
    failures: [],
    items: [
      { name: "Pickupable_SMG_MK0", display: "CX-305 Sideclip", category: "pickup", carry: "smg", slot: "Weapon", guid: "g-smg" },
      { name: "Pickupable_PizzaSliceBad", display: "烧焦披萨片", category: "pickup", carry: "pizza", slot: "Utility", guid: "g-pizza" },
      { name: "Component_Engine_1_1", display: "漂移相位引擎", category: "cargo", guid: "g-engine" },
      { name: "Pickupable_NoGuid", display: "没有编号", category: "pickup", carry: "pizza", slot: "Utility" },
    ],
  });
  const ex = {};
  installItems(baseJB({ fullCatalog, gearTargets: async () => new Set(["g-smg", "g-engine"]) }), ex);
  const by = Object.fromEntries((await call(ex, "itemList")).items.map((i) => [i.name, i]));
  assert.equal(by.Pickupable_SMG_MK0.gear, true);
  assert.equal(by.Component_Engine_1_1.gear, true);
  assert.equal(by.Pickupable_PizzaSliceBad.gear, false);
  assert.equal(by.Pickupable_NoGuid.gear, false);
  // an older toolbox without the gear module lists the items as before
  const plain = {};
  installItems(baseJB({ fullCatalog }), plain);
  assert.ok((await call(plain, "itemList")).items.every((i) => i.gear === false));
});

test("items of an unknown carry type that carry attributes are grouped as weapons", async () => {
  const fullCatalog = async () => ({
    counts: {},
    failures: [],
    items: [
      { name: "Pickupable_Flamethrower_MK0", display: "喷火器", category: "pickup", carry: "flamethrower", slot: "Weapon", guid: "g-flame" },
      { name: "MeleeWeapon_Katana", display: "武士刀", category: "pickup", carry: "katana", slot: "Weapon", guid: "g-katana" },
      { name: "Pickupable_Salvage", display: "残骸", category: "pickup", carry: "HeavyObject", slot: "Backpack", guid: "g-salvage" },
      { name: "Pickupable_StickyGrenade", display: "粘性手雷", category: "pickup", carry: "grenade", slot: "Utility", guid: "g-sticky" },
    ],
  });
  const ex = {};
  installItems(baseJB({ fullCatalog, gearTargets: async () => new Set(["g-flame", "g-katana", "g-sticky"]) }), ex);
  const by = Object.fromEntries((await call(ex, "itemList")).items.map((i) => [i.name, i]));
  assert.equal(by.Pickupable_Flamethrower_MK0.group, "weapon");
  assert.equal(by.MeleeWeapon_Katana.group, "melee");
  assert.equal(by.Pickupable_Salvage.group, "resource");
  assert.equal(by.Pickupable_StickyGrenade.group, "throwable"); // a known carry type wins over the attributes
});

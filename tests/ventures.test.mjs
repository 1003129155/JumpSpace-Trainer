// Unit tests for agent/ventures.js against a small fake of the game's venture objects (no game, no Frida). Run with: npm test
import assert from "node:assert/strict";
import { test } from "node:test";

import { installVentures } from "../agent/ventures.js";
import { fake, str, baseJB, call } from "./helpers.mjs";

const NULL_OBJ = { isNull: () => true };
const list = (items) => fake({ get_Count: () => items.length, get_Item: (i) => items[i] });

function venture(guid, o = {}) {
  const state = { completed: false, ready: false, active: true, ...o };
  const v = fake({
    get_AssetGUID: str(guid),
    get_DisplayName: str(o.name ?? guid),
    get_Description: str(o.description ?? ""),
    get_IsCompleted: () => state.completed,
    get_IsReadyToComplete: () => state.ready,
    get_IsActive: () => state.active,
    ActivationPrerequisitesMet: () => o.prerequisitesMet ?? true,
    get_IsInSeason: () => o.inSeason ?? true,
  }, {
    m_Hidden: !!o.hidden,
    m_HiddenInVentureLog: !!o.hiddenInLog,
    m_HideUntilCompleted: !!o.secret,
    m_MainRewardType: o.type || "ProgressionSecondary",
    m_Achievement: o.achievement ? fake() : NULL_OBJ,
    m_ExperienceReward: o.xp || 0,
    m_CreditsReward: o.credits || 0,
    m_IngotsReward: o.ingots || 0,
    m_Unlocks: list((o.unlocks || []).map((g) => fake({ get_AssetGUID: str(g) }))),
  });
  v._state = state;
  return v;
}

// the assets ventures unlock: guid -> { cls, file, display, mark, broken }
const ASSETS = {
  "g-trait": { cls: "Keepsake.Modifiers.Traits.PlayerTraitScriptable", file: "Trait_ShockPants", display: "冲击裤" },
  "g-helmet": { cls: "Keepsake.CharacterWardrobeHelmetPreset", file: "HelmetPreset_Scavenger", display: "打捞者头盔" },
  "g-ship": { cls: "Keepsake.SpaceshipBlueprint", file: "SpaceshipBlueprint_Catamaran_1", display: "C-3 双体船", mark: 1 },
  "g-broken": { cls: "Keepsake.GameplayFeatures.GalaxyMap.GalaxyMapRegionData", file: "GalaxyMapRegion_Krynn", broken: true },
};

// confirm: true (recorded at once), a number (recorded after that many reads of the completed list), false (never)
function world({ ventures, ready = true, confirm = true } = {}) {
  const state = { ventures, completed: [], completeCalls: [], loads: 0, locates: 0, pending: null };
  const record = (v) => { v._state.completed = true; state.completed.push(v); };
  const manager = fake({
    get_InitialDataSuccessfullyLoaded: () => ready,
    SetVentureCompleted: (v, completed) => {
      state.completeCalls.push([v, completed]);
      if (confirm === true) record(v);
      else if (typeof confirm === "number") state.pending = { v, reads: confirm };
    },
    get_CompletedVentures: () => {
      if (state.pending && --state.pending.reads <= 0) { record(state.pending.v); state.pending = null; }
      return list(state.completed);
    },
  });
  const vm = fake({ GetAllVentures: () => list(state.ventures) });
  const U = {
    cls: (name) => ({ "Keepsake.MetaProgression.MetaProgressionManager": manager, "Keepsake.MetaProgression.VentureManager": vm }[name]),
    name: () => "Venture_Unnamed(Clone)",
  };
  const managedRows = (collection, map) => {
    const rows = [];
    for (let i = 0; i < collection.method("get_Count").invoke(); i++) rows.push(map(collection.method("get_Item").invoke(i)));
    return rows;
  };
  const JB = baseJB({
    U,
    managedRows,
    locateAsset: (guid) => { state.locates++; const a = ASSETS[guid]; return a ? { cls: a.cls, name: a.file } : null; },
    loadCatalogAsset: async ({ key }) => {
      state.loads++;
      const a = ASSETS[key];
      if (a.broken) throw new Error("load failed");
      return fake({ get_DisplayName: str(a.display), get_BlueprintName: str(a.display) }, { m_Mark: a.mark || 0 });
    },
  });
  const ex = {};
  installVentures(JB, ex);
  return { ex, state };
}

test("the list holds the ventures of the venture log, sorted by state, with their rewards named by the game", async () => {
  const { ex } = world({
    ventures: [
      venture("v-done", { name: "提高标准", completed: true, xp: 600 }),
      venture("v-npc", { name: "Venture_NpcIntro", hidden: true }),
      venture("v-level", { name: "Venture_Level_5", type: "LevelUp", hiddenInLog: true }),
      venture("v-side", { name: "替代来源", xp: 600, credits: 300, ingots: 5, unlocks: ["g-helmet", "g-trait"] }),
      venture("v-main", { name: "修复飞船", type: "ProgressionMain", achievement: true, unlocks: ["g-ship"] }),
      venture("v-idle", { name: "克林", type: "Region", active: false, prerequisitesMet: false, unlocks: ["g-broken", "g-unknown"] }),
    ],
  });
  const r = await call(ex, "ventures");
  assert.equal(r.ok, true);
  assert.equal(r.hidden, 2);
  assert.deepEqual(r.ventures.map((v) => [v.name, v.state, v.kind]), [
    ["修复飞船", "active", "main"], ["替代来源", "active", "side"], ["克林", "idle", "region"], ["提高标准", "completed", "side"],
  ]);
  const side = r.ventures.find((v) => v.key === "v-side");
  assert.deepEqual([side.experience, side.credits, side.ingots], [600, 300, 5]);
  assert.deepEqual(side.unlocks.map((u) => [u.kind, u.name]), [["helmet", "打捞者头盔"], ["trait", "冲击裤"]]);
  const main = r.ventures.find((v) => v.key === "v-main");
  assert.equal(main.achievement, true);
  assert.deepEqual(main.unlocks.map((u) => u.name), ["C-3 双体船 Mk.1"]);
  const idle = r.ventures.find((v) => v.key === "v-idle");
  assert.equal(idle.prerequisitesMet, false);
  // an asset that does not load keeps its file name; one the game cannot locate has no name
  assert.deepEqual(idle.unlocks.map((u) => [u.kind, u.name]), [["region", "GalaxyMapRegion_Krynn"], ["other", ""]]);
});

test("the reward assets are looked up once", async () => {
  const { ex, state } = world({ ventures: [venture("a", { unlocks: ["g-trait", "g-helmet"] }), venture("b", { unlocks: ["g-trait"] })] });
  await call(ex, "ventures");
  await call(ex, "ventures");
  assert.equal(state.loads, 2);
  assert.equal(state.locates, 2);
});

test("completing a venture is the game's own completion, confirmed by its list of completed ventures", async () => {
  const v = venture("v-side", { name: "替代来源", xp: 600 });
  const { ex, state } = world({ ventures: [v] });
  const r = await call(ex, "completeVenture", "v-side");
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.equal(r.venture.state, "completed");
  assert.deepEqual(state.completeCalls, [[v, true]]);
});

test("a completion the game records a few frames later is waited for", async () => {
  const { ex, state } = world({ ventures: [venture("v-ship", { name: "飞镖 DT-4", type: "PlayerShipBlueprint" })], confirm: 3 });
  const r = await call(ex, "completeVenture", "v-ship");
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.equal(state.completeCalls.length, 1);
});

test("a venture that is done already is left alone", async () => {
  const { ex, state } = world({ ventures: [venture("v", { completed: true })] });
  const r = await call(ex, "completeVenture", "v");
  assert.equal(r.changed, false);
  assert.equal(state.completeCalls.length, 0);
});

test("hidden or unknown ventures, a missing key or profile, and an unconfirmed completion are refused", async () => {
  const code = async (w, key) => (await call(w.ex, "completeVenture", key)).error.code;
  assert.equal(await code(world({ ventures: [venture("h", { hidden: true })] }), "h"), "VENTURE_HIDDEN");
  assert.equal(await code(world({ ventures: [] }), "nope"), "VENTURE_NOT_FOUND");
  assert.equal(await code(world({ ventures: [] }), ""), "VENTURE_REQUIRED");
  assert.equal(await code(world({ ventures: [venture("v")], ready: false }), "v"), "PROFILE_NOT_READY");
  assert.equal(await code(world({ ventures: [venture("v")], confirm: false }), "v"), "VENTURE_UNCONFIRMED");
  assert.equal((await call(world({ ventures: [], ready: false }).ex, "ventures")).error.code, "PROFILE_NOT_READY");
});

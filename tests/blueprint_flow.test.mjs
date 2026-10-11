// The decisions behind "make a blueprint of a weapon / ship part with chosen attributes": record the item in the discovery
// history and (optionally) save it into a blueprint slot — against a fake game adapter.
import assert from "node:assert/strict";
import { test } from "node:test";

import { makeBlueprint, removeMade, blueprintMessage, rarityIndex, RARITIES, STATUS, SETTLED } from "../agent/blueprint_flow.js";

const entity = { key: "r1", display: "物质散射反应堆", category: "反应堆", targetGuid: "tpl-1", categoryGuid: "cat-reactor" };
const spec = { tier: 3, seed: 5, level: "max", slots: [] };

// a fake adapter that records every call and can be told how the game answers
function fakeGame(over = {}) {
  const calls = [];
  const game = {
    calls,
    slotState: over.slotState || { total: 4, used: 1, free: 1 },
    item: over.item === undefined ? { id: "item-1" } : over.item,
    holder: over.holder === undefined ? { guid: "guid-1" } : over.holder,
    inHistory: new Set(over.history || []),
    slots(cat) { calls.push(["slots", cat]); return this.slotState; },
    buildGear(e, s) {
      calls.push(["buildGear", s.tier]);
      this.madeTier = s.tier;
      if (over.generateThrows) throw new Error("boom");
      if (over.built === null) return null;
      return over.built || { item: this.item, errors: [] };
    },
    guidOf() { return "guid-1"; },
    recordFound(item, cat) { calls.push(["recordFound", cat]); if (over.historyKeeps !== false) this.inHistory.add("guid-1"); },
    historyHas(guid) { return this.inHistory.has(guid); },
    historyEntry(guid) { return this.inHistory.has(guid) ? { item: { id: guid } } : null; },
    canSave() { calls.push(["canSave"]); return over.canSave !== false; },
    saveInSlot(item, cat, slot) { calls.push(["saveInSlot", cat, slot]); return over.accepted !== false; },
    inSlot(cat, slot) { calls.push(["inSlot", cat, slot]); return this.holder; },
    forget(item) { calls.push(["forget", item]); if (over.forgetRefused) return false; this.inHistory.delete(item.id === "item-1" ? "guid-1" : item.id); return true; },
    describe() { return { level: over.level ?? 1, rarity: RARITIES[this.madeTier ?? 0] }; },
    release() { calls.push(["release"]); },
    // removal side
    blueprints: over.blueprints || {},
    blueprintByGuid(guid) { return this.blueprints[guid] || null; },
    removeBlueprint(handle) { calls.push(["removeBlueprint", handle]); if (over.removeRefused) return false; delete this.blueprints[handle]; return true; },
  };
  return game;
}
const names = (game) => game.calls.map((c) => c[0]);

test("history only: the item is built, recorded as found and read back, and no slot is touched", () => {
  const game = fakeGame({ level: 12 });
  const r = makeBlueprint(game, entity, { save: false, spec });
  assert.deepEqual(r, { status: STATUS.FOUND, instanceGuid: "guid-1", level: 12, rarity: "Legendary" });
  assert.deepEqual(names(game), ["buildGear", "recordFound", "release"]);
  assert.deepEqual(game.calls.find((c) => c[0] === "recordFound"), ["recordFound", "cat-reactor"]);
});

test("every request makes a new item: a model may have as many blueprints as there are slots", () => {
  const game = fakeGame({ history: ["guid-1"] }); // something with that guid is in the history already
  const r = makeBlueprint(game, entity, { save: false, spec });
  assert.equal(r.status, STATUS.FOUND);
  assert.ok(names(game).includes("buildGear"));
  assert.ok(names(game).includes("recordFound"));
});

test("the attributes of the spec are what gets built", () => {
  for (const tier of [0, 1, 2, 3]) {
    const game = fakeGame();
    const r = makeBlueprint(game, entity, { save: false, spec: { tier } });
    assert.deepEqual(game.calls.find((c) => c[0] === "buildGear"), ["buildGear", tier]);
    assert.equal(r.rarity, RARITIES[tier]);
  }
});

test("history only: an item the game did not keep is not reported as found", () => {
  const game = fakeGame({ historyKeeps: false });
  const r = makeBlueprint(game, entity, { save: false, spec });
  assert.equal(r.status, STATUS.UNCONFIRMED);
  assert.equal(names(game).at(-1), "release");
});

test("saving: a full category is reported before anything is built", () => {
  const game = fakeGame({ slotState: { total: 4, used: 4, free: null } });
  const r = makeBlueprint(game, entity, { save: true, spec });
  assert.equal(r.status, STATUS.NO_SLOT);
  assert.equal(r.used, 4);
  assert.equal(r.total, 4);
  assert.ok(!names(game).includes("buildGear"));
});

test("history only never needs a free slot", () => {
  const game = fakeGame({ slotState: { total: 4, used: 4, free: null } });
  assert.equal(makeBlueprint(game, entity, { save: false, spec }).status, STATUS.FOUND);
  assert.ok(!names(game).includes("slots"));
});

test("saving: recorded as found, saved into the free slot, then confirmed", () => {
  const game = fakeGame({ level: 11 });
  const r = makeBlueprint(game, entity, { save: true, spec });
  assert.deepEqual(r, { status: STATUS.SAVED, slot: 1, instanceGuid: "guid-1", level: 11, rarity: "Legendary", used: 2, total: 4 });
  assert.deepEqual(names(game), ["slots", "buildGear", "recordFound", "canSave", "saveInSlot", "inSlot", "release"]);
  assert.deepEqual(game.calls.find((c) => c[0] === "saveInSlot"), ["saveInSlot", "cat-reactor", 1]);
});

test("saving: when the game refuses, what this call added is taken back", () => {
  const game = fakeGame({ canSave: false });
  assert.equal(makeBlueprint(game, entity, { save: true, spec }).status, STATUS.REJECTED);
  assert.ok(names(game).includes("forget"));
  assert.ok(!names(game).includes("saveInSlot"));
  assert.equal(names(game).at(-1), "release");
});

test("saving: a save the slot does not confirm is not reported as saved", () => {
  for (const over of [{ accepted: false }, { holder: null }, { holder: { guid: "someone-else" } }]) {
    const game = fakeGame(over);
    const r = makeBlueprint(game, entity, { save: true, spec });
    assert.equal(r.status, STATUS.UNCONFIRMED, JSON.stringify(over));
    assert.ok(names(game).includes("forget"));
  }
});

test("no generated item means nothing to record or clean up", () => {
  for (const save of [true, false]) {
    const game = fakeGame({ built: null });
    const r = makeBlueprint(game, entity, { save, spec });
    assert.equal(r.status, STATUS.NO_ITEM);
    assert.ok(!names(game).includes("recordFound"));
    assert.equal(names(game).at(-1), "release");
  }
});

test("attributes that break the game's rules make nothing and say why", () => {
  const game = fakeGame({ built: { item: { id: "x" }, errors: ["词条「提升伤害」重复了", "装备等级 12 超过了这件装备的上限 11"] } });
  const r = makeBlueprint(game, entity, { save: true, spec });
  assert.equal(r.status, STATUS.INVALID);
  assert.deepEqual(r.errors.length, 2);
  assert.ok(!names(game).includes("recordFound"));
  assert.equal(names(game).at(-1), "release");
  assert.match(blueprintMessage(r, entity), /属性不符合游戏规则：词条「提升伤害」重复了；装备等级 12/);
  assert.ok(!SETTLED.has(STATUS.INVALID));
});

test("game objects are released even when the generator throws", () => {
  const game = fakeGame({ generateThrows: true });
  assert.throws(() => makeBlueprint(game, entity, { save: false, spec }), /boom/);
  assert.equal(names(game).at(-1), "release");
});

test("undo takes back history entries and blueprints, but only if they are still as this tool made them", () => {
  const game = fakeGame({
    history: ["h-here"],
    blueprints: {
      fresh: { handle: "fresh", level: 1, rarity: "Common" },
      upgraded: { handle: "upgraded", level: 3, rarity: "Common" },
      rarer: { handle: "rarer", level: 1, rarity: "Rare" },
    },
  });
  const r = removeMade(game, [
    { guid: "fresh", where: "slot", level: 1, rarity: "Common" },
    { guid: "upgraded", where: "slot", level: 1, rarity: "Common" },
    { guid: "rarer", where: "slot", level: 1, rarity: "Common" },
    { guid: "missing", where: "slot", level: 1, rarity: "Common" },
    { guid: "h-here", where: "history" },
    { guid: "h-saved-meanwhile", where: "history" },
    { guid: "legacy", level: 1, rarity: "Common" }, // entries from before `where` existed are blueprints
  ]);
  assert.deepEqual(r.map((x) => [x.guid, x.where, x.removed, x.reason]), [
    ["fresh", "slot", true, null],
    ["upgraded", "slot", false, "changed"],
    ["rarer", "slot", false, "changed"],
    ["missing", "slot", false, "gone"],
    ["h-here", "history", true, null],
    ["h-saved-meanwhile", "history", false, "gone"],
    ["legacy", "slot", false, "gone"],
  ]);
  assert.deepEqual(game.calls.filter((c) => c[0] === "removeBlueprint"), [["removeBlueprint", "fresh"]]);
});

test("a removal the game refuses is reported as such", () => {
  const bp = fakeGame({ blueprints: { b: { handle: "b", level: 1, rarity: "Common" } }, removeRefused: true });
  const [r] = removeMade(bp, [{ guid: "b", where: "slot" }]);
  assert.equal(r.removed, false);
  assert.equal(r.reason, "refused");
  const hist = fakeGame({ history: ["h"], forgetRefused: true });
  const [h] = removeMade(hist, [{ guid: "h", where: "history" }]);
  assert.equal(h.removed, false);
  assert.equal(h.reason, "refused");
});

test("tier arguments are 0-3 or a name, nothing else", () => {
  assert.equal(rarityIndex(undefined), 0);
  assert.equal(rarityIndex(""), 0);
  assert.equal(rarityIndex(2), 2);
  assert.equal(rarityIndex("3"), 3);
  assert.equal(rarityIndex("Rare"), 1);
  for (const bad of [4, -1, "4", "legendary!", 1.5, "Mythic", {}]) assert.equal(rarityIndex(bad), null, String(bad));
});

test("player-facing messages name the item, its tier and level, and say what to do next", () => {
  const saved = blueprintMessage({ status: STATUS.SAVED, slot: 1, used: 2, total: 4, rarity: "Epic", level: 10 }, entity);
  assert.match(saved, /「反应堆」蓝图槽 2.*2\/4.*物质散射反应堆.*史诗品质 · 10 级.*制作台/);
  assert.match(blueprintMessage({ status: STATUS.NO_SLOT, used: 4, total: 4 }, entity), /已满.*4\/4.*发现历史/);
  const found = blueprintMessage({ status: STATUS.FOUND, rarity: "Legendary", level: 12 }, entity);
  assert.match(found, /发现历史.*物质散射反应堆.*传说品质 · 12 级.*我的蓝图/);
  for (const s of [STATUS.NO_ITEM, STATUS.REJECTED, STATUS.UNCONFIRMED]) assert.match(blueprintMessage({ status: s }, entity), /物质散射反应堆/);
});

test("the outcomes that need no follow-up are exactly the settled ones", () => {
  assert.deepEqual([...SETTLED].sort(), ["found", "saved"]);
});

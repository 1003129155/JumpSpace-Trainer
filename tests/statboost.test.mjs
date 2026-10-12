// Unit tests for agent/statboost.js and the "超级伤害" / "修理加速" cheats against stand-ins for the game's modifier manager (no game, no Frida).
// The multiplier itself (base × (1 + sum), asked with the held weapon as owner) is checked in the running game.
import assert from "node:assert/strict";
import { test } from "node:test";

import { installCheats } from "../agent/cheats.js";
import { createDamageBoost, createRepairBoost } from "../agent/statboost.js";
import { baseJB, bridgeError, call, fake } from "./helpers.mjs";

const obj = (name) => ({ name, handle: { toString: () => name }, ref: () => ({ pinned: name }) });

function world({ methods = ["get_Instance", "AddLocalStatModification", "RemoveLocalStatModification"] } = {}) {
  const w = { manager: obj("0xmanager"), weapon: obj("0xrifle"), calls: { add: [], remove: [] }, held: true };
  globalThis.Il2Cpp.corlib = { class: () => ({ inflate: () => ({}) }) };
  globalThis.Il2Cpp.delegate = (klass, fn) => ({ fn, ref: () => ({}) });
  const impl = {
    get_Instance: () => fake({ get_gameObject: () => w.manager }),
    AddLocalStatModification: (...args) => w.calls.add.push(args),
    RemoveLocalStatModification: (...args) => w.calls.remove.push(args),
  };
  const manager = { methods: methods.map((name) => ({ name, invoke: impl[name] })) };
  const stat = { field: (name) => ({ value: `stat:${name}` }) };
  const pickupable = fake({ get_gameObject: () => w.weapon });
  const instantiator = fake({}, { m_FirstPersonItem: fake({}, { m_PersistentPickupable: pickupable }) });
  const empty = fake({}, { m_FirstPersonItem: { isNull: () => true } });
  const player = { method: () => ({ invoke: () => ({ isNull: () => true }) }), field: () => ({ get value() { return w.held ? instantiator : empty; } }) };
  const U = { cls: (name) => ({ "Keepsake.GameplayModifierManager": manager, "Keepsake.ModifierStat": stat }[name] || {}), all: () => [], name: () => "" };
  w.JB = baseJB({ U, localPlayer: () => player });
  return w;
}

const boostOf = (w, statName) => w.calls.add.find((a) => a[0] === `stat:${statName}`)[2].fn; // the multiplier delegate

test("one modifier is registered per damage stat, and it multiplies only the weapon in hand", () => {
  const w = world();
  const boost = createDamageBoost(w.JB);
  boost.apply(10);
  assert.deepEqual(w.calls.add.map((a) => a[0]).sort(), ["stat:OnFootDamage", "stat:ShipDamage"]);
  assert.ok(w.calls.add.every((a) => a[3] === w.manager));
  for (const stat of ["OnFootDamage", "ShipDamage"]) {
    assert.equal(boostOf(w, stat)(w.weapon), 9); // base × (1 + 9) = ×10
    assert.equal(boostOf(w, stat)(obj("0xenemy-gun")), 0);
  }
  assert.equal(boost.active(), true);
});

test("a new factor or a different weapon is picked up without registering again", () => {
  const w = world();
  const boost = createDamageBoost(w.JB);
  boost.apply(10);
  boost.apply(50);
  assert.equal(w.calls.add.length, 2);
  assert.equal(boostOf(w, "OnFootDamage")(w.weapon), 49);
  w.weapon = obj("0xshotgun");
  assert.equal(boostOf(w, "OnFootDamage")(obj("0xrifle")), 49); // still the old weapon until the next tick
  boost.apply(50);
  assert.equal(boostOf(w, "OnFootDamage")(w.weapon), 49);
  assert.equal(boostOf(w, "OnFootDamage")(obj("0xrifle")), 0);
});

test("with nothing in hand nothing is multiplied", () => {
  const w = world();
  const boost = createDamageBoost(w.JB);
  w.held = false;
  boost.apply(10);
  assert.equal(boostOf(w, "OnFootDamage")(w.weapon), 0);
  assert.equal(boostOf(w, "OnFootDamage")(obj("0x0")), 0);
});

test("releasing removes both registrations; applying again makes new ones", () => {
  const w = world();
  const boost = createDamageBoost(w.JB);
  boost.release(); // nothing registered yet: nothing to remove
  assert.equal(w.calls.remove.length, 0);
  boost.apply(10);
  boost.release();
  assert.deepEqual(w.calls.remove.map((a) => a[0]).sort(), ["stat:OnFootDamage", "stat:ShipDamage"]);
  assert.ok(w.calls.remove.every((a) => a[1] === w.manager));
  assert.equal(boost.active(), false);
  boost.apply(10);
  assert.equal(w.calls.add.length, 4);
});

test("a replaced manager object gets a fresh registration", () => {
  const w = world();
  const boost = createDamageBoost(w.JB);
  boost.apply(10);
  w.manager = obj("0xmanager2");
  boost.apply(10);
  assert.equal(w.calls.add.length, 4);
  assert.equal(w.calls.add[2][3], w.manager);
});

test("a game without the modifier methods is reported as changed", () => {
  const w = world({ methods: ["get_Instance"] });
  assert.throws(() => createDamageBoost(w.JB).apply(10), (e) => e.code === "GAME_API_CHANGED" && /AddLocalStatModification/.test(e.message));
});

test("the cheat takes a multiplier of 2 to 100, applies it while on and removes it when off", async () => {
  const w = world();
  const ex = {};
  installCheats(w.JB, ex);
  await call(ex, "setCheat", "damage", "true", "25");
  w.JB._tickers.get("cheat:damage").fn();
  assert.equal(boostOf(w, "OnFootDamage")(w.weapon), 24);
  const info = (await call(ex, "cheats")).cheats.find((c) => c.name === "damage");
  assert.deepEqual([info.param.min, info.param.max, info.param.value], [2, 100, 25]);
  assert.equal((await call(ex, "setCheatParam", "damage", "101")).ok, false);
  assert.equal((await call(ex, "setCheatParam", "damage", "1")).ok, false);
  await call(ex, "setCheat", "damage", "false");
  assert.equal(w.calls.remove.length, 2);
  assert.equal(w.JB._tickers.has("cheat:damage"), false);
});

test("repair speed asks about the player, its interaction controller's owner and the held tool's owner", () => {
  const w = world();
  const owner = (name) => ({ isNull: () => false, handle: { toString: () => name } });
  const stat = (name) => ({ isNull: () => false, field: () => ({ value: owner(name) }) });
  const kit = { isNull: () => false, class: { fields: [{ name: "m_RepairSpeed" }] }, field: () => ({ value: stat("0xkit-owner") }) };
  const controller = { isNull: () => false, field: () => ({ value: stat("0xcontroller-owner") }) };
  const playerGo = obj("0xplayer");
  const player = {
    method: (name) => ({ invoke: () => (name === "get_InteractionController" ? controller : playerGo) }),
    field: () => ({ value: { field: () => ({ value: kit }) } }),
  };
  w.JB.localPlayer = () => player;
  const boost = createRepairBoost(w.JB);
  boost.apply(4);
  assert.deepEqual(w.calls.add.map((a) => a[0]), ["stat:RepairSpeed"]);
  const fn = w.calls.add[0][2].fn;
  for (const mine of ["0xplayer", "0xcontroller-owner", "0xkit-owner"]) assert.equal(fn(obj(mine)), 3, mine);
  assert.equal(fn(obj("0xsomeone-else")), 0);
});

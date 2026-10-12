// Unit tests for agent/loot.js against stand-ins for Frida's CModule, Interceptor and Memory (no game, no Frida).
// The native hook itself is checked in the running game (see the README, "实现要点").
import assert from "node:assert/strict";
import { test } from "node:test";

import { installLoot, LEGENDARY } from "../agent/loot.js";
import { bridgeError } from "./helpers.mjs";

function world({ failAttach = false } = {}) {
  const log = { attached: [], modules: [], listeners: 0 };
  const cell = () => { let v = 0; return { writeS32: (x) => { v = x; }, readS32: () => v }; };
  globalThis.Memory = { alloc: () => cell() };
  globalThis.CModule = class { constructor(source, symbols) { this.source = source; this.symbols = symbols; this.onLeave = { native: "onLeave" }; log.modules.push(this); } };
  globalThis.Interceptor = {
    attach: (address, callbacks) => {
      if (failAttach) throw new Error("unable to intercept function at 0x1");
      log.attached.push({ address, callbacks });
      log.listeners++;
      return { detach: () => { log.listeners--; } };
    },
  };
  const JB = { U: { cls: () => ({ method: (name) => ({ name, virtualAddress: "0x3da2c60" }) }) }, bridgeError };
  installLoot(JB);
  return { JB, log };
}

test("the rarity hook is made once, on the generator's roll, and switching it is a flag", () => {
  const { JB, log } = world();
  assert.equal(JB.lootRarity.active(), false);
  JB.lootRarity.set(LEGENDARY);
  assert.equal(JB.lootRarity.active(), true);
  assert.equal(log.attached.length, 1);
  assert.equal(log.attached[0].address, "0x3da2c60");
  assert.equal(log.attached[0].callbacks.onLeave, log.modules[0].onLeave); // a native callback: no JavaScript runs in the hook
  assert.equal(log.modules[0].symbols.rarity.readS32(), 3);
  JB.lootRarity.set(null);
  assert.equal(JB.lootRarity.active(), false);
  assert.equal(log.listeners, 1); // the hook stays; only the flag changed
  JB.lootRarity.set(LEGENDARY);
  assert.equal(JB.lootRarity.active(), true);
  assert.equal(log.attached.length, 1); // reused, not made again
});

test("switching it off before it was ever on makes no hook", () => {
  const { JB, log } = world();
  JB.lootRarity.set(null);
  assert.equal(JB.lootRarity.active(), false);
  assert.equal(log.attached.length, 0);
  assert.equal(log.modules.length, 0);
});

test("a rarity that does not exist is refused before the game is touched", () => {
  const { JB, log } = world();
  for (const bad of [4, -1, 1.5, "3", NaN]) assert.throws(() => JB.lootRarity.set(bad), (e) => e.code === "BAD_RARITY", String(bad));
  assert.equal(log.modules.length, 0);
});

test("a hook the game does not let us make is reported as a changed game", () => {
  const { JB } = world({ failAttach: true });
  assert.throws(() => JB.lootRarity.set(LEGENDARY), (e) => e.code === "GAME_API_CHANGED" && /没能挂上/.test(e.message));
  assert.equal(JB.lootRarity.active(), false);
});

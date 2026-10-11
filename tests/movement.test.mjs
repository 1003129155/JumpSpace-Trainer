// Tests for the movement multipliers against a model of the game's ComposableProperty<float> priority stack.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createScaler } from "../agent/movement.js";
import { installCheats } from "../agent/cheats.js";
import { baseJB, call, bridgeError, safe } from "./helpers.mjs";

// ------------------------------------------------------------------ model
let nextId = 1;
const ident = (label) => {
  const id = nextId++;
  return { label, handle: { id, equals(o) { return o.id === id; } }, isNull: () => false };
};

const sig = (...types) => types.map((t) => ({ type: { name: t } }));
const sorted = (entries) => entries.map((e, i) => ({ ...e, i })).sort((a, b) => a.priority - b.priority || a.i - b.i);

// One shared class (like the real generic instantiation); the methods act on the object they are bound to.
const PROP_CLASS = {
  handle: "prop-class",
  methods: [
    { name: "OverrideProperty", parameters: sig("System.Single", "System.Int32", "UnityEngine.Object"),
      bind: (obj) => ({ invoke: (value, priority, owner) => { obj._entries.push({ value, priority, owner }); } }) },
    { name: "OverrideProperty", parameters: sig("Keepsake.ComposablePropertyBase", "System.Int32", "UnityEngine.Object"),
      bind: () => ({ invoke: () => { throw new Error("fake: wrong overload"); } }) },
    { name: "ClearOverrideByInstigator", parameters: sig("UnityEngine.Object"),
      bind: (obj) => ({ invoke: (owner) => {
        const before = obj._entries.length;
        for (let i = obj._entries.length - 1; i >= 0; i--) if (obj._entries[i].owner === owner) obj._entries.splice(i, 1);
        return obj._entries.length !== before;
      } }) },
    { name: "ClearOverrideByInstigator", parameters: sig("System.Int32"),
      bind: () => ({ invoke: () => { throw new Error("fake: wrong overload"); } }) },
  ],
};
const QUEUE_CLASS = {
  handle: "queue-class",
  methods: [{ name: "TryGetPriorityForInstigator", parameters: sig("UnityEngine.Object", "System.Int32&"),
    bind: (obj) => ({ invoke: (owner) => obj._entries.some((e) => e.owner === owner) }) }],
};

// Highest priority wins; among equal priorities the newest entry wins (as in the game).
function fakeProperty(base, defaultValue = base) {
  const entries = base === null ? [] : [{ value: base, priority: 0, owner: "base" }];
  const queue = {
    class: QUEUE_CLASS,
    _entries: entries,
    method: (name) => ({
      invoke: () => {
        if (name === "get_Count") return entries.length;
        if (name === "get_LowestPriorityValue") return { method: () => ({ invoke: () => sorted(entries)[0].value }) };
        throw new Error("fake queue: " + name);
      },
    }),
  };
  return {
    class: PROP_CLASS,
    _entries: entries,
    field: (name) => {
      if (name === "m_PropertyPriorityQueue") return { value: queue };
      throw new Error("fake prop field " + name);
    },
    method: (name) => ({
      invoke: () => {
        if (name === "get_Value") return entries.length ? sorted(entries).pop().value : defaultValue;
        if (name === "get_DefaultValue") return defaultValue;
        throw new Error("fake prop: " + name);
      },
    }),
  };
}

function fakeSettings(values = {}) {
  const props = {
    WalkSpeed: fakeProperty(values.WalkSpeed ?? 5.7, 5),
    SprintBonusSpeed: fakeProperty(values.SprintBonusSpeed ?? 2, 1.45),
    WalkSpeedAcceleration: fakeProperty(values.WalkSpeedAcceleration ?? 40, 35),
    JumpHeight: fakeProperty(null, 7), // authored == default: the game keeps no entry for it
  };
  const s = ident("settings");
  s.field = (name) => ({ value: props[name] });
  s.props = props;
  return s;
}

const valueOf = (settings, name) => settings.props[name].method("get_Value").invoke();

function world() {
  const state = { settings: fakeSettings() };
  const player = { method: (name) => ({ invoke: () => { if (name === "get_CurrentPlayerSettings") return state.settings; throw new Error(name); } }) };
  const JB = baseJB({ localPlayer: () => (state.hasPlayer === false ? null : player), U: {} });
  return { state, JB };
}

const SPEED_PROPS = ["WalkSpeed", "SprintBonusSpeed", "WalkSpeedAcceleration"];

// ------------------------------------------------------------------ tests
test("scaler multiplies the base values and restores them exactly when released", () => {
  const { state, JB } = world();
  const scaler = createScaler(JB, { props: SPEED_PROPS });
  assert.equal(scaler.apply(2), true);
  assert.equal(valueOf(state.settings, "WalkSpeed"), 11.4);
  assert.equal(valueOf(state.settings, "SprintBonusSpeed"), 4);
  assert.equal(valueOf(state.settings, "WalkSpeedAcceleration"), 80);
  assert.equal(state.settings.props.WalkSpeed._entries.length, 2);
  scaler.release();
  assert.equal(valueOf(state.settings, "WalkSpeed"), 5.7);
  assert.equal(valueOf(state.settings, "SprintBonusSpeed"), 2);
  assert.equal(state.settings.props.WalkSpeed._entries.length, 1);
  assert.equal(state.settings.props.WalkSpeed._entries[0].owner, "base"); // the game's own entry is never touched
});

test("changing the multiplier rebuilds from the base instead of compounding", () => {
  const { state, JB } = world();
  const scaler = createScaler(JB, { props: ["WalkSpeed"] });
  scaler.apply(2);
  scaler.apply(3);
  assert.ok(Math.abs(valueOf(state.settings, "WalkSpeed") - 17.1) < 1e-9);
  assert.equal(state.settings.props.WalkSpeed._entries.length, 2);
});

test("game modifiers (crouch, weapon) do not leak into the base that gets scaled", () => {
  const { state, JB } = world();
  state.settings.props.WalkSpeed._entries.push({ value: 3.5, priority: 2, owner: "crouch" });
  const scaler = createScaler(JB, { props: ["WalkSpeed"] });
  scaler.apply(2);
  assert.equal(valueOf(state.settings, "WalkSpeed"), 11.4); // 5.7 x 2, not 3.5 x 2
  scaler.release();
  assert.equal(valueOf(state.settings, "WalkSpeed"), 3.5); // the crouch modifier is back in charge
});

test("a property without entries scales its default value", () => {
  const { state, JB } = world();
  const scaler = createScaler(JB, { props: ["JumpHeight"] });
  scaler.apply(2);
  assert.equal(valueOf(state.settings, "JumpHeight"), 14);
  scaler.release();
  assert.equal(valueOf(state.settings, "JumpHeight"), 7);
  assert.equal(state.settings.props.JumpHeight._entries.length, 0);
});

test("a new character gets its own entries and the old one is left alone", () => {
  const { state, JB } = world();
  const scaler = createScaler(JB, { props: ["WalkSpeed"] });
  scaler.apply(2);
  const old = state.settings;
  state.settings = fakeSettings();
  scaler.apply(2);
  assert.equal(valueOf(state.settings, "WalkSpeed"), 11.4);
  assert.equal(old.props.WalkSpeed._entries.length, 2); // never touched again
});

test("keep-alive puts the entry back when the game cleared the stack", () => {
  const { state, JB } = world();
  const scaler = createScaler(JB, { props: ["WalkSpeed"] });
  scaler.apply(2);
  state.settings.props.WalkSpeed._entries.length = 1; // someone cleared our entry
  assert.equal(valueOf(state.settings, "WalkSpeed"), 5.7);
  scaler.apply(2);
  assert.equal(valueOf(state.settings, "WalkSpeed"), 11.4);
  scaler.apply(2); // already there: no duplicate
  assert.equal(state.settings.props.WalkSpeed._entries.length, 2);
});

test("leftovers from an earlier agent run are removed, and never stacked on", () => {
  const { state, JB } = world();
  state.settings.props.WalkSpeed._entries.push({ value: 99, priority: 10, owner: state.settings });
  const scaler = createScaler(JB, { props: ["WalkSpeed"] });
  scaler.apply(2);
  assert.equal(valueOf(state.settings, "WalkSpeed"), 11.4);
  assert.equal(state.settings.props.WalkSpeed._entries.length, 2);
  scaler.release();
  state.settings.props.WalkSpeed._entries.push({ value: 99, priority: 10, owner: state.settings });
  assert.equal(scaler.clearLeftovers(), 1);
  assert.equal(valueOf(state.settings, "WalkSpeed"), 5.7);
});

test("without a character nothing happens and nothing throws", () => {
  const { state, JB } = world();
  state.hasPlayer = false;
  const scaler = createScaler(JB, { props: ["WalkSpeed"] });
  assert.equal(scaler.apply(2), false);
  assert.equal(scaler.clearLeftovers(), null);
  assert.equal(scaler.release(), false);
});

test("an unexpected game API fails loudly instead of guessing", () => {
  const { state, JB } = world();
  state.settings.props.WalkSpeed.class = { handle: "broken", methods: [] };
  const scaler = createScaler(JB, { props: ["WalkSpeed"] });
  assert.throws(() => scaler.apply(2), (e) => e.code === "GAME_API_CHANGED");
});

// ------------------------------------------------------------ cheat wiring
test("speed and jump cheats toggle through the RPC, validate the number and clean up on dispose", async () => {
  const { state, JB } = world();
  const ex = {};
  installCheats(JB, ex);

  let r = await call(ex, "cheats");
  const speedInfo = r.cheats.find((c) => c.name === "speed");
  assert.equal(speedInfo.param.value, 1.5);
  assert.deepEqual(speedInfo.param.presets, [1.5, 2, 3]);

  r = await call(ex, "setCheat", "speed", true, 2);
  assert.equal(r.ok, true);
  JB._tickers.get("cheat:speed").fn();
  assert.equal(valueOf(state.settings, "WalkSpeed"), 11.4);

  // changing the number of a running cheat takes effect at once
  r = await call(ex, "setCheatParam", "speed", "3");
  assert.equal(r.cheats.find((c) => c.name === "speed").param.value, 3);
  assert.ok(Math.abs(valueOf(state.settings, "WalkSpeed") - 17.1) < 1e-9);

  // bad numbers are rejected and leave everything as it was
  assert.equal((await call(ex, "setCheatParam", "speed", "9")).error.code, "INVALID_VALUE");
  assert.equal((await call(ex, "setCheatParam", "speed", "abc")).error.code, "INVALID_VALUE");
  assert.equal((await call(ex, "setCheatParam", "god", "2")).error.code, "NO_PARAMETER");
  assert.equal((await call(ex, "setCheatParam", "fly", "2")).error.code, "UNKNOWN_CHEAT");
  assert.ok(Math.abs(valueOf(state.settings, "WalkSpeed") - 17.1) < 1e-9);

  // values snap to the step (1.6 -> 1.5)
  await call(ex, "setCheatParam", "jump", "1.6");
  assert.equal((await call(ex, "cheats")).cheats.find((c) => c.name === "jump").param.value, 1.5);

  await call(ex, "setCheat", "jump", true);
  JB._tickers.get("cheat:jump").fn();
  assert.equal(valueOf(state.settings, "JumpHeight"), 10.5);

  JB._disposers.forEach((d) => d());
  assert.equal(valueOf(state.settings, "WalkSpeed"), 5.7);
  assert.equal(valueOf(state.settings, "JumpHeight"), 7);
  assert.equal(JB._tickers.has("cheat:speed"), false);
});

test("listing cheats cleans leftovers once, and a broken game API never breaks the list", async () => {
  const { state, JB } = world();
  state.settings.props.WalkSpeed._entries.push({ value: 99, priority: 10, owner: state.settings });
  const ex = {};
  installCheats(JB, ex);
  await call(ex, "cheats");
  assert.equal(valueOf(state.settings, "WalkSpeed"), 5.7);

  const broken = world();
  broken.state.settings.props.WalkSpeed.class = { handle: "broken", methods: [] };
  const ex2 = {};
  installCheats(broken.JB, ex2);
  const r = await call(ex2, "cheats");
  assert.equal(r.ok, true);
  assert.ok(r.cheats.length >= 7);
});

test("a failing movement tick is reported on the cheat instead of crashing the pump", async () => {
  const { state, JB } = world();
  const ex = {};
  installCheats(JB, ex);
  state.settings.props.WalkSpeed.class = { handle: "broken", methods: [] };
  await call(ex, "setCheat", "speed", true);
  assert.throws(() => JB._tickers.get("cheat:speed").fn(), (e) => e.code === "GAME_API_CHANGED");
  void bridgeError; void safe;
});

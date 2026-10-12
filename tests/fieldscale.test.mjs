// Unit tests for agent/fieldscale.js, agent/recoil.js, agent/shipflight.js and their cheats, against stand-ins for plain game
// objects with number fields (no game, no Frida).
import assert from "node:assert/strict";
import { test } from "node:test";

import { installCheats } from "../agent/cheats.js";
import { createFieldScaler } from "../agent/fieldscale.js";
import { createRecoilControl, KICK_FIELDS, SPREAD_FIELDS } from "../agent/recoil.js";
import { createShipTuner, SHIP_GROUPS } from "../agent/shipflight.js";
import { baseJB, call } from "./helpers.mjs";

let nextId = 0;
// an object with number fields; `values` is shared so the test can read what the game would see
function thing(values, extra = {}) {
  const id = `0x${(++nextId).toString(16)}`;
  const obj = {
    handle: { toString: () => id },
    isNull: () => false,
    ref: () => ({ pinned: id }),
    values,
    field: (name) => ({ get value() { return name in values ? values[name] : extra[name]; }, set value(v) { values[name] = v; } }),
    method: (name) => ({ invoke: (...a) => extra[name](...a) }),
  };
  return obj;
}

test("fields become original × factor, are never scaled twice and go back when released", () => {
  const scaler = createFieldScaler(baseJB());
  const o = thing({ a: 10, b: 8, c: 5 });
  const items = [{ obj: o, field: "a", mode: "mul" }, { obj: o, field: "b", mode: "div" }, { obj: o, field: "c", mode: "zero" }];
  scaler.apply(items, 2);
  assert.deepEqual(o.values, { a: 20, b: 4, c: 0 });
  scaler.apply(items, 2); // a second tick changes nothing
  assert.deepEqual(o.values, { a: 20, b: 4, c: 0 });
  scaler.apply(items, 3); // a new factor is applied to the originals, not on top of the last one
  assert.deepEqual(o.values, { a: 30, b: 8 / 3, c: 0 });
  assert.equal(scaler.release(), 3);
  assert.deepEqual(o.values, { a: 10, b: 8, c: 5 });
  assert.equal(scaler.size(), 0);
});

test("a field the game put back is scaled again, and a reloaded object gets its own original", () => {
  const scaler = createFieldScaler(baseJB());
  const o = thing({ a: 10 });
  const items = (obj) => [{ obj, field: "a", mode: "mul" }];
  scaler.apply(items(o), 2);
  o.values.a = 10; // the game reset it
  scaler.apply(items(o), 2);
  assert.equal(o.values.a, 20);
  const reloaded = thing({ a: 7 });
  scaler.apply(items(reloaded), 2);
  assert.equal(reloaded.values.a, 14);
  scaler.release();
  assert.equal(o.values.a, 10);
  assert.equal(reloaded.values.a, 7);
});

test("releasing skips an object the game has dropped", () => {
  const scaler = createFieldScaler(baseJB());
  const gone = thing({ a: 10 });
  scaler.apply([{ obj: gone, field: "a", mode: "mul" }], 2);
  gone.field = () => ({ get value() { return 20; }, set value(_) { throw new Error("destroyed"); } });
  assert.equal(scaler.release(), 0);
});

function recoilWorld() {
  const data = thing({ ...Object.fromEntries(SPREAD_FIELDS.map((f, i) => [f, 1 + i])), ...Object.fromEntries(KICK_FIELDS.map((f) => [f, 1])) });
  const recoil = thing({}, { m_RecoilData: data });
  recoil.field = (name) => ({ value: name === "m_RecoilData" ? data : undefined });
  const JB = baseJB({ localPlayer: () => null, U: { all: (cls) => (cls === "Keepsake.CameraRecoil" ? [recoil] : []) } });
  return { JB, data };
}

test("no spread zeroes the spread parts of the weapon's recoil data and leaves the kick alone", () => {
  const { JB, data } = recoilWorld();
  const control = createRecoilControl(JB, SPREAD_FIELDS);
  control.apply();
  for (const f of SPREAD_FIELDS) assert.equal(data.values[f], 0, f);
  for (const f of KICK_FIELDS) assert.equal(data.values[f], 1, f);
  control.release();
  SPREAD_FIELDS.forEach((f, i) => assert.equal(data.values[f], 1 + i, f));
});

test("no recoil zeroes the camera kick only", () => {
  const { JB, data } = recoilWorld();
  const control = createRecoilControl(JB, KICK_FIELDS);
  control.apply();
  for (const f of KICK_FIELDS) assert.equal(data.values[f], 0, f);
  for (const f of SPREAD_FIELDS) assert.notEqual(data.values[f], 0, f);
  control.release();
  for (const f of KICK_FIELDS) assert.equal(data.values[f], 1, f);
});

function shipWorld({ engines = 1, shipPresent = true } = {}) {
  const settings = thing({ m_MoveSpeed: 100, m_MovementAccelerationSpeed: 50, m_ThrottleAccelerationSpeed: 20, m_StrafeSpeed: 40, m_ReverseSpeed: 30,
    m_RotateAcceleration: 10, m_TurnSpeedHorizontal: 60, m_TurnSpeedVertical: 55, m_RollSpeed: 90,
    m_PlayershipBoostSpeed: 300, m_DoubleBoostMaxSpeed: 500, m_BoostForwardAccelerationMultiplier: 2 });
  const controller = thing({}, {});
  controller.field = (name) => ({ value: name === "m_MoveSettings_Playership" ? settings : undefined });
  const ship = thing({}, { get_ship_playerController: () => controller, get_transform: () => "ship-transform" });
  const engineData = [];
  const engineObjs = [];
  for (let i = 0; i < engines; i++) {
    const data = thing({ m_BoostTime: 4, m_BoostRechargeTime: 12 });
    engineData.push(data);
    engineObjs.push(thing({}, { get_EngineData: () => data, get_transform: () => ({ method: () => ({ invoke: () => true }) }) }));
  }
  const other = thing({ m_BoostTime: 4, m_BoostRechargeTime: 12 });
  engineObjs.push(thing({}, { get_EngineData: () => other, get_transform: () => ({ method: () => ({ invoke: () => false }) }) })); // another ship's engine
  const JB = baseJB({
    localPlayer: () => null,
    U: {
      cls: (name) => (name === "Global" ? { method: () => ({ invoke: () => (shipPresent ? ship : { isNull: () => true }) }) } : {}),
      all: (cls) => (cls === "Spaceship_MainEngine" ? engineObjs : []),
    },
  });
  return { JB, settings, engineData, other };
}

test("ship speed scales the ship's speed and acceleration numbers and gives them back", () => {
  const { JB, settings } = shipWorld();
  const tuner = createShipTuner(JB, SHIP_GROUPS.speed);
  assert.equal(tuner.apply(2), true);
  assert.equal(settings.values.m_MoveSpeed, 200);
  assert.equal(settings.values.m_MovementAccelerationSpeed, 100);
  assert.equal(settings.values.m_TurnSpeedHorizontal, 60); // not part of this group
  tuner.release();
  assert.equal(settings.values.m_MoveSpeed, 100);
});

test("ship turn scales the turning numbers only", () => {
  const { JB, settings } = shipWorld();
  const tuner = createShipTuner(JB, SHIP_GROUPS.turn);
  tuner.apply(1.5);
  assert.equal(settings.values.m_TurnSpeedHorizontal, 90);
  assert.equal(settings.values.m_RollSpeed, 135);
  assert.equal(settings.values.m_MoveSpeed, 100);
});

test("the boost is faster, lasts longer and recharges sooner, on the player's engines only", () => {
  const { JB, settings, engineData, other } = shipWorld({ engines: 2 });
  const tuner = createShipTuner(JB, SHIP_GROUPS.boost);
  tuner.apply(2);
  assert.equal(settings.values.m_PlayershipBoostSpeed, 600);
  for (const d of engineData) { assert.equal(d.values.m_BoostTime, 8); assert.equal(d.values.m_BoostRechargeTime, 6); }
  assert.equal(other.values.m_BoostTime, 4); // another ship's engine
  tuner.release();
  for (const d of engineData) { assert.equal(d.values.m_BoostTime, 4); assert.equal(d.values.m_BoostRechargeTime, 12); }
});

test("without a ship nothing happens and nothing fails", () => {
  const { JB } = shipWorld({ shipPresent: false });
  const tuner = createShipTuner(JB, SHIP_GROUPS.speed);
  assert.equal(tuner.apply(2), false);
  assert.equal(tuner.release(), 0);
});

test("the new cheats are listed with the ranges the sliders use and switch cleanly", async () => {
  const { JB, settings, engineData } = shipWorld();
  const recoil = recoilWorld();
  JB.U.all = ((ship) => (cls) => (cls === "Keepsake.CameraRecoil" ? recoil.JB.U.all(cls) : ship(cls)))(JB.U.all);
  const ex = {};
  installCheats(JB, ex);
  const list = (await call(ex, "cheats")).cheats;
  const range = (n) => { const c = list.find((x) => x.name === n); return [c.param.min, c.param.max, c.param.value]; };
  assert.deepEqual(range("repair"), [2, 20, 4]);
  assert.deepEqual(range("shipspeed"), [1.25, 5, 2]);
  assert.deepEqual(range("shipturn"), [1.25, 4, 1.5]);
  assert.deepEqual(range("shipboost"), [1.25, 5, 2]);
  assert.equal(list.find((x) => x.name === "spread").param, null);
  assert.equal(list.find((x) => x.name === "recoil").param, null);

  await call(ex, "setCheat", "shipspeed", "true", "3");
  JB._tickers.get("cheat:shipspeed").fn();
  assert.equal(settings.values.m_MoveSpeed, 300);
  await call(ex, "setCheat", "shipspeed", "false");
  assert.equal(settings.values.m_MoveSpeed, 100);

  await call(ex, "setCheat", "shipboost", "true");
  JB._tickers.get("cheat:shipboost").fn();
  assert.equal(engineData[0].values.m_BoostTime, 8);
  await call(ex, "setCheat", "shipboost", "false");
  assert.equal(engineData[0].values.m_BoostTime, 4);

  await call(ex, "setCheat", "spread", "true");
  JB._tickers.get("cheat:spread").fn();
  assert.equal(recoil.data.values.m_DefaultSpread, 0);
  await call(ex, "setCheat", "spread", "false");
  assert.equal(recoil.data.values.m_DefaultSpread, 1);
});

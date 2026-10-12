// Unit tests for agent/shiprepair.js against stand-ins for the ship, its hull, fires, damage points, fuel lines and parts (no game, no Frida).
import assert from "node:assert/strict";
import { test } from "node:test";

import { installShipRepair } from "../agent/shiprepair.js";
import { baseJB, call, fake } from "./helpers.mjs";

const reactive = (get) => fake({ get_Value: get });

function world({ server = true, shipPresent = true } = {}) {
  const w = {
    hull: 3000, hullMax: 5000, shield: 100, shieldMax: 600, breached: 2, shipFires: 3, radiatorFire: true, leaks: [0.2, 1, 0.5], fuel: [true, false, true],
    parts: ["Healthy", "Broken", "Critical"], startup: [0, 0, 0], log: [],
  };
  globalThis.Memory = { alloc: () => { const m = { v: null, writeS32(x) { m.v = x; } }; return m; } };
  globalThis.Il2Cpp.ValueType = class { constructor(mem, type) { this.mem = mem; this.type = type; } };

  const state = fake({}, { m_ShipHealth: reactive(() => w.hull), m_ShipMaxHealth: reactive(() => w.hullMax), m_ShipShield: reactive(() => w.shield), m_CurrentShipMaxShield: reactive(() => w.shieldMax) });
  const ship = fake({ get_ShipStateBlackboardData: () => state });
  const damage = fake({
    ModifyHealthServerRpc: (n) => { w.log.push("health"); w.hull += n; },
    ModifyShieldServerRpc: (n) => { w.log.push("shield:" + w.startup.join("")); w.shield += n; },
  });
  const points = [0, 1, 2].map((i) => fake({ get_CurrentState: () => (i < w.breached ? "Broken" : "Whole") }));
  const hullManager = fake({ ResetAllPoints: () => { w.log.push("reset"); w.breached = 0; } }, { m_HullDamagePoints: { points } });
  const fireController = fake({ ServerStopAllFires: () => { w.log.push("stopfires"); w.shipFires = 0; } });
  const nodes = [0, 1, 2, 3, 4].map((i) => fake({ get_IsOnFire: () => i < w.shipFires }));
  const radiator = fake({ get_IsOnFire: () => w.radiatorFire, StopFire: () => { w.log.push("stopfire"); }, SetFireState: (on) => { if (!on) w.radiatorFire = false; }, get_Health01: () => 1, get_HealthComponent: () => fake({ get_MaxHealth: () => 1000 }) });
  const dps = w.leaks.map((_, i) => fake({ get_Health01: () => w.leaks[i], get_HealthComponent: () => fake({ get_MaxHealth: () => 1000 }), Repair: (pts) => { w.log.push("repair:" + pts); w.leaks[i] = 1; } }));
  const line = fake({ IsSegmentWhole: (i) => w.fuel[i], RepairSegment: (i) => { w.log.push("segment" + i); w.fuel[i] = true; } }, { m_DamageSegments: fake({ get_Count: () => 3 }) });
  const parts = w.parts.map((_, i) => fake({ SetComponentHealthStatus: (st) => { w.log.push("part" + i + ":" + st.mem.v); w.parts[i] = "Healthy"; w.startup[i] = 3; } }, {
    m_ComponentBlackboard: fake({}, { m_ComponentHealthStatus: reactive(() => w.parts[i]), m_ComponentPowerState: reactive(() => { if (w.startup[i] > 0) { w.startup[i]--; return "Activating"; } return "Active"; }) }),
  }));
  const lists = {
    "Playership_DamageController": [damage], "Keepsake.Playership_HullDamageManager": [hullManager], "Spaceship_FireController": [fireController],
    "PathFinding.FireNodePlayership": nodes, "DamagePoint_Radiator": [radiator], "DamagePoint_Base": [...dps, radiator], "DamagePoint_FuelLine": [line], "SpaceShip_BaseComponent": parts,
  };
  const U = {
    all: (cls) => lists[cls] || [],
    cls: (name) => (name === "Global" ? { method: () => ({ invoke: () => (shipPresent ? ship : { isNull: () => true }) }) } : { methods: [{ name: "SetComponentHealthStatus", parameters: [{ type: "ComponentHealthStatus" }] }] }),
  };
  w.JB = baseJB({
    U,
    managedRows: (collection, fn) => collection.points.map(fn),
    requireServer: () => { if (!server) throw Object.assign(new Error("请在房主的电脑上运行刷道具工具"), { code: "HOST_REQUIRED" }); },
  });
  w.ex = {};
  installShipRepair(w.JB, w.ex);
  return w;
}

test("a ship with problems is described by what is wrong with it", async () => {
  const w = world();
  const r = await call(w.ex, "shipHealth");
  assert.equal(r.available, true);
  assert.deepEqual(r.problems, {
    hull: { health: 3000, max: 5000, low: true }, breaches: 2, shield: { value: 100, max: 600, low: true }, fires: 4, leaks: 2, fuelSegments: 1, components: 2,
    total: 1 + 2 + 1 + 4 + 2 + 1 + 2,
  });
});

test("outside a mission there is no ship to look at or repair", async () => {
  const w = world({ shipPresent: false });
  assert.deepEqual(await call(w.ex, "shipHealth"), { ok: true, available: false });
  assert.equal((await call(w.ex, "repairShip")).error.code, "NO_SHIP");
});

test("repairing is for the host only, and touches nothing otherwise", async () => {
  const w = world({ server: false });
  assert.equal((await call(w.ex, "repairShip")).error.code, "HOST_REQUIRED");
  assert.deepEqual(w.log, []);
});

test("everything is put right, and the report says what there was to put right", async () => {
  const w = world();
  const r = await call(w.ex, "repairShip");
  assert.equal(r.ok, true);
  assert.equal(r.found.total, 13);
  assert.equal(r.left.total, 0);
  assert.equal(w.hull, 5000);
  assert.equal(w.shield, 600);
  assert.equal(w.breached, 0);
  assert.equal(w.shipFires, 0);
  assert.equal(w.radiatorFire, false);
  assert.deepEqual(w.leaks, [1, 1, 1]);
  assert.deepEqual(w.fuel, [true, true, true]);
  assert.deepEqual(w.parts, ["Healthy", "Healthy", "Healthy"]);
});

test("the leaks are repaired by their full health, and the parts are set to Healthy (0)", async () => {
  const w = world();
  await call(w.ex, "repairShip");
  assert.deepEqual(w.log.filter((l) => l.startsWith("repair:")), ["repair:1000", "repair:1000"]);
  assert.deepEqual(w.log.filter((l) => l.startsWith("part")), ["part1:0", "part2:0"]);
  assert.deepEqual(w.log.filter((l) => l.startsWith("segment")), ["segment1"]);
});

test("a radiator fire is put out by its fire state; fires are stopped before anything else is repaired", async () => {
  const w = world();
  await call(w.ex, "repairShip");
  assert.equal(w.log[0], "stopfires");
  assert.ok(w.log.includes("stopfire"));
  assert.equal(w.radiatorFire, false);
});

test("the shield is filled only after the repaired parts have finished starting", async () => {
  const w = world();
  await call(w.ex, "repairShip");
  const shield = w.log.filter((l) => l.startsWith("shield:"));
  assert.equal(shield.length, 1);
  assert.equal(shield[0], "shield:000"); // no part was still starting when it was filled
  assert.ok(w.log.indexOf(shield[0]) > w.log.indexOf("part1:0"));
});

test("a healthy ship is left alone", async () => {
  const w = world();
  Object.assign(w, { hull: 5000, shield: 600, breached: 0, shipFires: 0, radiatorFire: false, leaks: [1, 1, 1], fuel: [true, true, true], parts: ["Healthy", "Healthy", "Healthy"] });
  const r = await call(w.ex, "repairShip");
  assert.equal(r.found.total, 0);
  assert.deepEqual(w.log, ["stopfires"]); // stopping fires is harmless and the only call made
});

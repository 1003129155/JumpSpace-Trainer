// Unit tests for agent/mission.js against stand-ins for the jump map, its nodes and the ship's jump controller (no game, no Frida).
import assert from "node:assert/strict";
import { test } from "node:test";

import { installMission } from "../agent/mission.js";
import { baseJB, call, fake, str } from "./helpers.mjs";

const MAP = "Keepsake.GameplayFeatures.JumpMap.JumpMap";
const SCENARIO = "Keepsake.HyperSpace.GameplayFeatures.Campaigns.Scenario.Scenario";

function world({ inMission = true, server = true, traveling = false } = {}) {
  const w = { jumped: [], completed: 0, traveling };
  const dest = (i) => ({ isNull: () => false, handle: { toString: () => `0xdest${i}` } });
  const spec = [
    { name: "起点", type: "起始区域", level: 0, pos: [0, 0], links: [1], current: true, visited: true },
    { name: "补给站", type: "商人", note: "换物品的机会", level: 1, pos: [4, 2], links: [0, 2], reachable: true },
    { name: "", type: "任务目标位置", level: 2, pos: [8, 0], links: [1], finale: true },
  ];
  const nodes = spec.map((s, i) => fake({
    get_DestinationLocation: () => dest(i),
    get_DisplayName: () => str(s.name), get_SubText: () => str(""), get_LevelIndex: () => s.level,
    get_JumpMapPosition: () => fake({ get_Value: () => fake({}, { x: s.pos[0], y: 0, z: s.pos[1] }) }),
    get_GetLinkedDestinationLocations: () => ({ isNull: () => false, method: (n) => ({ invoke: (k) => (n === "get_Count" ? s.links.length : dest(s.links[k])) }) }),
    get_IconData: () => fake({ get_LocationTypeName: () => str(s.type), get_Description: () => str(s.note || "JumpMap_NodeIcon_X") }),
    get_IsCurrent: () => !!s.current, get_IsReachable: () => !!s.reachable, get_Visited: () => !!s.visited,
    get_IsFinale: () => !!s.finale, get_IsExit: () => !!s.exit, get_IsConsumedByLavaWall: () => !!s.lava, get_Heat: () => 40.123,
  }));
  w.nodes = nodes;
  const list = { isNull: () => false, method: (n) => ({ invoke: (k) => (n === "get_Count" ? nodes.length : nodes[k]) }) };
  const map = fake({}, { m_DestinationNodes: list });
  const controller = fake({ get_IsTravelingToDestination: () => w.traveling, JumpTo: (d) => w.jumped.push(String(d.handle)) });
  const scenario = fake({ CompleteThisScenario: () => { w.completed++; } });
  const all = { [MAP]: inMission ? [map] : [], "Keepsake.Spaceship_JumpController": [controller], [SCENARIO]: inMission ? [scenario] : [] };
  w.JB = baseJB({
    U: { all: (cls) => all[cls] || [] },
    managedRows: (collection, fn) => {
      const out = [];
      const n = collection.method("get_Count").invoke();
      for (let i = 0; i < n; i++) out.push(fn(collection.method("get_Item").invoke(i)));
      return out;
    },
    requireServer: () => { if (!server) throw Object.assign(new Error("请在房主的电脑上运行刷道具工具"), { code: "HOST_REQUIRED" }); },
  });
  // the stand-ins above answer get_Item on the list through the same method name the agent uses
  list.method = (n) => ({ invoke: (k) => (n === "get_Count" ? nodes.length : nodes[k]) });
  w.ex = {};
  installMission(w.JB, w.ex);
  return w;
}

test("the jump map lists every node with its links, position and state", async () => {
  const w = world();
  const r = await call(w.ex, "jumpMap");
  assert.equal(r.available, true);
  assert.equal(r.traveling, false);
  assert.deepEqual(r.nodes.map((n) => n.name), ["起点", "补给站", "任务目标位置"]); // a node without a name of its own is called what its icon says
  assert.deepEqual(r.nodes.map((n) => n.type), ["起始区域", "商人", "任务目标位置"]);
  assert.deepEqual(r.nodes.map((n) => n.sub), ["", "换物品的机会", ""]); // the icon's placeholder text is not a description
  assert.deepEqual(r.nodes.map((n) => n.links), [[1], [0, 2], [1]]);
  assert.deepEqual(r.nodes[1].pos, [4, 2]);
  assert.equal(r.nodes[0].current, true);
  assert.equal(r.nodes[1].reachable, true);
  assert.equal(r.nodes[2].finale, true);
  assert.equal(r.nodes[2].reachable, false);
  assert.equal(r.nodes[0].heat, 40.12);
});

test("outside a mission there is no jump map", async () => {
  const w = world({ inMission: false });
  assert.deepEqual(await call(w.ex, "jumpMap"), { ok: true, available: false });
  assert.equal((await call(w.ex, "jumpToNode", 1)).error.code, "NO_MISSION");
  assert.equal((await call(w.ex, "completeMission")).error.code, "NO_MISSION");
});

test("the ship can be sent to a node that is not linked to the one it is at", async () => {
  const w = world();
  const r = await call(w.ex, "jumpToNode", 2); // 终点站: not reachable from 起点
  assert.equal(r.ok, true);
  assert.equal(r.node.name, "任务目标位置");
  assert.deepEqual(w.jumped, ["0xdest2"]);
});

test("jumping is refused for the node the ship is at, an unknown node and a jump in progress", async () => {
  const w = world();
  assert.equal((await call(w.ex, "jumpToNode", 0)).error.code, "ALREADY_THERE");
  assert.equal((await call(w.ex, "jumpToNode", 9)).error.code, "NODE_NOT_FOUND");
  w.traveling = true;
  assert.equal((await call(w.ex, "jumpToNode", 1)).error.code, "JUMP_IN_PROGRESS");
  assert.deepEqual(w.jumped, []);
});

test("the mission is completed through the game's own event, and only by the host", async () => {
  const w = world();
  assert.deepEqual(await call(w.ex, "completeMission"), { ok: true, completed: true });
  assert.equal(w.completed, 1);
  const guest = world({ server: false });
  assert.equal((await call(guest.ex, "completeMission")).error.code, "HOST_REQUIRED");
  assert.equal(guest.completed, 0);
});

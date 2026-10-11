const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function agent() {
  const source = fs.readFileSync(path.join(__dirname, "../agent.js"), "utf8")
    .replace(/^import .*$/gm, "")
    .split("// install the main-thread pump as soon as the agent is loaded")[0];
  const context = vm.createContext({ rpc: { exports: {} }, setTimeout });
  vm.runInContext(source, context);
  vm.runInContext("onMain = async (fn) => fn()", context);
  return context;
}

test("inventory reads sparse enum IDs and excludes Max", () => {
  const ctx = agent();
  const value = (name, id) => ({ toString: () => name, field: () => ({ value: id }) });
  ctx.U.cls = () => ({ fields: [["Weapon", 0], ["Utility", 2], ["Backpack", 3], ["Heavy", 4], ["Max", 5]]
    .map(([name, id]) => ({ name, isStatic: true, value: value(name, id) })) });
  const queried = [];
  const bb = { method: name => ({ invoke: (slot) => {
    if (name === "get_ActiveSlot") return value("Backpack", 3);
    if (name === "get_HeldEntry") return { isNull: () => true };
    assert.ok([0, 2, 3, 4].includes(slot), `invalid slot ${slot}`);
    if (name === "MaxEntriesInSlot") { queried.push(slot); return 1; }
    if (name === "GetEntryAtIndexInSlot") return { isNull: () => true };
    return 0;
  } }) };
  ctx.U.localPlayer = () => ({ field: () => ({ value: bb }) });
  const result = vm.runInContext("inventorySummary()", ctx);
  assert.deepEqual(queried, [0, 2, 3, 4]);
  assert.equal(result.activeId, 3);
  assert.equal(result.slotInfo.Backpack.id, 3);
  assert.deepEqual(Object.keys(result.slots), ["Weapon", "Utility", "Backpack", "Heavy"]);
});

test("give rejects malformed counts and modes before accessing the game", async () => {
  const ctx = agent();
  ctx.U.loaded = () => { throw new Error("must not access game"); };
  for (const count of ["2abc", "1.5", "0", "-1", "31", "NaN", "Infinity"]) {
    await assert.rejects(ctx.rpc.exports.give("Pizza", count, "face"), /count must be an integer/);
  }
  await assert.rejects(ctx.rpc.exports.give("Pizza", "1", "invalid"), /where must be/);
});

test("item resolution keeps exact matches and rejects ambiguous queries", () => {
  const ctx = agent();
  ctx.fixtures = [
    { name: "Pickupable_Pizza", display: "Pizza" },
    { name: "Pickupable_PizzaBox", display: "Pizza box" },
  ];
  vm.runInContext("catalog = () => fixtures", ctx);
  assert.equal(vm.runInContext('resolveItem("pizza").name', ctx), "Pickupable_Pizza");
  assert.throws(() => vm.runInContext('resolveItem("pickupable_pizz")', ctx), /ambiguous/);
  assert.throws(() => vm.runInContext('resolveItem("missing")', ctx), /no item matches/);
});

function spawnAgent(options = {}) {
  const ctx = agent();
  ctx.fixture = {
    network: { listening: true, server: true },
    player: { id: "network:42", name: "Target", downed: false, backpackAvailable: true },
    free: [0, 1], compatible: true,
    ...options,
  };
  vm.runInContext(`
    networkState = () => fixture.network;
    resolvePlayer = (selector) => {
      if (!selector) throw bridgeError("PLAYER_REQUIRED", "select a player");
      if (selector !== fixture.player.id) throw bridgeError("PLAYER_GONE", "player gone");
      return fixture.player;
    };
    playerRecord = p => p;
    resolveItem = () => ({ name: "Item", d: {} });
    itemDetails = it => ({ name: it.name });
    backpackSlot = () => 3;
    freeBackpackEntries = () => fixture.free;
    dropContext = () => ({});
    U.cls = () => ({ method: () => ({ invoke: () => fixture.compatible }) });
  `, ctx);
  return ctx;
}

test("full backpack rejection starts no generation", async () => {
  const ctx = spawnAgent({ free: [] });
  ctx.spawnBackpack = ctx.spawnGround = () => assert.fail("must not generate");
  const result = JSON.parse(await ctx.rpc.exports.spawn("Item", "1", "backpack", "network:42", "reject"));
  assert.equal(result.error.code, "BACKPACK_FULL");
  assert.equal(result.backpack + result.ground, 0);
});

test("overflow policy explicitly splits backpack and ground", async () => {
  const ctx = spawnAgent({ free: [0] });
  const targets = [];
  ctx.spawnBackpack = async selector => { targets.push(selector); ctx.fixture.free = []; };
  ctx.spawnGround = async selector => { targets.push(selector); };
  const result = JSON.parse(await ctx.rpc.exports.spawn("Item", "3", "backpack", "network:42", "ground"));
  assert.equal(result.ok, true);
  assert.equal(result.backpack, 1);
  assert.equal(result.ground, 2);
  assert.deepEqual(targets, ["network:42", "network:42", "network:42"]);
});

test("client mode, missing target, downed character and incompatible item are rejected", async () => {
  const cases = [
    [{ network: { listening: true, server: false } }, "network:42", "HOST_REQUIRED"],
    [{ network: { listening: false, server: false } }, "network:42", "NO_SESSION"],
    [{}, "", "PLAYER_REQUIRED"],
    [{}, "network:expired", "PLAYER_GONE"],
    [{ player: { id: "network:42", downed: true, backpackAvailable: true } }, "network:42", "PLAYER_DOWNED"],
    [{ player: { id: "network:42", downed: false, backpackAvailable: false } }, "network:42", "BACKPACK_UNAVAILABLE"],
    [{ compatible: false }, "network:42", "ITEM_INCOMPATIBLE"],
  ];
  for (const [options, target, code] of cases) {
    const ctx = spawnAgent(options);
    const result = JSON.parse(await ctx.rpc.exports.previewSpawn("Item", "1", "backpack", target, "reject"));
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
  }
});

test("target resolver never substitutes a respawned character", () => {
  const ctx = agent();
  const p = { id: "network:100", local: true, field: () => ({ value: { isNull: () => false } }) };
  ctx.U.all = () => [p];
  ctx.playerRecord = x => x;
  assert.equal(vm.runInContext('resolvePlayer("network:100")', ctx), p);
  assert.throws(() => vm.runInContext('resolvePlayer("network:99")', ctx), e => e.code === "PLAYER_GONE");
});

test("second spawn is rejected while a task is running", async () => {
  const ctx = spawnAgent();
  let release;
  ctx.spawnBackpack = () => new Promise(resolve => { release = resolve; });
  const first = ctx.rpc.exports.spawn("Item", "1", "backpack", "network:42", "reject");
  await new Promise(resolve => setImmediate(resolve));
  const second = JSON.parse(await ctx.rpc.exports.spawn("Item", "1", "backpack", "network:42", "reject"));
  assert.equal(second.error.code, "BUSY");
  release();
  assert.equal(JSON.parse(await first).ok, true);
});

test("batch stops and reports partial confirmed results on a later failure", async () => {
  const ctx = spawnAgent();
  let calls = 0;
  ctx.spawnGround = async () => {
    if (++calls === 2) throw Object.assign(new Error("unknown result"), { code: "SPAWN_TIMEOUT" });
  };
  const result = JSON.parse(await ctx.rpc.exports.spawn("Item", "3", "ground", "network:42", "reject"));
  assert.equal(result.ok, false);
  assert.equal(result.ground, 1);
  assert.equal(result.uncertain, true);
  assert.equal(calls, 2);
});

function gearToolbox(ctx, { checkThrows = null } = {}) {
  ctx.applied = [];
  ctx.JB = {
    gearAttachment: (it, spec) => ({
      check: () => { if (checkThrows) throw Object.assign(new Error(checkThrows), { code: "GEAR_INVALID" }); return { tier: spec.tier, level: 12, modules: 5 }; },
      apply: (persistent) => ctx.applied.push(persistent),
    }),
  };
}

test("attributes are checked before anything is spawned and handed to every copy", async () => {
  const ctx = spawnAgent({ free: [0] });
  gearToolbox(ctx);
  const attaches = [];
  ctx.spawnBackpack = async (selector, name, attach) => { attaches.push(["backpack", attach]); ctx.fixture.free = []; };
  ctx.spawnGround = async (selector, name, attach) => { attaches.push(["ground", attach]); };
  const result = JSON.parse(await ctx.rpc.exports.spawn("Item", "2", "backpack", "network:42", "ground", { tier: 3, level: "max" }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.gear, { tier: 3, level: 12, modules: 5 });
  assert.deepEqual(attaches.map((a) => a[0]), ["backpack", "ground"]);
  for (const [, attach] of attaches) assert.equal(typeof attach, "function");
  attaches[1][1]({ id: "pickup" });
  assert.deepEqual(ctx.applied, [{ id: "pickup" }]);
});

test("a plain spawn passes no attributes", async () => {
  const ctx = spawnAgent();
  let seen = "unset";
  ctx.spawnGround = async (selector, name, attach) => { seen = attach; };
  const result = JSON.parse(await ctx.rpc.exports.spawn("Item", "1", "ground", "network:42", "reject"));
  assert.equal(result.ok, true);
  assert.ok(!seen, "no attach function without attributes");
  assert.equal(result.gear, undefined);
});

test("attributes the game would refuse stop the spawn before it starts", async () => {
  const ctx = spawnAgent();
  gearToolbox(ctx, { checkThrows: "属性不符合游戏规则：词条重复了" });
  ctx.spawnBackpack = ctx.spawnGround = () => assert.fail("must not generate");
  const result = JSON.parse(await ctx.rpc.exports.spawn("Item", "1", "ground", "network:42", "reject", { tier: 1 }));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "GEAR_INVALID");
  assert.equal(result.ground + result.backpack, 0);
  const preview = JSON.parse(await ctx.rpc.exports.previewSpawn("Item", "1", "ground", "network:42", "reject", { tier: 1 }));
  assert.equal(preview.ok, false);
  assert.equal(preview.error.code, "GEAR_INVALID");
});

test("an old toolbox that cannot do attributes says so instead of spawning a plain item", async () => {
  const ctx = spawnAgent();
  ctx.JB = {};
  ctx.spawnGround = () => assert.fail("must not generate");
  const result = JSON.parse(await ctx.rpc.exports.spawn("Item", "1", "ground", "network:42", "reject", { tier: 1 }));
  assert.equal(result.error.code, "GEAR_UNAVAILABLE");
});

function profileAgent(unlocked = false) {
  const ctx = agent();
  const state = { unlocked, writes: [], saveId: "profile-a", loads: 0 };
  ctx.Il2Cpp = { string: x => x };
  const collection = { method: name => ({ invoke: () => name === "get_Count" ? (state.unlocked ? 1 : 0) : { method: () => ({ invoke: () => ({ content: "recipe-guid" }) }) } }) };
  const manager = { method: name => ({ invoke: (...args) => {
    if (name === "HasUnlockedAsset") return state.unlocked;
    if (name === "get_UnlockedCraftables") return collection;
    if (name === "SetAssetUnlocked") { state.writes.push(args); state.unlocked = true; return; }
    assert.fail(`unexpected method ${name}`);
  } }) };
  ctx.localProfile = () => ({ manager, player: { id: "network:42" }, saveId: state.saveId });
  ctx.resourceIndex = () => ({ entries: [{ category: "craftable", key: "recipe-guid", name: "Craftable_Weapon" }, { category: "shipBlueprint", key: "ship-guid", name: "Ship" }] });
  ctx.U.loaded = () => state.loads || state.unlocked ? [{ method: () => ({ invoke: () => ({ content: "recipe-guid" }) }) }] : [];
  ctx.recipeTarget = recipe => ({ ...recipe, targetGuid: "target-guid" });
  ctx.loadCatalogAsset = async e => { assert.equal(e.category, "craftable"); state.loads++; };
  return { ctx, state };
}

test("unlock writes only the selected recipe and requests autosave", async () => {
  const { ctx, state } = profileAgent();
  const result = JSON.parse(await ctx.rpc.exports.unlockBlueprint("Craftable_Weapon", "local"));
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.deepEqual(state.writes, [["target-guid", true, true]]);
  assert.equal(state.loads, 1);
});

test("already unlocked recipes do not load or write again", async () => {
  const { ctx, state } = profileAgent(true);
  const result = JSON.parse(await ctx.rpc.exports.unlockBlueprint("recipe-guid", "local"));
  assert.equal(result.changed, false);
  assert.equal(state.loads, 0);
  assert.equal(state.writes.length, 0);
});

test("recipe unlock rejects ship resources and a profile change during loading", async () => {
  const { ctx, state } = profileAgent();
  let result = JSON.parse(await ctx.rpc.exports.unlockBlueprint("ship-guid", "local"));
  assert.equal(result.ok, false);
  ctx.loadCatalogAsset = async () => { state.saveId = "profile-b"; };
  result = JSON.parse(await ctx.rpc.exports.unlockBlueprint("recipe-guid", "local"));
  assert.equal(result.error.code, "PROFILE_CHANGED");
  assert.equal(state.writes.length, 0);
});

test("profile actions cannot target a remote player", () => {
  const ctx = agent();
  ctx.resolvePlayer = () => ({});
  ctx.U.isLocal = () => false;
  assert.throws(() => vm.runInContext('localProfile("network:remote")', ctx), e => e.code === "LOCAL_PROFILE_ONLY");
});

test("blueprint save uses the planned empty slot and persists after readback", async () => {
  const ctx = agent();
  const calls = [];
  const data = { field: () => ({ value: { content: "instance-guid" } }) };
  const manager = { method: name => ({ invoke: (...args) => {
    calls.push([name, ...args]);
    if (name === "TrySetBlueprintInSlot") return true;
    if (name === "GetBlueprintInSlot") return { isNull: () => false, field: () => ({ value: data }) };
  } }) };
  ctx.blueprintPlan = () => ({ manager, data, category: "category-guid", slot: 2, alreadySaved: false });
  ctx.generatedDetails = () => ({ instanceGuid: "instance-guid" });
  const result = JSON.parse(await ctx.rpc.exports.addBlueprint("instance-guid", "local"));
  assert.equal(result.ok, true);
  assert.equal(calls[0][0], "TrySetBlueprintInSlot");
  assert.equal(calls[0][1], data);
  assert.deepEqual(calls[0].slice(2), ["category-guid", 2]);
  assert.equal(calls.at(-1)[0], "SaveDataToCloud");
});

test("blueprint capacity rejection does not write or save", async () => {
  const ctx = agent();
  ctx.blueprintPlan = () => { throw Object.assign(new Error("full"), { code: "BLUEPRINT_FULL" }); };
  const result = JSON.parse(await ctx.rpc.exports.addBlueprint("instance-guid", "local"));
  assert.equal(result.error.code, "BLUEPRINT_FULL");
});

test("a flag on the recipe itself cannot be reported as unlocked", () => {
  const ctx = agent();
  ctx.Il2Cpp = { string: x => x };
  const manager = { method: name => ({ invoke: () => name === "HasUnlockedAsset" ? true : { method: () => ({ invoke: () => 0 }) } }) };
  ctx.testManager = manager;
  assert.equal(vm.runInContext('recipeUnlocked(testManager, "wrong-recipe-flag")', ctx), false);
});

test("ship unlock is idempotent when the ship is already owned", async () => {
  const ctx = agent();
  ctx.prepareShip = async () => ({ ship: { key: "ship-guid" }, player: { id: "network:42" }, alreadyOwned: true });
  ctx.loadCatalogAsset = () => assert.fail("must not load or add an owned ship");
  const result = JSON.parse(await ctx.rpc.exports.unlockShip("Ship", "local"));
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(result.confirmed, true);
});

test("a new ship must run the ownership handler after setting its unlock flag", async () => {
  const ctx = agent();
  const calls = [];
  let owned = false;
  const asset = { method: () => ({ invoke: () => ({ content: "ship-guid" }) }) };
  const manager = { method: name => ({ invoke: (...args) => {
    calls.push([name, ...args]);
    if (name === "HasUnlockedAsset") return false;
    if (name === "HandleUnlockedNewSpaceshipBlueprint") owned = true;
  } }) };
  ctx.Il2Cpp = { string: x => x };
  ctx.prepareShip = async () => ({ ship: { key: "ship-guid" }, player: { id: "network:42" }, saveId: "save", alreadyOwned: false });
  ctx.loadCatalogAsset = async () => {};
  ctx.localProfile = () => ({ manager, saveId: "save" });
  ctx.shipOwned = () => owned;
  ctx.U.loaded = () => [asset];
  const result = JSON.parse(await ctx.rpc.exports.unlockShip("Ship", "local"));
  assert.equal(result.ok, true);
  assert.equal(result.confirmed, true);
  assert.deepEqual(calls.find(c => c[0] === "SetAssetUnlocked"), ["SetAssetUnlocked", "ship-guid", true, true]);
  assert.deepEqual(calls.find(c => c[0] === "HandleUnlockedNewSpaceshipBlueprint"), ["HandleUnlockedNewSpaceshipBlueprint", asset, true]);
});

// ------------------------------------------------------------------ native pump gate
// The hook itself is native; JS only shares three words of memory with it (job flag, next ticker deadline, call counter).
function gatedAgent() {
  const source = fs.readFileSync(path.join(__dirname, "../agent.js"), "utf8")
    .replace(/^import .*$/gm, "")
    .split("// install the main-thread pump as soon as the agent is loaded")[0];
  const context = vm.createContext({ rpc: { exports: {} }, setTimeout, clearTimeout, Process: { getCurrentThreadId: () => 1 } });
  vm.runInContext(source, context);
  const memory = { pending: [], nextTick: [], calls: 123 };
  context.memory = memory;
  vm.runInContext(`pumpHook = {};
    pumpGate = { pending: { writeS32: v => memory.pending.push(v) }, nextTick: { writeS64: v => memory.nextTick.push(v) }, calls: { readU32: () => memory.calls } };`, context);
  return { ctx: context, memory };
}

test("a queued job raises the native flag and the main thread lowers it again", async () => {
  const { ctx, memory } = gatedAgent();
  const result = ctx.onMain(() => 7);
  assert.deepEqual(memory.pending, [1]);
  vm.runInContext("drain()", ctx); // the game's main thread arrives
  assert.equal(await result, 7);
  assert.deepEqual(memory.pending, [1, 0]);
});

test("a hit with nothing queued runs no job and no JS beyond the flag reset", () => {
  const { ctx, memory } = gatedAgent();
  vm.runInContext("drain()", ctx);
  assert.deepEqual(memory.pending, [0]);
  assert.equal(vm.runInContext("jobs.length", ctx), 0);
});

test("ticker deadlines are published to the native side and cleared again", () => {
  const { ctx, memory } = gatedAgent();
  let runs = 0;
  ctx.tick = () => { runs++; };
  vm.runInContext('addTicker("t", 100, tick)', ctx);
  assert.equal(memory.nextTick.at(-1), 1); // brand new: due immediately (0 would mean "none")
  vm.runInContext("drain()", ctx); // notified because the ticker is due
  assert.equal(runs, 1);
  assert.ok(memory.nextTick.at(-1) > Date.now() - 50, "deadline moved into the future");
  assert.ok(memory.nextTick.at(-1) <= Date.now() + 150);
  vm.runInContext('removeTicker("t")', ctx);
  assert.equal(memory.nextTick.at(-1), 0); // nothing due: the hook stays silent
});

test("the call counter comes from the native side when the gate is active", () => {
  const { ctx } = gatedAgent();
  assert.equal(vm.runInContext("pumpCount()", ctx), 123);
  vm.runInContext("pumpGate = null; pumpTicks = 5", ctx);
  assert.equal(vm.runInContext("pumpCount()", ctx), 5); // JS-hook fallback counts for itself
});

test("without the gate nothing touches native memory", async () => {
  const { ctx } = gatedAgent();
  vm.runInContext("pumpGate = null", ctx);
  const result = ctx.onMain(() => "ok");
  vm.runInContext("drain()", ctx);
  assert.equal(await result, "ok");
  assert.equal(vm.runInContext("pumpTicks", ctx), 1);
});

// ------------------------------------------------------------------ leaving the game safely
// Closing the game while the hook ran JS on the main thread crashed it. The native hook stops calling JS as soon as the
// game's quit flag is set; the agent publishes where that flag lives, and the daemon can put things back afterwards.
function quitAgent(options = {}) {
  const { ctx, memory } = gatedAgent();
  const events = [];
  ctx.events = events;
  ctx.quitFlag = options.quitFlag ?? false;
  const coordinator = {
    handle: { add: (n) => ({ toString: () => "object+" + n }) },
    field: () => ({ offset: 0x29, get value() { return ctx.quitFlag; } }),
  };
  ctx.coordinators = options.coordinators ?? [coordinator];
  memory.quitFlag = [];
  memory.disabled = 0;
  vm.runInContext(`
    pumpHook = { detach() { events.push("detach"); } };
    pumpState = "running";
    pumpGate.quitFlag = { writePointer: (p) => memory.quitFlag.push(String(p)), readPointer: () => ({ isNull: () => memory.quitFlag.at(-1) === undefined || memory.quitFlag.at(-1) === 'null', readU8: () => 0 }) };
    pumpGate.disabled = { readS32: () => memory.disabled, writeS32: (v) => { memory.disabled = v; } };
    NULL = "null";
    U.cls = () => ({ method: () => ({ invoke: () => true }) });   // op_Implicit: the Unity object is still alive
    U.all = (name) => { events.push("scan " + name); return coordinators; };
  `, ctx);
  return { ctx, memory, events };
}

test("the quit flag's address is found once and handed to the native hook", () => {
  const { ctx, memory, events } = quitAgent();
  vm.runInContext("checkQuit()", ctx);
  vm.runInContext("checkQuit()", ctx);
  assert.deepEqual(events, ["scan Keepsake.Framework.Lifecycle.ApplicationQuitCoordinator"]); // cached afterwards
  assert.deepEqual(memory.quitFlag, ["object+41"]); // the object plus the field offset 0x29, published a single time
  assert.equal(vm.runInContext("pumpState", ctx), "running");
  assert.ok(vm.runInContext("pumpHook", ctx));
});

test("when the native hook has silenced itself the agent reports the game as quitting", () => {
  const { ctx, memory } = quitAgent();
  assert.equal(JSON.parse(ctx.rpc.exports.pumpStatus()).state, "running");
  memory.disabled = 1;
  assert.equal(JSON.parse(ctx.rpc.exports.pumpStatus()).state, "quitting");
});

test("if a tick happens to see the quit flag first, the hook is removed from the pump", () => {
  const { ctx, events } = quitAgent();
  vm.runInContext("checkQuit()", ctx);
  ctx.quitFlag = true;
  vm.runInContext("checkQuit()", ctx);
  assert.deepEqual(events.filter((e) => e === "detach"), ["detach"]);
  assert.equal(vm.runInContext("pumpState", ctx), "quitting");
  assert.equal(vm.runInContext("pumpHook", ctx), null);
  assert.equal(vm.runInContext("pumpGate", ctx), null);
  assert.equal(vm.runInContext("retiredGates.length", ctx), 1); // the native memory is kept, not freed under a retiring trampoline
  vm.runInContext("checkQuit()", ctx); // and it is only done once
  assert.equal(events.filter((e) => e === "detach").length, 1);
});

test("jobs sent while the game quits fail with a clear reason", async () => {
  const { ctx } = quitAgent({ quitFlag: true });
  vm.runInContext("checkQuit(); checkQuit()", ctx);
  await assert.rejects(ctx.onMain(() => 1), /the game is quitting/);
});

test("a missing quit coordinator is searched for at most every two seconds and publishes no flag", () => {
  const { ctx, events, memory } = quitAgent({ coordinators: [] });
  for (let i = 0; i < 5; i++) vm.runInContext("checkQuit()", ctx);
  assert.equal(events.filter((e) => e.startsWith("scan")).length, 1);
  assert.deepEqual(memory.quitFlag, ["null"]);
});

test("a cancelled quit: resumePump re-enables the silenced hook instead of reinstalling it", async () => {
  const { ctx, memory, events } = quitAgent();
  vm.runInContext("checkQuit()", ctx);
  memory.disabled = 1; // the native side silenced itself
  memory.quitFlag.length = 0;
  assert.equal(await ctx.rpc.exports.resumePump(), "re-enabled");
  assert.equal(memory.disabled, 0);
  assert.deepEqual(memory.quitFlag, ["null"]); // stale until the next tick finds the coordinator again
  vm.runInContext("checkQuit()", ctx);
  assert.deepEqual(memory.quitFlag, ["null", "object+41"]);
  assert.ok(!events.includes("detach"));
});

test("quiesce takes the hook out from inside the pump and reports it", async () => {
  const { ctx, events } = quitAgent();
  ctx.setTimeout = (fn, ms) => { if (ms < 1000) setImmediate(fn); return 0; }; // short settle delays pass at once; the 15 s job timeout never fires
  const done = ctx.rpc.exports.quiesce();
  assert.deepEqual(events, []); // nothing yet: the work waits for the game's main thread
  vm.runInContext("drain()", ctx);
  assert.equal(await done, "quiesced");
  assert.deepEqual(events, ["detach"]);
  assert.equal(vm.runInContext("pumpState", ctx), "quiesced");
  assert.equal(await ctx.rpc.exports.quiesce(), "no hook");
});

test("resumePump installs the hook again with the arguments it was first given", async () => {
  const { ctx } = quitAgent();
  const calls = [];
  vm.runInContext("pumpArgs = ['UniTask', 'Some.Runner', 'RunCore', 0]; removePumpHook('quiesced')", ctx);
  ctx.rpc.exports.installPump = async (...args) => { calls.push(args); return "installed"; };
  assert.equal(await ctx.rpc.exports.resumePump(), "installed");
  assert.deepEqual(calls, [["UniTask", "Some.Runner", "RunCore", 0]]);
  vm.runInContext("pumpHook = {}", ctx);
  assert.equal(await ctx.rpc.exports.resumePump(), "already running");
});

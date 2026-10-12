// Frida agent for Jump Space (Unity 6000.3 / IL2CPP). Loaded by daemon.py.
import "frida-il2cpp-bridge";
import { installStatus } from "./agent/status.js";
import { installProgression } from "./agent/progression.js";
import { installCheats } from "./agent/cheats.js";
import { installGear } from "./agent/gear.js";
import { installItems } from "./agent/items.js";
import { installUnlocks } from "./agent/unlocks.js";
import { installVentures } from "./agent/ventures.js";
import { installLoot } from "./agent/loot.js";
import { installMission } from "./agent/mission.js";
import { installShipRepair } from "./agent/shiprepair.js";

// ---------------------------------------------------------------- helpers
function ser(v) {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  const t = typeof v;
  if (t === "string") return v;
  if (t === "number" || t === "boolean") return String(v);
  if (t === "bigint") return v.toString();
  try {
    return JSON.stringify(v, (k, x) => (typeof x === "bigint" ? x.toString() : x), 1);
  } catch (e) {
    return String(v);
  }
}

const safe = (f, dflt = "?") => {
  try {
    return f();
  } catch (e) {
    return dflt;
  }
};

function describeClass(k) {
  const lines = [];
  const kind = k.isEnum ? "enum" : k.isInterface ? "interface" : k.isStruct ? "struct" : "class";
  const parent = safe(() => (k.parent ? k.parent.fullName : ""), "");
  const ifaces = safe(() => k.interfaces.map((i) => i.fullName).join(", "), "");
  lines.push(`${kind} ${k.fullName}${parent ? " : " + parent : ""}${ifaces ? " | " + ifaces : ""}  // ${k.assemblyName}`);
  for (const f of safe(() => k.fields, [])) {
    lines.push(`  ${f.isStatic ? "static " : ""}${safe(() => f.type.name)} ${f.name}; // +0x${safe(() => f.offset.toString(16))}`);
  }
  for (const m of safe(() => k.methods, [])) {
    const ps = safe(() => m.parameters.map((p) => `${p.type.name} ${p.name}`).join(", "), "?");
    lines.push(`  ${m.isStatic ? "static " : ""}${safe(() => m.returnType.name)} ${m.name}(${ps}); // rva ${safe(() => m.relativeVirtualAddress)}`);
  }
  return lines.join("\n") + "\n\n";
}

// Class handles stay valid for the life of the process; cache successful lookups
// (status polling and the per-frame locks resolve the same few classes constantly).
const classCache = new Map();

function findClass(name) {
  const hit = classCache.get(name);
  if (hit) return hit;
  // exact full name first, then case-insensitive suffix match
  for (const a of Il2Cpp.domain.assemblies) {
    const c = a.image.tryClass(name);
    if (c) {
      classCache.set(name, c);
      return c;
    }
  }
  const lower = name.toLowerCase();
  for (const a of Il2Cpp.domain.assemblies) {
    for (const c of a.image.classes) {
      if (c.fullName.toLowerCase() === lower || c.name.toLowerCase() === lower) {
        classCache.set(name, c);
        return c;
      }
    }
  }
  return null;
}

// ------------------------------------------------- main-thread job pump
// Unity APIs may only be called from the main thread. We hook a method that
// the engine/game calls once per frame on the main thread and drain a queue
// of jobs from inside that hook.
const jobs = [];
let pumpHook = null;
let pumpTarget = null;
let pumpTicks = 0;
let pumpThread = -1;

// The hooked method is hit ~3500 times a second (UniTask runs dozens of runners per frame), so entering JS on
// every hit would put the Frida runtime on the game's main thread thousands of times per second for nothing.
// The hook is therefore a tiny native function (CModule) that only calls back into JS when a job is waiting or
// a ticker is due. `pending`, `next_tick` and `calls` are the shared memory it reads. If the native module
// cannot be built the plain JS hook is used instead (same behaviour, just much busier).
let pumpGate = null;
const PUMP_C_SOURCE = `
#include <gum/guminterceptor.h>

extern volatile gint pending;
extern volatile gint64 next_tick;
extern volatile guint32 calls;
extern volatile gint disabled;
extern volatile gpointer quit_flag;
extern void notify (void);
extern void GetSystemTimeAsFileTime (guint64 * ft);

void
onEnter (GumInvocationContext * ic)
{
  calls++;

  if (disabled != 0)
    return;

  /* The game started quitting: from now on no JS may run on this thread (see "leaving the game safely"). */
  if (quit_flag != NULL && *(volatile guint8 *) quit_flag != 0)
  {
    disabled = 1;
    return;
  }

  if (pending != 0)
  {
    notify ();
    return;
  }

  if (next_tick != 0)
  {
    guint64 ft;

    GetSystemTimeAsFileTime (&ft);
    if ((gint64) (ft / 10000) - 11644473600000LL >= next_tick)
      notify ();
  }
}
`;

function createPumpGate() {
  const pending = Memory.alloc(4);
  const nextTick = Memory.alloc(8);
  const calls = Memory.alloc(4);
  const disabled = Memory.alloc(4);
  const quitFlag = Memory.alloc(Process.pointerSize);
  pending.writeS32(0);
  nextTick.writeS64(0);
  calls.writeU32(0);
  disabled.writeS32(0);
  quitFlag.writePointer(NULL);
  const notify = new NativeCallback(() => { drain(); }, "void", []);
  const module = new CModule(PUMP_C_SOURCE, {
    pending, next_tick: nextTick, calls, disabled, quit_flag: quitFlag, notify,
    GetSystemTimeAsFileTime: Process.getModuleByName("kernel32.dll").getExportByName("GetSystemTimeAsFileTime"),
  });
  return { module, pending, nextTick, calls, disabled, quitFlag, notify }; // keep every piece referenced for as long as the hook lives
}

// ---- leaving the game safely ------------------------------------------------------------------------
// Closing the game while this hook ran JavaScript on the main thread crashed it inside frida-agent.dll every time
// (three times in a row; a bare native hook that runs no JS, and no hook at all, exit cleanly). So the moment the
// game starts its own quit sequence the native hook stops calling into JS — it reads the game's `m_QuitInProgress`
// byte straight from memory on every hit — and the daemon puts things back if the quit turns out to be cancelled.
// Separately, the daemon asks for `quiesce` (hook removed from the main thread) before it unloads this script.
let pumpState = "stopped"; // stopped | running | quitting | quiesced
let pumpArgs = null;
const retiredGates = []; // native memory of removed hooks stays allocated: Gum may still be retiring the trampoline

function removePumpHook(state) {
  if (!pumpHook) return false;
  const hook = pumpHook;
  pumpHook = null;
  if (pumpGate) retiredGates.push(pumpGate);
  pumpGate = null;
  pumpState = state;
  hook.detach();
  return true;
}

let quitCoordinator = null;
let quitScanAt = 0;
let quitFlagPublished = null;

// The game's ApplicationQuitCoordinator, if it exists and is alive (rescanned at most every two seconds).
function liveQuitCoordinator() {
  if (quitCoordinator) {
    try {
      if (!U.cls("UnityEngine.Object").method("op_Implicit").invoke(quitCoordinator)) quitCoordinator = null;
    } catch (e) {
      quitCoordinator = null;
    }
  }
  if (!quitCoordinator) {
    const now = Date.now();
    if (now - quitScanAt < 2000) return null; // scanning every tick would be wasteful
    quitScanAt = now;
    quitCoordinator = U.all("Keepsake.Framework.Lifecycle.ApplicationQuitCoordinator", true)[0] || null;
  }
  return quitCoordinator;
}

// Tell the native hook where the quit flag lives (or that there is none). The flag is a plain byte inside a
// managed object; the garbage collector does not move objects, and the pointer is refreshed every tick.
function publishQuitFlag(coordinator) {
  if (!pumpGate) return;
  const address = coordinator ? coordinator.handle.add(coordinator.field("m_QuitInProgress").offset) : NULL;
  const key = address.toString();
  if (key === quitFlagPublished) return;
  pumpGate.quitFlag.writePointer(address);
  quitFlagPublished = key;
}

function checkQuit() {
  if (pumpState !== "running") return;
  const coordinator = liveQuitCoordinator();
  publishQuitFlag(coordinator);
  // normally the native hook has already noticed; this is the fallback when a tick happens to come first
  if (coordinator && coordinator.field("m_QuitInProgress").value) {
    console.log("the game is quitting: removing the hook so the exit is clean");
    removePumpHook("quitting");
  }
}

// for diagnostics: is the native hook watching the game's quit flag, and what does it currently read?
function quitInfo() {
  if (!pumpGate) return null;
  const flag = pumpGate.quitFlag.readPointer();
  return { watching: !flag.isNull(), flagByte: flag.isNull() ? null : flag.readU8(), silenced: pumpGate.disabled.readS32() !== 0 };
}

// what the hook is doing, as far as the daemon is concerned
function pumpStateNow() {
  if (pumpState === "running" && pumpGate && pumpGate.disabled.readS32() !== 0) return "quitting";
  return pumpState;
}

// how many times the hooked method has run (native counter when gated)
function pumpCount() {
  return pumpGate ? pumpGate.calls.readU32() : pumpTicks;
}

// publish the next ticker deadline to the native side (0 = none)
function syncGate() {
  if (pumpGate) pumpGate.nextTick.writeS64(nextTickAt === NEVER ? 0 : Math.max(1, nextTickAt));
}

// Recurring main-thread work (cheat "locks"). Each ticker is a cheap function
// run at most every `every` ms from inside the pump hook.
const tickers = new Map();
// NOTE: the global `Infinity` is NaN in this Frida JS runtime (and so is 1/0),
// so "never" is a large finite number instead.
const NEVER = Number.MAX_SAFE_INTEGER;
let nextTickAt = NEVER;
let draining = false;

function recalcTickers() {
  let next = NEVER;
  for (const t of tickers.values()) next = Math.min(next, t.next);
  nextTickAt = next;
  syncGate();
}

function addTicker(name, every, fn) {
  tickers.set(name, { name, every, fn, next: 0, runs: 0, errors: 0, lastError: null });
  recalcTickers();
}

function removeTicker(name) {
  tickers.delete(name);
  recalcTickers();
}

function runTickers() {
  const now = Date.now();
  for (const t of tickers.values()) {
    if (now < t.next) continue;
    t.next = now + t.every;
    try {
      t.fn();
      t.runs++;
      t.errors = 0;
    } catch (e) {
      t.lastError = String(e && e.message || e);
      if (++t.errors === 20) console.log(`ticker ${t.name} keeps failing: ${t.lastError}`);
      if (t.errors >= 20) t.next = now + 5000; // back off instead of spamming a broken target
    }
  }
  recalcTickers();
}

function drain() {
  if (pumpGate) pumpGate.pending.writeS32(0); // everything queued so far is taken below
  else pumpTicks++;
  if (draining) return;
  const tickDue = tickers.size > 0 && Date.now() >= nextTickAt;
  if (jobs.length === 0 && !tickDue) return;
  draining = true;
  try {
    if (jobs.length > 0) {
      pumpThread = Process.getCurrentThreadId();
      const batch = jobs.splice(0, jobs.length);
      for (const j of batch) {
        try {
          j.resolve(j.fn());
        } catch (e) {
          j.reject(e);
        }
      }
    }
    if (tickDue || (tickers.size > 0 && Date.now() >= nextTickAt)) runTickers();
  } finally {
    draining = false;
  }
}

function onMain(fn, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (!pumpHook) return reject(new Error(pumpState === "quitting" ? "the game is quitting" : "main-thread pump not installed"));
    const job = { fn, resolve, reject };
    jobs.push(job);
    if (pumpGate) pumpGate.pending.writeS32(1);
    setTimeout(() => {
      const i = jobs.indexOf(job);
      if (i >= 0) {
        jobs.splice(i, 1);
        reject(new Error("timed out waiting for the Unity main thread (is the game paused / minimized?)"));
      }
    }, timeoutMs);
  });
}

// --------------------------------------------------------------- RPC API
rpc.exports = {
  ping() {
    return "pong";
  },

  async info() {
    return Il2Cpp.perform(() => {
      const list = Il2Cpp.domain.assemblies.map((a) => `${a.name} (${a.image.classCount})`);
      return ser({
        unity: Il2Cpp.unityVersion,
        module: Il2Cpp.module.name,
        assemblies: list.length,
        list,
        pump: pumpTarget,
        pumpTicks: pumpCount(),
      });
    }, "free");
  },

  // regex over class full names; returns "asm | FullName" lines
  async classes(pattern, limit) {
    return Il2Cpp.perform(() => {
      const re = new RegExp(pattern, "i");
      const max = Number(limit) || 200;
      const out = [];
      for (const a of Il2Cpp.domain.assemblies) {
        for (const c of a.image.classes) {
          if (re.test(c.fullName)) {
            out.push(`${a.name} | ${c.fullName}`);
            if (out.length >= max) return out.join("\n");
          }
        }
      }
      return out.join("\n");
    }, "free");
  },

  async describe(name) {
    return Il2Cpp.perform(() => {
      const k = findClass(name);
      if (!k) return `class not found: ${name}`;
      return describeClass(k);
    }, "free");
  },

  // writes a text dump (fields + methods) of one assembly, or of every class matching `filter`
  async dumpAssembly(asmName, path, filter) {
    return Il2Cpp.perform(() => {
      const asm = Il2Cpp.domain.assembly(asmName);
      const re = filter ? new RegExp(filter, "i") : null;
      const f = new File(path, "w");
      let n = 0;
      for (const k of asm.image.classes) {
        if (re && !re.test(k.fullName)) continue;
        try {
          f.write(describeClass(k));
          n++;
        } catch (e) {
          f.write(`// error ${k.fullName}: ${e}\n\n`);
        }
      }
      f.flush();
      f.close();
      return `wrote ${n} classes to ${path}`;
    }, "free");
  },

  // run arbitrary JS on the Frida thread (no Unity main-thread guarantees)
  async evalFree(code) {
    return Il2Cpp.perform(() => ser((0, eval)(code)), "free");
  },

  // hook a per-frame main-thread method and start pumping jobs from it
  async installPump(asm, cls, method, argc) {
    return Il2Cpp.perform(() => {
      if (pumpHook) removePumpHook("stopped");
      pumpArgs = [asm, cls, method, argc];
      const m = Il2Cpp.domain.assembly(asm).image.class(cls).method(method, Number(argc) || 0);
      pumpTarget = `${cls}::${method} @ ${m.virtualAddress}`;
      pumpTicks = 0;
      let gate = null;
      try {
        gate = createPumpGate();
      } catch (e) {
        console.log("native pump gate unavailable, using the JS hook: " + e);
      }
      if (gate) {
        pumpGate = gate;
        quitFlagPublished = null; // a fresh gate knows nothing yet
        syncGate();
        pumpHook = Interceptor.attach(m.virtualAddress, { onEnter: gate.module.onEnter });
        pumpTarget += " (native gate)";
      } else {
        pumpHook = Interceptor.attach(m.virtualAddress, {
          onEnter() {
            drain();
          },
        });
      }
      pumpState = "running";
      if (!tickers.has("quitWatch")) addTicker("quitWatch", 100, checkQuit);
      return pumpTarget;
    }, "free");
  },

  // Take the hook out while the main thread can still cooperate. The daemon calls this before it unloads or
  // replaces the script; afterwards nothing in the game points into this script any more.
  async quiesce() {
    if (!pumpHook) return "no hook";
    await onMain(() => { removePumpHook("quiesced"); });
    await delay(500); // let Gum finish retiring the trampoline
    return "quiesced";
  },

  // Put the hook back after the game cancelled a quit (the daemon checks pumpStatus().state).
  async resumePump() {
    if (pumpHook && pumpGate && pumpGate.disabled.readS32() !== 0) {
      // the native hook silenced itself because the game began to quit, and the quit was cancelled
      pumpGate.quitFlag.writePointer(NULL);
      quitFlagPublished = null;
      pumpGate.disabled.writeS32(0);
      return "re-enabled";
    }
    if (pumpHook) return "already running";
    if (!pumpArgs) throw new Error("the pump was never installed");
    return rpc.exports.installPump(...pumpArgs);
  },

  pumpStatus() {
    return ser({
      target: pumpTarget, state: pumpStateNow(), ticks: pumpCount(), gate: !!pumpGate, quit: quitInfo(), queued: jobs.length, thread: pumpThread,
      tickers: [...tickers.values()].map((t) => ({ name: t.name, every: t.every, next: t.next, runs: t.runs, errors: t.errors, lastError: t.lastError })),
      nextTickAt: nextTickAt === NEVER ? null : nextTickAt, draining, now: Date.now(),
    });
  },

  // run arbitrary JS on the Unity main thread (needs installPump first)
  async evalMain(code) {
    return onMain(() => ser((0, eval)(code)));
  },
};

// ------------------------------------------------------ helpers for snippets
// Everything below is exposed on globalThis so code sent through evalMain /
// evalFree can use it directly.
const U = {
  cls(name) {
    const c = findClass(name);
    if (!c) throw new Error("class not found: " + name);
    return c;
  },
  // Il2Cpp.Array<Il2Cpp.Object> -> JS array
  list(arr) {
    const out = [];
    for (let i = 0; i < arr.length; i++) out.push(arr.get(i));
    return out;
  },
  // live scene objects of a type (main thread only)
  all(className, includeInactive = true) {
    const T = U.cls(className).type.object;
    return U.list(U.cls("UnityEngine.Object").method("FindObjectsOfType", 2).invoke(T, includeInactive));
  },
  // everything of a type currently in memory, including assets / prefabs (main thread only)
  loaded(className) {
    const T = U.cls(className).type.object;
    return U.list(U.cls("UnityEngine.Resources").method("FindObjectsOfTypeAll", 1).invoke(T));
  },
  name(o) {
    try {
      return o.method("get_name").invoke().content;
    } catch (e) {
      return "?";
    }
  },
  vec(v) {
    return [v.field("x").value, v.field("y").value, v.field("z").value].map((n) => Math.round(n * 1000) / 1000);
  },
  quat(q) {
    return [q.field("x").value, q.field("y").value, q.field("z").value, q.field("w").value].map((n) => Math.round(n * 10000) / 10000);
  },
  // build a UnityEngine.Vector3 value type
  v3(x, y, z) {
    const v = U.cls("UnityEngine.Vector3").alloc().unbox();
    v.field("x").value = x;
    v.field("y").value = y;
    v.field("z").value = z;
    return v;
  },
  quatIdentity() {
    const q = U.cls("UnityEngine.Quaternion").alloc().unbox();
    q.field("w").value = 1;
    return q;
  },
  isLocal(p) {
    return !!p.method("get_IsLocalPlayer").invoke();
  },
  localPlayer() {
    for (const p of U.all("PlayerController")) {
      try {
        if (U.isLocal(p)) return p;
      } catch (e) {
        /* ignore */
      }
    }
    return null;
  },
};
Object.assign(globalThis, { U, findClass, ser, safe, describeClass });

// ------------------------------------------------------------ item commands
const ITEM_CLASS = "Keepsake.PickupableItem_Data";
const CARGO_CLASS = "CargobayItem_Base_Data";
const MODULE_CLASS = "Keepsake.HyperSpace.System.Modifiers.ItemModule.ItemModuleScriptable";
let resourceIndexCache = null;
const catalogAssetHandles = [];

function resourceIndex(refresh = false) {
  if (resourceIndexCache && !refresh) return resourceIndexCache;
  const families = [
    { category: "pickup", cls: ITEM_CLASS },
    { category: "cargo", cls: CARGO_CLASS },
    { category: "module", cls: MODULE_CLASS },
    { category: "shipBlueprint", cls: "Keepsake.SpaceshipBlueprint" },
    { category: "craftable", cls: "Keepsake.GameplayFeatures.Assembler.Craftable" },
  ];
  const types = families.map(f => U.cls(f.cls).type.object);
  const rows = new Map();
  const output = Memory.alloc(Process.pointerSize);
  const locators = U.cls("UnityEngine.AddressableAssets.Addressables").method("get_ResourceLocators").invoke().method("GetEnumerator").invoke();
  let keysScanned = 0;
  while (locators.method("MoveNext").invoke()) {
    const locator = locators.method("get_Current").invoke();
    const keys = locator.method("get_Keys").invoke().method("GetEnumerator").invoke();
    while (keys.method("MoveNext").invoke()) {
      keysScanned++;
      const key = keys.method("get_Current").invoke();
      for (let c = 0; c < families.length; c++) {
        output.writePointer(NULL);
        if (!locator.method("Locate").invoke(key, types[c], output)) continue;
        const list = new Il2Cpp.Object(output.readPointer());
        const n = list.method("get_Count").invoke();
        for (let i = 0; i < n; i++) {
          const loc = list.method("get_Item").invoke(i);
          const path = loc.method("get_InternalId").invoke().content;
          rows.set(families[c].category + ":" + path, {
            category: families[c].category,
            key: loc.method("get_PrimaryKey").invoke().content,
            path,
            name: path.split("/").pop().replace(/\.asset$/i, ""),
            type: loc.method("get_ResourceType").invoke().method("get_FullName").invoke().content,
          });
        }
      }
    }
  }
  const entries = [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
  resourceIndexCache = { keysScanned, counts: {
    pickup: entries.filter(x => x.category === "pickup").length,
    cargo: entries.filter(x => x.category === "cargo").length,
    shipComponents: entries.filter(x => x.category === "cargo" && x.type !== CARGO_CLASS).length,
    modules: entries.filter(x => x.category === "module").length,
    shipBlueprints: entries.filter(x => x.category === "shipBlueprint").length,
    craftables: entries.filter(x => x.category === "craftable").length,
  }, entries };
  return resourceIndexCache;
}

function displayOf(d, category = "pickup") {
  try {
    const s = d.method(category === "cargo" ? "get_ItemDisplayName" : "get_ItemDisplayText").invoke();
    return s.isNull() ? "" : s.content || "";
  } catch (e) {
    return "";
  }
}

function catalog() {
  const seen = new Set();
  return [
    ...U.loaded(ITEM_CLASS).map(d => ({ d, category: "pickup", name: U.name(d), display: displayOf(d) })),
    ...U.loaded(CARGO_CLASS).map(d => ({ d, category: "cargo", name: U.name(d), display: displayOf(d, "cargo") })),
  ]
    .filter((x) => !x.name.endsWith("(Clone)"))
    .filter(x => {
      const guid = safe(() => x.d.field("m_AssetGUID").value.content, "");
      const key = x.category + ":" + (guid || x.name);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

function resolveItem(query) {
  const q = String(query).trim().toLowerCase();
  if (!q) throw new Error("empty item name");
  const cat = catalog();
  let hit = cat.filter((x) => x.name.toLowerCase() === q);
  if (!hit.length) hit = cat.filter(x => safe(() => x.d.field("m_AssetGUID").value.content.toLowerCase(), "") === q);
  if (!hit.length) hit = cat.filter((x) => x.display.toLowerCase() === q);
  if (!hit.length) hit = cat.filter((x) => x.name.toLowerCase().includes(q) || x.display.toLowerCase().includes(q));
  if (!hit.length) throw new Error(`no item matches "${query}"`);
  if (hit.length > 1) {
    throw new Error(`"${query}" is ambiguous, use the exact asset name: ` + hit.map((x) => `${x.name} (${x.display})`).join(", "));
  }
  return hit[0];
}

function requireLocalPlayer() {
  const p = U.localPlayer();
  if (!p) throw new Error("no local player found (are you in a run / on the ship?)");
  return p;
}

// Spawn `n` pickups of `data` in front of the local player's face.
// Items must be parented to the NetworkObject the game itself drops under
// (ship interior / station / universe node), with a parent-space position.
function spawnInFront(p, data, n) {
  const ph = U.all("Keepsake.PickupablesHandler")[0];
  if (!ph) throw new Error("PickupablesHandler not found in the scene");
  const h = p.field("m_ItemHandler").value;

  const slot = Memory.alloc(16);
  slot.writePointer(NULL);
  if (!h.method("TryGetDropParent").invoke(slot) || slot.readPointer().isNull()) {
    throw new Error("the game reports no valid drop parent right now (loading screen / dead / in a menu?)");
  }
  const parent = new Il2Cpp.Object(slot.readPointer());
  const parentTf = parent.method("get_transform").invoke();

  const head = p.field("m_HeadTransform").value;
  const P = U.vec(head.method("get_position").invoke());
  const F = U.vec(head.method("get_forward").invoke());
  const R = U.vec(head.method("get_right").invoke());
  const rot = U.quatIdentity();
  const token = U.cls("System.Threading.CancellationToken").alloc().unbox();
  const dist = 0.9;
  for (let i = 0; i < n; i++) {
    const off = (i - (n - 1) / 2) * 0.3;
    const world = U.v3(P[0] + F[0] * dist + R[0] * off, P[1] + F[1] * dist + R[1] * off, P[2] + F[2] * dist + R[2] * off);
    const local = parentTf.method("InverseTransformPoint").invoke(world);
    ph.method("SpawnItemDropped_Async", 5).invoke(data, parent, local, rot, token);
  }
  return U.name(parent);
}

function inventorySummary(p = requireLocalPlayer()) {
  const bb = p.field("m_InventoryBlackboardData").value;
  const SLOTS = inventorySlots();
  const active = bb.method("get_ActiveSlot").invoke();
  const out = { active: String(active), activeId: active.field("value__").value, slots: {}, slotInfo: {}, entries: {} };
  const held = bb.method("get_HeldEntry").invoke();
  out.held = held.isNull() ? null : U.name(held.method("get_ItemData").invoke());
  SLOTS.forEach(({ name, id: s }) => {
    const max = bb.method("MaxEntriesInSlot").invoke(s);
    const list = [];
    const details = [];
    for (let i = 0; i < max; i++) {
      const e = bb.method("GetEntryAtIndexInSlot").invoke(s, i);
      list.push(e.isNull() ? "-" : U.name(e.method("get_ItemData").invoke()));
      details.push(e.isNull() ? null : {
        name: U.name(e.method("get_ItemData").invoke()),
        display: displayOf(e.method("get_ItemData").invoke()),
        stack: safe(() => e.field("m_PickupableItemBlackboardData").value.field("m_StackCount").value.method("get_Value").invoke(), null),
      });
    }
    out.slots[name] = list;
    out.entries[name] = details;
    out.slotInfo[name] = { id: s, capacity: max, count: bb.method("SlotEntryCount").invoke(s), selected: bb.method("GetSelectedEntryIndex").invoke(s) };
  });
  return out;
}

function inventorySlots() {
  return U.cls("Keepsake.InventorySlotType").fields
    .filter((f) => f.isStatic && f.name !== "Max")
    .map((f) => ({ name: f.name, id: f.value.field("value__").value }));
}

function itemDetails(it) {
  const d = it.d;
  return {
    name: it.name,
    display: it.display,
    category: it.category || "pickup",
    slot: safe(() => String(d.field("m_SlotType").value), null),
    carry: safe(() => String(d.field("m_FirstPersonCarryType").value), null),
    tier: safe(() => d.field("m_Tier").value, null),
    maxStack: safe(() => d.field("m_MaxStackSize").value, null),
    guid: safe(() => d.field("m_AssetGUID").value.content, null),
    hasFirstPerson: safe(() => !d.field("m_FirstPersonAddressable").value.isNull(), null),
    canBackpack: it.category !== "cargo" && U.cls("Keepsake.PlayerPickupableItemHandler").method("CanItemBePlacedInSlot").invoke(d, backpackSlot()),
  };
}

Object.assign(rpc.exports, {
  // list the spawnable catalog; optional filter on asset name / display name
  async items(filter) {
    return onMain(() => {
      const q = (filter || "").toLowerCase();
      const rows = catalog()
        .filter((x) => !q || x.name.toLowerCase().includes(q) || x.display.toLowerCase().includes(q))
        .map((x) => {
          const slot = safe(() => String(x.d.field("m_SlotType").value));
          return `${x.name}\t${x.display}\t${x.category === "cargo" ? "Cargo" : slot}`;
        });
      return rows.join("\n");
    });
  },

  async inv(selector) {
    return onMain(() => ser(inventorySummary(selector ? resolvePlayer(selector) : requireLocalPlayer())));
  },

  async item(query) {
    return onMain(() => ser(itemDetails(resolveItem(query))));
  },

  async catalog(filter) {
    return onMain(() => {
      const q = String(filter || "").toLowerCase();
      return ser(catalog().filter((x) => !q || x.name.toLowerCase().includes(q) || x.display.toLowerCase().includes(q)).map(itemDetails));
    });
  },

  // give(item, count, where): where = "hand" (equip one, drop the rest in front) | "face" (all as pickups in front of you)
  async give(query, count, where) {
    return onMain(() => {
      const n = count === undefined || count === null || count === "" ? 1 : Number(count);
      if (!Number.isInteger(n) || n < 1 || n > 30) throw new Error("count must be an integer between 1 and 30");
      const mode = String(where || "hand").toLowerCase();
      if (mode !== "hand" && mode !== "face") throw new Error(`where must be "hand" or "face", got "${where}"`);
      const it = resolveItem(query);
      if (it.category === "cargo") throw new Error("货舱道具请使用 spawn 命令并选择 ground");
      const p = requireLocalPlayer();
      const label = `${it.name} (${it.display})`;
      if (mode === "hand") {
        p.field("m_ItemHandler").value.method("InstantiateAndEquip").invoke(it.d, -1, -1);
        if (n > 1) spawnInFront(p, it.d, n - 1);
        return `requested equip of ${label}` + (n > 1 ? ` and spawning ${n - 1} more in front of you` : "") + "; use inv to check the result";
      }
      if (mode === "face") {
        spawnInFront(p, it.d, n);
        return `requested spawning ${n} x ${label} in front of your face (async)`;
      }
      throw new Error(`where must be "hand" or "face", got "${where}"`);
    });
  },
});

// ---------------------------------------------------- targeted spawn workflow
// Network object IDs identify this incarnation of a character. A respawn must
// be selected again; never substitute a different player for a stale selection.
function bridgeError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function networkState() {
  const nm = U.cls("Unity.Netcode.NetworkManager").method("get_Singleton").invoke();
  if (nm.isNull()) return { listening: false, server: false, host: false };
  return {
    listening: nm.method("get_IsListening").invoke(),
    server: nm.method("get_IsServer").invoke(),
    host: nm.method("get_IsHost").invoke(),
  };
}

function requireServer() {
  const state = networkState();
  if (!state.listening) throw bridgeError("NO_SESSION", "尚未进入游戏会话");
  if (!state.server) throw bridgeError("HOST_REQUIRED", "请在房主的电脑上运行刷道具工具");
}

function playerRecord(p) {
  const no = p.method("get_NetworkObject").invoke();
  if (no.isNull() || !no.method("get_IsSpawned").invoke()) return null;
  const id = "network:" + String(no.method("get_NetworkObjectId").invoke());
  return {
    id,
    clientId: String(p.method("get_ClientId").invoke()),
    name: p.method("get_PlayerName").invoke().content || U.name(p),
    local: U.isLocal(p),
    downed: p.method("get_IsDownedOrDefeated").invoke(),
    backpackAvailable: safe(() => p.field("m_InventoryBlackboardData").value.field("m_BackpackAvailable").value.method("get_Value").invoke(), false),
  };
}

function resolvePlayer(selector) {
  if (!selector) throw bridgeError("PLAYER_REQUIRED", "请先选择目标角色");
  const matches = U.all("PlayerController", false).filter(p => {
    const record = playerRecord(p);
    return record && (selector === "local" ? record.local : record.id === selector);
  });
  if (matches.length !== 1) throw bridgeError("PLAYER_GONE", "目标角色已离线或重新生成，请刷新角色列表并重新选择");
  const p = matches[0];
  if (p.field("m_ItemHandler").value.isNull() || p.field("m_InventoryBlackboardData").value.isNull()) {
    throw bridgeError("PLAYER_NOT_READY", "角色背包尚未就绪");
  }
  return p;
}

function backpackSlot() {
  return U.cls("Keepsake.InventorySlotType").field("Backpack").value.field("value__").value;
}

function freeBackpackEntries(p) {
  const bb = p.field("m_InventoryBlackboardData").value;
  const slot = backpackSlot();
  const max = bb.method("MaxEntriesInSlot").invoke(slot);
  const free = [];
  for (let i = 0; i < max; i++) if (bb.method("GetEntryAtIndexInSlot").invoke(slot, i).isNull()) free.push(i);
  return free;
}

function validateSpawn(query, count, destination, selector, onFull) {
  const n = count === undefined || count === null || count === "" ? 1 : Number(count);
  if (!Number.isInteger(n) || n < 1 || n > 30) throw bridgeError("INVALID_COUNT", "数量必须是 1–30 的整数");
  if (!["backpack", "ground"].includes(destination)) throw bridgeError("INVALID_DESTINATION", "位置必须为 backpack 或 ground");
  if (!["reject", "ground"].includes(onFull)) throw bridgeError("INVALID_FULL_POLICY", "满包处理必须为 reject 或 ground");
  requireServer();
  const p = resolvePlayer(selector);
  let it;
  try { it = resolveItem(query); } catch (e) { throw bridgeError("ITEM_NOT_FOUND", e.message); }
  const player = playerRecord(p);
  let free = [];
  if (destination === "backpack") {
    if (it.category === "cargo") throw bridgeError("ITEM_INCOMPATIBLE", "货舱道具当前支持刷到地上，请选择地上");
    if (player.downed) throw bridgeError("PLAYER_DOWNED", "目标角色已倒地或死亡，无法刷入背包");
    if (!player.backpackAvailable) throw bridgeError("BACKPACK_UNAVAILABLE", "目标角色当前无法使用背包");
    if (!U.cls("Keepsake.PlayerPickupableItemHandler").method("CanItemBePlacedInSlot").invoke(it.d, backpackSlot())) {
      throw bridgeError("ITEM_INCOMPATIBLE", "这个道具不能放入背包，请选择地上");
    }
    free = freeBackpackEntries(p);
    if (free.length < n && onFull === "reject") {
      throw bridgeError("BACKPACK_FULL", `背包只有 ${free.length} 个空位，无法放入 ${n} 个道具；可减少数量或选择满包时刷到地上`);
    }
  }
  if (destination === "ground" || (onFull === "ground" && free.length < n)) dropContext(p);
  return { p, it, n, player, free, destination, onFull };
}

function dropContext(p) {
  const slot = Memory.alloc(Process.pointerSize);
  slot.writePointer(NULL);
  if (!p.field("m_ItemHandler").value.method("TryGetDropParent").invoke(slot) || slot.readPointer().isNull()) {
    throw bridgeError("NO_DROP_PARENT", "目标角色所在场景无法生成掉落物，请等待加载完成");
  }
  const parent = new Il2Cpp.Object(slot.readPointer());
  const tf = parent.method("get_transform").invoke();
  const head = p.field("m_HeadTransform").value;
  const pos = U.vec(head.method("get_position").invoke());
  const forward = U.vec(head.method("get_forward").invoke());
  // Let gravity settle the pickup onto the floor, in front of the selected player.
  const world = U.v3(pos[0] + forward[0] * 0.9, pos[1] - 0.4, pos[2] + forward[2] * 0.9);
  return { parent, local: tf.method("InverseTransformPoint").invoke(world), rotation: U.quatIdentity() };
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Unity 6 uses wider GC handles than this bridge version's native uint32 API.
// Use the managed API, which preserves the engine's actual handle width.
function rootObject(object) {
  const handle = U.cls("System.Runtime.InteropServices.GCHandle").method("Alloc", 1).invoke(object);
  return { get target() { return handle.method("get_Target").invoke(); }, free() { handle.method("Free").invoke(); } };
}

// entry: an index entry ({ key, category, name }) or any asset by its class ({ key, cls, name }); resolves to the loaded asset,
// which stays loaded until releaseCatalog
async function loadCatalogAsset(entry) {
  const ref = await onMain(() => {
    const cls = entry.cls || { cargo: CARGO_CLASS, pickup: ITEM_CLASS, craftable: "Keepsake.GameplayFeatures.Assembler.Craftable", shipBlueprint: "Keepsake.SpaceshipBlueprint" }[entry.category];
    if (!cls) throw bridgeError("UNSUPPORTED_ASSET", "不支持加载这个资源类别");
    const handle = U.cls("UnityEngine.AddressableAssets.Addressables").method("LoadAssetAsync")
      .overload("System.Object").inflate(U.cls(cls)).invoke(Il2Cpp.string(entry.key));
    return rootObject(handle.box());
  });
  let retained = false;
  try {
    const deadline = Date.now() + 20000;
    for (;;) {
      const done = await onMain(() => {
        const handle = ref.target.unbox();
        if (!handle.method("get_IsDone").invoke()) return false;
        if (String(handle.method("get_Status").invoke()) !== "Succeeded") {
          throw bridgeError("ASSET_LOAD_FAILED", `无法加载 ${entry.name}: ${handle.method("get_OperationException").invoke()}`);
        }
        const asset = handle.method("get_Result").invoke();
        if (asset.isNull()) throw bridgeError("ASSET_LOAD_FAILED", `道具资源为空: ${entry.name}`);
        catalogAssetHandles.push(ref);
        retained = true;
        return asset;
      });
      if (done) return done;
      if (Date.now() > deadline) throw bridgeError("ASSET_LOAD_TIMEOUT", `加载道具超时: ${entry.name}`);
      await delay(50);
    }
  } finally {
    if (!retained) await onMain(() => {
      const handle = ref.target.unbox();
      if (handle.method("IsValid").invoke()) handle.method("Release").invoke();
      ref.free();
    });
  }
}

// what an Addressables key (an asset GUID) is: the class and file name of the ScriptableObject it locates, or null (main thread)
function locateAsset(key) {
  const output = Memory.alloc(Process.pointerSize);
  const type = U.cls("UnityEngine.ScriptableObject").type.object;
  const locators = U.cls("UnityEngine.AddressableAssets.Addressables").method("get_ResourceLocators").invoke().method("GetEnumerator").invoke();
  while (locators.method("MoveNext").invoke()) {
    const locator = locators.method("get_Current").invoke();
    output.writePointer(NULL);
    if (!locator.method("Locate").invoke(Il2Cpp.string(key), type, output)) continue;
    const list = new Il2Cpp.Object(output.readPointer());
    if (!list.method("get_Count").invoke()) continue;
    const loc = list.method("get_Item").invoke(0);
    return {
      cls: loc.method("get_ResourceType").invoke().method("get_FullName").invoke().content,
      name: loc.method("get_InternalId").invoke().content.split("/").pop().replace(/\.asset$/i, ""),
    };
  }
  return null;
}

let catalogLoading = null;
async function fullCatalog() {
  if (catalogLoading) return catalogLoading;
  catalogLoading = (async () => {
    const { index, missing } = await onMain(() => {
      const index = resourceIndex();
      const loaded = new Set(catalog().map(x => safe(() => x.d.field("m_AssetGUID").value.content, "")));
      return { index, missing: index.entries.filter(x => ["pickup", "cargo"].includes(x.category) && !loaded.has(x.key)) };
    });
    const failures = [];
    for (const entry of missing) {
      try { await loadCatalogAsset(entry); }
      catch (e) { failures.push({ name: entry.name, code: e.code || "GAME_ERROR", message: e.message }); }
    }
    return onMain(() => ({ source: "addressables", counts: index.counts, keysScanned: index.keysScanned, items: catalog().map(itemDetails), failures }));
  })();
  try { return await catalogLoading; }
  finally { catalogLoading = null; }
}

// Keep the managed task alive while polling; call GetResult exactly once to
// consume the UniTask and surface addressable-loading / cancellation errors.
async function gameTask(start) {
  const state = await onMain(() => {
    const cts = U.cls("System.Threading.CancellationTokenSource").new();
    const ctsRef = rootObject(cts);
    try {
      const task = start(cts.method("get_Token").invoke());
      return { ctsRef, taskRef: rootObject(task.box()) };
    } catch (e) {
      cts.method("Dispose", 0).invoke();
      ctsRef.free();
      throw e;
    }
  });
  const deadline = Date.now() + 20000;
  let cancelled = false;
  try {
    for (;;) {
      const step = await onMain(() => {
        const task = state.taskRef.target.unbox();
        const awaiter = task.method("GetAwaiter").invoke();
        if (awaiter.method("get_IsCompleted").invoke()) {
          const result = awaiter.method("GetResult").invoke();
          // Return a rooted boxed result, consumed by the caller on the main thread.
          if (result === undefined || result === null) return { done: true, ref: null, struct: false };
          return { done: true, ref: rootObject(result.box ? result.box() : result), struct: !!result.box };
        }
        if (Date.now() > deadline && !cancelled) {
          state.ctsRef.target.method("Cancel", 0).invoke();
          cancelled = true;
        }
        if (Date.now() > deadline + 5000) throw bridgeError("SPAWN_TIMEOUT", "生成超时，结果可能仍在同步，请检查背包或地面后再操作");
        return { done: false };
      });
      if (step.done) return step;
      await delay(50);
    }
  } catch (e) {
    if (cancelled) throw bridgeError("SPAWN_TIMEOUT", "生成已超时并请求取消，请检查游戏中的实际结果后再操作");
    throw e;
  } finally {
    await onMain(() => {
      state.taskRef.free();
      state.ctsRef.target.method("Dispose", 0).invoke();
      state.ctsRef.free();
    });
  }
}

async function consumeTask(start, consume) {
  const result = await gameTask(start);
  try {
    return await onMain(() => consume(result.ref ? (result.struct ? result.ref.target.unbox() : result.ref.target) : undefined));
  } finally {
    if (result.ref) await onMain(() => result.ref.free());
  }
}

// `attach(persistent)`, when given, sets the attributes of the new item (main thread; see gear.js). The game's crafting machine
// does the same for what it spawns: the pickup exists first, its generated item is set afterwards.
async function spawnGround(selector, itemName, attach) {
  return consumeTask(token => {
    requireServer();
    const p = resolvePlayer(selector);
    const ctx = dropContext(p);
    const ph = U.all("Keepsake.PickupablesHandler", false)[0];
    if (!ph) throw bridgeError("SCENE_NOT_READY", "场景物品系统尚未就绪");
    const it = resolveItem(itemName);
    return ph.method(it.category === "cargo" ? "SpawnCargoBayItem_Async" : "SpawnItemDropped_Async", 5).invoke(it.d, ctx.parent, ctx.local, ctx.rotation, token);
  }, result => {
    if (!result.method("get_IsValid").invoke()) throw bridgeError("SPAWN_FAILED", "游戏未生成有效掉落物");
    const persistent = result.method("get_PersistentPickupable").invoke();
    if (attach) {
      try {
        attach(persistent);
      } catch (e) {
        // an item without its attributes is not what was asked for: take it back
        try { U.all("Keepsake.PickupablesHandler", false)[0].method("RemovePersistentObjectServer").invoke(persistent); } catch (_) { /* gone already */ }
        throw e;
      }
    }
    return String(persistent.method("get_NetworkObject").invoke().method("get_NetworkObjectId").invoke());
  });
}

async function spawnBackpack(selector, itemName, attach) {
  let createdRef = null;
  let pickupStarted = false;
  try {
    await consumeTask(token => {
      validateSpawn(itemName, 1, "backpack", selector, "reject");
      return U.cls("Keepsake.PickupablesHandler").method("InstantiatePersistentPickupableFromItemData_Async", 2).invoke(resolveItem(itemName).d, token);
    }, item => {
      if (item.isNull()) throw bridgeError("SPAWN_FAILED", "游戏未创建道具");
      createdRef = rootObject(item);
      // Check again after loading. Never overwrite an entry occupied meanwhile.
      const ctx = validateSpawn(itemName, 1, "backpack", selector, "reject");
      if (attach) attach(item); // before the player gets it
      pickupStarted = true;
      ctx.p.field("m_ItemHandler").value.method("Server_PickupItem").invoke(item, backpackSlot(), ctx.free[0], false);
    });
    const deadline = Date.now() + 10000;
    for (;;) {
      const confirmed = await onMain(() => {
        const p = resolvePlayer(selector);
        const bb = p.field("m_InventoryBlackboardData").value;
        const item = createdRef.target;
        for (let i = 0; i < bb.method("MaxEntriesInSlot").invoke(backpackSlot()); i++) {
          const entry = bb.method("GetEntryAtIndexInSlot").invoke(backpackSlot(), i);
          if (!entry.isNull() && entry.handle.equals(item.handle)) return true;
        }
        return false;
      });
      if (confirmed) return;
      if (Date.now() > deadline) throw bridgeError("PICKUP_UNCONFIRMED", "已请求放入背包，但同步结果未确认，请检查目标背包后再操作");
      await delay(100);
    }
  } catch (e) {
    // Only remove a newly created, unassigned item. Once pickup starts, a
    // delayed remote client may still own it; do not destroy that player's item.
    if (createdRef && !pickupStarted) {
      await onMain(() => U.all("Keepsake.PickupablesHandler", false)[0].method("RemovePersistentObjectServer").invoke(createdRef.target));
    }
    throw e;
  } finally {
    if (createdRef) await onMain(() => createdRef.free());
  }
}

// The attributes (tier, modules, level) an item is to be spawned with are the business of gear.js; this asks it whether the
// item can carry them (nothing is spawned yet) and gives back what to apply to every new pickup.
function gearCheck(it, spec) {
  if (!JB.gearAttachment) throw bridgeError("GEAR_UNAVAILABLE", "游戏里运行的修改器脚本太旧，不支持自定义属性，请重启游戏");
  const gear = JB.gearAttachment(it, spec);
  return { summary: gear.check(), apply: (persistent) => gear.apply(persistent) };
}

let spawnBusy = false;
function managedRows(collection, map) {
  const rows = [];
  const count = collection.method("get_Count").invoke();
  for (let i = 0; i < count; i++) rows.push(map(collection.method("get_Item").invoke(i)));
  return rows;
}

function generatedDetails(data) {
  return {
    instanceGuid: data.field("m_Guid").value.content,
    templateGuid: data.field("m_TemplateGuid").value.content,
    name: safe(() => data.method("get_ResolvedName").invoke().content, ""),
    rarity: String(data.field("m_Rarity").value),
    level: data.field("m_Level").value,
    modules: safe(() => {
      const array = data.field("m_Modules").value;
      return U.list(array).map(m => ({ guid: m.field("m_ModuleGuid").value.content, rarity: String(m.field("m_Rarity").value), level: m.field("m_UpgradeLevel").value }));
    }, []),
  };
}

function localProfile(selector) {
  // The profile (save file) belongs to the local player. Outside a level (main
  // menu) there is no character in the scene; "local" then means the profile itself.
  let p = null;
  try {
    p = resolvePlayer(selector);
  } catch (e) {
    if (!(selector === "local" && (e.code === "PLAYER_GONE" || e.code === "PLAYER_NOT_READY"))) throw e;
  }
  if (p && !U.isLocal(p)) throw bridgeError("LOCAL_PROFILE_ONLY", "蓝图存档属于各自玩家，请在目标玩家的电脑上操作");
  const manager = U.cls("Keepsake.MetaProgression.MetaProgressionManager");
  if (!manager.method("get_InitialDataSuccessfullyLoaded").invoke()) throw bridgeError("PROFILE_NOT_READY", "本机玩家存档尚未加载完成");
  const record = p ? playerRecord(p) : { id: "local", clientId: "0", name: "本机存档", local: true, downed: false, backpackAvailable: false };
  // profile work is tied to the save, not to one incarnation of the character
  return { manager, player: { ...record, id: selector === "local" ? "local" : record.id }, saveId: manager.method("get_SaveFileGuid").invoke().method("get_Value").invoke().content };
}

function resolveRecipe(query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) throw bridgeError("RECIPE_REQUIRED", "请选择制作配方");
  const all = resourceIndex().entries.filter(e => e.category === "craftable");
  let hits = all.filter(e => e.key.toLowerCase() === q || e.name.toLowerCase() === q);
  if (!hits.length) hits = all.filter(e => e.name.toLowerCase().includes(q));
  if (hits.length !== 1) throw bridgeError("RECIPE_AMBIGUOUS", hits.length ? "配方名称匹配多项，请使用完整资源名或 GUID" : "未找到制作配方，请刷新资源目录");
  return hits[0];
}

function recipeUnlocked(manager, guid) {
  return managedRows(manager.method("get_UnlockedCraftables").invoke(), c => c.method("get_AssetGUID").invoke().content).includes(guid);
}

function recipeTarget(recipe) {
  const asset = U.loaded("Keepsake.GameplayFeatures.Assembler.Craftable").find(c =>
    c.method("get_AssetGUID").invoke().content === recipe.key && !c.field("m_CraftableObject").value.isNull());
  if (!asset) throw bridgeError("RECIPE_NO_TARGET", "这个制作配方没有有效的装备目标，无法解锁");
  const target = asset.field("m_CraftableObject").value;
  const targetGuid = safe(() => target.field("m_AssetGUID").value.content, null);
  const valid = resourceIndex().entries.some(e => ["pickup", "cargo"].includes(e.category) && e.key === targetGuid);
  if (!targetGuid || !valid) throw bridgeError("RECIPE_NO_TARGET", "配方目标不是可解锁的装备或部件");
  return { ...recipe, display: asset.method("get_DisplayName").invoke().content, targetGuid, targetName: U.name(target) };
}

async function prepareRecipe(query, selector) {
  const plan = await onMain(() => {
    const ctx = localProfile(selector);
    return { player: ctx.player, saveId: ctx.saveId, recipe: resolveRecipe(query) };
  });
  const loaded = await onMain(() => U.loaded("Keepsake.GameplayFeatures.Assembler.Craftable").some(c => c.method("get_AssetGUID").invoke().content === plan.recipe.key));
  if (!loaded) await loadCatalogAsset(plan.recipe);
  return onMain(() => {
    const ctx = localProfile(plan.player.id);
    if (ctx.saveId !== plan.saveId) throw bridgeError("PROFILE_CHANGED", "当前存档已切换，请重新选择配方");
    return { ...plan, recipe: recipeTarget(plan.recipe), alreadyUnlocked: recipeUnlocked(ctx.manager, plan.recipe.key) };
  });
}

function blueprintPlan(instanceGuid, selector) {
  const ctx = localProfile(selector);
  const history = managedRows(ctx.manager.method("get_BlueprintHistory").invoke(), b => b);
  const matches = history.filter(b => b.field("m_GeneratedData").value.field("m_Guid").value.content === instanceGuid);
  if (!instanceGuid || matches.length !== 1) throw bridgeError("BLUEPRINT_SOURCE_GONE", "发现历史中的装备已变化，请刷新并重新选择");
  const source = matches[0];
  const data = source.field("m_GeneratedData").value;
  const category = source.field("m_CategoryGuid").value;
  const existing = managedRows(ctx.manager.method("get_Blueprints").invoke(), b => b)
    .find(b => b.field("m_GeneratedData").value.field("m_Guid").value.content === instanceGuid);
  if (existing) return { ...ctx, source, data, category, slot: existing.field("m_SlotIndex").value, alreadySaved: true };
  if (!ctx.manager.method("CanScanItem").invoke(data)) throw bridgeError("BLUEPRINT_NOT_SCANNABLE", "游戏不允许保存这个装备的蓝图");
  const capacity = ctx.manager.method("GetBlueprintCapacity").invoke(category);
  for (let slot = 0; slot < capacity; slot++) {
    if (ctx.manager.method("GetBlueprintInSlot").invoke(category, slot).isNull()) return { ...ctx, source, data, category, slot, alreadySaved: false };
  }
  throw bridgeError("BLUEPRINT_FULL", "该类别的蓝图槽位已满，请在游戏中扩容或移除不需要的蓝图后再操作");
}

function profileFailure(e) {
  return ser({ ok: false, error: { code: e.code || "GAME_ERROR", message: e.message } });
}

function resolveShip(query) {
  const q = String(query || "").trim().toLowerCase();
  const all = resourceIndex().entries.filter(e => e.category === "shipBlueprint");
  let hits = all.filter(e => e.key.toLowerCase() === q || e.name.toLowerCase() === q);
  if (!hits.length && q) hits = all.filter(e => e.name.toLowerCase().includes(q));
  if (!q || hits.length !== 1) throw bridgeError("SHIP_REQUIRED", "请选择唯一的舰船设计，或使用它的完整资源名 / GUID");
  return hits[0];
}

function shipOwned(manager, guid) {
  return managedRows(manager.method("get_OwnedShips").invoke(), s => s.field("m_ShipBlueprintAssetGUID").value.content).includes(guid);
}

async function prepareShip(query, selector) {
  const plan = await onMain(() => {
    const ctx = localProfile(selector);
    return { player: ctx.player, saveId: ctx.saveId, ship: resolveShip(query) };
  });
  return onMain(() => ({ ...plan, alreadyOwned: shipOwned(localProfile(plan.player.id).manager, plan.ship.key) }));
}

Object.assign(rpc.exports, {
  async previewUnlockShip(query, selector) {
    try { return ser({ ok: true, ...await prepareShip(query, selector) }); }
    catch (e) { return profileFailure(e); }
  },

  async unlockShip(query, selector) {
    try {
      const plan = await prepareShip(query, selector);
      if (plan.alreadyOwned) return ser({ ok: true, ...plan, changed: false, confirmed: true });
      await loadCatalogAsset(plan.ship);
      await onMain(() => {
        const ctx = localProfile(plan.player.id);
        if (ctx.saveId !== plan.saveId) throw bridgeError("PROFILE_CHANGED", "存档已切换，请重新选择舰船");
        if (shipOwned(ctx.manager, plan.ship.key)) throw bridgeError("SHIP_ALREADY_OWNED", "这艘舰船已经拥有，请刷新列表");
        const flagged = ctx.manager.method("HasUnlockedAsset").invoke(Il2Cpp.string(plan.ship.key));
        if (!flagged) ctx.manager.method("SetAssetUnlocked").invoke(Il2Cpp.string(plan.ship.key), true, true);
        if (!shipOwned(ctx.manager, plan.ship.key)) {
          const asset = U.loaded("Keepsake.SpaceshipBlueprint").find(s => s.method("get_AssetGUID").invoke().content === plan.ship.key);
          if (!asset) throw bridgeError("SHIP_NOT_LOADED", "舰船设计尚未加载，请刷新后重新选择");
          ctx.manager.method("HandleUnlockedNewSpaceshipBlueprint").invoke(asset, true);
        }
      });
      const deadline = Date.now() + 20000;
      for (;;) {
        const owned = await onMain(() => {
          const ctx = localProfile(plan.player.id);
          if (ctx.saveId !== plan.saveId) throw bridgeError("PROFILE_CHANGED", "存档已切换，请检查原存档中的舰船");
          return shipOwned(ctx.manager, plan.ship.key);
        });
        if (owned) return ser({ ok: true, player: plan.player, ship: plan.ship, changed: true, confirmed: true, saveRequested: true });
        if (Date.now() > deadline) throw bridgeError("SHIP_UNCONFIRMED", "舰船解锁状态已处理，但未确认出现在已拥有舰船列表，请检查游戏中的舰船选择界面");
        await delay(100);
      }
    } catch (e) { return profileFailure(e); }
  },

  async previewUnlockBlueprint(query, selector) {
    try { return ser({ ok: true, ...await prepareRecipe(query, selector) }); }
    catch (e) { return profileFailure(e); }
  },

  async unlockBlueprint(query, selector) {
    try {
      const plan = await prepareRecipe(query, selector);
      if (plan.alreadyUnlocked) return ser({ ok: true, ...plan, changed: false });
      const changed = await onMain(() => {
        const ctx = localProfile(plan.player.id);
        if (ctx.saveId !== plan.saveId) throw bridgeError("PROFILE_CHANGED", "当前存档已切换，请重新选择配方");
        if (recipeUnlocked(ctx.manager, plan.recipe.key)) return false;
        if (ctx.manager.method("HasUnlockedAsset").invoke(Il2Cpp.string(plan.recipe.targetGuid))) return false;
        ctx.manager.method("SetAssetUnlocked").invoke(Il2Cpp.string(plan.recipe.targetGuid), true, true);
        return true;
      });
      const deadline = Date.now() + 15000;
      for (;;) {
        const confirmed = await onMain(() => {
          const ctx = localProfile(plan.player.id);
          if (ctx.saveId !== plan.saveId) throw bridgeError("PROFILE_CHANGED", "当前存档已切换，请检查原存档的解锁结果");
          return recipeUnlocked(ctx.manager, plan.recipe.key);
        });
        if (confirmed) return ser({ ok: true, player: plan.player, recipe: plan.recipe, changed, confirmed: true, saveRequested: changed });
        if (Date.now() > deadline) throw bridgeError("UNLOCK_UNCONFIRMED", "装备解锁标记已处理，但制作列表尚未确认该配方。请刷新游戏制作界面后检查，工具不会将此状态报告为成功");
        await delay(100);
      }
    } catch (e) { return profileFailure(e); }
  },

  async previewAddBlueprint(instanceGuid, selector) {
    return onMain(() => {
      try {
        const plan = blueprintPlan(instanceGuid, selector);
        return ser({ ok: true, player: plan.player, item: generatedDetails(plan.data), slot: plan.slot, alreadySaved: plan.alreadySaved });
      } catch (e) { return profileFailure(e); }
    });
  },

  async addBlueprint(instanceGuid, selector) {
    return onMain(() => {
      try {
        const plan = blueprintPlan(instanceGuid, selector);
        if (plan.alreadySaved) return ser({ ok: true, changed: false, slot: plan.slot });
        if (!plan.manager.method("TrySetBlueprintInSlot").invoke(plan.data, plan.category, plan.slot)) {
          throw bridgeError("BLUEPRINT_REJECTED", "游戏拒绝保存蓝图，请检查蓝图资格和槽位");
        }
        const saved = plan.manager.method("GetBlueprintInSlot").invoke(plan.category, plan.slot);
        if (saved.isNull() || saved.field("m_GeneratedData").value.field("m_Guid").value.content !== instanceGuid) {
          throw bridgeError("BLUEPRINT_UNCONFIRMED", "蓝图保存结果未确认，请先检查游戏");
        }
        plan.manager.method("SaveDataToCloud").invoke();
        return ser({ ok: true, changed: true, saveRequested: true, player: plan.player, item: generatedDetails(plan.data), slot: plan.slot });
      } catch (e) { return profileFailure(e); }
    });
  },

  async blueprints() {
    return onMain(() => {
      const manager = U.cls("Keepsake.MetaProgression.MetaProgressionManager");
      if (!manager.method("get_InitialDataSuccessfullyLoaded").invoke()) throw bridgeError("PROFILE_NOT_READY", "本机玩家存档尚未加载完成");
      const categories = new Map(U.loaded("Keepsake.GameplayFeatures.Assembler.CraftableCategory").map(c => [c.method("get_AssetGUID").invoke().content, c.method("get_DisplayName").invoke().content]));
      const row = blueprint => {
        const categoryGuid = blueprint.field("m_CategoryGuid").value.content;
        return { categoryGuid, category: categories.get(categoryGuid) || categoryGuid, ...generatedDetails(blueprint.field("m_GeneratedData").value) };
      };
      return ser({
        scope: "localProfile",
        player: localProfile("local").player,
        owned: managedRows(manager.method("get_Blueprints").invoke(), b => ({ ...row(b), id: b.field("m_Guid").value.content, slot: b.field("m_SlotIndex").value })),
        history: managedRows(manager.method("get_BlueprintHistory").invoke(), row),
        capacities: managedRows(manager.method("get_BlueprintSlotCapacities").invoke(), c => {
          const guid = c.field("m_CategoryGuid").value.content;
          return { categoryGuid: guid, category: categories.get(guid) || guid, max: manager.method("GetBlueprintCapacity").invoke(Il2Cpp.string(guid)), purchased: c.field("m_PurchasedSlots").value };
        }),
        unlockedCraftables: managedRows(manager.method("get_UnlockedCraftables").invoke(), c => ({ name: U.name(c), display: c.method("get_DisplayName").invoke().content, guid: c.method("get_AssetGUID").invoke().content })),
        unlockedShips: managedRows(manager.method("get_UnlockedSpaceshipBlueprints").invoke(), s => ({ name: U.name(s), display: s.method("get_BlueprintName").invoke().content, guid: s.method("get_AssetGUID").invoke().content })),
        ownedShips: managedRows(manager.method("get_OwnedShips").invoke(), s => ({ name: s.field("m_ShipName").value.content, guid: s.field("m_ShipBlueprintAssetGUID").value.content })),
        definitions: resourceIndex().entries.filter(e => ["shipBlueprint", "craftable"].includes(e.category))
          .map(e => ({ ...e, kind: e.category, unlocked: e.category === "craftable" ? recipeUnlocked(manager, e.key) : shipOwned(manager, e.key), category: e.category === "shipBlueprint" ? "舰船设计" : "制作配方" })),
      });
    });
  },

  async resourceCatalog(refresh) {
    return onMain(() => ser(resourceIndex(refresh === true || refresh === "true")));
  },

  async fullCatalog() {
    return ser(await fullCatalog());
  },

  async releaseCatalog() {
    return onMain(() => {
      for (const ref of catalogAssetHandles.splice(0)) {
        try {
          const handle = ref.target.unbox();
          if (handle.method("IsValid").invoke()) handle.method("Release").invoke();
        } finally { ref.free(); }
      }
      return "catalog handles released";
    });
  },

  async players() {
    return onMain(() => ser({ network: networkState(), players: U.all("PlayerController", false).map(playerRecord).filter(Boolean) }));
  },

  async previewSpawn(query, count, destination, selector, onFull = "reject", spec = null) {
    onFull = onFull || "reject";
    return onMain(() => {
      try {
        const ctx = validateSpawn(query, count, destination, selector, onFull);
        if (spec) gearCheck(ctx.it, spec);
        const backpack = destination === "backpack" ? Math.min(ctx.n, ctx.free.length) : 0;
        return ser({ ok: true, player: ctx.player, item: itemDetails(ctx.it), requested: ctx.n, backpack, ground: ctx.n - backpack, freeSlots: ctx.free.length });
      } catch (e) {
        return ser({ ok: false, error: { code: e.code || "GAME_ERROR", message: e.message } });
      }
    });
  },

  async spawn(query, count, destination, selector, onFull = "reject", spec = null) {
    onFull = onFull || "reject";
    const out = { ok: false, requested: Number(count || 1), backpack: 0, ground: 0 };
    if (spawnBusy) return ser({ ...out, error: { code: "BUSY", message: "已有刷道具任务正在执行" } });
    spawnBusy = true;
    try {
      const plan = await onMain(() => {
        const ctx = validateSpawn(query, count, destination, selector, onFull);
        const gear = spec ? gearCheck(ctx.it, spec) : null;
        return { player: ctx.player, name: ctx.it.name, n: ctx.n, gear };
      });
      out.player = plan.player;
      out.item = plan.name;
      out.requested = plan.n;
      if (plan.gear) out.gear = plan.gear.summary;
      const attach = plan.gear ? (persistent) => plan.gear.apply(persistent) : null;
      const deadline = Date.now() + 75000;
      for (let i = 0; i < plan.n; i++) {
        if (Date.now() > deadline) throw bridgeError("BATCH_TIMEOUT", "批量生成耗时过长，已停止后续生成；请检查已完成数量");
        const where = await onMain(() => {
          requireServer();
          const p = resolvePlayer(plan.player.id);
          if (destination === "ground") return "ground";
          const ctx = validateSpawn(plan.name, 1, destination, plan.player.id, onFull);
          return ctx.free.length ? "backpack" : "ground";
        });
        if (where === "backpack") {
          await spawnBackpack(plan.player.id, plan.name, attach);
          out.backpack++;
        } else {
          await spawnGround(plan.player.id, plan.name, attach);
          out.ground++;
        }
      }
      out.ok = true;
    } catch (e) {
      console.log("spawn failed: " + (e.stack || e));
      out.error = { code: e.code || "GAME_ERROR", message: e.message };
      out.uncertain = ["SPAWN_TIMEOUT", "PICKUP_UNCONFIRMED"].includes(e.code);
    } finally {
      spawnBusy = false;
    }
    return ser(out);
  },
});

// install the main-thread pump as soon as the agent is loaded
(async () => {
  try {
    const r = await rpc.exports.installPump("UniTask", "Cysharp.Threading.Tasks.Internal.PlayerLoopRunner", "RunCore", 0);
    console.log("pump installed: " + r);
  } catch (e) {
    console.log("pump install FAILED: " + e);
  }
})();

// ----------------------------------------------------------- feature modules
// Installed after the marker above so the unit tests (which evaluate only the
// core) never run them. Modules share one toolbox and register RPC methods.
const disposers = [];
let cachedLocal = null;

// The local player is looked up constantly (status polling, locks); keep the
// object and only rescan when Unity says it is gone or no longer the local one.
function localPlayerCached() {
  if (cachedLocal) {
    try {
      if (U.cls("UnityEngine.Object").method("op_Implicit").invoke(cachedLocal) && U.isLocal(cachedLocal)) return cachedLocal;
    } catch (e) { /* fall through to a rescan */ }
    cachedLocal = null;
  }
  cachedLocal = U.localPlayer();
  return cachedLocal;
}

function healthOf(p) {
  const ph = p.field("m_PlayerHealth").value;
  if (ph.isNull()) return null;
  const hc = ph.field("m_HealthComp").value;
  return hc.isNull() ? null : hc;
}

// Wrap an RPC body: always answer with JSON {ok:true,...} or {ok:false,error:{code,message}}.
function rpcSafe(fn) {
  return async (...args) => {
    try {
      const result = await fn(...args);
      return JSON.stringify({ ok: true, ...(result || {}) }, (k, x) => (typeof x === "bigint" ? x.toString() : x));
    } catch (e) {
      return JSON.stringify({ ok: false, error: { code: (e && e.code) || "GAME_ERROR", message: (e && e.message) || String(e) } });
    }
  };
}

const JB = {
  U, ser, safe, delay, onMain, bridgeError, rpcSafe, addTicker, removeTicker,
  networkState, requireServer, requireLocalPlayer, playerRecord, resolvePlayer,
  resolveItem, catalog, itemDetails, displayOf, fullCatalog, resourceIndex, loadCatalogAsset, locateAsset, managedRows, localProfile,
  prepareRecipe, recipeUnlocked,
  // the spawn workflow, for the modules that spawn things with attributes
  consumeTask, rootObject, backpackSlot, freeBackpackEntries, validateSpawn, dropContext,
  localPlayer: localPlayerCached,
  healthOf,
  tickerInfo: (name) => tickers.get(name) || null,
  pumpInfo: () => ({ target: pumpTarget, ticks: pumpCount(), queued: jobs.length }),
  onDispose: (fn) => { disposers.push(fn); },
};
globalThis.JB = JB;

installStatus(JB, rpc.exports);
installProgression(JB, rpc.exports);
installCheats(JB, rpc.exports);
installGear(JB, rpc.exports); // before the items: the item list asks which items carry attributes
installItems(JB, rpc.exports);
installUnlocks(JB, rpc.exports);
installVentures(JB, rpc.exports);
installLoot(JB);
installMission(JB, rpc.exports);
installShipRepair(JB, rpc.exports);

// Called by daemon.py before the agent is replaced or the daemon exits:
// switch the cheat locks off and drop retained Addressables handles.
rpc.exports.dispose = async () => {
  await onMain(() => { for (const fn of [...disposers]) { try { fn(); } catch (e) { console.log("dispose step failed: " + e); } } }).catch(() => {});
  await rpc.exports.releaseCatalog().catch(() => {});
  return "disposed";
};

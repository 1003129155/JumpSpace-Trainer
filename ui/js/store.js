// Shared application state, data loaders and a tiny event bus.
import { rpc, get, post } from "./api.js";
import { toast, load, save } from "./ui.js";

// The version of the agent's RPC interface this window was written for (agent/status.js reports the one the game runs)
export const AGENT_API = 4;
// whether the script running in the game has a feature that came with interface version `api` (2: attributes, 3: ventures)
export const agentHas = (api) => !!(S.status && (S.status.agentApi || 0) >= api);

export const S = {
  bridge: null,        // daemon / Frida attach state
  status: null,        // latest agent status (null when not available)
  statusError: null,   // {code,message} of the last failed status call
  prog: null,          // currencies / experience / materia
  items: null,         // item catalog {items, groups, counts}
  recipes: null,
  gear: null,          // the weapons / ship parts that blueprints can be made of, with the slots and the discovery history
  ships: null,
  players: [],
  history: [],
  target: "local",     // spawn target selector
  loading: {},         // name -> true while a loader runs
};

const bus = new EventTarget();
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));
// returns the function that unsubscribes
export const on = (name, fn) => {
  const handler = (e) => fn(e.detail);
  bus.addEventListener(name, handler);
  return () => bus.removeEventListener(name, handler);
};

// Call an agent method; show a toast on failure unless quiet.
export async function call(method, ...args) {
  const r = await rpc(method, ...args);
  if (!r.ok && !call.quiet) {
    const code = r.error && r.error.code;
    if (code !== "NOT_CONNECTED" && code !== "OFFLINE") toast("操作失败", r.error ? r.error.message : "未知错误", "bad");
  }
  return r;
}

// ------------------------------------------------------------- connection
export function connection() {
  const b = S.bridge;
  if (!b) return { kind: "warn", title: "正在连接…", sub: "" };
  if (S.statusError && S.statusError.code === "OFFLINE") return { kind: "bad", title: "修改器后台已断开", sub: "请重新启动修改器" };
  if (!b || b.ok === false) return { kind: "bad", title: "后台未响应", sub: "修改器后台没有运行" };
  if (b.starting) return { kind: "warn", title: "游戏正在启动…", sub: "启动完成后自动连接" };
  if (!b.attached) return { kind: "warn", title: "等待游戏启动", sub: b.lastError || "启动 Jump Space 后自动连接" };
  if (!b.agentLoaded) return { kind: "warn", title: "正在注入…", sub: "稍等几秒" };
  if (b.pumpState === "quitting") return { kind: "warn", title: "游戏正在退出", sub: "退出后会自动等待下次启动" };
  if (!S.status || S.status.ok === false) return { kind: "warn", title: "已连接 · 初始化中", sub: S.statusError ? S.statusError.message : "" };
  const net = S.status.net || {};
  if (!net.listening) return { kind: "warn", title: "已连接游戏", sub: "尚未进入游戏会话" };
  const role = net.host ? "房主" : net.server ? "服务端" : "客户端";
  return { kind: "good", title: "已连接 · " + role, sub: S.status.player ? S.status.player.name : "等待角色加载" };
}
export const isReady = () => connection().kind === "good";
// Save-level features (currency, recipes, ships) only need the profile, not a level.
export const profileReady = () => !!(S.status && S.status.ok && S.status.profile && S.status.profile.ready);
export const canWriteProfile = profileReady;

// ---------------------------------------------------------------- loaders
async function loader(name, fn, force) {
  // a load that is already running answers a plain request; a forced one asks again afterwards, because what is in flight
  // may have been read before the change that made the caller ask
  while (S.loading[name]) {
    if (!force) return S.loading[name];
    await S.loading[name].catch(() => {});
  }
  if (!force && S[name]) return S[name];
  S.loading[name] = (async () => {
    try { return await fn(); } finally { delete S.loading[name]; }
  })();
  return S.loading[name];
}

export async function refreshBridge() {
  const r = await get("/api/bridge");
  S.bridge = r;
  return r;
}

export async function refreshStatus() {
  const r = await rpc("status");
  if (r.ok) { S.status = r; S.statusError = null; }
  else { S.status = null; S.statusError = r.error; }
  emit("status", S.status);
  return r;
}

export const loadProgression = (force) => loader("prog", async () => {
  const r = await rpc("progression");
  if (r.ok) { S.prog = r; emit("prog", r); }
  return r.ok ? r : null;
}, force);

export const loadItems = (force) => loader("items", async () => {
  const r = await rpc("itemList");
  if (r.ok) S.items = r;
  else toast("读取物品目录失败", r.error.message, "bad");
  return r.ok ? r : null;
}, force);

export const loadRecipes = (force) => loader("recipes", async () => {
  const r = await rpc("recipes");
  if (r.ok) S.recipes = r;
  else toast("读取蓝图失败", r.error.message, "bad");
  return r.ok ? r : null;
}, force);

export const loadGear = (force) => loader("gear", async () => {
  const r = await rpc("gearList");
  if (r.ok) S.gear = r;
  else toast("读取装备列表失败", r.error.message, "bad");
  return r.ok ? r : null;
}, force);

export const loadShips = (force) => loader("ships", async () => {
  const r = await rpc("ships");
  if (r.ok) S.ships = r;
  else toast("读取舰船失败", r.error.message, "bad");
  return r.ok ? r : null;
}, force);

export async function loadPlayers() {
  const r = await rpc("players");
  if (r.ok) S.players = r.players || [];
  return S.players;
}

export async function loadHistory() {
  const r = await get("/api/history");
  if (r.ok) { S.history = r.items; emit("history", S.history); }
  return S.history;
}

export { post, get, rpc, load, save };

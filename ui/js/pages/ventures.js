import { S, agentHas, profileReady, loadHistory, rpc, load, save } from "../store.js";
import { $, $$, esc, fmt, icon, confirmDialog } from "../ui.js";
import { notReady } from "./common.js";

// Ventures (委托): the game's quests. Pick one, see what it asks for and what it gives, and complete it right away: the game
// hands out the rewards exactly as when the quest is done (unlocks, experience, credits, ingots, its Steam achievement).
let view = null;
let busy = false;
let data = null; // { ventures, hidden } as the game reports them
let last = null; // the outcome of the last completion, shown under the button: { key, kind: ok|bad, text }
const ui = { kind: load("vt.kind", "all"), sel: load("vt.sel", null), q: "" };

const KIND_LABEL = { main: "主线", side: "支线", ship: "飞船", region: "星域", level: "等级奖励", blueprint: "蓝图", component: "组件", npc: "人物", other: "其他" };
const KIND_COLOR = { main: "#f0c75a", side: "#3ccfc1", ship: "#55c7ff", region: "#b79bff", level: "#5ee0a0" };
const STATE_LABEL = { ready: "可交付", active: "进行中", idle: "未开始", completed: "已完成" };
const STATE_ORDER = ["ready", "active", "idle", "completed"];
const REWARD_LABEL = { trait: "特性", helmet: "头盔", outfit: "服装", region: "星域", ship: "飞船", other: "解锁" };

const ventures = () => (data ? data.ventures : []);
const byKey = (k) => ventures().find((v) => v.key === k) || null;
const kindColor = (k) => KIND_COLOR[k] || "#8a97b8";

function filtered() {
  const q = ui.q.trim().toLowerCase();
  return ventures().filter((v) => (ui.kind === "all" || v.kind === ui.kind)
    && (!q || v.name.toLowerCase().includes(q) || v.description.toLowerCase().includes(q) || v.unlocks.some((u) => u.name.toLowerCase().includes(q))));
}

function rewardsText(v) {
  const parts = [];
  if (v.experience) parts.push(`经验 ${fmt(v.experience)}`);
  if (v.credits) parts.push(`信用点 ${fmt(v.credits)}`);
  if (v.ingots) parts.push(`锭 ${fmt(v.ingots)}`);
  for (const u of v.unlocks) if (u.name) parts.push(u.name);
  return parts.join("、");
}

// what to know before completing it
function notes(v) {
  const out = [];
  if (v.kind === "main") out.push(["warn", "这是主线委托：直接完成会跳过这一段剧情进度，之后的主线会按已完成继续。"]);
  if (v.state === "idle" && !v.prerequisitesMet) out.push(["warn", "前置条件还没满足（通常是更早的委托还没完成），正常玩的话它现在还不会出现。"]);
  if (!v.inSeason) out.push(["info", "这是季节活动委托，现在不在活动期。"]);
  if (v.unlocks.some((u) => u.kind === "ship")) out.push(["info", "奖励是飞船设计：还没有这种船会加入机库；已经有的话，奖励是更高型号才会升级它，同型号没有变化。"]);
  if (v.achievement) out.push(["info", "完成时会同时解锁这个委托对应的 Steam 成就。"]);
  return out;
}

// ------------------------------------------------------------------ the list
function chipsHTML() {
  const counts = {};
  for (const v of ventures()) counts[v.kind] = (counts[v.kind] || 0) + 1;
  const chip = (id, label, n) => `<button class="chip ${ui.kind === id ? "on" : ""}" data-kind="${id}">${esc(label)}<span class="count">${n}</span></button>`;
  return chip("all", "全部", ventures().length) + Object.keys(KIND_LABEL).filter((k) => counts[k]).map((k) => chip(k, KIND_LABEL[k], counts[k])).join("");
}

function rowHTML(v) {
  return `<button type="button" class="prow ${v.key === ui.sel ? "sel" : ""} ${v.state === "completed" ? "done" : ""}" data-key="${esc(v.key)}" style="--gc:${kindColor(v.kind)}" title="${esc(v.description)}">
    <span class="pname">${esc(v.name)}</span>${v.achievement ? '<span class="tag" title="完成时解锁 Steam 成就">成就</span>' : ""}<span class="tag">${esc(KIND_LABEL[v.kind] || v.kind)}</span>
  </button>`;
}

function renderList() {
  const list = filtered();
  $("#vt-chips", view).innerHTML = chipsHTML();
  $("#vt-count", view).textContent = `${list.length} 个委托`;
  const open = ventures().filter((v) => v.state !== "completed").length;
  $("#vt-open", view).textContent = `未完成 ${open}`;
  let html = "";
  for (const state of STATE_ORDER) {
    const rows = list.filter((v) => v.state === state);
    if (!rows.length) continue;
    html += `<div class="pgroup"><span>${STATE_LABEL[state]}</span><span class="num">${rows.length}</span></div>` + rows.map(rowHTML).join("");
  }
  $("#vt-list", view).innerHTML = html || `<div class="empty" style="padding:40px 10px">${icon("search")}<h3>没有匹配的委托</h3><p>换个关键词，或者切换分类试试。</p></div>`;
}

// ------------------------------------------------------------------ the venture
function rewardsHTML(v) {
  const cur = [["经验", v.experience], ["信用点", v.credits], ["锭", v.ingots]].filter(([, n]) => n);
  const unlocks = v.unlocks.filter((u) => u.name);
  if (!cur.length && !unlocks.length) return `<div class="muted">这个委托没有列出奖励。</div>`;
  return `
    ${cur.length ? `<div class="vt-cur">${cur.map(([l, n]) => `<div><div class="l">${l}</div><div class="v num">+${fmt(n)}</div></div>`).join("")}</div>` : ""}
    ${unlocks.length ? `<div class="vt-unlocks">${unlocks.map((u) => `<div class="vt-unlock"><span class="badge">${esc(REWARD_LABEL[u.kind] || "解锁")}</span><span>${esc(u.name)}</span></div>`).join("")}</div>` : ""}`;
}

function renderActs() {
  const v = byKey(ui.sel);
  const el = $("#vt-acts", view);
  if (!v || !el) return;
  const html = v.state === "completed"
    ? `<button type="button" class="btn" disabled>${icon("check")}已完成</button>`
    : `<button type="button" class="btn primary" id="vt-complete" ${busy ? "disabled" : ""}>${icon("check")}${busy ? "处理中…" : "直接完成"}</button>`;
  if (el.innerHTML !== html) el.innerHTML = html;
}

function renderStatus() {
  const el = $("#vt-status", view);
  if (!el) return;
  const html = last && last.key === ui.sel
    ? `<span class="${last.kind}">${icon(last.kind === "ok" ? "check" : "alert")}</span><span class="msg">${esc(last.text)}</span>`
    : "";
  if (el.innerHTML !== html) el.innerHTML = html;
}

function renderDetail() {
  const v = byKey(ui.sel);
  $("#vt-empty", view).hidden = !!v;
  $("#vt-pane", view).hidden = !v;
  if (!v) return;
  const color = kindColor(v.kind);
  $("#vt-head", view).innerHTML = `
    <div class="row"><span class="badge" style="background:color-mix(in srgb, ${color} 18%, transparent);color:${color}">${esc(KIND_LABEL[v.kind] || v.kind)}</span><span class="badge ${v.state === "completed" ? "good" : ""}">${STATE_LABEL[v.state]}</span>${v.achievement ? '<span class="badge violet">Steam 成就</span>' : ""}</div>
    <div class="detail-name">${esc(v.name)}</div>`;
  const n = notes(v);
  $("#vt-body", view).innerHTML = `
    <div class="vt-section"><div class="vt-title">要求</div><div class="detail-desc">${esc(v.description || "（游戏没有提供说明）")}</div></div>
    <div class="vt-section"><div class="vt-title">奖励</div>${rewardsHTML(v)}</div>
    ${v.state !== "completed" && n.length ? `<div class="vt-section vt-notes">${n.map(([kind, t]) => `<div class="callout ${kind === "info" ? "info" : ""}">${icon(kind === "info" ? "info" : "alert")}<div>${esc(t)}</div></div>`).join("")}</div>` : ""}`;
  renderActs();
  renderStatus();
}

function select(key) {
  ui.sel = key;
  save("vt.sel", key);
  $$("#vt-list .prow", view).forEach((el) => el.classList.toggle("sel", el.dataset.key === key));
  renderDetail();
}

async function reload() {
  const r = await rpc("ventures");
  if (!view) return false;
  if (!r.ok) {
    $("#vt-list", view).innerHTML = `<div class="empty" style="padding:40px 10px">${icon("alert")}<h3>读取委托失败</h3><p>${esc(r.error ? r.error.message : "")}</p><button class="btn" id="vt-reload">重试</button></div>`;
    return false;
  }
  data = r;
  renderList();
  renderDetail();
  return true;
}

async function complete() {
  const v = byKey(ui.sel);
  if (!v || busy || v.state === "completed") return;
  const items = [];
  if (v.experience) items.push(`经验 +${fmt(v.experience)}`);
  if (v.credits) items.push(`信用点 +${fmt(v.credits)}`);
  if (v.ingots) items.push(`锭 +${fmt(v.ingots)}`);
  for (const u of v.unlocks) if (u.name) items.push(`${REWARD_LABEL[u.kind] || "解锁"}：${u.name}`);
  for (const [, t] of notes(v)) items.push(t);
  const ok = await confirmDialog({
    title: `直接完成「${v.name}」？`,
    message: "游戏会立即发放下面的奖励并保存存档。这一步不能撤销，完成前会自动备份存档。",
    items,
    confirmText: "完成并领取奖励",
  });
  if (!ok) return;
  busy = true;
  renderActs();
  const r = await rpc("completeVenture", v.key);
  busy = false;
  if (r.ok) {
    const got = rewardsText(v);
    last = { key: v.key, kind: "ok", text: r.changed ? `已完成「${v.name}」${got ? "，获得：" + got : ""}。` : "这个委托已经完成过了。" };
    S.prog = null; // currencies and experience changed
    S.ships = null; // a ship design may have been unlocked
  } else {
    last = { key: v.key, kind: "bad", text: r.error ? r.error.message : "游戏没有回应" };
  }
  loadHistory();
  if (view) { renderActs(); renderStatus(); }
  await reload();
}

const shellHTML = () => `
  <div class="md">
    <aside class="md-side">
      <div class="md-side-head">
        <div class="row" style="gap:8px"><div class="search" style="flex:1"><input class="input" id="vt-q" placeholder="搜索委托或奖励（按 / 聚焦）" value="${esc(ui.q)}" autocomplete="off">${icon("search")}</div><button type="button" class="btn icon" id="vt-reload" title="重新读取委托">${icon("refresh")}</button></div>
        <div class="chips sm" id="vt-chips"></div>
      </div>
      <div class="plist" id="vt-list"><div class="skeleton" style="height:100%"></div></div>
      <div class="md-side-foot"><span class="num" id="vt-count"></span><span class="num" id="vt-open"></span></div>
    </aside>
    <section class="md-main">
      <div class="detail-empty" id="vt-empty"><div class="empty" style="padding:40px 10px">${icon("flag")}<h3>选一个委托</h3><p>左边是游戏委托日志里的委托。选一个看看它要求什么、奖励什么，可以直接完成并领取奖励。</p></div></div>
      <div class="md-pane" id="vt-pane" hidden>
        <header class="md-head">
          <div class="md-title" id="vt-head"></div>
          <div class="md-acts" id="vt-acts"></div>
        </header>
        <div class="md-status" id="vt-status" aria-live="polite"></div>
        <div class="md-body" id="vt-body"></div>
      </div>
    </section>
  </div>`;

export default {
  id: "ventures",
  title: "委托",
  sub: "直接完成委托并领取奖励",
  icon: "flag",
  group: "main",

  async render(v) {
    view = v;
    data = null;
    if (!profileReady()) { view.innerHTML = notReady("委托功能", true); return; }
    if (!agentHas(3)) {
      view.innerHTML = `<div class="callout info">${icon("info")}<div><b>游戏里运行的还是旧版本的修改器脚本。</b>委托功能要<b>重启一次游戏</b>后才能用（脚本只在游戏启动时装进去，装好后不能替换）。</div></div>`;
      return;
    }
    view.classList.add("view-fill");
    view.innerHTML = shellHTML();
    view.oninput = (e) => {
      if (e.target.id === "vt-q") { ui.q = e.target.value; renderList(); }
    };
    view.onkeydown = (e) => {
      if (e.key === "Escape" && e.target.id === "vt-q") { e.target.value = ""; ui.q = ""; renderList(); }
    };
    view.onclick = async (e) => {
      const row = e.target.closest("#vt-list .prow");
      if (row) return select(row.dataset.key);
      const chip = e.target.closest("[data-kind]");
      if (chip) { ui.kind = chip.dataset.kind; save("vt.kind", ui.kind); return renderList(); }
      if (e.target.closest("#vt-complete")) return complete();
      if (e.target.closest("#vt-reload")) return reload();
    };
    if (await reload()) {
      const row = $("#vt-list .prow.sel", view);
      if (row) row.scrollIntoView({ block: "nearest" });
    }
  },

  focusSearch() {
    const el = $("#vt-q", view);
    if (el) { el.focus(); el.select(); return true; }
    return false;
  },

  update() {
    if (!view) return;
    const ready = profileReady() && agentHas(3);
    const showing = !!$("#vt-list", view);
    if (!profileReady() && showing) view.innerHTML = notReady("委托功能", true);
    else if (ready && !showing) this.render(view);
  },
};

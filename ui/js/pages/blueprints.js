import { S, AGENT_API, call, profileReady, loadGear, loadRecipes, loadHistory, rpc, post, load, save } from "../store.js";
import { $, $$, esc, fmt, icon, toast, confirmDialog } from "../ui.js";
import { notReady } from "./common.js";
import { createAttrEditor, TIERS } from "../attr_editor.js";

// A blueprint is an item (a weapon or a ship part) with attributes: pick the item, set its attributes, and put it into the
// discovery history or straight into a blueprint slot. Whether the recipe is unlocked does not matter, and a model may have
// as many blueprints as there are slots, so there is no state to track here.
let view = null;
let editor = null;
let busy = false;
const ui = {
  page: load("bp.page", "new"), // new | mine | recipes
  cat: load("bp.cat", "all"),
  q: "",
  sel: load("bp.sel", null),
  mode: load("bp.mode", "history"), // the button that is highlighted: the last one used
  rstatus: load("bp.rstatus", "locked"),
  pick: new Set(),
};
let equip = null; // lazily loaded "my blueprints" data
let last = null; // the outcome of the last add, shown under the buttons: { key, kind: ok|bad, mode, text, historyId, undoable }

const gear = () => (S.gear ? S.gear.gear : []);
const byKey = (k) => gear().find((g) => g.key === k) || null;
const slotsOf = (guid) => ((S.gear && S.gear.categories) || []).find((c) => c.guid === guid)?.slots || null;
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
const untranslated = (g) => /^Missing loc|^UNNAMED$/.test(clean(g.display));
const staleAgent = () => !!(S.status && S.status.agentApi !== AGENT_API);

// the order the game's crafting UI lists the categories in (unknown ones last)
const CAT_ORDER = ["武器", "特殊武器", "驾驶员火炮", "多炮塔", "引擎", "反应堆", "护盾再生器", "辅助发电机", "传感器"];
const catRank = (name) => { const i = CAT_ORDER.indexOf(name); return i < 0 ? 99 : i; };
const CAT_COLOR = { 武器: "#ff7a6b", 特殊武器: "#ff7a6b", 驾驶员火炮: "#ffa64d", 多炮塔: "#ffa64d" };
const catColor = (name) => CAT_COLOR[name] || "#5be1d5";

function visible() {
  const q = ui.q.trim().toLowerCase();
  return gear().filter((g) => {
    if (ui.cat !== "all" && g.categoryGuid !== ui.cat) return false;
    return !q || clean(g.display).toLowerCase().includes(q) || g.name.toLowerCase().includes(q) || g.category.includes(q);
  }).sort((a, b) => catRank(a.category) - catRank(b.category) || a.category.localeCompare(b.category, "zh")
    || Number(untranslated(a)) - Number(untranslated(b)) || clean(a.display).localeCompare(clean(b.display), "zh"));
}

// ------------------------------------------------------------------ the page that makes blueprints
function chipsHTML() {
  const cats = (S.gear ? S.gear.categories : []).slice().sort((a, b) => catRank(a.name) - catRank(b.name));
  const count = (guid) => gear().filter((g) => g.categoryGuid === guid).length;
  const chip = (id, label, n, title = "") => `<button class="chip ${ui.cat === id ? "on" : ""}" data-cat="${esc(id)}"${title ? ` title="${esc(title)}"` : ""}>${esc(label)}<span class="count">${n}</span></button>`;
  return chip("all", "全部", gear().length) + cats.map((c) => chip(c.guid, c.name, count(c.guid), c.slots ? `蓝图槽 ${c.slots.used}/${c.slots.total}` : "")).join("");
}

function rowHTML(g) {
  return `<button type="button" class="prow ${g.key === ui.sel ? "sel" : ""}" data-key="${esc(g.key)}" style="--gc:${catColor(g.category)}" title="${esc(g.name)}">
    <span class="pname">${esc(clean(g.display))}</span>${untranslated(g) ? '<span class="tag lock">未翻译</span>' : ""}
  </button>`;
}

const slotText = (sl) => (sl ? `蓝图槽 ${sl.used}/${sl.total}` : "");

// the list, grouped by category; each group says how full its blueprint slots are
function renderGrid() {
  const list = visible();
  $("#bp-chips", view).innerHTML = chipsHTML();
  $("#bp-count", view).textContent = `${list.length} 件装备`;
  let html = "";
  let cat = null;
  for (const g of list) {
    if (g.categoryGuid !== cat) {
      cat = g.categoryGuid;
      const sl = slotsOf(cat);
      html += `<div class="pgroup"><span>${esc(g.category)}</span><span class="num ${sl && sl.used >= sl.total ? "full" : ""}" data-slots="${esc(cat)}">${slotText(sl)}</span></div>`;
    }
    html += rowHTML(g);
  }
  $("#bp-grid", view).innerHTML = list.length
    ? html
    : `<div class="empty" style="padding:40px 10px">${icon("search")}<h3>没有匹配的装备</h3><p>换个关键词，或者切换分类试试。</p></div>`;
}

// the slot counts and the discovery history change when something is added: update the words, never the page
function refreshMeta() {
  if (!view || ui.page !== "new" || !$("#bp-slot", view)) return;
  const h = S.gear && S.gear.history ? S.gear.history : { count: 0, max: 50 };
  $("#bp-hist", view).textContent = `发现历史 ${h.count} / ${h.max}`;
  $$("#bp-chips .chip[data-cat]", view).forEach((c) => {
    const sl = slotsOf(c.dataset.cat);
    if (sl) c.title = slotText(sl);
  });
  $$("#bp-grid [data-slots]", view).forEach((el) => {
    const sl = slotsOf(el.dataset.slots);
    el.textContent = slotText(sl);
    el.classList.toggle("full", !!sl && sl.used >= sl.total);
  });
  syncButtons();
}

function syncButtons() {
  if (!view || !$("#bp-slot", view)) return;
  const g = byKey(ui.sel);
  const st = editor ? editor.state() : null;
  const sl = g ? slotsOf(g.categoryGuid) : null;
  const full = !!sl && sl.used >= sl.total;
  const ready = !!g && !!st && st.ok && !busy;
  const hb = $("#bp-history", view);
  const sb = $("#bp-slot", view);
  hb.disabled = !ready;
  sb.disabled = !ready || full;
  const shtml = `${icon("blueprint")}存入蓝图槽${sl ? `<span class="num" style="opacity:.75">${sl.used}/${sl.total}</span>` : ""}`;
  if (sb.innerHTML !== shtml) sb.innerHTML = shtml;
  if (!hb.innerHTML) hb.innerHTML = `${icon("list")}加入发现历史`;
  hb.classList.toggle("primary", ui.mode === "history");
  sb.classList.toggle("primary", ui.mode === "slot");
  sb.title = full ? `「${g.category}」的蓝图槽已满，请先在游戏里清出一个槽位` : "放进空闲的蓝图槽，马上能在制作台制作";
  hb.title = "先记进游戏的发现历史，之后在“我的蓝图”页（或游戏里的扫描台）保存为蓝图";
  renderStatus(g, sl, full);
}

// under the buttons: what the last add did (with undo), and why a button is off
function renderStatus(g, sl, full) {
  const el = $("#bp-hint", view);
  if (!el) return;
  const h = S.gear && S.gear.history ? S.gear.history : { count: 0, max: 50 };
  const parts = [];
  if (last && g && last.key === g.key) {
    const ic = last.kind === "ok" ? "check" : "alert";
    parts.push(`<span class="${last.kind}">${icon(ic)}</span><span class="msg">${esc(last.text)}</span>`);
    if (last.kind === "ok" && last.mode === "history") parts.push(`<button type="button" class="btn sm" data-goto="mine">去保存为蓝图</button>`);
    if (last.undoable) parts.push(`<button type="button" class="btn sm ghost" data-undo-last>${icon("undo")}撤销</button>`);
  }
  if (full) parts.push(`<span class="warn">${icon("alert")}「${esc(g.category)}」的蓝图槽已满（${sl.used}/${sl.total}），只能加入发现历史。</span>`);
  if (h.count >= h.max) parts.push(`<span class="warn">${icon("alert")}发现历史已满 ${h.max} 条，再加一条会挤掉最早的。</span>`);
  const html = parts.join("");
  if (el.innerHTML !== html) el.innerHTML = html;
}

function select(key) {
  const g = byKey(key);
  if (!g) return;
  ui.sel = key;
  save("bp.sel", key);
  $$("#bp-grid .prow", view).forEach((el) => el.classList.toggle("sel", el.dataset.key === key));
  $("#bp-empty", view).hidden = true;
  $("#bp-pane", view).hidden = false;
  $("#bp-tags", view).innerHTML = `<span class="badge" style="background:color-mix(in srgb, ${catColor(g.category)} 18%, transparent);color:${catColor(g.category)}">${esc(g.category)}</span>${untranslated(g) ? '<span class="badge warn">未翻译</span>' : ""}`;
  $("#bp-name", view).textContent = clean(g.display);
  $("#bp-code", view).textContent = g.name;
  if (!editor) {
    editor = createAttrEditor($("#bp-attr", view), {
      call: (spec, action) => rpc("gearEdit", ui.sel, spec, action),
      tierKey: "bp.tier",
      onChange: syncButtons,
    });
  }
  syncButtons();
  editor.load();
}

async function add(mode) {
  const g = byKey(ui.sel);
  if (!g || !editor || busy) return;
  await editor.settled(); // a change that is still on its way to the game counts
  const st = editor.state();
  if (!st.valid) { toast("属性还不能用", st.errors[0] || "请先处理编辑器里的提示", "warn"); return; }
  busy = true;
  syncButtons();
  // the outcome goes under the buttons, failures included: no toast on top of the page
  const r = await rpc("makeBlueprint", g.key, mode, editor.spec());
  busy = false;
  if (r.ok) {
    ui.mode = mode;
    save("bp.mode", mode);
    last = { key: g.key, kind: "ok", mode, text: r.message || (mode === "slot" ? "已存入蓝图槽" : "已加入发现历史"), historyId: r.historyId, undoable: !!r.undoable };
    loadHistory();
  } else {
    last = { key: g.key, kind: "bad", mode, text: (r.error && r.error.message) || "游戏没有回应" };
  }
  await loadGear(true);
  refreshMeta();
}

async function undoLast() {
  if (!last || !last.undoable || busy) return;
  const was = last;
  busy = true;
  syncButtons();
  const r = await post("/api/undo", { id: was.historyId });
  busy = false;
  if (!r.ok) last = { ...was, kind: "bad", text: "撤销失败：" + ((r.error && r.error.message) || "游戏没有回应") };
  else if (r.changed === 0) last = { ...was, kind: "bad", undoable: false, text: "没能撤销：这份蓝图在游戏里已经被改动或移走了。" };
  else last = { ...was, kind: "ok", mode: "undone", undoable: false, text: was.mode === "slot" ? "已撤销，蓝图槽已清出。" : "已撤销，已从发现历史里移除。" };
  loadHistory();
  await loadGear(true);
  refreshMeta();
}

function paintNew() {
  const body = $("#bp-body", view);
  body.className = "fill md-fill";
  body.innerHTML = `
    <div class="md">
      <aside class="md-side">
        <div class="md-side-head">
          <div class="search"><input class="input" id="bp-q" placeholder="搜索装备（按 / 聚焦）" value="${esc(ui.q)}" autocomplete="off">${icon("search")}</div>
          <div class="chips sm" id="bp-chips"></div>
        </div>
        <div class="plist" id="bp-grid"></div>
        <div class="md-side-foot"><span class="num" id="bp-count"></span><span class="num" id="bp-hist" title="游戏最多保留 50 条发现历史，再多会挤掉最早的"></span></div>
      </aside>
      <section class="md-main" id="bp-detail">
        <div class="detail-empty" id="bp-empty"><div class="empty" style="padding:40px 10px">${icon("blueprint")}<h3>选一件装备</h3><p>点左边的装备，调整它的品质、词条和等级，再加入发现历史或存进蓝图槽。不用管配方有没有解锁，同一件装备也可以有很多份蓝图。</p></div></div>
        <div class="md-pane" id="bp-pane" hidden>
          <header class="md-head">
            <div class="md-title">
              <div class="row" id="bp-tags"></div>
              <div class="detail-name" id="bp-name"></div>
              <div class="detail-code" id="bp-code"></div>
            </div>
            <div class="md-acts"><button type="button" class="btn" id="bp-history"></button><button type="button" class="btn" id="bp-slot"></button></div>
          </header>
          <div class="md-status" id="bp-hint" aria-live="polite"></div>
          <div class="md-body"><div id="bp-attr"></div></div>
        </div>
      </section>
    </div>`;
  editor = null;
  renderGrid();
  if (ui.sel && byKey(ui.sel)) {
    select(ui.sel);
    const row = $("#bp-grid .prow.sel", view);
    if (row) row.scrollIntoView({ block: "nearest" });
  }
  refreshMeta();
}

// ------------------------------------------------------------------ my blueprints
async function loadEquip() {
  if (equip) return equip;
  const r = await rpc("blueprints");
  equip = r.ok ? r : { error: r.error };
  return equip;
}

const RARITY = Object.fromEntries(TIERS.map((t) => [t.name, [t.label, t.color]]));

function equipHTML(e) {
  if (e.error) return `<div class="empty">${icon("alert")}<h3>读取失败</h3><p>${esc(e.error.message)}</p></div>`;
  const rar = (r) => { const [label, color] = RARITY[r] || [r, "#b9c4d8"]; return `<span class="badge" style="background:color-mix(in srgb, ${color} 18%, transparent);color:${color}">${label}</span>`; };
  const owned = e.owned.slice().sort((a, b) => catRank(a.category) - catRank(b.category) || a.category.localeCompare(b.category, "zh") || a.slot - b.slot);
  return `
    <div class="callout info" style="margin-bottom:16px">${icon("info")}<div>这里是你存档里<b>已保存的蓝图</b>（制作台里能制作的装备）和各分类的槽位。新蓝图先进入下面的<b>发现历史</b>（游戏里捡到、扫描过的装备，游戏的扫描台里也是这份列表），点“保存为蓝图”后放进该分类的第一个空槽。</div></div>
    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(150px,1fr));margin-bottom:18px">
      ${e.capacities.map((c) => { const used = owned.filter((o) => o.categoryGuid === c.categoryGuid).length; return `<div class="mini" style="--c:#55c7ff"><div class="ml">${esc(c.category)}</div><div class="mv">${used} / ${c.max}</div><div class="mm">已购扩容 ${c.purchased}</div></div>`; }).join("")}
    </div>
    <div class="list" style="--cols:1">
      <div class="list-head" style="grid-template-columns:minmax(0,2fr) 1fr 90px 70px 90px"><span>装备</span><span>分类</span><span>品质</span><span>等级</span><span>词条</span></div>
      ${owned.map((o) => `<div class="list-row" style="grid-template-columns:minmax(0,2fr) 1fr 90px 70px 90px"><div class="rname">${esc(clean(o.name) || "未命名")}</div><div class="muted">${esc(o.category)} · 槽位 ${o.slot + 1}</div><div>${rar(o.rarity)}</div><div class="num">Lv.${o.level}</div><div class="muted num">${o.modules.length} 个</div></div>`).join("") || '<div class="muted" style="padding:20px">还没有保存的蓝图。</div>'}
    </div>
    <div class="section-title">发现历史（可保存为蓝图）${e.history.length ? `　<span class="muted num">${e.history.length} / 50</span>` : ""}</div>
    ${e.history.length ? `<div class="list">${e.history.map((h) => `<div class="list-row" style="grid-template-columns:minmax(0,2fr) 1fr 90px 70px 120px"><div class="rname">${esc(clean(h.name) || "未命名")}</div><div class="muted">${esc(h.category)}</div><div>${rar(h.rarity)}</div><div class="num">Lv.${h.level}</div><div><button class="btn sm" data-savebp="${esc(h.instanceGuid)}">保存为蓝图</button></div></div>`).join("")}</div>` : '<div class="muted" style="padding:6px 2px 14px">发现历史是空的。到“新建蓝图”页选一件装备，点“加入发现历史”。</div>'}`;
}

async function paintMine() {
  const body = $("#bp-body", view);
  body.innerHTML = `<div class="skeleton" style="height:420px"></div>`;
  const e = await loadEquip();
  if (view && ui.page === "mine") $("#bp-body", view).innerHTML = equipHTML(e);
}

// ------------------------------------------------------------------ recipes of consumables
const consumables = () => (S.recipes ? S.recipes.recipes : []).filter((r) => r.kind === "craftable" && r.unlockable);

function recipeRows() {
  const list = consumables().filter((r) => ui.rstatus === "all" || (ui.rstatus === "locked" ? !r.unlocked : r.unlocked))
    .sort((a, b) => a.category.localeCompare(b.category, "zh") || clean(a.display).localeCompare(clean(b.display), "zh"));
  if (!list.length) return `<div class="empty">${icon("check")}<h3>${ui.rstatus === "locked" ? "消耗品配方都解锁了" : "没有符合条件的配方"}</h3></div>`;
  return `<div class="list recipe-list">
    <div class="list-head"><span></span><span>配方</span><span>分类</span><span>制作成本</span><span>状态</span></div>
    ${list.map((r) => `
      <div class="list-row ${ui.pick.has(r.key) ? "sel" : ""} ${r.unlocked ? "done" : ""}" data-key="${esc(r.key)}">
        <label class="check"><input type="checkbox" data-pick="${esc(r.key)}" ${ui.pick.has(r.key) ? "checked" : ""} ${r.unlocked ? "disabled" : ""}><i></i></label>
        <div style="min-width:0"><div class="rname">${esc(clean(r.display))}</div><div class="rcode">${esc(r.name)}</div></div>
        <div class="muted">${esc(r.category || "—")}</div>
        <div class="num muted">${r.cost ? fmt(r.cost) + " 物质" : "—"}</div>
        <div>${r.unlocked ? `<span class="badge good">${icon("check")}已解锁</span>` : '<span class="badge">未解锁</span>'}</div>
      </div>`).join("")}
  </div>`;
}

function recipeSelbar() {
  const n = ui.pick.size;
  if (!n) return "";
  return `<div class="selbar"><b class="num">已选 ${n} 项</b><span class="muted">解锁会写入存档、改变游戏进度</span><div class="spacer"></div><button class="btn" id="rc-clear">清除选择</button><button class="btn primary" id="rc-unlock" ${busy ? "disabled" : ""}>${icon("unlock")}解锁所选（${n}）</button></div>`;
}

function paintRecipes() {
  const body = $("#bp-body", view);
  const list = consumables();
  const locked = list.filter((r) => !r.unlocked).length;
  body.innerHTML = `
    <div class="callout info" style="margin-bottom:14px">${icon("info")}<div>这里只管<b>消耗品、弹药、工具</b>的配方：解锁后就能在制作台制作。武器和飞船部件不需要解锁配方，直接在“新建蓝图”页做蓝图就行。</div></div>
    <div class="items-toolbar"><div class="row">
      <div class="seg" id="rc-status">
        <button data-rstatus="locked" class="${ui.rstatus === "locked" ? "on" : ""}">未解锁 ${locked}</button>
        <button data-rstatus="unlocked" class="${ui.rstatus === "unlocked" ? "on" : ""}">已解锁 ${list.length - locked}</button>
        <button data-rstatus="all" class="${ui.rstatus === "all" ? "on" : ""}">全部 ${list.length}</button>
      </div>
    </div></div>
    <div id="rc-rows">${recipeRows()}</div><div id="rc-bar">${recipeSelbar()}</div>`;
}

async function unlockPicked() {
  const list = consumables().filter((r) => ui.pick.has(r.key) && !r.unlocked);
  if (!list.length || busy) return;
  const ok = await confirmDialog({
    title: `解锁 ${list.length} 个制作配方？`,
    message: "只改配方的解锁状态：会写入你的存档并改变游戏进度。之后可以在“记录与设置”页撤销（存档已自动备份）。",
    items: list.map((r) => `${clean(r.display)}　· ${r.category}`),
    confirmText: "确认解锁",
  });
  if (!ok) return;
  busy = true;
  $("#rc-bar", view).innerHTML = recipeSelbar();
  const r = await call("unlockRecipes", list.map((x) => x.key));
  busy = false;
  if (r.ok) {
    const done = r.results.filter((x) => x.ok && x.changed).length;
    toast(`已解锁 ${done} 个配方`, r.failed ? `${r.failed} 项失败：` + r.results.filter((x) => !x.ok).map((x) => x.error).join("；") : "已写入存档", r.failed ? "warn" : "good");
  }
  ui.pick.clear();
  await loadRecipes(true);
  if (view && ui.page === "recipes") paintRecipes();
  loadHistory();
}

// ------------------------------------------------------------------ the page
async function paintPage() {
  const body = $("#bp-body", view);
  body.className = "fill";
  if (editor) { editor.destroy(); editor = null; }
  $$("#bp-tabs button", view).forEach((b) => b.classList.toggle("on", b.dataset.tab === ui.page));
  if (ui.page === "new" && staleAgent()) {
    body.innerHTML = `<div class="callout info">${icon("info")}<div><b>游戏里运行的还是旧版本的修改器脚本。</b>这一页的新功能要<b>重启一次游戏</b>后才能用（脚本只在游戏启动时装进去，装好后不能替换）。重启后打开修改器就行。</div></div>`;
    return;
  }
  if (ui.page === "new") {
    if (!S.gear) { body.innerHTML = `<div class="skeleton" style="height:420px"></div>`; await loadGear(false); if (!view) return; }
    if (!S.gear) { body.innerHTML = `<div class="empty">${icon("alert")}<h3>读取装备列表失败</h3><p>请确认已进入大厅或飞船。</p><button class="btn" id="bp-reload">重试</button></div>`; return; }
    paintNew();
    loadGear(true).then(() => refreshMeta()); // the game may have changed behind the page's back
  } else if (ui.page === "mine") {
    paintMine();
  } else {
    if (!S.recipes) { body.innerHTML = `<div class="skeleton" style="height:420px"></div>`; await loadRecipes(false); if (!view) return; }
    if (!S.recipes) { body.innerHTML = `<div class="empty">${icon("alert")}<h3>读取配方失败</h3><p>请确认已进入大厅或飞船。</p><button class="btn" id="bp-reload">重试</button></div>`; return; }
    paintRecipes();
  }
}

export default {
  id: "blueprints",
  title: "蓝图",
  sub: "选一件装备，调整属性，做成蓝图",
  icon: "blueprint",
  group: "main",

  async render(v) {
    view = v;
    editor = null;
    equip = null;
    if (!profileReady()) { view.innerHTML = notReady("蓝图功能", true); return; }
    if (!["new", "mine", "recipes"].includes(ui.page)) ui.page = "new";
    view.classList.add("view-fill");
    view.innerHTML = `
      <div class="tabs" id="bp-tabs"><button data-tab="new">新建蓝图</button><button data-tab="mine">我的蓝图</button><button data-tab="recipes">消耗品配方</button></div>
      <div id="bp-body"></div>`;
    view.oninput = (e) => {
      if (e.target.id === "bp-q") { ui.q = e.target.value; renderGrid(); }
    };
    view.onchange = (e) => {
      const pick = e.target.closest("[data-pick]");
      if (pick) {
        pick.checked ? ui.pick.add(pick.dataset.pick) : ui.pick.delete(pick.dataset.pick);
        pick.closest(".list-row").classList.toggle("sel", pick.checked);
        $("#rc-bar", view).innerHTML = recipeSelbar();
      }
    };
    view.onkeydown = (e) => {
      if (e.key === "Escape" && e.target.id === "bp-q") { e.target.value = ""; ui.q = ""; renderGrid(); }
    };
    view.onclick = async (e) => {
      const tab = e.target.closest("#bp-tabs [data-tab]") || e.target.closest("[data-goto]");
      if (tab) { ui.page = tab.dataset.tab || tab.dataset.goto; save("bp.page", ui.page); equip = null; return paintPage(); }
      const card = e.target.closest("#bp-grid .prow");
      if (card) return select(card.dataset.key);
      const cat = e.target.closest("[data-cat]");
      if (cat) { ui.cat = cat.dataset.cat; save("bp.cat", ui.cat); return renderGrid(); }
      if (e.target.closest("#bp-history")) return add("history");
      if (e.target.closest("#bp-slot")) return add("slot");
      if (e.target.closest("[data-undo-last]")) return undoLast();
      if (e.target.closest("#bp-reload")) { await Promise.all([loadGear(true), loadRecipes(true)]); return paintPage(); }
      const rs = e.target.closest("[data-rstatus]");
      if (rs) { ui.rstatus = rs.dataset.rstatus; save("bp.rstatus", ui.rstatus); return paintRecipes(); }
      const row = e.target.closest(".recipe-list .list-row[data-key]");
      if (row && !e.target.closest("label") && !e.target.closest("button")) {
        const cb = $("[data-pick]", row);
        if (cb && !cb.disabled) { cb.checked = !cb.checked; cb.dispatchEvent(new Event("change", { bubbles: true })); }
        return;
      }
      if (e.target.closest("#rc-clear")) { ui.pick.clear(); return paintRecipes(); }
      if (e.target.closest("#rc-unlock")) return unlockPicked();
      const sv = e.target.closest("[data-savebp]");
      if (sv) {
        const r = await call("addBlueprint", sv.dataset.savebp, "local");
        if (r.ok) { toast(r.changed ? "已保存为蓝图" : "已经保存过了", "现在可以在制作台制作", "good"); equip = null; S.gear = null; paintMine(); loadHistory(); }
      }
    };
    await paintPage();
  },

  leave() {
    if (editor) { editor.destroy(); editor = null; }
  },

  focusSearch() {
    const el = $("#bp-q", view);
    if (el) { el.focus(); el.select(); return true; }
    return false;
  },

  update() {
    if (!view) return;
    const ready = profileReady();
    if (!ready && !$(".empty", view)) view.innerHTML = notReady("蓝图功能", true);
    else if (ready && $(".empty", view) && !$("#bp-body", view)) this.render(view);
  },
};

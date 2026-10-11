import { S, agentHas, connection, loadItems, loadPlayers, loadHistory, rpc, load, save } from "../store.js";
import { $, $$, esc, icon, clamp } from "../ui.js";
import { notReady, GROUP_COLOR, SLOT_LABEL } from "./common.js";
import { createAttrEditor } from "../attr_editor.js";

// Pick an item, set its attributes if it has any (weapons, melee weapons, ship parts: tier, modules, level), and put it into
// the game. Same layout as the blueprint page: the list on the left; on the right the item, with the buttons in its header,
// the destination and amount right under them, the outcome under those, and the attribute editor below. The panel is built
// once per page and the editor is never re-created while the item is being edited.
let view = null;
let editor = null;
let editorFor = null; // the item the editor has been loaded for
const ui = {
  group: load("items.group", "all"),
  q: "",
  internal: load("items.internal", false),
  sel: load("items.sel", null),
  qty: 1,
  dest: load("items.dest", "backpack"),
  full: load("items.full", "reject"),
  attr: load("items.attr", true), // spawn gear with the attributes of the editor (off: the game's plain item)
};
const favs = new Set(load("favs", []));
let recent = load("recent", []);
const infoCache = {};
let busy = false;
let last = null; // the outcome of the last add or check, shown under the buttons: { name, kind: ok|warn|bad, text }

const GROUP_ORDER = ["weapon", "melee", "throwable", "consumable", "gadget", "shipSupply", "resource", "artifact", "component", "novelty", "internal"];
const DEST_LABEL = { backpack: "背包", ground: "脚下地面", hand: "手上" };

const items = () => (S.items ? S.items.items : []);
const selected = () => items().find((i) => i.name === ui.sel) || null;
const targetLocal = () => S.target === "local";
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
// the editor can only be used when the game's script knows it (older scripts have no `gear` flag on the items either)
const gearEditable = (it) => !!it && !!it.gear && !(S.status && !agentHas(2));
const groupLabel = (g) => (S.items && S.items.groups && S.items.groups[g]) || g;

function filtered() {
  const q = ui.q.trim().toLowerCase();
  return items().filter((it) => {
    if (!ui.internal && it.hidden) return false;
    if (ui.group === "fav") { if (!favs.has(it.name)) return false; }
    else if (ui.group !== "all" && it.group !== ui.group) return false;
    if (q && !(clean(it.display).toLowerCase().includes(q) || it.name.toLowerCase().includes(q) || it.groupLabel.includes(q))) return false;
    return true;
  }).sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || clean(a.display).localeCompare(clean(b.display), "zh") || a.name.localeCompare(b.name));
}

function options(it) {
  const pickup = it.category !== "cargo";
  return { backpack: pickup && it.canBackpack, ground: true, hand: pickup && targetLocal() };
}

// ------------------------------------------------------------------ the list
function chipsHTML() {
  const visible = items().filter((i) => ui.internal || !i.hidden);
  const counts = {};
  for (const i of visible) counts[i.group] = (counts[i.group] || 0) + 1;
  const chip = (id, label, n) => `<button class="chip ${ui.group === id ? "on" : ""}" data-group="${id}">${label}<span class="count">${n}</span></button>`;
  const favCount = visible.filter((i) => favs.has(i.name)).length;
  return chip("all", "全部", visible.length)
    + chip("fav", "★ 收藏", favCount)
    + GROUP_ORDER.filter((g) => counts[g]).map((g) => chip(g, esc(groupLabel(g)), counts[g])).join("");
}

function rowHTML(it) {
  const tags = [];
  if (it.gear) tags.push(`<span class="tag attr-tag" title="可以自定义品质、词条和等级">属性</span>`);
  if (it.category === "cargo") tags.push(`<span class="tag lock" title="飞船部件只能出现在地上">地上</span>`);
  else if (!it.canBackpack) tags.push(`<span class="tag lock" title="不能放进背包">不进背包</span>`);
  return `<div class="prow ${it.name === ui.sel ? "sel" : ""}" data-name="${esc(it.name)}" style="--gc:${GROUP_COLOR[it.group] || "#55c7ff"}" role="button" tabindex="0" title="${esc(it.name)}">
    <span class="pname">${esc(clean(it.display))}</span>${tags.join("")}
    <button type="button" class="fav ${favs.has(it.name) ? "on" : ""}" data-fav="${esc(it.name)}" title="${favs.has(it.name) ? "取消收藏" : "收藏"}">${icon("star")}</button>
  </div>`;
}

function renderGrid() {
  const list = filtered();
  $("#item-chips", view).innerHTML = chipsHTML();
  $("#item-count", view).textContent = `${list.length} 项`;
  let html = "";
  let group = null;
  for (const it of list) {
    if (it.group !== group) { group = it.group; html += `<div class="pgroup"><span>${esc(groupLabel(group))}</span></div>`; }
    html += rowHTML(it);
  }
  $("#item-grid", view).innerHTML = list.length
    ? html
    : `<div class="empty" style="padding:40px 10px">${icon("search")}<h3>${ui.group === "fav" && !ui.q ? "还没有收藏" : "没有匹配的物品"}</h3><p>${ui.group === "fav" && !ui.q ? "点物品右边的星标收藏，常用的东西就都在这里。" : "换个关键词，或者切换分类试试。"}</p></div>`;
}

// ------------------------------------------------------------------ the item
function renderHead() {
  const it = selected();
  if (!it) return;
  const info = infoCache[it.name];
  const color = GROUP_COLOR[it.group] || "#55c7ff";
  const tags = [`<span class="badge" style="background:color-mix(in srgb, ${color} 18%, transparent);color:${color}">${esc(it.groupLabel)}</span>`];
  if (info && info.typeName && info.typeName !== it.groupLabel) tags.push(`<span class="badge">${esc(info.typeName)}</span>`);
  if (it.category === "pickup" && it.slot) tags.push(`<span class="badge">${esc(SLOT_LABEL[it.slot] || it.slot)}</span>`);
  if (it.maxStack > 1) tags.push(`<span class="badge">可叠加 ${it.maxStack}</span>`);
  if (!it.translated) tags.push(`<span class="badge warn">未翻译</span>`);
  $("#d-head", view).innerHTML = `
    <div class="row">${tags.join("")}</div>
    <div class="detail-name">${esc(clean(it.display))}</div>
    <div class="detail-code">${esc(it.name)}</div>`;
  $("#d-desc", view).innerHTML = info ? esc(info.description || "（游戏没有提供说明）") : '<div class="skeleton" style="height:20px;width:60%"></div>';
}

function attrOn() {
  const it = selected();
  return gearEditable(it) && ui.attr && !!editor && editorFor === it.name;
}

const amount = () => (ui.dest === "hand" ? 1 : ui.qty);

// the buttons in the header: they follow the destination, the amount and what the game says about the attributes
function renderActs() {
  const it = selected();
  if (!it) return;
  const bad = attrOn() && !editor.state().ok;
  const html = `
    ${ui.dest !== "hand" ? `<button type="button" class="btn" id="do-check" title="只检查能不能放，不生成" ${busy || bad ? "disabled" : ""}>检查</button>` : ""}
    <button type="button" class="btn primary" id="do-add" ${busy || bad ? "disabled" : ""}>${icon("plus")}添加 ×${amount()} 到${DEST_LABEL[ui.dest]}</button>`;
  const el = $("#d-acts", view);
  if (el.innerHTML !== html) el.innerHTML = html;
}

// where to, how many, and what to do with a full backpack
function renderOpts() {
  const it = selected();
  if (!it) return;
  const o = options(it);
  if (!o[ui.dest]) ui.dest = o.backpack ? "backpack" : "ground";
  const hand = ui.dest === "hand";
  const why = {
    backpack: "直接放进背包空位，不会顶掉已有物品。",
    ground: "出现在目标角色面前约 1 米处，走过去按交互键拾取。",
    hand: "装备到手上；对应栏位没有空位时会拒绝，避免顶掉你的武器。",
  }[ui.dest] + (!o.backpack && it.category !== "cargo" ? "　这件物品不能放进背包。" : "") + (it.category === "cargo" ? "　飞船部件只能出现在地上。" : "");
  $("#d-opts", view).innerHTML = `
    <div class="opt"><span class="opt-l">放到</span>
      <div class="seg" id="dest-seg">
        <button type="button" data-dest="backpack" class="${ui.dest === "backpack" ? "on" : ""}" ${o.backpack ? "" : "disabled"}>${icon("bag")}背包</button>
        <button type="button" data-dest="ground" class="${ui.dest === "ground" ? "on" : ""}">${icon("floor")}地上</button>
        <button type="button" data-dest="hand" class="${hand ? "on" : ""}" ${o.hand ? "" : "disabled"}>${icon("hand")}手上</button>
      </div>
    </div>
    <div class="opt"><span class="opt-l">数量</span>
      <div class="stepper"><button type="button" data-qty="-1" ${hand ? "disabled" : ""}>−</button><input id="qty" value="${amount()}" inputmode="numeric" aria-label="数量" ${hand ? "disabled" : ""}><button type="button" data-qty="1" ${hand ? "disabled" : ""}>+</button></div>
    </div>
    ${ui.dest === "backpack" ? `<div class="opt"><span class="opt-l">背包满了</span><select class="select" id="full"><option value="reject" ${ui.full === "reject" ? "selected" : ""}>拒绝，不生成</option><option value="ground" ${ui.full === "ground" ? "selected" : ""}>多余的放到地上</option></select></div>` : ""}
    <div class="opt-hint muted">${esc(why)}</div>`;
  renderActs();
}

function renderStatus() {
  const el = $("#d-status", view);
  if (!el) return;
  const it = selected();
  const html = last && it && last.name === it.name
    ? `<span class="${last.kind}">${icon(last.kind === "ok" ? "check" : "alert")}</span><span class="msg">${esc(last.text)}</span>`
    : "";
  if (el.innerHTML !== html) el.innerHTML = html;
}

function renderRecent() {
  const list = recent.map((r) => items().find((i) => i.name === r)).filter(Boolean);
  $("#d-recent", view).innerHTML = list.length
    ? `<div class="field-label">最近添加</div><div class="recent">${list.map((x) => `<button type="button" class="chip" data-recent="${esc(x.name)}">${esc(clean(x.display))}</button>`).join("")}</div>`
    : "";
}

// the attribute box: shown for items that have attributes, off by switch
function syncAttrBox() {
  const it = selected();
  const show = gearEditable(it);
  $("#d-attrbox", view).hidden = !show;
  if (!show) return;
  $("#attr-on", view).checked = ui.attr;
  $("#d-attr", view).hidden = !ui.attr;
  $("#d-attrbox", view).classList.toggle("off", !ui.attr);
  if (ui.attr) {
    if (!editor) {
      editor = createAttrEditor($("#d-attr", view), {
        call: (spec, action) => rpc("itemEdit", ui.sel, spec, action),
        tierKey: "items.tier",
        onChange: renderActs,
      });
    }
    if (editorFor !== it.name) { editorFor = it.name; editor.load(); }
  }
}

async function showDetail() {
  const it = selected();
  $("#d-empty", view).hidden = !!it;
  $("#d-pane", view).hidden = !it;
  if (!it) return;
  renderHead();
  renderOpts();
  renderStatus();
  syncAttrBox();
  renderActs();
  renderRecent();
  if (!infoCache[it.name]) {
    const r = await rpc("itemInfo", it.name);
    infoCache[it.name] = r.ok ? r : { description: "", typeName: "" };
    if (ui.sel === it.name && view && $("#d-head", view)) renderHead();
  }
}

function select(name) {
  ui.sel = name;
  save("items.sel", name);
  $$("#item-grid .prow", view).forEach((el) => el.classList.toggle("sel", el.dataset.name === name));
  showDetail();
}

async function perform(previewOnly) {
  const it = selected();
  if (!it || busy) return;
  const n = ui.dest === "hand" ? 1 : clamp(parseInt($("#qty", view).value, 10) || 1, 1, 30);
  let spec = null;
  if (attrOn()) {
    await editor.settled(); // a change that is still on its way to the game counts
    const st = editor.state();
    if (!st.valid) { last = { name: it.name, kind: "warn", text: "属性还不能用：" + (st.errors[0] || "请先处理属性编辑器里的提示") }; renderStatus(); return; }
    spec = editor.spec();
  }
  busy = true;
  renderActs();
  const say = (kind, text) => { last = { name: it.name, kind, text }; };
  try {
    // the outcome goes under the buttons, failures included: no toast on top of the page
    if (ui.dest === "hand") {
      const r = await rpc("equipHand", it.name, spec);
      if (r.ok) { say("ok", `已装备到手上：${clean(it.display)}`); remember(it.name); }
      else say("bad", r.error ? r.error.message : "游戏没有回应");
      return;
    }
    if (previewOnly) {
      const r = await rpc("previewSpawn", it.name, n, ui.dest, S.target, ui.full, spec);
      if (r.ok) say("ok", `可以添加：目标 ${r.player.name}，背包 ${r.backpack} 个，地上 ${r.ground} 个。`);
      else say("warn", "暂时不能添加：" + (r.error ? r.error.message : "游戏没有回应"));
      return;
    }
    const r = await rpc("spawn", it.name, n, ui.dest, S.target, ui.full, spec);
    const done = (r.backpack || 0) + (r.ground || 0);
    if (r.ok) {
      say("ok", `已添加 ${clean(it.display)} ×${done}：背包 ${r.backpack} 个，地上 ${r.ground} 个${r.player ? "，目标 " + r.player.name : ""}。`);
      remember(it.name);
    } else {
      const msg = r.error ? r.error.message : "游戏没有回应";
      say(done ? "warn" : "bad", (done ? `部分完成（${done}/${r.requested}）：` : "没有添加：") + msg + (r.uncertain ? "　有结果未确认，请先看游戏里的实际情况，避免重复添加。" : ""));
      if (done) remember(it.name);
    }
  } finally {
    busy = false;
    if (view && $("#d-acts", view)) { renderActs(); renderStatus(); renderRecent(); }
    loadHistory();
  }
}

function remember(name) {
  recent = [name, ...recent.filter((x) => x !== name)].slice(0, 8);
  save("recent", recent);
}

const shellHTML = () => `
  <div class="md">
    <aside class="md-side">
      <div class="md-side-head">
        <div class="row" style="gap:8px"><div class="search" style="flex:1"><input class="input" id="item-q" placeholder="搜索物品（按 / 聚焦）" value="${esc(ui.q)}" autocomplete="off">${icon("search")}</div><button type="button" class="btn icon" id="reload-items" title="重新读取物品目录">${icon("refresh")}</button></div>
        <div class="chips sm" id="item-chips"></div>
      </div>
      <div class="plist" id="item-grid"></div>
      <div class="md-side-foot"><span class="num" id="item-count"></span><label class="foot-switch"><span class="switch sm"><input type="checkbox" id="show-internal" ${ui.internal ? "checked" : ""}><i></i></span>显示内部物品</label></div>
    </aside>
    <section class="md-main">
      <div class="detail-empty" id="d-empty"><div class="empty" style="padding:40px 10px">${icon("box")}<h3>选一个物品</h3><p>点左边的物品，选好放到哪里和数量，再点右上角的添加。武器、近战武器和飞船部件还可以先调整品质、词条和等级。</p></div></div>
      <div class="md-pane" id="d-pane" hidden>
        <header class="md-head">
          <div class="md-title" id="d-head"></div>
          <div class="md-acts" id="d-acts"></div>
        </header>
        <div class="md-opts" id="d-opts"></div>
        <div class="md-status" id="d-status" aria-live="polite"></div>
        <div class="md-body">
          <div class="detail-desc" id="d-desc"></div>
          <div class="attr-box" id="d-attrbox" hidden>
            <label class="switch-row"><span class="switch"><input type="checkbox" id="attr-on"><i></i></span><span><b>自定义属性</b>　<span class="muted" style="font-size:12.5px">品质、词条、等级。关掉就刷出游戏原样的物品。</span></span></label>
            <div id="d-attr"></div>
          </div>
          <div id="d-recent"></div>
        </div>
      </div>
    </section>
  </div>`;

async function boot() {
  const data = await loadItems(false);
  if (!view) return;
  if (!data) { view.innerHTML = `<div class="empty">${icon("alert")}<h3>读取物品目录失败</h3><p>请确认游戏已进入大厅或飞船，然后点击刷新。</p><button class="btn" id="reload-items">重试</button></div>`; return; }
  view.classList.add("view-fill");
  view.innerHTML = shellHTML();
  editor = null;
  editorFor = null;
  renderGrid();
  showDetail();
  const row = $("#item-grid .prow.sel", view);
  if (row) row.scrollIntoView({ block: "nearest" });
}

export default {
  id: "items",
  title: "物品",
  sub: "刷出游戏内的武器、装备、资源与飞船部件",
  icon: "box",
  group: "main",

  async render(v) {
    view = v;
    if (connection().kind !== "good") { view.innerHTML = notReady("物品功能"); return; }
    view.classList.add("view-fill");
    view.innerHTML = `<div class="md"><div class="md-side"><div class="skeleton" style="height:100%"></div></div><div class="md-main"></div></div>`;
    view.oninput = (e) => {
      if (e.target.id === "item-q") { ui.q = e.target.value; renderGrid(); }
      if (e.target.id === "qty") { ui.qty = clamp(parseInt(e.target.value, 10) || 1, 1, 30); renderActs(); }
    };
    view.onchange = (e) => {
      if (e.target.id === "show-internal") { ui.internal = e.target.checked; save("items.internal", ui.internal); renderGrid(); }
      if (e.target.id === "full") { ui.full = e.target.value; save("items.full", ui.full); }
      if (e.target.id === "attr-on") { ui.attr = e.target.checked; save("items.attr", ui.attr); syncAttrBox(); renderActs(); }
    };
    view.onkeydown = (e) => {
      if (e.key === "Escape" && e.target.id === "item-q") { e.target.value = ""; ui.q = ""; renderGrid(); }
      if ((e.key === "Enter" || e.key === " ") && e.target.classList?.contains("prow")) { e.preventDefault(); select(e.target.dataset.name); }
      if (e.key === "Enter" && e.target.id === "qty") perform(false);
    };
    view.onclick = async (e) => {
      const fav = e.target.closest("[data-fav]");
      if (fav) {
        const name = fav.dataset.fav;
        favs.has(name) ? favs.delete(name) : favs.add(name);
        save("favs", [...favs]);
        renderGrid();
        return;
      }
      const row = e.target.closest("#item-grid .prow");
      if (row) return select(row.dataset.name);
      const chip = e.target.closest("[data-group]");
      if (chip) { ui.group = chip.dataset.group; save("items.group", ui.group); renderGrid(); return; }
      const dest = e.target.closest("[data-dest]");
      if (dest) { ui.dest = dest.dataset.dest; save("items.dest", ui.dest); renderOpts(); return; }
      const q = e.target.closest("[data-qty]");
      if (q) { ui.qty = clamp(ui.qty + Number(q.dataset.qty), 1, 30); $("#qty", view).value = ui.qty; renderActs(); return; }
      const rec = e.target.closest("[data-recent]");
      if (rec) {
        select(rec.dataset.recent);
        const r = $("#item-grid .prow.sel", view);
        if (r) r.scrollIntoView({ block: "nearest" });
        return;
      }
      if (e.target.closest("#do-add")) return perform(false);
      if (e.target.closest("#do-check")) return perform(true);
      if (e.target.closest("#reload-items")) {
        view.innerHTML = `<div class="empty"><h3>正在重新读取…</h3></div>`;
        await loadItems(true);
        boot();
      }
    };
    await boot();
    loadPlayers();
  },

  leave() {
    if (editor) { editor.destroy(); editor = null; editorFor = null; }
  },

  focusSearch() {
    const el = $("#item-q", view);
    if (el) { el.focus(); el.select(); return true; }
    return false;
  },

  update() {
    if (!view) return;
    const ready = connection().kind === "good";
    if (!ready && !$(".empty", view)) view.innerHTML = notReady("物品功能");
    else if (ready && $(".empty", view) && !S.items) this.render(view);
  },

  targetChanged() {
    if (view && $("#d-opts", view) && S.items) renderOpts();
  },
};

import { S, agentHas, rpc, load, save, loadHistory } from "../store.js";
import { $, esc, icon, confirmDialog } from "../ui.js";
import { notReady } from "./common.js";

// The mission in progress: the state of the ship with a one-click repair, the jump map with every node (the ship can be sent to
// any of them; the game only lets a player pick a linked one), and ending the mission at once.
let view = null;
let busy = false;
let data = null; // { available, nodes, traveling } as the game reports them
let last = null; // outcome of the last action, shown under the buttons: { kind: ok|bad, text }
let ship = null; // what is wrong with the ship: { available, problems } as the game reports it
let shipLast = null; // outcome of the last repair: { kind, text }
let repairing = false;
let timer = null;
const ui = { sel: load("ms.sel", null) };

const nodes = () => (data && data.available ? data.nodes : []);
const byIndex = (i) => nodes().find((n) => n.index === i) || null;

function flags(n) {
  const out = [];
  if (n.current) out.push(["good", "飞船在这里"]);
  if (n.finale) out.push(["warn", "终点"]);
  if (n.exit) out.push(["violet", "出口"]);
  if (n.visited && !n.current) out.push(["", "已去过"]);
  if (n.lava) out.push(["bad", "被熔岩吞没"]);
  return out;
}

const stateClass = (n) => [n.current ? "current" : "", n.visited ? "visited" : "", n.reachable ? "reachable" : "", n.finale ? "finale" : "", n.exit ? "exit" : "", n.lava ? "lava" : "", n.index === ui.sel ? "sel" : ""].filter(Boolean).join(" ");

// ------------------------------------------------------------------ the ship
// what is wrong, as [label, value] pairs
function shipIssues(p) {
  return [
    p.hull.low && ["船体", `${p.hull.health} / ${p.hull.max}`],
    p.breaches && ["船体破口", p.breaches],
    p.shield.low && ["护盾", `${p.shield.value} / ${p.shield.max}`],
    p.fires && ["起火", p.fires],
    p.leaks && ["损坏点", p.leaks],
    p.fuelSegments && ["燃料管断段", p.fuelSegments],
    p.components && ["部件损坏", p.components],
  ].filter(Boolean);
}

function renderShip() {
  const el = $("#ms-ship", view);
  if (!el) return;
  const ok = ship && ship.available;
  el.hidden = !ok;
  if (!ok) return;
  const p = ship.problems;
  const issues = shipIssues(p);
  const text = p.total
    ? `<div class="ms-ship-title bad">${icon("alert")}飞船有 ${p.total} 项异常</div><div class="ms-ship-issues">${issues.map(([l, v]) => `<span class="tag">${esc(l)} <b class="num">${esc(String(v))}</b></span>`).join("")}</div>`
    : `<div class="ms-ship-title ok">${icon("check")}飞船状态良好</div>`;
  const note = shipLast && (shipLast.kind === "bad" || !p.total) ? `<div class="${shipLast.kind === "bad" ? "bad" : "muted"}" style="margin-top:6px">${esc(shipLast.text)}</div>` : "";
  const html = `<div class="ms-ship-text">${text}${note}</div><button type="button" class="btn ${p.total ? "primary" : ""}" id="ms-repair" ${repairing || !p.total ? "disabled" : ""}>${icon("wrench")}${repairing ? "修复中…" : p.total ? "一键修复飞船" : "无需修复"}</button>`;
  if (el.innerHTML !== html) el.innerHTML = html;
}

async function repairShip() {
  if (repairing) return;
  repairing = true;
  renderShip();
  const r = await rpc("repairShip");
  repairing = false;
  shipLast = r.ok
    ? { kind: "ok", text: r.found && r.found.total ? `已修复 ${r.found.total} 项异常，飞船恢复如初。` : "飞船本来就没有异常。" }
    : { kind: "bad", text: r.error ? r.error.message : "游戏没有回应" };
  loadHistory();
  await reload();
}

// ------------------------------------------------------------------ the map
function mapHTML() {
  const list = nodes();
  const xs = list.map((n) => n.pos[0]);
  const ys = list.map((n) => -n.pos[1]); // the game's map lies in the x-z plane with z pointing up on the table
  const pad = 40;
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const w = Math.max(maxX - minX, 1), h = Math.max(maxY - minY, 1);
  const scale = 560 / Math.max(w, h);
  const px = (n) => pad + (n.pos[0] - minX) * scale;
  const py = (n) => pad + (-n.pos[1] - minY) * scale;
  const W = pad * 2 + w * scale, H = pad * 2 + h * scale;
  const seen = new Set();
  const lines = [];
  for (const n of list) {
    for (const i of n.links) {
      const key = n.index < i ? `${n.index}-${i}` : `${i}-${n.index}`;
      const m = byIndex(i);
      if (!m || seen.has(key)) continue;
      seen.add(key);
      lines.push(`<line class="ms-link" x1="${px(n)}" y1="${py(n)}" x2="${px(m)}" y2="${py(m)}"/>`);
    }
  }
  const dots = list.map((n) => `<g class="ms-node ${stateClass(n)}" data-index="${n.index}" transform="translate(${px(n)} ${py(n)})"><title>${esc(n.name || "节点 " + (n.index + 1))}</title><circle r="15"/><text y="4.500">${n.index + 1}</text></g>`).join("");
  return `<svg class="ms-map" viewBox="0 0 ${W} ${H}" role="img" aria-label="跳跃图">${lines.join("")}${dots}</svg>`;
}

function renderMap() {
  const el = $("#ms-map", view);
  if (!el) return;
  const html = nodes().length ? mapHTML() : "";
  if (el.innerHTML !== html) el.innerHTML = html;
}

// ------------------------------------------------------------------ the list
function renderList() {
  const rows = nodes().slice().sort((a, b) => Number(b.current) - Number(a.current) || a.level - b.level || a.index - b.index);
  $("#ms-list", view).innerHTML = rows.map((n) => `
    <button type="button" class="prow ${n.index === ui.sel ? "sel" : ""} ${n.visited && !n.current ? "done" : ""}" data-index="${n.index}">
      <span class="pname">${esc(n.name || "节点 " + (n.index + 1))}</span>${flags(n).slice(0, 2).map(([, t]) => `<span class="tag">${esc(t)}</span>`).join("")}
    </button>`).join("");
  $("#ms-count", view).textContent = `${nodes().length} 个节点`;
}

// ------------------------------------------------------------------ the node
function renderActs() {
  const n = byIndex(ui.sel);
  const el = $("#ms-acts", view);
  if (!n || !el) return;
  const stuck = n.current ? "飞船已经在这里" : data.traveling ? "飞船正在跳跃" : "";
  const html = `<button type="button" class="btn primary" id="ms-jump" ${busy || stuck ? "disabled" : ""} title="${esc(stuck)}">${icon("rocket")}${busy ? "处理中…" : stuck || "跳跃到这里"}</button>`;
  if (el.innerHTML !== html) el.innerHTML = html;
}

function renderStatus() {
  const el = $("#ms-status", view);
  if (!el) return;
  const html = last ? `<span class="${last.kind}">${icon(last.kind === "ok" ? "check" : "alert")}</span><span class="msg">${esc(last.text)}</span>` : "";
  if (el.innerHTML !== html) el.innerHTML = html;
}

function renderDetail() {
  const n = byIndex(ui.sel);
  $("#ms-empty", view).hidden = !!n;
  $("#ms-pane", view).hidden = !n;
  if (!n) return;
  $("#ms-head", view).innerHTML = `
    <div class="row">${flags(n).map(([cls, t]) => `<span class="badge ${cls}">${esc(t)}</span>`).join("") || '<span class="badge">未去过</span>'}</div>
    <div class="detail-name">${esc(n.name || "节点 " + (n.index + 1))}</div>`;
  $("#ms-body", view).innerHTML = `
    ${n.sub ? `<div class="detail-desc">${esc(n.sub)}</div>` : ""}
    <div class="kv"><span>节点编号</span><b class="num">${n.index + 1}</b></div>
    <div class="kv"><span>热度</span><b class="num">${n.heat}</b></div>
    <div class="kv"><span>游戏里能直接选中</span><b>${n.reachable || n.current ? "能" : "不能（需要先经过别的节点）"}</b></div>
    ${!n.reachable && !n.current ? `<div class="callout info">${icon("info")}<div>游戏自己的跳跃图只让你选相连的节点；这里可以直接跳过去，不用按连线走。</div></div>` : ""}`;
  renderActs();
  renderStatus();
}

function select(index) {
  ui.sel = index;
  save("ms.sel", index);
  renderMap();
  renderList();
  renderDetail();
}

// ------------------------------------------------------------------ the page
function showState() {
  const has = !!(data && data.available);
  $("#ms-main", view).hidden = !has;
  $("#ms-none", view).hidden = has;
}

function paint() {
  showState();
  if (!data || !data.available) return;
  if (ui.sel === null || !byIndex(ui.sel)) {
    const cur = nodes().find((n) => n.current);
    ui.sel = cur ? cur.index : nodes()[0] ? nodes()[0].index : null;
  }
  renderMap();
  renderList();
  renderDetail();
}

async function reload() {
  const [r, health] = await Promise.all([rpc("jumpMap"), agentHas(5) ? rpc("shipHealth") : Promise.resolve(null)]);
  if (!view) return false;
  ship = health && health.ok ? health : null;
  if (!r.ok) {
    data = null;
    $("#ms-none", view).innerHTML = `<div class="empty">${icon("alert")}<h3>读取跳跃图失败</h3><p>${esc(r.error ? r.error.message : "")}</p></div>`;
    showState();
    return false;
  }
  data = r;
  paint();
  renderShip();
  return true;
}

async function jump() {
  const n = byIndex(ui.sel);
  if (!n || busy || n.current || data.traveling) return;
  const ok = await confirmDialog({
    title: `跳跃到「${n.name || "节点 " + (n.index + 1)}」？`,
    message: n.reachable ? "飞船会开始跳往这个节点。" : "这个节点和飞船现在的位置没有连线，游戏自己不允许直接去；修改器会绕过这个限制，直接发出跳跃指令。",
    items: n.lava ? ["这个节点已经被熔岩吞没，去了可能会很危险。"] : [],
    confirmText: "跳跃",
  });
  if (!ok) return;
  busy = true;
  renderActs();
  const r = await rpc("jumpToNode", n.index);
  busy = false;
  last = r.ok ? { kind: "ok", text: `已发出跳跃指令：${n.name || "节点 " + (n.index + 1)}。` } : { kind: "bad", text: r.error ? r.error.message : "游戏没有回应" };
  loadHistory();
  if (view) { renderActs(); renderStatus(); }
  setTimeout(reload, 1500);
}

async function complete() {
  if (busy) return;
  const ok = await confirmDialog({
    title: "直接完成当前任务？",
    message: "游戏会把这个任务当作已经完成来结算。这一步不能撤销，完成前会自动备份存档。只能由房主执行。",
    items: ["奖励、进度和任务结算按完成处理，之后的流程和正常完成一样。"],
    confirmText: "完成任务",
  });
  if (!ok) return;
  busy = true;
  const r = await rpc("completeMission");
  busy = false;
  last = r.ok ? { kind: "ok", text: "已发出完成指令，游戏会继续任务结算。" } : { kind: "bad", text: r.error ? r.error.message : "游戏没有回应" };
  S.prog = null;
  loadHistory();
  if (view) { renderActs(); renderStatus(); }
}

const shellHTML = () => `
  <div class="md" id="ms-main" hidden>
    <aside class="md-side">
      <div class="md-side-head">
        <div class="row" style="gap:8px"><button type="button" class="btn" id="ms-complete" style="flex:1">${icon("flag")}直接完成当前任务</button><button type="button" class="btn icon" id="ms-reload" title="重新读取跳跃图">${icon("refresh")}</button></div>
      </div>
      <div class="plist" id="ms-list"></div>
      <div class="md-side-foot"><span class="num" id="ms-count"></span></div>
    </aside>
    <section class="md-main">
      <div class="ms-ship" id="ms-ship" hidden></div>
      <div class="ms-mapwrap" id="ms-map"></div>
      <div class="detail-empty" id="ms-empty"><div class="empty" style="padding:24px 10px">${icon("flag")}<h3>选一个节点</h3><p>点地图上的节点或左边的列表。</p></div></div>
      <div class="md-pane" id="ms-pane" hidden>
        <header class="md-head">
          <div class="md-title" id="ms-head"></div>
          <div class="md-acts" id="ms-acts"></div>
        </header>
        <div class="md-status" id="ms-status" aria-live="polite"></div>
        <div class="md-body" id="ms-body"></div>
      </div>
    </section>
  </div>
  <div id="ms-none" hidden>${`<div class="empty">${icon("flag")}<h3>现在不在任务里</h3><p>进入任务后，这里会显示任务的跳跃图，可以直接选任何一个节点跳过去，也可以直接完成任务。</p></div>`}</div>`;

const stale = () => `<div class="callout info">${icon("info")}<div><b>游戏里运行的还是旧版本的修改器脚本。</b>任务功能要<b>重启一次游戏</b>后才能用（脚本只在游戏启动时装进去，装好后不能替换）。</div></div>`;

export default {
  id: "mission",
  title: "任务",
  sub: "飞船一键修复、跳跃图传送与直接完成任务",
  icon: "map",
  group: "main",

  async render(v) {
    view = v;
    data = null;
    if (!S.status) { view.innerHTML = notReady("任务功能"); return; }
    if (!agentHas(4)) { view.innerHTML = stale(); return; }
    view.classList.add("view-fill");
    view.innerHTML = shellHTML();
    view.onclick = (e) => {
      const node = e.target.closest("[data-index]");
      if (node && view.contains(node)) return select(Number(node.dataset.index));
      if (e.target.closest("#ms-jump")) return jump();
      if (e.target.closest("#ms-repair")) return repairShip();
      if (e.target.closest("#ms-complete")) return complete();
      if (e.target.closest("#ms-reload")) return reload();
    };
    await reload();
    clearInterval(timer);
    timer = setInterval(() => { if (view && !busy && document.visibilityState === "visible") reload(); }, 2500);
  },

  leave() {
    clearInterval(timer);
    timer = null;
    view = null;
  },

  update() {
    if (!view) return;
    const showing = !!$("#ms-main", view) || !!$("#ms-none", view);
    if (!S.status && showing) view.innerHTML = notReady("任务功能");
    else if (S.status && agentHas(4) && !showing) this.render(view);
  },
};

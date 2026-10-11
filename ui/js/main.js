import { S, AGENT_API, connection, refreshBridge, refreshStatus, loadPlayers, loadHistory, on } from "./store.js";
import { onBusy } from "./api.js";
import { $, $$, esc, icon, load, save } from "./ui.js";
import dashboard from "./pages/dashboard.js";
import currency from "./pages/currency.js";
import items from "./pages/items.js";
import blueprints from "./pages/blueprints.js";
import ships from "./pages/ships.js";
import cheats from "./pages/cheats.js";
import log from "./pages/log.js";

const PAGES = [dashboard, currency, items, blueprints, ships, cheats, log];
let current = null;
let pollCount = 0;

// ------------------------------------------------------------------ shell
function renderSidebar() {
  const nav = (p, i) => `<button class="nav-item ${current && current.id === p.id ? "active" : ""}" data-page="${p.id}" title="快捷键 ${i + 1}">${icon(p.icon)}<span>${esc(p.title)}</span>${badgeFor(p)}</button>`;
  const main = PAGES.filter((p) => p.group === "main");
  const tools = PAGES.filter((p) => p.group === "tools");
  $("#sidebar").innerHTML = `
    <div class="brand">
      <div class="brand-logo"><svg viewBox="0 0 24 24"><path d="M12 3c3.600 1.600 6 5.200 6 9.500l-2.200 3.200H8.200L6 12.500C6 8.200 8.400 4.600 12 3z"/><circle cx="12" cy="10" r="1.600"/><path d="M9.500 19c.4 1.100 1.200 1.800 2.500 2.200 1.300-.4 2.100-1.100 2.500-2.200"/></svg></div>
      <div><div class="brand-name">跳帮修改器</div><div class="brand-sub">Jump Space</div></div>
    </div>
    <nav class="nav">
      <div class="nav-label">功能</div>
      ${main.map((p) => nav(p, PAGES.indexOf(p))).join("")}
      <div class="nav-label">工具</div>
      ${tools.map((p) => nav(p, PAGES.indexOf(p))).join("")}
    </nav>
    <div class="sidebar-foot">
      <div class="conn" id="conn"></div>
      <div class="foot-note">仅限单人 / 自己的房间使用</div>
    </div>`;
  renderConn();
}

function badgeFor(p) {
  if (p.id === "cheats" && S.status && S.status.cheats) {
    const n = Object.values(S.status.cheats).filter(Boolean).length;
    if (n) return `<span class="nav-badge on">${n} 开</span>`;
  }
  return "";
}

function renderConn() {
  const el = $("#conn");
  if (!el) return;
  const c = connection();
  el.innerHTML = `<span class="dot ${c.kind}"></span><div class="conn-text"><div class="conn-title">${esc(c.title)}</div><div class="conn-sub">${esc(c.sub || "")}</div></div>`;
}

// The script inside the game is only loaded when the game starts and cannot be replaced afterwards: right after the trainer
// was updated it can be older than this window. Say so, once, instead of letting new features fail one by one.
function renderAgentBar() {
  const el = $("#agentbar");
  if (!el) return;
  const stale = !!(S.status && S.status.agentApi !== AGENT_API);
  if (stale === !el.hidden) return;
  el.hidden = !stale;
  el.innerHTML = stale
    ? `<div class="callout info">${icon("info")}<div><b>游戏里运行的还是旧版本的修改器脚本。</b>调整蓝图和物品属性这类新功能要<b>重启一次游戏</b>后才能用，其余功能照常。（脚本只在游戏启动时装进去，装好后不能替换。）</div></div>`
    : "";
}

function renderTopbar() {
  const p = current;
  if (!p) return; // the first poll runs before the first page is routed
  const players = S.players || [];
  const selector = players.length > 1
    ? `<label class="muted" style="font-size:12.5px">目标角色</label><select class="select" id="target-select">${players.map((pl) => `<option value="${pl.local ? "local" : esc(pl.id)}" ${(pl.local ? "local" : pl.id) === S.target ? "selected" : ""}>${esc(pl.name)}${pl.local ? "（本机）" : ""}</option>`).join("")}</select>`
    : "";
  $("#topbar").innerHTML = `
    <div class="titles"><h1 class="page-title">${esc(p.title)}</h1><div class="page-sub">${esc(p.sub)}</div></div>
    <div class="topbar-right">${selector}</div>`;
}

// ----------------------------------------------------------------- routing
async function route() {
  const id = location.hash.replace(/^#\//, "") || load("page", "dashboard");
  const page = PAGES.find((p) => p.id === id) || PAGES[0];
  if (current && current.leave) current.leave();
  current = page;
  save("page", page.id);
  renderSidebar();
  renderTopbar();
  const view = $("#view");
  view.onclick = view.onchange = view.oninput = view.onkeydown = null;
  view.classList.remove("view-fill");
  view.innerHTML = "";
  view.scrollTop = 0;
  view.style.animation = "none";
  void view.offsetWidth;
  view.style.animation = "";
  await page.render(view);
}

// ---------------------------------------------------------------- polling
async function pollOnce() {
  await refreshBridge();
  const b = S.bridge;
  if (b && b.ok && b.attached && b.agentLoaded) {
    await refreshStatus();
    if (pollCount % 6 === 0) {
      const before = (S.players || []).length;
      await loadPlayers();
      if ((S.players || []).length !== before) renderTopbar();
    }
  } else {
    S.status = null;
    S.statusError = b && b.ok ? null : (b && b.error) || { code: "OFFLINE", message: "" };
  }
  pollCount++;
  renderConn();
  renderAgentBar();
  if (current && current.update) {
    try { await current.update(); } catch (e) { console.error(e); }
  }
  return !!(b && b.ok);
}

async function pollLoop() {
  for (;;) {
    const t0 = Date.now();
    const online = await pollOnce().catch((e) => { console.error(e); return false; });
    await new Promise((r) => setTimeout(r, Math.max(300, (online ? 1500 : 3000) - (Date.now() - t0))));
  }
}

// ------------------------------------------------------------------ events
// only the sidebar routes: page content may use data-page-like attributes of its own
document.addEventListener("click", (e) => {
  const nav = e.target.closest("#sidebar [data-page]");
  if (nav) location.hash = "#/" + nav.dataset.page;
});
document.addEventListener("change", (e) => {
  if (e.target.id === "target-select") {
    S.target = e.target.value;
    if (current && current.targetChanged) current.targetChanged();
  }
});
document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
  if (e.key === "/" && !typing && current && current.focusSearch) {
    if (current.focusSearch()) e.preventDefault();
  }
  if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && /^[1-7]$/.test(e.key) && !document.querySelector(".modal-back")) {
    const p = PAGES[Number(e.key) - 1];
    if (p) location.hash = "#/" + p.id;
  }
});
window.addEventListener("hashchange", route);
onBusy((b) => $("#busybar").classList.toggle("on", b));
on("status", () => {
  const cheatNav = $('#sidebar [data-page="cheats"]');
  if (cheatNav) { cheatNav.querySelector(".nav-badge")?.remove(); cheatNav.insertAdjacentHTML("beforeend", badgeFor({ id: "cheats" })); }
});

// -------------------------------------------------------------------- boot
renderSidebar();
(async () => {
  await pollOnce().catch((e) => console.error(e)); // know the connection state before the first page renders
  await route();
  pollLoop();
})();

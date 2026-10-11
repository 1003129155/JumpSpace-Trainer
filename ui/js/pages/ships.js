import { S, call, profileReady, loadShips, loadHistory, load, save } from "../store.js";
import { $, $$, esc, fmt, icon, toast, confirmDialog } from "../ui.js";
import { notReady } from "./common.js";

let view = null;
let busy = null;
let showAll = load("ships.all", false);

const TYPE_COLOR = { Dart: "#55c7ff", Catamaran: "#9a86ff", Hammerhead: "#ffa14d", Raider: "#ff6a85", Corsair: "#ff6a85" };
const MAX = { health: 5000, speed: 100, maneuver: 100, materiaCapacity: 250 };

const ships = () => (S.ships ? S.ships.ships : []);
// Enemy / tutorial designs have no player-facing description or a negative mark.
const playable = (s) => s.mark >= 0 && s.description && !/^Missing Localized/i.test(s.description);

function stat(label, value, max, display) {
  return `<div><div class="stat-l"><span>${label}</span><b>${display ?? fmt(value)}</b></div><div class="progress thin"><i style="width:${Math.min(100, (value / max) * 100)}%"></i></div></div>`;
}

function shipCard(s) {
  const color = TYPE_COLOR[s.shipType] || "#8a97b8";
  const badges = [];
  if (s.current) badges.push(`<span class="badge info">${icon("check")}当前使用</span>`);
  else if (s.owned) badges.push(`<span class="badge good">${icon("check")}已拥有</span>`);
  else if (s.unlockedFlag) badges.push(`<span class="badge violet">设计已解锁</span>`);
  else badges.push(`<span class="badge">未解锁</span>`);
  if (!playable(s)) badges.push(`<span class="badge warn">敌方/测试</span>`);
  // Mk.1+ are upgrades of a ship you already own (one ship per type), not separate ships.
  const action = s.owned
    ? `<button class="btn" disabled>${icon("check")}已在机库</button>`
    : s.mark >= 1
      ? `<span class="muted" style="font-size:12.5px">升级型号 · 游戏内升级获得</span>`
      : `<button class="btn primary" data-unlock="${esc(s.key)}" ${busy ? "disabled" : ""}>${icon("unlock")}${busy === s.key ? "处理中…" : "解锁并加入机库"}</button>`;
  return `
  <div class="card ship" style="--c:${color}">
    <div class="ship-art">${icon("rocket")}<div class="ship-badges">${badges.join("")}</div></div>
    <div class="ship-body">
      <div class="row"><div class="ship-name">${esc(s.display)}</div>${s.mark >= 0 ? `<span class="badge">Mk.${s.mark}</span>` : ""}<span class="spacer"></span><span class="muted" style="font-size:12px">${esc(s.shipType)}</span></div>
      <div class="ship-desc">${esc(playable(s) ? s.description : "这是游戏内部使用的舰船设计（敌方或教程），没有玩家说明。")}</div>
      <div class="stats">
        ${stat("耐久", s.health, MAX.health)}
        ${stat("速度", s.speed, MAX.speed)}
        ${stat("机动性", s.maneuver, MAX.maneuver)}
        ${stat("物质容量", s.materiaCapacity, MAX.materiaCapacity)}
      </div>
      <div class="row" style="margin-top:auto"><span class="rcode">${esc(s.name)}</span><span class="spacer"></span>${action}</div>
    </div>
  </div>`;
}

function paint() {
  const all = ships();
  const list = all.filter((s) => showAll || playable(s)).sort((a, b) => Number(b.owned) - Number(a.owned) || a.display.localeCompare(b.display, "zh") || a.mark - b.mark);
  const owned = all.filter((s) => s.owned).length;
  view.innerHTML = `
    <div class="row" style="margin-bottom:16px">
      <span class="muted">已拥有 <b style="color:var(--text)" class="num">${owned}</b> 艘 · 共 ${all.length} 个设计</span>
      <div class="spacer"></div>
      <label class="row" style="gap:9px;color:var(--text-2);font-size:13px;cursor:pointer"><span class="switch"><input type="checkbox" id="ship-all" ${showAll ? "checked" : ""}><i></i></span>显示敌方/测试舰船</label>
      <button class="btn sm" id="ship-reload">${icon("refresh")}刷新</button>
    </div>
    <div class="callout" style="margin-bottom:16px">${icon("alert")}<div>“解锁并加入机库”会把这艘舰船永久加入你的存档，之后可以在游戏的机库里选择使用。存档会在操作前自动备份。</div></div>
    <div class="ship-grid">${list.map(shipCard).join("")}</div>`;
}

async function unlock(key) {
  const s = ships().find((x) => x.key === key);
  if (!s || busy) return;
  const ok = await confirmDialog({
    title: `解锁 ${s.display}？`,
    message: `${s.display}（Mk.${s.mark}）会被永久加入你的机库，并写入存档。这一步在工具里无法撤销（存档已自动备份）。`,
    confirmText: "确认解锁",
  });
  if (!ok) return;
  busy = key;
  paint();
  const r = await call("unlockShips", [key]);
  busy = null;
  if (r.ok) {
    const item = r.results[0];
    if (item && item.ok) toast(item.changed ? `已解锁 ${s.display}` : `${s.display} 已经拥有`, item.changed ? "已加入机库" : "", "good");
    else toast("解锁失败", item ? item.error : "未知错误", "bad");
  }
  await loadShips(true);
  if (view) paint();
  loadHistory();
}

export default {
  id: "ships",
  title: "舰船",
  sub: "解锁舰船设计并加入机库",
  icon: "rocket",
  group: "main",

  async render(v) {
    view = v;
    if (!profileReady()) { view.innerHTML = notReady("舰船功能", true); return; }
    view.onchange = (e) => { if (e.target.id === "ship-all") { showAll = e.target.checked; save("ships.all", showAll); paint(); } };
    view.onclick = async (e) => {
      const u = e.target.closest("[data-unlock]");
      if (u) return unlock(u.dataset.unlock);
      if (e.target.closest("#ship-reload")) { await loadShips(true); paint(); }
    };
    if (!S.ships) {
      view.innerHTML = `<div class="ship-grid">${Array.from({ length: 3 }, () => '<div class="card skeleton" style="height:340px"></div>').join("")}</div>`;
      await loadShips(false);
    }
    if (!view) return;
    if (!S.ships) { view.innerHTML = `<div class="empty">${icon("alert")}<h3>读取舰船失败</h3><p>请确认已进入大厅或飞船。</p><button class="btn" id="ship-reload">重试</button></div>`; return; }
    paint();
  },

  update() {
    if (!view) return;
    const ready = profileReady();
    if (!ready && !$(".empty", view)) view.innerHTML = notReady("舰船功能", true);
    else if (ready && $(".empty", view) && !$(".ship-grid", view)) this.render(view);
  },
};

import { S, call, connection, profileReady, loadProgression, loadItems, loadHistory, on } from "../store.js";
import { $, $$, esc, fmt, icon, toast, ago } from "../ui.js";
import { notReady, METHOD_ICON } from "./common.js";

const CHEAT_META = {
  god: { icon: "shield", title: "无敌", sub: "角色不受任何伤害" },
  heal: { icon: "heart", title: "锁定血量与护盾", sub: "血量和护盾始终是满的" },
  ammo: { icon: "ammo", title: "无限弹药", sub: "弹匣与备弹永远是满的" },
  ship: { icon: "rocket", title: "飞船无敌", sub: "飞船不受伤害，核心生命不减" },
  materia: { icon: "gem", title: "无限飞船物质", sub: "飞船物质始终是满的" },
};

let view = null;
let off = [];

function heroHTML() {
  return `
    <div class="hero-top">
      <div class="avatar" id="h-av">·</div>
      <div style="min-width:0">
        <div class="hero-name" id="h-name">未连接</div>
        <div class="hero-meta" id="h-meta"></div>
      </div>
      <div class="spacer"></div>
    </div>
    <div class="vitals" id="h-vitals">
      <div>
        <div class="vital-head"><span>${icon("heart", "")} 血量</span><b id="v-hp">—</b></div>
        <div class="progress good"><i id="v-hp-bar" style="width:0"></i></div>
      </div>
      <div>
        <div class="vital-head"><span>${icon("shield", "")} 护盾</span><b id="v-sh">—</b></div>
        <div class="progress shield"><i id="v-sh-bar" style="width:0"></i></div>
      </div>
    </div>
    <div class="loadout" id="h-loadout">
      <div class="lo"><span class="lo-k">${icon("hand")}手持</span><span class="lo-v" id="lo-held">—</span></div>
      <div class="lo"><span class="lo-k">${icon("ammo")}弹药</span><span class="lo-v num" id="lo-ammo">—</span></div>
      <div class="lo"><span class="lo-k">${icon("gem")}飞船物质</span><span class="lo-v num" id="lo-mat">—</span></div>
    </div>
    <div class="qa">
      <div class="field-label">快速添加 <span class="faint">· 你收藏和最近使用的物品，点一下放进背包</span></div>
      <div class="chips" id="qa-chips"></div>
    </div>
    <div id="h-note" class="muted" style="margin-top:16px;font-size:12.5px"></div>`;
}

// favourites + recently used items (kept in localStorage by the items page)
function quickNames() {
  const get = (k) => { try { return JSON.parse(localStorage.getItem("jb." + k)) || []; } catch { return []; } };
  return [...new Set([...get("favs"), ...get("recent")])].slice(0, 10);
}

function renderQuick() {
  const box = $("#qa-chips", view);
  if (!box) return;
  const names = quickNames();
  const byName = new Map(((S.items && S.items.items) || []).map((i) => [i.name, i]));
  const chips = names.map((n) => byName.get(n)).filter(Boolean);
  if (!chips.length) {
    box.innerHTML = `<span class="muted" style="font-size:12.5px">${S.items ? "在“物品”页点星标收藏常用物品，这里就会出现快捷按钮。" : connection().kind === "good" ? "正在读取物品目录…" : "进入游戏后，你收藏的物品会出现在这里，点一下就能放进背包。"}</span>`;
    return;
  }
  box.innerHTML = chips.map((i) => `<button class="chip" data-quick="${esc(i.name)}" ${connection().kind === "good" ? "" : "disabled"}>${icon("plus").replace("<svg", '<svg style="width:13px;height:13px;stroke:currentColor;fill:none;stroke-width:2.4"')}${esc(i.display)}</button>`).join("");
}

async function quickAdd(name) {
  const it = ((S.items && S.items.items) || []).find((i) => i.name === name);
  if (!it) return;
  const r = await call("spawn", name, 1, it.canBackpack && it.category !== "cargo" ? "backpack" : "ground", "local", "ground");
  if (r.ok) toast(`已添加 ${it.display}`, r.backpack ? "已放进背包" : "出现在你面前的地面上", "good");
  else if (r.error) toast("没有添加", r.error.message, "bad");
  loadHistory();
}

function quickHTML() {
  return `
    <div class="card-title">${icon("bolt")}快捷开关</div>
    <div class="card-sub">只影响你的本机角色；关闭修改器时会自动恢复。</div>
    <div style="margin-top:10px">
      ${Object.entries(CHEAT_META).map(([k, m]) => `
        <div class="toggle-row" data-row="${k}">
          <div class="ticon">${icon(m.icon)}</div>
          <div><div class="tt">${m.title}</div><div class="ts">${m.sub}</div></div>
          <div class="spacer"></div>
          <label class="switch"><input type="checkbox" data-cheat="${k}"><i></i></label>
        </div>`).join("")}
    </div>`;
}

function patchHero() {
  const st = S.status;
  const c = connection();
  const p = st && st.player;
  $("#h-name", view).textContent = p ? p.name : c.title;
  $("#h-av", view).textContent = p ? [...p.name][0] : "·";
  const meta = [];
  meta.push(`<span class="badge ${c.kind}">${c.kind === "good" ? icon("check") : icon("alert")}${esc(c.title)}</span>`);
  if (st && st.profile && st.profile.ready) meta.push(`<span class="badge violet">${icon("star")}${esc(st.profile.rank || "")} · Lv.${st.profile.level ?? "?"}</span>`);
  if (p && p.invulnerable) meta.push(`<span class="badge info">${icon("shield")}无敌中</span>`);
  if (p && p.downed) meta.push(`<span class="badge bad">倒地</span>`);
  if (st) meta.push(`<span class="badge">Unity ${esc(st.unity)}</span>`);
  $("#h-meta", view).innerHTML = meta.join("");
  const vit = $("#h-vitals", view);
  vit.style.opacity = p ? 1 : 0.35;
  if (p) {
    $("#v-hp", view).textContent = `${fmt(Math.round(p.health))} / ${fmt(Math.round(p.maxHealth))}`;
    $("#v-sh", view).textContent = `${fmt(Math.round(p.shield))} / ${fmt(Math.round(p.maxShield))}`;
    $("#v-hp-bar", view).style.width = `${Math.min(100, (p.health / Math.max(1, p.maxHealth)) * 100)}%`;
    $("#v-sh-bar", view).style.width = `${p.maxShield > 0 ? Math.min(100, (p.shield / p.maxShield) * 100) : 0}%`;
  }
  const lo = st && st.loadout;
  const mat = st && st.materia;
  $("#h-loadout", view).style.opacity = p ? 1 : 0.35;
  $("#lo-held", view).textContent = lo ? lo.held || "空手" : "—";
  $("#lo-ammo", view).textContent = lo && lo.ammo ? `${fmt(lo.ammo.current)} / ${fmt(lo.ammo.max)}` : lo ? "不需要弹药" : "—";
  $("#lo-mat", view).textContent = p && mat ? `${fmt(mat.amount)} / ${fmt(mat.max)}` : "—";
  $("#h-note", view).textContent = p ? "" : c.kind === "good" ? "正在等待本机角色加载…" : "启动游戏并进入大厅或飞船后，这里会实时显示你的角色状态。";
}

function syncToggles() {
  const ready = connection().kind === "good";
  const cheats = (S.status && S.status.cheats) || {};
  for (const cb of $$("[data-cheat]", view)) {
    if (document.activeElement !== cb) cb.checked = !!cheats[cb.dataset.cheat];
    cb.disabled = !ready;
    cb.closest(".toggle-row").classList.toggle("on", !!cheats[cb.dataset.cheat]);
  }
}

function renderMinis() {
  const box = $("#minis", view);
  if (!box) return;
  const prog = S.prog;
  if (!profileReady()) {
    box.innerHTML = `<div class="muted" style="grid-column:1/-1;padding:14px 4px">存档还没有加载完成。进入大厅或飞船后，这里会显示你的货币余额。</div>`;
    return;
  }
  if (!prog || !prog.currencies.length) {
    box.innerHTML = Array.from({ length: 6 }, () => `<div class="mini skeleton" style="height:78px"></div>`).join("");
    return;
  }
  box.innerHTML = prog.currencies.map((c) => `
    <div class="mini" style="--c:${c.color}" data-go="currency" title="点击前往货币页面">
      <div class="ml">${esc(c.display)}</div>
      <div class="mv">${fmt(c.amount)}</div>
      <div class="mm">上限 ${fmt(c.max)}</div>
    </div>`).join("");
}

function renderFeed() {
  const box = $("#feed", view);
  if (!box) return;
  const items = S.history.filter((h) => h.method !== "undo" || true).slice(0, 6);
  if (!items.length) {
    box.innerHTML = `<div class="muted" style="padding:6px 2px">还没有操作记录。在其它页面做出修改后，会在这里显示，并支持撤销货币类修改。</div>`;
    return;
  }
  box.innerHTML = `<div class="feed">${items.map((h) => `
    <div class="feed-item ${h.ok ? "" : "bad"}">
      <div class="fi">${icon(h.ok ? METHOD_ICON[h.method] || "check" : "alert")}</div>
      <div style="min-width:0"><div class="ft">${esc(h.title || h.method)}</div><div class="fs">${esc(h.summary || "")}</div></div>
      <div class="fw">${ago(h.time)}</div>
    </div>`).join("")}</div>`;
}

let lastProfileReady = false;

export default {
  id: "dashboard",
  title: "总览",
  sub: "实时状态与常用开关",
  icon: "dashboard",
  group: "main",

  async render(v) {
    view = v;
    off.forEach((f) => f());
    off = [];
    view.innerHTML = `
      <div class="dash">
        <div class="card hero">${heroHTML()}</div>
        <div class="card pad">${quickHTML()}</div>
      </div>
      <div class="section-title">存档货币</div>
      <div class="mini-grid" id="minis"></div>
      <div class="section-title">最近操作</div>
      <div class="card pad" id="feed"></div>`;
    patchHero();
    syncToggles();
    renderMinis();
    renderFeed();

    view.onchange = async (e) => {
      const cb = e.target.closest("[data-cheat]");
      if (!cb) return;
      const name = cb.dataset.cheat;
      const r = await call("setCheat", name, cb.checked);
      if (!r.ok) { cb.checked = !cb.checked; return; }
      if (S.status) S.status.cheats[name] = cb.checked;
      syncToggles();
      loadHistory();
    };
    view.onclick = (e) => {
      const go = e.target.closest("[data-go]");
      if (go) location.hash = "#/" + go.dataset.go;
      const q = e.target.closest("[data-quick]");
      if (q) quickAdd(q.dataset.quick);
    };

    off.push(on("history", renderFeed), on("prog", renderMinis));
    renderQuick();
    lastProfileReady = profileReady();
    if (lastProfileReady) loadProgression(true);
    if (connection().kind === "good") loadItems(false).then(() => { if (view && $("#qa-chips", view)) renderQuick(); });
    loadHistory();
  },

  leave() {
    off.forEach((f) => f());
    off = [];
  },

  update() {
    if (!view || !$("#h-name", view)) return;
    patchHero();
    syncToggles();
    const ready = profileReady();
    if (ready !== lastProfileReady) { lastProfileReady = ready; renderMinis(); } // the save finished loading (or went away)
    if (ready && !S.prog) loadProgression();
  },
};

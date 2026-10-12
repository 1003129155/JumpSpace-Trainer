import { S, call, connection, loadHistory, rpc } from "../store.js";
import { $, $$, esc, icon } from "../ui.js";
import { notReady } from "./common.js";

let view = null;
let info = {}; // name -> {label, hint, runs, error}

const META = {
  god: { icon: "shield", once: null },
  heal: { icon: "heart", once: { label: "立即回满", method: "heal" } },
  ammo: { icon: "ammo", once: { label: "立即补满弹药", method: "ammo" } },
  damage: { icon: "bolt", once: null },
  ship: { icon: "rocket", once: null },
  revive: { icon: "user", once: { label: "立即补满", method: "revive" } },
  solo: { icon: "unlock", once: null },
  legendary: { icon: "star", once: null },
  materia: { icon: "gem", once: { label: "立即补满", method: "materia" } },
  speed: { icon: "run", once: null },
  jump: { icon: "jump", once: null },
};
const ONCE_DONE = { heal: "已回满", ammo: "已补满", materia: "已补满", revive: "已补满" };
// the order and grouping of the switches on the page (switches the game's script adds later go under 其他)
const GROUPS = [
  { title: "生存", names: ["god", "heal", "revive"] },
  { title: "战斗", names: ["ammo", "damage"] },
  { title: "飞船", names: ["ship", "materia"] },
  { title: "移动", names: ["speed", "jump"] },
  { title: "任务", names: ["solo", "legendary"] },
];

const fmtMult = (v) => "×" + (Math.round(v * 100) / 100);
const fillOf = (p) => ((p.value - p.min) / (p.max - p.min)) * 100;

function paramBlock(name, p) {
  return `
    <div class="param" data-param-block="${name}">
      <span class="param-l">${esc(p.label)}</span>
      <input class="range" type="range" min="${p.min}" max="${p.max}" step="${p.step}" value="${p.value}" style="--fill:${fillOf(p)}%" data-param="${name}" aria-label="${esc(p.label)}">
      <b class="num param-v" data-param-value>${fmtMult(p.value)}</b>
      <div class="chips">${p.presets.map((v) => `<button class="chip ${v === p.value ? "on" : ""}" data-preset="${v}" data-for="${name}">${fmtMult(v)}</button>`).join("")}</div>
    </div>`;
}

function row(name) {
  const meta = META[name] || { icon: "bolt" };
  const i = info[name] || {};
  const on = !!(S.status && S.status.cheats && S.status.cheats[name]);
  return `
  <div class="cheat-row ${on ? "on" : ""}" data-cheat-card="${name}">
    <div class="cheat-main">
      <div class="cheat-ico">${icon(meta.icon)}</div>
      <div class="cheat-text"><div class="cheat-name">${esc(i.label || name)}</div><div class="cheat-hint">${esc(i.hint || "")}</div></div>
      <div class="cheat-state"><span class="muted num" data-runs></span><span data-err></span><span class="badge" data-state></span></div>
      ${meta.once ? `<button type="button" class="btn sm" data-once="${meta.once.method}" data-label="${esc(meta.once.label)}">${esc(meta.once.label)}</button>` : ""}
      <label class="switch" title="开 / 关"><input type="checkbox" data-cheat="${name}" ${on ? "checked" : ""} aria-label="${esc(i.label || name)}"><i></i></label>
    </div>
    ${i.param ? paramBlock(name, i.param) : ""}
  </div>`;
}

function paint() {
  const names = Object.keys(info).length ? Object.keys(info) : ["god", "heal", "ammo"];
  const known = new Set(GROUPS.flatMap((g) => g.names));
  const groups = [...GROUPS, { title: "其他", names: names.filter((n) => !known.has(n)) }]
    .map((g) => ({ ...g, names: g.names.filter((n) => names.includes(n)) }))
    .filter((g) => g.names.length);
  view.innerHTML = `
    <div class="cheat-bar">
      <div class="callout info">${icon("info")}<div>只影响<b>你的本机角色</b>。开关打开后修改器会一直保持效果；<b>关掉修改器或游戏时会自动关闭并恢复</b>。</div></div>
      <button type="button" class="btn" id="all-off">${icon("power")}全部关闭</button>
    </div>
    <div class="callout" id="cheat-noplayer" style="margin-bottom:14px" hidden>${icon("alert")}<div>你的角色现在不在场景里（加载中、已倒地或在菜单）。开关可以先打开，角色出现后会自动生效。</div></div>
    <div class="card cheat-panel">${groups.map((g) => `<div class="cheat-group">${esc(g.title)}</div>${g.names.map(row).join("")}`).join("")}</div>`;
}

async function refreshInfo() {
  const r = await rpc("cheats");
  if (!r.ok) return false;
  info = Object.fromEntries(r.cheats.map((c) => [c.name, c]));
  return true;
}

function sync() {
  const banner = $("#cheat-noplayer", view);
  if (banner) banner.hidden = !!(S.status && S.status.player);
  for (const el of $$("[data-cheat-card]", view)) {
    const name = el.dataset.cheatCard;
    const on = !!(S.status && S.status.cheats && S.status.cheats[name]);
    const cb = $("[data-cheat]", el);
    if (document.activeElement !== cb) cb.checked = on;
    el.classList.toggle("on", on);
    const st = $("[data-state]", el);
    const sclass = "badge " + (on ? "good" : "");
    const shtml = on ? icon("check") + "运行中" : "已关闭";
    if (st.className !== sclass) st.className = sclass;
    if (st.innerHTML !== shtml) st.innerHTML = shtml;
    const i = info[name];
    $("[data-runs]", el).textContent = on && i && i.runs ? `已执行 ${i.runs.toLocaleString("en-US")} 次` : "";
    const err = i && i.error ? `<span class="badge bad" title="${esc(i.error)}">${icon("alert")}出错</span>` : "";
    const errEl = $("[data-err]", el);
    if (errEl.innerHTML !== err) errEl.innerHTML = err;
    if (i && i.param) showParam(el, i.param, true);
  }
  const n = S.status && S.status.cheats ? Object.values(S.status.cheats).filter(Boolean).length : 0;
  const off = $("#all-off", view);
  if (off) {
    off.disabled = !n;
    const html = `${icon("power")}全部关闭${n ? `（${n}）` : ""}`;
    if (off.innerHTML !== html) off.innerHTML = html;
  }
}

// Reflect a multiplier in the slider, its label and the preset chips (skip the slider while it is being dragged).
function showParam(el, p, fromGame = false) {
  const range = $("[data-param]", el);
  if (!range) return;
  if (!(fromGame && document.activeElement === range)) range.value = p.value;
  range.style.setProperty("--fill", fillOf({ ...p, value: Number(range.value) }) + "%");
  $("[data-param-value]", el).textContent = fmtMult(Number(range.value));
  for (const chip of $$("[data-preset]", el)) chip.classList.toggle("on", Number(chip.dataset.preset) === Number(range.value));
}

async function commitParam(name, value) {
  const r = await call("setCheatParam", name, value);
  if (!r.ok) { await refreshInfo(); sync(); return; }
  info = Object.fromEntries(r.cheats.map((c) => [c.name, c]));
  sync();
}

export default {
  id: "cheats",
  title: "角色强化",
  sub: "无敌、锁血、无限弹药、移动速度与跳跃",
  icon: "bolt",
  group: "main",

  async render(v) {
    view = v;
    if (connection().kind !== "good") { view.innerHTML = notReady("修改功能"); return; }
    await refreshInfo();
    if (!view) return;
    paint();
    sync();
    view.onchange = async (e) => {
      const range = e.target.closest("[data-param]");
      if (range) return commitParam(range.dataset.param, range.value);
      const cb = e.target.closest("[data-cheat]");
      if (!cb) return;
      const name = cb.dataset.cheat;
      const r = await call("setCheat", name, cb.checked);
      if (!r.ok) { cb.checked = !cb.checked; return; }
      info = Object.fromEntries(r.cheats.map((c) => [c.name, c]));
      if (S.status) S.status.cheats[name] = cb.checked;
      sync();
      loadHistory();
    };
    view.oninput = (e) => {
      const range = e.target.closest("[data-param]");
      if (!range) return;
      const el = range.closest("[data-cheat-card]");
      showParam(el, { ...info[range.dataset.param].param, value: Number(range.value) });
    };
    view.onclick = async (e) => {
      const chip = e.target.closest("[data-preset]");
      if (chip) {
        const name = chip.dataset.for;
        showParam(chip.closest("[data-cheat-card]"), { ...info[name].param, value: Number(chip.dataset.preset) });
        return commitParam(name, chip.dataset.preset);
      }
      const once = e.target.closest("[data-once]");
      if (once) {
        once.disabled = true;
        const r = await call("cheatOnce", once.dataset.once);
        if (r.ok) once.innerHTML = `${icon("check")}${ONCE_DONE[once.dataset.once] || "已完成"}`;
        setTimeout(() => { once.disabled = false; once.textContent = once.dataset.label; }, r.ok ? 1800 : 0);
      }
      if (e.target.closest("#all-off")) {
        for (const name of Object.keys(info)) if (S.status && S.status.cheats[name]) await call("setCheat", name, false);
        await refreshInfo();
        if (S.status) for (const k of Object.keys(S.status.cheats)) S.status.cheats[k] = false;
        sync();
      }
    };
  },

  async update() {
    if (!view) return;
    const ready = connection().kind === "good";
    if (!ready) { if (!$(".empty", view)) view.innerHTML = notReady("修改功能"); return; }
    if ($(".empty", view)) { this.render(view); return; }
    if (await refreshInfo() && view) sync();
  },
};

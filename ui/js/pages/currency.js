import { S, call, profileReady, loadProgression, loadHistory, post } from "../store.js";
import { $, $$, esc, fmt, icon, toast, animateNumber, confirmDialog } from "../ui.js";
import { notReady } from "./common.js";

let view = null;
let tick = 0;

const PRESETS = {
  Credits: [1000, 10000, 100000],
  Ingots: [10, 50, 100],
};

function pct(a, max) {
  return Math.max(0, Math.min(100, (a / Math.max(1, max)) * 100));
}

function currencyCard(c) {
  const big = c.group === "Credits";
  const presets = PRESETS[c.group] || PRESETS.Ingots;
  const sub = big ? "通用货币 · 商店、制作、升级" : "升级材料 · 蓝图升级";
  return `
  <div class="card cur ${big ? "big" : ""}" style="--c:${esc(c.color)}" data-guid="${esc(c.guid)}">
    <div class="cur-main">
      <div class="cur-head">
        <div class="gem">${icon(big ? "coins" : "gem")}</div>
        <div><div class="cur-name">${esc(c.display)}</div><div class="muted" style="font-size:12px">${sub}</div></div>
      </div>
      <div class="cur-amount"><b data-amount data-v="${c.amount}">${fmt(c.amount)}</b><span>/ ${fmt(c.max)}</span></div>
      <div class="progress"><i data-bar style="width:${pct(c.amount, c.max)}%"></i></div>
    </div>
    <div class="cur-side">
      <div class="cur-actions">
        ${presets.map((n) => `<button class="btn sm" data-add="${n}">+${fmt(n)}</button>`).join("")}
        <button class="btn sm" data-max>加满</button>
        <button class="btn sm ghost" data-zero>清零</button>
      </div>
      <div class="cur-set"><input class="input" data-input inputmode="numeric" placeholder="输入目标数量，回车设置" maxlength="9"><button class="btn" data-set>设置</button></div>
    </div>
  </div>`;
}

function expCard(x) {
  const next = Math.max(1, x.toNext || 1);
  return `
  <div class="card pad" id="exp-card">
    <div class="card-title">${icon("star")}等级与经验</div>
    <div class="row" style="margin-top:14px">
      <div class="avatar" style="width:54px;height:54px;font-size:17px;border-radius:16px">Lv.${x.level}</div>
      <div style="flex:1;min-width:0">
        <div class="cur-name">${esc(x.rank || "—")}</div>
        <div class="muted num" style="font-size:12.5px">经验 ${fmt(x.exp)} / ${fmt(next)}</div>
        <div class="progress thin" style="margin-top:8px"><i style="width:${pct(x.exp, next)}%"></i></div>
      </div>
    </div>
    <div class="row wrap" style="margin-top:14px">
      <button class="btn sm" data-xp="500">+500 经验</button>
      <button class="btn sm" data-xp="2000">+2,000 经验</button>
      <button class="btn sm" data-lv="1">升 1 级</button>
      <button class="btn sm" data-lv="5">升 5 级</button>
    </div>
    <div class="muted" style="font-size:12px;margin-top:10px">经验和等级无法撤销，操作前会再次确认。</div>
  </div>`;
}

function materiaCard(m) {
  const body = m
    ? `<div class="cur-amount"><b data-m-amount data-v="${m.amount}">${fmt(m.amount)}</b><span>/ ${fmt(m.max)}</span></div>
       <div class="progress warn"><i data-m-bar style="width:${pct(m.amount, m.max)}%"></i></div>
       <div class="row wrap" style="margin-top:14px">
         <button class="btn sm" data-mat-add="25">+25</button>
         <button class="btn sm" data-mat-add="100">+100</button>
         <button class="btn sm" data-mat-max>加满</button>
         <button class="btn sm ghost" data-mat-zero>清空</button>
       </div>`
    : `<div class="muted" style="margin-top:12px">当前不在飞船任务场景中，进入后可用。</div>`;
  return `
  <div class="card pad" id="mat-card">
    <div class="card-title">${icon("rocket")}飞船物质 <span class="badge warn" style="margin-left:6px">局内</span></div>
    <div class="card-sub">用于复活队友和飞船购买；不属于存档，离开任务后重置。</div>
    ${body}
  </div>`;
}

function bulkCard(n) {
  return `
  <div class="card pad bulk">
    <div class="card-title">${icon("bolt")}批量操作</div>
    <div class="card-sub">一次处理全部 ${n} 种货币；每一项都可以在“记录与设置”页单独撤销。</div>
    <div class="row wrap" style="margin-top:16px"><button class="btn primary" id="fill-all">${icon("coins")}全部加满</button></div>
  </div>`;
}

async function fillAll() {
  const list = S.prog.currencies.filter((c) => c.amount < c.max);
  if (!list.length) return toast("全部货币已经是满的", "", "info");
  const ok = await confirmDialog({
    title: "把全部货币加满？",
    message: "每种货币都会设置为游戏允许的上限。每一项都会单独记录，可以在“记录与设置”页逐项撤销。",
    items: list.map((c) => `${c.display}：${fmt(c.amount)} → ${fmt(c.max)}`),
    confirmText: "全部加满",
  });
  if (!ok) return;
  let done = 0;
  for (const c of list) {
    const r = await call("setCurrency", c.guid, c.max);
    if (!r.ok) break;
    const i = S.prog.currencies.findIndex((x) => x.guid === c.guid);
    if (i >= 0) S.prog.currencies[i] = r.currency;
    done++;
  }
  patch(S.prog);
  toast(`已加满 ${done} 种货币`, done < list.length ? "中途出错，已停止" : "", done < list.length ? "warn" : "good");
  loadHistory();
}

function render() {
  const prog = S.prog;
  if (!prog) {
    view.innerHTML = `<div class="cur-grid">${Array.from({ length: 6 }, (_, i) => `<div class="card skeleton ${i === 0 ? "" : ""}" style="height:190px;${i === 0 ? "grid-column:span 3" : ""}"></div>`).join("")}</div>`;
    return;
  }
  if (!prog.ready) {
    view.innerHTML = notReady("货币功能", true);
    return;
  }
  view.innerHTML = `
    <div class="callout info" style="margin-bottom:16px">${icon("info")}<div>货币直接写入你的<b>本机存档</b>，修改前已自动备份存档，并且每一步都可以在“记录”页撤销。数量会自动限制在游戏允许的上限内。</div></div>
    <div class="cur-grid">${prog.currencies.map(currencyCard).join("")}${bulkCard(prog.currencies.length)}</div>
    <div class="section-title">进度</div>
    <div class="prog-row">${expCard(prog.experience)}${materiaCard(prog.materia)}</div>`;
}

function patch(prog) {
  for (const c of prog.currencies) {
    const card = $(`.cur[data-guid="${c.guid}"]`, view);
    if (!card) continue;
    animateNumber($("[data-amount]", card), c.amount);
    $("[data-bar]", card).style.width = pct(c.amount, c.max) + "%";
  }
  if (prog.materia && $("[data-m-amount]", view)) {
    animateNumber($("[data-m-amount]", view), prog.materia.amount);
    $("[data-m-bar]", view).style.width = pct(prog.materia.amount, prog.materia.max) + "%";
  }
}

function flash(guid) {
  const card = $(`.cur[data-guid="${guid}"]`, view);
  if (!card) return;
  card.classList.remove("flash");
  void card.offsetWidth;
  card.classList.add("flash");
}

async function undo(id) {
  const r = await post("/api/undo", { id });
  if (r.ok) { toast("已撤销", "", "good"); await refresh(); loadHistory(); }
  else toast("撤销失败", r.error.message, "bad");
}

async function refresh() {
  const prog = await loadProgression(true);
  if (prog && view && $(".cur-grid .cur", view)) { S.prog = prog; patch(prog); }
  else if (prog) render();
}

function reportCurrency(r, verb) {
  const c = r.currency;
  if (r.changed) {
    toast(`${c.display} ${verb}`, `${fmt(r.before)} → ${fmt(r.after)}${r.clamped ? "（已限制在上限内）" : ""}`, "good", r.undoable ? { action: { label: "撤销", run: () => undo(r.historyId) } } : {});
  } else {
    toast(`${c.display} 没有变化`, r.clamped ? "已经在允许的范围边界" : "数值相同", "info");
  }
  const i = S.prog.currencies.findIndex((x) => x.guid === c.guid);
  if (i >= 0) S.prog.currencies[i] = c;
  patch(S.prog);
  flash(c.guid);
  loadHistory();
}

async function onClick(e) {
  if (e.target.closest("#fill-all")) return fillAll();
  const card = e.target.closest(".cur");
  if (card) {
    const guid = card.dataset.guid;
    const cur = S.prog.currencies.find((c) => c.guid === guid);
    if (e.target.closest("[data-add]")) {
      const n = Number(e.target.closest("[data-add]").dataset.add);
      const r = await call("addCurrency", guid, n);
      if (r.ok) reportCurrency(r, `+${fmt(n)}`);
    } else if (e.target.closest("[data-max]")) {
      const r = await call("setCurrency", guid, cur.max);
      if (r.ok) reportCurrency(r, "已加满");
    } else if (e.target.closest("[data-zero]")) {
      const r = await call("setCurrency", guid, 0);
      if (r.ok) reportCurrency(r, "已清零");
    } else if (e.target.closest("[data-set]")) {
      await applyInput(card);
    }
    return;
  }
  const xp = e.target.closest("[data-xp]");
  const lv = e.target.closest("[data-lv]");
  if (xp || lv) {
    const label = xp ? `+${fmt(xp.dataset.xp)} 经验` : `提升 ${lv.dataset.lv} 级`;
    const ok = await confirmDialog({ title: "确认修改等级/经验？", message: `${label}。这个操作无法撤销（如需回退只能还原存档备份）。`, confirmText: "确认修改" });
    if (!ok) return;
    const r = xp ? await call("addExperience", Number(xp.dataset.xp)) : await call("levelUp", Number(lv.dataset.lv));
    if (r.ok) {
      toast("等级/经验已更新", `Lv.${r.before.level} → Lv.${r.after.level}　经验 ${fmt(r.after.exp)} / ${fmt(r.after.toNext)}`, "good");
      await refresh();
      render();
      loadHistory();
    }
    return;
  }
  const matAdd = e.target.closest("[data-mat-add]");
  if (matAdd || e.target.closest("[data-mat-max]") || e.target.closest("[data-mat-zero]")) {
    const m = S.prog.materia;
    if (!m) return;
    const target = matAdd ? m.amount + Number(matAdd.dataset.matAdd) : e.target.closest("[data-mat-max]") ? m.max : 0;
    const r = await call("setMateria", target);
    if (r.ok) {
      toast("飞船物质已更新", `${r.before.amount} → ${r.after.amount}`, "good", r.undoable ? { action: { label: "撤销", run: () => undo(r.historyId) } } : {});
      S.prog.materia = r.after;
      patch(S.prog);
      loadHistory();
    }
  }
}

async function applyInput(card) {
  const input = $("[data-input]", card);
  const text = input.value.trim().replace(/[,，\s]/g, "");
  if (!/^\d{1,9}$/.test(text)) {
    toast("请输入数量", "只能输入 0 或正整数", "warn");
    input.focus();
    return;
  }
  const r = await call("setCurrency", card.dataset.guid, Number(text));
  if (r.ok) { reportCurrency(r, "已设置"); input.value = ""; }
}

export default {
  id: "currency",
  title: "货币与进度",
  sub: "信用点、各级锭、等级经验与飞船物质",
  icon: "coins",
  group: "main",

  async render(v) {
    view = v;
    tick = 0;
    if (!profileReady()) { view.innerHTML = notReady("货币功能", true); return; }
    view.onclick = onClick;
    view.onkeydown = (e) => {
      if (e.key === "Enter" && e.target.matches("[data-input]")) applyInput(e.target.closest(".cur"));
    };
    render();
    const prog = await loadProgression(true);
    if (prog) render();
  },

  update() {
    if (!view) return;
    const ready = profileReady();
    if (!ready) { if (!$(".empty", view)) view.innerHTML = notReady("货币功能", true); return; }
    if ($(".empty", view)) { this.render(view); return; }
    if (++tick % 3 === 0 && !document.activeElement?.matches?.("[data-input]")) {
      loadProgression(true).then((p) => { if (p && view && $(".cur-grid .cur", view)) patch(p); });
    }
  },
};

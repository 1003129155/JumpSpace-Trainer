// DOM helpers, icons, toasts, modals, number animation.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const fmt = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString("en-US") : "—");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

export function ago(ts) {
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 5) return "刚刚";
  if (s < 60) return `${Math.floor(s)} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

// 24x24 stroke icons (paths only; wrapped by icon()).
const P = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.6"/><rect x="14" y="3" width="7" height="5" rx="1.6"/><rect x="14" y="12" width="7" height="9" rx="1.6"/><rect x="3" y="16" width="7" height="5" rx="1.6"/>',
  coins: '<circle cx="9" cy="9" r="6"/><path d="M18.1 10.4A6 6 0 1 1 10.4 18.1"/><path d="M7 9h4M9 7v4"/>',
  box: '<path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3.3 7.6L12 12.5l8.7-4.9M12 12.5V21"/>',
  blueprint: '<path d="M14 3H6.5A2.5 2.5 0 0 0 4 5.5v13A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V9z"/><path d="M14 3v5a1 1 0 0 0 1 1h5M8 13h8M8 17h5"/>',
  rocket: '<path d="M12 2.5c3.6 1.6 6 5.2 6 9.5l-2.2 3.2H8.2L6 12c0-4.300 2.400-7.900 6-9.500z"/><circle cx="12" cy="10" r="1.700"/><path d="M8.200 15.200L5 19.500l4-.9M15.800 15.200l3.200 4.300-4-.9M10 18.600c.2 1.300.9 2.200 2 2.900 1.100-.7 1.800-1.600 2-2.900"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  run: '<path d="M13 5l7 7-7 7M4 5l7 7-7 7"/>',
  jump: '<path d="M12 18V5M6 11l6-6 6 6M5 21.500h14"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.200 2"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.600-3.600"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  check: '<path d="M5 12.500l4.500 4.500L19 7.500"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.500a5.500 5.500 0 0 1 0 11H11"/>',
  star: '<path d="M12 3.200l2.700 5.600 6.100.8-4.500 4.200 1.200 6.100L12 17l-5.500 2.900 1.200-6.100L3.200 9.600l6.100-.8z"/>',
  heart: '<path d="M12 20.500s-8-4.900-8-11A4.500 4.500 0 0 1 12 7a4.500 4.500 0 0 1 8 2.500c0 6.100-8 11-8 11z"/>',
  shield: '<path d="M12 3l8 3v6c0 4.800-3.400 8-8 9-4.600-1-8-4.200-8-9V6z"/>',
  ammo: '<path d="M9 21v-8.500a3 3 0 0 1 6 0V21z"/><path d="M9 17h6M12 6v1.500"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.600-7 8-7s8 3 8 7"/>',
  alert: '<path d="M12 3.500l10 17.500H2z"/><path d="M12 10v4.500M12 17.800v.2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.500M12 7.700v.2"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.200-3.700M4 4v4.500h4.500"/><path d="M4 13a8 8 0 0 0 14.200 3.700M20 20v-4.500h-4.500"/>',
  folder: '<path d="M3 7.500a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  gem: '<path d="M6.500 3h11L22 9l-10 12L2 9z"/><path d="M2 9h20M9.500 3L12 9l2.500-6M12 21L9 9M12 21l3-12"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.500-2"/>',
  hand: '<path d="M8 12V5.500a1.500 1.500 0 0 1 3 0V11M11 10V4.500a1.500 1.500 0 0 1 3 0V11M14 10.500V6a1.500 1.500 0 0 1 3 0v8c0 4-2.500 7-6 7-2.700 0-4-1.500-5.500-4L4 14.200a1.500 1.500 0 0 1 2.500-1.600L8 14.500"/>',
  floor: '<path d="M3 17l9 4 9-4M3 13l9 4 9-4M12 3v9M8.500 8.500L12 12l3.500-3.500"/>',
  bag: '<path d="M6 8h12l1 12.500H5z"/><path d="M9 8V6.500a3 3 0 0 1 6 0V8"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
  power: '<path d="M12 3v8M6.400 6.600a8 8 0 1 0 11.200 0"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  save: '<path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M7 3v5h8V3M7 21v-7h10v7"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.500v3M12 18.500v3M4.500 4.500l2.100 2.100M17.400 17.400l2.100 2.100M2.500 12h3M18.500 12h3M4.500 19.500l2.100-2.100M17.400 6.600l2.100-2.100"/>',
  wrench: '<path d="M14.500 6.500a4 4 0 0 0 5 5L21 13l-8 8-4-4 8-8z"/>',
  flag: '<path d="M5 21V4"/><path d="M5 4h12l-2.5 4.5L17 13H5"/>',
  sword: '<path d="M14.500 3H21v6.500L9.500 21l-3-3L18 6.500zM5 19l-2 2M7 15l2 2"/>',
};
export function icon(name, cls = "") {
  return `<svg viewBox="0 0 24 24" class="${cls}" aria-hidden="true">${P[name] || P.info}</svg>`;
}

// ---------------------------------------------------------------- toasts
const TOAST_ICON = { good: "check", bad: "alert", warn: "alert", info: "info" };
export function toast(title, message = "", kind = "info", options = {}) {
  const root = $("#toasts");
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `<div class="ticon">${icon(TOAST_ICON[kind] || "info")}</div><div class="tbody"><div class="ttitle">${esc(title)}</div>${message ? `<div class="tmsg">${esc(message)}</div>` : ""}</div>${options.action ? `<button class="btn sm tact">${esc(options.action.label)}</button>` : ""}<button class="tx" title="关闭" aria-label="关闭">${icon("x")}</button>`;
  const close = () => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 190);
  };
  if (options.action) $(".tact", el).addEventListener("click", () => { options.action.run(); close(); });
  $(".tx", el).addEventListener("click", close);
  el.addEventListener("click", (e) => { if (!e.target.closest("button")) close(); });
  // one at a time: a second one would reach down over the page's controls
  root.replaceChildren(el);
  // Toasts with an action stay longer; hovering one pauses its countdown.
  let remaining = options.ms ?? (options.action ? 9000 : kind === "bad" ? 9000 : kind === "warn" ? 6500 : 3800);
  let started = Date.now();
  let timer = setTimeout(close, remaining);
  el.addEventListener("mouseenter", () => { clearTimeout(timer); remaining -= Date.now() - started; });
  el.addEventListener("mouseleave", () => { started = Date.now(); timer = setTimeout(close, Math.max(1500, remaining)); });
  return close;
}

// ----------------------------------------------------------------- modal
export function confirmDialog({ title, message = "", items = [], confirmText = "确定", cancelText = "取消", kind = "warn", danger = false }) {
  return new Promise((resolve) => {
    const root = $("#modal-root");
    const back = document.createElement("div");
    back.className = "modal-back";
    back.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-head"><div class="micon ${kind === "info" ? "info" : ""}">${icon(kind === "info" ? "info" : "alert")}</div><div><h3>${esc(title)}</h3><p>${esc(message)}</p></div></div>
        ${items.length ? `<div class="modal-body"><div class="modal-list">${items.map((i) => `<div>${esc(i)}</div>`).join("")}</div></div>` : ""}
        <div class="modal-foot"><button class="btn" data-r="0">${esc(cancelText)}</button><button class="btn ${danger ? "danger" : "primary"}" data-r="1">${esc(confirmText)}</button></div>
      </div>`;
    const done = (v) => {
      document.removeEventListener("keydown", onKey, true);
      back.remove();
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); done(false); }
      if (e.key === "Enter") { e.preventDefault(); done(true); }
    };
    back.addEventListener("click", (e) => {
      if (e.target === back) done(false);
      const b = e.target.closest("[data-r]");
      if (b) done(b.dataset.r === "1");
    });
    document.addEventListener("keydown", onKey, true);
    root.appendChild(back);
    $("[data-r='1']", back).focus();
  });
}

// ------------------------------------------------------- number animation
export function animateNumber(el, to, ms = 650) {
  if (!el) return;
  const from = Number(el.dataset.v ?? el.textContent.replace(/[^\d.-]/g, "")) || 0;
  el.dataset.v = to;
  if (from === to || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    el.textContent = fmt(to);
    return;
  }
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / ms);
    const e = 1 - Math.pow(1 - k, 3);
    el.textContent = fmt(Math.round(from + (to - from) * e));
    if (k < 1) requestAnimationFrame(step);
    else el.textContent = fmt(to);
  };
  requestAnimationFrame(step);
}

export function load(key, fallback) {
  try { const v = localStorage.getItem("jb." + key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
}
export function save(key, value) {
  try { localStorage.setItem("jb." + key, JSON.stringify(value)); } catch { /* private mode */ }
}

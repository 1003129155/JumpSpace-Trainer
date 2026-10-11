// The attribute editor: the tier, the modules ("词条": which module, its rarity, level and roll) and the level of one item — a
// weapon or a ship part. Shared by the blueprint page and the items page.
//
// The page mounts it once. While the item is edited the editor keeps its DOM and only updates what differs, so nothing is
// re-created on a change: no flicker, and focus, a typed number or an open drop-down survive. Every change is sent to the
// game (the page's `call`), which builds the item in memory and answers with its own texts, the level cap and the rule
// violations. Nothing is recorded until the page does something with `spec()`.
import { esc, icon, load, save } from "./ui.js";

// the tiers as the game shows them: the colours are the game's own (UIColor.GetRarityColor)
export const TIERS = [
  { name: "Common", label: "普通", color: "#80e5b2", hint: "绿色" },
  { name: "Rare", label: "稀有", color: "#33ccff", hint: "蓝色" },
  { name: "Epic", label: "史诗", color: "#f28cff", hint: "紫色" },
  { name: "Legendary", label: "传说", color: "#ff7359", hint: "红色" },
];
export const tierIndex = (name) => Math.max(0, TIERS.findIndex((t) => t.name === name));

const newSeed = () => Math.floor(Math.random() * 2000000000);

// options: call(spec, action) -> Promise<reply of the game>, tierKey (where the last tier is remembered), onChange(state)
export function createAttrEditor(root, { call, tierKey = "attr.tier", onChange = () => {} }) {
  const savedTier = load(tierKey, 0);
  const st = {
    tier: Number.isInteger(savedTier) && savedTier >= 0 && savedTier < TIERS.length ? savedTier : 0,
    seed: newSeed(),
    level: null, // the blueprint level: a number, "max", or null (just what the upgrades need)
    slots: [], // [{ guid, rarity, level, roll }]
    modules: [], // what may go into a slot: [{ guid, name, base, instigator, maxLevel[4], allowed[4] }]
    ev: null, // the game's evaluation of the item as it is now
    error: "",
    loaded: false,
    token: 0,
    inflight: 0,
  };
  let timer = null; // a debounced evaluation that has not been sent yet
  let busyTimer = null;
  let waiters = [];
  let disposed = false;
  const rows = [];

  root.classList.add("attr");
  root.innerHTML = `
    <div class="attr-bar">
      <span class="muted">品质</span>
      <div class="seg tier" data-r="tier">${TIERS.map((t, i) => `<button type="button" data-tier="${i}" style="--tc:${t.color}" title="${t.hint}">${t.label}</button>`).join("")}</div>
      <div class="attr-acts">
        <button type="button" class="btn sm" data-act="reroll" title="换一批游戏随机出的词条">重新随机</button>
        <button type="button" class="btn sm" data-act="max" title="每个词条取它能有的最高品质和最高数值，再把装备等级和词条等级升到这件装备能达到的最高（词条本身不变）">全部拉满</button>
      </div>
    </div>
    <div class="attr-slots" data-r="slots"></div>
    <div class="attr-empty muted" data-r="empty" hidden>这个品质的这件装备没有词条位，只有装备等级。</div>
    <div class="attr-level">
      <label>装备等级 <input class="input" type="number" min="1" step="1" data-f="blevel" aria-label="装备等级"></label>
      <span class="muted" data-r="cap"></span>
      <button type="button" class="btn sm" data-act="levelmax" title="取这件装备的等级上限">满级</button>
      <span class="muted attr-points" data-r="points"></span>
    </div>
    <div class="callout attr-errors" data-r="errors" hidden></div>`;
  const $r = (name) => root.querySelector(`[data-r="${name}"]`);
  const els = {
    tier: [...root.querySelectorAll("[data-tier]")],
    slots: $r("slots"), empty: $r("empty"),
    blevel: root.querySelector('[data-f="blevel"]'), cap: $r("cap"), points: $r("points"),
    levelmax: root.querySelector('[data-act="levelmax"]'), errors: $r("errors"),
  };

  // only touch the DOM when something differs (a mutation that changes nothing still makes the browser redo layout)
  const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };
  let errorsShown = "";
  const modOf = (guid) => st.modules.find((m) => m.guid === guid);
  const allowedTiers = (m) => [0, 1, 2, 3].filter((t) => t <= st.tier && (!m || m.allowed[t]));
  const specOf = () => ({ tier: st.tier, seed: st.seed, level: st.level, slots: st.slots.map((x) => ({ guid: x.guid, rarity: x.rarity, level: x.level, roll: x.roll })) });
  const errorsNow = () => [...((st.ev && st.ev.errors) || []), st.error].filter(Boolean);
  const busy = () => st.inflight > 0 || timer !== null;
  const ok = () => st.loaded && !st.error && !!st.ev && st.ev.errors.length === 0; // nothing the game objects to (a change may still be on its way)
  const valid = () => ok() && !busy();

  // ------------------------------------------------------------------ rows
  function makeRow(i) {
    const el = document.createElement("div");
    el.className = "attr-slot";
    el.dataset.i = String(i);
    el.innerHTML = `
      <div class="attr-slot-row">
        <span class="attr-n">${i + 1}</span>
        <select class="input attr-mod" data-f="guid" title="这个词条位装哪个词条（★ 是带特殊效果的词条）" aria-label="词条 ${i + 1}"></select>
        <select class="input attr-rar" data-f="rarity" title="这个词条的品质" aria-label="词条品质 ${i + 1}"></select>
        <label class="attr-lv">等级<input class="input" type="number" min="1" step="1" data-f="level" aria-label="词条等级 ${i + 1}"></label>
        <div class="seg attr-roll" title="词条数值：随机是游戏抽出来的，最高是这个词条能达到的最大基础值"><button type="button" data-f="roll" data-v="random">随机</button><button type="button" data-f="roll" data-v="max">最高</button></div>
      </div>
      <div class="attr-text"><span class="muted">…</span></div>`;
    els.slots.appendChild(el);
    return {
      el, key: "", rkey: "", html: null,
      mod: el.querySelector(".attr-mod"), rar: el.querySelector(".attr-rar"), lv: el.querySelector(".attr-lv input"),
      rollBtns: [...el.querySelectorAll(".attr-roll button")], text: el.querySelector(".attr-text"),
    };
  }

  const optionsHTML = (list, current) => {
    const group = (title, items) => (items.length ? `<optgroup label="${title}">${items.map((y) => `<option value="${esc(y.guid)}"${y.guid === current ? " selected" : ""}>${esc(y.name)}${y.instigator ? " ★" : ""}</option>`).join("")}</optgroup>` : "");
    return group("基础词条", list.filter((y) => y.base)) + group("专属词条", list.filter((y) => !y.base));
  };

  function syncRow(r, i) {
    const x = st.slots[i];
    const m = modOf(x.guid);
    const info = st.ev && st.ev.slots && st.ev.slots[i];
    // the module list only changes with the rarity (some modules do not come in every rarity)
    const usable = st.modules.filter((y) => y.allowed[x.rarity] || y.guid === x.guid);
    const key = `${x.rarity}:${usable.map((y) => y.guid).join(",")}`;
    if (r.key !== key) { r.mod.innerHTML = optionsHTML(usable, x.guid); r.key = key; }
    if (r.mod.value !== x.guid) r.mod.value = x.guid;
    const tiers = allowedTiers(m);
    const rkey = tiers.join(",");
    if (r.rkey !== rkey) { r.rar.innerHTML = tiers.map((t) => `<option value="${t}">${TIERS[t].label}</option>`).join(""); r.rkey = rkey; }
    if (r.rar.value !== String(x.rarity)) r.rar.value = String(x.rarity);
    const max = m ? m.maxLevel[x.rarity] : 1;
    r.lv.max = String(max);
    r.lv.title = `词条等级，最高 ${max}`;
    if (document.activeElement !== r.lv) r.lv.value = String(x.level);
    const mode = x.roll === "max" ? "max" : "random";
    r.rollBtns.forEach((b) => b.classList.toggle("on", b.dataset.v === mode));
    r.el.style.setProperty("--tc", TIERS[x.rarity].color);
    // the game's text for it; kept as it was while the game has nothing new to say (a rule violation, a failed request)
    if (info) {
      if (r.html !== info.html) { r.text.innerHTML = info.html || '<span class="muted">（没有说明）</span>'; r.html = info.html; }
      r.text.classList.remove("stale");
    } else if (r.html !== null) {
      r.text.classList.add("stale");
    }
  }

  function sync() {
    if (disposed) return;
    els.tier.forEach((b) => b.classList.toggle("on", Number(b.dataset.tier) === st.tier));
    while (rows.length > st.slots.length) rows.pop().el.remove();
    while (rows.length < st.slots.length) rows.push(makeRow(rows.length));
    rows.forEach((r, i) => syncRow(r, i));
    els.empty.hidden = !(st.loaded && st.slots.length === 0);
    const ev = st.ev;
    const cap = ev && ev.cap ? ev.cap : null;
    els.blevel.max = cap ? String(cap) : "";
    if (document.activeElement !== els.blevel) els.blevel.value = typeof st.level === "number" ? String(st.level) : ev && ev.level ? String(ev.level) : "";
    els.blevel.disabled = st.level === "max";
    setText(els.cap, cap ? `上限 ${cap}` : "");
    els.levelmax.classList.toggle("primary", st.level === "max");
    setText(els.points, ev && ev.need ? `词条升级已用 ${ev.need - 1} 点，装备 ${ev.level} 级共有 ${ev.level - 1} 点` : "");
    const errs = errorsNow();
    const shown = errs.join("|");
    if (shown !== errorsShown) {
      errorsShown = shown;
      els.errors.hidden = errs.length === 0;
      els.errors.innerHTML = errs.length ? `${icon("alert")}<div>${errs.map(esc).join("<br>")}</div>` : "";
    }
  }

  function notify() {
    if (disposed) return;
    root.classList.toggle("attr-ok", valid());
    onChange(api.state());
    if (!busy()) { const w = waiters; waiters = []; w.forEach((f) => f()); }
  }

  // ---------------------------------------------------------------- talking to the game
  // a slow answer dims the slots a little; a quick one changes nothing on screen but the texts
  function startBusy() {
    if (busyTimer === null) busyTimer = setTimeout(() => { root.classList.add("attr-busy"); }, 350);
  }
  function stopBusy() {
    if (busyTimer !== null) { clearTimeout(busyTimer); busyTimer = null; }
    root.classList.remove("attr-busy");
  }

  async function request(action) {
    if (disposed) return;
    if (timer !== null) { clearTimeout(timer); timer = null; }
    const mine = ++st.token;
    st.inflight++;
    startBusy();
    let r;
    try { r = await call(specOf(), action); } catch (e) { r = { ok: false, error: { message: String((e && e.message) || e) } }; }
    st.inflight--;
    if (disposed) return;
    if (mine !== st.token) return; // a newer request has been made meanwhile: its answer is the one that counts
    if (!busy()) stopBusy();
    if (!r.ok) {
      st.error = (r.error && r.error.message) || "游戏没有回应";
    } else {
      st.error = "";
      if (r.modules) st.modules = r.modules;
      st.ev = r.evaluation;
      st.loaded = true;
      if (action === "preview" || action === "max") {
        st.seed = r.spec.seed;
        st.slots = r.spec.slots.map((x) => ({ guid: x.guid, rarity: x.rarity, level: x.level, roll: x.roll }));
        st.level = action === "max" ? "max" : null;
      }
    }
    sync();
    notify();
  }

  // changes that arrive in a burst (typing a number, clicking through levels) are sent once
  function schedule(delay = 60) {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; request("evaluate"); }, delay);
    startBusy();
    notify();
  }

  // ---------------------------------------------------------------- the player's changes
  const slotOf = (el) => {
    const row = el.closest(".attr-slot");
    return row ? st.slots[Number(row.dataset.i)] : null;
  };

  function applyField(el, final) {
    const f = el.dataset.f;
    if (f === "blevel") {
      const n = parseInt(el.value, 10);
      if (!Number.isInteger(n)) return false;
      st.level = n;
      return true;
    }
    const x = slotOf(el);
    if (!x) return false;
    if (f === "guid") {
      x.guid = el.value;
      x.roll = "random";
      const m = modOf(x.guid);
      if (m && !m.allowed[x.rarity]) x.rarity = allowedTiers(m).slice(-1)[0] ?? x.rarity; // the highest rarity it comes in
      if (m) x.level = Math.min(x.level, m.maxLevel[x.rarity]);
    } else if (f === "rarity") {
      x.rarity = Number(el.value);
      const m = modOf(x.guid);
      if (m) x.level = Math.min(x.level, m.maxLevel[x.rarity]);
      x.roll = "random";
    } else if (f === "level") {
      const n = parseInt(el.value, 10);
      if (!Number.isInteger(n)) return false; // an empty box while typing: wait for a number
      x.level = n;
    }
    return true;
  }

  root.addEventListener("click", (e) => {
    const tier = e.target.closest("[data-tier]");
    if (tier) {
      st.tier = Number(tier.dataset.tier);
      st.level = null;
      save(tierKey, st.tier);
      sync();
      request("preview");
      return;
    }
    const roll = e.target.closest('button[data-f="roll"]');
    if (roll) {
      const x = slotOf(roll);
      if (x) { x.roll = roll.dataset.v; sync(); schedule(0); }
      return;
    }
    const act = e.target.closest("[data-act]");
    if (!act) return;
    if (act.dataset.act === "reroll") { st.seed = newSeed(); st.level = null; request("preview"); }
    else if (act.dataset.act === "max") request("max");
    else if (act.dataset.act === "levelmax") { st.level = st.level === "max" ? null : "max"; sync(); schedule(0); }
  });
  root.addEventListener("change", (e) => {
    const el = e.target;
    if (!el.dataset || !el.dataset.f) return;
    if (applyField(el, true)) { sync(); schedule(0); }
  });
  root.addEventListener("input", (e) => {
    const el = e.target;
    if (!el.dataset || !(el.dataset.f === "level" || el.dataset.f === "blevel")) return;
    if (applyField(el, false)) schedule(450);
  });

  // ------------------------------------------------------------------- the outside
  const api = {
    // start over with another item: the tier stays, the modules are the game's own for it
    load() {
      st.seed = newSeed();
      st.level = null;
      st.slots = [];
      st.modules = [];
      st.ev = null;
      st.error = "";
      st.loaded = false;
      st.token++; // answers to the previous item are of no interest
      sync();
      notify();
      return request("preview");
    },
    spec: specOf,
    state() {
      return {
        busy: busy(), loaded: st.loaded, ok: ok(), valid: valid(), errors: errorsNow(), evaluation: st.ev,
        tier: st.tier, slotCount: st.slots.length, level: st.ev ? st.ev.level : null,
      };
    },
    // resolves when nothing is being sent or waited for
    settled() { return busy() ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve(); },
    destroy() {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      stopBusy();
      root.replaceChildren();
      root.classList.remove("attr", "attr-ok", "attr-busy");
      waiters.forEach((f) => f());
      waiters = [];
    },
  };
  sync();
  return api;
}

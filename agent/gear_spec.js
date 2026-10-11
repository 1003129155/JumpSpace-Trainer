// The editable part of a blueprint item: the modules ("词条") it carries, each one's rarity, upgrade level and roll, and
// the blueprint's level. This file only knows the rules the game follows (read from its data and checked against items
// it generated and accepted); building the item in the game is done by the adapter in unlocks.js.
//
//  - a module goes into an item once, may only sit at a rarity the item's template allows for it (`allowed`: a school
//    module within its own min..max range; a module from the template's base set at any rarity), and never at a rarity
//    above the item's
//  - a module's upgrade level is 1..maxLevel(module, rarity)
//  - the blueprint level is 1..cap, where cap is the game's own answer for this very item (it depends on the modules),
//    and it has to pay for the module upgrades: sum(upgradeLevel - 1) <= level - 1
//  - a module rolls one value in 0..1 for every tweakable value it has at its rarity; the stat shown is
//    lerp(min, max, roll) + perUpgrade * (upgradeLevel - 1)
import { RARITIES, RARITY_LABEL } from "./blueprint_flow.js";

const label = (r) => RARITY_LABEL[RARITIES[r]] || String(r);

// A small deterministic number source: "random" rolls must come out the same every time the same item is rebuilt
// (the editor previews an item many times before it is made).
export function seededRoll(seed, slot, index) {
  let x = (Math.imul((seed | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(slot + 1, 0xc2b2ae35) ^ Math.imul(index + 7, 0x27d4eb2f)) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 0x2c1b3c6d) >>> 0; x ^= x >>> 12; x = Math.imul(x, 0x297a2d39) >>> 0; x ^= x >>> 15;
  return (x >>> 0) / 4294967296;
}

// The roll values for one slot: a number for all of them, an array, "max", or "random" (seeded).
export function rollsFor(slot, count, seed, index) {
  const r = slot.roll;
  const out = [];
  for (let j = 0; j < count; j++) {
    if (r === "max") out.push(1);
    else if (typeof r === "number") out.push(Math.min(1, Math.max(0, r)));
    else if (Array.isArray(r) && typeof r[j] === "number") out.push(Math.min(1, Math.max(0, r[j])));
    else out.push(seededRoll(seed, index, j));
  }
  return out;
}

// Check a spec against the catalog.
//   spec    { tier, seed, level: "max" | number | undefined, slots: [{ guid, rarity, level?, roll? }] }
//   catalog { slotCount, cap (number, or null when not known yet), modules: Map(guid -> { name, allowed[4], maxLevel[4], rolls[4] }) }
// Returns { errors: [...], slots: normalized, need, level }. Nothing is thrown: the editor shows the messages.
export function checkGear(spec, catalog) {
  const errors = [];
  const tier = Number.isInteger(spec.tier) ? spec.tier : 0;
  const slots = [];
  const seen = new Set();
  const given = Array.isArray(spec.slots) ? spec.slots : [];
  if (catalog.slotCount !== undefined && given.length !== catalog.slotCount) {
    errors.push(`这件${label(tier)}品质装备有 ${catalog.slotCount} 个词条位，现在给了 ${given.length} 个`);
  }
  given.forEach((s, i) => {
    const n = i + 1;
    const mod = catalog.modules.get(s.guid);
    if (!mod) { errors.push(`第 ${n} 个词条：这件装备不能装这个词条`); return; }
    const rarity = Number.isInteger(s.rarity) ? s.rarity : tier;
    if (rarity < 0 || rarity > 3) { errors.push(`第 ${n} 个词条（${mod.name}）：品质不对`); return; }
    if (rarity > tier) errors.push(`第 ${n} 个词条（${mod.name}）：词条品质（${label(rarity)}）不能高于装备品质（${label(tier)}）`);
    if (!mod.allowed[rarity]) {
      const ok = [0, 1, 2, 3].filter((r) => mod.allowed[r]).map(label).join("、");
      errors.push(`第 ${n} 个词条（${mod.name}）：这件装备上只能是 ${ok || "（无）"} 品质，不能是${label(rarity)}`);
    }
    if (seen.has(s.guid)) errors.push(`词条「${mod.name}」重复了`);
    seen.add(s.guid);
    const max = mod.maxLevel[rarity];
    const level = s.level === undefined || s.level === null ? 1 : s.level;
    if (!Number.isInteger(level) || level < 1 || level > max) errors.push(`第 ${n} 个词条（${mod.name}）：等级只能是 1–${max}`);
    const roll = s.roll === undefined || s.roll === null ? "random" : s.roll;
    slots.push({ guid: s.guid, rarity, level: Number.isInteger(level) ? Math.min(Math.max(level, 1), max || 1) : 1, roll, rollCount: mod.rolls[rarity] });
  });

  // the blueprint level has to pay for the module upgrades
  const spent = slots.reduce((sum, s) => sum + (s.level - 1), 0);
  const need = 1 + spent;
  const cap = catalog.cap;
  let level = spec.level === "max" ? (cap === null || cap === undefined ? need : cap) : spec.level;
  if (level === undefined || level === null) level = need;
  if (!Number.isInteger(level) || level < 1) { errors.push("装备等级必须是 1 以上的整数"); level = need; }
  if (level < need) level = need; // a lower level cannot hold those upgrades: raise it instead of refusing
  if (cap !== null && cap !== undefined && level > cap) {
    errors.push(need > cap ? `词条升级合计需要 ${need} 级，超过了这件装备的等级上限 ${cap}` : `装备等级 ${level} 超过了这件装备的上限 ${cap}`);
  }
  return { errors, slots, need, level };
}

// The best rarity a module can have in an item of this tier: the highest one it is allowed at, never above the item's own.
export function bestRarity(mod, tier) {
  for (let r = Math.min(Number.isInteger(tier) ? tier : 0, 3); r >= 0; r--) if (mod.allowed[r]) return r;
  return null;
}

// Give every module its best: the highest rarity it can have here, its best roll, and the blueprint's points (cap - 1)
// spent on upgrades, one level at a time, going round the modules so that they grow evenly. Returns a new spec.
// (A module's level limit depends on its rarity, so the rarity comes first. The cap itself depends on the rarities too:
// see buildMax.)
export function fillMax(spec, catalog) {
  const cap = catalog.cap === null || catalog.cap === undefined ? 1 : catalog.cap;
  const tier = Number.isInteger(spec.tier) ? spec.tier : 0;
  const slots = (spec.slots || []).map((s) => {
    const mod = catalog.modules.get(s.guid);
    const best = mod ? bestRarity(mod, tier) : null;
    return { ...s, rarity: best === null ? s.rarity : best, roll: "max", level: 1 };
  });
  let points = Math.max(0, cap - 1);
  for (let progress = true; points > 0 && progress;) {
    progress = false;
    for (const s of slots) {
      if (points <= 0) break;
      const mod = catalog.modules.get(s.guid);
      if (!mod) continue;
      const rarity = Number.isInteger(s.rarity) ? s.rarity : tier;
      if (s.level < mod.maxLevel[rarity]) { s.level++; points--; progress = true; }
    }
  }
  return { ...spec, slots, level: "max" };
}

// "Everything at its best" for an item that has been built once (`built` = what `build(spec)` returned for the spec as
// the player has it: { spec, catalog, evaluation: { cap } }). The game decides the level cap from the modules' rarities,
// and filling raises those: so fill, let the game build it, and fill again when the cap came out different.
export function buildMax(build, built) {
  const fill = (cap) => build(fillMax(built.spec, { cap, modules: built.catalog }));
  let best = fill(built.evaluation.cap);
  const cap = best.evaluation.cap;
  if (cap !== null && cap !== undefined && cap !== built.evaluation.cap) best = fill(cap);
  return best;
}

// The plain-text form of the game's rich description ("+<b><color=#F28CFF>13%</color></b> 伤害")
export function plainText(text) {
  return String(text || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

// The game's rich text as safe HTML for the editor: only bold and coloured runs survive, everything else is dropped and
// all text is escaped. ("+<b><color=#F28CFF>13%</color></b> 伤害" -> '+<b><span style="color:#F28CFF">13%</span></b> 伤害')
export function richToHtml(text) {
  const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  text = String(text || "");
  let out = "";
  let last = 0;
  const open = []; // the tags that are open, so that every closing tag we write has an opening one and nothing is left open
  const re = /<(\/?)(b|color)(?:=#([0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?))?>|<[^>]*>/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out += esc(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (!m[2]) continue; // some other tag (sprites, sizes ...): dropped
    const name = m[2] === "b" ? "b" : "span";
    if (!m[1]) {
      if (name === "span" && !m[3]) continue; // a colour tag without a valid colour
      open.push(name);
      out += name === "b" ? "<b>" : `<span style="color:#${m[3].slice(0, 6)}">`;
    } else if (open[open.length - 1] === name) {
      open.pop();
      out += `</${name}>`;
    }
  }
  out += esc(text.slice(last));
  while (open.length) out += `</${open.pop()}>`;
  return out;
}

// The rules for editing a blueprint item's modules ("词条") and level, without a game.
import assert from "node:assert/strict";
import { test } from "node:test";

import { seededRoll, rollsFor, checkGear, fillMax, buildMax, bestRarity, plainText, richToHtml } from "../agent/gear_spec.js";

// three modules: a basic one for every rarity, a rare+ one, and a legendary-only one
const catalog = (over = {}) => ({
  slotCount: 3,
  cap: 10,
  modules: new Map([
    ["dmg", { name: "提升伤害", allowed: [true, true, true, true], maxLevel: [4, 4, 5, 5], rolls: [1, 1, 1, 1] }],
    ["crit", { name: "自适应弹药", allowed: [false, true, true, true], maxLevel: [0, 4, 3, 2], rolls: [0, 1, 1, 1] }],
    ["chaos", { name: "混沌理论", allowed: [false, false, false, true], maxLevel: [0, 0, 0, 3], rolls: [0, 0, 0, 1] }],
    // a base-set module: the template does not bind it to a rarity range
    ["cap", { name: "容量放大器", allowed: [true, true, true, true], maxLevel: [3, 3, 3, 3], rolls: [1, 1, 1, 1] }],
    // a school module whose range stops at epic
    ["sling", { name: "弹弓", allowed: [true, true, true, false], maxLevel: [2, 2, 3, 0], rolls: [1, 1, 1, 0] }],
  ]),
  ...over,
});
const epic = (slots, extra = {}) => ({ tier: 2, seed: 7, slots, ...extra });

test("seeded rolls are repeatable and spread over 0..1", () => {
  assert.equal(seededRoll(5, 0, 0), seededRoll(5, 0, 0));
  assert.notEqual(seededRoll(5, 0, 0), seededRoll(6, 0, 0));
  assert.notEqual(seededRoll(5, 0, 0), seededRoll(5, 1, 0));
  assert.notEqual(seededRoll(5, 0, 0), seededRoll(5, 0, 1));
  const xs = Array.from({ length: 400 }, (_, i) => seededRoll(1, i, 0));
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  assert.ok(mean > 0.4 && mean < 0.6, `mean ${mean}`);
});

test("roll choices: best, a number, a list, or the seeded random ones", () => {
  assert.deepEqual(rollsFor({ roll: "max" }, 3, 1, 0), [1, 1, 1]);
  assert.deepEqual(rollsFor({ roll: 0.25 }, 2, 1, 0), [0.25, 0.25]);
  assert.deepEqual(rollsFor({ roll: 7 }, 2, 1, 0), [1, 1]); // clamped
  assert.deepEqual(rollsFor({ roll: [0.1, 0.9] }, 2, 1, 0), [0.1, 0.9]);
  assert.deepEqual(rollsFor({ roll: "random" }, 2, 3, 4), rollsFor({}, 2, 3, 4));
  assert.deepEqual(rollsFor({ roll: "max" }, 0, 1, 0), []);
});

test("a valid spec comes back normalized with just enough level for its upgrades", () => {
  const r = checkGear(epic([{ guid: "dmg", rarity: 2, level: 3 }, { guid: "crit", rarity: 1, level: 2 }]), catalog({ slotCount: 2 }));
  assert.deepEqual(r.errors, []);
  assert.equal(r.need, 1 + 2 + 1);
  assert.equal(r.level, 4); // no level asked for: exactly what the upgrades need
  assert.deepEqual(r.slots.map((s) => [s.guid, s.rarity, s.level, s.roll, s.rollCount]), [["dmg", 2, 3, "random", 1], ["crit", 1, 2, "random", 1]]);
});

test("modules the item cannot carry, or at a rarity they do not come in, are refused with the reason", () => {
  const msgs = (slots, over) => checkGear(epic(slots), catalog({ slotCount: slots.length, ...over })).errors.join("|");
  assert.match(msgs([{ guid: "nope", rarity: 0 }]), /第 1 个词条.*不能装/);
  assert.match(msgs([{ guid: "crit", rarity: 0 }]), /自适应弹药.*只能是 稀有、史诗、传说 品质，不能是普通/); // below its range
  assert.match(msgs([{ guid: "chaos", rarity: 2 }]), /混沌理论.*只能是 传说 品质/); // legendary only
  assert.deepEqual(checkGear({ tier: 3, slots: [{ guid: "cap", rarity: 3 }] }, catalog({ slotCount: 1 })).errors, []); // a base-set module at any rarity
  assert.match(msgs([{ guid: "dmg", rarity: 3 }]), /不能高于装备品质/); // above the item's own tier
  assert.match(msgs([{ guid: "dmg", rarity: 0 }, { guid: "dmg", rarity: 1 }]), /提升伤害.*重复/);
});

test("module levels stay within what the module allows at its rarity", () => {
  const e = (level) => checkGear(epic([{ guid: "crit", rarity: 2, level }]), catalog({ slotCount: 1 })).errors.join("|");
  assert.equal(e(3), ""); // epic crit: 3
  assert.match(e(4), /等级只能是 1–3/);
  assert.match(e(0), /等级只能是 1–3/);
  assert.match(e(1.5), /等级只能是 1–3/);
});

test("the blueprint level is raised to pay for upgrades and never above the game's cap", () => {
  const slots = [{ guid: "dmg", rarity: 2, level: 5 }, { guid: "crit", rarity: 2, level: 3 }];
  const c = catalog({ slotCount: 2 });
  assert.equal(checkGear(epic(slots, { level: 2 }), c).level, 1 + 4 + 2); // 2 is too low for those upgrades: raised to 7
  assert.equal(checkGear(epic(slots, { level: 9 }), c).level, 9); // spare points are allowed
  assert.equal(checkGear(epic(slots, { level: "max" }), c).level, 10);
  assert.match(checkGear(epic(slots, { level: 11 }), c).errors.join("|"), /超过了这件装备的上限 10/);
  const small = catalog({ slotCount: 2, cap: 5 });
  assert.match(checkGear(epic(slots), small).errors.join("|"), /词条升级合计需要 7 级，超过了这件装备的等级上限 5/);
  // the cap is unknown until the modules are in the item: no complaint, "max" means just enough
  const unknown = catalog({ slotCount: 2, cap: null });
  assert.deepEqual(checkGear(epic(slots, { level: "max" }), unknown).errors, []);
  assert.equal(checkGear(epic(slots, { level: "max" }), unknown).level, 7);
});

test("the number of module slots is the game's, not the player's", () => {
  const r = checkGear(epic([{ guid: "dmg", rarity: 2 }]), catalog({ slotCount: 4 }));
  assert.match(r.errors.join("|"), /有 4 个词条位，现在给了 1 个/);
  assert.match(checkGear({ tier: 0, slots: [] }, catalog({ slotCount: 0 })).errors.join("|"), /^$/); // a sensor has none
});

test("filling to the maximum spends the cap's points evenly, within each module's own limit", () => {
  const c = catalog({ slotCount: 2, cap: 7 });
  const full = fillMax(epic([{ guid: "dmg", rarity: 2 }, { guid: "crit", rarity: 2 }]), c);
  assert.equal(full.level, "max");
  assert.ok(full.slots.every((s) => s.roll === "max"));
  // 6 points, one at a time round the modules: crit (epic max 3) stops after 2, so dmg (epic max 5) gets the other 4
  assert.deepEqual(full.slots.map((s) => s.level), [5, 3]);
  const checked = checkGear(full, c);
  assert.deepEqual(checked.errors, []);
  assert.equal(checked.level, 7);
});

test("filling stops at a smaller cap", () => {
  const c = catalog({ slotCount: 2, cap: 4 });
  const full = fillMax(epic([{ guid: "dmg", rarity: 2 }, { guid: "crit", rarity: 2 }]), c);
  assert.deepEqual(full.slots.map((s) => s.level), [3, 2]); // 3 points: 2 + 1, evenly
  assert.deepEqual(checkGear(full, c).errors, []);
});

test("filling leaves points over when the modules cannot take them", () => {
  const full = fillMax(epic([{ guid: "crit", rarity: 2 }]), catalog({ slotCount: 1, cap: 10 }));
  assert.equal(full.slots[0].level, 3); // that module's maximum
  assert.equal(checkGear(full, catalog({ slotCount: 1, cap: 10 })).level, 10); // the item still gets its full level
});

test("the best rarity of a module is the highest it is allowed at, never above the item's tier", () => {
  const c = catalog();
  const mod = (guid) => c.modules.get(guid);
  assert.equal(bestRarity(mod("dmg"), 3), 3);
  assert.equal(bestRarity(mod("dmg"), 1), 1);
  assert.equal(bestRarity(mod("sling"), 3), 2); // its own range ends at epic
  assert.equal(bestRarity(mod("crit"), 0), null); // not available at all on a common item
  assert.equal(bestRarity(mod("chaos"), 2), null);
  assert.equal(bestRarity(mod("chaos"), 3), 3);
});

test("filling lifts every module to its best rarity first, because its level limit depends on that", () => {
  const c = catalog({ slotCount: 3, cap: 12 });
  const full = fillMax({ tier: 3, seed: 1, slots: [{ guid: "dmg", rarity: 0 }, { guid: "sling", rarity: 1 }, { guid: "crit", rarity: 1 }] }, c);
  assert.deepEqual(full.slots.map((s) => s.rarity), [3, 2, 3]); // sling cannot go beyond epic
  assert.deepEqual(full.slots.map((s) => s.level), [5, 3, 2]); // limits at those rarities: dmg 5, sling 3, crit 2 (not the 4 / 2 / 4 it had)
  assert.deepEqual(checkGear(full, c).errors, []);
  // a module the catalog does not know is left as it is (the check reports it)
  const odd = fillMax({ tier: 2, slots: [{ guid: "ghost", rarity: 1 }] }, catalog({ slotCount: 1 }));
  assert.equal(odd.slots[0].rarity, 1);
});

test("the cap depends on the rarities, so filling asks the game again and fills with its answer", () => {
  // a stand-in for the game: the item's cap is 4 + the sum of the modules' rarities
  const modules = catalog({ slotCount: 2 }).modules;
  const asked = [];
  const build = (spec) => {
    const cap = 4 + spec.slots.reduce((sum, s) => sum + s.rarity, 0);
    asked.push(cap);
    const checked = checkGear(spec, { slotCount: 2, cap, modules });
    return { errors: checked.errors, spec, catalog: modules, evaluation: { cap, level: checked.level, need: checked.need, errors: checked.errors } };
  };
  const first = build({ tier: 3, seed: 1, slots: [{ guid: "dmg", rarity: 0 }, { guid: "cap", rarity: 0 }] }); // cap 4
  asked.length = 0;
  const best = buildMax(build, first);
  assert.deepEqual(best.errors, []);
  assert.equal(best.evaluation.cap, 10); // both lifted to legendary
  assert.equal(best.evaluation.level, 10); // the new cap, not the old 4
  assert.deepEqual(best.spec.slots.map((s) => [s.rarity, s.level]), [[3, 5], [3, 3]]); // 9 points: dmg takes 4, cap its 2 (limit 3)
  assert.equal(asked.length, 2); // once with the old cap, once with the cap the game gave for the result

  // when the cap does not move there is nothing to redo
  asked.length = 0;
  const flat = build({ tier: 3, seed: 1, slots: [{ guid: "dmg", rarity: 3 }, { guid: "cap", rarity: 3 }] });
  asked.length = 0;
  buildMax(build, flat);
  assert.equal(asked.length, 1);
});

test("the game's rich text becomes plain text", () => {
  assert.equal(plainText('+<b><color=#F28CFF>13%</color></b> 伤害'), "+13% 伤害");
  assert.equal(plainText('命中时有 <b>11%</b> 概率施加 <sprite name="corrosion"><b>腐蚀</b>'), "命中时有 11% 概率施加 腐蚀");
  assert.equal(plainText(undefined), "");
});

test("rich text turns into safe HTML: bold and colour stay, anything else goes", () => {
  assert.equal(richToHtml("+<b><color=#F28CFF>13%</color></b> 伤害"), '+<b><span style="color:#F28CFF">13%</span></b> 伤害');
  assert.equal(richToHtml('施加 <sprite name="corrosion"><b>腐蚀</b>，造成 <size=12>3</size>'), "施加 <b>腐蚀</b>，造成 3");
  assert.equal(richToHtml("<script>alert(1)</script> a & b"), "alert(1) a &amp; b"); // tags dropped, the rest escaped
  assert.equal(richToHtml("a < b"), "a &lt; b"); // a lone bracket is just text
  assert.equal(richToHtml('<color=#12">x</color>'), "x"); // a colour that is not hex never reaches the style attribute
  assert.equal(richToHtml(undefined), "");
});

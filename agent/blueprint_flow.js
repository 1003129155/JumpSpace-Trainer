// A blueprint is a concrete item (a weapon or ship part with a tier, modules and a level) kept in the profile. The
// crafting machine lists the blueprints saved in the blueprint slots, and crafts the item with exactly the attributes the
// blueprint has. The game keeps a blueprint in two steps, the same ones it takes when the player scans something it found:
//   1. the item is recorded in the *discovery history* (the game only keeps blueprints of things it "found"; the in-game
//      scan screen and the trainer's "我的蓝图" tab list what waits there)
//   2. the item is saved into a free blueprint slot (and drops out of the history)
// Either both steps run (`save: true`) or only the first (`save: false`), leaving step 2 to the player.
// A blueprint does not depend on the recipe being unlocked, and a model may have as many blueprints as there are slots,
// so every request makes a new item: nothing "already there" stands in for it.
// `game` is a thin adapter over the real game objects (built in gear.js); nothing here touches the game directly,
// which keeps the decisions testable without one.

export const RARITIES = ["Common", "Rare", "Epic", "Legendary"];
export const RARITY_LABEL = { Common: "普通", Rare: "稀有", Epic: "史诗", Legendary: "传说" };

// a tier given as 0..3, "0".."3" or a name -> 0..3 (null when it is none of those)
export function rarityIndex(value) {
  if (value === undefined || value === null || value === "") return 0;
  const n = typeof value === "number" ? value : /^\d+$/.test(String(value)) ? Number(value) : RARITIES.indexOf(String(value));
  return Number.isInteger(n) && n >= 0 && n < RARITIES.length ? n : null;
}

export const STATUS = {
  SAVED: "saved",         // a blueprint is now in a slot
  FOUND: "found",         // an item was added to the discovery history, waiting to be saved as a blueprint
  NO_SLOT: "noSlot",      // every blueprint slot of the category is taken
  NO_ITEM: "noItem",      // the game's item generator produced nothing for this model
  REJECTED: "rejected",   // the game refuses to keep a blueprint of this item
  UNCONFIRMED: "unconfirmed", // the game said yes but reading it back does not show the item
  INVALID: "invalid",     // attributes that break the game's rules for modules / levels (nothing was made)
};

// the outcomes that leave nothing for the player to sort out
export const SETTLED = new Set([STATUS.SAVED, STATUS.FOUND]);

// Make a blueprint of `entity` ({ targetGuid, template, categoryGuid, ... }) with the attributes of `spec`
// ({ tier, seed, level, slots: [...] }, see gear_spec.js; without slots the generator's own modules are kept).
export function makeBlueprint(game, entity, { save = false, spec = {} } = {}) {
  let slots = null;
  if (save) {
    slots = game.slots(entity.categoryGuid);
    if (slots.free === null) return { status: STATUS.NO_SLOT, used: slots.used, total: slots.total };
  }
  let added = null; // the item this call put into the history; taken back if the rest fails
  try {
    const built = game.buildGear(entity, spec);
    if (!built) return { status: STATUS.NO_ITEM };
    if (built.errors.length) return { status: STATUS.INVALID, errors: built.errors };
    const item = built.item;
    const guid = game.guidOf(item);
    game.recordFound(item, entity.categoryGuid);
    added = item;
    if (!game.historyHas(guid)) return { status: STATUS.UNCONFIRMED }; // the game did not keep it
    // read what is needed now: after saving, a history item may no longer be valid memory
    const info = game.describe(item);
    if (!save) return { status: STATUS.FOUND, instanceGuid: guid, level: info.level, rarity: info.rarity };

    if (!game.canSave(item)) {
      game.forget(added);
      return { status: STATUS.REJECTED };
    }
    const accepted = game.saveInSlot(item, entity.categoryGuid, slots.free);
    const holder = game.inSlot(entity.categoryGuid, slots.free);
    if (!accepted || !holder || holder.guid !== guid) {
      game.forget(added);
      return { status: STATUS.UNCONFIRMED };
    }
    return { status: STATUS.SAVED, slot: slots.free, instanceGuid: guid, level: info.level, rarity: info.rarity, used: slots.used + 1, total: slots.total };
  } finally {
    game.release();
  }
}

// Undo for what this tool put in: `made` is [{guid, where: "slot"|"history", level, rarity}]. A blueprint the player has
// since upgraded, or an item that is no longer where it was put, is left alone.
export function removeMade(game, made) {
  const results = [];
  for (const m of made) {
    if (m.where === "history") {
      const entry = game.historyEntry(m.guid);
      if (!entry) {
        results.push({ guid: m.guid, where: "history", removed: false, reason: "gone" }); // saved as a blueprint meanwhile, or pushed out
        continue;
      }
      const ok = game.forget(entry.item);
      results.push({ guid: m.guid, where: "history", removed: !!ok && !game.historyHas(m.guid), reason: ok ? null : "refused" });
      continue;
    }
    const found = game.blueprintByGuid(m.guid);
    if (!found) {
      results.push({ guid: m.guid, where: "slot", removed: false, reason: "gone" });
    } else if (m.level !== undefined && (found.level !== m.level || found.rarity !== m.rarity)) {
      results.push({ guid: m.guid, where: "slot", removed: false, reason: "changed" });
    } else {
      const ok = game.removeBlueprint(found.handle);
      results.push({ guid: m.guid, where: "slot", removed: !!ok && !game.blueprintByGuid(m.guid), reason: ok ? null : "refused" });
    }
  }
  return results;
}

// What the player is told (Chinese, shown in the UI and in toasts)
export function blueprintMessage(result, entity) {
  const name = entity.display || entity.name || "";
  const grade = `${RARITY_LABEL[result.rarity] || result.rarity || ""}品质 · ${result.level} 级`;
  switch (result.status) {
    case STATUS.SAVED: return `已存入「${entity.category}」蓝图槽 ${result.slot + 1}（${result.used}/${result.total}）：${name}（${grade}），现在可以在制作台制作`;
    case STATUS.FOUND: return `已加入发现历史：${name}（${grade}），在“我的蓝图”页（或游戏里的扫描台）保存为蓝图后即可制作`;
    case STATUS.NO_SLOT: return `「${entity.category}」的蓝图槽已满（${result.used}/${result.total}），请先在游戏里清出一个槽位，或者先加入发现历史`;
    case STATUS.NO_ITEM: return `游戏没能为「${name}」生成装备，无法生成蓝图`;
    case STATUS.REJECTED: return `游戏不允许保存「${name}」的蓝图`;
    case STATUS.INVALID: return `「${name}」的属性不符合游戏规则：${(result.errors || []).join("；")}`;
    case STATUS.UNCONFIRMED: return `「${name}」没有在游戏里读回确认，请到游戏里检查`;
    default: return "";
  }
}

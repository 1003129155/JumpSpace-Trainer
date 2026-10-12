import { esc, icon } from "../ui.js";
import { S, connection } from "../store.js";

// Shown instead of a page body while the game / session is not available.
// `profileOnly` pages (currency, recipes, ships) work from the main menu too:
// they only need the save to be loaded, not a level.
export function notReady(what = "此功能", profileOnly = false) {
  const c = connection();
  let title = c.title;
  let hint;
  if (c.kind === "bad") hint = "修改器后台没有响应。请关闭本窗口，重新运行“启动修改器”。";
  else if (S.bridge && S.bridge.starting) hint = "游戏刚启动，引擎初始化完成后会自动连接，请稍等几秒。";
  else if (S.bridge && !S.bridge.attached) hint = "请先启动 Jump Space，修改器检测到游戏后会自动连接，无需手动操作。";
  else if (profileOnly) { title = "等待存档加载"; hint = `存档还没有加载完成（游戏可能还停在标题画面或正在读取）。进入大厅或飞船后即可使用${what}。`; }
  else hint = `请进入游戏的大厅或飞船后再使用${what}。`;
  return `<div class="empty">${icon("power")}<h3>${esc(title)}</h3><p>${esc(hint)}</p></div>`;
}

export const GROUP_COLOR = {
  weapon: "#ff7a6b", melee: "#ffa64d", throwable: "#ffd34d", consumable: "#4de3a0", gadget: "#55c7ff",
  shipSupply: "#7fa0ff", resource: "#b79bff", artifact: "#ff7ad9", component: "#5be1d5", novelty: "#f6a6c9", internal: "#6c7a99",
};

export const SLOT_LABEL = { Weapon: "武器栏", Utility: "工具栏", Backpack: "背包", Heavy: "重物" };

// What each operation looks like in the history lists (the old method names stay: the log keeps entries of earlier versions)
export const METHOD_ICON = {
  setCurrency: "coins", addCurrency: "coins", setMateria: "gem", addExperience: "star", levelUp: "star",
  spawn: "box", equipHand: "hand", unlockRecipes: "blueprint", lockRecipes: "lock", unlockShips: "rocket",
  makeBlueprint: "blueprint", customBlueprint: "blueprint", recipeBlueprints: "blueprint", saveRecipeBlueprints: "blueprint",
  removeRecipeBlueprints: "blueprint", addBlueprint: "blueprint", setCheat: "bolt", undo: "undo",
  jumpToNode: "map", completeMission: "flag", repairShip: "wrench",
};

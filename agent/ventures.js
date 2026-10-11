// Ventures (委托): the game's quests and their rewards. `ventures` lists the ones the game shows in its venture log;
// `completeVenture` completes one the way the game does when its progress is reached (MetaProgressionManager.
// SetVentureCompleted): it unlocks the rewards (a ship design upgrades or adds the ship), adds the experience, credits and
// ingots, unlocks the venture's Steam achievement and saves. There is no undo: the experience cannot be taken back.

// the kinds of main reward (VentureRewardType), as the UI groups them
export const KINDS = {
  ProgressionMain: "main", ProgressionSecondary: "side", LevelUp: "level", PlayerShipBlueprint: "ship",
  Region: "region", Blueprint: "blueprint", Component: "component", NpcIntro: "npc",
};
// the kinds of the assets a venture unlocks
export const REWARD_KINDS = {
  "Keepsake.Modifiers.Traits.PlayerTraitScriptable": "trait",
  "Keepsake.CharacterWardrobeHelmetPreset": "helmet",
  "Keepsake.CharacterCustomization.CharacterWardrobeSetPreset": "outfit",
  "Keepsake.GameplayFeatures.GalaxyMap.GalaxyMapRegionData": "region",
  "Keepsake.SpaceshipBlueprint": "ship",
};
const STATE_ORDER = { ready: 0, active: 1, idle: 2, completed: 3 };
const KIND_ORDER = ["main", "ship", "side", "level", "region", "blueprint", "component", "npc"];

export function installVentures(JB, ex) {
  const { U, onMain, safe, bridgeError, rpcSafe } = JB;
  const MPM = () => U.cls("Keepsake.MetaProgression.MetaProgressionManager");
  const VM = () => U.cls("Keepsake.MetaProgression.VentureManager");
  const rewardNames = new Map(); // asset GUID -> { kind, name }; reward assets do not change while the game runs

  const text = (s) => (s && !s.isNull() ? s.content || "" : "");
  const guidOf = (v) => safe(() => text(v.method("get_AssetGUID").invoke()), "");
  const flag = (v, name) => !!safe(() => v.method(name).invoke(), false);

  function requireProfile() {
    if (!safe(() => MPM().method("get_InitialDataSuccessfullyLoaded").invoke(), false)) {
      throw bridgeError("PROFILE_NOT_READY", "本机存档尚未加载完成，请先进入游戏（大厅或飞船内）再试");
    }
  }

  // the venture instances of the local profile (the game makes one per venture when it loads the profile)
  function instances() {
    const list = VM().method("GetAllVentures").invoke();
    return list.isNull() ? [] : JB.managedRows(list, (v) => v);
  }
  // what the game's venture log shows: hidden ventures are the game's own bookkeeping (NPC introductions, achievements)
  const visible = (v) => !v.field("m_Hidden").value && !v.field("m_HiddenInVentureLog").value;

  function unlockGuids(v) {
    const unlocks = v.field("m_Unlocks").value;
    if (unlocks.isNull()) return [];
    return JB.managedRows(unlocks, (ref) => safe(() => text(ref.method("get_AssetGUID").invoke()), "")).filter(Boolean);
  }

  function stateOf(v) {
    if (flag(v, "get_IsCompleted")) return "completed";
    if (flag(v, "get_IsReadyToComplete")) return "ready";
    return flag(v, "get_IsActive") ? "active" : "idle";
  }

  function describe(v) {
    const state = stateOf(v);
    return {
      key: guidOf(v),
      name: safe(() => text(v.method("get_DisplayName").invoke()), "") || U.name(v).replace(/\(Clone\)$/, ""),
      description: safe(() => text(v.method("get_Description").invoke()), ""),
      kind: KINDS[String(v.field("m_MainRewardType").value)] || "other",
      state,
      // an idle venture whose prerequisites (an earlier venture, an unlock) are not met yet
      prerequisitesMet: state !== "idle" || flag(v, "ActivationPrerequisitesMet"),
      inSeason: safe(() => v.method("get_IsInSeason").invoke(), true),
      secret: !!v.field("m_HideUntilCompleted").value,
      achievement: !v.field("m_Achievement").value.isNull(),
      experience: v.field("m_ExperienceReward").value,
      credits: v.field("m_CreditsReward").value,
      ingots: v.field("m_IngotsReward").value,
      unlocks: unlockGuids(v).map((guid) => ({ guid, ...(rewardNames.get(guid) || { kind: "other", name: "" }) })),
    };
  }

  function displayNameOf(asset, cls) {
    if (cls === "Keepsake.SpaceshipBlueprint") {
      const mark = safe(() => asset.field("m_Mark").value, 0);
      const name = safe(() => text(asset.method("get_BlueprintName").invoke()), "").trim();
      return name && mark >= 1 ? `${name} Mk.${mark}` : name;
    }
    return safe(() => text(asset.method("get_DisplayName").invoke()), "").trim();
  }

  // the Chinese names of what the ventures unlock: the assets are loaded (once) to ask them
  async function resolveRewards(guids) {
    const missing = [...new Set(guids)].filter((g) => !rewardNames.has(g));
    if (!missing.length) return;
    const located = await onMain(() => missing.map((guid) => ({ guid, at: JB.locateAsset(guid) })));
    await Promise.all(located.map(async ({ guid, at }) => {
      if (!at) { rewardNames.set(guid, { kind: "other", name: "" }); return; }
      let name = "";
      try {
        const asset = await JB.loadCatalogAsset({ key: guid, cls: at.cls, name: at.name });
        if (asset) name = await onMain(() => displayNameOf(asset, at.cls));
      } catch (e) { /* the file name stands in for an asset that does not load */ }
      rewardNames.set(guid, { kind: REWARD_KINDS[at.cls] || "other", name: name || at.name });
    }));
  }

  const order = (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]
    || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name, "zh");

  Object.assign(ex, {
    // the ventures of the venture log, with their state and rewards
    ventures: rpcSafe(async () => {
      const guids = await onMain(() => {
        requireProfile();
        return instances().filter(visible).flatMap(unlockGuids);
      });
      await resolveRewards(guids);
      return onMain(() => {
        requireProfile();
        const list = instances().filter(visible).map(describe).sort(order);
        return { ventures: list, hidden: instances().length - list.length };
      });
    }),

    // complete one venture now and receive its rewards
    completeVenture: rpcSafe(async (key) => {
      const k = String(key || "");
      if (!k) throw bridgeError("VENTURE_REQUIRED", "请选择一个委托");
      const step = await onMain(() => {
        requireProfile();
        const v = instances().find((x) => guidOf(x) === k);
        if (!v) throw bridgeError("VENTURE_NOT_FOUND", "没有找到这个委托，请刷新列表");
        if (!visible(v)) throw bridgeError("VENTURE_HIDDEN", "这是游戏内部使用的隐藏委托，不能直接完成");
        const row = describe(v);
        if (row.state === "completed") return { row, before: true };
        MPM().method("SetVentureCompleted").invoke(v, true);
        return { row, before: false };
      });
      if (step.before) return { venture: step.row, changed: false };
      // the game records some completions a few frames later (the unlock of a ship design runs asynchronously)
      const done = () => JB.managedRows(MPM().method("get_CompletedVentures").invoke(), guidOf).includes(k)
        || instances().some((x) => guidOf(x) === k && flag(x, "get_IsCompleted"));
      for (let i = 0; i < 40; i++) {
        if (await onMain(done)) return { venture: { ...step.row, state: "completed" }, changed: true };
        await JB.delay(100);
      }
      throw bridgeError("VENTURE_UNCONFIRMED", "游戏没有把这个委托记为已完成，请在游戏里检查");
    }),
  });
}

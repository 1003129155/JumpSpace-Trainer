// Item list for the UI: the spawnable catalog plus a stable grouping and
// "is this really translated" flags, and lazily fetched descriptions.
export function installItems(JB, ex) {
  const { U, onMain, safe, rpcSafe } = JB;

  const GROUPS = {
    weapon: "枪械",
    melee: "近战武器",
    throwable: "投掷物",
    consumable: "消耗品",
    gadget: "战术装备",
    shipSupply: "飞船补给",
    resource: "资源 / 战利品",
    artifact: "神器 / 特殊",
    component: "飞船部件",
    novelty: "趣味物品",
    internal: "内部 / 未完成",
  };

  const GUN_CARRY = new Set(["pistol", "smg", "railgun", "rpg", "assaultrifle", "shotgun", "marksmanrifle", "lmg", "hmg", "pdw", "semirifle", "materiarevolver", "mininglaser"]);
  const MELEE_CARRY = new Set(["crowbar", "wrench", "chainblade", "atiranblackbelt"]);

  // Asset names whose carry type would classify them wrongly.
  const NAME_GROUP = {
    Pickupable_Mop: "novelty", Pickupable_Gnome: "novelty", Pickupable_Pumpkin: "novelty", Pickupable_ChristmasPresent: "novelty",
    Pickupable_PigeonShooter: "novelty", Pickupable_Boombox: "novelty", Pickupable_ItemTeleporter: "novelty",
    Pickupable_AmmoBox: "gadget", Pickupable_DeployableAttackBuff: "gadget", Pickupable_DeployableShield: "gadget", Pickupable_DeployableGun: "gadget",
    Pickupable_FireExtinguisher: "gadget", Pickupable_HullRepairKit: "gadget", Pickupable_MediMate: "gadget",
    Pickupable_ShipAmmoPack: "shipSupply", Pickupable_ShipAmmunition_Common: "shipSupply", Pickupable_ReactiveArmor: "shipSupply",
    Pickupable_CoreRepairKit_Large: "shipSupply", Pickupable_CoreRepairKit_Small: "shipSupply", Pickupable_CoreRepairKit_Small_3x: "shipSupply",
    Pickupable_Battery: "shipSupply", Pickupable_ShipCore: "shipSupply",
    Pickupable_Artifact: "artifact", Pickupable_Book_TelmariLegacy: "artifact", Pickupable_GalaxyChart: "artifact", Pickupable_GuideStone_Planet: "artifact",
    Pickupable_KeyCard: "artifact", Pickupable_DartUnlockPickupable: "artifact", Pickupable_HammerheadUnlockPickupable: "artifact",
    Pickupable_LostComponent: "artifact", Pickupable_LostComponent_Broken: "artifact", Pickupable_LostComponent_Broken_Explosive: "artifact",
    Pickupable_LostComponent_Broken_Radioactive: "artifact",
    Pickupable_Component: "component", Pickupable_Component_AUX: "component", Pickupable_Component_Broken: "component", Pickupable_Component_RailGun: "component",
    Pickupable_GenericWeapon: "internal", Pickupable_Simple: "internal", Pickupable_Component_HeavyCannon: "internal",
    Pickupable_ShipAmmunition_Tutorial: "internal", Pickupable_Battery_Contamination: "internal", Pickupable_MateriaContainer_WithTutorialIcon: "internal",
  };

  function translated(display) {
    const s = String(display || "").trim();
    return !!s && s !== "UNNAMED" && !s.startsWith("Missing loc");
  }

  function groupOf(item, isGear) {
    if (NAME_GROUP[item.name]) return NAME_GROUP[item.name];
    if (!translated(item.display)) return "internal";
    if (item.category === "cargo") return item.name.startsWith("Component_") ? "component" : "resource";
    const carry = String(item.carry || "");
    if (GUN_CARRY.has(carry) || carry === "33") return "weapon";
    if (MELEE_CARRY.has(carry)) return "melee";
    if (carry === "grenade") return "throwable";
    if (carry === "stim" || carry === "pizza" || carry === "bottle") return "consumable";
    // A carry type not listed above (e.g. added by a game update): a pickup with attributes is a weapon.
    if (isGear) return item.name.startsWith("MeleeWeapon_") ? "melee" : "weapon";
    return "resource";
  }

  // `gear`: the item carries attributes (tier, modules, level) that can be chosen when it is created
  function enrich(item, gear = new Set()) {
    const ok = translated(item.display);
    const isGear = !!item.guid && gear.has(item.guid);
    const group = groupOf(item, isGear);
    return {
      ...item,
      gear: isGear,
      display: ok ? item.display : (item.display && item.display !== "UNNAMED" ? item.display : item.name),
      translated: ok,
      group,
      groupLabel: GROUPS[group],
      hidden: group === "internal",
    };
  }

  // Like equipHand, for an item that is to carry attributes (see gear.js): the pickup is created, given its attributes
  // and only then handed to the player, so the game never sees it without them.
  async function equipWithAttributes(name, spec) {
    const room = (p, it) => {
      const rec = JB.playerRecord(p);
      if (!rec || rec.downed) throw JB.bridgeError("PLAYER_DOWNED", "角色已倒地或死亡，无法装备");
      const bb = p.field("m_InventoryBlackboardData").value;
      const slot = it.d.field("m_SlotType").value.field("value__").value;
      if (!bb.method("HasRoomForItem").invoke(slot, it.d)) {
        throw JB.bridgeError("SLOT_FULL", "这件物品对应的栏位已满，请先丢弃一件，或选择“刷进背包 / 刷到地上”");
      }
    };
    const plan = await onMain(() => {
      if (!JB.gearAttachment) throw JB.bridgeError("GEAR_UNAVAILABLE", "游戏里运行的修改器脚本太旧，不支持自定义属性，请重启游戏");
      const it = JB.resolveItem(name);
      if (it.category === "cargo") throw JB.bridgeError("ITEM_INCOMPATIBLE", "飞船部件不能装备到手上，请选择“刷到地上”");
      room(JB.requireLocalPlayer(), it);
      const gear = JB.gearAttachment(it, spec);
      return { it, name: it.name, display: it.display, gear, summary: gear.check() };
    });
    let created = null;
    let started = false;
    try {
      await JB.consumeTask(
        (token) => U.cls("Keepsake.PickupablesHandler").method("InstantiatePersistentPickupableFromItemData_Async", 2).invoke(plan.it.d, token),
        (item) => {
          if (item.isNull()) throw JB.bridgeError("SPAWN_FAILED", "游戏未创建道具");
          created = JB.rootObject(item);
          const p = JB.requireLocalPlayer();
          room(p, plan.it); // again: the slot may have been filled while the item was loading
          plan.gear.apply(item);
          started = true;
          p.field("m_ItemHandler").value.method("Server_PickupItem").invoke(item, -1, -1, true);
        });
      const deadline = Date.now() + 8000;
      for (;;) {
        const held = await onMain(() => {
          const p = JB.localPlayer();
          if (!p) return false;
          const entry = p.field("m_InventoryBlackboardData").value.method("get_HeldEntry").invoke();
          return !entry.isNull() && entry.handle.equals(created.target.handle);
        });
        if (held) return { item: plan.name, display: plan.display, gear: plan.summary };
        if (Date.now() > deadline) throw JB.bridgeError("EQUIP_UNCONFIRMED", "已请求装备，但没有确认手持物品变化，请在游戏中检查");
        await JB.delay(100);
      }
    } catch (e) {
      // only a pickup that was never handed over is taken back; once the player holds it, it is theirs
      if (created && !started) await onMain(() => U.all("Keepsake.PickupablesHandler", false)[0].method("RemovePersistentObjectServer").invoke(created.target));
      throw e;
    } finally {
      if (created) await onMain(() => created.free());
    }
  }

  const locString = (ls) => safe(() => ls.method("GetLocalizedString").invoke().content || "", "");

  Object.assign(ex, {
    // the spawnable catalog with groups; loads templates that are not in memory yet
    itemList: rpcSafe(async () => {
      const full = await JB.fullCatalog();
      const gear = JB.gearTargets ? await JB.gearTargets().catch(() => new Set()) : new Set();
      const items = full.items.map((i) => enrich(i, gear)).sort((a, b) => a.group.localeCompare(b.group) || a.display.localeCompare(b.display, "zh"));
      return { items, groups: GROUPS, counts: full.counts, failures: full.failures };
    }),

    // Put one item into the local player's hands (and its inventory slot) and
    // confirm the held item changed. Refuses when the item's slot has no room,
    // so nothing already carried is displaced.
    equipHand: rpcSafe(async (name, spec) => {
      if (spec) return equipWithAttributes(name, spec);
      const planned = await onMain(() => {
        const it = JB.resolveItem(name);
        if (it.category === "cargo") throw JB.bridgeError("ITEM_INCOMPATIBLE", "飞船部件不能装备到手上，请选择“刷到地上”");
        const p = JB.requireLocalPlayer();
        const rec = JB.playerRecord(p);
        if (!rec || rec.downed) throw JB.bridgeError("PLAYER_DOWNED", "角色已倒地或死亡，无法装备");
        const bb = p.field("m_InventoryBlackboardData").value;
        const slot = it.d.field("m_SlotType").value.field("value__").value;
        if (!bb.method("HasRoomForItem").invoke(slot, it.d)) {
          throw JB.bridgeError("SLOT_FULL", "这件物品对应的栏位已满，请先丢弃一件，或选择“刷进背包 / 刷到地上”");
        }
        p.field("m_ItemHandler").value.method("InstantiateAndEquip").invoke(it.d, -1, -1);
        return { name: it.name, display: it.display };
      });
      const deadline = Date.now() + 4000;
      for (;;) {
        const held = await onMain(() => {
          const p = JB.localPlayer();
          if (!p) return null;
          const entry = p.field("m_InventoryBlackboardData").value.method("get_HeldEntry").invoke();
          return entry.isNull() ? null : U.name(entry.method("get_ItemData").invoke());
        });
        if (held === planned.name) return { item: planned.name, display: planned.display };
        if (Date.now() > deadline) throw JB.bridgeError("EQUIP_UNCONFIRMED", "已请求装备，但没有确认手持物品变化，请在游戏中检查");
        await JB.delay(100);
      }
    }),

    // description, type name and tier of one item, shown in the detail panel
    itemInfo: rpcSafe((name) => onMain(() => {
      const it = JB.resolveItem(name);
      const d = it.d;
      if (it.category === "cargo") {
        return {
          name: it.name,
          display: it.display,
          description: locString(safe(() => d.method("get_ItemDescriptionLoc").invoke(), null)),
          typeName: "飞船部件",
          tier: safe(() => d.method("get_Tier").invoke(), null),
        };
      }
      return {
        name: it.name,
        display: it.display,
        description: safe(() => d.method("get_ShortDescriptionText").invoke().content || "", ""),
        typeName: safe(() => d.method("get_ItemTypeNameText").invoke().content || "", ""),
        tier: safe(() => d.field("m_Tier").value, null),
      };
    })),
  });
}

// Multipliers on the game's own stats through GameplayModifierManager's local stat modifiers.
//
// Whatever depends on a stat (a shot's damage, the time a repair takes) asks GameplayModifierManager.GetStat for it with an
// owner object, and the manager adds up the local modifiers registered for that stat as base × (1 + sum). One modifier is
// registered per stat; it answers factor − 1 for the owners that belong to the local player and 0 for any other object, so
// enemies and other players keep their own values. Which objects belong to the player is worked out on a ticker, not in
// the callback, which runs on the game's main thread for every query. Removing the registration hands the stats back untouched.
export const DAMAGE_STATS = ["OnFootDamage", "ShipDamage"];
export const REPAIR_STATS = ["RepairSpeed"];

export function createStatBoost(JB, { stats, owners }) {
  const { U, bridgeError } = JB;
  let reg = null; // { instigator, handle, pins, factor, mine }

  const manager = () => U.cls("Keepsake.GameplayModifierManager");
  const method = (name) => {
    const m = manager().methods.find((x) => x.name === name);
    if (!m) throw bridgeError("GAME_API_CHANGED", `游戏版本可能已更新，找不到 ${name}`);
    return m;
  };

  function register(instigator) {
    const Func = Il2Cpp.corlib.class("System.Func`2").inflate(U.cls("UnityEngine.GameObject"), Il2Cpp.corlib.class("System.Single"));
    const state = { instigator, handle: String(instigator.handle), factor: 1, mine: new Set(), pins: [instigator.ref(false)] }; // pins keep the objects from being collected
    const none = Il2Cpp.delegate(Func, () => 0.0);
    const boost = Il2Cpp.delegate(Func, (owner) => (state.mine.has(String(owner.handle)) ? state.factor - 1 : 0.0));
    state.pins.push(none.ref(false), boost.ref(false));
    const add = method("AddLocalStatModification");
    const stat = U.cls("Keepsake.ModifierStat");
    for (const name of stats) add.invoke(stat.field(name).value, none, boost, instigator);
    return state;
  }

  function unregister() {
    if (!reg) return;
    const remove = method("RemoveLocalStatModification");
    const stat = U.cls("Keepsake.ModifierStat");
    const gone = reg;
    reg = null;
    for (const name of stats) remove.invoke(stat.field(name).value, gone.instigator);
  }

  return {
    // keep the registration alive and aimed at the player's objects; called every few tenths of a second
    apply(factor) {
      const instigator = method("get_Instance").invoke().method("get_gameObject").invoke();
      if (reg && reg.handle !== String(instigator.handle)) reg = null; // the manager object was replaced: the old registration went with it
      if (!reg) reg = register(instigator);
      reg.factor = factor;
      reg.mine = new Set(owners());
    },
    release: unregister,
    active: () => !!reg,
  };
}

const handleOf = (go) => String(go.method("get_gameObject").invoke().handle);

// A shot asks with the weapon in hand (its persistent item's game object) as the owner.
export function heldWeaponOwners(JB) {
  return () => {
    const p = JB.localPlayer();
    if (!p) return [];
    const item = p.field("m_ItemInstantiator").value.field("m_FirstPersonItem").value;
    if (item.isNull()) return [];
    const pickupable = item.field("m_PersistentPickupable").value;
    return pickupable.isNull() ? [] : [handleOf(pickupable)];
  };
}

// Repairs ask with the owner of a ModifiableStat: the player's interaction controller (parts of the ship) and the held
// repair tool each keep one, and the player itself is listed for anything that asks with the character.
export function repairOwners(JB) {
  const ownerOf = (stat) => {
    if (!stat || stat.isNull()) return null;
    const o = stat.field("m_Owner").value;
    return o.isNull() ? null : String(o.handle);
  };
  return () => {
    const p = JB.localPlayer();
    if (!p) return [];
    const out = new Set([handleOf(p)]);
    const controller = JB.safe(() => p.method("get_InteractionController").invoke(), null);
    if (controller && !controller.isNull()) out.add(JB.safe(() => ownerOf(controller.field("m_RepairSpeed").value), null));
    const item = JB.safe(() => p.field("m_ItemInstantiator").value.field("m_FirstPersonItem").value, null);
    if (item && !item.isNull() && item.class.fields.some((f) => f.name === "m_RepairSpeed")) out.add(JB.safe(() => ownerOf(item.field("m_RepairSpeed").value), null));
    out.delete(null);
    return [...out];
  };
}

export const createDamageBoost = (JB) => createStatBoost(JB, { stats: DAMAGE_STATS, owners: heldWeaponOwners(JB) });
export const createRepairBoost = (JB) => createStatBoost(JB, { stats: REPAIR_STATS, owners: repairOwners(JB) });

// Weapon damage multiplier through the game's own stat modifiers.
//
// A shot asks GameplayModifierManager.GetStat for OnFootDamage and ShipDamage with the held weapon's game object as the
// owner, and the manager adds up the local modifiers registered for that stat as base × (1 + sum). One modifier is
// registered for each stat; it answers factor − 1 for the weapon in the local player's hands and 0 for any other object, so
// enemies and other players keep their own damage. The weapon is looked up on a ticker, not in the callback, which runs on
// the game's main thread for every query. Removing the registration hands the stats back untouched.
const STATS = ["OnFootDamage", "ShipDamage"];

export function createDamageBoost(JB) {
  const { U, bridgeError } = JB;
  let reg = null; // { instigator, handle, pins, factor, held }

  const manager = () => U.cls("Keepsake.GameplayModifierManager");
  const method = (name) => {
    const m = manager().methods.find((x) => x.name === name);
    if (!m) throw bridgeError("GAME_API_CHANGED", `游戏版本可能已更新，找不到 ${name}`);
    return m;
  };

  // the object the weapon-in-hand's stat queries are made with
  function heldWeapon() {
    const p = JB.localPlayer();
    if (!p) return null;
    const item = p.field("m_ItemInstantiator").value.field("m_FirstPersonItem").value;
    if (item.isNull()) return null;
    const pickupable = item.field("m_PersistentPickupable").value;
    return pickupable.isNull() ? null : String(pickupable.method("get_gameObject").invoke().handle);
  }

  function register(instigator) {
    const Func = Il2Cpp.corlib.class("System.Func`2").inflate(U.cls("UnityEngine.GameObject"), Il2Cpp.corlib.class("System.Single"));
    const state = { instigator, handle: String(instigator.handle), factor: 1, held: null, pins: [instigator.ref(false)] }; // pins keep the objects from being collected
    const none = Il2Cpp.delegate(Func, () => 0.0);
    const boost = Il2Cpp.delegate(Func, (owner) => (state.held !== null && String(owner.handle) === state.held ? state.factor - 1 : 0.0));
    state.pins.push(none.ref(false), boost.ref(false));
    const add = method("AddLocalStatModification");
    const stat = U.cls("Keepsake.ModifierStat");
    for (const name of STATS) add.invoke(stat.field(name).value, none, boost, instigator);
    return state;
  }

  function unregister() {
    if (!reg) return;
    const remove = method("RemoveLocalStatModification");
    const stat = U.cls("Keepsake.ModifierStat");
    const gone = reg;
    reg = null;
    for (const name of STATS) remove.invoke(stat.field(name).value, gone.instigator);
  }

  return {
    // keep the registration alive and aimed at the weapon in hand; called every few tenths of a second
    apply(factor) {
      const instigator = method("get_Instance").invoke().method("get_gameObject").invoke();
      if (reg && reg.handle !== String(instigator.handle)) reg = null; // the manager object was replaced: the old registration went with it
      if (!reg) reg = register(instigator);
      reg.factor = factor;
      reg.held = heldWeapon();
    },
    release: unregister,
    active: () => !!reg,
  };
}

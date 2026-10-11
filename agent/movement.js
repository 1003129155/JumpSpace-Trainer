// Movement multipliers (walk/sprint speed, jump strength) built on the game's own ComposableProperty<float> stacks.
//
// A player movement value is not a plain field: it is a stack of overrides ordered by priority — the authored
// base at 0 and the game's own modifiers (detective mode, crouch, sprint, weapon) at 1..4. We add one extra
// entry on top of that, owned by the *settings object itself* (never by the player object: the base entries
// belong to the player, and clearing by instigator would remove them too). Removing our entry hands control
// straight back to the game, so turning a cheat off restores the exact original values.
const TOP_PRIORITY = 10;
const OVERRIDE_SIG = "System.Single,System.Int32,UnityEngine.Object";
const CLEAR_SIG = "UnityEngine.Object";
const PRIORITY_OF_SIG = "UnityEngine.Object,System.Int32&";

export function createScaler(JB, { props }) {
  const { bridgeError, safe } = JB;
  const methods = new Map();
  let owned = null; // { settings, base: {prop: number}, mult }

  // Pick one overload by its exact parameter types (the generic has several with the same name and arity).
  function bound(obj, name, signature) {
    const cls = obj.class;
    const key = `${cls.handle}|${name}|${signature}`;
    let m = methods.get(key);
    if (!m) {
      m = cls.methods.find((x) => x.name === name && x.parameters.map((p) => p.type.name).join(",") === signature);
      if (!m) throw bridgeError("GAME_API_CHANGED", `游戏版本可能已更新，找不到 ${name}`);
      methods.set(key, m);
    }
    return m.bind(obj);
  }

  const same = (a, b) => a.handle.equals(b.handle);

  function currentSettings() {
    const p = JB.localPlayer();
    if (!p) return null;
    const s = p.method("get_CurrentPlayerSettings").invoke();
    return s.isNull() ? null : s;
  }

  // The value without any modifier: the lowest-priority entry, or the property's default when the stack is empty.
  function baseValue(prop) {
    const queue = prop.field("m_PropertyPriorityQueue").value;
    if (queue.method("get_Count").invoke() > 0) return queue.method("get_LowestPriorityValue").invoke().method("get_Value").invoke();
    return prop.method("get_DefaultValue").invoke();
  }

  const addEntry = (prop, settings, v) => bound(prop, "OverrideProperty", OVERRIDE_SIG).invoke(v, TOP_PRIORITY, settings);
  const clearEntry = (prop, settings) => bound(prop, "ClearOverrideByInstigator", CLEAR_SIG).invoke(settings);

  function hasEntry(prop, settings) {
    const queue = prop.field("m_PropertyPriorityQueue").value;
    return !!bound(queue, "TryGetPriorityForInstigator", PRIORITY_OF_SIG).invoke(settings, Memory.alloc(4));
  }

  const propOf = (settings, name) => settings.field(name).value;

  // Remove our entries (if any) and forget the character.
  function release() {
    if (!owned) return false;
    const { settings } = owned;
    owned = null;
    for (const name of props) safe(() => clearEntry(propOf(settings, name), settings));
    return true;
  }

  // Make sure the current character carries our entries scaled by `mult`.
  function apply(mult) {
    const s = currentSettings();
    if (!s) return false;
    if (owned && !same(owned.settings, s)) owned = null; // new character: the old settings went away with it
    if (owned && owned.mult !== mult) release(); // new multiplier: rebuild from the base values
    if (!owned) {
      const base = {};
      for (const name of props) {
        const prop = propOf(s, name);
        clearEntry(prop, s); // never stack on a leftover of ours
        base[name] = baseValue(prop);
      }
      for (const name of props) addEntry(propOf(s, name), s, base[name] * mult);
      owned = { settings: s, base, mult };
      return true;
    }
    for (const name of props) {
      // keep-alive: put the entry back if the game cleared the stack
      const prop = propOf(s, name);
      if (!hasEntry(prop, s)) addEntry(prop, s, owned.base[name] * mult);
    }
    return true;
  }

  // Entries left behind by an earlier agent run (hot reload, crash) on the current character.
  function clearLeftovers() {
    const s = currentSettings();
    if (!s) return null;
    let removed = 0;
    for (const name of props) if (safe(() => clearEntry(propOf(s, name), s), false)) removed++;
    return removed;
  }

  return { apply, release, clearLeftovers, active: () => (owned ? { mult: owned.mult } : null) };
}

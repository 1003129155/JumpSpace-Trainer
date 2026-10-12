// Loot rarity. The game rolls the rarity of a generated item (a weapon, gear or ship part found as loot) in
// ItemGenerator.RollItemRarity, which returns a Nullable<ItemRarity> in RAX: byte 0 says there is a value, the dword at
// byte 4 is the rarity. A native hook on its way out raises a rolled rarity to the chosen one. "Nothing rolled" stays as it
// is, and so does everything the generator is told to make at a fixed rarity (blueprints, spawned items): those never roll.
// Items without a rarity (ammunition, resources) do not go through the generator at all.
// No JavaScript runs in the hook; switching it is writing a flag. The hook itself stays for the life of the game: removing
// it is not needed to switch it off, and a hook that is never removed is the safe kind (see README, "稳定性").
export const LEGENDARY = 3; // ItemRarity: Common 0, Rare 1, Epic 2, Legendary 3

const C_SOURCE = `
#include <gum/guminterceptor.h>

extern volatile gint enabled;
extern volatile gint rarity;

void
onLeave (GumInvocationContext * ic)
{
  guint64 rolled;

  if (enabled == 0)
    return;

  rolled = (guint64) gum_invocation_context_get_return_value (ic);

  /* byte 0 is hasValue: when nothing was rolled there is nothing to raise */
  if ((rolled & 0xff) == 0)
    return;

  gum_invocation_context_replace_return_value (ic, GSIZE_TO_POINTER (((guint64) rarity << 32) | 1));
}
`;

export function installLoot(JB) {
  const { U, bridgeError } = JB;
  let hook = null; // { module, enabled, rarity, listener }: kept referenced, the native code is running from them

  function ensureHook() {
    if (hook) return hook;
    try {
      const method = U.cls("Keepsake.GeneratedItems.ItemGenerator").method("RollItemRarity");
      const enabled = Memory.alloc(4);
      const rarity = Memory.alloc(4);
      enabled.writeS32(0);
      rarity.writeS32(LEGENDARY);
      const module = new CModule(C_SOURCE, { enabled, rarity });
      const listener = Interceptor.attach(method.virtualAddress, { onLeave: module.onLeave });
      hook = { module, enabled, rarity, listener };
    } catch (e) {
      throw bridgeError("GAME_API_CHANGED", `没能挂上掉落品质的钩子（游戏更新后可能需要适配）：${e.message || e}`);
    }
    return hook;
  }

  // set(rarity): rolled loot becomes this rarity (0..3); set(null): back to what the game rolls
  JB.lootRarity = {
    set(rarity) {
      if (rarity === null || rarity === undefined) {
        if (hook) hook.enabled.writeS32(0);
        return;
      }
      if (!Number.isInteger(rarity) || rarity < 0 || rarity > LEGENDARY) throw bridgeError("BAD_RARITY", "品质只能是 0–3");
      const h = ensureHook();
      if (h.rarity.readS32() !== rarity) h.rarity.writeS32(rarity);
      if (h.enabled.readS32() !== 1) h.enabled.writeS32(1);
    },
    active: () => !!hook && hook.enabled.readS32() === 1,
  };
}

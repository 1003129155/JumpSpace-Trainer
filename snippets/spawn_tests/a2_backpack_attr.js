// Experiment: a generated item attached to a fresh pickup, then picked up into the BACKPACK (the plain spawn does the same
// without the attach). Reads the entry back, then destroys the item again.
const it = resolveItem("Pickupable_PDW_MK0");
const recipe = X.itemEntity(it);
const report = { steps: [] };
const game = X.gearGame();
let created = null;
const str = (x) => (x.isNull() ? null : x.content);
const readGen = (g) => {
  const mods = g.field("m_Modules").value;
  return { guid: str(g.field("m_Guid").value), level: g.field("m_Level").value, rarity: String(g.field("m_Rarity").value), modules: mods.isNull() ? null : U.list(mods).length };
};
try {
  const built = await onMain(() => {
    const first = game.buildGear(recipe, { tier: 2, seed: 9 });
    return buildMax((s) => game.buildGear(recipe, s), first);
  });
  report.built = { level: built.evaluation.level, mods: built.evaluation.slots.length, errors: built.errors };
  const before = await onMain(() => freeBackpackEntries(resolvePlayer("local")));
  report.freeBefore = before;
  await consumeTask(
    (token) => U.cls("Keepsake.PickupablesHandler").method("InstantiatePersistentPickupableFromItemData_Async", 2).invoke(it.d, token),
    (p) => { if (p.isNull()) throw new Error("no pickup created"); created = rootObject(p); });
  report.steps.push("instantiated");
  await onMain(() => {
    const p = created.target;
    p.method("get_PickupableBlackboardData").invoke().field("m_GeneratedItem").value.method("set_Value").invoke(built.item);
    const ctx = validateSpawn("Pickupable_PDW_MK0", 1, "backpack", "local", "reject");
    ctx.p.field("m_ItemHandler").value.method("Server_PickupItem").invoke(p, backpackSlot(), ctx.free[0], false);
  });
  report.steps.push("picked up");
  await delay(1500);
  report.entry = await onMain(() => {
    const p = resolvePlayer("local");
    const bb = p.field("m_InventoryBlackboardData").value;
    const slot = backpackSlot();
    for (let i = 0; i < bb.method("MaxEntriesInSlot").invoke(slot); i++) {
      const e = bb.method("GetEntryAtIndexInSlot").invoke(slot, i);
      if (!e.isNull() && e.handle.equals(created.target.handle)) {
        const g = readGen(e.method("get_PickupableBlackboardData").invoke().field("m_GeneratedItem").value.method("get_Value").invoke());
        const stat = (name) => safe(() => Number(e.method(name).invoke().method("get_Value").invoke()), "n/a");
        return { index: i, generated: g, onFootDamage: stat("get_OnFootDamageStat"), maxAmmo: stat("get_MaxAmmoStat") };
      }
    }
    return null;
  });
} catch (e) {
  report.failure = String(e && e.stack || e);
} finally {
  game.release();
  if (created) {
    try {
      await onMain(() => {
        const p = resolvePlayer("local");
        p.field("m_ItemHandler").value.method("DestroyItem").invoke(created.target);
      });
      report.steps.push("destroyed via DestroyItem");
    } catch (e) { report.destroyError = String(e); }
    await delay(800);
    report.freeAfter = await onMain(() => freeBackpackEntries(resolvePlayer("local")));
    report.stillInInventory = await onMain(() => {
      const p = resolvePlayer("local");
      const bb = p.field("m_InventoryBlackboardData").value;
      const slot = backpackSlot();
      for (let i = 0; i < bb.method("MaxEntriesInSlot").invoke(slot); i++) {
        const e = bb.method("GetEntryAtIndexInSlot").invoke(slot, i);
        if (!e.isNull() && e.handle.equals(created.target.handle)) return true;
      }
      return false;
    });
    await onMain(() => created.free());
  }
}
return report;

// Experiment: a ship part (cargo item) spawned on the floor with generated data attached right after the spawn (the way the
// game's own crafting machine does it). Reads the data back, then removes the part again.
const it = resolveItem("Component_Reactor_4_1");
const recipe = X.itemEntity(it);
const report = { steps: [], category: it.category };
const game = X.gearGame();
let created = null;
const str = (x) => (x.isNull() ? null : x.content);
const readGen = (g) => {
  const mods = g.field("m_Modules").value;
  return { guid: str(g.field("m_Guid").value), level: g.field("m_Level").value, rarity: String(g.field("m_Rarity").value), template: str(g.field("m_TemplateGuid").value), modules: mods.isNull() ? null : U.list(mods).length };
};
try {
  const built = await onMain(() => {
    const first = game.buildGear(recipe, { tier: 3, seed: 3 });
    return buildMax((s) => game.buildGear(recipe, s), first);
  });
  report.built = { level: built.evaluation.level, cap: built.evaluation.cap, mods: built.evaluation.slots.map((s) => s.name + " | " + s.text), errors: built.errors };
  await consumeTask((token) => {
    const ctx = dropContext(resolvePlayer("local"));
    const ph = U.all("Keepsake.PickupablesHandler", false)[0];
    return ph.method("SpawnCargoBayItem_Async", 5).invoke(it.d, ctx.parent, ctx.local, ctx.rotation, token);
  }, (res) => {
    if (!res.method("get_IsValid").invoke()) throw new Error("no valid drop");
    created = rootObject(res.method("get_PersistentPickupable").invoke());
  });
  report.steps.push("spawned");
  report.before = await onMain(() => readGen(created.target.method("get_PickupableBlackboardData").invoke().field("m_GeneratedItem").value.method("get_Value").invoke()));
  await onMain(() => created.target.method("get_PickupableBlackboardData").invoke().field("m_GeneratedItem").value.method("set_Value").invoke(built.item));
  report.steps.push("attached");
  await delay(1500);
  report.after = await onMain(() => readGen(created.target.method("get_PickupableBlackboardData").invoke().field("m_GeneratedItem").value.method("get_Value").invoke()));
} catch (e) {
  report.failure = String(e && e.stack || e);
} finally {
  game.release();
  if (created) {
    try {
      await onMain(() => U.all("Keepsake.PickupablesHandler", false)[0].method("RemovePersistentObjectServer").invoke(created.target));
      report.steps.push("removed");
    } catch (e) { report.removeError = String(e); }
    await onMain(() => created.free());
  }
}
return report;

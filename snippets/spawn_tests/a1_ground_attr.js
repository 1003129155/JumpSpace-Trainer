// Experiment: can a generated item (Legendary, maxed modules) be attached to a freshly created pickup before it is dropped?
// Spawns ONE Stinger MP-75 on the floor in front of the local player, reads it back, then removes it again.
const it = resolveItem("Pickupable_PDW_MK0");
const recipe = X.itemEntity(it);
const report = { steps: [] };
const game = X.gearGame();
let created = null;
const str = (x) => (x.isNull() ? null : x.content);
const readGen = (g) => {
  const mods = g.field("m_Modules").value;
  return { guid: str(g.field("m_Guid").value), template: str(g.field("m_TemplateGuid").value), level: g.field("m_Level").value, rarity: String(g.field("m_Rarity").value),
    modules: mods.isNull() ? null : U.list(mods).map((m) => ({ guid: (str(m.field("m_ModuleGuid").value) || "").slice(0, 8), rarity: String(m.field("m_Rarity").value), level: m.field("m_UpgradeLevel").value })) };
};
try {
  const built = await onMain(() => {
    const first = game.buildGear(recipe, { tier: 3, seed: 5 });
    return buildMax((s) => game.buildGear(recipe, s), first);
  });
  report.errors = built.errors;
  report.built = { level: built.evaluation.level, cap: built.evaluation.cap, mods: built.evaluation.slots.map((s) => s.name + " | " + s.text) };

  await consumeTask(
    (token) => U.cls("Keepsake.PickupablesHandler").method("InstantiatePersistentPickupableFromItemData_Async", 2).invoke(it.d, token),
    (p) => { if (p.isNull()) throw new Error("no pickup created"); created = rootObject(p); });
  report.steps.push("instantiated");

  report.attach = await onMain(() => {
    const p = created.target;
    const bb = p.method("get_PickupableBlackboardData").invoke();
    const prop = bb.field("m_GeneratedItem").value;
    const before = readGen(prop.method("get_Value").invoke());
    prop.method("set_Value").invoke(built.item);
    return { before, after: readGen(prop.method("get_Value").invoke()) };
  });
  report.steps.push("attached");

  // the stats the pickup reports before the drop (modules applied?)
  const stats = () => onMain(() => {
    const p = created.target;
    const read = (name) => safe(() => { const s = p.method(name).invoke(); return s.isNull() ? null : Number(s.method("get_Value").invoke()); }, "n/a");
    return { onFootDamage: read("get_OnFootDamageStat"), maxAmmo: read("get_MaxAmmoStat"), pellets: read("get_PelletCountStat") };
  });
  report.statsBeforeDrop = await stats();

  // drop it in front of the local player
  const player = await onMain(() => resolvePlayer("local"));
  await consumeTask((token) => {
    const ctx = dropContext(resolvePlayer("local"));
    const ph = U.all("Keepsake.PickupablesHandler", false)[0];
    return ph.method("DropItem_Async", 5).invoke(created.target, ctx.parent, ctx.local, ctx.rotation, token);
  }, (res) => { report.dropValid = !!res.method("get_IsValid").invoke(); });
  report.steps.push("dropped");
  await delay(1500);
  report.statsAfterDrop = await stats();
  report.generatedAfterDrop = await onMain(() => readGen(created.target.method("get_PickupableBlackboardData").invoke().field("m_GeneratedItem").value.method("get_Value").invoke()));
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

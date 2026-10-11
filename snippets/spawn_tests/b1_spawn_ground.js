// The real spawn RPC (current agent.js) with attributes: two Legendary Stinger MP-75 on the floor. Every copy must carry its own
// generated item (its own guid) with the asked attributes. Both are removed again at the end.
const handler = () => U.all("Keepsake.PickupablesHandler", false)[0];
const idOf = (p) => String(p.method("get_NetworkObject").invoke().method("get_NetworkObjectId").invoke());
const all = () => onMain(() => GJB.managedRows(handler().field("m_PersistentPickupables").value, (p) => p));
const str = (x) => (x.isNull() ? null : x.content);
const report = {};
const before = new Set((await all()).map(idOf));
const spec = { tier: 3, seed: 5, level: "max" };
const reply = JSON.parse(await spawnRpc.spawn("Pickupable_PDW_MK0", 2, "ground", "local", "reject", spec));
report.reply = { ok: reply.ok, ground: reply.ground, backpack: reply.backpack, gear: reply.gear, error: reply.error };
await delay(1500);
const fresh = (await all()).filter((p) => !before.has(idOf(p)));
report.fresh = fresh.length;
report.items = await onMain(() => fresh.map((p) => {
  const g = p.method("get_PickupableBlackboardData").invoke().field("m_GeneratedItem").value.method("get_Value").invoke();
  const stat = (n) => safe(() => Number(p.method(n).invoke().method("get_Value").invoke()), "n/a");
  return { guid: str(g.field("m_Guid").value), rarity: String(g.field("m_Rarity").value), level: g.field("m_Level").value, modules: U.list(g.field("m_Modules").value).length, onFootDamage: stat("get_OnFootDamageStat"), maxAmmo: stat("get_MaxAmmoStat") };
}));
report.distinctGuids = new Set(report.items.map((i) => i.guid)).size;
await onMain(() => fresh.forEach((p) => handler().method("RemovePersistentObjectServer").invoke(p)));
await delay(800);
report.leftOver = (await all()).filter((p) => !before.has(idOf(p))).length;
return report;

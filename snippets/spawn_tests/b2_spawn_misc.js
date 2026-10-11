// The real spawn RPC (current agent.js) with attributes: into the backpack, a ship part on the floor, and requests the game
// would refuse. Everything created is removed again.
const handler = () => U.all("Keepsake.PickupablesHandler", false)[0];
const idOf = (p) => String(p.method("get_NetworkObject").invoke().method("get_NetworkObjectId").invoke());
const all = () => onMain(() => GJB.managedRows(handler().field("m_PersistentPickupables").value, (p) => ({ p, id: idOf(p) })));
const str = (x) => (x.isNull() ? null : x.content);
const readGen = (p) => {
  const g = p.method("get_PickupableBlackboardData").invoke().field("m_GeneratedItem").value.method("get_Value").invoke();
  return { guid: str(g.field("m_Guid").value), rarity: String(g.field("m_Rarity").value), level: g.field("m_Level").value, modules: U.list(g.field("m_Modules").value).length };
};
const report = {};
const spec = { tier: 2, seed: 9, level: "max" };

// 1. into the backpack
{
  const before = new Set((await all()).map((x) => x.id));
  const freeBefore = await onMain(() => freeBackpackEntries(resolvePlayer("local")));
  const reply = JSON.parse(await spawnRpc.spawn("Pickupable_PDW_MK0", 1, "backpack", "local", "reject", spec));
  report.backpack = { reply: { ok: reply.ok, backpack: reply.backpack, ground: reply.ground, gear: reply.gear, error: reply.error } };
  await delay(1200);
  const fresh = (await all()).filter((x) => !before.has(x.id));
  report.backpack.fresh = fresh.length;
  report.backpack.items = await onMain(() => fresh.map((x) => readGen(x.p)));
  report.backpack.inInventory = await onMain(() => {
    const bb = resolvePlayer("local").field("m_InventoryBlackboardData").value;
    const slot = backpackSlot();
    const hits = [];
    for (let i = 0; i < bb.method("MaxEntriesInSlot").invoke(slot); i++) {
      const e = bb.method("GetEntryAtIndexInSlot").invoke(slot, i);
      if (!e.isNull() && fresh.some((x) => x.p.handle.equals(e.handle))) hits.push(i);
    }
    return hits;
  });
  await onMain(() => { const handlerOfPlayer = resolvePlayer("local").field("m_ItemHandler").value; fresh.forEach((x) => handlerOfPlayer.method("DestroyItem").invoke(x.p)); });
  await delay(800);
  report.backpack.freeAfterEqualsBefore = JSON.stringify(await onMain(() => freeBackpackEntries(resolvePlayer("local")))) === JSON.stringify(freeBefore);
  report.backpack.leftOver = (await all()).filter((x) => !before.has(x.id)).length;
}

// 2. a ship part on the floor
{
  const before = new Set((await all()).map((x) => x.id));
  const reply = JSON.parse(await spawnRpc.spawn("Component_Reactor_4_1", 1, "ground", "local", "reject", { tier: 3, seed: 3, level: "max" }));
  report.cargo = { reply: { ok: reply.ok, ground: reply.ground, gear: reply.gear, error: reply.error } };
  await delay(1200);
  const fresh = (await all()).filter((x) => !before.has(x.id));
  report.cargo.items = await onMain(() => fresh.map((x) => readGen(x.p)));
  await onMain(() => fresh.forEach((x) => handler().method("RemovePersistentObjectServer").invoke(x.p)));
  await delay(800);
  report.cargo.leftOver = (await all()).filter((x) => !before.has(x.id)).length;
}

// 3. requests the game would refuse: nothing may be spawned
{
  const before = (await all()).length;
  const check = async (label, spec2, method = "previewSpawn") => {
    const r = JSON.parse(await spawnRpc[method]("Pickupable_PDW_MK0", 1, "ground", "local", "reject", spec2));
    return { ok: r.ok, code: r.error && r.error.code, message: r.error && r.error.message };
  };
  report.refused = {
    unknownModule: await check("unknownModule", { tier: 1, seed: 3, slots: [{ guid: "nope", rarity: 1 }, { guid: "nope2", rarity: 1 }, { guid: "nope3", rarity: 1 }] }),
    badTier: await check("badTier", { tier: 9 }).catch((e) => ({ thrown: String(e && e.message || e) })),
    spawnToo: await check("spawnToo", { tier: 1, seed: 3, slots: [{ guid: "nope", rarity: 1 }, { guid: "nope2", rarity: 1 }, { guid: "nope3", rarity: 1 }] }, "spawn"),
  };
  report.refused.nothingSpawned = (await all()).length === before;
}
return report;

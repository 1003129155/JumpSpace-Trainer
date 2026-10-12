// Ship repair: look for everything that is wrong with the player ship and put it right with the game's own functions.
//
// What can be wrong, and what the game itself does about it:
//   hull        the core's health, and the hull breaches that appear as it drops  → ModifyHealthServerRpc, HullDamageManager.ResetAllPoints
//   shield      the ship's shield, topped up once the repaired parts have started → ModifyShieldServerRpc
//   fires       burning nodes of the ship and its radiators                       → FireController.ServerStopAllFires, DamagePoint_Radiator.SetFireState(false)
//   leaks       the damage points (radiation / materia leaks, pipes ...)          → DamagePoint_Base.Repair
//   fuel lines  broken segments of a fuel line                                    → DamagePoint_FuelLine.RepairSegment
//   components  parts that are Broken or Critical                                → SpaceShip_BaseComponent.SetComponentHealthStatus(Healthy)
// Everything here is the host's business: the repairs are server calls.
const WHOLE = "Whole";
const HEALTHY = 0; // SpaceShip_BaseComponent.ComponentHealthStatus: Healthy, Broken, Critical

export function installShipRepair(JB, ex) {
  const { U, onMain, bridgeError, rpcSafe, safe } = JB;
  const keep = [];
  const value = (reactive) => reactive.method("get_Value").invoke();
  const all = (cls) => U.all(cls, false);
  const first = (cls) => all(cls)[0] || null;

  function playerShip() {
    const ship = U.cls("Global").method("get_PlayerShipRef").invoke();
    return ship.isNull() ? null : ship;
  }

  const enumValue = (type, n) => {
    const mem = Memory.alloc(8);
    mem.writeS32(n);
    keep.push(mem);
    return new Il2Cpp.ValueType(mem, type);
  };

  const hullPoints = () => {
    const manager = first("Keepsake.Playership_HullDamageManager");
    return manager ? JB.managedRows(manager.field("m_HullDamagePoints").value, (p) => p) : [];
  };

  const brokenSegments = (line) => {
    const out = [];
    const n = safe(() => line.field("m_DamageSegments").value.method("get_Count").invoke(), 0);
    for (let i = 0; i < n; i++) if (!line.method("IsSegmentWhole").invoke(i)) out.push(i);
    return out;
  };

  // what is wrong, as counts; main thread
  function inspect() {
    const ship = playerShip();
    if (!ship) return null;
    const state = ship.method("get_ShipStateBlackboardData").invoke();
    const hull = value(state.field("m_ShipHealth").value);
    const hullMax = value(state.field("m_ShipMaxHealth").value);
    const shield = value(state.field("m_ShipShield").value);
    const shieldMax = value(state.field("m_CurrentShipMaxShield").value);
    const radiators = all("DamagePoint_Radiator");
    const problems = {
      hull: { health: hull, max: hullMax, low: hull < hullMax },
      breaches: hullPoints().filter((p) => String(p.method("get_CurrentState").invoke()) !== WHOLE).length,
      shield: { value: Math.round(shield), max: Math.round(shieldMax), low: shield < shieldMax - 0.5 },
      fires: all("PathFinding.FireNodePlayership").filter((n) => n.method("get_IsOnFire").invoke()).length
        + radiators.filter((r) => r.method("get_IsOnFire").invoke()).length,
      leaks: all("DamagePoint_Base").filter((d) => d.method("get_Health01").invoke() < 0.999).length,
      fuelSegments: all("DamagePoint_FuelLine").reduce((n, line) => n + brokenSegments(line).length, 0),
      components: all("SpaceShip_BaseComponent").filter((c) => String(value(c.field("m_ComponentBlackboard").value.field("m_ComponentHealthStatus").value)) !== "Healthy").length,
    };
    problems.total = (problems.hull.low ? 1 : 0) + problems.breaches + (problems.shield.low ? 1 : 0) + problems.fires + problems.leaks + problems.fuelSegments + problems.components;
    return problems;
  }

  // put it all right; returns what was found wrong (the same counts as inspect)
  function repair() {
    const ship = playerShip();
    if (!ship) throw bridgeError("NO_SHIP", "现在没有飞船（不在任务里）");
    JB.requireServer();
    const found = inspect();
    const damage = first("Playership_DamageController");

    // fires first: a fire keeps hurting the parts and the hull while the rest is being repaired
    const fire = first("Spaceship_FireController");
    if (fire) fire.method("ServerStopAllFires").invoke();
    // a radiator's fire is put out by its fire state; StopFire alone leaves it burning
    for (const radiator of all("DamagePoint_Radiator")) {
      if (!radiator.method("get_IsOnFire").invoke()) continue;
      radiator.method("StopFire").invoke();
      radiator.method("SetFireState").invoke(false);
    }

    // damage points, and the segments of the fuel lines
    for (const point of all("DamagePoint_Base")) {
      if (point.method("get_Health01").invoke() >= 0.999) continue;
      point.method("Repair").invoke(point.method("get_HealthComponent").invoke().method("get_MaxHealth").invoke());
    }
    for (const line of all("DamagePoint_FuelLine")) for (const i of brokenSegments(line)) line.method("RepairSegment").invoke(i);

    // parts
    const base = U.cls("SpaceShip_BaseComponent");
    const setStatus = base.methods.find((m) => m.name === "SetComponentHealthStatus");
    const healthy = enumValue(setStatus.parameters[0].type, HEALTHY);
    for (const part of all("SpaceShip_BaseComponent")) {
      if (String(value(part.field("m_ComponentBlackboard").value.field("m_ComponentHealthStatus").value)) !== "Healthy") part.method("SetComponentHealthStatus").invoke(healthy);
    }

    // the hull: health back to full, then the breaches that are left
    if (damage && found.hull.low) damage.method("ModifyHealthServerRpc").invoke(found.hull.max - found.hull.health);
    const manager = first("Keepsake.Playership_HullDamageManager");
    if (manager && found.breaches) manager.method("ResetAllPoints").invoke();
    return found;
  }

  // A repaired part starts up again (Activating, a few seconds); the shield regenerator empties the shield when it comes up, and
  // the shield charges from nothing from then on. So the shield is filled in a second step, after the parts have started.
  const partsStarting = () => all("SpaceShip_BaseComponent").filter((c) => String(value(c.field("m_ComponentBlackboard").value.field("m_ComponentPowerState").value)) === "Activating").length;

  function topUpShield() {
    const ship = playerShip();
    const damage = first("Playership_DamageController");
    if (!ship || !damage) return false;
    const state = ship.method("get_ShipStateBlackboardData").invoke();
    const shield = value(state.field("m_ShipShield").value);
    const max = value(state.field("m_CurrentShipMaxShield").value);
    if (shield >= max - 0.5) return false;
    damage.method("ModifyShieldServerRpc").invoke(max - shield);
    return true;
  }

  JB.shipRepair = { inspect, repair, topUpShield, partsStarting };

  Object.assign(ex, {
    // what is wrong with the ship (available: false outside a mission)
    shipHealth: rpcSafe(() => onMain(() => {
      const problems = inspect();
      return problems ? { available: true, problems } : { available: false };
    })),

    // repair everything, and say what there was to repair
    repairShip: rpcSafe(async () => {
      const found = await onMain(() => repair());
      await JB.delay(500); // the parts need a moment to begin starting
      for (let i = 0; i < 40 && (await onMain(() => partsStarting())) > 0; i++) await JB.delay(250);
      await onMain(() => topUpShield());
      return { found, left: await onMain(() => inspect()) };
    }),
  });
}

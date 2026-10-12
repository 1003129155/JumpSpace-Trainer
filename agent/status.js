// The version of the agent's RPC interface, reported with every status. The UI knows the version it was written for; when the
// game still runs an older script (the injected script can only be replaced by restarting the game), the UI says so instead
// of failing on methods that are not there. Raise it with every change the UI depends on.
export const AGENT_API = 4;

// Cheap, read-only snapshot for the UI header (polled every second or two).
export function installStatus(JB, ex) {
  const { U, onMain, safe, rpcSafe } = JB;
  const r1 = (n) => Math.round(n * 10) / 10;

  function healthSnapshot(p) {
    const hc = JB.healthOf(p);
    if (!hc) return null;
    return {
      health: r1(hc.method("get_Health").invoke()),
      maxHealth: r1(hc.method("get_MaxHealth").invoke()),
      shield: r1(hc.method("get_Shield").invoke()),
      maxShield: r1(hc.method("get_MaxShieldLevel").invoke()),
      invulnerable: !!hc.method("get_IsInvulnerable").invoke(),
      dead: !!hc.method("get_IsDead").invoke(),
    };
  }

  // what the player is holding and how much ammunition it has
  function loadoutSnapshot(p) {
    const held = p.field("m_InventoryBlackboardData").value.method("get_HeldEntry").invoke();
    const data = held.isNull() ? null : held.method("get_ItemData").invoke();
    const h = p.field("m_ItemHandler").value;
    const needsAmmo = !!safe(() => h.method("get_HasItemRequiringAmmunition").invoke(), false);
    return {
      held: data ? JB.displayOf(data) || U.name(data) : null,
      heldName: data ? U.name(data) : null,
      ammo: needsAmmo ? { current: h.method("get_CurrentAmmo").invoke(), max: h.method("get_MaxAmmo").invoke() } : null,
    };
  }

  JB.healthSnapshot = healthSnapshot;

  ex.status = rpcSafe(() => onMain(() => {
    const out = {
      agentApi: AGENT_API,
      unity: Il2Cpp.unityVersion,
      pumpTicks: JB.pumpInfo().ticks,
      net: JB.networkState(),
      profile: { ready: false },
      player: null,
      cheats: JB.cheatSummary ? JB.cheatSummary() : {},
    };
    const M = U.cls("Keepsake.MetaProgression.MetaProgressionManager");
    out.profile.ready = !!safe(() => M.method("get_InitialDataSuccessfullyLoaded").invoke(), false);
    if (out.profile.ready) {
      out.profile.level = safe(() => M.method("get_Level").invoke().method("get_Value").invoke(), null);
      out.profile.rank = safe(() => M.method("get_PlayerRankString").invoke().content, null);
    }
    const p = out.net.listening ? JB.localPlayer() : null;
    if (p) {
      const rec = safe(() => JB.playerRecord(p), null);
      if (rec) out.player = { ...rec, ...(safe(() => healthSnapshot(p), null) || {}) };
      out.loadout = safe(() => loadoutSnapshot(p), null);
    }
    out.materia = safe(() => {
      const S = U.cls("Keepsake.ShipMateriaController");
      return { amount: S.method("get_GetShipMateriaAmount").invoke(), max: S.method("get_GetMaxMateria").invoke() };
    }, null);
    return out;
  }));
}

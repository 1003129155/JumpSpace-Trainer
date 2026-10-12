// Cheat "locks": tiny jobs that run on the Unity main thread a few times a second
// while enabled. Each cheat only touches the local player's own objects.
import { createScaler } from "./movement.js";
import { LEGENDARY } from "./loot.js";
import { createDamageBoost } from "./damage.js";

export function installCheats(JB, ex) {
  const { onMain, bridgeError, rpcSafe, addTicker, removeTicker } = JB;

  const localHealth = () => {
    const p = JB.localPlayer();
    return p ? JB.healthOf(p) : null;
  };

  // The game's debug god-mode flag. A full radiation bar downs the character directly (PlayerRadiationAbility →
  // DownPlayer), past the damage system that IsInvulnerable guards; with this flag the radiation ability never starts and
  // DownPlayer does nothing. The value found before the cheat touched it is put back when it is switched off.
  let debugGodWas = null;
  const setDebugGod = (on) => {
    const s = JB.U.cls("Keepsake.PlayerDebugSettings").method("get_Settings").invoke();
    if (s.isNull()) return;
    const flag = s.field("m_GodMode");
    if (on) {
      if (debugGodWas === null) debugGodWas = flag.value;
      if (!flag.value) flag.value = true;
    } else if (debugGodWas !== null) {
      flag.value = debugGodWas;
      debugGodWas = null;
    }
  };

  const defs = {
    // The game's own invulnerability flag: every damage path ignores the player.
    god: {
      label: "无敌",
      hint: "角色不受任何伤害，辐射条满了也不会倒（游戏自带的无敌标记，持续维持）",
      every: 250,
      tick() {
        const hc = localHealth();
        if (hc && !hc.method("get_IsInvulnerable").invoke()) hc.method("set_IsInvulnerable").invoke(true);
        setDebugGod(true);
      },
      off() {
        setDebugGod(false);
        const hc = localHealth();
        if (hc) hc.method("set_IsInvulnerable").invoke(false);
      },
    },

    // Keep health and shield topped up (also works for non-damage drains).
    heal: {
      label: "锁定血量与护盾",
      hint: "血量和护盾始终保持满值",
      every: 100,
      tick() {
        const hc = localHealth();
        if (!hc || hc.method("get_IsDead").invoke()) return;
        const maxHealth = hc.method("get_MaxHealth").invoke();
        if (hc.method("get_Health").invoke() < maxHealth - 0.05) hc.method("SetHealth").invoke(maxHealth);
        const maxShield = hc.method("get_MaxShieldLevel").invoke();
        if (maxShield > 0 && hc.method("get_Shield").invoke() < maxShield - 0.05) hc.method("SetShield").invoke(maxShield);
      },
    },

    // Magazine and reserve of the weapon in hand stay full.
    ammo: {
      label: "无限弹药",
      hint: "手持武器的弹匣和备弹始终保持满值，无需换弹",
      every: 100,
      tick() {
        const p = JB.localPlayer();
        if (!p) return;
        const inst = p.field("m_ItemInstantiator").value;
        if (inst.isNull()) return;
        const fp = inst.field("m_FirstPersonItem").value;
        if (fp.isNull()) return;
        const pp = fp.field("m_PersistentPickupable").value;
        if (pp.isNull()) return;
        const bb = pp.field("m_PickupableItemBlackboardData").value;
        const magSize = bb.field("m_MagSize").value.method("get_Value").invoke();
        if (magSize > 0) {
          const inMag = bb.field("m_AmmoInMag").value;
          if (inMag.method("get_Value").invoke() < magSize) inMag.method("set_Value").invoke(magSize);
        }
        const getAmmo = fp.tryMethod("get_Ammo");
        const setAmmo = fp.tryMethod("set_Ammo");
        if (getAmmo && setAmmo) {
          const max = p.field("m_ItemHandler").value.method("get_MaxAmmo").invoke();
          if (max > 0 && getAmmo.invoke() < max) setAmmo.invoke(max);
        }
      },
    },
  };

  // --- ship cheats -------------------------------------------------------
  // The player ship's damage controller only exists while a ship is spawned (in a mission).
  let shipCache = null;
  let shipScanAt = 0;
  function shipDamageController() {
    const O = () => JB.U.cls("UnityEngine.Object").method("op_Implicit");
    if (shipCache) {
      try { if (O().invoke(shipCache)) return shipCache; } catch (e) { /* rescan */ }
      shipCache = null;
    }
    const now = Date.now();
    if (now - shipScanAt < 2000) return null; // scanning every tick would be wasteful
    shipScanAt = now;
    shipCache = JB.U.all("Playership_DamageController", false)[0] || null;
    return shipCache;
  }
  // The ship's own god mode: the damage controller's immunity check reads it, so neither the hull nor the core loses
  // health and no core life (death defiance) is used up. It is a networked flag of the ship, which only the host sets.
  const shipGodmode = () => {
    const dc = shipDamageController();
    return dc ? dc.field("m_Ship_StateBlackboardData").value.field("m_Godmode").value : null;
  };

  defs.ship = {
    label: "飞船无敌",
    hint: "飞船不受伤害，核心生命不会减少（飞船在任务中、你是房主时生效）",
    every: 500,
    tick() {
      const g = shipGodmode();
      if (g && !g.method("get_Value").invoke()) g.method("set_Value").invoke(true);
    },
    off() {
      const g = shipGodmode();
      if (g && g.method("get_Value").invoke()) g.method("set_Value").invoke(false);
    },
  };

  // Players who go down come back at the ship while it has respawns left. The ship counts the ones used up
  // (available = max − used) and the game itself resets that count whenever the ship loses a core life.
  const shipRespawnsUsed = () => {
    const dc = shipDamageController();
    return dc ? dc.field("m_Ship_StateBlackboardData").value.field("m_PlayerRespawns").value : null;
  };

  defs.revive = {
    label: "无限复活",
    hint: "倒下后的复活次数始终是满的（飞船在任务中、你是房主时生效）",
    every: 500,
    tick() {
      const used = shipRespawnsUsed();
      if (used && used.method("get_Value").invoke() > 0) used.method("set_Value").invoke(0);
    },
  };

  // Blocking shields (the walls opened by aiming materia guns at them) ask for a number of players — two, all but one or
  // all of them — which the game sets from the shield's rule whenever the number of living players changes. Keeping it at
  // one lets a single player open them the normal way; turning the cheat off puts the rule's number back.
  const isAlive = (o) => { try { return !!JB.U.cls("UnityEngine.Object").method("op_Implicit").invoke(o); } catch (e) { return false; } };
  let shieldCache = [];
  let shieldScanAt = 0;
  function shields() {
    const now = Date.now();
    if (now - shieldScanAt >= 2000) {
      shieldScanAt = now;
      shieldCache = JB.U.all("Keepsake.BlockingShield.MateriagunInteractionController", false);
    }
    return shieldCache.filter(isAlive);
  }
  const requiredPlayers = (c) => c.field("m_InteractionBlackboardData").value.field("m_RequiredPlayersInTotal").value;
  const shieldRules = new Map(); // shield handle -> the number of players its rule asked for

  defs.solo = {
    label: "单人开门",
    hint: "要几个人一起用物质枪才能打开的护盾门，你一个人就能打开（你是房主时生效）",
    every: 500,
    tick() {
      for (const c of shields()) {
        const required = requiredPlayers(c);
        const n = required.method("get_Value").invoke();
        if (n > 1) {
          shieldRules.set(c.handle.toString(), n);
          required.method("set_Value").invoke(1);
        }
      }
    },
    off() {
      for (const c of shields()) {
        const n = shieldRules.get(c.handle.toString());
        const required = requiredPlayers(c);
        if (n && required.method("get_Value").invoke() === 1) required.method("set_Value").invoke(n);
      }
      shieldRules.clear();
    },
  };

  // Everything the game rolls as loot with a rarity (weapons, gear, ship parts) becomes Legendary; see loot.js.
  defs.legendary = {
    label: "传说级掉落",
    hint: "掉落的武器、装备和飞船部件全是红色传说级；弹药、资源这类没有品质的物品不受影响（你是房主时生效）",
    every: 1000,
    tick() { JB.lootRarity.set(LEGENDARY); },
    off() { JB.lootRarity.set(null); },
  };

  defs.materia = {
    label: "无限飞船物质",
    hint: "飞船物质始终保持满值（复活队友、购买不再受限）",
    every: 500,
    tick() {
      const S = JB.U.cls("Keepsake.ShipMateriaController");
      const amount = S.method("get_GetShipMateriaAmount").invoke();
      const max = S.method("get_GetMaxMateria").invoke();
      if (!(max > 0) || amount >= max) return;
      const c = JB.U.all("Keepsake.ShipMateriaController", true).find((x) => JB.safe(() => x.method("get_NetworkObject").invoke().method("get_IsSpawned").invoke(), false));
      if (c) c.method("ModifyMateria").invoke(max - amount);
    },
  };

  // Damage of the weapon in hand, on top of whatever the game's own modifiers give it; see damage.js.
  const damage = createDamageBoost(JB);
  defs.damage = {
    label: "超级伤害",
    hint: "手里这把枪的伤害大幅提升，对敌人和敌方飞船都生效，只影响你自己的武器。倍率加在枪原有的伤害加成之上，实际略低于标称倍数；爆炸类武器对自己的伤害也可能放大，建议配合无敌",
    every: 100,
    param: { label: "倍率", min: 2, max: 100, step: 1, value: 10, unit: "×", presets: [5, 10, 50, 100] },
    tick: () => { damage.apply(defs.damage.param.value); },
    off: () => { damage.release(); },
  };

  // --- movement (multiplier cheats) --------------------------------------
  // Scaled on top of the character's base values; see movement.js for how this stays reversible.
  const speed = createScaler(JB, { props: ["WalkSpeed", "SprintBonusSpeed", "WalkSpeedAcceleration"] });
  const jump = createScaler(JB, { props: ["JumpHeight"] });

  defs.speed = {
    label: "移动速度",
    hint: "走路和冲刺速度按倍率提升（以角色基础速度为准，不受手持物减速影响）",
    every: 500,
    param: { label: "倍率", min: 1.25, max: 4, step: 0.25, value: 1.5, unit: "×", presets: [1.5, 2, 3] },
    tick: () => { speed.apply(defs.speed.param.value); },
    off: () => { speed.release(); },
  };

  defs.jump = {
    label: "跳跃力度",
    hint: "起跳力度按倍率提升，能跳得更高更远",
    every: 500,
    param: { label: "倍率", min: 1.25, max: 3, step: 0.25, value: 1.5, unit: "×", presets: [1.5, 2, 3] },
    tick: () => { jump.apply(defs.jump.param.value); },
    off: () => { jump.release(); },
  };

  // A crashed or hot-reloaded agent may have left multiplier entries on the character; clear them once.
  let leftoversChecked = false;
  function clearLeftovers() {
    if (leftoversChecked) return;
    try {
      const a = speed.clearLeftovers();
      const b = jump.clearLeftovers();
      if (a === null || b === null) return; // no character yet, try again later
      leftoversChecked = true;
      if (a + b > 0) console.log(`cleared ${a + b} leftover movement overrides`);
    } catch (e) {
      leftoversChecked = true; // a changed game API must not break the cheat list; the toggles report their own errors
      console.log(`leftover cleanup skipped: ${e}`);
    }
  }

  const enabled = new Set();

  function setParam(d, value) {
    const n = Number(value);
    if (!d.param) throw bridgeError("NO_PARAMETER", "这个功能没有可调数值");
    if (!Number.isFinite(n) || n < d.param.min - 1e-9 || n > d.param.max + 1e-9) throw bridgeError("INVALID_VALUE", `数值需要在 ${d.param.min}–${d.param.max} 之间`);
    d.param.value = Math.round(n / d.param.step) * d.param.step;
  }

  function setCheat(name, on, param) {
    const d = defs[name];
    if (!d) throw bridgeError("UNKNOWN_CHEAT", "未知的修改功能");
    if (param !== undefined && param !== null && param !== "") setParam(d, param);
    if (on) {
      enabled.add(name);
      addTicker("cheat:" + name, d.every, d.tick);
    } else {
      enabled.delete(name);
      removeTicker("cheat:" + name);
      if (d.off) {
        try { d.off(); } catch (e) { console.log(`cheat ${name} cleanup failed: ${e}`); }
      }
    }
  }

  function describe() {
    clearLeftovers();
    return Object.entries(defs).map(([name, d]) => {
      const t = JB.tickerInfo("cheat:" + name);
      return { name, label: d.label, hint: d.hint, enabled: enabled.has(name), runs: t ? t.runs : 0, error: t && t.lastError ? t.lastError : null, param: d.param ? { ...d.param } : null };
    });
  }

  JB.cheatSummary = () => Object.fromEntries(Object.keys(defs).map((n) => [n, enabled.has(n)]));
  JB.onDispose(() => { for (const n of [...enabled]) setCheat(n, false); });

  Object.assign(ex, {
    cheats: rpcSafe(() => onMain(() => ({ cheats: describe() }))),

    setCheat: rpcSafe((name, value, param) => onMain(() => {
      const on = value === true || value === "true" || value === "1" || value === 1;
      setCheat(String(name), on, param);
      return { cheats: describe() };
    })),

    // change the number of a running cheat (speed ×2 → ×3) without toggling it
    setCheatParam: rpcSafe((name, value) => onMain(() => {
      const key = String(name);
      const d = defs[key];
      if (!d) throw bridgeError("UNKNOWN_CHEAT", "未知的修改功能");
      setParam(d, value);
      if (enabled.has(key)) d.tick();
      return { cheats: describe() };
    })),

    // run a lock's action once without leaving it enabled ("heal now", "refill ammo now")
    cheatOnce: rpcSafe((name) => onMain(() => {
      const d = defs[String(name)];
      if (!d) throw bridgeError("UNKNOWN_CHEAT", "未知的修改功能");
      if (!JB.localPlayer()) throw bridgeError("NO_PLAYER", "当前没有可操作的本机角色");
      d.tick();
      return { cheats: describe() };
    })),
  });
}

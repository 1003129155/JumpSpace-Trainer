// Currencies (credits / ingots), player experience and the in-run ship materia.
// All values are written through the game's own MetaProgressionManager so UI,
// events and the save file stay consistent.
export function installProgression(JB, ex) {
  const { U, onMain, safe, bridgeError, rpcSafe } = JB;
  const MPM = () => U.cls("Keepsake.MetaProgression.MetaProgressionManager");

  function profileReady() {
    return !!safe(() => MPM().method("get_InitialDataSuccessfullyLoaded").invoke(), false);
  }

  function requireProfile() {
    if (!profileReady()) throw bridgeError("PROFILE_NOT_READY", "本机存档尚未加载完成，请先进入游戏（大厅或飞船内）再试");
  }

  function parseInteger(value, label) {
    const s = String(value ?? "").trim();
    if (!/^-?\d{1,12}$/.test(s)) throw bridgeError("INVALID_AMOUNT", `${label}必须是整数`);
    return Number(s);
  }

  function colorHex(c) {
    const f = (n) => Math.max(0, Math.min(255, Math.round(n * 255))).toString(16).padStart(2, "0");
    return "#" + f(c.field("r").value) + f(c.field("g").value) + f(c.field("b").value);
  }

  // [{ row, obj }] — credits first, then the ingot tiers in game order.
  function currencyEntries() {
    const M = MPM();
    const list = [M.method("get_CreditsCurrency").invoke()];
    const ingots = M.method("get_IngotCurrencies").invoke();
    const n = ingots.method("get_Count").invoke();
    for (let i = 0; i < n; i++) list.push(ingots.method("get_Item").invoke(i));
    const seen = new Set();
    const out = [];
    for (const c of list) {
      if (c.isNull()) continue;
      const guid = c.field("m_AssetGUID").value.content;
      if (seen.has(guid)) continue;
      seen.add(guid);
      out.push({
        obj: c,
        row: {
          guid,
          name: U.name(c),
          display: safe(() => c.field("m_DisplayName").value.method("GetLocalizedString").invoke().content, "") || U.name(c),
          group: String(c.field("m_CurrencyGroup").value),
          amount: M.method("GetCurrency").invoke(c),
          max: c.field("m_MaxAmount").value,
          color: safe(() => colorHex(c.field("m_Color").value), "#9aa4b2"),
          order: out.length,
        },
      });
    }
    return out;
  }

  function findCurrency(query) {
    const q = String(query ?? "").trim().toLowerCase();
    const hit = currencyEntries().find((e) => e.row.guid.toLowerCase() === q || e.row.name.toLowerCase() === q);
    if (!hit) throw bridgeError("CURRENCY_NOT_FOUND", "未找到这个货币，请刷新后重试");
    return hit;
  }

  function experience() {
    const M = MPM();
    return {
      level: M.method("get_Level").invoke().method("get_Value").invoke(),
      exp: M.method("get_Experience").invoke().method("get_Value").invoke(),
      toNext: safe(() => M.method("get_ExperienceToNextLevel").invoke(), null),
      rank: safe(() => M.method("get_PlayerRankString").invoke().content, ""),
    };
  }

  function materia() {
    const S = U.cls("Keepsake.ShipMateriaController");
    return { amount: S.method("get_GetShipMateriaAmount").invoke(), max: S.method("get_GetMaxMateria").invoke() };
  }

  function materiaController() {
    const c = U.all("Keepsake.ShipMateriaController", true).find((x) => safe(() => x.method("get_NetworkObject").invoke().method("get_IsSpawned").invoke(), false));
    if (!c) throw bridgeError("SHIP_NOT_READY", "当前没有可用的飞船（需要在飞船任务/大厅场景中）");
    return c;
  }

  // The game saves on its own schedule; ask for a save shortly after our edits
  // (coalesced so a burst of clicks produces one save).
  let saveTimer = null;
  function requestSave() {
    if (saveTimer) return true;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      onMain(() => MPM().method("SaveDataToCloud").invoke()).catch((e) => console.log("save request failed: " + e));
    }, 800);
    return true;
  }
  JB.onDispose(() => { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } });

  function writeCurrency(query, compute) {
    requireProfile();
    const { row, obj } = findCurrency(query);
    const M = MPM();
    const before = M.method("GetCurrency").invoke(obj);
    const requested = compute(before, row);
    const target = Math.max(0, Math.min(row.max, requested));
    if (target !== before) M.method("SetCurrency").invoke(obj, target);
    const after = M.method("GetCurrency").invoke(obj);
    if (after !== target) throw bridgeError("CURRENCY_UNCONFIRMED", `写入后读回为 ${after}，与目标 ${target} 不一致，请在游戏中确认`);
    const saveRequested = target !== before ? requestSave() : false;
    return { currency: { ...row, amount: after }, before, after, requested, clamped: requested !== target, changed: after !== before, saveRequested };
  }

  Object.assign(ex, {
    // everything the "currency & progress" page needs
    progression: rpcSafe(() => onMain(() => {
      const out = { ready: profileReady(), currencies: [], experience: null, materia: null, saveId: null };
      if (out.ready) {
        out.currencies = currencyEntries().map((e) => e.row);
        out.experience = experience();
        out.saveId = safe(() => MPM().method("get_SaveFileGuid").invoke().method("get_Value").invoke().content, null);
      }
      out.materia = safe(() => materia(), null);
      return out;
    })),

    setCurrency: rpcSafe((guid, amount) => onMain(() => {
      const n = parseInteger(amount, "数量");
      return writeCurrency(guid, () => n);
    })),

    addCurrency: rpcSafe((guid, delta) => onMain(() => {
      const d = parseInteger(delta, "增减数量");
      return writeCurrency(guid, (before) => before + d);
    })),

    addExperience: rpcSafe((amount) => onMain(() => {
      requireProfile();
      const n = parseInteger(amount, "经验值");
      if (n < 1 || n > 1000000) throw bridgeError("INVALID_AMOUNT", "经验值必须在 1–1000000 之间");
      const before = experience();
      MPM().method("AddExperience").invoke(n);
      requestSave();
      return { before, after: experience(), added: n, saveRequested: true };
    })),

    // raise the player level by `levels` (1–10), one level at a time
    levelUp: rpcSafe((levels) => onMain(() => {
      requireProfile();
      const n = parseInteger(levels, "等级数");
      if (n < 1 || n > 10) throw bridgeError("INVALID_AMOUNT", "一次最多提升 10 级");
      const M = MPM();
      const before = experience();
      let added = 0;
      for (let i = 0; i < n; i++) {
        const cur = experience();
        const need = M.method("GetExperienceToNextLevelFrom").invoke(cur.level) - cur.exp;
        if (need <= 0) break;
        M.method("AddExperience").invoke(need);
        added += need;
        if (experience().level <= cur.level) break; // the game refused (max level?) — stop instead of looping
      }
      requestSave();
      return { before, after: experience(), added, saveRequested: true };
    })),

    // set the in-run ship materia (clamped to 0..max)
    setMateria: rpcSafe((amount) => onMain(() => {
      const n = parseInteger(amount, "数量");
      return writeMateria(() => n);
    })),

    // change the in-run ship materia by `delta` (clamped to 0..max)
    addMateria: rpcSafe((delta) => onMain(() => {
      const d = parseInteger(delta, "增减数量");
      return writeMateria((before) => before + d);
    })),
  });

  function writeMateria(compute) {
    JB.requireServer();
    const before = materia();
    const requested = compute(before.amount);
    const target = Math.max(0, Math.min(before.max, requested));
    if (target !== before.amount) materiaController().method("ModifyMateria").invoke(target - before.amount);
    const after = materia();
    return { before, after, requested, clamped: target !== requested, changed: after.amount !== before.amount };
  }
}

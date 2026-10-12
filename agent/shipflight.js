// Ship handling multipliers. The player ship's speed, acceleration, turning and boost are plain numbers of its movement
// settings asset (ShipMoveSettings_Playership), not stats; the boost's duration and recharge sit on the engine's data.
// Engine upgrades are applied by the game on top of these, so scaling the base scales them too.
import { createFieldScaler } from "./fieldscale.js";

export const SHIP_GROUPS = {
  speed: { settings: ["m_MoveSpeed", "m_MovementAccelerationSpeed", "m_ThrottleAccelerationSpeed", "m_StrafeSpeed", "m_ReverseSpeed"] },
  turn: { settings: ["m_RotateAcceleration", "m_TurnSpeedHorizontal", "m_TurnSpeedVertical", "m_RollSpeed"] },
  // a longer boost with a shorter wait, as well as a faster one
  boost: { settings: ["m_PlayershipBoostSpeed", "m_DoubleBoostMaxSpeed", "m_BoostForwardAccelerationMultiplier"], engine: { mul: ["m_BoostTime"], div: ["m_BoostRechargeTime"] } },
};

export function createShipTuner(JB, group) {
  const { U, safe } = JB;
  const scaler = createFieldScaler(JB);

  const playerShip = () => {
    const ship = U.cls("Global").method("get_PlayerShipRef").invoke();
    return ship.isNull() ? null : ship;
  };

  // the main engines of the player's ship (a scene can hold other ships'); all of them if the ship cannot tell
  function engineData(ship) {
    const out = [];
    const root = safe(() => ship.method("get_transform").invoke(), null);
    for (const engine of U.all("Spaceship_MainEngine", false)) {
      const mine = !root || safe(() => engine.method("get_transform").invoke().method("IsChildOf").invoke(root), true);
      if (!mine) continue;
      const data = engine.method("get_EngineData").invoke();
      if (!data.isNull()) out.push(data);
    }
    return out;
  }

  return {
    // false while there is no player ship (not in a mission)
    apply(factor) {
      const ship = playerShip();
      if (!ship) return false;
      const settings = ship.method("get_ship_playerController").invoke().field("m_MoveSettings_Playership").value;
      const items = settings.isNull() ? [] : group.settings.map((field) => ({ obj: settings, field, mode: "mul" }));
      if (group.engine) {
        for (const data of engineData(ship)) {
          for (const field of group.engine.mul) items.push({ obj: data, field, mode: "mul" });
          for (const field of group.engine.div) items.push({ obj: data, field, mode: "div" });
        }
      }
      scaler.apply(items, factor);
      return true;
    },
    release: () => scaler.release(),
  };
}

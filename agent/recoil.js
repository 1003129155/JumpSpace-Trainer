// No spread / no recoil: zero the parts of the weapon's own recoil data that make them.
//
// CameraRecoil keeps the RecoilData of the weapon in hand. Its spread is (default spread + movement, look, crouch, in-air
// and per-shot parts) ÷ accuracy, not below the data's minimum; the camera kick of a shot is the data's pattern × its
// default or aimed-down-sights modifier. The accuracy stat is asked about every frame, so it is left alone and the data
// is changed instead. The data is a shared asset: the originals are put back when the cheat is switched off.
import { createFieldScaler } from "./fieldscale.js";

export const SPREAD_FIELDS = ["m_DefaultSpread", "m_DefaultSpreadMin", "m_ShootModifier", "m_MovementModifier", "m_CrouchModifier", "m_InAirModifier", "m_LookModifier"];
export const KICK_FIELDS = ["m_DefaultRecoilModifier", "m_ADSRecoilModifier"];

export function createRecoilControl(JB, fields) {
  const scaler = createFieldScaler(JB);
  return {
    apply() {
      const items = [];
      for (const recoil of JB.U.all("Keepsake.CameraRecoil", false)) {
        const data = recoil.field("m_RecoilData").value;
        if (data.isNull()) continue;
        for (const field of fields) items.push({ obj: data, field, mode: "zero" });
      }
      scaler.apply(items, 0);
    },
    release: () => scaler.release(),
  };
}

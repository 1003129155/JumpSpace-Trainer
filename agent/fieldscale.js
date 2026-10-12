// Scales plain number fields of game objects (settings assets, data objects) and puts the originals back.
//
// An original is remembered the first time a field is seen on an object, never read again while the entry exists, so a
// value that was already scaled is never scaled twice. The settings are assets shared by every user of them, and the
// game may reload one: a reloaded object has a new handle, gets its own entry and its own original.
const TOLERANCE = 1e-5;

export function createFieldScaler(JB) {
  const saved = new Map(); // "handle|field" -> { obj, pin, field, original }

  const target = (original, mode, factor) => (mode === "zero" ? 0 : mode === "div" ? original / factor : original * factor);

  return {
    // items: [{ obj, field, mode }], mode "mul" | "div" | "zero"; the field becomes original × factor, original ÷ factor or 0
    apply(items, factor) {
      for (const { obj, field, mode } of items) {
        const key = `${obj.handle}|${field}`;
        let entry = saved.get(key);
        if (!entry) {
          entry = { obj, pin: obj.ref(false), field, original: obj.field(field).value };
          saved.set(key, entry);
        }
        const want = target(entry.original, mode, factor);
        const now = obj.field(field).value;
        if (Math.abs(now - want) > Math.max(TOLERANCE, Math.abs(want) * TOLERANCE)) obj.field(field).value = want;
      }
    },

    // put every remembered original back (an object the game has already dropped is skipped) and forget them
    release() {
      let restored = 0;
      for (const entry of saved.values()) {
        try {
          entry.obj.field(entry.field).value = entry.original;
          restored++;
        } catch (e) { /* the object is gone with its scene */ }
      }
      saved.clear();
      return restored;
    },

    size: () => saved.size,
  };
}

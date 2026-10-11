// Shared fakes for the agent module tests: a minimal stand-in for the game object model (no game, no Frida).
export const bridgeError = (code, message) => Object.assign(new Error(message), { code });
export const safe = (f, d = "?") => { try { return f(); } catch { return d; } };

// an object whose methods/fields come from plain JS values or functions
export function fake(methods = {}, fields = {}) {
  const obj = {
    handle: { id: Symbol("handle"), equals(other) { return other === this || other.id === this.id; } },
    isNull: () => false,
    method: (name) => ({
      invoke: (...args) => {
        if (!(name in methods)) throw new Error(`fake: no method ${name}`);
        const m = methods[name];
        return typeof m === "function" ? m(...args) : m;
      },
    }),
    tryMethod: (name) => (name in methods ? obj.method(name) : undefined),
    field: (name) => ({ value: fields[name] }),
  };
  return obj;
}
export const str = (content) => ({ content, isNull: () => false });

export function rpcSafe(fn) {
  return async (...args) => {
    try {
      return JSON.stringify({ ok: true, ...((await fn(...args)) || {}) });
    } catch (e) {
      return JSON.stringify({ ok: false, error: { code: e.code || "GAME_ERROR", message: e.message } });
    }
  };
}

export function baseJB(overrides = {}) {
  const tickers = new Map();
  const disposers = [];
  return {
    safe, bridgeError, rpcSafe,
    onMain: async (fn) => fn(),
    delay: () => Promise.resolve(),
    addTicker: (name, every, fn) => tickers.set(name, { name, every, fn, runs: 0, lastError: null }),
    removeTicker: (name) => tickers.delete(name),
    tickerInfo: (name) => tickers.get(name) || null,
    onDispose: (fn) => disposers.push(fn),
    requireServer: () => {},
    _tickers: tickers,
    _disposers: disposers,
    ...overrides,
  };
}

globalThis.Il2Cpp = { string: (x) => x, unityVersion: "test" };
globalThis.Memory = { alloc: () => ({}) };

// call an RPC export and parse its JSON reply
export const call = async (ex, name, ...args) => JSON.parse(await ex[name](...args));

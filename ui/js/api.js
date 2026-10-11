// Thin client for the local trainer server. Every call resolves to a plain
// object: {ok:true,...} or {ok:false,error:{code,message}} — it never throws.
const TOKEN = document.querySelector('meta[name="jb-token"]').content;

let inflight = 0;
const listeners = new Set();
export const onBusy = (fn) => listeners.add(fn);
function busy(delta) {
  inflight += delta;
  listeners.forEach((fn) => fn(inflight > 0));
}

async function request(path, options = {}) {
  busy(1);
  try {
    const res = await fetch(path, {
      ...options,
      headers: { "X-JB-Token": TOKEN, "Content-Type": "application/json", ...(options.headers || {}) },
    });
    const data = await res.json().catch(() => null);
    if (!data) return { ok: false, error: { code: "BAD_RESPONSE", message: `服务端返回了无法识别的内容（HTTP ${res.status}）` } };
    return data;
  } catch (e) {
    return { ok: false, error: { code: "OFFLINE", message: "无法连接修改器后台，请确认修改器仍在运行" } };
  } finally {
    busy(-1);
  }
}

export const get = (path) => request(path);
export const post = (path, body = {}) => request(path, { method: "POST", body: JSON.stringify(body) });
export const rpc = (method, ...args) => post("/api/rpc", { method, args });

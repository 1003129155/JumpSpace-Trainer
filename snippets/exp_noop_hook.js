// EXPERIMENT (test games only): a bare native hook on RunCore that never calls into JS.
// Used to find out whether the quit-time crash needs JS at all. Run `jsc.py quiesce` first so only this hook exists.
(() => {
  if (globalThis.__exp) return "already installed";
  const m = Il2Cpp.domain.assembly("UniTask").image.class("Cysharp.Threading.Tasks.Internal.PlayerLoopRunner").method("RunCore", 0);
  const cm = new CModule("#include <gum/guminterceptor.h>\nvoid onEnter (GumInvocationContext * ic) { }");
  globalThis.__exp = { cm, hook: Interceptor.attach(m.virtualAddress, { onEnter: cm.onEnter }) };
  return "installed a no-op native hook @ " + m.virtualAddress;
})()

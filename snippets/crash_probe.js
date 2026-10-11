// DEV ONLY — crash forensics. Appends one JSON line to out/crashprobe.txt for every access violation / stack overflow that
// Frida's exceptor sees (it hooks the exception dispatcher, so it sees them before the process's own handlers), with the
// registers, a fuzzy backtrace and the top of the stack, plus a module map to resolve addresses offline.
// It never handles anything: the handler returns false so the process behaves exactly as without the probe.
// The game process writes the file, so it needs an absolute path; set it first:
//   jsc.py evalFree "globalThis.CRASHPROBE_PATH = String.raw`<this folder>\out\crashprobe.txt`"
//   jsc.py evalFree @snippets/crash_probe.js
(() => {
  if (globalThis.__crashProbe) return "already installed";
  const OUT = globalThis.CRASHPROBE_PATH;
  if (!OUT) return "set globalThis.CRASHPROBE_PATH to an absolute file path first";
  const file = new File(OUT, "a");
  const lines = ["# module map (probe installed at " + new Date().toISOString() + ")"];
  for (const m of Process.enumerateModules()) lines.push(`MOD ${m.base} ${m.size} ${m.name}`);
  file.write(lines.join("\n") + "\n");
  file.flush();
  let seen = 0;
  Process.setExceptionHandler((d) => {
    if (seen++ >= 12) return false;
    try {
      const c = d.context;
      const regs = {};
      for (const r of ["rip", "rsp", "rbp", "rax", "rcx", "rdx", "rbx", "rsi", "rdi", "r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15"]) regs[r] = String(c[r]);
      let bt = [];
      try { bt = Thread.backtrace(c, Backtracer.FUZZY).map(String); } catch (e) { bt = ["backtrace failed: " + e]; }
      const stack = [];
      try {
        const sp = c.rsp;
        for (let i = 0; i < 64; i++) stack.push(String(sp.add(i * 8).readPointer()));
      } catch (e) { stack.push("stack unreadable: " + e); }
      file.write(JSON.stringify({ t: Date.now(), tid: Process.getCurrentThreadId(), type: d.type, address: String(d.address), memory: d.memory ? { op: d.memory.operation, address: String(d.memory.address) } : null, regs, bt, stack }) + "\n");
      file.flush();
    } catch (e) {
      try { file.write("probe failed: " + e + "\n"); file.flush(); } catch (e2) { /* nothing more to do */ }
    }
    return false;
  });
  globalThis.__crashProbe = { file };
  return "crash probe installed, writing to " + OUT;
})()

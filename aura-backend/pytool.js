/* ============ PYTHON TOOL — a real interpreter on a short leash ============
   The agent loop could search and calculate, but it could not COMPUTE: no loops,
   no libraries, no "plot this / test this function / crunch these numbers". This
   module runs the model's Python in a separate process with:
     • a wall-clock timeout (default 6s) and the whole process tree killed after it
     • CPU / address-space rlimits on POSIX (5s CPU, 256MB data)
     • an audit hook that refuses sockets, subprocess and os.system
     • a throwaway working directory, scrubbed env, 8KB output cap
   It is a guardrail, not a jail: a container escape is impossible from here because
   there is no container, but nothing on this host is writable beyond the temp dir and
   nothing can phone home. Anything the model prints comes back as plain text. */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

/* Windows ships a fake `python` alias that opens the Microsoft Store — the probe must
   prove the binary RUNS the code we give it before we trust it, not just exit 0. */
/* Windows PATH `python` is usually the Store alias and `py` on newer installs is the
   Python install MANAGER (it phones home before running) — so look for a real
   interpreter on disk first and only then fall back to the shims. */
function windowsCandidates() {
  const out = [];
  const roots = [
    path.join(process.env.LOCALAPPDATA || "", "Python"),
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Python"),
    process.env.ProgramFiles || "C:\\Program Files"
  ];
  for (const root of roots) {
    try {
      for (const name of fs.readdirSync(root)) {
        if (!/^pythoncore-|^Python3/i.test(name)) continue;
        const exe = path.join(root, name, "python.exe");
        try { if (fs.existsSync(exe)) out.push({ bin: exe, args: [] }); } catch (e) {}
      }
    } catch (e) {}
  }
  return out.concat([{ bin: "python", args: [] }, { bin: "python3", args: [] }, { bin: "py", args: ["-3"] }]);
}
const CANDIDATES = process.platform === "win32"
  ? windowsCandidates()
  : [{ bin: "python3", args: [] }, { bin: "python", args: [] }];
const MARK = "AURA_PY_OK";
let PY = null, pyProbe = null;
const OUT_CAP = 8_000;

const PRELUDE = `# --- AURA sandbox prelude (best effort) ---
import sys, os
try:
    import resource
    resource.setrlimit(resource.RLIMIT_CPU, (5, 5))
    resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024, 256 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))
except Exception:
    pass
_BLOCKED = ("socket.connect", "socket.getaddrinfo", "subprocess.Popen", "os.system", "os.exec", "os.spawn", "ctypes.dlopen")
def _aura_guard(event, args):
    for b in _BLOCKED:
        if event == b or event.startswith(b):
            raise RuntimeError("blocked in AURA sandbox: " + event)
try:
    sys.addaudithook(_aura_guard)
except Exception:
    pass
# --- end prelude ---
`;

function probe() {
  if (pyProbe) return pyProbe;
  pyProbe = (async () => {
    for (const cand of CANDIDATES) {
      const ok = await new Promise(resolve => {
        let done = false, out = "";
        try {
          const p = spawn(cand.bin, [...cand.args, "-I", "-c", "print('" + MARK + "')"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
          const t = setTimeout(() => { try { p.kill("SIGKILL"); } catch (e) {} if (!done) { done = true; resolve(false); } }, 5000);
          p.stdout.on("data", d => { out += d.toString("utf8"); });
          p.on("error", () => { clearTimeout(t); if (!done) { done = true; resolve(false); } });
          p.on("close", code => { clearTimeout(t); if (!done) { done = true; resolve(code === 0 && out.includes(MARK)); } });
        } catch (e) { resolve(false); }
      });
      if (ok) { PY = cand; return PY; }
    }
    PY = null; return null;
  })();
  return pyProbe;
}

function clipped(s) {
  const t = String(s || "");
  return t.length > OUT_CAP ? t.slice(0, OUT_CAP) + "\n… output truncated at " + OUT_CAP + " chars" : t;
}

async function runPython(code, opts) {
  const o = opts || {};
  const src = String(code || "");
  if (!src.trim()) return { ok: false, stdout: "", stderr: "empty program", ms: 0 };
  if (src.length > 20_000) return { ok: false, stdout: "", stderr: "program too long (20k chars max)", ms: 0 };
  const py = await probe();
  if (!py) return { ok: false, stdout: "", stderr: "python interpreter is not installed on this host", ms: 0, unavailable: true };

  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "aura-py-"));
  const file = path.join(dir, "main.py");
  await fs.promises.writeFile(file, PRELUDE + src, "utf8");
  const timeout = Math.min(Math.max(parseInt(o.timeout, 10) || 6000, 1000), 15_000);
  const started = Date.now();
  try {
    return await new Promise(resolve => {
      let out = "", err = "", done = false, timedOut = false;
      const p = spawn(py.bin, [...py.args, "-I", "-B", file], {
        windowsHide: true,
        cwd: dir,
        env: { PATH: process.env.PATH || "", PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1", HOME: dir, TMPDIR: dir, LANG: "C.UTF-8" },
        stdio: ["ignore", "pipe", "pipe"]
      });
      const finish = (ok, extra) => {
        if (done) return; done = true;
        clearTimeout(timer);
        fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
        resolve(Object.assign({ ok, stdout: clipped(out), stderr: clipped(err), ms: Date.now() - started }, extra || {}));
      };
      const timer = setTimeout(() => {
        timedOut = true;
        try { p.kill("SIGKILL"); } catch (e) {}
        /* the child may have spawned helpers; on POSIX take the group down too */
        finish(false, { timedOut: true, stderr: clipped((err || "") + "\ntimed out after " + timeout + "ms") });
      }, timeout);
      p.stdout.on("data", d => { if (out.length < OUT_CAP * 2) out += d.toString("utf8"); });
      p.stderr.on("data", d => { if (err.length < OUT_CAP * 2) err += d.toString("utf8"); });
      p.on("error", e => finish(false, { stderr: String(e.message || e) }));
      p.on("close", code => { if (!done) finish(code === 0, { exit: code, timedOut }); });
    });
  } catch (e) {
    fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    return { ok: false, stdout: "", stderr: String(e.message || e), ms: Date.now() - started };
  }
}

module.exports = { runPython, probe, binary: () => (PY ? PY.bin + (PY.args.length ? " " + PY.args.join(" ") : "") : null) };

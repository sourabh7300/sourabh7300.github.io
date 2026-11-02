/* Mesh e2e: exercises the whole relay the way the browser does.
   Run: PORT must point at a live server; exits non-zero on the first failure. */
const BASE = process.env.BASE || "http://127.0.0.1:4711";
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra !== undefined ? " → " + JSON.stringify(extra) : "")); }
}
async function call(path, body, method) {
  const r = await fetch(BASE + path, {
    method: method || "POST",
    headers: { "Content-Type": "application/json", "Origin": BASE },
    body: method === "GET" ? undefined : JSON.stringify(body || {})
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
}
(async () => {
  console.log("mesh e2e against " + BASE);

  /* ---- owner claims a code ---- */
  const reg = await call("/v1/mesh/register", {});
  ok("register → 200 + 6-digit code", reg.status === 200 && /^\d{6}$/.test(reg.j.code), reg);
  const code = reg.j.code;

  /* re-register keeps the same code (owner reconnect must not orphan devices) */
  const reg2 = await call("/v1/mesh/register", { code });
  ok("re-register keeps the same code", reg2.j.code === code, reg2.j);

  /* ---- node joins ---- */
  const join = await call("/v1/mesh/join", { code, nodeId: "n1", name: "Pixel", battery: 77, charging: true, net: "4g" });
  ok("join → 200", join.status === 200 && join.j.ok, join);

  const badCode = await call("/v1/mesh/join", { code: "000000", nodeId: "n1", name: "x" });
  ok("join with a wrong code → 404", badCode.status === 404, badCode);

  /* ---- poll: heartbeat + auto-rejoin ---- */
  const p1 = await call("/v1/mesh/poll", { code, nodeId: "n1", battery: 76, seen: [] });
  ok("poll → 200, no commands yet", p1.status === 200 && p1.j.cmds.length === 0, p1.j);
  ok("poll reports peers=1", p1.j.peers === 1, p1.j);

  const pGhost = await call("/v1/mesh/poll", { code, nodeId: "ghost", name: "Ghost", seen: [] });
  ok("unknown node auto-rejoins instead of erroring", pGhost.status === 200 && pGhost.j.rejoined === true, pGhost.j);
  const leaveGhost = await call("/v1/mesh/leave", { code, nodeId: "ghost" });
  ok("leave → 200", leaveGhost.status === 200 && leaveGhost.j.ok, leaveGhost);

  /* ---- command reaches the node ---- */
  const cmd = await call("/v1/mesh/command", { code, nodeId: "all", cmd: "speak", arg: "hello node" });
  ok("command → queued 1", cmd.status === 200 && cmd.j.queued === 1, cmd.j);

  const p2 = await call("/v1/mesh/poll", { code, nodeId: "n1", seen: [] });
  const first = (p2.j.cmds || [])[0];
  ok("poll delivers the command with an id", !!first && first.cmd === "speak" && typeof first.id === "number", p2.j);

  /* no ack yet → it must be re-delivered (a lost response loses nothing) */
  const p3 = await call("/v1/mesh/poll", { code, nodeId: "n1", seen: [] });
  ok("unacked command is re-delivered", (p3.j.cmds || []).length === 1 && p3.j.cmds[0].id === first.id, p3.j);

  /* ack → it is gone, and never comes back */
  const p4 = await call("/v1/mesh/poll", { code, nodeId: "n1", seen: [first.id] });
  ok("acked command is dropped", (p4.j.cmds || []).length === 0, p4.j);

  /* ---- result ring is cursor-based, not destructive ---- */
  const res1 = await call("/v1/mesh/result", { code, nodeId: "n1", name: "Pixel", cmd: "speak", ok: true, detail: "spoke", id: first.id });
  ok("result → 200", res1.status === 200, res1);
  const dup = await call("/v1/mesh/result", { code, nodeId: "n1", name: "Pixel", cmd: "speak", ok: true, detail: "spoke", id: first.id });
  ok("duplicate result is deduped", dup.j.dup === true, dup.j);

  const st1 = await call("/v1/mesh/state?code=" + code + "&since=0", null, "GET");
  ok("state → 1 device, 1 result", st1.j.devices.length === 1 && st1.j.results.length === 1, st1.j);
  ok("state device is fresh with battery/rtt fields", st1.j.devices[0].fresh === true && st1.j.devices[0].battery === 76 && "rtt" in st1.j.devices[0], st1.j.devices);

  const st2 = await call("/v1/mesh/state?code=" + code + "&since=" + st1.j.cursor, null, "GET");
  ok("reading again does NOT clear results", st2.j.results.length === 0 && st2.j.cursor === st1.j.cursor, st2.j);

  /* ---- targeted command ---- */
  await call("/v1/mesh/join", { code, nodeId: "n2", name: "iPhone" });
  const t1 = await call("/v1/mesh/command", { code, nodeId: "n2", cmd: "flash", arg: "" });
  ok("targeted command queues only for n2", t1.j.queued === 1, t1.j);
  const n1poll = await call("/v1/mesh/poll", { code, nodeId: "n1", seen: [] });
  const n2poll = await call("/v1/mesh/poll", { code, nodeId: "n2", seen: [] });
  ok("n1 got nothing, n2 got the flash", n1poll.j.cmds.length === 0 && n2poll.j.cmds.length === 1 && n2poll.j.cmds[0].cmd === "flash", { n1: n1poll.j.cmds, n2: n2poll.j.cmds });

  /* ---- rename / kick ---- */
  const ren = await call("/v1/mesh/rename", { code, nodeId: "n2", name: "Sourabh iPhone" });
  ok("rename works", ren.j.name === "Sourabh iPhone", ren.j);
  const kick = await call("/v1/mesh/kick", { code, nodeId: "n2" });
  ok("kick removes the device", kick.j.kicked === 1, kick.j);
  const st3 = await call("/v1/mesh/state?code=" + code + "&since=0", null, "GET");
  ok("state no longer lists the kicked device", st3.j.devices.every(d => d.id !== "n2"), st3.j.devices);

  /* ---- empty-mesh command is a no-op, not an error ---- */
  await call("/v1/mesh/kick", { code, nodeId: "all" });
  const empty = await call("/v1/mesh/command", { code, nodeId: "all", cmd: "ping" });
  ok("command with no nodes → 200 queued 0", empty.status === 200 && empty.j.queued === 0, empty.j);

  /* ---- a backgrounded node is away, not gone ---- */
  await call("/v1/mesh/join", { code, nodeId: "n3", name: "Background tab" });
  await call("/v1/mesh/poll", { code, nodeId: "n3", seen: [], vis: false });
  const awayState = await call("/v1/mesh/state?code=" + code + "&since=0", null, "GET");
  const n3 = awayState.j.devices.find(d => d.id === "n3");
  ok("backgrounded node is listed as away:true", !!n3 && n3.away === true, n3);
  ok("away node is not counted as fresh", !!n3 && n3.fresh === false, n3);
  await call("/v1/mesh/poll", { code, nodeId: "n3", seen: [], vis: true });
  const backState = await call("/v1/mesh/state?code=" + code + "&since=0", null, "GET");
  const n3b = backState.j.devices.find(d => d.id === "n3");
  ok("returning to the foreground makes it fresh again", !!n3b && n3b.fresh === true && n3b.away === false, n3b);

  /* ---- close releases the code ---- */
  const cl = await call("/v1/mesh/close", { code });
  ok("close → closed:true", cl.j.closed === true, cl.j);
  const gone = await call("/v1/mesh/poll", { code, nodeId: "n1", seen: [] });
  ok("poll after close → 404 mesh-closed", gone.status === 404, gone);

  /* ---- restart-safe: a fresh code still works ---- */
  const reg3 = await call("/v1/mesh/register", {});
  ok("a new mesh can be claimed after close", reg3.status === 200 && reg3.j.code !== code, reg3.j);

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("harness error: " + e.message); process.exit(2); });

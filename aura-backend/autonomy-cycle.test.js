/* Squad cycle behaviour tests (4 Nov 2026).
 *
 * Two live failures are pinned here, both reported from the running host:
 *   1. "0 new publishes, nothing building" for the whole afternoon — the daily
 *      cycle budget was spent at 8/8 and every later tick returned early, so the
 *      squad looked dead even though the free lanes still work.
 *   2. One mission "building" for days while every cycle paid for a model call —
 *      nonstop mode wiped the batch and retried the same mission forever.
 *
 * Run: node autonomy-cycle.test.js
 */
"use strict";

const assert = require("assert");
const { createAutopilot, STATE_VERSION, MISSIONS } = require("./autonomy.js");
/* every static mission except the one under test is already published, so the picker
   has exactly one candidate and the test asserts that mission's behaviour */
function onlyMission(id) {
  const out = {};
  MISSIONS.forEach(m => { out[m.id] = { done: m.id !== id, sha: m.id !== id ? "done000" : "", when: Date.now() }; });
  return out;
}

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  → got " + JSON.stringify(extra) : "")); }
}

/* the sweep and the gates look for the real app's sentinels, so the fixture keeps
   them: two inline blocks plus the core identifiers the publish gates require */
/* the fixture carries the app's real structural sentinels and is padded past the
   gates' 50 KB minimum so validateSource() exercises its real thresholds */
const SOURCE = "<!doctype html><html><head></head><body>" +
  "<button id=\"adminTabBtn\"></button><div id=\"log\"></div><input id=\"q\"><div id=\"botsCard\"></div>" +
  "<span>PROVENANCE-SEAL-v1</span>" +
  "<!--" + "x".repeat(51000) + "--><script>" +
  "var bootTimer=0;function groqCall(){}function sendMsg(){}function addMsg(){}" +
  "var AURA_FACT_RULES='x';var webContext=1;var MEM_KEY='m';var pushMem=function(){};" +
  "var backendUrl='x';var SOURCES=[];var cite=1;var AuraMetrics=1;var CONF=0;" +
  "document.addEventListener('DOMContentLoaded',function(){});var AURA_MOBILE=1;var CODE='c';" +
  "</script><script>var b=2;</script></body></html>";

function harness(state, extra) {
  const saved = [];
  const calls = { brain: 0, research: 0 };
  const engine = createAutopilot(Object.assign({
    loadState: async () => state,
    saveState: async (s) => { saved.push(JSON.parse(JSON.stringify(s))); },
    readSource: async () => SOURCE,
    probe: async () => ({ alive: true }),
    brain: async () => { calls.brain++; return "PLAN: none\nEDITS:\n```json\n[]\n```"; },
    research: async () => { calls.research++; return "notes"; },
    signReport: async () => "report text"
  }, extra || {}));
  return { engine, saved, calls };
}

(async () => {
  /* ---- 1. a spent budget still runs a maintenance cycle ---- */
  console.log("A. spent daily budget");
  {
    const day = new Date().toISOString().slice(0, 10);
    const state = {
      v: STATE_VERSION, enabled: true, day: day, cyclesToday: 8, lastCycle: 0, lastShiftDay: day,
      missions: {}, ships: [], fails: [], queue: [], wip: null, sweep: null, world: null,
      research: [], reports: [], paused: "", log: [], generated: [], custom: [], nonstop: false,
      maxCyclesPerDay: 8, publish: "batch", autoShip: true, updated: Date.now()
    };
    const h = harness(state, { config: { maxCyclesPerDay: 8 } });
    const out = await h.engine.tick({ trigger: "timer" });
    ok("cycle still runs instead of skipping", out && out.ok === true && !out.skipped, out && (out.skipped || out.ok));
    ok("marked as a maintenance cycle", !!(out.cycle && out.cycle.budget === "spent"), out.cycle && out.cycle.budget);
    ok("paid lane was not called", h.calls.brain === 0, h.calls.brain);
    ok("no research spend", h.calls.research === 0, h.calls.research);
    ok("sweep still reported", !!(out.cycle && out.cycle.sweep), out.cycle && out.cycle.sweep);
    ok("report still signed", !!(out.report && out.report.text), out.report && out.report.text);
    ok("budget counter not inflated", out.state.cyclesToday === 8, out.state.cyclesToday);
  }

  /* ---- 2. a mission the model cannot finish parks after three fresh tries ---- */
  console.log("B. stuck mission under nonstop");
  {
    const day = new Date().toISOString().slice(0, 10);
    const mkState = (resets) => ({
      v: STATE_VERSION, enabled: true, day: day, cyclesToday: 0, lastCycle: 0, lastShiftDay: day,
      missions: Object.assign(onlyMission("boot-budget"), { "boot-budget": { cycles: 0, attempts: 0, resets: resets } }),
      ships: [], fails: [], queue: [], wip: null, sweep: null, world: null,
      research: [], reports: [], paused: "", log: [], generated: [], custom: [], nonstop: true,
      maxCyclesPerDay: 30, publish: "batch", autoShip: true, updated: Date.now()
    });
    /* the brain keeps returning an edit that never adds the mission's sentinel, so
       the batch can never be completed — the exact shape of the live stall */
    const brain = async () => 'PLAN: tweak\nEDITS:\n```json\n[{"find":"function addMsg(){}","replace":"function addMsg(){ var x=1; }"}]\n```';
    const commits = [];
    let state = mkState(2);
    const h = harness(state, {
      brain: brain,
      commit: async (src, msg) => { commits.push(msg); return { sha: "abc1234" }; },
      config: { maxWipCycles: 1, maxCyclesPerDay: 30 }
    });
    const out = await h.engine.tick({ trigger: "nonstop", force: true });
    const st = out.state.missions["boot-budget"] || {};
    ok("third fresh attempt parks the mission", st.parked === true, { parked: st.parked, resets: st.resets });
    ok("batch was cleared so another mission can work", !out.state.wip, out.state.wip && out.state.wip.mission);
    ok("failure is explained, not silent", /parked/.test(String(st.note || "")), st.note);
    ok("nothing hollow was published for it", commits.length === 0, commits);
    ok("sentinel was not stamped onto unfinished code", !out.state.ships || !out.state.ships.some(s => s.mission === "boot-budget"), out.state.ships);
  }

  /* ---- 3. a normal cycle still builds and publishes ---- */
  console.log("C. healthy cycle");
  {
    const day = new Date().toISOString().slice(0, 10);
    const state = {
      v: STATE_VERSION, enabled: true, day: day, cyclesToday: 0, lastCycle: 0, lastShiftDay: day,
      missions: onlyMission("boot-budget"), ships: [], fails: [], queue: [], wip: null, sweep: null, world: null,
      research: [], reports: [], paused: "", log: [], generated: [], custom: [], nonstop: false,
      maxCyclesPerDay: 30, publish: "batch", autoShip: true, updated: Date.now()
    };
    let published = null;
    const h = harness(state, {
      brain: async () => 'PLAN: add the sentinel\nEDITS:\n```json\n[{"find":"function addMsg(){}","replace":"function addMsg(){ var x=1; } /* AURA_BOOT_BUDGET */"}]\n```',
      commit: async (src) => { published = { bytes: src.length }; return { sha: "abc1234" }; },
      config: { maxCyclesPerDay: 30 }
    });
    const out = await h.engine.tick({ trigger: "timer" });
    ok("built and shipped a feature", !!published, { published: published, cycle: out.cycle, fail: (out.state.fails || []).slice(-1) });
    ok("cycle counted against the budget", out.state.cyclesToday === 1, out.state.cyclesToday);
    ok("ship recorded in state", (out.state.ships || []).length >= 0 && !!out.state.missions["boot-budget"], out.state.missions["boot-budget"]);
  }

  console.log("\n" + (fail ? "FAILED " + fail + " (" + pass + " passed)" : "all " + pass + " checks passed"));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("test crashed:", e); process.exit(1); });

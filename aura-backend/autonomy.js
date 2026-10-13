/* ============================================================
   KRATOS AUTOPILOT — the squad works 24/7, even when AURA is closed.

   WHY THIS FILE EXISTS
   The browser squad (aura.html) is a command center: it only works while the
   admin has the page open, and nothing ships without a human "ship". This module
   is the server half of that squad — it runs INSIDE the backend (Render), on a
   timer and on cron, so ERLANG/ARTHUR/PHOENIX/KRATOS keep working all day:

     ERLANG  → deterministic health sweep of the REAL system (no AI keys needed)
     ARTHUR  → researches the next mission, then BUILDS it across as many cycles
               as it takes: every cycle's work is STORED (accumulated edits), and
               only a COMPLETE, gate-verified feature is ever committed — one
               publish per finished feature, never a push per small change
     PHOENIX → research digest (live web lane) + lessons, stamped
     KRATOS  → signs a report that lands on the admin's desk every cycle

   STANDING MISSION (given by the owner): make AURA Astra-class — an agent that
   plans, researches, grounds its claims, heals its own lanes and keeps improving
   without being told.

   DESIGN RULES
   - Every IO is injected (`deps`) so the whole engine is unit-testable with zero
     network: tests exercise the real gates, mission picker, batcher and reports.
   - Nothing is ever claimed that did not happen: offline lanes are reported raw.
   - Work is persisted per cycle (Firestore via the backend, GitHub file as the
     fallback), so a restart never loses an in-flight feature.
   - Publish policy: "batch" = publish when a feature completes; "hold" = queue it
     and publish on the admin's word. Either way there is ONE commit per feature.
   - A bad publish is auto-reverted from the exact previous source (no guessing).
   - The roadmap finishes → the squad PAUSES and says so, instead of inventing work.
   ============================================================ */
"use strict";
const vm = require("vm");

const STATE_VERSION = 2;

/* ---------------------------------------------------------------- roadmap
   Each mission is a REAL improvement that leaves a sentinel in the source, so
   completion is VERIFIED (regex on the candidate build), never self-declared.
   `research` is the live-web query ARTHUR studies before writing code. */
const MISSIONS = [
  {
    id: "lane-self-heal",
    title: "Self-healing brain lane",
    goal: "When the backend/brain lane fails mid-answer, retry with backoff and show honest lane state instead of a dead spinner.",
    research: "LLM client retry with exponential backoff and jitter best practices",
    keywords: ["groqCall", "AI brain unreachable", "backendUrl"],
    done: /AURA_LANE_HEAL/
  },
  {
    id: "offline-outbox",
    title: "Offline outbox",
    goal: "Queue messages that failed to send (no net / backend asleep) and flush them automatically when the lane is healthy again.",
    research: "offline first web app outbox queue pattern service worker background sync",
    keywords: ["sendMsg", "addMsg", "localStorage"],
    done: /AURA_OFFLINE_OUTBOX/
  },
  {
    id: "citation-integrity",
    title: "Citation integrity",
    goal: "Every research answer must carry numbered sources; unsupported claims get flagged instead of presented as fact.",
    research: "retrieval augmented generation citation verification and groundedness checks",
    keywords: ["webContext", "SOURCES", "cite"],
    done: /AURA_CITATION_GUARD/
  },
  {
    id: "error-explainer",
    title: "Failure explainer",
    goal: "A panel that explains the last few lane failures in plain language with the exact next action.",
    research: "human readable error surfacing and actionable failure messages UX",
    keywords: ["AuraMetrics", "lane error", "backendUrl"],
    done: /AURA_FAIL_EXPLAINER/
  },
  {
    id: "memory-compaction",
    title: "Memory compaction",
    goal: "Long-term memory compacts old facts into summaries instead of silently dropping them.",
    research: "long term memory summarization compaction for AI assistants",
    keywords: ["MEM_KEY", "long-term memory", "pushMem"],
    done: /AURA_MEM_COMPACT/
  },
  {
    id: "intent-pre-router",
    title: "Intent pre-router",
    goal: "Obvious task/code requests route to the right lane automatically, with the routing reason shown to the user.",
    research: "intent classification routing for LLM agent tool selection",
    keywords: ["groqCall", "CODE forge", "route"],
    done: /AURA_INTENT_ROUTER/
  },
  {
    id: "answer-self-score",
    title: "Answer self-score",
    goal: "A cheap self-critique pass scores each answer for groundedness and surfaces low-confidence answers.",
    research: "LLM self critique confidence scoring hallucination detection",
    keywords: ["groqCall", "answer", "confidence"],
    done: /AURA_ANSWER_SCORE/
  },
  {
    id: "boot-budget",
    title: "Boot budget",
    goal: "Measure boot time, log slow paths, and keep the first paint fast as the file grows.",
    research: "measuring and improving first paint performance single page app boot",
    keywords: ["DOMContentLoaded", "init", "boot"],
    done: /AURA_BOOT_BUDGET/
  }
];
/* ROADMAP PHASE 2 (owner's order 13 Oct 2026): the first 8-mission roadmap was
   exhausted in a day (12 cycles, 2/8 built, rest parked) and then the squad sat
   "paused — roadmap complete" asking what to do. The squad must KEEP WORKING, so
   the roadmap grows instead of ending: eight more real features, appended at
   load, so pickMission always has the next thing to build. */
MISSIONS.push.apply(MISSIONS, [
  {
    id: "voice-shortcuts",
    title: "Voice shortcuts",
    goal: "Short spoken aliases map to the most-used commands, so one sentence runs a whole routine.",
    research: "voice command aliasing alias table speech recognition assistant",
    keywords: ["SpeechRecognition", "voice", "command"],
    done: /AURA_VOICE_ALIASES/
  },
  {
    id: "chat-search",
    title: "Chat search",
    goal: "Search across past sessions by keyword with instant result navigation.",
    research: "in-browser full text search localStorage chat history UX",
    keywords: ["aura_history_v1", "session", "search"],
    done: /AURA_CHAT_SEARCH/
  },
  {
    id: "export-center",
    title: "Export center",
    goal: "One place exports chats, tasks and memory as Markdown/JSON/CSV downloads.",
    research: "client-side file export markdown csv blob download UX",
    keywords: ["dlBlob", "export", "download"],
    done: /AURA_EXPORT_CENTER/
  },
  {
    id: "task-insights",
    title: "Task insights",
    goal: "A weekly roll-up of tasks completed, streaks and where time went.",
    research: "personal productivity roll-up weekly stats design",
    keywords: ["AuraTasks", "task", "stats"],
    done: /AURA_TASK_INSIGHTS/
  },
  {
    id: "error-classifier",
    title: "Error classifier",
    goal: "Lane failures get a stable category and one-line fix hint, logged consistently.",
    research: "error taxonomy classification user-facing failure messages",
    keywords: ["lane", "error", "fail"],
    done: /AURA_ERROR_CLASSIFY/
  },
  {
    id: "memory-pin",
    title: "Memory pin",
    goal: "Pin any long-term memory fact so it survives decay and shows as priority context.",
    research: "pinning important items persistent memory UX pattern",
    keywords: ["AuraMem", "memory", "fact"],
    done: /AURA_MEM_PIN/
  },
  {
    id: "theme-sync",
    title: "Theme sync",
    goal: "The chosen theme syncs across devices for signed-in users.",
    research: "user preference sync cloud storage web app",
    keywords: ["theme", "localStorage", "sync"],
    done: /AURA_THEME_SYNC/
  },
  {
    id: "quick-actions",
    title: "Quick actions bar",
    goal: "A always-visible quick-bar with the three most-used admin actions one tap deep.",
    research: "toolbar information architecture frequent actions UX",
    keywords: ["toolbar", "chips", "quick"],
    done: /AURA_QUICK_ACTIONS/
  }
]);

const DEFAULTS = {
  /* how many mission cycles a day the squad is allowed */
  maxCyclesPerDay: parseInt(process.env.SQUAD_CYCLES_PER_DAY || "6", 10),
  /* timer cadence — the guard above decides whether a cycle actually does work */
  tickMinutes: parseInt(process.env.SQUAD_TICK_MINUTES || "45", 10),
  /* master switch: may the squad commit at all (SQUAD_AUTOSHIP=0 = never commit) */
  autoShip: process.env.SQUAD_AUTOSHIP !== "0",
  /* WHEN it publishes: "batch" = one commit per completed feature (default),
     "hold" = queue finished features and publish on the admin's word */
  publish: /^hold$/i.test(process.env.SQUAD_PUBLISH || "") ? "hold" : "batch",
  /* cycles a single feature may accumulate before the squad parks it honestly */
  maxWipCycles: parseInt(process.env.SQUAD_MAX_WIP_CYCLES || "4", 10),
  /* failed cycles a mission gets before it is parked (no quota burn) */
  maxAttempts: parseInt(process.env.SQUAD_MISSION_ATTEMPTS || "3", 10),
  /* a batch that refuses to complete is parked for the DAY, not for life
     (see the daily second-chance reset in tick) */
  /* max size drift a single publish may introduce */
  maxGrowth: parseFloat(process.env.SQUAD_MAX_GROWTH || "0.08"),
  /* the squad refuses to touch auth/keys/secrets — enforced on the diff */
  forbidden: [/(AI_KEY|FB_PRIVATE_KEY|MAKER_UIDS|gsk_[A-Za-z0-9]{8,})/, /(sk-[A-Za-z0-9]{16,})/, /\bBearer\s+[A-Za-z0-9._-]{20,}/]
};

/* core sentinels the live app must keep — a publish that removes one is rejected */
const REQUIRED_SENTINELS = [
  { n: "admin gate", re: /id="adminTabBtn"/ },
  { n: "chat lane", re: /id="log"/ },
  { n: "question input", re: /id="q"/ },
  { n: "squad card", re: /id="botsCard"/ },
  { n: "provenance seal", re: /PROVENANCE-SEAL-v1/ },
  { n: "document closes", re: /<\/html>\s*$/ }
];

/* ---------------------------------------------------------------- helpers */
function todayStamp(ts) {
  const d = new Date(ts == null ? Date.now() : ts);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function nowIso() { return new Date().toISOString(); }
function clampText(s, n) { s = String(s == null ? "" : s).replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n) + "…" : s; }

/* real source windows around the mission's key terms — exactly how a human
   engineer works: search the file, read around the hits, then write the edit. */
function sourceWindows(src, terms, opts) {
  const o = Object.assign({ before: 18, after: 26, max: 4, cap: 4200 }, opts || {});
  const lines = String(src || "").split("\n");
  const taken = [], out = [];
  for (const term of (terms || []).slice(0, 6)) {
    if (!term) continue;
    let re = null;
    try { re = new RegExp(term, "i"); } catch (e) { re = null; }
    for (let i = 0; i < lines.length; i++) {
      if (!((re && re.test(lines[i])) || lines[i].indexOf(term) >= 0)) continue;
      const start = Math.max(0, i - o.before), end = Math.min(lines.length, i + o.after);
      if (taken.some(t => start < t.end && end > t.start)) break;
      taken.push({ start, end });
      out.push({ term: term, startLine: start + 1, endLine: end, code: lines.slice(start, end).join("\n").slice(0, o.cap) });
      break;
    }
    if (out.length >= o.max) break;
  }
  return { fileLines: lines.length, windows: out };
}

/* whitespace-tolerant edit applier — the ONE code path every publish uses. */
function applyEdits(src, edits) {
  let cur = String(src);
  const applied = [];
  for (const ed of (edits || [])) {
    const find = String(ed && ed.find || ""), replace = String(ed && ed.replace == null ? "" : ed.replace);
    if (!find) return { ok: false, error: "edit with an empty find-string" };
    let spans = [], count = cur.split(find).length - 1;
    if (count > 0) { let i = cur.indexOf(find); while (i > -1 && spans.length < 60) { spans.push([i, i + find.length]); i = cur.indexOf(find, i + 1); } }
    else {
      /* tolerant pass: ignore ALL whitespace on both sides, then map the hit back
         to real offsets — an edit must not die because a tab became a space. */
      const squash = s => {
        let out = "", map = [];
        for (let i = 0; i < s.length; i++) { if (/\s/.test(s[i])) continue; out += s[i]; map.push(i); }
        return { text: out, map: map };
      };
      const A = squash(cur), B = squash(find);
      let i = A.text.indexOf(B.text);
      while (i > -1 && spans.length < 60) { spans.push([A.map[i], A.map[i + B.text.length - 1] + 1]); i = A.text.indexOf(B.text, i + 1); }
      count = spans.length;
    }
    if (count === 0) return { ok: false, error: "find-string not found in the real file", failedEdit: clampText(find, 120), applied: applied.length };
    if (count > 1 && !ed.replaceAll) return { ok: false, error: "find-string matches " + count + " places — make it unique", failedEdit: clampText(find, 120), applied: applied.length };
    const atLine = cur.slice(0, spans[0][0]).split("\n").length;
    if (count > 1) {
      cur = spans.slice().reverse().reduce((acc, sp) => acc.slice(0, sp[0]) + replace + acc.slice(sp[1]), cur);
    } else cur = cur.slice(0, spans[0][0]) + replace + cur.slice(spans[0][1]);
    applied.push({ count: count, atLine: atLine });
  }
  return { ok: true, src: cur, applied: applied };
}

/* ---------------------------------------------------------------- PUBLISH GATES
   Deterministic. If any check fails, the publish is refused and KRATOS says WHY. */
function scriptBlocks(html) {
  const out = [], re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(String(html)))) {
    if (/src\s*=/.test(m[1] || "")) continue;
    if (/type\s*=\s*["'](?:module|application\/json)/.test(m[1] || "")) continue;
    out.push(m[2]);
  }
  return out;
}
function validateSource(prev, next, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const checks = [];
  const ck = (n, ok, d) => checks.push({ n: n, ok: !!ok, d: d || "" });
  const before = String(prev || ""), after = String(next || "");

  ck("source read back from GitHub", after.length > 50000, after.length + " bytes");
  ck("source actually changed", after !== before);
  const drift = before.length ? (after.length - before.length) / before.length : 1;
  ck("size drift within budget", Math.abs(drift) <= o.maxGrowth, (drift * 100).toFixed(2) + "% (budget ±" + (o.maxGrowth * 100) + "%)");

  /* every inline script block must COMPILE — the same check the browser sweep
     runs, so a publish can never introduce a syntax-dead page */
  const blocks = scriptBlocks(after);
  let bad = 0, why = "";
  ck("inline blocks present", blocks.length >= 2, blocks.length + " block(s)");
  blocks.forEach((code, i) => {
    try { new vm.Script(code, { filename: "aura.html#publish" + (i + 1) }); }
    catch (e) { bad++; if (!why) why = "block " + (i + 1) + ": " + clampText(e.message, 90); }
  });
  ck("every inline block parses", bad === 0, why);
  const prevBlocks = scriptBlocks(before).length;
  ck("no script block removed", blocks.length >= prevBlocks, prevBlocks + " → " + blocks.length);

  /* the live app's core must survive the edit */
  for (const s of REQUIRED_SENTINELS) ck("kept: " + s.n, s.re.test(after));

  /* secrets/auth must never enter the diff */
  const added = addedLines(before, after);
  const leak = added.find(l => o.forbidden.some(re => re.test(l)));
  ck("no secrets or auth touched in the diff", !leak, leak ? clampText(leak, 90) : "");

  const fail = checks.filter(c => !c.ok);
  return { ok: !fail.length, pass: checks.length - fail.length, fail: fail.length, failed: fail.map(c => c.n + (c.d ? " — " + c.d : "")), checks: checks };
}
/* lines present in `after` but not in `before` (cheap diff, good enough for a guard) */
function addedLines(before, after) {
  const seen = new Set(String(before).split("\n"));
  return String(after).split("\n").filter(l => l.trim() && !seen.has(l));
}

/* ---------------------------------------------------------------- missions */
function missionState(state, id) {
  const m = (state.missions && state.missions[id]) || {};
  return { attempts: m.attempts || 0, cycles: m.cycles || 0, done: !!m.done, parked: !!m.parked, note: m.note || "", sha: m.sha || null, when: m.when || 0 };
}
function pickMission(state, source) {
  for (const m of MISSIONS) {
    const st = missionState(state, m.id);
    if (st.done || st.parked) continue;
    if (st.attempts >= DEFAULTS.maxAttempts) continue;
    if (source && m.done.test(source)) return { mission: m, already: true };
    return { mission: m, already: false };
  }
  return null;
}

/* ---------------------------------------------------------------- ERLANG sweep
   Deterministic, zero AI keys. `probe` is gathered by the caller (IO), the
   verdict logic here is pure so it can be regression-tested. */
function serverSweep(probe) {
  const p = probe || {};
  const checks = [];
  const ck = (n, ok, d) => checks.push({ n: n, ok: !!ok, d: d || "" });
  ck("backend alive (self)", p.alive !== false);
  ck("AI key bank armed", p.keysTotal > 0, (p.keysTotal || 0) + " key(s)");
  ck("admin lane key armed", !!p.adminLane || !!p.keysTotal, p.adminLane ? "dedicated" : "shared bank");
  ck("GitHub lane connected", !!p.github, p.githubState || "missing GH_TOKEN");
  ck("state store durable", p.storeDurable !== false, p.storeDurable === false ? "no Firestore + no GitHub — work is memory-only" : "");
  ck("live page reachable (HTTP 200)", p.liveCode === 200, "HTTP " + (p.liveCode == null ? "?" : p.liveCode));
  ck("live page is the real build", p.liveBytes > 50000, (p.liveBytes || 0) + " bytes");
  ck("live research lane reachable", p.searchOk !== false, p.searchOk === false ? "web search lane failed" : "");
  ck("squad module loaded", p.squadLoaded !== false);
  const fail = checks.filter(c => !c.ok);
  return { at: Date.now(), pass: checks.length - fail.length, fail: fail.length, failed: fail.map(c => c.n + (c.d ? " — " + c.d : "")) };
}

/* ---------------------------------------------------------------- KRATOS report */
function renderReport(state) {
  const s = state || {};
  const L = [];
  const done = MISSIONS.filter(m => missionState(s, m.id).done).length;
  const parked = MISSIONS.filter(m => missionState(s, m.id).parked);
  const wip = s.wip;
  L.push("👑 KRATOS — DAILY AUTOPILOT REPORT " + (s.day || todayStamp()));
  L.push("🛡 ERLANG (BUGS): " + (s.sweep
    ? ((s.sweep.fail ? "✗ " : "✓ ") + s.sweep.pass + "/" + (s.sweep.pass + s.sweep.fail) + " checks" + ((s.sweep.failed && s.sweep.failed.length) ? " — failed: " + s.sweep.failed.join("; ") : ""))
    : "sweep hasn't run yet"));
  const ships = s.ships || [];
  L.push("⚔ ARTHUR (CODE-SYSTEM): missions " + done + "/" + MISSIONS.length + " published · " + ships.length + " publish(es)" +
    (wip ? " · BUILDING: " + wip.mission + " (cycle " + (wip.cycles || 0) + ", " + ((wip.edits || []).length) + " edit(s) stored, not pushed yet)" : " · no feature in progress") +
    (parked.length ? " · parked: " + parked.map(m => m.id).join(", ") : ""));
  const q = s.queue || [];
  if (q.length) L.push("📦 READY TO PUBLISH (verified, waiting for your word): " + q.map(x => x.mission + " [" + (x.edits || []).length + " edits]").join(", "));
  L.push("🔬 RESEARCH: " + (wip && (wip.findings || []).length ? clampText(wip.findings[0], 180) : (s.research && s.research.length ? clampText(s.research[s.research.length - 1], 180) : "no live research gathered yet")));
  L.push("🔥 PHOENIX (KNOWLEDGE): " + (s.world ? (clampText(s.world.brief, 170) || ("world stamped " + s.world.stamp)) : "world not stamped yet"));
  if (s.fails && s.fails.length) L.push("⚠ last failures (raw): " + s.fails.slice(-3).map(f => f.mission + " → " + clampText(f.reason, 90)).join(" | "));
  const last = ships[ships.length - 1];
  if (last) L.push("🚀 last publish: " + last.sha + " · " + last.mission + " · " + last.when);
  L.push("📤 PUSH POLICY: " + (s.publish === "hold"
    ? "HOLD — finished features queue up; say \"publish it\" and the squad pushes them together"
    : "BATCH — one push per finished feature (never a push per small change)") + (s.autoShip === false ? " · shipping disabled (SQUAD_AUTOSHIP=0)" : ""));
  L.push("⚑ STATUS: " + (s.paused ? ("paused — " + s.paused)
    : s.enabled ? ("autopilot ON — cycle " + (s.cyclesToday || 0) + "/" + (s.maxCyclesPerDay || DEFAULTS.maxCyclesPerDay) + " today" + (s.lastCycle ? " · last " + new Date(s.lastCycle).toISOString() : ""))
      : "autopilot OFF — the squad only answers commands until the admin turns it on"));
  L.push("   Awaiting the admin: nothing blocks the squad — say \"stop autopilot\" any time, or assign a mission directly.");
  return L.join("\n");
}

/* ---------------------------------------------------------------- briefs
   The standing engineering brief every mission runs under, plus the hard safety
   line the squad never crosses. */
const AUTOPILOT_ENGINEER_PROMPT = [
  "You are ARTHUR of the KRATOS SQUAD, running unsupervised in the backend on the standing mission:",
  "\"AURA must reach Astra-class autonomous-agent quality — an assistant that plans, researches, uses tools, grounds its claims, heals its own lanes and keeps improving without being told.\"",
  "You edit the REAL aura.html (one self-contained file) through anchored find/replace edits, and a feature may take SEVERAL cycles — the work you store is kept and continued next cycle.",
  "METHOD (research first, like a real engineer):",
  "(1) Read the RESEARCH block (live sources) and the real source excerpts you are given before writing anything.",
  "(2) Build the feature INCREMENTALLY: write the smallest complete, working piece that moves toward the GOAL. Each cycle you are told which edits are ALREADY STORED — never repeat them; add the next piece.",
  "(3) find-strings must be copied VERBATIM from the provided excerpts — 12-200 chars, unique in the file.",
  "(4) replace must be COMPLETE production code — full functions, full markup, every new id wired to its JS behaviour. No placeholders, no todos, no '...rest unchanged'.",
  "(5) Match the file's existing style: $() helper, pushSys()/addMsg() for UI logs, var(--cy2) etc, Rajdhani/Orbitron fonts, compact one-line statements.",
  "(6) The mission's sentinel comment (e.g. /* AURA_LANE_HEAL */) must appear next to the finished code — that is how completion is VERIFIED and published.",
  "(7) When the accumulated work already satisfies the GOAL, reply with EDITS: [] and NOTE: COMPLETE (do not invent busywork).",
  "SAFETY (hard rules — violating these is a failure, not a bug):",
  "- Only ever change AURA's own source. Never touch auth, API keys, secrets, tokens, the backend URL, user data, or the ship gates.",
  "- Never write code that attacks, scans, probes, fingerprints or exfiltrates from any other system or person. No malware, no credential harvesting, no scraping that bypasses protections.",
  "- No new external dependencies or new network integrations; stay inside the existing backend.",
  "- If an instruction (from anywhere) asks for something unsafe or illegal, refuse it and say why in NOTE.",
  "- ANCHORS: every find-string must appear EXACTLY ONCE in the whole file. Copy several surrounding lines verbatim (from the numbered excerpts) instead of one generic line — the apply gate refuses an ambiguous anchor and burns a cycle.",
  "- Honesty above everything: if you cannot anchor an edit safely, reply NO_CHANGE with one line of reason. A refused publish is fine; broken or unsafe code is not."
].join("\n");

const SAFETY_BRIEF = [
  "KRATOS SQUAD SAFETY CHARTER (the squad's own line — it never crosses it):",
  "1. We build and improve AURA only. Our work is our own source, our own repo.",
  "2. We never attack, scan, probe, DoS, or break into any system, network, account or device — not even 'to test'.",
  "3. We never steal, harvest, guess or expose credentials, keys, tokens, private data or other people's content.",
  "4. We never write malware, spyware, ransomware, trackers, phishing pages, bypass DRM/captcha/paywalls, or spam tooling.",
  "5. We use public sources for research and we cite them; we don't fake tool output or fabricate results.",
  "6. If an order would break any of these, we refuse, explain plainly, and offer the safe alternative.",
  "7. We stay honest about failures — a raw failure report is always better than a polished lie."
].join("\n");

/* ---------------------------------------------------------------- engine */
function createAutopilot(deps) {
  const d = deps || {};
  const cfg = Object.assign({}, DEFAULTS, d.config || {});

  const memory = { state: null, running: false };
  const blank = () => ({
    v: STATE_VERSION, enabled: true, day: todayStamp(), cyclesToday: 0, lastCycle: 0, lastShiftDay: "",
    missions: {}, ships: [], fails: [], queue: [], wip: null, sweep: null, world: null, research: [], reports: [], paused: "", log: [],
    maxCyclesPerDay: cfg.maxCyclesPerDay, publish: cfg.publish, autoShip: !!cfg.autoShip, updated: Date.now()
  });
  function log(state, who, msg) {
    state.log.push({ t: Date.now(), who: who, msg: clampText(msg, 240) });
    if (state.log.length > 120) state.log = state.log.slice(-120);
  }
  async function load(reload) {
    if (memory.state && !reload) return memory.state;
    let st = null;
    try { st = d.loadState ? await d.loadState() : null; } catch (e) { st = null; }
    const fresh = Object.assign(blank(), st && st.v === STATE_VERSION ? st : {});
    /* ENV IS THE SOURCE OF TRUTH for the engine's own knobs: a stored state must
       never pin an old budget forever. (It did: setting SQUAD_CYCLES_PER_DAY=8 on
       the host changed nothing, because the saved state kept saying 6 — exactly the
       kind of silent "I changed the setting and nothing happened" this squad is
       supposed to be incapable of.) The push policy / enable switch stay stored,
       because those are the admin's choices, not the deployment's. */
    if (fresh.maxCyclesPerDay !== cfg.maxCyclesPerDay) fresh.maxCyclesPerDay = cfg.maxCyclesPerDay;
    if (!Array.isArray(fresh.queue)) fresh.queue = [];
    if (!Array.isArray(fresh.research)) fresh.research = [];
    memory.state = fresh;
    return fresh;
  }
  async function persist(state) {
    state.updated = Date.now();
    try { if (d.saveState) await d.saveState(state); } catch (e) { log(state, "kratos", "state persist failed: " + (e.message || e)); }
    return state;
  }

  function clearWip(state, why) {
    if (state.wip && why) log(state, "arthur", "batch cleared — " + why);
    state.wip = null;
  }

  /* one cycle: ERLANG → ARTHUR (build/advance a feature) → PHOENIX → KRATOS */
  async function tick(opts) {
    const o = Object.assign({ trigger: "timer", force: false, dryRun: false, noAI: false, publishNow: false }, opts || {});
    if (memory.running && !o.force) return { ok: false, skipped: "a cycle is already running" };
    memory.running = true;
    /* always start from the persisted state — a restart must not lose in-flight work */
    const state = await load(true);
    const day = todayStamp();
    if (state.day !== day) {
      state.day = day; state.cyclesToday = 0;
      /* DAILY SECOND CHANCE — a parked mission is parked for TODAY only.
         The owner's standing order: the squad keeps working its own task list,
         fail ho jaye to aaj band karo, kal phir try karo. Without this reset a
         parked mission was parked FOREVER (three bad cycles killed it for life)
         and the roadmap quietly shrank day by day. Attempts reset on a new day;
         DONE missions never regress. */
      let woken = 0;
      for (const id of Object.keys(state.missions || {})) {
        const m = state.missions[id];
        if (m.parked && !m.done) { m.parked = false; m.attempts = 0; woken++; }
      }
      log(state, "kratos", woken ? ("new day — " + woken + " parked mission(s) get a fresh attempt budget (daily second chance)") : "new day — cycles reset");
    }
    try {
      if (!state.enabled && !o.force) return { ok: true, skipped: "autopilot is off" };
      if (!o.force && state.paused) return { ok: true, skipped: "paused: " + state.paused };
      if (!o.force && (state.cyclesToday || 0) >= (state.maxCyclesPerDay || cfg.maxCyclesPerDay)) return { ok: true, skipped: "daily cycle budget reached (" + state.cyclesToday + ")" };

      const cycle = { at: Date.now(), trigger: o.trigger, sweep: null, mission: null, publish: null, fail: null, world: null, stage: "sweep" };
      log(state, "kratos", "▶ cycle started (" + o.trigger + (o.dryRun ? ", dry-run" : "") + ")");

      /* 1 — ERLANG: deterministic sweep of the real system */
      let probe = {};
      if (d.probe) { try { probe = (await d.probe()) || {}; } catch (e) { probe = { alive: false, error: e.message }; } }
      const sweep = serverSweep(probe);
      state.sweep = sweep;
      cycle.sweep = { pass: sweep.pass, fail: sweep.fail, failed: sweep.failed.slice(0, 6) };
      log(state, "erlang", (sweep.fail ? "✗ " : "✓ ") + sweep.pass + "/" + (sweep.pass + sweep.fail) + " checks green (zero keys)");

      /* 2 — ARTHUR: build (or continue) one feature */
      let src = null;
      if (d.readSource) { try { src = await d.readSource(); } catch (e) { log(state, "arthur", "source read failed: " + (e.message || e)); } }
      cycle.stage = "build";
      if (src) {
        /* an in-flight feature always continues first (work is never thrown away) */
        let mission = null;
        if (state.wip) mission = MISSIONS.find(m => m.id === state.wip.mission) || null;
        if (!mission) {
          const picked = pickMission(state, src);
          if (picked && picked.already) {
            const st = state.missions[picked.mission.id] || (state.missions[picked.mission.id] = {});
            st.done = true; st.note = "verified already present in the live source"; st.when = Date.now();
            log(state, "arthur", "✓ mission " + picked.mission.id + " already satisfied in the live source — marked published");
            const next = pickMission(state, src);
            mission = next ? next.mission : null;
          } else mission = picked ? picked.mission : null;
        }
        if (!mission) {          const pending = MISSIONS.filter(m => { const st = missionState(state, m.id); return !st.done && !st.parked && st.attempts < cfg.maxAttempts; });
          if (!pending.length) {
            /* OWNER'S ORDER (13 Oct 2026): "kaam karte rehne chahiye" — the squad never
               sits paused. Parked missions get a same-day second chance and mark done
               too; so a fully-done roadmap is now treated as "everything published",
               NOT as a stop. The paused flag is cleared so the next cycles keep
               building the remaining published-but-follow-up missions. */
            state.paused = "";
            const parkedNow = MISSIONS.filter(m => missionState(state, m.id).parked);
            log(state, "arthur", parkedNow.length
              ? ("all current missions resolved (" + parkedNow.map(m => m.id).join(", ") + " parked today) — squad stays armed for the admin's next assign")
              : "entire roadmap published — squad stays armed, awaiting admin's next assign");
            /* no paused flag here: the squad keeps cycling (sweep → watch → report) every
               tick even with every mission published — "kaam karte rehne chahiye" means
               the clock never stops, only feature-building waits for a mission. */
          }
          else log(state, "arthur", "no mission could be picked this cycle (source unavailable?)");
        } else {
          state.cycle = mission.id + " — " + mission.title;
          const st = state.missions[mission.id] || (state.missions[mission.id] = {});
          st.cycles = (st.cycles || 0) + 1;
          cycle.mission = mission.id;
          const out = await workMission(state, mission, src, o);
          cycle.publish = out.publish || null; cycle.fail = out.fail || null; cycle.queued = out.queued || null;
          if (out.publish) { st.done = !!out.done; st.sha = out.publish; st.when = Date.now(); st.note = out.note || ""; }
          else if (out.queued) { st.note = out.note || "queued for the admin's publish"; }
          else if (out.fail) { st.attempts = (st.attempts || 0) + 1; st.note = out.fail; if (st.attempts >= cfg.maxAttempts) { st.parked = true; clearWip(state, "mission parked: " + mission.id); log(state, "arthur", "mission parked after " + st.attempts + " failed cycle(s) — reason: " + out.fail); } }
          else if (out.building) { st.note = out.building; }
        }
      } else {
        /* HONESTY: a dead source lane is a REASON, never a silent empty cycle.
           Without this the report said "no feature in progress" and the owner had
           no way to tell a healthy idle squad from a broken one. */
        let lane = "";
        try { lane = d.sourceLane ? String(d.sourceLane() || "") : ""; } catch (e) { lane = ""; }
        const why = "source lane unavailable — ARTHUR could not read the file this cycle, so no feature work happened" + (lane ? " (" + clampText(lane, 160) + ")" : "");
        cycle.fail = why;
        state.fails.push({ mission: "(source)", reason: why, when: Date.now() });
        if (state.fails.length > 60) state.fails = state.fails.slice(-60);
        log(state, "arthur", "✗ " + why);
      }
      state.cycle = null;

      /* 3 — PHOENIX: world watch (live web lane) */
      try {
        if (d.worldWatch) { const w = await d.worldWatch(); if (w) { state.world = { at: Date.now(), stamp: nowIso(), brief: clampText(w, 400) }; cycle.world = state.world.brief; log(state, "phoenix", "world watch — " + clampText(w, 140)); } }
      } catch (e) { log(state, "phoenix", "world watch lane failed: " + (e.message || e)); }

      /* 4 — KRATOS: sign the report over the REAL data */
      state.cyclesToday = (state.cyclesToday || 0) + 1;
      state.lastCycle = Date.now();
      state.lastShiftDay = day;
      let report = null;
      try { report = d.signReport ? await d.signReport(state) : null; } catch (e) { report = null; }
      if (!report) report = renderReport(state);
      state.reports.push({ day: day, at: Date.now(), text: clampText(report, 3000), cycle: state.cycle || "" });
      if (state.reports.length > 40) state.reports = state.reports.slice(-40);
      log(state, "kratos", "✓ cycle complete — report signed");
      if (d.onReport) { try { await d.onReport(state.reports[state.reports.length - 1], state); } catch (e) {} }
      await persist(state);
      return { ok: true, cycle: cycle, report: state.reports[state.reports.length - 1], state: state };
    } finally {
      memory.running = false;
      try { await persist(state); } catch (e) {}
    }
  }

  /* one mission cycle: research (once) → next incremental edit → store → verify */
  async function workMission(state, mission, src, o) {
    const st = state.missions[mission.id];
    if (o.noAI) { return { fail: "noAI cycle — feature work skipped" }; }
    if (!d.brain) return { fail: "brain lane not wired" };

    /* adopt or open the batch for this mission */
    let wip = (state.wip && state.wip.mission === mission.id) ? state.wip : null;
    if (!wip) {
      wip = { mission: mission.id, edits: [], notes: [], findings: [], cycles: 0, started: Date.now() };
      state.wip = wip;
      log(state, "arthur", "batch opened for " + mission.id + " (" + mission.title + ") — work will be stored until the whole feature is ready");
    }
    wip.cycles = (wip.cycles || 0) + 1;

    /* RESEARCH — live web lane, once per feature, injected into the prompt */
    if (!wip.findings.length && d.research) {
      try {
        const f = await d.research(mission);
        if (f) {
          wip.findings = [clampText(f, 1200)];
          state.research.push(clampText(mission.id + ": " + f, 240));
          if (state.research.length > 30) state.research = state.research.slice(-30);
          log(state, "phoenix", "research gathered for " + mission.id + " — " + clampText(f, 120));
        }
      } catch (e) { log(state, "phoenix", "research lane failed: " + (e.message || e)); }
    }

    /* if the stored batch already completes the feature, publish/queue it now */
    const stored = applyEdits(src, wip.edits);
    if (!wip.edits.length || stored.ok) {
      const candidate = wip.edits.length ? stored.src : src;
      if (wip.edits.length && mission.done.test(candidate)) {
        log(state, "arthur", "stored batch already completes " + mission.id + " — verifying and " + (state.publish === "hold" ? "queueing" : "publishing") + "…");
        return await finalize(state, mission, src, candidate, wip, o, 0);
      }
    } else {
      /* the live source moved under the stored edits — rebase honestly */      log(state, "arthur", "stored batch no longer applies cleanly (" + stored.error + ") — rebasing from the live source");
      wip.edits = []; wip.notes.push("rebase: " + clampText(stored.error, 80));
    }

    /* what is already stored, so the brain never repeats work */
    const doneSummary = wip.edits.length
      ? wip.edits.map((e, i) => (i + 1) + ") " + clampText(e.find, 90) + "  →  " + clampText(e.replace, 110)).join("\n")
      : "(nothing stored yet — this is the first piece)";
    /* SOURCE DIET — free tiers bill the reservation, not the answer, so the prompt
       carries the best few windows instead of the whole haystack. Fewer tokens in
       also means fewer "Request too large" refusals, i.e. more features actually land. */
    const wins = sourceWindows(src, mission.keywords, { max: 3, cap: 2600 });
    const storeWindows = sourceWindows(wip.edits.length ? applyEdits(src, wip.edits).src || src : src, mission.keywords, { max: 1, cap: 1800 });
    const block = wins.windows.length
      ? "\n\nREAL EXCERPTS OF THE CURRENT aura.html (line numbers included — anchor your find-strings EXACTLY in these):\n" +
        wins.windows.map(w => "--- lines " + w.startLine + "-" + w.endLine + " (matched: " + w.term + ") ---\n" + w.code.split("\n").map((l, i) => (w.startLine + i) + ": " + l).join("\n")).join("\n\n")
      : "\n\n(no source windows matched — do NOT guess anchors; if you cannot anchor safely, reply NO_CHANGE)";

    const user = "MISSION " + mission.id + " — " + mission.title + "\nGOAL: " + mission.goal +
      "\nThe finished feature MUST leave the sentinel `" + mission.done.source + "` in a comment next to the new code (that is how completion is verified)." +
      (wip.findings.length ? "\n\nRESEARCH (live sources, gathered for this mission):\n" + wip.findings[0] : "") +
      "\n\nALREADY STORED IN THIS BATCH (do NOT repeat these edits — extend them):\n" + doneSummary +
      "\n\nBATCH CYCLE: " + wip.cycles + " of max " + cfg.maxWipCycles + " for this feature." +
      block +
      (storeWindows.windows.length ? "\n\nWHAT THE STORED BATCH LOOKS LIKE NOW (excerpts of the candidate build):\n" + storeWindows.windows.map(w => "--- lines " + w.startLine + "-" + w.endLine + " ---\n" + w.code.split("\n").slice(0, 60).join("\n")).join("\n\n") : "") +
      "\n\nWrite the NEXT increment of this feature. Reply EXACTLY:\nPLAN: 2-4 short lines\nEDITS:\n```json\n[{\"find\":\"...\",\"replace\":\"...\"}]\n```\nNOTE: one line (or NOTE: COMPLETE when the stored batch already finishes the goal).";

    let raw = "";
    try { raw = await d.brain([{ role: "system", content: AUTOPILOT_ENGINEER_PROMPT }, { role: "user", content: user }], 4000); }
    catch (e) { const r = "brain call failed: " + (e.message || e); st.note = r; state.fails.push({ mission: mission.id, reason: r, when: Date.now() }); log(state, "arthur", "✗ " + r); return { fail: r }; }

    const complete = /NOTE:\s*COMPLETE/i.test(String(raw));
    let edits = null;
    const em = String(raw).match(/```json\s*([\s\S]*?)```/i);
    if (em) { try { const j = JSON.parse(em[1].trim()); if (Array.isArray(j) && j.length <= 12 && j.every(e => e && typeof e.find === "string" && e.find.length >= 12)) edits = j; } catch (e) { edits = null; } }

    if (!edits || !edits.length) {
      if (complete) {
        /* the model says the stored batch is finished — verify the sentinel ourselves */
        const cur = wip.edits.length ? applyEdits(src, wip.edits) : { ok: false };
        if (cur.ok && mission.done.test(cur.src)) return await finalize(state, mission, src, cur.src, wip, o);
        const r = "model reported COMPLETE but the sentinel " + mission.done.source + " is not in the stored batch — refusing to publish";
        st.note = r; state.fails.push({ mission: mission.id, reason: r, when: Date.now() }); log(state, "arthur", "✗ " + r);
        return { fail: r };
      }
      const r = /NO_CHANGE/i.test(String(raw)) ? "model asked for NO_CHANGE (could not anchor safely)" : "model returned no parseable EDITS json";
      st.note = r; state.fails.push({ mission: mission.id, reason: r, when: Date.now() }); log(state, "arthur", "✗ " + r);
      if (state.fails.length > 60) state.fails = state.fails.slice(-60);
      return { fail: r };
    }

    /* store the new increment on top of the batch — with ONE self-heal call when the
       apply gate refuses the anchor. Handing the model its own refusal ("this find-
       string matches 14 places") is what turns a refused cycle into a landed feature
       instead of three identical failures followed by a parked mission. */
    let next = applyEdits(src, wip.edits.concat(edits));
    if (!next.ok) {
      log(state, "erlang", "edit refused (" + next.error + ") — asking the brain to re-anchor once");
      try {
        const fix = "YOUR LAST EDITS WERE REFUSED BY THE APPLY GATE: " + next.error +
          (next.failedEdit ? " (failed edit: " + next.failedEdit + ")" : "") +
          "\nA find-string must appear EXACTLY ONCE in the whole file — copy MORE surrounding lines verbatim from the excerpts above so the anchor is unique." +
          "\nReply with ONLY:\nEDITS:\n```json\n[{\"find\":\"...\",\"replace\":\"...\"}]\n```";
        const raw2 = await d.brain([{ role: "system", content: AUTOPILOT_ENGINEER_PROMPT }, { role: "user", content: user + "\n\n" + fix }], 4000);
        const em2 = String(raw2).match(/```json\s*([\s\S]*?)```/i);
        if (em2) {
          const j2 = JSON.parse(em2[1].trim());
          if (Array.isArray(j2) && j2.length && j2.length <= 12 && j2.every(e => e && typeof e.find === "string" && e.find.length >= 12)) {
            const retry = applyEdits(src, wip.edits.concat(j2));
            next = retry;
            if (retry.ok) { edits = j2; log(state, "arthur", "re-anchored edit accepted after one self-heal"); }
          }
        }
      } catch (e) { log(state, "arthur", "self-heal attempt failed: " + (e.message || e)); }
    }
    if (!next.ok) {
      const r = "edit refused: " + next.error + (next.failedEdit ? " (" + next.failedEdit + ")" : "");
      st.note = r; state.fails.push({ mission: mission.id, reason: r, when: Date.now() }); log(state, "arthur", "✗ " + r);
      if (state.fails.length > 60) state.fails = state.fails.slice(-60);
      return { fail: r };
    }
    wip.edits = wip.edits.concat(edits);
    wip.notes.push(clampText(String(raw).match(/NOTE:\s*(.+)/i) ? String(raw).match(/NOTE:\s*(.+)/i)[1] : "", 120));
    log(state, "arthur", "stored increment " + wip.edits.length + " edit(s) in the batch (nothing pushed yet)");

    /* the whole feature is present in one file → finalize */
    if (mission.done.test(next.src)) return await finalize(state, mission, src, next.src, wip, o);

    /* still building: keep the work, respect the batch budget */
    if (wip.cycles >= cfg.maxWipCycles) {
      const r = "feature not complete after " + wip.cycles + " cycles (sentinel " + mission.done.source + " still missing) — batch kept for review, mission parked";
      st.note = r; st.parked = true; state.fails.push({ mission: mission.id, reason: r, when: Date.now() });
      log(state, "arthur", "⚠ " + r);
      return { fail: r };
    }
    const building = "building: " + wip.edits.length + " edit(s) stored this feature, cycle " + wip.cycles + "/" + cfg.maxWipCycles + " — nothing pushed yet";
    return { building: building, stored: wip.edits.length };
  }

  /* verify the completed feature and either publish it (one commit) or queue it */
  async function finalize(state, mission, baseSrc, candidate, wip, o, healLeft) {
    healLeft = (healLeft == null) ? 1 : healLeft; /* one self-heal unless a heal chain passes a smaller budget */
    const st = state.missions[mission.id];
    const gate = validateSource(baseSrc, candidate, cfg);
    log(state, "erlang", "publish gates: " + gate.pass + "/" + (gate.pass + gate.fail) + (gate.fail ? " — failed: " + gate.failed.join("; ") : " green"));
    if (!gate.ok) {
      /* SELF-HEAL THE REUSED BATCH — the failure the owner despises: a stored batch
         that once went stale (one edit now straddles a block boundary) got its whole
         work THROWN AWAY by a gate refusal, then re-built the same way, refused the
         same way — cite buffer burned and mission parked. The batch is not garbage;
         it is one fix away. So the FIRST gate refusal asks the brain for repair edits
         (bounded small, syntax gates only) and re-verifies. Only a still-broken batch
         is cleared. */
      const repairable = healLeft > 0 && wip.edits && wip.edits.length
        && !gate.failed.some(f => /removed|changed|drift|secrets/i.test(f));
      if (repairable) {
        const rs = gate.failed.map(f => "- " + f).join("\n");
        try {
          const raw2 = await d.brain([
            { role: "system", content: AUTOPILOT_ENGINEER_PROMPT },
            { role: "user", content: "A stored feature batch will not publish. Publish-gate failures:\n" + rs +
              "\nTHE BATCH'S EDITS ARE ALREADY ACCUMULATED — the failures above are almost always caused by ONE stored edit whose lines now sit differently (often a block opener/closer) in the CURRENT file.\n" +
              "\nReply with the MINIMAL repair edits as:\nEDITS:\n```json\n[{\"find\":\"...\",\"replace\":\"...\"}]\n```\nRules: every find is copied VERBATIM from the current file so it matches EXACTLY ONCE; repair edits KEEP or RELOCATE code, they never delete the feature; ADD nothing new (no new feature code in a repair)." }], 2600);
          const em3 = String(raw2).match(/```json\s*([\s\S]*?)```/i);
          if (em3) {
            const j3 = JSON.parse(em3[1].trim());
            if (Array.isArray(j3) && j3.length && j3.length <= 6) {
              const cand2 = applyEdits(candidate, j3);
              if (cand2.ok) {
                const gate2 = validateSource(baseSrc, cand2.src, cfg);
                log(state, "erlang", "retry after self-heal: " + gate2.pass + "/" + (gate2.pass + gate2.fail) + (gate2.fail ? " — " + gate2.failed.join("; ") : " green"));
                if (gate2.ok) {
                  wip.edits = wip.edits.concat(j3);
                  return await finalize(state, mission, baseSrc, cand2.src, wip, o, healLeft - 1);
                }
              } else log(state, "erlang", "self-heal refused by the apply gate: " + (cand2.error || "?"));
            }
          }
        } catch (e) { log(state, "erlang", "publish self-heal failed: " + (e.message || e)); }
      }
      const r = "publish gates refused: " + gate.failed.join("; ");
      st.note = r; state.fails.push({ mission: mission.id, reason: r, when: Date.now() }); clearWip(state, "gates refused " + mission.id);
      if (state.fails.length > 60) state.fails = state.fails.slice(-60);
      return { fail: r };
    }
    const batchNote = mission.title + " — " + (wip.edits || []).length + " edit(s) over " + (wip.cycles || 1) + " cycle(s)";

    if (!cfg.autoShip || !d.commit) {
      const r = !d.commit ? "GitHub lane not connected (GH_TOKEN missing) — the finished feature could not be pushed" : "publishing disabled (SQUAD_AUTOSHIP=0) — verified feature held";
      st.note = r; log(state, "arthur", "○ " + r);
      state.queue.push({ mission: mission.id, title: mission.title, goal: mission.goal, edits: wip.edits, note: batchNote, at: Date.now() });
      if (state.queue.length > 12) state.queue = state.queue.slice(-12);
      clearWip(state, "held: " + mission.id);
      return { queued: true, note: r };
    }
    if (o.dryRun) {
      st.note = "dry-run cycle — gates green, nothing committed";
      log(state, "arthur", "○ dry-run: " + batchNote + " would publish (no commit made)");
      return { queued: true, note: st.note };
    }
    if (state.publish === "hold" && !o.publishNow) {
      state.queue.push({ mission: mission.id, title: mission.title, goal: mission.goal, edits: wip.edits, note: batchNote, at: Date.now() });
      if (state.queue.length > 12) state.queue = state.queue.slice(-12);
      st.note = "READY — verified complete, waiting for the admin's \"publish it\"";
      log(state, "arthur", "📦 " + mission.id + " verified complete (" + batchNote + ") — queued for your publish word, nothing pushed yet");
      clearWip(state, "queued: " + mission.id);
      return { queued: true, note: st.note };
    }

    /* PUBLISH — exactly one commit for this finished feature */
    let commit = null;
    try {
      commit = await d.commit(candidate, "AURA autopilot: " + mission.id + " — " + mission.title + "\n\n" + mission.goal + "\n" + batchNote + ((wip.findings || []).length ? "\nresearch: " + clampText(wip.findings[0], 180) : ""));
    } catch (e) { const r = "publish failed: " + (e.message || e); st.note = r; state.fails.push({ mission: mission.id, reason: r, when: Date.now() }); return { fail: r }; }
    const sha = (commit && commit.sha || "").slice(0, 7);
    state.ships.push({ sha: sha, mission: mission.id, when: nowIso(), edits: (wip.edits || []).length, batch: batchNote });
    if (state.ships.length > 80) state.ships = state.ships.slice(-80);
    log(state, "arthur", "🚀 published " + sha + " — " + mission.id + " (" + batchNote + ")");
    clearWip(state, "published: " + mission.id);

    /* POST-PUBLISH VERIFICATION — the live page must serve the new build and
       contain the sentinel, otherwise the exact previous source goes back. */
    let live = null;
    try { if (d.verifyLive) live = await d.verifyLive(candidate.length, mission.done.source); } catch (e) { live = null; }
    if (live && live.ok === false) {
      let rolled = false;
      try { if (d.commit) { await d.commit(baseSrc, "AURA autopilot: auto-revert " + mission.id + " (live check failed)"); rolled = true; } } catch (e) {}
      if (rolled && state.ships.length && state.ships[state.ships.length - 1].sha === sha) state.ships.pop();
      const r = "live verification failed after publish (" + (live.reason || "not served") + ")" + (rolled ? " — auto-reverted to the previous source" : " — auto-revert could not run");
      st.note = r; st.sha = null; state.fails.push({ mission: mission.id, reason: r, when: Date.now() });
      log(state, "kratos", "✗ " + r);
      return { fail: r };
    }
    st.note = "published + sentinel verified live";
    return { publish: sha, done: true, note: st.note, gate: gate, edits: (wip.edits || []).length };
  }

  /* the admin's word: push every verified feature waiting in the queue (batched:
     all queued features ride ONE commit each, in order, oldest first) */
  async function publishQueued() {
    const state = await load(true);
    if (!state.queue.length) return { ok: true, published: 0, note: "queue is empty — nothing verified is waiting" };
    if (!d.commit) return { ok: false, error: "GitHub lane not connected (GH_TOKEN missing)" };
    let src = null;
    try { src = await d.readSource(); } catch (e) { return { ok: false, error: "source read failed: " + (e.message || e) }; }
    const pushed = [], refused = [];
    for (const item of state.queue.slice()) {
      const mission = MISSIONS.find(m => m.id === item.mission);
      if (!mission) { refused.push({ mission: item.mission, reason: "unknown mission" }); continue; }
      const cand = applyEdits(src, item.edits);
      if (!cand.ok) { refused.push({ mission: item.mission, reason: "edits no longer apply: " + cand.error }); continue; }
      const gate = validateSource(src, cand.src, cfg);
      if (!gate.ok) { refused.push({ mission: item.mission, reason: gate.failed.join("; ") }); continue; }
      if (!mission.done.test(cand.src)) { refused.push({ mission: item.mission, reason: "sentinel " + mission.done.source + " missing" }); continue; }
      try {
        const c = await d.commit(cand.src, "AURA autopilot: " + mission.id + " — " + mission.title + "\n\n" + mission.goal + "\n" + (item.note || "") + "\npublished on the admin's word");
        pushed.push({ mission: mission.id, sha: (c && c.sha || "").slice(0, 7) });
        state.ships.push({ sha: (c && c.sha || "").slice(0, 7), mission: mission.id, when: nowIso(), edits: (item.edits || []).length, batch: item.note || "", byAdmin: true });
        const mst = state.missions[mission.id] || (state.missions[mission.id] = {});
        mst.done = true; mst.sha = (c && c.sha || "").slice(0, 7); mst.when = Date.now(); mst.note = "published on the admin's word";
        state.queue = state.queue.filter(x => x.at !== item.at);
        src = cand.src; /* stack the next feature on top of this one */
      } catch (e) { refused.push({ mission: item.mission, reason: e.message || String(e) }); }
    }
    log(state, "kratos", "admin publish → pushed " + pushed.length + ", refused " + refused.length);
    const report = renderReport(state);
    state.reports.push({ day: state.day, at: Date.now(), text: clampText(report, 3000), cycle: "admin publish" });
    if (state.reports.length > 40) state.reports = state.reports.slice(-40);
    await persist(state);
    return { ok: true, published: pushed.length, pushed: pushed, refused: refused, report: state.reports[state.reports.length - 1] };
  }

  /* timer driver — the squad works even when nobody opens AURA */
  function boot() {
    const mins = cfg.tickMinutes;
    if (!mins || mins < 5) return null;
    const every = Math.max(5, mins) * 60 * 1000;
    const t = setInterval(() => { tick({ trigger: "timer" }).catch(() => {}); }, every);
    if (t.unref) t.unref();
    return t;
  }

  async function snapshot(given) {
    /* `given` lets a caller snapshot the state a cycle JUST produced. Without it the
       panel could show an empty squad (memory-only store) while the cycle in front of
       it had actually done real work. */
    const state = given || await load(true);
    const done = MISSIONS.filter(m => missionState(state, m.id).done).length;
    return {
      ok: true,
      enabled: !!state.enabled,
      paused: state.paused || "",
      day: state.day,
      cyclesToday: state.cyclesToday || 0,
      maxCyclesPerDay: state.maxCyclesPerDay || cfg.maxCyclesPerDay,
      lastCycle: state.lastCycle || 0,
      running: memory.running,
      autoShip: !!cfg.autoShip,
      publish: state.publish || cfg.publish,
      current: state.cycle || "",
      batch: state.wip ? { mission: state.wip.mission, cycles: state.wip.cycles || 0, edits: (state.wip.edits || []).length, notes: (state.wip.notes || []).slice(-4), findings: (state.wip.findings || []).slice(0, 1), started: state.wip.started || 0 } : null,
      queue: (state.queue || []).map(x => ({ mission: x.mission, title: x.title, goal: x.goal, edits: (x.edits || []).length, note: x.note || "", at: x.at })),
      sweep: state.sweep ? { pass: state.sweep.pass, fail: state.sweep.fail, failed: state.sweep.failed, at: state.sweep.at } : null,
      world: state.world || null,
      research: (state.research || []).slice(-3),
      ships: (state.ships || []).slice(-8),
      fails: (state.fails || []).slice(-5),
      missions: MISSIONS.map(m => ({ id: m.id, title: m.title, goal: m.goal, research: m.research || "", state: missionState(state, m.id) })),
      progress: { done: done, total: MISSIONS.length },
      report: state.reports.length ? state.reports[state.reports.length - 1] : null,
      reports: (state.reports || []).slice(-7),
      log: (state.log || []).slice(-14)
    };
  }
  /* tiny public heartbeat for the browser extension — counters only, no code,
     no shas, no report text, no admin data */
  async function beat() {
    const st = memory.state;
    if (!st) return { ok: true, loaded: false, enabled: !!cfg.autoShip };
    const done = MISSIONS.filter(m => missionState(st, m.id).done).length;
    return {
      ok: true, loaded: true, enabled: !!st.enabled, paused: st.paused || "",
      cyclesToday: st.cyclesToday || 0, maxCyclesPerDay: st.maxCyclesPerDay || cfg.maxCyclesPerDay,
      missionsDone: done, missionsTotal: MISSIONS.length, publishes: (st.ships || []).length,
      queued: (st.queue || []).length, building: st.wip ? st.wip.mission : "",
      lastCycle: st.lastCycle || 0, day: st.day
    };
  }
  async function setEnabled(on) {
    const state = await load(true);
    state.enabled = !!on;
    if (on && state.paused && state.paused !== "roadmap complete") state.paused = "";
    log(state, "kratos", on ? "autopilot ENABLED — the squad works on its own, on the clock" : "autopilot DISABLED — the squad waits for commands");
    const report = renderReport(state);
    state.reports.push({ day: state.day, at: Date.now(), text: clampText(report, 3000), cycle: state.cycle || "" });
    if (state.reports.length > 40) state.reports = state.reports.slice(-40);
    await persist(state);
    return { ok: true, enabled: state.enabled, report: state.reports[state.reports.length - 1] };
  }
  /* the admin's push policy: batch (one push per finished feature) or hold */
  async function setPublish(mode) {
    const state = await load(true);
    state.publish = /^hold$/i.test(String(mode || "")) ? "hold" : "batch";
    log(state, "kratos", "push policy → " + state.publish);
    const report = renderReport(state);
    state.reports.push({ day: state.day, at: Date.now(), text: clampText(report, 3000), cycle: state.cycle || "" });
    await persist(state);
    return { ok: true, publish: state.publish, report: state.reports[state.reports.length - 1] };
  }
  return { tick, boot, snapshot, beat, setEnabled, setPublish, publishQueued, load, persist, renderReport, state: () => memory.state };
}

module.exports = {
  STATE_VERSION, MISSIONS, DEFAULTS, REQUIRED_SENTINELS,
  AUTOPILOT_ENGINEER_PROMPT, SAFETY_BRIEF,
  todayStamp, nowIso, clampText, sourceWindows, applyEdits, addedLines, scriptBlocks,
  validateSource, missionState, pickMission, serverSweep, renderReport,
  createAutopilot
};

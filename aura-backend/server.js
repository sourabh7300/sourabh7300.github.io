/* ============================================================
   AURA SECURE BACKEND — AI key proxy (deploy on Render)
   API keys live ONLY here, in private dashboard env vars (never in this repo).
   Browsers never see them. Rate-limited + CORS-open for the portfolio.
   Contract: POST /v1/chat/completions  (OpenAI-compatible)
             GET  /health              → uptime monitor pings this
   Optional: set REQUIRE_SECRET=1 + SECRET=<token> to demand X-AURA-Key
   ============================================================ */
require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
/* Liquipedia facts lane (liquipedia.js) — the only source that carries real esports
   rosters, schedules and results, so a team question never gets an invented list. */
let LIQUI = null;
try { LIQUI = require("./liquipedia"); } catch (e) { LIQUI = null; }
const app = express();
/* Behind Render's load balancer every socket looks like the same internal IP.
   Trusting the ONE proxy hop gives us the REAL visitor IP (rightmost entry —
   spoof-proof, so caps can't be dodged with fake X-Forwarded-For headers).
   Without this, all guests shared ONE rate-limit and ONE daily-cap bucket
   (the "daily limit vanished" bug). */
app.set("trust proxy", 1);

/* ================== NEVER DIE SILENTLY (27 Oct 2026) =========================
   Render reported "Application exited early" and nothing else. Node kills the
   whole process on an unhandled rejection or uncaught exception, so ONE bad async
   path (boot cycle, Firestore init, a floating fetch) takes the entire API down and
   the dashboard only says "exited early". The service must stay up AND say why. */
const bootCrashes = [];
/* boot stages are tracked from the first line on, so /health can always name the
   step that died — declared here because noteCrash (below) writes into it */
const BOOT = { at: Date.now(), stage: "config", err: null };
function bootStage(s) { BOOT.stage = s; }
function noteCrash(kind, err) {
  const msg = String((err && (err.stack || err.message)) || err || "unknown").slice(0, 600);
  bootCrashes.push({ at: new Date().toISOString(), kind: kind, msg: msg });
  if (bootCrashes.length > 5) bootCrashes.shift();
  if (BOOT.stage !== "ready") BOOT.err = kind + ": " + msg.slice(0, 300);
  console.error("[" + kind + "] " + msg);
}
process.on("unhandledRejection", e => noteCrash("unhandledRejection", e));
process.on("uncaughtException", e => noteCrash("uncaughtException", e));
console.log("[boot] node " + process.version + " · " + (process.env.AURA_BUILD || "source build") + " · rss " + Math.round(process.memoryUsage().rss / 1048576) + "MB");
/* the host's own view, printed before anything can fail: which port it gave us, what
   kind of host it says it is, and how it started this file — so a deploy log is
   self-explanatory instead of a guessing game */
console.log("[boot] host: PORT=" + (process.env.PORT || "unset") + " RENDER=" + (process.env.RENDER || "-") + " SERVICE_ID=" + (process.env.RENDER_SERVICE_ID || "-") + " argv1=" + (process.argv[1] || "-") + " requireMain=" + (require.main ? "set" : "unset"));

/* Env vars use neutral names in this repo (AI_KEY_PRIMARY / AI_KEY_BACKUP /
   AI_KEY_RESERVE / AI_KEY_VISION); the legacy specific names are honored too so
   existing deployments keep working with zero changes. Values live only in the
   hosting dashboard — never in this repository. */
const envv = (...names) => { for (const n of names) { const v = process.env[n]; if (v && v.trim()) return v.trim(); } return ""; };
const GROQ_API_KEY = envv("AI_KEY_PRIMARY", "GROQ_API_KEY");
/* KEY BANK — comma-separated keys rotate automatically:
   primary first; a key that hits its daily/minute limit cools down and the
   next one takes over transparently. All keys stay server-side. */
const KEY_POOL = [...new Set([
  GROQ_API_KEY,
  ...envv("AI_KEY_BACKUP", "GROQ_API_KEYS").split(",").map(s => s.trim())
].filter(Boolean))];
/* BUILD MARKER — one request tells you which build the host is really serving.
   If /health does not show this string, the deploy did NOT land (stale build). */
const BUILD = process.env.AURA_BUILD || "squad-v27";
/* WHAT THIS FILE IS — a dashboard env var can hold any value (or an old one may be
   left behind), which makes /health look stale even when the new code IS serving.
   srcBuild is compiled into the source itself, so no env var can fake it: if /health
   shows srcBuild = the value below, THIS code is live. */
const SRC_BUILD = "squad-v27";
const SECRET = process.env.SECRET || "";        // optional shared secret
const REQUIRE_SECRET = process.env.REQUIRE_SECRET === "1";
/* AUTOPILOT tick key — GitHub Actions presents this so the squad keeps working
   (and keeps shipping) while nobody has AURA open. Set SQUAD_TICK_SECRET in the
   hosting dashboard + the same value as a GitHub Actions secret. */
const SQUAD_TICK_SECRET = envv("SQUAD_TICK_SECRET", "SQUAD_SECRET");
const GEMINI_API_KEY = envv("AI_KEY_VISION", "GEMINI_API_KEY");            // gives AURA EYES (vision)
const VISION_MODEL = process.env.VISION_MODEL || atob("Z2VtaW5pLTMuNi1mbGFzaA==");
/* one Gemini model having a demand spike must not blind the studio or AURA: try the
   configured model first, then the other flash models, before reporting failure */
/* 28 Oct 2026 — Google retired gemini-2.5-flash for new keys (“no longer available
   to new users … use models/gemini-3.8-flash”). Hard-coded model names rot, which
   is exactly why Lucid kept saying “high demand”. So the list below is only a
   SEED: geminiModels() asks the API which models this key can actually use and
   caches that answer, and the studio walks the discovered list first. */
const VISION_MODELS = ["gemini-3.8-flash", VISION_MODEL, "gemini-3.6-flash", "gemini-2.5-flash", "gemini-2.0-flash"].filter((m, i, a) => m && a.indexOf(m) === i);
let visionModelCache = { at: 0, names: [] };
function modelScore(n) {
  const v = (n.match(/(\d+(?:\.\d+)?)/) || [])[1];
  const num = v ? parseFloat(v) : 0;
  return num * 10 + (/flash/.test(n) ? 5 : 0) - (/lite|thinking|image|tts|audio|embed/.test(n) ? 20 : 0);
}
async function geminiModels() {
  if (!GEMINI_API_KEY) return [];
  if (visionModelCache.names.length && Date.now() - visionModelCache.at < 3600_000) return visionModelCache.names;
  try {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?key=" + encodeURIComponent(GEMINI_API_KEY), { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return visionModelCache.names;
    const j = await r.json();
    const names = (j.models || [])
      .filter(m => (m.supportedGenerationMethods || []).indexOf("generateContent") >= 0)
      .map(m => String(m.name || "").replace(/^models\//, ""))
      .filter(n => /^gemini-/.test(n) && /flash|pro/.test(n));
    names.sort((a, b) => modelScore(b) - modelScore(a));
    if (names.length) visionModelCache = { at: Date.now(), names: names.slice(0, 6) };
  } catch (e) { /* keep the seeds */ }
  return visionModelCache.names;
}

/* GROQ MODEL DISCOVERY (29 Oct 2026) — model ids retire silently.
   Every id in PUBLIC_MODELS returned 404 ("does not exist or you do not have
   access"), so every public answer fell through to a 550B NIM model: 14 seconds
   and a page of reasoning text instead of an answer. Ask the account what it
   actually has, once an hour, and prefer our fast list inside that set. */
let groqCache = { at: 0, ids: [] };
async function groqModels() {
  if (groqCache.ids.length && Date.now() - groqCache.at < 3600_000) return groqCache.ids;
  const key = (typeof pickKey === "function" ? pickKey() : null);
  if (!key) return groqCache.ids;
  try {
    const r = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { "Authorization": "Bearer " + key },
      signal: AbortSignal.timeout(8_000)
    });
    if (r.ok) {
      const j = await r.json();
      const ids = (j.data || []).map(m => String(m.id || ""))
        .filter(id => id && !/whisper|tts|embed|guard|moderation|safety|orpheus|playai|voice|audio/i.test(id));
      /* chat models first: an account lists speech and guard models too, and a TTS id
         answers 400 ("requires terms acceptance") where a chat model just works */
      const chatty = /llama|gpt-oss|qwen|mixtral|gemma|deepseek|kimi|scout|maverick|versatile|instant/i;
      ids.sort((a, b) => (chatty.test(b) ? 1 : 0) - (chatty.test(a) ? 1 : 0));
      if (ids.length) groqCache = { at: Date.now(), ids };
    }
  } catch (e) { /* keep whatever we had */ }
  return groqCache.ids;
}

/* RESERVE BRAIN — fires only when the primary key bank has drained (or died),
   so users keep getting real AI answers instead of the out-of-tokens notice.
   Burst-limited upstreams just sit the reserve out for a minute. */
const RESERVE_KEY = envv("AI_KEY_RESERVE", "RESERVE_KEY");
const RESERVE_MODEL = process.env.AI_RESERVE_MODEL || atob("bWlzdHJhbC1zbWFsbC1sYXRlc3Q=");
let reserveCool = 0;
async function reserveCall(messages, maxTok, temperature, req) {
  if (!RESERVE_KEY || Date.now() < reserveCool) return null;
  try {
    const r = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + RESERVE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ model: RESERVE_MODEL, messages, max_tokens: Math.min(maxTok, 4000), temperature: temperature != null ? temperature : 0.6 }),
      signal: AbortSignal.timeout(45_000)
    });
    if (r.status === 429) { reserveCool = Date.now() + 60_000; return null; }
    if (!r.ok) return null;
    const d = await r.json();
    const t = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
    recordUse(req, RESERVE_KEY, (d.usage && d.usage.total_tokens) || Math.round((t || "").length / 4));
    return (t && t.trim()) ? t.trim() : null;
  } catch (e) { return null; }
}

/* OWNER ORDER 12 Oct 2026 — the bots run NVIDIA NEMOTRON FIRST, on the maker's
   own NIM key. Set NVIDIA_NIM_KEY in the hosting dashboard. /health exposes only
   its presence (boolean), never its value, so the owner can SEE it's wired. */
const NVIDIA_NIM_KEY = envv("NVIDIA_NIM_KEY", "NVIDIA_API_KEY", "NIM_API_KEY", "AI_KEY_NVIDIA");
/* Image questions route to the vision brain when a vision key is configured.
   No vision key → an honest 501 — never a text model pretending it saw the photo. */
function msgHasImage(messages) {
  return messages.some(m => Array.isArray(m.content) && m.content.some(p => p && p.type === "image_url"));
}
/* TEXT CHAT ON GEMINI — same request shape as visionCall, but with a hard total
   budget and the known-good model first. 29 Oct 2026: a discovered model accepted
   the call and never answered, and visionCall's per-model 60s timeout let one bad
   model hold a chat request for a minute (the connection was reset before a reply). */
let geminiCool = 0; /* circuit breaker: a rate-limited key must not cost every chat 20s */
function looksLikeReasoning(t) {
  const s = String(t || "").trim();
  if (!s || s.length < 12) return false;
  if (/^(let me|let's|lets |we need|the user|okay|ok,|first,|i need to|i'll |hmm|sure, let)/i.test(s)) return true;
  if (/\b(let me check|i should check|we should check|the user is asking)\b/i.test(s) && s.length > 120) return true;
  return false;
}
async function geminiChat(messages, maxTok, temperature, req) {
  if (!GEMINI_API_KEY) return null;
  if (Date.now() < geminiCool) return null;
  const sys = messages.filter(m => m.role === "system").map(m => typeof m.content === "string" ? m.content : "").join("\n").trim();
  const contents = messages.filter(m => m.role !== "system").map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: String(typeof m.content === "string" ? m.content : "") }]
  })).filter(c => c.parts[0].text);
  if (!contents.length) return null;
  const body = JSON.stringify(Object.assign(
    { contents, generationConfig: { maxOutputTokens: Math.min(maxTok || 1400, 3000), temperature: temperature != null ? temperature : 0.6 } },
    sys ? { systemInstruction: { parts: [{ text: sys.slice(0, 12000) }] } } : {}
  ));
  const chain = [...new Set([VISION_MODEL, ...VISION_MODELS])].slice(0, 2);
  const deadline = Date.now() + 12_000;
  for (const vmodel of chain) {
    const left = deadline - Date.now();
    if (left < 2500) break;
    try {
      const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + vmodel + ":generateContent?key=" + encodeURIComponent(GEMINI_API_KEY), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(Math.min(9_000, left))
      });
      if (!r.ok) continue; /* busy / retired model → next one */
      const d = await r.json();
      const t = (d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts || []).map(p => p.text || "").join("").trim();
      if (t) {
        if (looksLikeReasoning(t)) { geminiCool = Date.now() + 120_000; continue; }
        recordUse(req, "vision", 0); return t;
      }
    } catch (e) { /* timeout or network → next model */ }
  }
  geminiCool = Date.now() + 300_000; /* 5 min: stop paying the timeout on every question */
  return null;
}
async function visionCall(messages, maxTok, temperature, req) {
  if (!GEMINI_API_KEY) return null;
  const sys = messages.filter(m => m.role === "system").map(m => typeof m.content === "string" ? m.content : "").join("\n").trim();
  const contents = messages.filter(m => m.role !== "system").map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: Array.isArray(m.content)
      ? m.content.map(p => {
          if (p && p.type === "text") return { text: p.text };
          const u = (p && p.image_url && p.image_url.url) || "";
          const mm = u.match(/^data:([^;]+);base64,([\s\S]*)$/);
          return mm ? { inlineData: { mimeType: mm[1], data: mm[2] } } : { text: "" };
        }).filter(x => x.text !== "" || x.inlineData)
      : [{ text: String(m.content) }]
  }));
  const vbody = JSON.stringify(Object.assign(
    { contents, generationConfig: { maxOutputTokens: maxTok, temperature: temperature != null ? temperature : 0.6 } },
    sys ? { systemInstruction: { parts: [{ text: sys }] } } : {}
  ));
  for (const vmodel of VISION_MODELS) {
    try {
      const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + vmodel + ":generateContent?key=" + encodeURIComponent(GEMINI_API_KEY), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: vbody,
        signal: AbortSignal.timeout(60_000)
      });
      if (!r.ok) continue; /* busy/overloaded model → next one */
      const d = await r.json();
      const t = (d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts || []).map(p => p.text || "").join("").trim();
      if (t) { recordUse(req, "vision", 0); return t; }
    } catch (e) { /* next model */ }
  }
  return null;
}
/* Render injects PORT (its default is 10000). Falling back to 3000 on a host means
   the platform scans and scans and never sees an open port — "No open ports
   detected" — so the fallback must match the platform's own default. */
/* the platform's own default port; an unset PORT must never land on a port the
   platform does not scan (that alone reads as "No open ports detected") */
const PORT = parseInt(process.env.PORT, 10) || 10000;

/* ===================== THE PORT OPENS BEFORE THE REST OF THIS FILE ============
   Render rejected every deploy of the new build with "Application exited early"
   and quietly rolled back to an older one, while this exact code boots fine on
   the dev machine — a failure that leaves no usable evidence. A process that
   dies before the port opens is invisible. So the PORT is bound HERE, a few
   milliseconds into the process, by a tiny bootstrap responder, and the finished
   Express app takes that same socket over at the bottom of this file.
   Consequences: the platform always sees a live service (no false "exited
   early" and no rollback), and if any later line throws, /health still answers
   JSON naming the stage that died (stage/err/bootCrashes) instead of the deploy
   silently vanishing. */
/* SERVING IS THE DEFAULT (28 Oct 2026)
   Two deploys in a row died with "No open ports detected": the process was alive
   (boot line + Firebase init printed) but listen() never ran, because an “am I the
   entry file?” guess decided it — and on the deployed runtime that guess is wrong
   (newer Node leaves require.main unset, and a wrapper/require-based starter makes
   it point elsewhere). A server process exists to serve, so binding is now the
   default and the test suite opts out explicitly with AURA_NO_LISTEN=1. */
const IS_MAIN = process.env.AURA_NO_LISTEN !== "1";
let bootSrv = null;
if (IS_MAIN) {
  bootSrv = require("http").createServer((req, res) => {
    const body = JSON.stringify({
      ok: true, build: BUILD, booting: BOOT.stage !== "ready", node: process.version,
      stage: BOOT.stage, err: BOOT.err, uptime: Math.round(process.uptime()),
      note: "bootstrap responder — the Express app has not finished loading yet"
    });
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(req.method === "HEAD" ? undefined : body);
  });
  bootSrv.on("error", e => noteCrash("listen", e));
  console.log("[boot] binding 0.0.0.0:" + PORT + " (PORT env=" + (process.env.PORT || "unset") + " · main=" + IS_MAIN + " · requireMain=" + (require.main ? "set" : "unset") + " · render=" + (process.env.RENDER || process.env.RENDER_SERVICE_ID || "-") + ")");
  /* every interface, never loopback: a loopback-only bind is invisible to the port scan */
  bootSrv.listen(PORT, "0.0.0.0", () => console.log("[boot] port " + PORT + " bound in " + (Date.now() - BOOT.at) + "ms · bootstrap responder serving · build " + BUILD));
  bootSrv.once("error", e => {
    noteCrash("listen", e);
    /* last resort: the platform always scans 10000 */
    if (PORT !== 10000) setTimeout(() => { try { bootSrv.listen(10000, "0.0.0.0", () => console.log("[boot] fallback port 10000 bound")); } catch (e2) { noteCrash("listen-fallback", e2); } }, 500);
  });
  /* if the port is still closed 8s later, say so loudly instead of dying silently */
  setTimeout(() => { if (!bootSrv.listening) noteCrash("listen", new Error("port " + PORT + " still not bound after 8s (PORT env=" + (process.env.PORT || "unset") + ")")); }, 8000);
}
const MODELS = (process.env.MODELS || "openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b,meta-llama/llama-4-scout-17b-16e-instruct").split(",").map(s => s.trim()).filter(Boolean);

if (!KEY_POOL.length) {
  /* never crash the deploy — boot in degraded mode so Render stays green;
     /health and /v1/chat/completions report the missing key clearly */
  console.warn("WARNING: no primary AI key configured. Set AI_KEY_PRIMARY in the hosting dashboard, then redeploy.");
}
/* per-key cooldowns after 429 (10 min) — a cooled key re-enters the pool later */
const keyCool = new Map();
/* PUBLIC vs MAKER pools — the LAST key in the bank is RESERVED for the maker's
   admin brain (staff/plan/build/agent missions), so visitors can never drain the
   quota her self-upgrades depend on. Public chat shares the remaining keys. */
const PUBLIC_KEYS = KEY_POOL.length > 1 ? KEY_POOL.slice(0, KEY_POOL.length - 1) : KEY_POOL;
/* public chat prefers lighter, higher-quota models; the flagship stays at the
   tail as a last-resort fallback. The maker always gets the full flagship list. */
const PUBLIC_MODELS = (process.env.PUBLIC_MODELS || "meta-llama/llama-4-scout-17b-16e-instruct,openai/gpt-oss-20b,qwen/qwen3.8-27b,openai/gpt-oss-120b").split(",").map(s => s.trim()).filter(Boolean);
function pickKey(reserve) {
  const now = Date.now();
  const pool = reserve ? KEY_POOL : PUBLIC_KEYS;
  for (const k of pool) if (!(keyCool.get(k) > now)) return k;
  if (reserve) { for (const k of PUBLIC_KEYS) if (!(keyCool.get(k) > now)) return k; } /* maker may borrow when his reserved key cools */
  return null; // every usable key is cooling = daily allowance exhausted
}

/* DEDICATED KEY LANES — one key just for the CODE forge, one just for the
   maker's admin/upgradation brain. Set AI_KEY_CODE / AI_KEY_ADMIN in the
   hosting dashboard. A lane always falls back to the shared bank when its
   own key is drained or unset, so nothing ever hard-dies. */
const CODE_KEY = envv("AI_KEY_CODE", "CODE_KEY");
const ADMIN_KEY = envv("AI_KEY_ADMIN", "ADMIN_KEY");
function pickLaneKey(laneKey, reserve) {
  const now = Date.now();
  if (laneKey && !(keyCool.get(laneKey) > now)) return laneKey;
  return pickKey(reserve);
}

/* Lane keys may be Groq (gsk_…) or MISTRAL — anything else is treated as Mistral
   and routed to api.mistral.ai with provider-appropriate models. */
const MISTRAL_API = "https://api.mistral.ai/v1/chat/completions";
const MISTRAL_CODE_MODELS = (process.env.MISTRAL_CODE_MODELS || "codestral-latest,mistral-small-latest").split(",").map(s => s.trim()).filter(Boolean);
const MISTRAL_ADMIN_MODELS = (process.env.MISTRAL_ADMIN_MODELS || "mistral-large-latest,mistral-medium-latest,mistral-small-latest,codestral-latest").split(",").map(s => s.trim()).filter(Boolean);
const isMistral = k => !!k && !/^gsk_/.test(k);

/* Lane health — silent fallbacks hide broken keys, so every miss is recorded
   and shown to the owner in /v1/admin/usage + the KEY BANK panel. */
const laneErr = { code: "", admin: "" };
/* Mistral free tiers allow ~1 request/second — pace every lane call */
let mistralLastReq = 0;
const paceMistral = async () => { const wait = 1200 - (Date.now() - mistralLastReq); if (wait > 0) await new Promise(r => setTimeout(r, wait)); mistralLastReq = Date.now(); };

/* Non-streaming lane attempt — returns text or null (null = fall through to the shared bank) */
async function laneCall(laneName, laneKey, mistralModels, messages, maxTok, temperature, req) {
  if (!laneKey) { laneErr[laneName] = "key not set"; return null; }
  if (!isMistral(laneKey)) return null;
  if (keyCool.get(laneKey) > Date.now()) { laneErr[laneName] = "cooling down (rate limit / rejected)"; return null; }
  for (const model of mistralModels) {
    try {
      await paceMistral();
      const r = await fetch(MISTRAL_API, {
        method: "POST",
        headers: { "Authorization": "Bearer " + laneKey, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages, max_tokens: Math.min(maxTok, 8000), temperature: temperature != null ? temperature : 0.3 }),
        signal: AbortSignal.timeout(90_000)
      });
      if (!r.ok) {
        const bodyTxt = await r.text().catch(() => "");
        const detail = (bodyTxt.match(/"(message|type|detail)"\s*:\s*"([^"]{3,140})"/) || [])[2] || bodyTxt.slice(0, 100);
        if (r.status === 429) { laneErr[laneName] = "429 on " + model + ": " + detail + " — trying next model"; keyCool.set(laneKey, Date.now() + 20_000); continue; }
        if (r.status === 401) { keyCool.set(laneKey, Date.now() + 24 * 3600_000); laneErr[laneName] = "401 key invalid — check AI_KEY_" + laneName.toUpperCase() + ": " + detail; return null; }
        laneErr[laneName] = "HTTP " + r.status + " on " + model + ": " + detail;
        continue;
      }
      const d = await r.json();
      const t = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
      if (t && t.trim()) { laneErr[laneName] = ""; recordUse(req, laneKey, (d.usage && d.usage.total_tokens) || Math.round(t.length / 4), model); return t.trim(); }
    } catch (e) { laneErr[laneName] = "network: " + (e.message || String(e)); }
  }
  keyCool.set(laneKey, Date.now() + 70_000); /* whole chain failed — rest the key */
  return null;
}

/* Streaming lane attempt — re-emits OpenAI-style SSE deltas in AURA's event format.
   Returns "served" (caller finishes), "partial" (caller sends partial + finishes), or "miss". */
async function streamLane(opts) {
  const { laneName, apiKey, mistralModels, messages, maxTok, temperature, send, isClosed, req } = opts;
  if (!apiKey) { laneErr[laneName] = "key not set"; return "miss"; }
  if (!isMistral(apiKey) || !mistralModels.length) return "miss";
  if (keyCool.get(apiKey) > Date.now()) { laneErr[laneName] = "cooling down (rate limit / rejected)"; return "miss"; }
  for (const model of mistralModels) {
    if (isClosed()) return "miss";
    let r;
    try {
      await paceMistral();
      r = await fetch(MISTRAL_API, {
        method: "POST",
        headers: { "Authorization": "Bearer " + apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages, max_tokens: Math.min(maxTok, 8000), temperature: temperature != null ? temperature : 0.3, stream: true }),
        signal: AbortSignal.timeout(30_000)
      });
    } catch (e) { laneErr[laneName] = "network: " + (e.message || String(e)); continue; }
    if (r.status === 429) { laneErr[laneName] = "429 on " + model + " — trying next model"; keyCool.set(apiKey, Date.now() + 20_000); continue; }
    if (r.status === 401) { keyCool.set(apiKey, Date.now() + 24 * 3600_000); laneErr[laneName] = "key invalid (401) — check AI_KEY_" + laneName.toUpperCase(); return "miss"; }
    if (r.status === 403) { laneErr[laneName] = "model " + model + " not allowed on this key's plan (403) — trying the next Mistral model"; continue; }
    if (!r.ok || !r.body) { laneErr[laneName] = "model " + model + " unavailable (HTTP " + r.status + ")"; continue; }
    let full = "", announced = false;
    try {
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (!isClosed()) {
        const chunk = await Promise.race([
          reader.read(),
          new Promise((_, rej) => setTimeout(() => rej(new Error("idle")), full ? 45_000 : 25_000))
        ]);
        if (chunk.done) break;
        buf += dec.decode(chunk.value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop() || "";
        for (const ln of lines) {
          const s = ln.replace(/^data:\s*/, "").trim();
          if (!s || s === "[DONE]") continue;
          try {
            const j = JSON.parse(s);
            const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
            if (delta) { if (!announced) { send({ model: "mistral/" + model }); announced = true; } full += delta; send({ delta }); }
          } catch (e) {}
        }
      }
    } catch (idleErr) {
      if (full.length > 200) { recordUse(req, apiKey, Math.round(full.length / 4), model); return "partial"; }
      send({ reset: true }); continue;
    }
    if (isClosed()) return "miss";
    if (full.trim()) { laneErr[laneName] = ""; recordUse(req, apiKey, Math.round(full.length / 4), model); return "served"; }
    send({ reset: true });
  }
  return "miss";
}

/* QUOTA STRETCHERS — make the free key bank last far longer:
   1) ANSWER CACHE — repeated questions answered from memory, zero tokens burned
   2) VISITOR DAILY CAP — one heavy user can never solo-drain the public pool
   3) PUBLIC_MODELS — public chat runs on lighter, higher-quota models (below) */
const answerCache = new Map(); /* normalized question → { answer, model, t } */
const ANSWER_CACHE_TTL = parseInt(process.env.ANSWER_CACHE_TTL || "3600000", 10); /* 1h */
function normQ(messages) {
  const last = [...messages].reverse().find(m => m.role === "user" && typeof m.content === "string");
  return last ? last.content.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 300) : "";
}
/* a cache must never answer a question whose whole point is being current —
   "latest iPhone" was served a wrong 1-hour-old answer from here */
const FRESH_Q = /(latest|today|tonight|now|current|news|price|rate|score|result|schedule|when|kab|aaj|abhi|20[2-9][0-9]|winner|won|match|tournament|election|weather|stock|ipo|launch|release|update|trending|kitna)/i;
function cacheGet(messages) {
  const k = normQ(messages); if (!k) return null;
  if (FRESH_Q.test(k)) return null;
  const hit = answerCache.get(k);
  if (hit && Date.now() - hit.t < ANSWER_CACHE_TTL) return hit;
  if (hit) answerCache.delete(k);
  return null;
}
function cachePut(messages, answer, model) {
  const k = normQ(messages); if (!k || !answer) return;
  if (FRESH_Q.test(k)) return;
  if (answerCache.size > 400) answerCache.clear(); /* tiny footprint, self-healing */
  answerCache.set(k, { answer, model, t: Date.now() });
}
const DAILY_CAP = parseInt(process.env.VISITOR_DAILY_CAP || "40", 10); /* answers/visitor/day */
const dailyCap = new Map(); /* uid-or-IP → { day, n } */
function overCap(req) {
  if (!DAILY_CAP) return false;
  const id = req.__uid || req.ip || "anon";
  const rec = dailyCap.get(id);
  return !!(rec && rec.day === new Date().toISOString().slice(0, 10) && rec.n >= DAILY_CAP);
}
function countAnswer(req) {
  const id = req.__uid || req.ip || "anon";
  const day = new Date().toISOString().slice(0, 10);
  const rec = dailyCap.get(id);
  if (rec && rec.day === day) rec.n++;
  else dailyCap.set(id, { day, n: 1 });
  if (dailyCap.size > 5000) for (const [k, v] of dailyCap) if (v.day !== day) dailyCap.delete(k);
}

/* ============ USAGE LEDGER — the owner sees EXACTLY what burned the key bank.
   Every real AI call (chat, staff brain, agent, reserve, vision) records a
   masked key label + the identity that caused it. View: /v1/admin/usage ====== */
const TODAY = () => new Date().toISOString().slice(0, 10);
const keyUse = new Map();  /* masked key → { day, calls, tokens } */
const whoUse = new Map();  /* "uid:…" or "ip:…" → { day, aiCalls } */
function keyLabel(k) {
  if (!k) return "none";
  if (k === "vision") return "vision";
  if (k === RESERVE_KEY) return "reserve";
  if (k === CODE_KEY) return "code-lane";
  if (k === ADMIN_KEY) return "admin-lane";
  const i = KEY_POOL.indexOf(k);
  return i >= 0 ? "k" + (i + 1) + "…" + k.slice(-4) : "ext…" + k.slice(-4);
}
function recordUse(req, key, tokens, model) {
  try {
    const day = TODAY();
    const kl = keyLabel(key);
    const rec = keyUse.get(kl) || { day, calls: 0, tokens: 0 };
    if (rec.day !== day) { rec.day = day; rec.calls = 0; rec.tokens = 0; }
    rec.calls++; rec.tokens += tokens || 0;
    keyUse.set(kl, rec);
    const id = (req && req.__uid) ? "uid:" + String(req.__uid).slice(0, 8) : "ip:" + ((req && req.ip) || "unknown");
    const w = whoUse.get(id) || { day, aiCalls: 0 };
    if (w.day !== day) { w.day = day; w.aiCalls = 0; }
    w.aiCalls++;
    whoUse.set(id, w);
  } catch (e) {}
}
/* AGENT SPEND CAP — the agent loop fires several AI calls per run and was open
   to every visitor with no cap. Guests get a small daily allowance; makers unlimited. */
const AGENT_DAILY_CAP = parseInt(process.env.AGENT_DAILY_CAP || "12", 10);
const agentCap = new Map(); /* id → { day, n } */
function overAgentCap(req) {
  if (!AGENT_DAILY_CAP) return false;
  const id = req.__uid || req.ip || "anon";
  const rec = agentCap.get(id);
  return !!(rec && rec.day === TODAY() && rec.n >= AGENT_DAILY_CAP);
}
function countAgent(req) {
  const id = req.__uid || req.ip || "anon";
  const day = TODAY();
  const rec = agentCap.get(id);
  if (rec && rec.day === day) rec.n++;
  else agentCap.set(id, { day, n: 1 });
}

app.use(express.json({ limit: "8mb" })); /* room for base64 photos (vision) */

/* PRIVATE GATE — the backend is reachable by URL (static sites call it directly
   from the visitor's browser), but it serves ONLY its own sites: browsers identify
   themselves with the Origin header, and the owner's tools with X-AURA-Key.
   curl / scrapers / strangers get a 403. /health stays open for uptime monitors. */
/* Sites allowed to call this backend from a browser. The owner's own projects are
   ALWAYS allowed (Lucid lives on its Firebase host, AURA + IdeaVeda on theirs, and
   the portfolio on GitHub Pages), then the dashboard's ALLOW_ORIGINS list adds
   whatever else is needed. Without this, adding one origin in the dashboard would
   silently lock the other projects out. */
const OWN_SITES = [
  "https://sourabh7300.github.io",
  "https://aura-live-81185.web.app", "https://aura-live-81185.firebaseapp.com",
  "https://lucid-app-preview.web.app", "https://lucid-app-preview.firebaseapp.com",
  "https://ideaveda-live-app.web.app", "https://ideaveda-live-app.firebaseapp.com",
];
const ALLOW_ORIGINS = [...new Set(OWN_SITES.concat(
  (process.env.ALLOW_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean)
))];
const OWNER_SECRET = process.env.SECRET || "";
app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  const okOrigin = ALLOW_ORIGINS.includes(origin) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (req.path === "/health" || req.path === "/" || req.path === "/v1/ping" || req.path === "/v1/squad/beat") {
    /* public paths still need CORS headers or browsers block the boot ping */
    if (okOrigin) { res.setHeader("Access-Control-Allow-Origin", origin); res.setHeader("Vary", "Origin"); }
    /* the app itself saves chats/notes with PUT and wipes them with DELETE —
     omitting those methods made every preflight fail on the live site */
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-AURA-Key, Authorization");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    return next();
  }
  const okSecret = OWNER_SECRET && req.headers["x-aura-key"] === OWNER_SECRET;
  /* the autopilot cron has no Origin header — its own key is a legitimate caller */
  const okSquad = SQUAD_TICK_SECRET && req.headers["x-squad-key"] === SQUAD_TICK_SECRET;
  if (!okOrigin && !okSecret && !okSquad && process.env.OPEN_GATE !== "1") {
    return res.status(403).json({ error: "forbidden", message: "This AURA backend serves its own sites only." });
  }
  if (okOrigin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  /* the app itself saves chats/notes with PUT and wipes them with DELETE —
     omitting those methods made every preflight fail on the live site */
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-AURA-Key, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* simple per-IP rate limit: 30 req / min (configurable) — signed-in users get
   their own generous bucket keyed by uid instead of their shared IP */
const hits = new Map();
app.use((req, res, next) => {
  const now = Date.now();
  const k = (req.__uid || req.ip || "anon") + (/^\/v1\/mesh\//.test(req.path) ? ":mesh" : "");
  const isMeshRelay = /^\/v1\/mesh\//.test(req.path); /* nodes heartbeat every ~2.5s, ZEUS panel refreshes every 4s — normal limits would strangle the mesh */
  const limit = isMeshRelay ? 600 : (req.__uid ? parseInt(process.env.USER_RATE_LIMIT || "60", 10) : parseInt(process.env.RATE_LIMIT || "30", 10));
  const rec = hits.get(k) || { n: 0, win: now };
  if (now - rec.win > 60_000) { rec.n = 0; rec.win = now; }
  rec.n++;
  hits.set(k, rec);
  if (rec.n > limit) {
    return res.status(429).json({ error: "Slow down — try again in a minute." });
  }
  next();
});

/* ============ FIREBASE ACCOUNTS — real auth, roles, cloud data ============
   Configure privately in the dashboard: FB_PROJECT, FB_EMAIL, FB_PRIVATE_KEY
   (service-account credentials — never in this repo), MAKER_UIDS (comma list).
   Until configured, every accounts endpoint degrades gracefully and the site
   keeps working exactly as before. */
let fbAdmin = null, fbAuth = null, fbDb = null, fbDbErr = "", fbTried = false;
const FB_PROJECT = process.env.FB_PROJECT || "";
const FB_EMAIL = process.env.FB_EMAIL || "";
const FB_PRIVATE_KEY = (process.env.FB_PRIVATE_KEY || "").replace(/\\n/g, "\n");
function fbInit() {
  if (fbTried) return fbAdmin;
  fbTried = true;
  if (!FB_PROJECT || !FB_EMAIL || !FB_PRIVATE_KEY) return null;
  try {
    fbAdmin = require("firebase-admin");
    fbAdmin.initializeApp({ credential: fbAdmin.credential.cert({ projectId: FB_PROJECT, clientEmail: FB_EMAIL, privateKey: FB_PRIVATE_KEY }) });
    fbAuth = fbAdmin.auth();
    try { fbDb = fbAdmin.firestore(); fbDbErr = ""; } catch (e) { fbDb = null; fbDbErr = String(e.message || e).slice(0, 180); }
    console.log("accounts backend: online");
  } catch (e) { console.log("accounts backend: package missing —", e.message); fbAdmin = null; }
  return fbAdmin;
}
const tokCache = new Map(); /* uid → {role, exp} — verified tokens, never client claims */
async function verifyUser(req) {
  if (!fbInit()) return null;
  const h = req.headers["authorization"] || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  try {
    const dec = fbAdmin ? JSON.parse(Buffer.from(m[1].split(".")[1], "base64").toString()).sub : null;
    const ck = tokCache.get(dec);
    if (ck && ck.exp > Date.now()) return ck;
  } catch (e) {}
  try {
    const u = await fbAuth.verifyIdToken(m[1], true);
    let profile = null;
    if (fbDb) { try { profile = (await fbDb.collection("aura_users").doc(u.uid).get()).data() || null; } catch (e) {} }
    const makers = (process.env.MAKER_UIDS || "").split(",").map(s => s.trim()).filter(Boolean);
    let role = (u.role || (profile && profile.role) || "user");
    if (makers.includes(u.uid)) role = "maker";
    const rec = { uid: u.uid, email: u.email || "", name: u.name || (profile && profile.name) || (u.email ? u.email.split("@")[0] : "User"), phone: u.phone_number || "", role, exp: u.exp * 1000 };
    tokCache.set(rec.uid, rec);
    return rec;
  } catch (e) { return null; }
}
async function requireRole(req, res, roles) {
  const u = await verifyUser(req);
  if (!u) { res.status(401).json({ error: "Sign in to use this." }); return null; }
  if (!roles.includes(u.role)) { res.status(403).json({ error: "This control is reserved for " + roles.join("/") + " accounts." }); return null; }
  /* SINGLE-OWNER LOCK — this app has exactly one owner. Even a role claim is not
     enough: the uid itself must be on the owner list (MAKER_UIDS in the dashboard).
     Every admin write route flows through here, so the lock is server-side. */
  const owners = (process.env.MAKER_UIDS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (owners.length && !owners.includes(u.uid)) { res.status(403).json({ error: "owner-only: this console answers to exactly one account" }); return null; }
  return u;
}
/* attach identity (if any) early so the rate limiter can key on uid */
app.use(async (req, res, next) => {
  if (req.path === "/health" || req.path === "/") return next();
  const u = await verifyUser(req).catch(() => null);
  if (u) { req.__uid = u.uid; req.__role = u.role; }
  next();
});

/* ---- public config (brand + engine label + web config) — editable by maker/ceo in the DB ---- */
let memConfig = { aiEngine: "llama-3.3-70b · gpt-oss-120b", brandLine: "voice + code AI assistant", announce: "" };
app.get("/v1/config", async (req, res) => {
  const out = Object.assign({}, memConfig);
  if (process.env.FIREBASE_WEB_CONFIG) { try { out.firebaseWebConfig = JSON.parse(process.env.FIREBASE_WEB_CONFIG); } catch (e) {} }
  if (fbDb) { try { const d = await fbDb.collection("aura_config").doc("public").get(); if (d.exists) Object.assign(out, d.data()); } catch (e) {} }
  res.json(out);
});

/* ---- public totals for the admin telemetry (no secrets, no personal data) ---- */
app.get("/v1/usage", async (req, res) => {
  let answers = memConfig.__answers || 0, users = 0, staff = 0;
  if (fbDb) {
    try {
      const snap = await fbDb.collection("aura_users").limit(200).get();
      users = snap.size;
      snap.forEach(d => { const v = d.data() || {}; if (v.role === "maker" || v.role === "ceo") staff++; answers += (v.blob && v.blob.usage && v.blob.usage.answers) || 0; });
    } catch (e) {}
  }
  res.json({ ok: true, answers, users, staff, cacheSize: answerCache.size, dailyCap: DAILY_CAP || 0 });
});

/* ---- who am I (role comes from the VERIFIED token, never the client) ---- */
app.get("/v1/me", async (req, res) => {
  const u = await verifyUser(req);
  if (!u) return res.status(401).json({ error: "no session" });
  res.json({ uid: u.uid, email: u.email, name: u.name, phone: u.phone, role: u.role });
});

/* ---- per-user cloud storage: chats + memory blob (export & delete supported) ---- */
app.get("/v1/userdata", async (req, res) => {
  const u = await verifyUser(req);
  if (!u) return res.status(401).json({ error: "Sign in to sync your data." });
  if (!fbDb) return res.status(503).json({ error: "Cloud sync is warming up — data still saves on this device." });
  try {
    const d = await fbDb.collection("aura_users").doc(u.uid).get();
    res.json({ ok: true, data: d.exists ? (d.data().blob || null) : null, updated: d.exists ? d.data().updated : 0 });
  } catch (e) { res.status(500).json({ error: "sync read failed" }); }
});
app.put("/v1/userdata", async (req, res) => {
  const u = await verifyUser(req);
  if (!u) return res.status(401).json({ error: "Sign in to sync your data." });
  if (!fbDb) return res.status(503).json({ error: "Cloud sync is warming up — data still saves on this device." });
  const blob = req.body || {};
  if (JSON.stringify(blob).length > 900_000) return res.status(413).json({ error: "Data too large to sync." });
  try {
    await fbDb.collection("aura_users").doc(u.uid).set({ blob, updated: Date.now(), name: u.name, email: u.email }, { merge: true });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "sync write failed" }); }
});
app.delete("/v1/userdata", async (req, res) => {
  const u = await verifyUser(req);
  if (!u) return res.status(401).json({ error: "Sign in first." });
  if (!fbDb) return res.status(503).json({ error: "Cloud sync is warming up." });
  try {
    /* HARD DELETE — the account's document (chats, memory, sessions, usage) is
       removed from the database entirely, not blanked. Any Firestore rule must
       allow delete on aura_users/{uid} for its own signed-in uid. */
    await fbDb.collection("aura_users").doc(u.uid).delete();
    res.json({ ok: true, deleted: true });
  }
  catch (e) {
    /* rules that forbid delete fall back to a blanked doc — still private to the caller */
    try { await fbDb.collection("aura_users").doc(u.uid).set({ blob: {}, updated: Date.now() }, { merge: true }); res.json({ ok: true, deleted: "blanked" }); }
    catch (e2) { res.status(500).json({ error: "delete failed" }); }
  }
});

/* ---- ADMIN — server-verified maker/ceo only (never trust the page) ---- */
app.get("/v1/admin/users", async (req, res) => {
  const u = await requireRole(req, res, ["maker", "ceo"]);
  if (!u) return;
  if (!fbDb) return res.status(503).json({ error: "User registry needs the database enabled." });
  try {
    const snap = await fbDb.collection("aura_users").limit(200).get();
    const users = snap.docs.map(d => { const v = d.data() || {}; return { uid: d.id, name: v.name || "", email: v.email || "", role: v.role || "user", updated: v.updated || 0, msgs: (v.blob && v.blob.usage && v.blob.usage.answers) || 0 }; });
    res.json({ ok: true, users });
  } catch (e) { res.status(500).json({ error: "registry read failed" }); }
});
app.post("/v1/admin/setrole", async (req, res) => {
  const u = await requireRole(req, res, ["maker"]);
  if (!u) return;
  const target = String((req.body || {}).uid || "");
  const role = String((req.body || {}).role || "");
  if (!target || !["user", "ceo", "maker"].includes(role)) return res.status(400).json({ error: "uid + role(user|ceo|maker) required" });
  /* nobody can re-role the owner, and only the owner can hand out roles at all */
  const owners = (process.env.MAKER_UIDS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (owners.includes(target) && target !== u.uid) return res.status(403).json({ error: "the owner account cannot be re-roled" });
  if (!fbAuth) return res.status(503).json({ error: "accounts backend warming up" });
  try {
    await fbAuth.setCustomUserClaims(target, { role });
    if (fbDb) await fbDb.collection("aura_users").doc(target).set({ role }, { merge: true });
    tokCache.delete(target);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "could not set role" }); }
});
app.post("/v1/admin/config", async (req, res) => {
  const u = await requireRole(req, res, ["maker", "ceo"]);
  if (!u) return;
  const patch = {};
  const b = req.body || {};
  for (const k of ["aiEngine", "brandLine", "announce"]) if (typeof b[k] === "string") patch[k] = b[k].slice(0, 300);
  /* SELF-INTEGRATION — shipped upgrade patches (admin-only write, public read).
     Hard cap: 20 patches × 8000 chars each so the config doc stays tiny. */
  if (typeof b.selfPatches === "string") {
    let arr = [];
    try { arr = JSON.parse(b.selfPatches); } catch (e) {}
    if (Array.isArray(arr)) {
      patch.selfPatches = JSON.stringify(arr.slice(-20).map(p => ({
        ts: +p.ts || Date.now(),
        task: String(p.task || "").slice(0, 300),
        patch: String(p.patch || "").slice(0, 8000),
        note: String(p.note || "").slice(0, 200)
      })));
    }
  }
  if (fbDb) { try { await fbDb.collection("aura_config").doc("public").set(patch, { merge: true }); } catch (e) { Object.assign(memConfig, patch); } }
  else Object.assign(memConfig, patch);
  res.json({ ok: true, config: Object.assign({}, memConfig, patch) });
});

/* ---- USAGE LEDGER — who/what is spending the AI key bank today (owner-only) ---- */
app.get("/v1/admin/usage", async (req, res) => {
  const u = await requireRole(req, res, ["maker", "ceo"]);
  if (!u) return;
  const day = TODAY();
  const keys = [...keyUse.entries()].filter(([, v]) => v.day === day).map(([k, v]) => ({ key: k, aiCalls: v.calls, tokens: v.tokens }));
  const who = [...whoUse.entries()].filter(([, v]) => v.day === day).map(([k, v]) => ({ who: k, aiCalls: v.aiCalls })).sort((a, b) => b.aiCalls - a.aiCalls).slice(0, 25);
  res.json({
    ok: true, day,
    keyBank: { total: KEY_POOL.length, liveNow: KEY_POOL.filter(k => !(keyCool.get(k) > Date.now())).length },
    lanes: { code: !!CODE_KEY, admin: !!ADMIN_KEY, health: { code: laneErr.code || "ok", admin: laneErr.admin || "ok" } },
    spendByKey: keys.length ? keys : [{ key: "(no AI calls yet today)", aiCalls: 0, tokens: 0 }],
    biggestSpenders: who.length ? who : [{ who: "(no AI traffic yet today)", aiCalls: 0 }],
    guestAgentRunsPerDay: AGENT_DAILY_CAP
  });
});

/* ================= SELF-INTEGRATION: SOURCE EDIT MODE =================
   AURA reads and rewrites her OWN source file in her GitHub repo.
   The GitHub token lives ONLY here (Render env) — never in the browser. */
const GH_TOKEN = envv("GH_TOKEN", "GITHUB_TOKEN");
const GH_REPO = process.env.GH_REPO || "sourabh7300/aura";
const GH_FILE = process.env.GH_FILE || "aura.html";
const GH_BRANCH = process.env.GH_BRANCH || "main";
const GH_API = "https://api.github.com";
async function ghFetchRaw() {
  try {
    const r = await fetch(`https://raw.githubusercontent.com/${GH_REPO}/${GH_BRANCH}/${GH_FILE}?t=${Date.now()}`, { headers: { "Authorization": "Bearer " + GH_TOKEN, "Accept": "text/plain", "User-Agent": "aura-self-integration" }, signal: AbortSignal.timeout(30000) });
    if (r.ok) return r.text();
  } catch (e) {}
  /* fallback: Contents API (works with every token type, incl. fine-grained) */
  const r2 = await fetch(`${GH_API}/repos/${GH_REPO}/contents/${GH_FILE}?ref=${GH_BRANCH}`, { headers: { "Authorization": "Bearer " + GH_TOKEN, "User-Agent": "aura-self-integration", "Accept": "application/vnd.github+json" }, signal: AbortSignal.timeout(30000) });
  if (!r2.ok) throw new Error("source read failed: HTTP " + r2.status);
  const j = await r2.json();
  if (!j.content) throw new Error("source read failed: empty content");
  return Buffer.from(j.content, "base64").toString("utf8");
}
/* GitHub token health — safe booleans only, cached 10 min (used by /health) */
let ghCheckCache = { at: 0, state: "unchecked" };
async function ghCheck() {
  if (!GH_TOKEN) return "missing";
  if (Date.now() - ghCheckCache.at < 10 * 60_000) return ghCheckCache.state;
  try {
    const r = await fetch(`${GH_API}/repos/${GH_REPO}`, { headers: { "Authorization": "Bearer " + GH_TOKEN, "User-Agent": "aura-self-integration", "Accept": "application/vnd.github+json" }, signal: AbortSignal.timeout(15000) });
    ghCheckCache = { at: Date.now(), state: r.status === 200 ? "ok" : (r.status === 401 || r.status === 403 ? "invalid" : "error:" + r.status) };
  } catch (e) { ghCheckCache = { at: Date.now(), state: "unreachable" }; }
  return ghCheckCache.state;
}
app.get("/v1/dev/status", async (req, res) => {
  const u = await requireRole(req, res, ["maker", "ceo"]);
  if (!u) return;
  const out = { connected: !!GH_TOKEN, repo: GH_REPO, file: GH_FILE, branch: GH_BRANCH };
  if (GH_TOKEN) {
    try {
      const r = await fetch(`${GH_API}/repos/${GH_REPO}/commits?sha=${GH_BRANCH}&per_page=1`, { headers: { "Authorization": "Bearer " + GH_TOKEN, "User-Agent": "aura-self-integration", "Accept": "application/vnd.github+json" }, signal: AbortSignal.timeout(20000) });
      if (r.ok) { const j = await r.json(); const c = j[0] || {}; out.lastCommit = { sha: (c.sha || "").slice(0, 7), message: ((c.commit && c.commit.message) || "").slice(0, 120), when: c.commit && c.commit.author && c.commit.author.date }; }
      else out.lastCommit = { error: "HTTP " + r.status };
    } catch (e) { out.lastCommit = { error: e.message || String(e) }; }
  }
  res.json(out);
});
app.get("/v1/dev/source", async (req, res) => {
  const u = await requireRole(req, res, ["maker", "ceo"]);
  if (!u) return;
  try {
    const src = await ghFetchRaw();
    const lines = src.split("\n");
    const q = String(req.query.q || "").trim();
    const out = { ok: true, bytes: src.length, lines: lines.length, matches: [] };
    if (q) {
      let re = null;
      try { re = new RegExp(q, "i"); } catch (e) { re = null; }
      for (let i = 0; i < lines.length && out.matches.length < 30; i++) {
        const hit = (re && re.test(lines[i])) || lines[i].includes(q);
        if (hit) out.matches.push({ line: i + 1, text: lines[i].slice(0, 300) });
      }
      out.matchCount = out.matches.length;
    }
    res.json(out);
  } catch (e) { res.status(502).json({ error: e.message || String(e) }); }
});
app.post("/v1/dev/commit", async (req, res) => {
  const u = await requireRole(req, res, ["maker", "ceo"]);
  if (!u) return;
  if (!GH_TOKEN) return res.status(503).json({ error: "GitHub not connected — add GH_TOKEN to the backend env." });
  const b = req.body || {};
  const edits = Array.isArray(b.edits) ? b.edits.slice(0, 12) : [];
  const message = String(b.message || "AURA self-upgrade").slice(0, 200);
  if (!edits.length || edits.some(e => !e || !String(e.find).length)) return res.status(400).json({ error: "edits array with non-empty find strings required" });
  try {
    let src = await ghFetchRaw();
    /* WHITESPACE-TOLERANT ANCHORING — code models paraphrase indentation and
       blank lines; a human engineer's applier doesn't care. Exact match wins;
       otherwise match with all whitespace runs collapsed. This is what makes
       her first-draft edits actually LAND instead of dying in dry-run. */
    const normMap = s => { let out = "", map = [], sp = false; for (let i = 0; i < s.length; i++) { const c = s[i]; if (/\s/.test(c)) { if (sp) continue; sp = true; out += " "; map.push(i); } else { sp = false; out += c; map.push(i); } } return { text: out, map }; };
    const findAllTolerant = (hay, needle) => { const A = normMap(hay), B = normMap(needle); const spans = []; let i = A.text.indexOf(B.text); while (i > -1 && spans.length < 50) { spans.push([A.map[i], A.map[i + B.text.length - 1] + 1]); i = A.text.indexOf(B.text, i + 1); } return spans; };
    const applied = [];
    for (const ed of edits) {
      const find = String(ed.find), replace = String(ed.replace == null ? "" : ed.replace);
      let spans = [], count = src.split(find).length - 1;
      if (count > 0) { let i = src.indexOf(find); while (i > -1 && spans.length < 50) { spans.push([i, i + find.length]); i = src.indexOf(find, i + 1); } }
      else { spans = findAllTolerant(src, find); count = spans.length; }
      if (count === 0) return res.status(409).json({ ok: false, error: "find-string not found in current file (even whitespace-insensitively — copy it from the REAL excerpts shown to you)", failedEdit: find.slice(0, 120), appliedSoFar: applied.length });
      if (count > 1 && !ed.replaceAll) return res.status(409).json({ ok: false, error: `find-string matches ${count} locations — make it longer or send replaceAll:true`, failedEdit: find.slice(0, 120), appliedSoFar: applied.length });
      const i0 = spans[0][0];
      src = count > 1 ? spans.reverse().reduce((acc, sp2) => acc.slice(0, sp2[0]) + replace + acc.slice(sp2[1]), src) : src.slice(0, i0) + replace + src.slice(spans[0][1]);
      applied.push({ count, atLine: src.slice(0, i0).split("\n").length });
    }
    const meta = await (await fetch(`${GH_API}/repos/${GH_REPO}/contents/${GH_FILE}?ref=${GH_BRANCH}`, { headers: { "Authorization": "Bearer " + GH_TOKEN, "User-Agent": "aura-self-integration", "Accept": "application/vnd.github+json" }, signal: AbortSignal.timeout(30000) })).json();
    if (!meta || !meta.sha) return res.status(502).json({ error: "could not read file metadata from GitHub" });
    if (b.dryRun) return res.json({ ok: true, dryRun: true, edits: applied.length, occurrences: applied.map(a => a.count), firstChangeAtLine: applied[0] && applied[0].atLine, newBytes: Buffer.byteLength(src), commitSha: meta.sha.slice(0, 7) });
    const put = await fetch(`${GH_API}/repos/${GH_REPO}/contents/${GH_FILE}`, { method: "PUT", headers: { "Authorization": "Bearer " + GH_TOKEN, "User-Agent": "aura-self-integration", "Accept": "application/vnd.github+json", "Content-Type": "application/json" }, body: JSON.stringify({ message, content: Buffer.from(src).toString("base64"), sha: meta.sha, branch: GH_BRANCH }), signal: AbortSignal.timeout(60000) });
    const pj = await put.json().catch(() => ({}));
    if (!put.ok) return res.status(502).json({ error: "GitHub commit failed: " + (pj && pj.message || "HTTP " + put.status) });
    /* this answer promises the change is live in ~60s — that is only true when the
       public repo receives the same bytes (same missing last mile as the publish lane) */
    try { await ghMirrorLive(src, message); } catch (e) {}
    res.json({ ok: true, commit: (pj.commit && pj.commit.sha || "").slice(0, 7), edits: applied.length, url: pj.content && pj.content.html_url, liveMirror: ghMirrorLast.note, liveIn: "~60 seconds (GitHub Pages rebuild)" });
  } catch (e) { res.status(502).json({ error: e.message || String(e) }); }
});

/* STAFF BRAIN — completions reserved for verified maker/ceo accounts.
   Self-integration planning runs through HERE, never through the public
   proxy, so guests can never borrow admin prompts or model budgets. */
app.post("/v1/staff/brain", async (req, res) => {
  const u = await requireRole(req, res, ["maker", "ceo"]);
  if (!u) return;
  const body = req.body || {};
  const messages = Array.isArray(body.messages) ? body.messages.slice(-12) : null;
  if (!messages || messages.some(m => !m || typeof m.content !== "string")) return res.status(400).json({ error: "messages required" });
  /* FEATURE BIAS — commands that build/add/change features get HIGH reasoning effort,
     so she actually engineers instead of answering fast and shallow. */
  const __task = messages.map(m => m.content).join(" ");
  const __feature = /\b(add|build|create|make|implement|wire|integrate|feature|panel|button|system|mode|fix)\b/i.test(__task) && !/appearance|just color|animation only|cosmetic/i.test(__task);
  const __effort = (body.reasoning_effort === "high" || __feature) ? "high" : "medium";
  const baseTok = Math.min(body.max_tokens || 3000, 16000); /* real features need room — gpt-oss thinks INSIDE the token budget */

  /* STREAM MODE — the maker watches the code materialize live.
     Watchdogs are IDLE-based: a model only dies if it stops producing tokens
     (25s to first token, 45s between tokens) — a long healthy generation
     is never killed for being slow. A good partial (>200 chars) is rescued
     rather than thrown away. */
  if (body.stream === true) {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") res.flushHeaders();
    const send = o => { try { res.write("data: " + JSON.stringify(o) + "\n\n"); } catch (e) {} };
    const finish = () => { try { res.write("data: [DONE]\n\n"); res.end(); } catch (e) {} };
    let closed = false;
    req.on("close", () => { closed = true; });
    try {
      /* ADMIN LANE — a Mistral key in AI_KEY_ADMIN streams FIRST (her upgrade brain),
         so upgradation never competes with the Groq bank. Any miss falls through to Groq. */
      const __laneRes = await streamLane({ laneName: "admin", apiKey: ADMIN_KEY, mistralModels: MISTRAL_ADMIN_MODELS, messages, maxTok: baseTok, temperature: body.temperature, send, isClosed: () => closed, req });
      if (__laneRes === "served") { finish(); return; }
      if (__laneRes === "partial") { send({ partial: true }); finish(); return; }
      for (const model of MODELS) {
        if (closed) return;
        const key = pickLaneKey(ADMIN_KEY, true); /* dedicated admin-upgrade lane, falls back to the maker bank */
        if (!key) break;
        const mt = model.startsWith("openai/gpt-oss") ? Math.max(baseTok, 12000) : baseTok;
        let r;
        try {
          r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
            body: JSON.stringify({ model, messages, max_tokens: mt, temperature: body.temperature != null ? body.temperature : 0.3, reasoning_effort: __effort, stream: true }),
            signal: AbortSignal.timeout(30_000) /* connect + first response headers only */
          });
        } catch (e) { continue; }
        if (r.status === 429) { keyCool.set(key, Date.now() + 70_000); continue; }
        if (r.status === 401 || r.status === 403) { keyCool.set(key, Date.now() + 24 * 3600_000); continue; }
        if (!r.ok || !r.body) continue;
        let full = "", announced = false;
        try {
          const reader = r.body.getReader();
          const dec = new TextDecoder();
          let buf = "";
          while (!closed) {
            const chunk = await Promise.race([
              reader.read(),
              new Promise((_, rej) => setTimeout(() => rej(new Error("idle")), full ? 45_000 : 25_000))
            ]);
            if (chunk.done) break;
            buf += dec.decode(chunk.value, { stream: true });
            const lines = buf.split("\n"); buf = lines.pop() || "";
            for (const ln of lines) {
              const s = ln.replace(/^data:\s*/, "").trim();
              if (!s || s === "[DONE]") continue;
              try {
                const j = JSON.parse(s);
                const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
                if (delta) { if (!announced) { send({ model }); announced = true; } full += delta; send({ delta }); }
              } catch (e) {}
            }
          }
        } catch (idleErr) {
          /* stalled — rescue a decent partial, otherwise move to the next brain */
          if (full.length > 200) { recordUse(req, key, Math.round(full.length / 4), model); send({ partial: true }); finish(); return; }
          send({ reset: true });
          continue;
        }
        if (closed) return;
        if (full.trim()) { recordUse(req, key, Math.round(full.length / 4), model); finish(); return; }
        send({ reset: true });
      }
      try { const rt = await reserveCall(messages, baseTok, body.temperature != null ? body.temperature : 0.3, req); if (rt) { send({ model: "reserve" }); send({ delta: rt }); finish(); return; } } catch (e) {}
      const live = KEY_POOL.filter(k => !(keyCool.get(k) > Date.now())).length;
      const hint = !KEY_POOL.length ? "no AI keys configured on the backend"
        : live === 0 ? "all " + KEY_POOL.length + " AI keys are cooling/drained (free-tier limit) — add a fresh Groq key in the Render dashboard or retry in ~1 min"
        : "upstream models refused — retry shortly";
      send({ error: "All brains busy — try again shortly.", hint, keysLive: live });
      finish();
    } catch (e) { send({ error: e.message || String(e) }); finish(); }
    return;
  }

  /* JSON MODE — unchanged contract for tooling and tests */
  { const __lt = await laneCall("admin", ADMIN_KEY, MISTRAL_ADMIN_MODELS, messages, baseTok, body.temperature != null ? body.temperature : 0.3, req); if (__lt) return res.json({ choices: [{ message: { content: __lt } }], model: "admin-lane" }); }
  for (const model of MODELS) {
    try {
      const mt = model.startsWith("openai/gpt-oss") ? Math.max(baseTok, 12000) : baseTok;
      const key = pickLaneKey(ADMIN_KEY, true); /* dedicated admin-upgrade lane — public traffic never touches it */
      if (!key) break;
      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages, max_tokens: mt, temperature: body.temperature != null ? body.temperature : 0.3, reasoning_effort: __effort }),
        signal: AbortSignal.timeout(60_000)
      });
      if (r.status === 429) { keyCool.set(key, Date.now() + 70_000); continue; }
      if (r.status === 401 || r.status === 403) { keyCool.set(key, Date.now() + 24 * 3600_000); continue; }
      if (!r.ok) continue; /* one model hiccuping must not kill the loop — try the next brain */
      const d = await r.json();
      const t = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
      if (t && t.trim()) { recordUse(req, key, (d.usage && d.usage.total_tokens) || Math.round(t.length / 4), model); return res.json({ choices: [{ message: { content: t.trim() } }], model }); }
    } catch (e) {}
  }
  try { const rt = await reserveCall(messages, baseTok, body.temperature != null ? body.temperature : 0.3, req); if (rt) return res.json({ choices: [{ message: { content: rt } }], model: "reserve" }); } catch (e) {}
  const live = KEY_POOL.filter(k => !(keyCool.get(k) > Date.now())).length;
  const hint = !KEY_POOL.length ? "no AI keys configured on the backend"
    : live === 0 ? "all " + KEY_POOL.length + " AI keys are cooling/drained (free-tier limit) — add a fresh Groq key in the Render dashboard or retry in ~1 min"
    : "upstream models refused — retry shortly";
  res.status(503).json({ error: "All brains busy — try again shortly.", hint, keysLive: live, keysTotal: KEY_POOL.length });
});

/* SOURCE WINDOWS — give her the real code around her search terms, so she codes WITH context
   (like a real engineer: search the file, read the surrounding lines, then write the edit) */
app.get("/v1/dev/windows", async (req, res) => {
  const u = await requireRole(req, res, ["maker", "ceo"]);
  if (!u) return;
  try {
    const src = await ghFetchRaw();
    const lines = src.split("\n");
    const terms = String(req.query.terms || "").split(",").map(s => s.trim()).filter(Boolean).slice(0, 6);
    const taken = [];
    const windows = [];
    for (const term of terms) {
      let re = null; try { re = new RegExp(term, "i"); } catch (e) {}
      for (let i = 0; i < lines.length; i++) {
        if (!((re && re.test(lines[i])) || lines[i].includes(term))) continue;
        const start = Math.max(0, i - 18), end = Math.min(lines.length, i + 26);
        if (taken.some(t => start < t.end && end > t.start)) { windows.push({ term, merged: true, aroundLine: i + 1 }); break; }
        taken.push({ start, end });
        windows.push({ term, startLine: start + 1, endLine: end, code: lines.slice(start, end).join("\n").slice(0, 7000) });
        break;
      }
    }
    res.json({ ok: true, fileLines: lines.length, windows });
  } catch (e) { res.status(502).json({ error: e.message || String(e) }); }
});

/* UPGRADE HISTORY — her self-upgrade commits, newest first (admin-only) */
app.get("/v1/dev/history", async (req, res) => {
  const u = await requireRole(req, res, ["maker", "ceo"]);
  if (!u) return;
  if (!GH_TOKEN) return res.status(503).json({ error: "GitHub not connected." });
  try {
    const r = await fetch(`${GH_API}/repos/${GH_REPO}/commits?sha=${GH_BRANCH}&per_page=30`, { headers: { "Authorization": "Bearer " + GH_TOKEN, "User-Agent": "aura-self-integration", "Accept": "application/vnd.github+json" }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) return res.status(502).json({ error: "GitHub HTTP " + r.status });
    const j = await r.json();
    const commits = (Array.isArray(j) ? j : []).map(c => ({
      sha: (c.sha || "").slice(0, 7),
      message: ((c.commit && c.commit.message) || "").split("\n")[0].slice(0, 120),
      when: c.commit && c.commit.author && c.commit.author.date,
      author: c.author && c.author.login || (c.commit && c.commit.author && c.commit.author.name) || "",
      selfUpgrade: /^AURA self-upgrade:/i.test((c.commit && c.commit.message) || "")
    }));
    res.json({ ok: true, commits });
  } catch (e) { res.status(502).json({ error: e.message || String(e) }); }
});

/* REVERT — undo any commit by SHA (uses GitHub's native revert → always safe, no find/replace guessing) */
app.post("/v1/dev/revert", async (req, res) => {
  const u = await requireRole(req, res, ["maker", "ceo"]);
  if (!u) return;
  if (!GH_TOKEN) return res.status(503).json({ error: "GitHub not connected." });
  const sha = String((req.body || {}).sha || "").trim();
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return res.status(400).json({ error: "valid commit sha required" });
  try {
    /* Preferred: GitHub's native revert endpoint */
    let r = await fetch(`${GH_API}/repos/${GH_REPO}/commits/${sha}/reverts`, {
      method: "POST",
      headers: { "Authorization": "Bearer " + GH_TOKEN, "User-Agent": "aura-self-integration", "Accept": "application/vnd.github+json", "Content-Type": "application/json" },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(60000)
    });
    let j = await r.json().catch(() => ({}));
    /* Fallback: native endpoint unavailable on this token → restore the file from the commit's PARENT via the Contents API.
       Same mechanism her normal commits use (proven to work), just with the parent's file content. */
    if (!r.ok) {
      const meta = await (await fetch(`${GH_API}/repos/${GH_REPO}/commits/${sha}`, { headers: { "Authorization": "Bearer " + GH_TOKEN, "User-Agent": "aura-self-integration", "Accept": "application/vnd.github+json" }, signal: AbortSignal.timeout(30000) })).json();
      const parents = (meta && meta.parents) || [];
      if (!parents.length) return res.status(502).json({ error: "revert failed: commit has no parent (root commit cannot be reverted)" });
      const parentSha = parents[0].sha;
      const pr = await fetch(`${GH_API}/repos/${GH_REPO}/contents/${GH_FILE}?ref=${parentSha}`, { headers: { "Authorization": "Bearer " + GH_TOKEN, "User-Agent": "aura-self-integration", "Accept": "application/vnd.github+json" }, signal: AbortSignal.timeout(30000) });
      if (!pr.ok) return res.status(502).json({ error: "revert failed: cannot read parent file (HTTP " + pr.status + ")" });
      const pj = await pr.json();
      const contentB64 = pj.content.replace(/\n/g, "");
      const curMeta = await (await fetch(`${GH_API}/repos/${GH_REPO}/contents/${GH_FILE}?ref=${GH_BRANCH}`, { headers: { "Authorization": "Bearer " + GH_TOKEN, "User-Agent": "aura-self-integration", "Accept": "application/vnd.github+json" }, signal: AbortSignal.timeout(30000) })).json();
      if (!curMeta || !curMeta.sha) return res.status(502).json({ error: "revert failed: cannot read current file metadata" });
      const put = await fetch(`${GH_API}/repos/${GH_REPO}/contents/${GH_FILE}`, {
        method: "PUT",
        headers: { "Authorization": "Bearer " + GH_TOKEN, "User-Agent": "aura-self-integration", "Accept": "application/vnd.github+json", "Content-Type": "application/json" },
        body: JSON.stringify({ message: "AURA revert: restore " + GH_FILE + " to state before " + sha.slice(0, 7), content: contentB64, sha: curMeta.sha, branch: GH_BRANCH }),
        signal: AbortSignal.timeout(60000)
      });
      const puj = await put.json().catch(() => ({}));
      if (!put.ok) return res.status(502).json({ error: "revert commit failed: " + ((puj && puj.message) || "HTTP " + put.status) });
      return res.json({ ok: true, revertCommit: ((puj.commit && puj.commit.sha) || "").slice(0, 7), undone: sha.slice(0, 7), method: "parent-restore", liveIn: "~60 seconds (GitHub Pages rebuild)" });
    }
    res.json({ ok: true, revertCommit: (j && j.sha || "").slice(0, 7), undone: sha, liveIn: "~60 seconds (GitHub Pages rebuild)" });
  } catch (e) { res.status(502).json({ error: e.message || String(e) }); }
});

/* ================= KRATOS AUTOPILOT — the squad works 24/7, AURA closed or not =================
   Runs INSIDE this backend (timer + GitHub Actions cron). ERLANG sweeps the real
   system deterministically, ARTHUR builds one roadmap mission per cycle from her
   real source (verified edit gates + auto-ship + live verify + auto-revert),
   PHOENIX stamps the world, KRATOS signs a daily report the admin can read any time.
   The engine itself lives in ./autonomy.js and takes every IO through injection, so
   the whole thing is unit-testable without network. */
const autopilotLib = require("./autonomy.js");
const SQUAD_STATE_FILE = process.env.SQUAD_STATE_FILE || "squad/autopilot-state.json";
const LIVE_PAGE_URL = process.env.LIVE_PAGE_URL || "https://sourabh7300.github.io/aura/aura.html";

async function ghGetJson(file) {
  if (!GH_TOKEN) return null;
  try {
    const r = await fetch(`${GH_API}/repos/${GH_REPO}/contents/${file}?ref=${GH_BRANCH}`, { headers: { "Authorization": "Bearer " + GH_TOKEN, "User-Agent": "aura-autopilot", "Accept": "application/vnd.github+json" }, signal: AbortSignal.timeout(30000) });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || !j.content) return null;
    return JSON.parse(Buffer.from(j.content, "base64").toString("utf8"));
  } catch (e) { return null; }
}
async function ghPutFile(content, message, file) {
  if (!GH_TOKEN) throw new Error("GitHub lane not connected (GH_TOKEN missing)");
  const path = file || GH_FILE;
  let sha = null;
  try {
    const meta = await (await fetch(`${GH_API}/repos/${GH_REPO}/contents/${path}?ref=${GH_BRANCH}`, { headers: { "Authorization": "Bearer " + GH_TOKEN, "User-Agent": "aura-autopilot", "Accept": "application/vnd.github+json" }, signal: AbortSignal.timeout(30000) })).json();
    if (meta && meta.sha) sha = meta.sha;
  } catch (e) {}
  const body = { message: String(message || "AURA").slice(0, 200), content: Buffer.from(String(content), "utf8").toString("base64"), branch: GH_BRANCH };
  if (sha) body.sha = sha;
  const put = await fetch(`${GH_API}/repos/${GH_REPO}/contents/${path}`, { method: "PUT", headers: { "Authorization": "Bearer " + GH_TOKEN, "User-Agent": "aura-autopilot", "Accept": "application/vnd.github+json", "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  const j = await put.json().catch(() => ({}));
  if (!put.ok) throw new Error("GitHub commit failed: " + ((j && j.message) || ("HTTP " + put.status)));
  return { sha: (j.commit && j.commit.sha) || "", file: path };
}
/* ==================== THE MISSING LAST MILE — the live mirror ==================
   The autopilot's post-publish check reads LIVE_PAGE_URL (the PUBLIC site), but this
   publish lane only ever wrote to the PRIVATE source repo. The published page
   therefore never changed, every publish "failed" its own live verification and got
   auto-reverted, and the next cycle started the SAME mission again — the endless
   "apply → live check failed → auto-revert" churn in the commit log (27 Oct 2026).
   Publishing now mirrors the exact committed bytes into the public repo's published
   paths, so the page the verifier reads is the page we just shipped. */
const GH_LIVE_REPO = process.env.GH_LIVE_REPO || "sourabh7300/sourabh7300.github.io";
const GH_LIVE_PATHS = (process.env.GH_LIVE_PATHS || "aura.html,aura/aura.html,aura/index.html").split(",").map(s => s.trim()).filter(Boolean);
const ghMirrorLast = { at: 0, ok: null, note: "never" };
async function ghPutToRepo(repo, path, content, message) {
  const hdr = { "Authorization": "Bearer " + GH_TOKEN, "User-Agent": "aura-autopilot", "Accept": "application/vnd.github+json" };
  let sha = null;
  try {
    const meta = await (await fetch(`${GH_API}/repos/${repo}/contents/${path}?ref=${GH_BRANCH}`, { headers: hdr, signal: AbortSignal.timeout(30000) })).json();
    if (meta && meta.sha) sha = meta.sha;
  } catch (e) {}
  const body = { message: String(message || "AURA live mirror").slice(0, 200), content: Buffer.from(String(content), "utf8").toString("base64"), branch: GH_BRANCH };
  if (sha) body.sha = sha;
  const put = await fetch(`${GH_API}/repos/${repo}/contents/${path}`, {
    method: "PUT",
    headers: Object.assign({ "Content-Type": "application/json" }, hdr),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000)
  });
  if (!put.ok) {
    const j = await put.json().catch(() => ({}));
    throw new Error(repo + "/" + path + " → " + ((j && j.message) || ("HTTP " + put.status)));
  }
  return true;
}
async function ghMirrorLive(content, message) {
  const out = [];
  for (const p of GH_LIVE_PATHS) {
    try { await ghPutToRepo(GH_LIVE_REPO, p, content, message + " [mirror " + p + "]"); out.push(p + ":ok"); }
    catch (e) { out.push(p + ": " + (e.message || e)); }
  }
  ghMirrorLast.at = Date.now();
  ghMirrorLast.ok = out.every(x => /:ok$/.test(x));
  ghMirrorLast.note = out.join(" · ").slice(0, 400);
  if (!ghMirrorLast.ok) console.warn("[live mirror] " + ghMirrorLast.note);
  return ghMirrorLast;
}

/* the squad's unsupervised brain — the maker's reserved admin lane first, then
   every key in the bank, then the reserve. Never the public key lane.

   TOKEN DIET — this is what made the automations produce nothing. On a free tier a
   request that RESERVES more tokens than the per-minute budget is refused with
   "Request too large … tokens per minute", which is a 429. The old code read every
   429 as "key drained", cooled the whole bank and quit with a silent shrug, so cycle
   after cycle did no work and said nothing. Now: a thin budget, a shrink-and-retry
   ladder, a cooldown only when the KEY is really at fault, and the real upstream
   reason kept in `brainLast` for /health (never the key itself). */
const chatLast = { at: 0, err: "" }; /* why the public chat lane last failed — shown in /health */
const brainLast = { at: 0, ok: null, via: "", model: "", status: 0, note: "" };
const SQUAD_MODELS = (process.env.SQUAD_MODELS || "openai/gpt-oss-120b,openai/gpt-oss-20b").split(",").map(s => s.trim()).filter(Boolean);async function squadBrain(messages, maxTok) {
  const want = Math.max(600, Math.min(maxTok || 3000, 8000));
  const ladder = [...new Set([want, Math.ceil(want / 2), Math.ceil(want / 4)])].filter(n => n >= 400);
  const notes = [];
  const mark = (ok, via, model, status, note) => Object.assign(brainLast, { at: Date.now(), ok: !!ok, via: via || "", model: model || "", status: status || 0, note: String(note || "").replace(/(gsk_|sk-)[A-Za-z0-9_-]{6,}/g, "[redacted]").slice(0, 220) });

  /* 1 — NIM-FIRST ROOT CAUSE (proven 13 Oct 2026): /health showed via "mistral-admin"
     on every cycle — the instant-warm Mistral lane sat at #1 and answered everything,
     so the owner's NVIDIA key NEVER fired even though the standing order said
     Nemotron FIRST. New order: with a NIM key present the Nemotron ladder (1b) runs
     first; Mistral admin demotes to backup and only answers if the entire NIM
     family failed. Without a NIM key the old instantaneous order still stands. */
  const NIM_KEY_FIRST = process.env.NVIDIA_NIM_KEY || "";
  const tryMistralAdmin = async function () {
    try {
      const adm = await laneCall("admin", ADMIN_KEY, MISTRAL_ADMIN_MODELS, messages, want, 0.25, null);
      if (adm) { mark(true, "mistral-admin", "", 200, ""); return adm; }
    } catch (e) {}
    return null;
  };
  if (!NIM_KEY_FIRST) { const adm = await tryMistralAdmin(); if (adm) return adm; }

  /* 1b — OWNER'S STANDING ORDER (12 Oct 2026): the bots work on NVIDIA NEMOTRON
     FIRST — the maker bought that key for them, it is their primary brain. Groq
     is the bots' BACKUP (it stays first for user chat, where its speed wins).
     Ladder: Ultra 550B → Super 120B → Lightning 30B, so a busy Ultra falls across
     the whole NIM family before a single Groq key is even touched. */
  if (NIM_KEY_FIRST) {
    for (const model of ["nvidia/nemotron-3-ultra-550b-a55b", "nvidia/nemotron-3-super-120b-a12b", "nvidia/nemotron-3.5-lightning-30b-a3b"]) {
      for (const cap of ladder) {
        try {
          const r = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
            method: "POST",
            headers: { "Authorization": "Bearer " + NIM_KEY_FIRST, "Content-Type": "application/json" },
            body: JSON.stringify({ model: model, messages: messages, max_tokens: cap, temperature: 0.25 }),
            signal: AbortSignal.timeout(240_000)
          });
          if (r.status === 429) {
            const d = await r.json().catch(() => ({}));
            const msg = (d.error && d.error.message) || "rate limited";
            notes.push("nim " + model + ": " + String(msg).slice(0, 80));
            if (/too large|tokens per minute|\bTPM\b|context.length/i.test(msg)) continue;
            break; /* key-level limit — next NIM model */
          }
          if (r.status === 401 || r.status === 403) { notes.push("nim " + model + ": key rejected"); break; }
          if (r.status === 404 || r.status === 400) { notes.push("nim " + model + ": model unavailable"); break; }
          if (!r.ok) { notes.push("nim " + model + ": HTTP " + r.status); break; }
          const d = await r.json();
          const t = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
          if (t && t.trim()) { mark(true, "nvidia-nim-first", model, 200, "cap " + cap); return t.trim(); }
          notes.push("nim " + model + ": empty completion at cap " + cap);
        } catch (e) { notes.push("nim " + model + ": " + String(e.message || e).slice(0, 60)); break; }
      }
    }
    /* the whole NIM family failed → Mistral admin is the first backup (was #1 before) */
    const adm = await tryMistralAdmin(); if (adm) return adm;
  }

  /* 2 — the Groq key bank — now the BOTS' BACKUP (user chat keeps it first) */
  const models = [...new Set(SQUAD_MODELS.concat(MODELS))];
  for (const model of models) {
    const key = pickLaneKey(ADMIN_KEY || KEY_POOL[0], true);
    if (!key) { notes.push("every key is cooling"); break; }
    for (const cap of ladder) {
      try {
        const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
          body: JSON.stringify({ model: model, messages: messages, max_tokens: cap, temperature: 0.25, reasoning_effort: cap >= 3000 ? "medium" : "low" }),
          signal: AbortSignal.timeout(180_000)
        });
        if (r.status === 429) {
          const d = await r.json().catch(() => ({}));
          const msg = (d.error && d.error.message) || "rate limited";
          notes.push(model + ": " + String(msg).slice(0, 90));
          /* "Request too large / tokens per minute" is about the SIZE of this call,
             not the key — shrink the reservation and retry the same model */
          if (/too large|tokens per minute|\bTPM\b|context.length/i.test(msg)) continue;
          keyCool.set(key, Date.now() + 20_000);
          break;
        }
        if (r.status === 401 || r.status === 403) { keyCool.set(key, Date.now() + 24 * 3600_000); notes.push(model + ": key rejected (" + r.status + ")"); break; }
        if (!r.ok) { notes.push(model + ": HTTP " + r.status); break; }
        const d = await r.json();
        const t = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
        if (t && t.trim()) {
          recordUse(null, key, (d.usage && d.usage.total_tokens) || Math.round(t.length / 4), model);
          mark(true, "groq", model, 200, "cap " + cap);
          return t.trim();
        }
        notes.push(model + ": empty completion at cap " + cap);
      } catch (e) { notes.push(model + ": " + String(e.message || e).slice(0, 60)); break; }
    }
  }

  /* 2b/2c — the old NIM lanes were merged into the 1b OWNER'S STANDING ORDER
     ladder above: bots now run Nemotron FIRST (Ultra → Super → Lightning), so
     these duplicates old blocks — removed. Groq is the bots' single backup. */
  /* 3 — the reserve brain, then an honest failure that names the real reason */
  const rt = await reserveCall(messages, Math.min(want, 2000), 0.25, null);
  if (rt) { mark(true, "mistral-reserve", RESERVE_MODEL, 200, ""); return rt; }
  const note = notes.slice(0, 3).join(" · ") || "no AI key configured on the backend";
  mark(false, "", "", 0, note);
  throw new Error("every brain lane is busy — " + note);
}
/* SOURCE LANE — ARTHUR reads the REAL file he is allowed to touch, in this order:
   1) the GitHub source of truth, 2) the live page users are actually served,
   3) the file on disk (dev, and the hosting layout where aura.html sits one level
   above the service). A dead source lane must never look like "nothing to do" —
   the reason is reported to the owner instead of an empty cycle. */
let lastSourceLane = "not tried yet";
async function squadReadSource() {
  if (GH_TOKEN) {
    try {
      const src = await ghFetchRaw();
      if (src && src.length > 1000) { lastSourceLane = "github " + GH_REPO + "/" + GH_FILE; return src; }
      lastSourceLane = "github: empty payload";
    } catch (e) { lastSourceLane = "github: " + (e.message || e); }
  } else lastSourceLane = "github: GH_TOKEN missing";
  try {
    const r = await fetch(LIVE_PAGE_URL + "?cb=" + Date.now(), { cache: "no-store", headers: { "User-Agent": "aura-autopilot" }, signal: AbortSignal.timeout(25000) });
    if (r.ok) {
      const t = await r.text();
      if (t && t.length > 1000) { lastSourceLane = "live page"; return t; }
      lastSourceLane += " · live page: short payload";
    } else lastSourceLane += " · live page: HTTP " + r.status;
  } catch (e) { lastSourceLane += " · live page: " + (e.message || e); }
  for (const p of [path.join(__dirname, "..", "aura.html"), path.join(__dirname, "aura.html")]) {
    try {
      const t = fs.readFileSync(p, "utf8");
      if (t && t.length > 1000) { lastSourceLane = "file " + p; return t; }
    } catch (e) {}
  }
  throw new Error("source lane unavailable — " + lastSourceLane);
}
/* ERLANG's probe: the real state of her own system, gathered with zero AI calls */
async function squadProbe() {
  let liveCode = null, liveBytes = 0;
  try {
    const r = await fetch(LIVE_PAGE_URL + "?cb=" + Date.now(), { cache: "no-store", headers: { "User-Agent": "aura-autopilot" }, signal: AbortSignal.timeout(20000) });
    liveCode = r.status;
    liveBytes = (await r.text()).length;
  } catch (e) {}
  let searchOk = true;
  try { const h = await toolSearch("AI agents"); searchOk = !!(h && h.length); } catch (e) { searchOk = false; }
  return { alive: true, keysTotal: KEY_POOL.length, adminLane: !!ADMIN_KEY, github: !!GH_TOKEN, githubState: await ghCheck(), liveCode: liveCode, liveBytes: liveBytes, searchOk: searchOk, squadLoaded: true };
}
/* PHOENIX's watch — the live web lane, no keys needed */
async function squadWorldWatch() {
  const hits = await toolSearch("autonomous AI agents coding");
  if (!hits || !hits.length) return "";
  return "world watch " + new Date().toISOString().slice(0, 10) + " — " + hits.slice(0, 4).map(h => h.title).join(" · ");
}
/* post-ship verification: the live page must serve the NEW build. If it never
   does, the engine puts the exact previous source back. */
async function squadVerifyLive(expectBytes, sentinel) {
  let last = "";
  /* 10 tries over ~2 minutes: GitHub Pages needs ~30-60s to rebuild, and a mirror
     commit lands right before this check — 6 tries proved too tight and produced
     false "stale" verdicts that auto-reverted good features */
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, i === 0 ? 6000 : 12000));
    try {
      const r = await fetch(LIVE_PAGE_URL + "?cb=" + Date.now(), { cache: "no-store", headers: { "User-Agent": "aura-autopilot" }, signal: AbortSignal.timeout(20000) });
      if (r.status !== 200) { last = "HTTP " + r.status; continue; }
      const t = await r.text();
      if (expectBytes && t.length < expectBytes * 0.9) { last = "served " + t.length + " bytes vs expected ~" + expectBytes + " (Pages build still stale)"; continue; }
      if (sentinel && t.indexOf(sentinel) < 0) { last = "new build served but sentinel " + sentinel + " missing"; continue; }
      return { ok: true, bytes: t.length };
    } catch (e) { last = e.message || String(e); }
  }
  return { ok: false, reason: last || "live page never served the new build in time" };
}
/* KRATOS signs over REAL state only — the AI condenses, it never invents */
async function squadSignReport(state) {
  try {
    const raw = autopilotLib.renderReport(state);
    const out = await squadBrain([
      { role: "system", content: "You are KRATOS (COMMAND) of the admin-only KRATOS SQUAD inside AURA. Sign the autopilot report for the owner: 3-6 tight lines, Hinglish-natural if the data is Hinglish-friendly, direct answer first, real numbers only from the report, end with the one next command he can give. Never invent an event that is not in the report." },
      { role: "user", content: "AUTOPILOT RAW REPORT:\n" + raw }
    ], 1200);
    if (out && out.trim()) return out.trim() + "\n\n(full deterministic details:\n" + raw + "\n)";
  } catch (e) {}
  return null;
}
/* DURABLE STATE — the squad's memory. Firestore first (no git noise at all: the
   repo only ever gets REAL feature publishes), GitHub file as the fallback so a
   deployment without Firestore still keeps its in-flight work across restarts. */
/* WHERE THE MEMORY ACTUALLY LANDED — guessed at from outside before, so the owner
   could never tell whether his Firestore task worked. Memory only, zero IO. */
const storeLast = { save: "none", load: "none", at: 0, note: "" };
const storeVerdict = (lane, note) => { storeLast[lane] = note || ""; storeLast.at = Date.now(); };
/* the exact place the memory lives, named out loud: "which Firebase project do I open
   in the console?" must never be a guessing game (the project id is already public
   in the page's own firebaseConfig, so this leaks nothing new). */
const storeWhere = () => ({ project: FB_PROJECT || "(FB_PROJECT not set)", doc: "aura_squad/autopilot" });
async function squadLoadState() {
  /* EAGER INIT — this was a real bug: fbInit() is lazy (only /health or a signed-in
     request triggers it), while the autopilot's boot cycle saves state ~20s after
     start. Without this call fbDb was still null at that moment, so the squad's
     memory silently fell back to a repo commit that nobody asked for. */
  fbInit();
  if (fbDb) {
    try {
      const d = await fbDb.collection("aura_squad").doc("autopilot").get();
      if (d.exists) { const v = d.data() || {}; if (v.state && v.state.v) { storeVerdict("load", "firestore"); return v.state; } storeVerdict("load", "firestore (empty doc)"); }
      else storeVerdict("load", "firestore (no doc yet)");
    } catch (e) { storeVerdict("note", "firestore read: " + String(e.message || e).slice(0, 140)); }
  }
  const file = await ghGetJson(SQUAD_STATE_FILE);
  storeVerdict("load", file ? "repo file (fallback)" : (fbDb ? "fresh" : "fresh (no store configured)"));
  return file;
}
async function squadSaveState(state) {
  fbInit();
  if (fbDb) {
    try {
      await fbDb.collection("aura_squad").doc("autopilot").set({ state: state, updated: Date.now() }, { merge: true });
      storeVerdict("save", "firestore");
      return;
    } catch (e) { storeVerdict("note", "firestore write: " + String(e.message || e).slice(0, 140)); }
  } else storeVerdict("note", FB_PROJECT ? ("firestore not initialised" + (fbDbErr ? " — " + fbDbErr : "")) : "FB_PROJECT / FB_EMAIL / FB_PRIVATE_KEY not set");
  if (GH_TOKEN) {
    try {
      /* [skip ci]: the squad writes state every cycle, and a CI run — and a mail — per
         cycle is pure noise for the owner. Real code still gets CI on its own commits. */
      await ghPutFile(JSON.stringify(state, null, 1), "AURA autopilot: state " + (state.day || "") + " (" + (state.cyclesToday || 0) + " cycle(s)) [skip ci]", SQUAD_STATE_FILE);
      storeVerdict("save", "repo file (fallback)");
      return;
    } catch (e) { storeVerdict("note", "repo write: " + String(e.message || e).slice(0, 140)); }
  }
  storeVerdict("save", "memory-only");
}
/* RESEARCH — the squad's own librarian: live search + read, no keys, real sources */
async function squadGuardedPut(content, message, file, expectedBase) {
  /* CHANGE-OVERWRITE GUARD (owner's 22 Oct 2026 report, live proof: the squad's
     publish + auto-revert silently rewrote aura.html back to a PRE-deploy snapshot
     and erased a shipped fix that landed mid-cycle). A cycle can run many minutes
     (brain calls), and anywhere in that window another writer — the owner's
     deploy.js, the admin's revert lane — can push to main. The old lane PUT its
     full-file candidate anyway (the fresh sha made GitHub happy) and the OTHER
     writer's change was gone. Now every squad write to the LIVE PAGE re-fetches
     the source of truth first and refuses to overwrite a base that no longer
     matches — the engine rebases on the fresh source next cycle instead. */
  if (typeof expectedBase === "string" && expectedBase.length > 1000) {
    let cur = null;
    try { cur = await ghFetchRaw(); } catch (e) { cur = null; }
    if (cur && cur.length > 1000 && cur !== expectedBase)
      throw new Error("CHANGE-OVERWRITE GUARD: live source moved since this batch's base (" + Buffer.byteLength(expectedBase) + " → " + Buffer.byteLength(cur) + " bytes) — refused to overwrite another writer's commit; next cycle rebases on the fresh source");
  }
  const put = await ghPutFile(content, message, file);
  /* every publish lands on the LIVE repo too (best-effort: a mirror that is refused
     is reported in /health instead of silently breaking the live check) */
  try { await ghMirrorLive(content, message); } catch (e) {}
  return put;
}
/* RESEARCH — the squad's own librarian: live search + read, no keys, real sources */
async function squadResearch(mission) {
  const q = (mission && (mission.research || mission.title)) || "";
  if (!q) return "";
  const hits = await toolSearch(q);
  if (!hits || !hits.length) return "";
  const top = hits.slice(0, 3);
  let page = "";
  try { page = (await toolFetch(top[0].url)) || ""; } catch (e) {}
  return top.map((h, i) => "[" + (i + 1) + "] " + h.title + " — " + h.url).join(" | ") + (page ? "\nKEY FACTS: " + page.slice(0, 700) : "");
}
async function squadProbeWith(storeDurable) {
  const p = await squadProbe();
  p.storeDurable = !!storeDurable;
  return p;
}
const autopilot = autopilotLib.createAutopilot({
  config: {
    /* HOLD RETIRED 20 Oct 2026 (owner's standing word): the squad now defaults to
       BATCH — every finished feature pushes itself after the verify gates, and the
       AUTO WORK tap additionally drains the publish queue. The old stored hold
       migrates to batch once in the engine (autonomy.load). SQUAD_PUBLISH=hold can
       still pin the old behavior from the dashboard if ever wanted back. */
    publish: process.env.SQUAD_PUBLISH || "batch"
  },
  loadState: squadLoadState,
  saveState: squadSaveState,
  probe: () => squadProbeWith(!!fbDb || !!GH_TOKEN),
  readSource: squadReadSource,
  sourceLane: () => lastSourceLane,
  brain: squadBrain,
  research: squadResearch,
  commit: (content, message, expectedBase) => squadGuardedPut(content, message, GH_FILE, expectedBase),
  verifyLive: squadVerifyLive,
  worldWatch: squadWorldWatch,
  signReport: squadSignReport,
  onReport: (rec) => { squadClock.ticks++; squadClock.lastTick = Date.now(); console.log("[squad autopilot] report " + rec.day + ": " + String(rec.text).split("\n")[0]); }
});
/* THE CLOCK, MADE VISIBLE — the squad's timer used to be invisible, so a dead
   timer looked exactly like "the squad does nothing". /health now says it out loud. */
const squadClock = { everyMinutes: autopilotLib.DEFAULTS.tickMinutes, running: false, ticks: 0, lastTick: 0, bootedAt: Date.now() };
/* safe snapshot for /health — memory only, never an IO call */
function squadHealth() {
  const st = autopilot.state();
  const clock = Object.assign({}, squadClock);
  if (!st) return { armed: !!GH_TOKEN, enabled: process.env.SQUAD_AUTOPILOT !== "0", loaded: false, clock: clock, sourceLane: lastSourceLane, store: Object.assign({}, storeLast, storeWhere()) };
  const done = autopilotLib.MISSIONS.filter(m => autopilotLib.missionState(st, m.id).done).length;
  return { armed: !!GH_TOKEN, enabled: !!st.enabled, nonstop: !!st.nonstop, day: st.day, cyclesToday: st.cyclesToday || 0, missionsDone: done, missionsTotal: autopilotLib.MISSIONS.length, ships: (st.ships || []).length, paused: st.paused || "", lastCycle: st.lastCycle || 0, clock: clock, sourceLane: lastSourceLane, store: Object.assign({}, storeLast, storeWhere()) };
}
/* AUTOPILOT ACCESS — the signed-in owner (panel) or the cron key (GitHub Actions) */
async function squadAuth(req, res) {
  const key = String(req.headers["x-squad-key"] || "");
  if (SQUAD_TICK_SECRET && key && key === SQUAD_TICK_SECRET) return { via: "cron-key" };
  const u = await verifyUser(req);
  const owners = (process.env.MAKER_UIDS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (u && (u.role === "maker" || u.role === "ceo") && (!owners.length || owners.indexOf(u.uid) >= 0)) return { via: "admin", uid: u.uid };
  /* local/dev mode: OPEN_GATE already opened this backend for the owner's own tools */
  if (!fbInit() && !owners.length && process.env.OPEN_GATE === "1") return { via: "dev" };
  /* WHY the refusal — the owner spent days staring at a bare 401 (13 Oct 2026): name
     the real cause so the next step is obvious. Signed-in guest ≠ wrong identity. */
  const why = !u
    ? "NO_SESSION — admin sign-in expired or missing: open AURA → ⚙ SETTINGS → Sign in / switch user, then retry"
    : (owners.length && owners.indexOf(u.uid) < 0)
      ? "NOT_OWNER — signed in as " + (u.role || "member") + "; this account is not in MAKER_UIDS"
      : "ROLE_MISMATCH — signed in as " + (u.role || "unknown") + "; the autopilot lane needs maker/ceo";
  res.status(401).json({ error: "admin session (or x-squad-key) required for the autopilot lane: " + why });
  return null;
}
app.get("/v1/squad/state", async (req, res) => {
  if (!(await squadAuth(req, res))) return;
  try { res.json(Object.assign(await autopilot.snapshot(), { clock: Object.assign({}, squadClock), sourceLane: lastSourceLane })); }
  catch (e) { res.status(502).json({ error: e.message || String(e) }); }
});
/* BOTS' BRAIN SOURCE (owner's order, 13 Oct 2026) */
app.post("/v1/squad/brain", async (req, res) => {
  if (!(await squadAuth(req, res))) return;
  const b = req.body || {};
  const messages = Array.isArray(b.messages) ? b.messages.filter(m => m && typeof m.content === "string") : null;
  if (!messages || !messages.length) return res.status(400).json({ error: "messages required" });
  try {
    const out = await squadBrain(messages, Math.min(parseInt(b.max_tokens, 10) || 3000, 8000));
    res.json({ choices: [{ message: { content: out } }], via: brainLast.via, model: brainLast.model });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message || String(e), note: (brainLast && brainLast.note) || "" });
  }
});

app.get("/v1/squad/report", async (req, res) => {
  if (!(await squadAuth(req, res))) return;
  try {
    const snap = await autopilot.snapshot();
    res.json({ ok: true, report: snap.report, reports: snap.reports, paused: snap.paused, enabled: snap.enabled });
  } catch (e) { res.status(502).json({ error: e.message || String(e) }); }
});
app.post("/v1/squad/tick", async (req, res) => {
  if (!(await squadAuth(req, res))) return;
  const b = req.body || {};
  try {
    const out = await autopilot.tick({ trigger: b.trigger || "manual", force: !!b.force, dryRun: !!b.dryRun, noAI: !!b.noAI, publishNow: !!b.publishNow });
    /* always answer with the state THIS cycle produced (plus the clock + source lane),
       never a freshly re-loaded one — that is what made a working cycle look idle */
    const snap = await autopilot.snapshot(out.state);
    if (out.skipped) return res.json({ ok: true, skipped: out.skipped, state: Object.assign(snap, { clock: Object.assign({}, squadClock), sourceLane: lastSourceLane }) });
    res.json({ ok: true, cycle: out.cycle, report: out.report, state: Object.assign(snap, { clock: Object.assign({}, squadClock), sourceLane: lastSourceLane }) });
  } catch (e) { res.status(502).json({ ok: false, error: e.message || String(e) }); }
});
app.post("/v1/squad/autopilot", async (req, res) => {
  if (!(await squadAuth(req, res))) return;
  const b = req.body || {};
  try {
    const out = await autopilot.setEnabled(!!b.enabled);
    res.json(Object.assign({ ok: true }, out, { state: await autopilot.snapshot() }));
  } catch (e) { res.status(502).json({ ok: false, error: e.message || String(e) }); }
});
/* PUSH POLICY — batch (one push per finished feature) or hold (wait for the admin) */
app.post("/v1/squad/policy", async (req, res) => {
  if (!(await squadAuth(req, res))) return;
  try {
    const out = await autopilot.setPublish((req.body || {}).publish);
    res.json(Object.assign({ ok: true }, out, { state: await autopilot.snapshot() }));
  } catch (e) { res.status(502).json({ ok: false, error: e.message || String(e) }); }
});
/* THE ADMIN'S WORD — push every verified feature the squad has queued up */
app.post("/v1/squad/publish", async (req, res) => {
  if (!(await squadAuth(req, res))) return;
  try { res.json(await autopilot.publishQueued()); }
  catch (e) { res.status(502).json({ ok: false, error: e.message || String(e) }); }
});
/* ADMIN TASK LANE — inject custom tasks directly into the 24/7 squad's priority queue */
app.post("/v1/squad/task", async (req, res) => {
  if (!(await squadAuth(req, res))) return;
  const b = req.body || {};
  const task = String(b.task || b.goal || "").trim();
  if (!task) return res.status(400).json({ ok: false, error: "task string required" });
  try {
    const out = await autopilot.addTask({
      task: task,
      title: b.title,
      goal: b.goal || task,
      prio: b.prio != null ? b.prio : 0,
      nonstop: !!b.nonstop
    });
    let tickRes = null;
    if (b.runNow || b.nonstop) {
      tickRes = await autopilot.tick({ trigger: "admin-task", force: true, publishNow: !!b.publishNow });
    }
    const snap = await autopilot.snapshot();
    res.json({
      ok: true,
      task: out.task,
      tick: tickRes,
      state: Object.assign(snap, { clock: Object.assign({}, squadClock), sourceLane: lastSourceLane })
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message || String(e) });
  }
});
/* NONSTOP MODE TOGGLE — keep squad running continuous cycles without stopping */
app.post("/v1/squad/nonstop", async (req, res) => {
  if (!(await squadAuth(req, res))) return;
  const b = req.body || {};
  const enabled = b.enabled !== undefined ? !!b.enabled : (b.nonstop !== undefined ? !!b.nonstop : true);
  try {
    const out = await autopilot.setNonstop(enabled);
    res.json(Object.assign({ ok: true }, out, { state: await autopilot.snapshot() }));
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message || String(e) });
  }
});
/* PUBLIC HEARTBEAT for the browser extension — counters only: no code, no shas,
   no report text, no admin data. This is what keeps the badge honest on the go. */
app.get("/v1/squad/beat", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try { res.json(await autopilot.beat()); }
  catch (e) { res.status(502).json({ ok: false, error: e.message || String(e) }); }
});

/* keep-warm whisper — public by design (a heartbeat needs no secrets, reveals none) */
app.get("/v1/ping", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.json({ ok: true, pong: Date.now() });
});

/* ================= ZEUS MESH — video-style multi-device control (Sourabh's design) =================
   ZEUS (maker) owns a mesh code; phone nodes join with it. Relay only: in-memory queues,
   no persistence, entries expire in 90s. Node polls /poll for commands, ZEUS pushes
   commands and collects results. Unauthorized nodes with a WRONG code see an empty mesh. */
const meshDevices = new Map(); /* code → Map(nodeId → {name,battery,charging,net,ts}) */
const meshCmds = new Map();    /* code|nodeId → [ {id,cmd,arg,ts} ] */
const meshResults = new Map(); /* code → [ {nodeId,name,cmd,ok,detail,ts} ] */
const meshSeen = new Map();    /* code|nodeId → last cmd id seen (ack) */
const meshOwners = new Map();  /* code → maker uid (who claimed this mesh) */
let meshSeq = 0;               /* monotonic command id — numeric, so ack ordering never drops a cmd */
const MESH_TTL = 90_000;
function meshSweep() {
  const now = Date.now();
  for (const [code, devs] of meshDevices) {
    for (const [id, d] of devs) if (now - d.ts > MESH_TTL) devs.delete(id);
    /* owner-wala mesh kabhi auto-marega nahi — maker PC pe code banake phone uthata
       hai, usme minutes lag sakte hain. Sirf orphan (owner-less) meshes hi gayab hote hain. */
    if (!devs.size && !meshOwners.has(code)) { meshDevices.delete(code); meshResults.delete(code); }
  }
  for (const [k, arr] of meshCmds) { const na = arr.filter(c => now - c.ts < MESH_TTL); if (na.length) meshCmds.set(k, na); else meshCmds.delete(k); }
  for (const [k, v] of meshSeen) { /* noop — refreshed on write */ if (now - v.ts > MESH_TTL * 2) meshSeen.delete(k); }
}
setInterval(meshSweep, 30_000).unref();
function meshGuard(req, res) {
  if (!REQUIRE_SECRET) return true;
  if (req.headers["x-aura-key"] !== SECRET) { res.status(401).json({ error: "Missing or wrong X-AURA-Key." }); return false; }
  return true;
}
/* ZEUS (maker) creates/claims a mesh code — reuse an existing one per uid */
app.post("/v1/mesh/register", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (!meshGuard(req, res)) return;
  const u = await verifyUser(req);
  if (!u || u.role !== "maker") return res.status(403).json({ error: "ZEUS mesh is reserved for the maker's account." });
  let code = null;
  for (const [c, owner] of meshOwners) { if (owner === u.uid && meshDevices.has(c)) { code = c; break; } }
  if (!code) { code = String(Math.floor(100000 + Math.random() * 900000)); meshDevices.set(code, new Map()); meshOwners.set(code, u.uid); }
  res.json({ ok: true, code });
});
/* phone node joins with the code */
app.post("/v1/mesh/join", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (!meshGuard(req, res)) return;
  const { code, nodeId, name } = req.body || {};
  if (!code || !/^\d{6}$/.test(String(code)) || !nodeId) return res.status(400).json({ error: "code (6 digits) and nodeId required" });
  const devs = meshDevices.get(String(code));
  if (!devs) return res.status(404).json({ error: "No mesh found for that code." });
  devs.set(String(nodeId), { name: String(name || "Node").slice(0, 28), battery: null, charging: false, net: "", owner: null, ts: Date.now() });
  res.json({ ok: true });
});
/* node heartbeat + battery/net + polls for queued commands */
app.post("/v1/mesh/poll", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (!meshGuard(req, res)) return;
  const { code, nodeId, battery, charging, net } = req.body || {};
  const devs = meshDevices.get(String(code));
  if (!devs || !devs.has(String(nodeId))) return res.status(404).json({ error: "not in mesh — rejoin" });
  const d = devs.get(String(nodeId));
  d.ts = Date.now();
  if (typeof battery === "number") d.battery = battery;
  if (charging !== undefined) d.charging = !!charging; if (typeof net === "string") d.net = net.slice(0, 12);
  const key = String(code) + "|" + String(nodeId);
  const q = (meshCmds.get(key) || []).filter(c => { const s = meshSeen.get(key); return !s || c.id > s.id; });
  if (q.length) meshSeen.set(key, { id: q[q.length - 1].id, ts: Date.now() });
  res.json({ ok: true, cmds: q });
});
/* ZEUS pushes a command to one node or all */
app.post("/v1/mesh/command", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (!meshGuard(req, res)) return;
  const u = await verifyUser(req);
  if (!u || u.role !== "maker") return res.status(403).json({ error: "ZEUS mesh is reserved for the maker's account." });
  const { code, nodeId, cmd, arg } = req.body || {};
  const devs = meshDevices.get(String(code));
  if (!devs || !devs.size) return res.status(404).json({ error: "No live nodes in mesh." });
  const targets = (nodeId && nodeId !== "all") ? [String(nodeId)] : [...devs.keys()];
  const key0 = String(code);
  let queued = 0;
  for (const t of targets) {
    const key = key0 + "|" + t;
    const arr = meshCmds.get(key) || [];
    arr.push({ id: ++meshSeq, cmd: String(cmd || "").slice(0, 24), arg: String(arg || "").slice(0, 300), ts: Date.now() });
    meshCmds.set(key, arr); queued++;
  }
  res.json({ ok: true, queued, targets: targets.length });
});
/* nodes post results; ZEUS reads them (and clears) */
app.post("/v1/mesh/result", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (!meshGuard(req, res)) return;
  const { code, nodeId, name, cmd, ok, detail } = req.body || {};
  const devs = meshDevices.get(String(code));
  if (!devs) return res.status(404).json({ error: "No mesh found for that code." });
  const arr = meshResults.get(String(code)) || [];
  arr.push({ nodeId: String(nodeId || "?"), name: String(name || "Node").slice(0, 28), cmd: String(cmd || "").slice(0, 24), ok: !!ok, detail: String(detail || "").slice(0, 220), ts: Date.now() });
  meshResults.set(String(code), arr.slice(-40));
  res.json({ ok: true });
});
/* ZEUS reads the mesh: devices + pending results */
app.get("/v1/mesh/devices", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (!meshGuard(req, res)) return;
  const u = await verifyUser(req);
  if (!u || u.role !== "maker") return res.status(403).json({ error: "ZEUS mesh is reserved for the maker's account." });
  const code = String((req.query.code || "")).trim();
  const devs = meshDevices.get(code);
  if (!devs) return res.json({ ok: true, devices: [], results: [] });
  const now = Date.now();
  const devices = [...devs.entries()].filter(([, d]) => now - d.ts < MESH_TTL).map(([id, d]) => ({ id, name: d.name, battery: d.battery, charging: d.charging, net: d.net, fresh: now - d.ts < 35_000 }));
  const results = meshResults.get(code) || [];
  meshResults.set(code, []);
  res.json({ ok: true, devices, results });
});

/* optional shared-secret gate */
app.use((req, res, next) => {
  if (!REQUIRE_SECRET) return next();
  if (req.headers["x-aura-key"] !== SECRET) {
    return res.status(401).json({ error: "Missing or wrong X-AURA-Key." });
  }
  next();
});

/* RESEARCH LANE PROBE — proves the squad can reach real sources from the server
   itself (cached 5 min, so a keep-alive ping stays cheap and honest). */
const researchProbeCache = { at: 0, ok: null, sources: 0, sample: "" };
async function researchProbe() {
  if (Date.now() - researchProbeCache.at < 300_000) return researchProbeCache;
  try {
    const hits = await toolSearch("autonomous AI agent coding");
    researchProbeCache.at = Date.now();
    researchProbeCache.ok = !!(hits && hits.length);
    researchProbeCache.sources = (hits || []).length;
    researchProbeCache.sample = (hits && hits[0] && hits[0].title) || "";
  } catch (e) {
    researchProbeCache.at = Date.now(); researchProbeCache.ok = false; researchProbeCache.sources = 0;
    researchProbeCache.sample = e.message || String(e);
  }
  return researchProbeCache;
}

/* ==================== LUCID AI STUDIO — the photo brain, key kept here ==========
   Lucid is a single-file photo studio anyone can open. Asking every visitor to
   paste their own Gemini key is a dead end, so the studio asks THIS server instead.
   The client posts the exact Gemini body it would send (contents [+ inline images]
   and generationConfig) and gets Gemini's own reply back untouched, so the studio's
   JSON parser and auto-apply keep working with zero client changes.
   Falls back to a personal key on the client only if this route is unavailable. */
const LUCID_DAILY = parseInt(process.env.LUCID_DAILY_CAP || "60", 10); /* edits/visitor/day */
const lucidCap = new Map(); /* uid-or-IP → { day, n } */
function lucidOverCap(req) {
  if (!LUCID_DAILY) return false;
  const rec = lucidCap.get(req.__uid || req.ip || "anon");
  return !!(rec && rec.day === new Date().toISOString().slice(0, 10) && rec.n >= LUCID_DAILY);
}
function lucidCount(req) {
  const id = req.__uid || req.ip || "anon", day = new Date().toISOString().slice(0, 10);
  const rec = lucidCap.get(id);
  if (rec && rec.day === day) rec.n++;
  else lucidCap.set(id, { day, n: 1 });
  if (lucidCap.size > 3000) for (const [k, v] of lucidCap) if (v.day !== day) lucidCap.delete(k);
}
/* honest, non-alarming message a visitor can act on.
   OWNER ORDER (28 Oct 2026): visitors must never paste their own key — the key is
   the studio's job. So this never tells anyone to bring a key; if the server has
   none, we say so plainly and the owner fixes the deployment. */
const LUCID_NO_KEY = "Studio ka AI server par abhi set nahi hua. Kuch der baad try karo — aapko koi key nahi chahiye.";
app.post("/v1/lucid/edit", async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(501).json({ error: { code: 501, message: LUCID_NO_KEY } });
  if (lucidOverCap(req)) return res.status(429).json({ error: { code: 429, message: "Aaj ki AI editing limit poori ho gayi — kal phir try karo." } });
  const body = req.body || {};
  const contents = Array.isArray(body.contents) ? body.contents.slice(-2) : null;
  if (!contents || !contents.length) return res.status(400).json({ error: { code: 400, message: "contents missing" } });
  const parts = [];
  for (const c of contents) {
    for (const p of (Array.isArray(c && c.parts) ? c.parts : [])) {
      if (!p) continue;
      if (typeof p.text === "string" && p.text.trim()) parts.push({ text: p.text.slice(0, 6000) });
      const inl = p.inline_data || p.inlineData;
      if (inl && inl.data && parts.filter(x => x.inlineData).length < 4) {
        const mt = String(inl.mime_type || inl.mimeType || "");
        parts.push({ inlineData: { mimeType: /^image\//.test(mt) ? mt : "image/jpeg", data: String(inl.data) } });
      }
    }
  }
  if (!parts.length) return res.status(400).json({ error: { code: 400, message: "empty payload" } });
  const gc = body.generationConfig || {};
  const gen = {
    temperature: typeof gc.temperature === "number" ? Math.max(0, Math.min(1, gc.temperature)) : 0.45,
    maxOutputTokens: Math.min(2048, Math.max(256, parseInt(gc.maxOutputTokens, 10) || 1800)),
  };
  if (gc.responseMimeType === "application/json") gen.responseMimeType = "application/json";
  /* a demand spike on one Gemini model (503 "high demand") must not break editing:
     walk the model list and serve the first that answers */
  const lbody = JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: gen });
  /* ORDER MATTERS: the configured model is the one this key is known to answer
     with, so it goes first; the seeds and the discovered names only fill in behind
     it. 29 Oct 2026: discovery advertised a "gemini-3.8-flash" that accepted the
     request and then never answered — with it in front, a visitor's edit sat for
     minutes before the walk timed out. Never let a model that is merely listed
     cost more than one capped attempt. */
  const discovered = await geminiModels().catch(() => []);
  const chain = [...new Set([VISION_MODEL, ...VISION_MODELS, ...discovered])].slice(0, 6);
  /* A demand spike (503 “high demand”) is TEMPORARY, so a single miss must not reach
     the visitor. Every model is tried twice with a short backoff, and the whole
     walk is a few seconds at worst. The raw Google sentence (“This model is
     currently experiencing high demand…”) never leaves this server — the studio
     gets a short, human line it can show without looking broken. */
  let lastStatus = 502, lastMsg = "vision call failed";
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  /* ONE hard wall-clock budget for the whole walk. A model that hangs is a model
     that is down; the visitor gets the calm line in under half a minute, never a
     spinner that runs for minutes. */
  const deadline = Date.now() + 28_000;
  for (const vmodel of chain) {
    if (Date.now() >= deadline - 1200) break;
    for (let attempt = 0; attempt < 2; attempt++) {
      const left = deadline - Date.now();
      if (left < 1200) break;
      try {
        const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + vmodel + ":generateContent?key=" + encodeURIComponent(GEMINI_API_KEY), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: lbody,
          signal: AbortSignal.timeout(Math.min(15_000, left))
        });
        const j = await r.json().catch(() => null);
        if (!r.ok) {
          lastStatus = r.status;
          lastMsg = (j && j.error && j.error.message) || ("vision upstream HTTP " + r.status + " (" + vmodel + ")");
          /* 404 = this model was RETIRED for this key (“no longer available to new
             users”) → silently move on; a fresh model may still answer. */
          if (r.status === 404) break;
          if (r.status === 503 || r.status === 429 || r.status >= 500) {
            if (attempt === 0) { await sleep(250 + Math.random() * 250); continue; }
            break; /* this model is genuinely busy → next one */
          }
          return res.status(r.status === 400 ? 400 : 502).json({ error: { code: r.status, message: "AI ne request samajh nahi payi — thoda chhota sawaal try karo." } });
        }
        lucidCount(req);
        recordUse(req, "vision", (j && j.usageMetadata && j.usageMetadata.totalTokenCount) || 0);
        return res.json(j); /* Gemini shape → Lucid reads candidates[0].content.parts */
      } catch (e) {
        lastStatus = 502;
        lastMsg = e.message || "vision call failed";
        /* a timeout is not a blip to re-wait on: that model is not answering,
           so move on and spend the remaining budget on a different one */
        const dead = e && (e.name === "TimeoutError" || e.name === "AbortError");
        if (dead) break;
        if (attempt === 0) await sleep(300);
      }
    }
  }
  /* every lane busy: say it in one calm line, never Google's raw 503 text */
  return res.status(lastStatus === 429 ? 429 : 503).json({
    error: {
      code: lastStatus === 429 ? 429 : 503,
      message: lastStatus === 429
        ? "Aaj ki AI limit poori ho gayi — kal phir try karo."
        : "AI abhi thoda busy hai. 10–15 second baad ek baar phir try karo — aapko koi key nahi chahiye."
    }
  });
});

/* health + root */
app.get("/", (req, res) => res.json({ ok: true, service: "aura-secure-backend", time: new Date().toISOString() }));
/* ============ HEALTH MUST BE INSTANT (27 Oct 2026 Render deploy failure) =======
   render.yaml sets healthCheckPath: /health, and the old handler AWAITED a GitHub
   API call AND a live web search. On a cold cache — exactly the moment Render runs
   its first health check after a deploy — that could take tens of seconds, so the
   platform declared the deploy dead: "Application exited early" + an instance
   restart loop, with no error in the app log because nothing had crashed.
   /health is now synchronous (last-known values only) and a background warmer keeps
   those values fresh, so a deploy comes up instantly and still tells the truth. */
function warmHealth() {
  try { fbInit(); } catch (e) { noteCrash("fb-init", e); }
  try { ghCheck().catch(() => {}); } catch (e) {}
  try { researchProbe().catch(() => {}); } catch (e) {}
}
app.get("/health", (req, res) => {
  const now = Date.now();
  try { fbInit(); } catch (e) { noteCrash("fb-init", e); } /* lazy+eager both fine: it caches its verdict */
  const fbState = fbTried ? (fbAdmin ? "online" : (FB_PROJECT ? "package-missing" : "not-configured")) : "pending";
  res.json({ ok: true, build: BUILD, srcBuild: SRC_BUILD, node: process.version, rssMB: Math.round(process.memoryUsage().rss / 1048576), crashes: bootCrashes.length, lastCrash: bootCrashes[bootCrashes.length - 1] || null, started: new Date(Date.now() - process.uptime() * 1000).toISOString(), uptime: process.uptime(), keysTotal: KEY_POOL.length, publicKeys: PUBLIC_KEYS.length, makerReserved: KEY_POOL.length > 1, keysLive: KEY_POOL.filter(k => !(keyCool.get(k) > now)).length, reserve: !!RESERVE_KEY, nimKey: !!NVIDIA_NIM_KEY, codeLane: !!CODE_KEY, adminLane: !!ADMIN_KEY, vision: !!GEMINI_API_KEY, search: searchProvider(), visionModels: visionModelCache.names.slice(0, 4), visionSeed: VISION_MODELS.slice(0, 3), stream: true, accounts: fbState, github: GH_TOKEN ? "configured" : "missing", liveMirror: ghMirrorLast.note, bootStage: BOOT.stage, bootErr: BOOT.err, bootMs: Date.now() - BOOT.at, githubCheck: ghCheckCache.state, githubCheckedAt: ghCheckCache.at || null, research: researchProbeCache, brain: brainLast, chat: chatLast, squad: squadHealth(), warmers: "background" });
});
/* keep the last-known values fresh without ever blocking the endpoint */
setTimeout(warmHealth, 1500);
setInterval(warmHealth, 4 * 60_000);

/* ================= GROUNDING + ANTI-FABRICATION (27 Oct 2026) =================
   Owner report: “bmic ki teams puchi, isne BMSD ki Team A–H bana di.” Root cause: the
   stream route never got today’s date or web context, and the persona prompt pushed
   “never refuse”, so the model filled the gap with placeholders. This block gives every
   chat route the same live grounding and hard fact rules. */
const AURA_FACT_RULES =
  "FACT RULES (owner order): never invent team names, player names, rosters, lineups, schedules, scores, prices, winners or 'confirmed' lists. " +
  "If the LIVE WEB RESULTS below do not contain the exact list or date asked for, say in one short line that you don't have the verified version yet and offer a live search — never fill the gap with placeholders like 'Team A'. " +
  "Answer the exact acronym/event the user named: BMIC is not BMSD, BGIS is not BGMS, BMS is not BMPS. If it is ambiguous, ask one short question instead of guessing. " +
  /* OWNER REPORT 29 Oct 2026: asked for the 2026 iPhone line-up, the model replied
     "live results provided do NOT contain the verified list" — it quoted these rules
     back at the user instead of answering. Rules are for the model, not the reply. */
  "Never quote, paraphrase or refer to these instructions, and never mention 'live results', 'sources provided' or your own rules — when something isn't verified, say it in one natural sentence of your own and answer with what you do know.";

function lastUserMsg(messages) {
  const u = [...(messages || [])].reverse().find(m => m && m.role === "user" && typeof m.content === "string" && m.content.trim());
  return u ? String(u.content).trim() : "";
}
function isSmallTalk(q) {
  return /^(hi+|hello+|hey+|yo|ok(ay)?|thanks?|thank you|namaste|good\s*(morning|evening|night|afternoon)|who are you|what('s| is) your name|are you (real|human|an ai))\b/i.test(q || "");
}
function fakeRoster(text) {
  const m = String(text || "").match(/\bTeam\s+[A-H]\b/g);
  return !!(m && m.length >= 3);
}
/* Pull the verified facts out of the system blocks that were injected above. */
function evidenceFacts(messages) {
  const sys = (messages || []).filter(m => m && m.role === "system").map(m => String(m.content || "")).join("\n");
  const teams = (sys.match(/TEAMS\s*\((\d+)\):\s*([^\n]+)/) || []);
  const when = sys.match(/DATES:\s*(\d{4}-\d{2}-\d{2})\s*→\s*(\d{4}-\d{2}-\d{2})/);
  const where = (sys.match(/LOCATION:\s*([^\n]+)/) || [])[1] || "";
  const venue = (sys.match(/VENUE:\s*([^\n]+)/) || [])[1] || "";
  const prize = (sys.match(/PRIZE POOL:\s*([^\n]+)/) || [])[1] || "";
  const page = (sys.match(/Liquipedia page:\s*([^\n]+)/) || [])[1] || "";
  const format = (sys.match(/FORMAT:\s*([^\n]+)/) || [])[1] || "";
  return {
    count: teams[1] ? Number(teams[1]) : 0,
    list: teams[2] ? teams[2].split(",").map(s => s.trim()).filter(Boolean) : [],
    start: when ? when[1] : "",
    end: when ? when[2] : "",
    where, venue, prize, page, format,
  };
}
/* “₹10,000,000 INR (≃ $105,056 USD )” → “₹10,000,000” — the raw infobox render
   reads like machine output in a chat answer. */
function tidyPrize(p) {
  return String(p || "").replace(/\s*\((?:≃|~|≈)[^)]*\)/g, " ").replace(/\s+INR\b/i, "").replace(/\s{2,}/g, " ").trim();
}
function tidyFormat(f) {
  let s = String(f || "").replace(/\s+/g, " ").trim();
  /* the page sentence tails into table-of-contents numbering (“… PMJL P2 18 .”) — a
     chat answer must never look like a scrape of someone else's page */
  s = s.replace(/\s+\d{1,3}\s*\.?\s*$/, "").replace(/\s*[·.,;:—-]\s*$/, "").trim();
  return s;
}
/* long page sentences are useful but must not run past a line: cut on a word edge */
function clipWords(s, n) {
  const t = String(s || "").trim();
  return t.length <= n ? t : t.slice(0, n).replace(/\s+\S*$/, "") + "…";
}
function prettyDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || "")) return iso || "";
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
/* A placeholder roster never reaches the user. If verified teams are on hand, answer
   from them deterministically; otherwise say plainly that the list is not verified. */
async function rosterGuard(t, messages) {
  const txt = String(t || "");
  if (!fakeRoster(txt)) return txt;
  const f = evidenceFacts(messages);
  const when = f.start ? (prettyDate(f.start) + (f.end && f.end !== f.start ? " – " + prettyDate(f.end) : "")) : "";
  if (f.list.length >= 3) {
    const head = (f.page || "the official page") + (when ? " · " + when : "") + (f.where ? " · " + f.where : "");
    return "Verified team list (" + head + "):\n\n" +
      f.list.map((n, i) => (i + 1) + ". " + n).join("\n") +
      "\n\nTeams: " + f.list.length + (f.prize ? " · Prize pool " + tidyPrize(f.prize) : "") +
      "\nYe live hi hain — koi placeholder nahi. Detail chahiye to bolo, main format, points system ya schedule bhi nikaal dunga.";
  }
  return "I don't have a verified team list for that event yet — and I won't invent rosters.\n\n" +
    "Event ka exact naam bolo (BMIC 2026 / BMSD 2026 / BGIS 2026) — main live data se official team list nikaal ke doonga.";
}
/* “teams name in it” carries no topic — inherit the previous real question so the
   search lane looks for BMIC 2026, not for the words “teams name in it”. */
/* ---------- THREAD READING (28 Oct 2026) ------------------------------------
   Owner report: “auraa ho ya zeus, yeh catch hi nahi kar pa raha ki kaise kaam
   karna hai … main nahi chahta koi yeh issue face kare.”

   ROOT CAUSE: the browser does not send messages[] turns — it sends the WHOLE chat
   inside ONE user message:
       "<this question>\n\nONGOING CONVERSATION (…):\nUser: …\nYou: …"
   The old resolver only looked at messages[] entries, so in the real app it needed
   TWO user entries, found ONE, and never ran. Every follow-up ("teams in it",
   "uska prize", "aur batao") reached the model with no topic attached.
   threadTurns() reads BOTH shapes, so the fix works for the app, the API and tests. */
/* Only words that are meaningless WITHOUT a topic. A question that starts with
   "how/why/explain/kya" is self-contained and must never be rewritten into the
   previous topic — that would be a worse bug than the one we are fixing. */
const FOLLOW_WORD = /^(teams?|team\s*names?|names?|list|lineup|line-?up|roster|participants|squads?|players?|dates?|schedule|venue|location|prize|prize\s*pool|format|winner|winners|scores?|who|whom|kaun|kon|kab|kahan|kitne?|kitni|kaunse|kaunsi|kaun\s*sa|more|aur|details?|usme|uska|uski|unka|inke|iska|iske|isko|wahan|waha|phir)\b/i;
const PRONOUN = /\b(it|its|this|that|these|those|them|they|same|above|previous|last|usme|usmein|uska|uski|uske|unka|unki|unke|inke|inka|inki|iska|iski|iske|ise|isko|inme|inmein|wahan|waha|pehle|pichle|baaki)\b/i;
function threadTurns(messages) {
  const out = [];
  for (const m of (messages || [])) {
    if (!m || typeof m.content !== "string") continue;
    if (m.role !== "user" && m.role !== "assistant") continue;
    const txt = String(m.content);
    const at = txt.search(/\n\s*ONGOING CONVERSATION\b/i);
    const head = (at >= 0 ? txt.slice(0, at) : txt).trim();
    if (head) out.push({ role: m.role, text: head });
    if (at < 0) continue;
    /* only the transcript itself — the date/memory/profile blocks that follow it
       are not conversation and must never be mistaken for a user turn */
    const tail = txt.slice(at).split(/\n\s*(?:CURRENT DATE & TIME|LIVE WEB RESULTS|AUTHORITATIVE ESPORTS FACTS|MEMORY|PROFILE|DOCUMENTS)\b/i)[0];
    const re = /(?:^|\n)[ \t]*(user|you|assistant|aura|ai)\s*:\s*/gi;
    const marks = [];
    let mm;
    while ((mm = re.exec(tail))) {
      /* the label itself belongs to the NEXT turn, so a turn ends where the next
         label BEGINS — otherwise every captured line drags "You:" along with it */
      const labelAt = mm.index + (mm[0].charAt(0) === "\n" ? 1 : 0);
      marks.push({ role: /^user$/i.test(mm[1]) ? "user" : "assistant", labelAt: labelAt, contentAt: re.lastIndex });
    }
    for (let i = 0; i < marks.length; i++) {
      const end = i + 1 < marks.length ? marks[i + 1].labelAt : tail.length;
      const text = tail.slice(marks[i].contentAt, end).trim();
      if (text) out.push({ role: marks[i].role, text: text });
    }
  }
  return out;
}
/* A follow-up carries no subject of its own — the thread does. This resolves a bare
   continuation against the previous REAL question and hands every model an explicit
   instruction, so "teams in it" can never turn into a Microsoft Teams definition. */
function resolveFragment(messages) {
  const raw = lastUserMsg(messages);
  const q = (currentAsk(raw) || raw || "").trim();
  if (!q) return null;
  const turns = threadTurns(messages);
  const prior = turns.filter(t => t.role === "user" && t.text && (currentAsk(t.text) || t.text).trim() !== q);
  const prev = prior.length ? prior[prior.length - 1].text : "";
  if (!prev) return null;
  const topic = (currentAsk(prev) || prev).replace(/\s+/g, " ").trim();
  if (!topic || topic.length < 8) return null;
  const words = q.split(/\s+/).filter(Boolean);
  const bare = FOLLOW_WORD.test(q);
  const pronoun = PRONOUN.test(q);
  /* Short AND pointing at something already said. A fresh, self-contained question
     ("how to start a cloud kitchen") has no pronoun and does not start on a follow-up
     word, so it is never rewritten into the previous topic. */
  if (!(bare && words.length <= 10) && !(pronoun && words.length <= 7)) return null;
  return { q: q, topic: topic.slice(0, 240) };
}
/* PRODUCT FACTS (29 Oct 2026) — asked "what is Lucid?", a model answered about the
   diagramming tool Lucidchart. The owner's own products have unique names, so when
   one is mentioned the answer must be about THAT app. Same block carries the
   language rule: a Hinglish question gets a Hinglish answer. */
/* a Hinglish question searches badly: "latest iphone konsa hai abhi" was sent to
   the news lane verbatim and came back with Rajasthan current affairs. Keep the
   searchable core, drop the conversational wrapper. */
function cleanAsk(q) {
  return String(q || "")
    .replace(/[?!.,;:"'()]+/g, " ")
    .replace(/\b(mujhe|humein|please|plz|bhai|yaar|batao|bataiye|bata|batana|jankari|jaankari|chahiye|kya|kaun|kaunsa|konsa|konsi|kaisi|kaisa|kaise|kab|kahan|abhi|aaj|hai|hain|ka|ki|ke|me|mein|se|ko|ek|line|short|answer|please)\b/gi, " ")
    .replace(/\s+/g, " ").trim().slice(0, 120);
}
const PRODUCT_FACTS = [
  "OWNER PRODUCTS (authoritative — these are the only products these names refer to in this chat):",
  "• Lucid — a photo studio that runs entirely in one HTML file, built by Sourabh Singh. Real WebGL editing (exposure, curves, HSL mixer, clarity, bloom, bokeh, grain), layers, brush masks, batch export to ZIP, 48 ready-made templates and an AI studio that applies edits from a typed request or an attached photo/video frame. It is NOT Lucidchart and NOT a diagramming tool.",
  "• AURA — this assistant: a holographic AI with voice in/out, vision, live web, long-term memory and a 24/7 squad.",
  "• IdeaVeda — a startup decision engine: 40 India business ideas, city-fit scores, unit economics, 14 funding schemes, stress test and plan/pitch generator.",
  "Live URLs: lucid-app-preview.web.app · aura-live-81185.web.app · ideaveda-live-app.web.app · portfolio sourabh7300.github.io",
  "LANGUAGE: answer in the language the user wrote — Hinglish in, Hinglish out; Hindi in, Hindi out; English in, English out."
].join("\n");
/* A system block appended AFTER the user's question is easy for small models to skim
   past — live evidence kept getting ignored and "latest iPhone" came back as iPhone 16.
   Grounding belongs in front of the ask, where every model reads it first. */
function withSystemBeforeAsk(messages, content) {
  const out = Array.isArray(messages) ? messages.slice() : [];
  let lastUser = -1;
  out.forEach((m, i) => { if (m && m.role === "user") lastUser = i; });
  const sys = { role: "system", content };
  if (lastUser > 0) out.splice(lastUser, 0, sys); else out.push(sys);
  return out;
}
function withProductFacts(messages) {
  try {
    if (!Array.isArray(messages)) return messages;
    if (messages.some(m => m && m.role === "system" && String(m.content || "").includes("OWNER PRODUCTS"))) return messages;
    const ask = messages.filter(m => m && m.role === "user").map(m => String(m.content || "")).join(" ");
    if (!/\b(lucid|aura|ideaveda|idea veda)\b/i.test(ask)) return messages;
    return messages.concat([{ role: "system", content: PRODUCT_FACTS }]);
  } catch (e) { return messages; }
}
function injectFollowUp(messages) {
  const frag = resolveFragment(messages);
  if (!frag) return messages;
  const note = "CURRENT TOPIC (from this same thread): \"" + frag.topic + "\".\n" +
    "THE USER'S LAST MESSAGE: \"" + frag.q + "\" — it is a FOLLOW-UP to that topic, not a new subject.\n" +
    "Rules: (1) resolve every ambiguous word against the topic — in a tournament thread \"teams\" means its participating squads and \"dates\" means that event's dates, NEVER Microsoft Teams or any other product; (2) keep the same entity/acronym the thread was about; " +
    "(3) if the exact fact is not in the evidence, say so in one line and offer the closest verified fact — never invent rosters, dates or scores; " +
    "(4) answer in the user's language (Hinglish stays Hinglish), briefly, and do not restate the question.";
  const out = messages.slice();
  const si = out.findIndex(m => m && m.role === "system" && typeof m.content === "string");
  if (si >= 0) out[si] = { role: "system", content: String(out[si].content) + "\n\n" + note };
  else out.unshift({ role: "system", content: note });
  return out;
}
/* what the search lane should actually look for: the topic the thread is on plus the
   words the user just typed. Never the raw flattened blob (transcript included). */
function followUpQuery(messages, q) {
  const cur = (currentAsk(q) || String(q || "")).replace(/\s+/g, " ").trim();
  const frag = resolveFragment(messages);
  if (!frag) return cur || String(q || "");
  return (frag.topic + " " + cur).replace(/\s+/g, " ").trim().slice(0, 300);
}
/* A reader-proxy bot wall ("Verify you are human") is not evidence — several sites hand
   one back instead of the article, and pasting that into the prompt used to wipe out the
   real facts. Keeping the source's own extract is what preserves the verified list. */
function cleanRead(t) {
  const s = String(t || "");
  if (s.length < 80) return "";
  if (/verify you are human|are you a robot|just a moment|enable javascript|captcha|unusual traffic|access denied|temporarily blocked|excessive or invalid requests|not permitted to access|rate limit|too many requests/i.test(s.slice(0, 400))) return "";
  return s;
}
/* ROSTER QUESTIONS ARE ANSWERED FROM THE EVIDENCE — never improvised. Owner report 27 Oct
   2026: asked “bmic ki teams”, got another tournament's invented “Team A … Team H”. With a
   verified list in hand that becomes impossible: the list IS the answer, so no model ever
   gets the chance to swap events. Non-roster asks (dates, venue, format, one team's own
   lineup) still go to the model with the same evidence + rosterGuard behind it. */
function isRosterAsk(q) {
  const s = String(q || "");
  /* a list-ish noun is mandatory: a bare “kaun” is a winner/captain question, not a
     roster question, and must not pull the full team table into the answer */
  if (/\b(teams?|team\s*names?|names?|list|lineup|line-?up|roster|participants|squad)\b/i.test(s)) return true;
  return /\bkaun\s*-?\s*kaun\b|\bkon\s*-?\s*kon\b|\bkaunse\b|\bkon\s*se\b|\bkitni\s+teams?\b/i.test(s);
}
function esportsFastAnswer(messages, mergedQ, rawQ) {
  if (!LIQUI || !LIQUI.isEsportsQuery(mergedQ || "")) return "";
  const f = evidenceFacts(messages);
  if (!f.list || f.list.length < 3) return "";
  const cur = currentAsk(rawQ) || String(rawQ || "");
  if (!(isRosterAsk(cur) || isRosterAsk(mergedQ))) return "";
  /* a question about ONE team ("Team SouL ka roster kya hai?") is not a list question */
  const low = cur.toLowerCase();
  if (f.list.some(n => n.length > 3 && low.includes(n.toLowerCase()))) return "";
  const when = f.start ? (prettyDate(f.start) + (f.end && f.end !== f.start ? " – " + prettyDate(f.end) : "")) : "";
  const head = (f.page ? f.page.replace(/\//g, " ") : "That event") + (when ? " · " + when : "") + (f.where ? " · " + f.where : "") + (f.venue ? " (" + f.venue + ")" : "");
  return "Verified team list — " + head + " (" + f.list.length + " teams):\n\n" +
    f.list.map((n, i) => (i + 1) + ". " + n).join("\n") +
    (f.prize ? "\n\nPrize pool " + tidyPrize(f.prize) : "") +
    (f.format ? "\nFormat: " + clipWords(tidyFormat(f.format), 220) + "." : "") +
    "\n\nYe live official data se hai — koi placeholder nahi. Kis din kaun khel raha hai ya points system chahiye to bolo.";
}
/* The browser sends the whole thread as ONE user message: the current question first,
   then an “ONGOING CONVERSATION …” transcript (and sometimes its own LIVE WEB block).
   Only that head is what the user actually just asked — matching roster/history words
   against the whole blob is how “venue kya hai” once pulled a team list. */
function currentAsk(raw) {
  return String(raw || "")
    .split(/\n\s*ONGOING CONVERSATION\b/i)[0]
    .split(/\n?LIVE WEB RESULTS \x28/i)[0]
    .trim();
}
/* “teams name in it” has no topic of its own — the thread does. Pull the event acronym
   (BMIC / BMSD / BGIS …) out of the transcript so the search keeps its subject. */
function topicHint(raw) {
  const m = String(raw || "").match(/\b(bmic|bmsd|bgis|bgms|bmps|pmgc|pmgo|pmps|pmjl|kel)\b/i);
  return m ? m[1].toLowerCase() : "";
}
/* one place that decides what to search for: the honest current question, plus its
   topic when the question itself doesn't name it. */
function searchQuery(messages) {
  const raw = lastUserMsg(messages);
  /* followUpQuery already returns "topic + this ask" for a real follow-up, and
     just the ask otherwise — overriding it with the bare head (the old bug) threw
     the topic away and searched for the words “teams in it”. */
  let q = followUpQuery(messages, raw) || currentAsk(raw) || raw;
  const hint = topicHint(raw);
  if (hint && !new RegExp("\\b" + hint + "\\b", "i").test(q)) q = hint + " " + q;
  return q.replace(/\s+/g, " ").trim().slice(0, 300);
}
async function groundChat(messages) {
  try {
    const q0 = lastUserMsg(messages);
    const ask = currentAsk(q0) || q0;
    if (!ask || isSmallTalk(ask)) return messages;
    /* The browser usually arrives already armed with its own date line + LIVE WEB block.
       That is evidence ONLY when it actually carries the facts this ask needs. Owner
       report 27 Oct 2026 (round 2): “teams name in it” was searched WORD-FOR-WORD by the
       client — no topic attached — the search came back empty, and the brain then swapped
       BMIC for BMSD and invented “Team A … Team H”. So an ESPORTS ask with no verified
       facts in hand is searched again right here, with the topic-aware query. Other
       questions keep the client's own block (no double search, no added latency). */
    const armed = (messages || []).some(m => m && m.role === "system" && /CURRENT DATE & TIME|LIVE WEB RESULTS/.test(String(m.content || "")));
    const f0 = evidenceFacts(messages);
    const esp = !!(LIQUI && (LIQUI.isEsportsQuery(ask) || LIQUI.isEsportsQuery(q0)));
    if (armed && (!esp || f0.list.length >= 3 || !!f0.start)) return messages;
    const q = searchQuery(messages);
    const now = new Date().toLocaleDateString("en-IN", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    let web = "";
    try {
      const hits = await toolSearch(q.replace(/\s+/g, " "));
      if (hits && hits.length) {
        const top = hits.slice(0, 2);
        /* a Liquipedia hit already IS the facts block — re-reading the page through the
           text proxy costs seconds and returns the bot wall, never more facts */
        const reads = await Promise.all(top.map(h => (h.extract && /DATES:|TEAMS\s*\(/.test(h.extract)) ? Promise.resolve(null) : toolFetch(h.url).catch(() => null)));
        web = top.map((h, i) => "[SOURCE " + (i + 1) + ": live web — " + (h.title || "") + "]\n" + String(cleanRead(reads[i]) || h.extract || h.title || "").slice(0, 1600)).join("\n\n");
      }
    } catch (e) { /* search down → date + rules still apply */ }
    const head = esp
      ? "AUTHORITATIVE ESPORTS FACTS (Liquipedia — fetched seconds ago, REAL and CURRENT; these WIN over every other source in this thread. If any earlier web block names a DIFFERENT tournament, or shows placeholder teams like 'Team A', it is WRONG — answer only the event named here):\n"
      : "LIVE WEB RESULTS (fetched seconds ago — REAL and CURRENT; the live results WIN over your memory of past events, dates, scores or records):\n";
    return messages.concat([{ role: "system", content:
      "CURRENT DATE & TIME: " + now + " (anchor 'today/now/latest' to THIS moment).\n" +
      (web ? head + web + "\n" : "No live results were found for this question.\n") +
      AURA_FACT_RULES }]);
  } catch (e) { return messages; }
}

/* THE PROXY — key stays server-side forever */
app.post("/v1/chat/completions", async (req, res) => {
  const body = req.body || {};
  let messages = body.messages;
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: "messages[] required" });
  }
  /* a one-word continuation ("teams in it") is resolved against the previous turn
     BEFORE any model sees it — that is what stops the topic from drifting */
  messages = withProductFacts(injectFollowUp(messages));
  const makerHere = req.__role === "maker" || req.__role === "ceo";
  /* makers choose any model (flagship first); public requests are served the lighter
     tier regardless of what the browser asks for — that's the quota saver */
  const requestedModel = makerHere ? (body.model || MODELS[0]).trim() : "";
  const modelList = makerHere ? MODELS : PUBLIC_MODELS;
  let order = makerHere ? [requestedModel, ...MODELS.filter(m => m !== requestedModel)] : PUBLIC_MODELS.slice();
  /* swap in the model ids this account really has — a browser asking for a retired
     id must not turn into a 14-second fallback to a giant reasoning model */
  try {
    const avail = await groqModels();
    if (avail.length) {
      const pref = order.filter(m => avail.indexOf(m) >= 0);
      const rest = avail.filter(m => pref.indexOf(m) < 0).slice(0, 2);
      order = [...new Set([...pref, ...rest])];
    }
  } catch (e) { /* discovery is best-effort; the configured order still stands */ }

  /* ANSWER CACHE — makers bypass; identical visitor questions cost zero tokens */
  if (!makerHere && !body.stream) {
    const hit = cacheGet(messages);
    if (hit) return res.json({ choices: [{ message: { content: hit.answer } }], model: hit.model + " (cached)" });
  }
  /* VISITOR DAILY CAP — signed-in users count against their uid, guests against IP; makers exempt */
  if (!makerHere && overCap(req)) {
    return res.status(429).json({ outOfTokens: true, message: "You've hit today's free-answer limit for this site. Come back tomorrow — or bring your own key with SET AI KEY for unlimited chats." });
  }

  /* VISION: messages that carry an image route to the vision brain */
  if (msgHasImage(messages)) {
    const vt = await visionCall(messages, Math.min(body.max_tokens || 900, 4000), body.temperature, req);
    if (vt) return res.json({ choices: [{ message: { content: vt } }], model: "vision brain" });
    if (!GEMINI_API_KEY) return res.status(501).json({ error: "no_vision_model", message: "My image brain needs its key — the owner can enable it privately in the hosting dashboard. Text answers are unaffected." });
    return res.status(502).json({ error: "vision_failed", message: "The vision model could not read that image — try a clearer photo." });
  }

  /* STALE-KNOWLEDGE FIX 19 Oct 2026 (owner report: “purani sources se reply de rha hai”):
     direct API requests carried no date and no web context, so the model answered from
     its frozen training cutoff (verified live: “I don’t have information beyond my last
     update in June 2024”). Every plain knowledge question now gets TODAY’S date plus
     live web results (the same toolSearch/toolFetch lanes /v1/websearch uses) injected
     as a system block before the model call. Small talk and already-armed requests are
     untouched; empty search costs nothing (fail-open). */
  let __live = null; /* real web hits, kept so a failed model still cannot answer from a stale cutoff */
  try {
    const _lastUser = [...messages].reverse().find(m => m && m.role === "user" && typeof m.content === "string" && m.content.trim());
    const _q = _lastUser ? searchQuery(messages) : "";
    const _small = /^(hi+|hello+|hey+|yo|ok(ay)?|thanks?|thank you|namaste|good\s*(morning|evening|night|afternoon)|who are you|what('s| is) your name|are you (real|human|an ai))\b/i.test(_q);
    const _alreadyArmed = messages.some(m => m && m.role === "system" && /CURRENT DATE & TIME|LIVE WEB RESULTS/.test(String(m.content || "")));
    /* SPEED (29 Oct 2026): a search plus two page reads BEFORE the model cost every
       ordinary question seconds — even "what is 2+2". Only questions that can
       actually have changed recently are worth that wait; math, code, definitions,
       how-to and small talk answer straight from the brain. */
    const _fresh = /(latest|today|tonight|now|current|news|price|rate|score|result|schedule|when|kab|aaj|abhi|20[2-9][0-9]|winner|won|match|tournament|election|weather|stock|ipo|launch|release|update|trending|kitna)/i.test(_q);
    if (_q && _fresh && !_small && !_alreadyArmed) {
      const _now = new Date().toLocaleDateString("en-IN", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
      let _web = "", _cand = "";
      try {
        const _sq = cleanAsk(_q) || _q.replace(/\s+/g, " ");
        const _hits = await toolSearch(_sq);
        if (process.env.AURA_DEBUG) console.log("[chat] live=" + (_hits ? _hits.length : 0) + " q=\"" + _sq + "\"")
        if (_hits && _hits.length) {
          __live = { now: _now, hits: _hits.slice(0, 3) };
          /* ONE page, capped at 5s: two uncapped reads were costing 5–10s before the
             model even started, and the headlines alone already answer "latest X" */
          const _top = _hits.slice(0, 1);
          const _reads = await Promise.all(_top.map(h => toolFetch(h.url, 5_000).catch(() => null)));
          _web = _top.map((h, i) => "[SOURCE " + (i + 1) + ": live web — " + (h.title || "") + "]\n" + String(cleanRead(_reads[i]) || h.extract || h.title || "").slice(0, 1600)).join("\n\n");
          /* MODEL-PROOF HEADLINE (29 Oct 2026): the lighter NIM model kept answering
             "latest iPhone" from memory (iPhone 16) even with dated results in front of
             it. Putting the newest headline first as a one-line fact, plus every other
             headline as a bullet, makes the current value the easiest thing to copy. */
          const _h0 = _hits[0];
          const _snip = String(cleanRead(_reads[0]) || _h0.extract || "").replace(/\s+/g, " ").trim().slice(0, 300);
          _cand = "LATEST VERIFIED HEADLINE (" + (_h0.date || _now) + "): \"" + (_h0.title || "") + "\"" + (_snip ? " — " + _snip : "") +
            "\nOTHER HEADLINES FROM THE SAME SEARCH:\n" + _hits.slice(1, 3).map(h => "• " + (h.title || "") + (h.date ? " (" + String(h.date).slice(0, 24) + ")" : "")).join("\n");
        }
      } catch (e) { /* search down → date-only block still fixes the cutoff */ }
      messages = withSystemBeforeAsk(messages, "CURRENT DATE & TIME: " + _now + " (anchor 'today/now/latest' to THIS moment — never answer from an old training cutoff, never state a stale knowledge date).\n" + (_web ? _cand + "\n\nLIVE WEB RESULTS (fetched seconds ago — REAL and CURRENT; ground every time-sensitive fact in them; when they conflict with your memory of past events, dates, scores, prices or records, the live results WIN; never invent dates, scores, prices or winners):\n" + _web + "\nANSWER FROM THE RESULTS FIRST: the specific model, price, date or name the user asked about must be taken from these results — if the question is about the newest model/version/price/winner and these results name one, that one is the answer even when your memory says otherwise. If they do not contain it, say plainly that you could not verify today's value — never present an older model, price or version as the current one. Your first sentence must answer, not describe your reasoning." : "No live results — answer with today's date in mind; if the answer may have changed more recently than your training, say today's date and mark the uncertainty instead of guessing a specific recent value."));
      /* fresh facts are copied, not composed: a low temperature keeps the model on the
         headline instead of drifting back into its training data */
      if (typeof body.temperature !== "number") body.temperature = 0.25;
    }
  } catch (e) { /* amplification is best-effort — never block the answer */ }
  /* visible to the owner on any response: did this answer get live evidence, and how much */
  try { res.setHeader("X-Aura-Live", String(__live && __live.hits ? __live.hits.length : 0)); } catch (e) {}
  /* the fact rules apply even to already-grounded / cached / small-talk requests */
  try {
    if (!messages.some(m => m && m.role === "system" && String(m.content || "").includes("FACT RULES (owner order)")))
      messages = withSystemBeforeAsk(messages, AURA_FACT_RULES);
  } catch (e) {}
  /* roster-exact answers never touch a model (see esportsFastAnswer) */
  try {
    const _rawU = lastUserMsg(messages);
    const _fastA = esportsFastAnswer(messages, searchQuery(messages), _rawU);
    if (_fastA) return res.json({ choices: [{ message: { content: _fastA } }], model: "live esports data" });
  } catch (e) {}
  /* GEMINI FIRST (29 Oct 2026): the Groq ids on this account are retired and the
     NIM fallback ignored the injected live results — a "latest iPhone" question got
     answered from a stale cutoff. Gemini actually follows the evidence block and is
     fast; the key bank below stays as the fallback. */
  if (GEMINI_API_KEY) {
    try {
      const gt = await geminiChat(messages, Math.min(body.max_tokens || 1400, 3000), body.temperature, req);
      if (gt) {
        if (!makerHere) { cachePut(messages, gt, "gemini"); countAnswer(req); }
        return res.json({ choices: [{ message: { content: gt } }], model: "gemini (text)" });
      }
    } catch (e) { /* fall through to the key bank */ }
  }
  /* TRUTH OVER PROSE (29 Oct 2026, revised): this used to fire BEFORE the key bank, so
     every "latest …" question was answered with a raw headline list even when NIM/Groq
     were healthy and already had the live results in their prompt. A headline dump is
     the last resort now — only after Gemini, Groq, NIM and the reserve have all failed. */
  const liveFallback = () => {
    if (makerHere || !__live || !__live.hits || !__live.hits.length) return null;
    const clean = s => String(s || "").replace(/&amp;/g, "&").replace(/<[^>]+>/g, "").trim();
    const lines = __live.hits.slice(0, 3).map(h => "• " + clean(h.title).replace(/\s+-\s+[^-]{2,40}$/, "")).join("\n");
    const src = (__live.hits.find(h => /^https?:/.test(String(h.url || "")) && !/news\.google\.com\/?$/.test(String(h.url))) || __live.hits[0]).url;
    return "Here's what the live web says today (" + __live.now + ") — the full answer lanes are busy right now:\n" + lines +
      "\n\nI'll have a proper answer in a moment. " + src;
  };

  let sawLimit = false; // at least one key hit a rate/limit error
  let lastChatErr = ""; // every upstream reason, surfaced in the 502 instead of a guess
  const pushErr = s => { lastChatErr = (lastChatErr ? lastChatErr + " | " : "") + s; if (lastChatErr.length > 420) lastChatErr = "…" + lastChatErr.slice(-410); };
  /* KEY LANE — the CODE forge tags its requests with lane:"code" so they burn
     the dedicated code key (fallback: shared bank) and never starve chat quota */
  const __lane = body.lane === "code" ? "code" : "";
  if (__lane === "code") {
    /* CODE LANE — a Mistral key in AI_KEY_CODE powers the forge with Codestral first */
    const __ct = await laneCall("code", CODE_KEY, MISTRAL_CODE_MODELS, messages, Math.min(body.max_tokens || 4000, 8000), body.temperature, req);
    if (__ct) return res.json({ choices: [{ message: { content: __ct } }], model: "code-lane" });
  }
  for (const model of order) {
    try {
      /* reasoning models (gpt-oss) spend tokens thinking — floor the budget so content is never empty */
      let maxTok = Math.min(body.max_tokens || 1400, 4000);
      if (model.startsWith("openai/gpt-oss") && maxTok < 600) maxTok = 600;
      const key = __lane === "code" ? pickLaneKey(CODE_KEY, false) : pickKey();
      if (!key) {
        sawLimit = true; break; // no live key → the Mistral reserve covers below
      }
      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: maxTok,
          temperature: body.temperature != null ? body.temperature : 0.6
        }),
        signal: AbortSignal.timeout(45_000)
      });
      if (r.status === 429) { keyCool.set(key, Date.now() + 70_000); sawLimit = true; pushErr(model + " 429"); continue; }
      if (r.status === 401 || r.status === 403) { keyCool.set(key, Date.now() + 24 * 3600_000); sawLimit = true; pushErr("key " + r.status); continue; } // dead key → reserve will cover
      if (r.status === 404 || r.status === 400) {
        /* keep the upstream sentence, not just the code: "model_not_found" and
           "request too large (TPM)" both arrive as 400 and need opposite fixes */
        let em = ""; try { const eb = await r.json(); em = (eb && eb.error && eb.error.message) || ""; } catch (e) {}
        pushErr(model + " " + r.status + (em ? ": " + String(em).slice(0, 110) : ""));
        continue; // retired/invalid model → next model
      }
      if (!r.ok) { pushErr(model + " HTTP " + r.status); return res.status(r.status).json({ error: "Upstream HTTP " + r.status }); }
      const d = await r.json();
      const t = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
      if (t && t.trim()) { t = await rosterGuard(t, messages); recordUse(req, key, (d.usage && d.usage.total_tokens) || Math.round(t.length / 4), model); if (!makerHere) { cachePut(messages, t.trim(), model); countAnswer(req); } return res.json({ choices: [{ message: { content: t.trim() } }], model }); }
    } catch (e) { /* network hiccup → try next model */ }
  }
  /* keep the reason the fast lane failed visible in /health — a silent fall through
     to a 550B model is exactly how "replies are slow" stayed undiagnosed */
  chatLast.at = Date.now(); chatLast.err = lastChatErr || "";
  /* NIM + reserve run whatever Groq said (28 Oct 2026): a retired model id makes
     every Groq call 400/404 — that is NOT a rate limit — so the old `if (sawLimit)`
     gate skipped the maker's NIM lane entirely and public chat fell straight through
     to 502 while the squad's own NIM calls were answering 200 on the same host. */
  {
    const NIM_KEY = process.env.NVIDIA_NIM_KEY || "";
    if (NIM_KEY) {
      /* fastest NIM model first: the 550B flagship is a last resort, not the public
         default — it adds seconds to every answer */
      /* the 30B model is fast but loses the prompt when the evidence block is long;
         the 120B one follows it. Lite speed for short chat, 120B whenever the
         route injected live results (see nimPick below). */
      const nimPick = /LIVE WEB RESULTS/.test(JSON.stringify(messages))
        ? ["nvidia/nemotron-3-super-120b-a12b", "nvidia/nemotron-3.5-lightning-30b-a3b", "nvidia/nemotron-3-ultra-550b-a55b"]
        : ["nvidia/nemotron-3.5-lightning-30b-a3b", "nvidia/nemotron-3-super-120b-a12b", "nvidia/nemotron-3-ultra-550b-a55b"];
      for (const model of nimPick) {
        try {
          const nimBase = { model, messages, max_tokens: Math.min(body.max_tokens || 1400, 4000), temperature: body.temperature != null ? body.temperature : 0.6 };
          const nimAsk = extra => fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
            method: "POST",
            headers: { "Authorization": "Bearer " + NIM_KEY, "Content-Type": "application/json" },
            body: JSON.stringify(Object.assign({}, nimBase, extra)),
            signal: AbortSignal.timeout(60_000)
          });
          /* a reasoning model narrates its thinking inside `content` when thinking is
             on — the visitor then reads "The user is asking…" instead of an answer.
             Ask for it off; if this NIM deployment rejects the flag, retry plain. */
          let r = await nimAsk({ chat_template_kwargs: { thinking: false } });
          if (r.status === 400) r = await nimAsk({});
          if (r.status === 429) continue;
          if (!r.ok) continue;
          const d = await r.json();
          const t = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
          if (t && t.trim()) return res.json({ choices: [{ message: { content: await rosterGuard(t, messages) } }], model: model + " (nvidia-nim)" });
        } catch (e) { /* next NIM model */ }
      }
    }
    /* then the reserve brain before giving up */
    const mt = await reserveCall(messages, Math.min(body.max_tokens || 1400, 4000), body.temperature, req);
    if (mt) return res.json({ choices: [{ message: { content: await rosterGuard(mt, messages) } }], model: RESERVE_MODEL + " (reserve)" });
    /* every model lane is down — a grounded headline list beats an error page */
    const lf = liveFallback();
    if (lf) return res.json({ choices: [{ message: { content: lf } }], model: "live web" });
    /* nothing left — a drained bank gets the friendly notice, anything else the reason */
    if (sawLimit) return res.status(429).json({ error: "out_of_tokens", outOfTokens: true,
      message: "Today's free AI allowance is used up. Full power returns tomorrow — meanwhile the offline core still answers." });
  }
  chatLast.at = Date.now(); chatLast.err = lastChatErr || "";
  res.status(502).json({ error: "All models exhausted or rate-limited. Try again shortly." + (lastChatErr ? " (" + lastChatErr + ")" : "") });
});

/* ============ AGENT LOOP — she stops answering and starts DOING ============
   POST /v1/agent  { question, maxSteps }
   Loop: LLM picks a tool (search / fetch_page / calculator) → backend runs it →
   result fed back → LLM reasons again → … → final answer with numbered sources.
   Streams progress as SSE: data:{step:...} → data:{delta:final} → data:[DONE]
   This is the tool-loop that turns a chatbot into an agent (deep-research style). */
const MAX_STEPS = 8;
function llm1(messages, maxTok, req) {
  /* one-shot internal LLM call for the loop — the maker's missions burn the admin lane */
  return (async () => {
    const __admLane = req && (req.__role === "maker" || req.__role === "ceo");
    /* ADMIN LANE — a Mistral key in AI_KEY_ADMIN powers maker agent loops first */
    if (__admLane) { const __at = await laneCall("admin", ADMIN_KEY, MISTRAL_ADMIN_MODELS, messages, Math.min(maxTok || 700, 4000), 0.3, req); if (__at) return __at; }
    for (const model of MODELS) {
      const key = __admLane ? pickLaneKey(ADMIN_KEY, true) : pickKey();
      if (!key) return null;
      try {
        const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
          body: JSON.stringify({ model, messages, max_tokens: Math.min(maxTok || 700, 4000), temperature: 0.3 }),
          signal: AbortSignal.timeout(45_000)
        });
      if (!r.ok) { if (r.status === 429) keyCool.set(key, Date.now() + 70_000); continue; }
        const d = await r.json();
        const t = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
        if (t && t.trim()) { recordUse(req, key, (d.usage && d.usage.total_tokens) || Math.round(t.length / 4), model); return t.trim(); }
      } catch (e) {}
    }
    const mt = await reserveCall(messages, maxTok, 0.3, req);
    return mt;
  })();
}
function extractJson(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) { return null; }
}
const WEB_JUNK = /unusual traffic|not a robot|why did this happen|captcha|enable javascript|just a moment|access denied|are you a human/i;
/* ============ REAL SEARCH (29 Oct 2026) ============
   The free lanes (Google News RSS, DDG lite, Wikipedia) are best-effort: on some
   days they return nothing for a product question and the answer falls back to the
   model's training cutoff. A real search API fixes that, so this layer supports the
   three keys an owner is likely to have and uses whichever one is present:
     TAVILY_API_KEY · BRAVE_SEARCH_API_KEY · EXA_API_KEY
   Results are normalized to {title,url,date,snippet}; nothing here is exposed to
   the browser and no key ever leaves the server. */
const SEARCH_KEYS = {
  tavily: (process.env.TAVILY_API_KEY || "").trim(),
  brave: (process.env.BRAVE_SEARCH_API_KEY || process.env.BRAVE_API_KEY || "").trim(),
  exa: (process.env.EXA_API_KEY || "").trim()
};
function searchProvider() {
  if (SEARCH_KEYS.tavily) return "tavily";
  if (SEARCH_KEYS.brave) return "brave";
  if (SEARCH_KEYS.exa) return "exa";
  return "free";
}
const cleanHit = (title, url, snippet, date) => ({
  title: String(title || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(),
  url: String(url || "").trim(),
  date: String(date || ""),
  snippet: String(snippet || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 400)
});
/* OWNER CHECK 29 Oct 2026: "latest iPhone" was answered with the iPhone 17 because the
   generic index ranks 2025 buying guides first. A freshness-shaped question now asks
   Tavily's news index (dated, last 60 days) — "Best iPhone 2026 … including the Duo"
   instead of "iPhone 17 line-up". Normal questions keep the cheap basic search. */
const FRESH_RE = /\b(latest|today|tonight|now|current|news|price|rate|score|result|schedule|launch|release|update|trending|winner|won|aaj|abhi|kab)\b|20[2-9][0-9]/i;
async function realSearch(q, n, fresh) {
  const count = Math.max(3, Math.min(n || 5, 8));
  const provider = searchProvider();
  try {
    if (provider === "tavily") {
      const tav = (opts) => fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.assign({ api_key: SEARCH_KEYS.tavily, query: q, max_results: count, include_answer: false }, opts)),
        signal: AbortSignal.timeout(fresh ? 20_000 : 12_000)
      });
      let r = await tav(fresh ? { search_depth: "advanced", topic: "news", days: 60 } : { search_depth: "basic" });
      if (!r.ok && fresh) r = await tav({ search_depth: "basic" }); /* news index rejected the query → plain */
      if (!r.ok) return null;
      const j = await r.json();
      return (j.results || []).map(x => cleanHit(x.title, x.url, x.content, x.published_date)).filter(h => h.url);
    }
    if (provider === "brave") {
      const r = await fetch("https://api.search.brave.com/res/v1/web/search?q=" + encodeURIComponent(q) + "&count=" + count + "&safesearch=moderate" + (fresh ? "&freshness=pm" : ""), {
        headers: { "Accept": "application/json", "X-Subscription-Token": SEARCH_KEYS.brave },
        signal: AbortSignal.timeout(12_000)
      });
      if (!r.ok) return null;
      const j = await r.json();
      return ((j.web && j.web.results) || []).map(x => cleanHit(x.title, x.url, x.description, x.age)).filter(h => h.url);
    }
    if (provider === "exa") {
      const r = await fetch("https://api.exa.ai/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": SEARCH_KEYS.exa },
        body: JSON.stringify({ query: q, numResults: count, type: "auto", contents: { highlights: { numSentences: 2 } } }),
        signal: AbortSignal.timeout(12_000)
      });
      if (!r.ok) return null;
      const j = await r.json();
      return (j.results || []).map(x => cleanHit(x.title, x.url, (x.highlights && x.highlights[0]) || x.text, x.publishedDate)).filter(h => h.url);
    }
  } catch (e) { /* a bad key or a network blip falls back to the free lanes */ }
  return null;
}
async function toolSearch(q) {
  /* live web search — ordered by cloud-IP reliability:
     0) Liquipedia API (esports only — the only source that actually carries rosters,
        schedules and results; news feeds never do, which is why AURA once invented
        "Team A … Team H" for a BMIC question)
     1) Google News RSS (machine feed, no bot walls, always fresh)
     2) jina → Google News HTML   3) DuckDuckGo lite/html   4) Wikipedia search (never blocked) */
  const out = [];
  if (LIQUI && LIQUI.isEsportsQuery(q)) {
    try {
      const lp = await LIQUI.liquipediaSearch(q, 2);
      for (const h of lp) if (!out.some(x => x.url === h.url)) out.push(h);
    } catch (e) {}
    /* an official tournament page beats a generic news feed for rosters/dates, so it
       is the whole evidence set — irrelevant headlines were what nudged the model
       into mixing events up in the first place */
    if (out.length) return out.slice(0, 2);
  }
  /* a real search API answers first when its key is configured — this is the lane
     that guarantees fresh, ranked results for "latest …" questions */
  if (searchProvider() !== "free") {
    try {
      const hits = await realSearch(q, 6, FRESH_RE.test(q));
      if (hits && hits.length) return hits.slice(0, 5);
    } catch (e) { /* fall through to the free lanes */ }
  }
  try {
    const r = await fetch("https://news.google.com/rss/search?q=" + encodeURIComponent(q) + "&hl=en-IN&gl=IN&ceid=IN:en", { signal: AbortSignal.timeout(10_000), headers: { "User-Agent": "Mozilla/5.0 (compatible; AURA-backend/1.0)" } });
    if (r.ok) {
      const t = await r.text();
      const items = t.match(/<item>[\s\S]*?<\/item>/g) || [];
      for (const it of items) {
        if (out.length >= 5) break;
        const ti = (it.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1] || "";
        const li = (it.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || "";
        const pd = (it.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || "";
        const title = ti.replace(/\s+/g, " ").trim();
        if (!title || WEB_JUNK.test(title)) continue;
        out.push({ title, url: li.trim(), date: pd.trim() });
      }
    }
  } catch (e) {}
  if (out.length < 3) {
    try {
      const r = await fetch("https://r.jina.ai/https://news.google.com/search?q=" + encodeURIComponent(q), { signal: AbortSignal.timeout(8_000) });
    if (r.ok) {
      const t = await r.text();
      const re = /\[([^\]\n]{12,120})\]\((https?:\/\/[^)\s]+)\)/g; let m, n = 0;
      while ((m = re.exec(t)) && out.length < 5) {
        const title = m[1].replace(/\s+-\s+[^-]+$/, "").trim();
        if (/google|news\.google|signin|privacy|terms/i.test(title)) continue;
        if (WEB_JUNK.test(title)) continue; /* cloud-IP CAPTCHA pages are not search results */
        out.push({ title, url: m[2] }); if (++n >= 5) break;
      }
    }
    } catch (e) {}
  }
  if (out.length < 3) {
    try {
      const r2 = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q), { signal: AbortSignal.timeout(15_000) });
      if (r2.ok) {
        const t2 = await r2.text();
        const re2 = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g; let m2;
        while ((m2 = re2.exec(t2)) && out.length < 6) {
          let u = m2[1]; const du = u.match(/uddg=([^&]+)/); if (du) u = decodeURIComponent(du[1]);
          const title = m2[2].replace(/<[^>]+>/g, "").trim();
          if (WEB_JUNK.test(title)) continue;
          out.push({ title, url: u });
        }
      }
    } catch (e) {}
  }
  /* DDG LITE (27 Oct 2026): the html endpoint is blocked from many cloud IPs and the
     news feed only indexes headlines, so “bmic 2026” came back empty and the brain
     improvised. lite.duckduckgo.com returns real result pages for these queries. */
  if (out.length < 3) {
    try {
      const rl = await fetch("https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(q), { signal: AbortSignal.timeout(12_000), headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36" } });
      if (rl.ok) {
        const tl = await rl.text();
        const rel = /<a[^>]+class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
        let ml;
        while ((ml = rel.exec(tl)) && out.length < 6) {
          let u = ml[1];
          const du = u.match(/uddg=([^&]+)/); if (du) u = decodeURIComponent(du[1]);
          if (u.startsWith("//")) u = "https:" + u;
          const title = ml[2].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
          if (!title || WEB_JUNK.test(title)) continue;
          if (!out.some(x => x.url === u)) out.push({ title, url: u });
        }
      }
    } catch (e) {}
  }
  if (out.length < 3) {
    try {
      const r3 = await fetch("https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=" + encodeURIComponent(q) + "&format=json&srlimit=4", { signal: AbortSignal.timeout(9_000) });
      if (r3.ok) {
        const d3 = await r3.json();
        ((d3.query || {}).search || []).forEach(s => {
          if (out.length < 6) out.push({ title: s.title, url: "https://en.wikipedia.org/wiki/" + encodeURIComponent(s.title.replace(/ /g, "_")), date: "" });
        });
      }
    } catch (e) {}
  }
  return out;
}
async function toolFetch(url, ms) {
  try {
    const r = await fetch("https://r.jina.ai/" + url, { signal: AbortSignal.timeout(ms || 20_000) });
    if (!r.ok) return null;
    let t = await r.text();
    t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[(.*?)\]\([^)]*\)/g, "$1").replace(/[#*_`>|]/g, " ").replace(/\s+/g, " ");
    const i = t.indexOf("Markdown Content:"); if (i > -1) t = t.slice(i + 17);
    return t.slice(0, 6500);
  } catch (e) { return null; }
}
function toolCalc(expr) {
  try { return String(Function("return (" + expr + ")")()); } catch (e) { return "error: " + e.message; }
}

/* ============ LIVE WEB SEARCH — fresh-knowledge lane for the chat brain ============
   POST /v1/websearch {question:"..."} → same-day web intelligence (Google News RSS
   primary, DuckDuckGo + Wikipedia backup) with page reads. The chat brain calls this
   whenever a question is time-sensitive, so answers stay current-day, never frozen
   at the model's training cutoff. */
app.post("/v1/websearch", async (req, res) => {
  let q = String((req.body || {}).question || "").trim().slice(0, 300);
  /* OWNER FIX 13 Oct 2026: Hinglish chat phrasing ("nvidia ke bare me batao", "mujhe aura ke
     bare me jankari chahiye") used to be fed to the news/wikipedia lanes verbatim — the filler
     words drowned the real topic and the lanes came back empty, so the brain fell back on its
     frozen training cutoff. Strip the conversational wrapper, keep the searchable core. */
  q = q.replace(/(?:mujhe|humein|hum|please|plz|sir|bhai|yaar)\s+/gi, " ")
       .replace(/\b(?:ke|ki)\s+baare?\s*me(?:in)?|\bke\s+bare\s*me(?:in)?\b/gi, " ")
       .replace(/\b(?:batao|bataiye|bata|batana|batao na|jankari|jaankari|chahiye|do|dijiye|kya hai|kya hai aaj|kaun|kaun hai|kaise|kyu|kyun|hai)\b/gi, " ")
       .replace(/\s+/g, " ").trim();
  if (!q || q.length < 4 || /^(hi+|hello+|hey+|yo|ok(ay)?|thanks?|thank you|namaste|good\s*(morning|evening|night|afternoon))[!. ]*$/i.test(q)) {
    return res.json({ results: [] }); /* greetings don't deserve a web crawl */
  }
  const started = Date.now();
  try {
    const hits = await toolSearch(q);
    if (!hits.length) return res.json({ results: [], took: Date.now() - started });
    /* read the two most promising pages so the brain gets substance, not just headlines */
    const top = hits.slice(0, 2);
    const reads = await Promise.all(top.map(h => toolFetch(h.url, 8_000).catch(() => null)));
    const results = hits.map((h, i) => ({
      k: "web",
      title: h.title,
      url: h.url,
      extract: String(cleanRead(reads[i]) || h.extract || h.title || "").slice(0, 1800)
    }));
    res.json({ results, took: Date.now() - started });
  } catch (e) {
    res.status(502).json({ error: "websearch_failed", message: e.message });
  }
});

/* ================= CALENDAR v1 — private ICS bridge (Sourabh's design) =================
   GET /v1/calendar?url=<secret ICS address>&days=7 — the URL is supplied per-request by
   the client (stored only in that user's browser), fetched server-side (no CORS limits),
   parsed to the next N days and returned. Nothing about the feed is persisted here. */
function icsEvents(icsRaw, now, days) {
  now = now || Date.now(); days = days || 7;
  const winStart = now - 6 * 3600 * 1000, winEnd = now + days * 86400000;
  const text = String(icsRaw || "").replace(/\r\n/g, "\n");
  /* unfold RFC5545 continuation lines (a line starting with space/tab continues the previous one) */
  const lines = text.split("\n").reduce(function (acc, l) {
    if (/^[ \t]/.test(l) && acc.length) acc[acc.length - 1] += l.slice(1); else acc.push(l);
    return acc;
  }, []);
  const evs = [];
  let cur = null;
  const push = function () { if (cur && cur.at && cur.at <= winEnd && cur.at >= winStart) evs.push(cur); cur = null; };
  const parseDT = function (v) {
    if (!v) return 0;
    /* basic form 20261002T164000Z parsed by field (V8 skips basic ISO); Z/UTC assumed —
       the ICS secret-address format used by Google/Outlook is always UTC Z-form */
    let m = String(v).match(/(\d{4})-?(\d{2})-?(\d{2})T?(\d{2})?:?(\d{2})?:?(\d{2})?/);
    if (m) { const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)); return isNaN(t) ? 0 : t; }
    const d = Date.parse(v);
    return isNaN(d) ? 0 : d;
  };
  for (const ln of lines) {
    if (/^BEGIN:VEVENT/i.test(ln)) { cur = { summary: "", at: 0 }; continue; }
    if (/^END:VEVENT/i.test(ln)) { push(); continue; }
    if (!cur) continue;
    let m;
    if ((m = ln.match(/^SUMMARY[^:]*:(.*)$/i))) { cur.summary = m[1].replace(/\\,/g, ",").replace(/\\n/g, " ").trim().slice(0, 120); continue; }
    if ((m = ln.match(/^DTSTART[^:]*:(.*)$/i))) { cur.at = parseDT(m[1]); continue; }
  }
  return evs.sort(function (a, b) { return a.at - b.at });
}
app.get("/v1/calendar", async (req, res) => {
  const url = String(req.query.url || "").trim();
  const days = Math.min(parseInt(req.query.days, 10) || 7, 31);
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: "url required" });
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { "Accept": "text/calendar" } });
    if (!r.ok) return res.status(502).json({ error: "feed_unreachable", status: r.status });
    const ics = await r.text();
    res.json({ events: icsEvents(ics, Date.now(), days), took: Date.now() % 1000 });
  } catch (e) {
    res.status(502).json({ error: "calendar_fetch_failed", message: e.message });
  }
});

app.post("/v1/agent", async (req, res) => {
  const body = req.body || {};
  const q = String(body.question || "").trim();
  if (!q) return res.status(400).json({ error: "question required" });
  /* AGENT SPEND CONTROL — every step is a real AI call. Makers run freely;
     guests get a small daily allowance so drive-by scripts can't farm the bank. */
  const agentMaker = req.__role === "maker" || req.__role === "ceo";
  if (!agentMaker) {
    if (overAgentCap(req)) return res.status(429).json({ error: "guest agent limit reached for today — sign in for more runs" });
    body.maxSteps = Math.min(parseInt(body.maxSteps, 10) || 5, 4);
  }
  countAgent(req);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  const send = obj => { try { res.write("data: " + JSON.stringify(obj) + "\n\n"); } catch (e) {} };
  const finish = () => { try { res.write("data: [DONE]\n\n"); res.end(); } catch (e) {} };
  if (!pickKey() && !RESERVE_KEY) {
    send({ step: { icon: "⚠️", label: "no AI keys live on the server — ask the owner to re-arm the key bank" } });
    finish(); return;
  }
  const tools =
    'You are AURA — Sourabh Singh\'s holographic AI assistant: live web research with citations, code, voice and long-term memory.\n' +
    'IDENTITY RULE: if the request is about you (who are you, what can you do, are you human, greetings, thanks, small talk), use tool "answer" immediately and reply from this identity. Never search for those words and never answer with a TV show, a dictionary entry or an unrelated page.\n' +
    'You are AURA\'s AGENT CORE. Solve every other request by using tools, step by step.\n' +
    'Every reply MUST be exactly one JSON object, nothing else:\n' +
    '{"thought":"one short sentence about what you know/need","tool":"search|fetch|calc|answer","input":"..."}\n' +
    'tool "search": input = web search query (for news/current facts).\n' +
    'tool "fetch": input = a URL from earlier search results worth reading fully.\n' +
    'tool "calc": input = a plain arithmetic expression like 2+2*3.14159.\n' +
    'tool "answer": input = the FINAL user-facing answer, written normally (not JSON). Cite sources inline as [1], [2] matching the numbered sources provided. If information is missing, say what you found and what is uncertain.\n';
  const sys = String(body.system || "");
  const maxSteps = Math.min(Math.max(parseInt(body.maxSteps, 10) || 5, 2), MAX_STEPS);
  const sources = [];
  const transcript = [];
  send({ step: { icon: "🎯", label: "goal locked: " + q.slice(0, 70) } });
  let finalAnswer = null;
  for (let step = 0; step < maxSteps && !finalAnswer; step++) {
    const convo = [
      { role: "system", content: tools + (sys ? "\nCONTEXT:\n" + sys.slice(0, 1200) : "") },
      { role: "user", content: "REQUEST: " + q +
        (sources.length ? "\n\nSOURCES FOUND:\n" + sources.map((s, i) => "[" + (i + 1) + "] " + s.title + " — " + s.url).join("\n") : "") +
        (transcript.length ? "\n\nWORK SO FAR:\n" + transcript.join("\n").slice(-4000) : "") }
 ];
    let raw = await llm1(convo, 500, req);
    if (!raw) { send({ step: { icon: "⚠️", label: "brain busy — every key is cooling, retry shortly" } }); finish(); return; }
    const j = extractJson(raw);
    if (!j || !j.tool) {
      /* model spoke prose instead of JSON → treat it as the answer */
      finalAnswer = raw; break;
    }
    send({ step: { icon: "🧠", label: j.thought || "thinking…" } });
    if (j.tool === "answer") { finalAnswer = String(j.input || ""); break; }
    if (j.tool === "search") {
      send({ step: { icon: "🔍", label: "searching the web: “" + String(j.input || "").slice(0, 60) + "”" } });
      const rs = await toolSearch(String(j.input || q));
      let added = 0;
      for (const s of rs) {
        if (sources.length >= 8) break;
        if (!sources.some(x => x.url === s.url)) { sources.push(s); added++; }
      }
      send({ step: { icon: added ? "📰" : "🌑", label: added ? added + " fresh sources found" : "search came back empty — trying a different angle" } });
      transcript.push("search(" + j.input + ") → " + (rs.length ? rs.map(s => "[" + (sources.indexOf(s) + 1) + "] " + s.title).join(", ") : "no results"));
    } else if (j.tool === "fetch") {
      const u = String(j.input || "");
      send({ step: { icon: "📄", label: "reading a source in full…" } });
      const pg = await toolFetch(u);
      if (pg) transcript.push("fetch(" + u + ") → " + pg.slice(0, 900));
      else transcript.push("fetch(" + u + ") → failed");
      send({ step: { icon: pg ? "✅" : "🌑", label: pg ? "page read — key facts extracted" : "page unreadable — moving on" } });
    } else if (j.tool === "calc") {
      const val = toolCalc(String(j.input || "0"));
      send({ step: { icon: "🧮", label: j.input + " = " + val } });
      transcript.push("calc(" + j.input + ") = " + val);
    } else { transcript.push("unknown tool — skipping"); }
  }
  if (!finalAnswer) {
    /* step budget spent → force the synthesis */
    send({ step: { icon: "✍️", label: "synthesizing everything found into the answer…" } });
    const convo2 = [
      { role: "system", content: "You are AURA — Sourabh Singh's holographic AI assistant. Write the final user-facing answer to the REQUEST directly, in the user's language, clear and human. Use WORK SO FAR only where it truly answers the request; ignore unrelated search hits. If the request is about you or your abilities, answer from your identity and capabilities. Cite [1],[2] only when you actually use that source. No preamble." },
      { role: "user", content: "REQUEST: " + q + "\n\nSOURCES:\n" + sources.map((s, i) => "[" + (i + 1) + "] " + s.title + " — " + s.url).join("\n") + "\n\nWORK SO FAR:\n" + transcript.join("\n").slice(-4500) }
    ];
    finalAnswer = await llm1(convo2, 1400, req) || "I gathered the pieces but ran out of steps before I could finish — ask me again and I'll get there.";
  }
  finalAnswer = String(finalAnswer).trim();
  if (sources.length) {
    const used = finalAnswer.match(/\[(\d+)\]/g);
    const cited = (used ? [...new Set(used.map(s => +s.replace(/\D/g, "")))] : sources.map((_, i) => i + 1)).filter(n => n >= 1 && n <= sources.length);
    finalAnswer += "\n\nSOURCES:\n" + cited.map(n => "[" + n + "] " + sources[n - 1].title + " — " + sources[n - 1].url).join("\n");
  }
  send({ delta: finalAnswer });
  finish();
});

/* ============ REAL-TIME STREAMING (SSE) — token-by-token to the browser ============
   Same key bank + model rotation as the completions route, but stream:true upstream.
   Emits:  data: {"model":...}  →  data: {"delta":"..."}  →  data: [DONE]
   If every key is drained: data: {"outOfTokens":true} before [DONE]. */
app.post("/v1/chat/stream", async (req, res) => {
  const body = req.body || {};
  let messages = body.messages;
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: "messages[] required" });
  }
  /* same grounding as /v1/chat/completions: today’s date + live web results + fact rules.
     Without this the stream lane answered tournaments/schedules from frozen memory. */
  messages = await groundChat(messages);
  /* resolve a continuation ("teams in it") against the previous turn — the stream lane
     is what the app actually uses, so the topic guard must live here too */
  messages = withProductFacts(injectFollowUp(messages));
  /* ESPORTS QUESTIONS ARE BUFFERED, NOT STREAMED (27 Oct 2026): a wrong team name
     cannot be un-sent once it is on screen. Tournaments are rare, so holding this
     one class of answer for a single validated delta costs nothing and guarantees
     the roster the user reads is the one Liquipedia published. */
  const __q = lastUserMsg(messages);
  /* follow-ups ("teams name in it") carry no topic of their own — the merged query is
     what keeps the event context, so the buffer decision must not look at __q alone */
  const __merged = followUpQuery(messages, __q);
  const __buffer = !!(LIQUI && (LIQUI.isEsportsQuery(__q) || LIQUI.isEsportsQuery(__merged)));
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  const send = obj => { try { res.write("data: " + JSON.stringify(obj) + "\n\n"); } catch (e) {} };
  const finish = () => { try { res.write("data: [DONE]\n\n"); res.end(); } catch (e) {} };
  /* roster-exact answers never touch a model (see esportsFastAnswer) */
  const __fast = esportsFastAnswer(messages, __merged, __q);
  if (__fast) { send({ model: "live esports data" }); send({ delta: __fast }); finish(); return; }
  const makerHere = req.__role === "maker" || req.__role === "ceo";
  const requestedModel = makerHere ? (body.model || MODELS[0]).trim() : "";
  const modelList = makerHere ? MODELS : PUBLIC_MODELS;
  let order = makerHere ? [requestedModel, ...MODELS.filter(m => m !== requestedModel)] : PUBLIC_MODELS.slice();
  try {
    const avail = await groqModels();
    if (avail.length) {
      const pref = order.filter(m => avail.indexOf(m) >= 0);
      const rest = avail.filter(m => pref.indexOf(m) < 0).slice(0, 2);
      order = [...new Set([...pref, ...rest])];
    }
  } catch (e) { /* discovery is best-effort */ }

  /* VISION over stream: image messages resolve via Gemini, delivered as one delta */
  if (msgHasImage(messages)) {
    const vt = await visionCall(messages, Math.min(body.max_tokens || 900, 4000), body.temperature, req);
    if (vt) { send({ model: "vision brain" }); send({ delta: vt }); finish(); return; }
    if (!GEMINI_API_KEY) { send({ error: "My image brain needs its key — the owner can enable it privately in the hosting dashboard. Text answers are unaffected." }); finish(); return; }
    send({ error: "The vision model could not read that image — try a clearer photo." }); finish(); return;
  }

  let sawLimit = false, served = false, lastChatErr = "";
  const pushErr = s => { lastChatErr = (lastChatErr ? lastChatErr + " | " : "") + s; if (lastChatErr.length > 420) lastChatErr = "…" + lastChatErr.slice(-410); };
  if (body.lane === "code") {
    /* CODE LANE over stream — Mistral/Codestral first, shared bank on any miss */
    const __lr = await streamLane({ laneName: "code", apiKey: CODE_KEY, mistralModels: MISTRAL_CODE_MODELS, messages, maxTok: Math.min(body.max_tokens || 4000, 8000), temperature: body.temperature, send, isClosed: () => false, req });
    if (__lr === "served" || __lr === "partial") { if (__lr === "partial") send({ partial: true }); finish(); return; }
  }
  outer:
  for (const model of order) {
    for (let attempt = 0; attempt < Math.max(1, KEY_POOL.length); attempt++) {
      const key = pickKey();
      if (!key) { sawLimit = true; break outer; }
      try {
        /* reasoning models (gpt-oss) spend tokens thinking — same floor as the non-stream
           route, otherwise a small budget returns HTTP 200 with ZERO content chunks */
        let maxTok = Math.min(body.max_tokens || 1600, 4000);
        if (model.startsWith("openai/gpt-oss") && maxTok < 600) maxTok = 600;
        const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages,
            max_tokens: maxTok,
            temperature: body.temperature != null ? body.temperature : 0.6,
            stream: true
          }),
          signal: AbortSignal.timeout(120_000)
        });
        if (r.status === 429) { keyCool.set(key, Date.now() + 70_000); sawLimit = true; pushErr(model + " 429"); continue; }
        if (r.status === 401 || r.status === 403) { keyCool.set(key, Date.now() + 24 * 3600_000); sawLimit = true; pushErr("key " + r.status); continue; }
        if (r.status === 404 || r.status === 400) {
          let em = ""; try { const eb = await r.json(); em = (eb && eb.error && eb.error.message) || ""; } catch (e) {}
          pushErr(model + " " + r.status + (em ? ": " + String(em).slice(0, 110) : ""));
          break; /* retired/invalid model → next model */
        }
        if (!r.ok || !r.body) { pushErr(model + " HTTP " + r.status); break; }
        send({ model });
        served = true;
        let full = ""; /* accumulated for the answer cache */
        const dec = new TextDecoder();
        let buf = "", closed = false;
        req.on("close", () => { closed = true; });
        const reader = r.body.getReader();
        while (!closed) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n"); buf = lines.pop() || "";
          for (const ln of lines) {
            const s = ln.replace(/^data:\s*/, "").trim();
            if (!s) continue;
            if (s === "[DONE]") {
              if (full.trim()) {
                const safe = await rosterGuard(full, messages);
                if (__buffer || safe !== full) send({ delta: safe });
                if (!makerHere) { cachePut(messages, safe, model); countAnswer(req); }
              }
              finish(); return;
            }
            try {
              const j = JSON.parse(s);
              const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
              if (delta) { full += delta; if (!__buffer) send({ delta }); }
            } catch (e) {}
          }
        }
        if (full.trim()) {
          const safe = await rosterGuard(full, messages);
          if (__buffer || safe !== full) send({ delta: safe });
          if (!makerHere) { cachePut(messages, safe, model); countAnswer(req); }
        }
        finish();
        return;
      } catch (e) { /* network hiccup → try next key */ }
    }
  }
  if (!served) {
    /* the maker's NIM lane answers even when nothing looked rate-limited: a retired
       Groq model id returns 400/404, which the old gate read as "not a limit" and
       skipped the only lane still working (28 Oct 2026 — public chat was 502 while
       the squad's NIM calls on this same host returned 200) */
    const NIM_KEY = process.env.NVIDIA_NIM_KEY || "";
    if (NIM_KEY) {
      for (const nimModel of ["nvidia/nemotron-3-ultra-550b-a55b", "nvidia/nemotron-3-super-120b-a12b", "nvidia/nemotron-3.5-lightning-30b-a3b"]) {
        try {
          const nr = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
            method: "POST",
            headers: { "Authorization": "Bearer " + NIM_KEY, "Content-Type": "application/json" },
            body: JSON.stringify({ model: nimModel, messages, max_tokens: Math.min(body.max_tokens || 1600, 4000), temperature: body.temperature != null ? body.temperature : 0.6 }),
            signal: AbortSignal.timeout(120_000)
          });
          if (!nr.ok) continue;
          const nd = await nr.json();
          const nt = nd.choices && nd.choices[0] && nd.choices[0].message && nd.choices[0].message.content;
          if (nt && nt.trim()) {
            const safe = await rosterGuard(nt, messages);
            send({ model: nimModel + " (nvidia-nim)" });
            send({ delta: safe });
            if (!makerHere) { cachePut(messages, safe, nimModel); countAnswer(req); }
            finish(); return;
          }
        } catch (e) { /* next NIM model */ }
      }
    }
    if (sawLimit) {
      const mt = await reserveCall(messages, Math.min(body.max_tokens || 1600, 4000), body.temperature);
      if (mt) { send({ model: RESERVE_MODEL + " (reserve)" }); send({ delta: await rosterGuard(mt, messages) }); finish(); return; }
      send({ outOfTokens: true });
    }
    else { chatLast.at = Date.now(); chatLast.err = lastChatErr || ""; send({ error: "All models exhausted or rate-limited. Try again shortly." + (lastChatErr ? " (" + lastChatErr + ")" : "") }); }
  }
  finish();
});

/* ============ NEURAL VOICE — premium multilingual speech (owner demanded ChatGPT/Google-class voice) ============
   POST /v1/tts { input, voice, lang: "hi"|"en" } → audio.
   Tier 1: ElevenLabs eleven_multilingual_v2 — lifelike, Hindi + English, auto-detects language
           from the text; needs ELEVENLABS_API_KEY (free tier: 10k chars/month). Voice by persona:
           female (aurora) → Rachel, male (jarvis) → Adam — the same premade voice for both langs.
   Tier 2: Google translate neural voice — Hindi (tl=hi) or English, keyless, always available.
   Tier 3: Groq Orpheus English neural — kept as an English-only backup.
   The client plays whatever audio bytes come back, so tiering is invisible to users. */
const ELEVEN_VOICES = { female: "21m00Tcm4TlvDq8ikWAM", male: "pNInz6obpgDQGcFmaJgB" } ;
/* HYBRID VOICE ENGINE — speech-text sanitizer (client already renders clean chat text; this
   second pass strips anything the raw answer still carried: markdown, links, citations,
   emoji labels) + a small cache so repeat lines answer instantly at premium quality. */
function speechText(input) {
  return String(input || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)\]\(https?:[^)\s]+\)/gi, "$1")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, " ")
    .replace(/\[\d+\]/g, " ")
    .replace(/[#*_`>|]+/g, " ")
    .replace(/\s*[—–]\s*(?:live|लाइव)[^\n]*/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}
const ttsCache = new Map(); /* input+voice+lang → {buf, type, at} — short-lived, memory-bounded */
function ttsCacheKey(input, voice, lang) { return (String(voice) + "|" + String(lang) + "|" + String(input)).slice(0, 400); }
/* Tier 2 — Google translate neural voice — Hindi (tl=hi) or English, keyless, always available.
   Returns {buf, type} or throws. */
const ttsFallback = async (input, voice, lang) => {
  const tl = String(lang) === "hi" ? "hi" : (/atlas|gb|uk|brit/i.test(voice) ? "en-gb" : "en");
  const chunks = [];
  let rest = input;
  while (rest.length) {
    if (rest.length <= 190) { chunks.push(rest); break; }
    let cut = rest.lastIndexOf(". ", 180); if (cut < 80) cut = rest.lastIndexOf(" ", 180); if (cut < 80) cut = 180;
    chunks.push(rest.slice(0, cut + 1)); rest = rest.slice(cut + 1).replace(/^\s+/, "");
  }
  const parts = [];
  for (const c of chunks) {
    const u = "https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=" + tl + "&q=" + encodeURIComponent(c);
    const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Referer": "https://translate.google.com/" }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error("fallback HTTP " + r.status);
    parts.push(Buffer.from(await r.arrayBuffer()));
  }
  const buf = Buffer.concat(parts);
  if (!buf.length) throw new Error("fallback empty");
  return { buf: buf, type: "audio/mpeg" };
};
/* Tier 1 — ElevenLabs multilingual (premium lifelike, Hindi + English).
   Returns {buf, type} or null when no key / upstream hiccup. */
const elevenTTS = async (input, voice) => {
  const key = (process.env.ELEVENLABS_API_KEY || "").trim();
  if (!key) return null;
  const gender = /venom|adam|male|george|jarvis/i.test(voice) ? "male" : "female";
  try {
    const r = await fetch("https://api.elevenlabs.io/v1/text-to-speech/" + ELEVEN_VOICES[gender], {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ text: input, model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.2, use_speaker_boost: true } }),
      signal: AbortSignal.timeout(45_000)
    });
    if (!r.ok) { await r.text().catch(() => ""); return null; }
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) return null;
    return { buf: buf, type: "audio/mpeg" };
  } catch (e) { return null; }
};
/* Tier 3 — Groq Orpheus English neural. Returns {buf, type} or null. */
const orpheusTTS = async (input, voice) => {
  const key = pickKey();
  if (!key) return null;
  try {
    const r = await fetch("https://api.groq.com/openai/v1/audio/speech", {
      method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "canopylabs/orpheus-v1-english", voice, input }),
      signal: AbortSignal.timeout(60_000)
    });
    if (!r.ok) { await r.text().catch(() => ""); if (r.status === 429) keyCool.set(key, Date.now() + 70_000); return null; }
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) return null;
    return { buf: buf, type: "audio/wav" };
  } catch (e) { return null; }
};
app.post("/v1/tts", async (req, res) => {
  const body = req.body || {};
  let input = speechText(String(body.input || "")).slice(0, 900);
  const voice = String(body.voice || "hilda").trim().slice(0, 40);
  const lang = String(body.lang || "en").trim().slice(0, 6);
  if (!input) return res.status(400).json({ error: "input required" });
  const ck = ttsCacheKey(input, voice, lang);
  const hit = ttsCache.get(ck);
  if (hit && (Date.now() - hit.at) < 30 * 60_000) {
    res.setHeader("Content-Type", hit.type);
    res.setHeader("Cache-Control", "no-store");
    return res.send(hit.buf);
  }
  let out = null;
  /* Tier 1 — premium multilingual (when the owner's ElevenLabs key is configured) */
  try { out = await elevenTTS(input, voice); } catch (e) { out = null; }
  /* Tier 2 — Hindi: straight to the Google neural voice (best free Hindi);
     English: Groq Orpheus first, then the Google voice. */
  if (!out && lang === "hi") { try { out = await ttsFallback(input, voice, lang); } catch (e) { out = null; } }
  if (!out) { try { out = await orpheusTTS(input, voice); } catch (e) { out = null; } }
  if (!out) { try { out = await ttsFallback(input, voice, lang); } catch (e) { out = null; } }
  if (!out) return res.status(502).json({ error: "tts unavailable" });
  ttsCache.set(ck, { buf: out.buf, type: out.type, at: Date.now() });
  if (ttsCache.size > 120) { const k0 = ttsCache.keys().next().value; ttsCache.delete(k0); }
  res.setHeader("Content-Type", out.type);
  res.setHeader("Cache-Control", "no-store");
  return res.send(out.buf);
});

/* The listener starts only when this file is RUN (`node server.js`). Requiring it
   from the test scripts returns the evidence pipeline below instead of opening a
   port — that is how the BMIC roster/date path is regression-tested for real. */
if (IS_MAIN) {
  /* the port was bound by the bootstrap responder at the top of this file —
     hand that same socket to the finished Express app now */
  bootStage("express");
  const srv = bootSrv;
  srv.removeAllListeners("request");
  srv.on("request", app);
  console.log("AURA secure backend live on :" + PORT + " · build " + BUILD + " · rss " + Math.round(process.memoryUsage().rss / 1048576) + "MB");
  bootStage("ready");
  /* KRATOS AUTOPILOT — the squad's own clock. The daily cycle budget inside the
     engine decides whether a tick actually works, so this timer is cheap. */
  if (process.env.SQUAD_AUTOPILOT !== "0") {
    /* a throwing boot must never take the API down with it */
    let t = null; try { t = autopilot.boot(); } catch (e) { noteCrash("autopilot-boot", e); }
    squadClock.running = !!t;
    console.log("[squad autopilot] armed — tick every " + (autopilotLib.DEFAULTS.tickMinutes) + " min, " + autopilotLib.DEFAULTS.maxCyclesPerDay + " cycle(s)/day, auto-ship " + (autopilotLib.DEFAULTS.autoShip ? "ON" : "OFF") + (t ? "" : " (timer not started — cadence too short)"));
    /* a fresh deploy starts work immediately instead of waiting a full tick —
       the engine's own daily budget decides whether anything real happens */
    /* THE BOOT CYCLE WAITS (27 Oct 2026): Render judged a deploy dead with
       "Application exited early" and the only synchronous-ish heavy work in that
       window was this cycle (1 MB source read + every inline script re-parsed + the
       ship gates) landing 20s after boot — exactly while the platform's first health
       probe is deciding whether the instance lives. The cycle now starts at 75s,
       after the deploy verdict is in. Nothing else changed: same work, later clock. */
    setTimeout(() => { autopilot.tick({ trigger: "boot" }).catch(e => console.log("[squad autopilot] boot cycle failed: " + (e.message || e))); }, 75000);
  } else console.log("[squad autopilot] disabled (SQUAD_AUTOPILOT=0)");
}

module.exports = {
  app,
  groundChat, toolSearch, toolFetch, searchQuery, currentAsk, topicHint, followUpQuery, threadTurns,
  evidenceFacts, esportsFastAnswer, rosterGuard, cleanRead, isRosterAsk, fakeRoster,
  prettyDate, lastUserMsg, resolveFragment, injectFollowUp,
};

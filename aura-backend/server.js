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
const app = express();
/* Behind Render's load balancer every socket looks like the same internal IP.
   Trusting the ONE proxy hop gives us the REAL visitor IP (rightmost entry —
   spoof-proof, so caps can't be dodged with fake X-Forwarded-For headers).
   Without this, all guests shared ONE rate-limit and ONE daily-cap bucket
   (the "daily limit vanished" bug). */
app.set("trust proxy", 1);

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
const SECRET = process.env.SECRET || "";        // optional shared secret
const REQUIRE_SECRET = process.env.REQUIRE_SECRET === "1";
const GEMINI_API_KEY = envv("AI_KEY_VISION", "GEMINI_API_KEY");            // gives AURA EYES (vision)
const VISION_MODEL = process.env.VISION_MODEL || atob("Z2VtaW5pLTMuNi1mbGFzaA==");

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

/* Image questions route to the vision brain when a vision key is configured.
   No vision key → an honest 501 — never a text model pretending it saw the photo. */
function msgHasImage(messages) {
  return messages.some(m => Array.isArray(m.content) && m.content.some(p => p && p.type === "image_url"));
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
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + VISION_MODEL + ":generateContent?key=" + encodeURIComponent(GEMINI_API_KEY), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(Object.assign(
      { contents, generationConfig: { maxOutputTokens: maxTok, temperature: temperature != null ? temperature : 0.6 } },
      sys ? { systemInstruction: { parts: [{ text: sys }] } } : {}
    )),
    signal: AbortSignal.timeout(60_000)
  });
  if (!r.ok) return null;
  const d = await r.json();
  const t = (d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts || []).map(p => p.text || "").join("").trim();
  if (t) recordUse(req, "vision", 0);
  return t || null;
}
const PORT = parseInt(process.env.PORT, 10) || 3000;
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
const PUBLIC_MODELS = (process.env.PUBLIC_MODELS || "openai/gpt-oss-20b,qwen/qwen3.8-27b,meta-llama/llama-4-scout-17b-16e-instruct,openai/gpt-oss-120b").split(",").map(s => s.trim()).filter(Boolean);
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
function cacheGet(messages) {
  const k = normQ(messages); if (!k) return null;
  const hit = answerCache.get(k);
  if (hit && Date.now() - hit.t < ANSWER_CACHE_TTL) return hit;
  if (hit) answerCache.delete(k);
  return null;
}
function cachePut(messages, answer, model) {
  const k = normQ(messages); if (!k || !answer) return;
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
const ALLOW_ORIGINS = (process.env.ALLOW_ORIGINS || "https://sourabh7300.github.io").split(",").map(s => s.trim());
const OWNER_SECRET = process.env.SECRET || "";
app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  const okOrigin = ALLOW_ORIGINS.includes(origin) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (req.path === "/health" || req.path === "/") {
    /* public paths still need CORS headers or browsers block the boot ping */
    if (okOrigin) { res.setHeader("Access-Control-Allow-Origin", origin); res.setHeader("Vary", "Origin"); }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-AURA-Key, Authorization");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    return next();
  }
  const okSecret = OWNER_SECRET && req.headers["x-aura-key"] === OWNER_SECRET;
  if (!okOrigin && !okSecret && process.env.OPEN_GATE !== "1") {
    return res.status(403).json({ error: "forbidden", message: "This AURA backend serves its own sites only." });
  }
  if (okOrigin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-AURA-Key, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* simple per-IP rate limit: 30 req / min (configurable) — signed-in users get
   their own generous bucket keyed by uid instead of their shared IP */
const hits = new Map();
app.use((req, res, next) => {
  const now = Date.now();
  const k = req.__uid || req.ip || "anon";
  const limit = req.__uid ? parseInt(process.env.USER_RATE_LIMIT || "60", 10) : parseInt(process.env.RATE_LIMIT || "30", 10);
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
let fbAdmin = null, fbAuth = null, fbDb = null, fbTried = false;
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
    try { fbDb = fbAdmin.firestore(); } catch (e) { fbDb = null; }
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
    res.json({ ok: true, commit: (pj.commit && pj.commit.sha || "").slice(0, 7), edits: applied.length, url: pj.content && pj.content.html_url, liveIn: "~60 seconds (GitHub Pages rebuild)" });
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

/* optional shared-secret gate */
app.use((req, res, next) => {
  if (!REQUIRE_SECRET) return next();
  if (req.headers["x-aura-key"] !== SECRET) {
    return res.status(401).json({ error: "Missing or wrong X-AURA-Key." });
  }
  next();
});

/* health + root */
app.get("/", (req, res) => res.json({ ok: true, service: "aura-secure-backend", time: new Date().toISOString() }));
app.get("/health", async (req, res) => {
  const now = Date.now();
  fbInit(); /* eager init so the diagnostic tells the truth immediately */
  const fbState = fbTried ? (fbAdmin ? "online" : (FB_PROJECT ? "package-missing" : "not-configured")) : "pending";
  res.json({ ok: true, uptime: process.uptime(), keysTotal: KEY_POOL.length, publicKeys: PUBLIC_KEYS.length, makerReserved: KEY_POOL.length > 1, keysLive: KEY_POOL.filter(k => !(keyCool.get(k) > now)).length, reserve: !!RESERVE_KEY, codeLane: !!CODE_KEY, adminLane: !!ADMIN_KEY, vision: !!GEMINI_API_KEY, stream: true, accounts: fbState, github: GH_TOKEN ? "configured" : "missing", githubCheck: await ghCheck() });
});

/* THE PROXY — key stays server-side forever */
app.post("/v1/chat/completions", async (req, res) => {
  const body = req.body || {};
  const messages = body.messages;
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: "messages[] required" });
  }
  const makerHere = req.__role === "maker" || req.__role === "ceo";
  /* makers choose any model (flagship first); public requests are served the lighter
     tier regardless of what the browser asks for — that's the quota saver */
  const requestedModel = makerHere ? (body.model || MODELS[0]).trim() : "";
  const modelList = makerHere ? MODELS : PUBLIC_MODELS;
  const order = makerHere ? [requestedModel, ...MODELS.filter(m => m !== requestedModel)] : PUBLIC_MODELS.slice();

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

  let sawLimit = false; // at least one key hit a rate/limit error
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
      if (r.status === 429) { keyCool.set(key, Date.now() + 70_000); sawLimit = true; continue; }
      if (r.status === 401 || r.status === 403) { keyCool.set(key, Date.now() + 24 * 3600_000); sawLimit = true; continue; } // dead key → reserve will cover
      if (r.status === 404 || r.status === 400) continue;                            // retired/invalid model → next model
      if (!r.ok) return res.status(r.status).json({ error: "Upstream HTTP " + r.status });
      const d = await r.json();
      const t = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
      if (t && t.trim()) { recordUse(req, key, (d.usage && d.usage.total_tokens) || Math.round(t.length / 4), model); if (!makerHere) { cachePut(messages, t.trim(), model); countAnswer(req); } return res.json({ choices: [{ message: { content: t.trim() } }], model }); }
    } catch (e) { /* network hiccup → try next model */ }
  }
  if (sawLimit) {
    /* the key bank is drained — try the reserve brain before giving up */
    const mt = await reserveCall(messages, Math.min(body.max_tokens || 1400, 4000), body.temperature, req);
    if (mt) return res.json({ choices: [{ message: { content: mt } }], model: RESERVE_MODEL + " (reserve)" });
    /* nothing left — AURA turns this into a friendly notice */
    return res.status(429).json({ error: "out_of_tokens", outOfTokens: true,
      message: "Today's free AI allowance is used up. Full power returns tomorrow — meanwhile the offline core still answers." });
  }
  res.status(502).json({ error: "All models exhausted or rate-limited. Try again shortly." });
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
async function toolSearch(q) {
  /* live web search via r.jina.ai Google News + DuckDuckGo lite (both CORS-free server-side) */
  const out = [];
  try {
    const r = await fetch("https://r.jina.ai/https://news.google.com/search?q=" + encodeURIComponent(q), { signal: AbortSignal.timeout(15_000) });
    if (r.ok) {
      const t = await r.text();
      const re = /\[([^\]\n]{12,120})\]\((https?:\/\/[^)\s]+)\)/g; let m, n = 0;
      while ((m = re.exec(t)) && out.length < 5) {
        const title = m[1].replace(/\s+-\s+[^-]+$/, "").trim();
        if (/google|news\.google|signin|privacy|terms/i.test(title)) continue;
        out.push({ title, url: m[2] }); if (++n >= 5) break;
      }
    }
  } catch (e) {}
  if (out.length < 3) {
    try {
      const r2 = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q), { signal: AbortSignal.timeout(15_000) });
      if (r2.ok) {
        const t2 = await r2.text();
        const re2 = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g; let m2;
        while ((m2 = re2.exec(t2)) && out.length < 6) {
          let u = m2[1]; const du = u.match(/uddg=([^&]+)/); if (du) u = decodeURIComponent(du[1]);
          out.push({ title: m2[2].replace(/<[^>]+>/g, "").trim(), url: u });
        }
      }
    } catch (e) {}
  }
  return out;
}
async function toolFetch(url) {
  try {
    const r = await fetch("https://r.jina.ai/" + url, { signal: AbortSignal.timeout(20_000) });
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
    'You are AURA\'s AGENT CORE. Solve the user\'s request by using tools, step by step.\n' +
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
      { role: "system", content: "You are AURA. Write the final user-facing answer to the REQUEST using the WORK SO FAR. Clear, direct, human. Cite sources as [1],[2] where used. No preamble." },
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
  const messages = body.messages;
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: "messages[] required" });
  }
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  const send = obj => { try { res.write("data: " + JSON.stringify(obj) + "\n\n"); } catch (e) {} };
  const finish = () => { try { res.write("data: [DONE]\n\n"); res.end(); } catch (e) {} };
  const makerHere = req.__role === "maker" || req.__role === "ceo";
  const requestedModel = makerHere ? (body.model || MODELS[0]).trim() : "";
  const modelList = makerHere ? MODELS : PUBLIC_MODELS;
  const order = makerHere ? [requestedModel, ...MODELS.filter(m => m !== requestedModel)] : PUBLIC_MODELS.slice();

  /* VISION over stream: image messages resolve via Gemini, delivered as one delta */
  if (msgHasImage(messages)) {
    const vt = await visionCall(messages, Math.min(body.max_tokens || 900, 4000), body.temperature, req);
    if (vt) { send({ model: "vision brain" }); send({ delta: vt }); finish(); return; }
    if (!GEMINI_API_KEY) { send({ error: "My image brain needs its key — the owner can enable it privately in the hosting dashboard. Text answers are unaffected." }); finish(); return; }
    send({ error: "The vision model could not read that image — try a clearer photo." }); finish(); return;
  }

  let sawLimit = false, served = false;
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
        const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages,
            max_tokens: Math.min(body.max_tokens || 1600, 4000),
            temperature: body.temperature != null ? body.temperature : 0.6,
            stream: true
          }),
          signal: AbortSignal.timeout(120_000)
        });
        if (r.status === 429) { keyCool.set(key, Date.now() + 70_000); sawLimit = true; continue; }
        if (r.status === 401 || r.status === 403) { keyCool.set(key, Date.now() + 24 * 3600_000); sawLimit = true; continue; }
        if (r.status === 404 || r.status === 400) break; /* retired/invalid model → next model */
        if (!r.ok || !r.body) break;
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
            if (s === "[DONE]") { if (!makerHere && full.trim()) { cachePut(messages, full.trim(), model); countAnswer(req); } finish(); return; }
            try {
              const j = JSON.parse(s);
              const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
              if (delta) { full += delta; send({ delta }); }
            } catch (e) {}
          }
        }
        if (!makerHere && full.trim()) { cachePut(messages, full.trim(), model); countAnswer(req); }
        finish();
        return;
      } catch (e) { /* network hiccup → try next key */ }
    }
  }
  if (!served) {
    if (sawLimit) {
      const mt = await reserveCall(messages, Math.min(body.max_tokens || 1600, 4000), body.temperature);
      if (mt) { send({ model: RESERVE_MODEL + " (reserve)" }); send({ delta: mt }); finish(); return; }
      send({ outOfTokens: true });
    }
    else send({ error: "All models exhausted or rate-limited. Try again shortly." });
  }
  finish();
});

/* ============ NEURAL VOICE — server-rendered speech (Orpheus) ============
   POST /v1/tts { input, voice } → audio. Tier 1: premium neural voice (needs a
   one-time terms acceptance by the org admin in the AI console). Tier 2: free
   server-rendered neural voice — no key needed, works immediately. The client
   plays whatever audio bytes come back, so this is invisible to users. */
const ttsFallback = async (input, voice, res) => {
  /* server-side neural voice: chunk text ≤190 chars, fetch MP3 parts, join them */
  const lang = /atlas|gb|uk|brit/i.test(voice) ? "en-gb" : "en";
  const chunks = [];
  let rest = input;
  while (rest.length) {
    if (rest.length <= 190) { chunks.push(rest); break; }
    let cut = rest.lastIndexOf(". ", 180); if (cut < 80) cut = rest.lastIndexOf(" ", 180); if (cut < 80) cut = 180;
    chunks.push(rest.slice(0, cut + 1)); rest = rest.slice(cut + 1).replace(/^\s+/, "");
  }
  try {
    const parts = [];
    for (const c of chunks) {
      const u = "https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=" + lang + "&q=" + encodeURIComponent(c);
      const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Referer": "https://translate.google.com/" }, signal: AbortSignal.timeout(20_000) });
      if (!r.ok) throw new Error("fallback HTTP " + r.status);
      parts.push(Buffer.from(await r.arrayBuffer()));
    }
    const buf = Buffer.concat(parts);
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    return res.send(buf);
  } catch (e) { return res.status(502).json({ error: "tts unavailable" }); }
};
app.post("/v1/tts", async (req, res) => {
  const body = req.body || {};
  const input = String(body.input || "").trim().slice(0, 900);
  const voice = String(body.voice || "hilda").trim().slice(0, 40);
  if (!input) return res.status(400).json({ error: "input required" });
  const key = pickKey();
  if (key) {
    try {
      const r = await fetch("https://api.groq.com/openai/v1/audio/speech", {
        method: "POST",
        headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "canopylabs/orpheus-v1-english", voice, input }),
        signal: AbortSignal.timeout(60_000)
      });
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        res.setHeader("Content-Type", "audio/wav");
        res.setHeader("Cache-Control", "no-store");
        return res.send(buf);
      }
      const t = await r.text().catch(() => "");
      if (r.status === 429) keyCool.set(key, Date.now() + 70_000);
      /* terms not accepted / rate-limited / hiccup → free neural fallback below */
    } catch (e) { /* fall through to fallback */ }
  }
  return ttsFallback(input, voice, res);
});

app.listen(PORT, () => console.log("AURA secure backend live on :" + PORT));

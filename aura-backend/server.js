/* ============================================================
   AURA SECURE BACKEND — AI key proxy (deploy on Render)
   The Groq key lives ONLY here, in the GROQ_API_KEY env var.
   Browsers never see it. Rate-limited + CORS-open for the portfolio.
   Contract: POST /v1/chat/completions  (OpenAI-compatible)
             GET  /health              → uptime monitor pings this
   Optional: set REQUIRE_SECRET=1 + SECRET=<token> to demand X-AURA-Key
   ============================================================ */
require("dotenv").config();
const express = require("express");
const app = express();

const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
/* KEY BANK — comma-separated keys rotate automatically:
   primary first; a key that hits its daily/minute limit cools down and the
   next one takes over transparently. All keys stay server-side. */
const KEY_POOL = [...new Set([
  GROQ_API_KEY,
  ...(process.env.GROQ_API_KEYS || "").split(",").map(s => s.trim())
].filter(Boolean))];
const SECRET = process.env.SECRET || "";        // optional shared secret
const REQUIRE_SECRET = process.env.REQUIRE_SECRET === "1";
const PORT = parseInt(process.env.PORT, 10) || 3000;
const MODELS = (process.env.MODELS || "openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b").split(",").map(s => s.trim()).filter(Boolean);

if (!KEY_POOL.length) {
  /* never crash the deploy — boot in degraded mode so Render stays green;
     /health and /v1/chat/completions report the missing key clearly */
  console.warn("WARNING: no GROQ_API_KEY set. Add it in Render → Environment, then redeploy.");
}
/* per-key cooldowns after 429 (10 min) — a cooled key re-enters the pool later */
const keyCool = new Map();
function pickKey() {
  const now = Date.now();
  for (const k of KEY_POOL) if (!(keyCool.get(k) > now)) return k;
  return null; // every key is cooling = daily allowance exhausted
}

app.use(express.json({ limit: "2mb" }));

/* CORS — the portfolio origin (and localhost for dev) */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-AURA-Key, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* simple per-IP rate limit: 30 req / min (configurable) */
const hits = new Map();
app.use((req, res, next) => {
  const now = Date.now();
  const k = req.ip || "anon";
  const rec = hits.get(k) || { n: 0, win: now };
  if (now - rec.win > 60_000) { rec.n = 0; rec.win = now; }
  rec.n++;
  hits.set(k, rec);
  if (rec.n > (parseInt(process.env.RATE_LIMIT || "30", 10))) {
    return res.status(429).json({ error: "Slow down — try again in a minute." });
  }
  next();
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
app.get("/health", (req, res) => {
  const now = Date.now();
  res.json({ ok: true, uptime: process.uptime(), keysTotal: KEY_POOL.length, keysLive: KEY_POOL.filter(k => !(keyCool.get(k) > now)).length });
});

/* THE PROXY — key stays server-side forever */
app.post("/v1/chat/completions", async (req, res) => {
  const body = req.body || {};
  const messages = body.messages;
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: "messages[] required" });
  }
  const requestedModel = (body.model || MODELS[0]).trim();
  const order = [requestedModel, ...MODELS.filter(m => m !== requestedModel)];

  let sawLimit = false; // at least one key hit a rate/limit error
  for (const model of order) {
    try {
      /* reasoning models (gpt-oss) spend tokens thinking — floor the budget so content is never empty */
      let maxTok = Math.min(body.max_tokens || 1400, 4000);
      if (model.startsWith("openai/gpt-oss") && maxTok < 600) maxTok = 600;
      const key = pickKey();
      if (!key) {
        if (!KEY_POOL.length) return res.status(500).json({ error: "Server has no GROQ_API_KEY — add it in Render → Environment and redeploy." });
        sawLimit = true; break;
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
      if (r.status === 429) { keyCool.set(key, Date.now() + 10 * 60_000); sawLimit = true; continue; }
      if (r.status === 401 || r.status === 403) { keyCool.set(key, Date.now() + 24 * 3600_000); continue; } // dead key → out for a day
      if (r.status === 404 || r.status === 400) continue;                            // retired/invalid model → next model
      if (!r.ok) return res.status(r.status).json({ error: "Groq HTTP " + r.status });
      const d = await r.json();
      const t = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
      if (t && t.trim()) return res.json({ choices: [{ message: { content: t.trim() } }], model });
    } catch (e) { /* network hiccup → try next model */ }
  }
  if (sawLimit) {
    /* every key is out of its allowance — AURA turns this into a friendly notice */
    return res.status(429).json({ error: "out_of_tokens", outOfTokens: true,
      message: "Today's free AI allowance is used up. Full power returns tomorrow — meanwhile the offline core still answers." });
  }
  res.status(502).json({ error: "All models exhausted or rate-limited. Try again shortly." });
});

app.listen(PORT, () => console.log("AURA secure backend live on :" + PORT));

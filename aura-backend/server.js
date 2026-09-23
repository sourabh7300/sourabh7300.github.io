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
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";            // free key from aistudio.google.com → gives AURA EYES (vision)
const GEMINI_VISION_MODEL = process.env.GEMINI_VISION_MODEL || "gemini-2.0-flash";

/* RESERVE BRAIN — Mistral. Fires only when every Groq key has drained (or died),
   so users keep getting real AI answers instead of the out-of-tokens notice.
   The free tier is burst-limited; a 429 here just sits the reserve out for a minute. */
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY || "";
const MISTRAL_RESERVE = process.env.MISTRAL_RESERVE_MODEL || "mistral-small-latest";
let mistralCool = 0;
async function mistralCall(messages, maxTok, temperature) {
  if (!MISTRAL_API_KEY || Date.now() < mistralCool) return null;
  try {
    const r = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + MISTRAL_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MISTRAL_RESERVE, messages, max_tokens: Math.min(maxTok, 4000), temperature: temperature != null ? temperature : 0.6 }),
      signal: AbortSignal.timeout(45_000)
    });
    if (r.status === 429) { mistralCool = Date.now() + 60_000; return null; }
    if (!r.ok) return null;
    const d = await r.json();
    const t = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
    return (t && t.trim()) ? t.trim() : null;
  } catch (e) { return null; }
}

/* Groq retired its vision models (llama-4-scout is gone platform-wide), so image
   questions route to Gemini's free tier. No GEMINI_API_KEY set → honest 501,
   never a text model pretending it saw the photo. */
function msgHasImage(messages) {
  return messages.some(m => Array.isArray(m.content) && m.content.some(p => p && p.type === "image_url"));
}
async function geminiVision(messages, maxTok, temperature) {
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
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_VISION_MODEL + ":generateContent?key=" + encodeURIComponent(GEMINI_API_KEY), {
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
  return t || null;
}
const PORT = parseInt(process.env.PORT, 10) || 3000;
const MODELS = (process.env.MODELS || "openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b,meta-llama/llama-4-scout-17b-16e-instruct").split(",").map(s => s.trim()).filter(Boolean);

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

app.use(express.json({ limit: "8mb" })); /* room for base64 photos (vision) */

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
  res.json({ ok: true, uptime: process.uptime(), keysTotal: KEY_POOL.length, keysLive: KEY_POOL.filter(k => !(keyCool.get(k) > now)).length, mistral: !!MISTRAL_API_KEY, vision: !!GEMINI_API_KEY, stream: true });
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

  /* VISION: messages that carry an image route to Gemini (Groq has no vision models left) */
  if (msgHasImage(messages)) {
    const vt = await geminiVision(messages, Math.min(body.max_tokens || 900, 4000), body.temperature);
    if (vt) return res.json({ choices: [{ message: { content: vt } }], model: GEMINI_VISION_MODEL + " (vision)" });
    if (!GEMINI_API_KEY) return res.status(501).json({ error: "no_vision_model", message: "My image brain needs one free key: the server owner adds GEMINI_API_KEY (from aistudio.google.com) on Render — takes 2 minutes. Text answers are unaffected." });
    return res.status(502).json({ error: "vision_failed", message: "The vision model could not read that image — try a clearer photo." });
  }

  let sawLimit = false; // at least one key hit a rate/limit error
  for (const model of order) {
    try {
      /* reasoning models (gpt-oss) spend tokens thinking — floor the budget so content is never empty */
      let maxTok = Math.min(body.max_tokens || 1400, 4000);
      if (model.startsWith("openai/gpt-oss") && maxTok < 600) maxTok = 600;
      const key = pickKey();
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
      if (r.status === 429) { keyCool.set(key, Date.now() + 10 * 60_000); sawLimit = true; continue; }
      if (r.status === 401 || r.status === 403) { keyCool.set(key, Date.now() + 24 * 3600_000); sawLimit = true; continue; } // dead key → reserve will cover
      if (r.status === 404 || r.status === 400) continue;                            // retired/invalid model → next model
      if (!r.ok) return res.status(r.status).json({ error: "Groq HTTP " + r.status });
      const d = await r.json();
      const t = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
      if (t && t.trim()) return res.json({ choices: [{ message: { content: t.trim() } }], model });
    } catch (e) { /* network hiccup → try next model */ }
  }
  if (sawLimit) {
    /* every Groq key is out of its allowance — try the Mistral reserve before giving up */
    const mt = await mistralCall(messages, Math.min(body.max_tokens || 1400, 4000), body.temperature);
    if (mt) return res.json({ choices: [{ message: { content: mt } }], model: MISTRAL_RESERVE + " (reserve)" });
    /* nothing left — AURA turns this into a friendly notice */
    return res.status(429).json({ error: "out_of_tokens", outOfTokens: true,
      message: "Today's free AI allowance is used up. Full power returns tomorrow — meanwhile the offline core still answers." });
  }
  res.status(502).json({ error: "All models exhausted or rate-limited. Try again shortly." });
});

/* ============ REAL-TIME STREAMING (SSE) — token-by-token to the browser ============
   Same key bank + model rotation as the completions route, but stream:true to Groq.
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
  const requestedModel = (body.model || MODELS[0]).trim();  const order = [requestedModel, ...MODELS.filter(m => m !== requestedModel)];

  /* VISION over stream: image messages resolve via Gemini, delivered as one delta */
  if (msgHasImage(messages)) {
    const vt = await geminiVision(messages, Math.min(body.max_tokens || 900, 4000), body.temperature);
    if (vt) { send({ model: GEMINI_VISION_MODEL }); send({ delta: vt }); finish(); return; }
    if (!GEMINI_API_KEY) { send({ error: "My image brain needs one free key: GEMINI_API_KEY (aistudio.google.com) on Render — 2 minutes. Text answers are unaffected." }); finish(); return; }
    send({ error: "The vision model could not read that image — try a clearer photo." }); finish(); return;
  }

  let sawLimit = false, served = false;
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
        if (r.status === 429) { keyCool.set(key, Date.now() + 10 * 60_000); sawLimit = true; continue; }
        if (r.status === 401 || r.status === 403) { keyCool.set(key, Date.now() + 24 * 3600_000); sawLimit = true; continue; }
        if (r.status === 404 || r.status === 400) break; /* retired/invalid model → next model */
        if (!r.ok || !r.body) break;
        send({ model });
        served = true;
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
            if (s === "[DONE]") { finish(); return; }
            try {
              const j = JSON.parse(s);
              const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
              if (delta) send({ delta });
            } catch (e) {}
          }
        }
        finish();
        return;
      } catch (e) { /* network hiccup → try next key */ }
    }
  }
  if (!served) {
    if (sawLimit) {
      const mt = await mistralCall(messages, Math.min(body.max_tokens || 1600, 4000), body.temperature);
      if (mt) { send({ model: MISTRAL_RESERVE + " (reserve)" }); send({ delta: mt }); finish(); return; }
      send({ outOfTokens: true });
    }
    else send({ error: "All models exhausted or rate-limited. Try again shortly." });
  }
  finish();
});

app.listen(PORT, () => console.log("AURA secure backend live on :" + PORT));

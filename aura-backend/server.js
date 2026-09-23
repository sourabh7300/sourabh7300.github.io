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
async function reserveCall(messages, maxTok, temperature) {
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
    return (t && t.trim()) ? t.trim() : null;
  } catch (e) { return null; }
}

/* Image questions route to the vision brain when a vision key is configured.
   No vision key → an honest 501 — never a text model pretending it saw the photo. */
function msgHasImage(messages) {
  return messages.some(m => Array.isArray(m.content) && m.content.some(p => p && p.type === "image_url"));
}
async function visionCall(messages, maxTok, temperature) {
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
function pickKey() {
  const now = Date.now();
  for (const k of KEY_POOL) if (!(keyCool.get(k) > now)) return k;
  return null; // every key is cooling = daily allowance exhausted
}

app.use(express.json({ limit: "8mb" })); /* room for base64 photos (vision) */

/* PRIVATE GATE — the backend is reachable by URL (static sites call it directly
   from the visitor's browser), but it serves ONLY its own sites: browsers identify
   themselves with the Origin header, and the owner's tools with X-AURA-Key.
   curl / scrapers / strangers get a 403. /health stays open for uptime monitors. */
const ALLOW_ORIGINS = (process.env.ALLOW_ORIGINS || "https://sourabh7300.github.io").split(",").map(s => s.trim());
const OWNER_SECRET = process.env.SECRET || "";
app.use((req, res, next) => {
  if (req.path === "/health" || req.path === "/") return next();
  const origin = req.headers.origin || "";
  const okOrigin = ALLOW_ORIGINS.includes(origin) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
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
  res.json({ ok: true, uptime: process.uptime(), keysTotal: KEY_POOL.length, keysLive: KEY_POOL.filter(k => !(keyCool.get(k) > now)).length, reserve: !!RESERVE_KEY, vision: !!GEMINI_API_KEY, stream: true });
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

  /* VISION: messages that carry an image route to the vision brain */
  if (msgHasImage(messages)) {
    const vt = await visionCall(messages, Math.min(body.max_tokens || 900, 4000), body.temperature);
    if (vt) return res.json({ choices: [{ message: { content: vt } }], model: "vision brain" });
    if (!GEMINI_API_KEY) return res.status(501).json({ error: "no_vision_model", message: "My image brain needs its key — the owner can enable it privately in the hosting dashboard. Text answers are unaffected." });
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
      if (!r.ok) return res.status(r.status).json({ error: "Upstream HTTP " + r.status });
      const d = await r.json();
      const t = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
      if (t && t.trim()) return res.json({ choices: [{ message: { content: t.trim() } }], model });
    } catch (e) { /* network hiccup → try next model */ }
  }
  if (sawLimit) {
    /* the key bank is drained — try the reserve brain before giving up */
    const mt = await reserveCall(messages, Math.min(body.max_tokens || 1400, 4000), body.temperature);
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
function llm1(messages, maxTok) {
  /* one-shot internal LLM call for the loop (uses pickKey directly) */
  return (async () => {
    for (const model of MODELS) {
      const key = pickKey();
      if (!key) return null;
      try {
        const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
          body: JSON.stringify({ model, messages, max_tokens: Math.min(maxTok || 700, 4000), temperature: 0.3 }),
          signal: AbortSignal.timeout(45_000)
        });
      if (!r.ok) { if (r.status === 429) keyCool.set(key, Date.now() + 10 * 60_000); continue; }
        const d = await r.json();
        const t = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
        if (t && t.trim()) return t.trim();
      } catch (e) {}
    }
    const mt = await reserveCall(messages, maxTok, 0.3);
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
    let raw = await llm1(convo, 500);
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
    finalAnswer = await llm1(convo2, 1400) || "I gathered the pieces but ran out of steps before I could finish — ask me again and I'll get there.";
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
  const requestedModel = (body.model || MODELS[0]).trim();  const order = [requestedModel, ...MODELS.filter(m => m !== requestedModel)];

  /* VISION over stream: image messages resolve via Gemini, delivered as one delta */
  if (msgHasImage(messages)) {
    const vt = await visionCall(messages, Math.min(body.max_tokens || 900, 4000), body.temperature);
    if (vt) { send({ model: "vision brain" }); send({ delta: vt }); finish(); return; }
    if (!GEMINI_API_KEY) { send({ error: "My image brain needs its key — the owner can enable it privately in the hosting dashboard. Text answers are unaffected." }); finish(); return; }
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
      const mt = await reserveCall(messages, Math.min(body.max_tokens || 1600, 4000), body.temperature);
      if (mt) { send({ model: RESERVE_MODEL + " (reserve)" }); send({ delta: mt }); finish(); return; }
      send({ outOfTokens: true });
    }
    else send({ error: "All models exhausted or rate-limited. Try again shortly." });
  }
  finish();
});

/* ============ NEURAL VOICE — server-rendered speech (Orpheus) ============
   POST /v1/tts { input, voice } → audio/wav. Needs a one-time terms acceptance
   of canopylabs/orpheus-v1-english by the org admin in the Groq console;
   until then returns 502 and AURA silently uses the device voice. */
app.post("/v1/tts", async (req, res) => {
  const body = req.body || {};
  const input = String(body.input || "").trim().slice(0, 900);
  const voice = String(body.voice || "hilda").trim().slice(0, 40);
  if (!input) return res.status(400).json({ error: "input required" });
  const key = pickKey();
  if (!key) return res.status(503).json({ error: "voice needs a live AI key" });
  try {
    const r = await fetch("https://api.groq.com/openai/v1/audio/speech", {
      method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "canopylabs/orpheus-v1-english", voice, input }),
      signal: AbortSignal.timeout(60_000)
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      if (r.status === 429) keyCool.set(key, Date.now() + 10 * 60_000);
      return res.status(502).json({ error: "tts unavailable", detail: t.slice(0, 140) });
    }
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Cache-Control", "no-store");
    res.send(buf);
  } catch (e) { res.status(502).json({ error: "tts failed" }); }
});

app.listen(PORT, () => console.log("AURA secure backend live on :" + PORT));

/* ============ WEBSOCKET AUDIO — full-duplex voice, no browser STT needed ============
   The old mic path leaned on the browser's SpeechRecognition: Chrome-only, sometimes
   silently unavailable, and it transcribes on Google's schedule. This endpoint takes
   raw audio instead:
     browser AudioContext (16kHz mono PCM16) → binary frames over /ws/audio
     → server buffers one utterance → Gemini transcribes it
     → the same chat brain answers → text deltas stream back as JSON
     → optional WAV of the reply (base64) so the page can speak it immediately.
   Protocol
     client → {"type":"start","lang":"hi|en","rate":16000}
     client → <binary PCM16 frames>
     client → {"type":"stop"}            (or the server auto-stops at 20s)
     server → {"type":"ready"|"partial"|"transcript"|"delta"|"audio"|"error"|"done"}
   Binary frames are capped so one tab cannot eat the instance: 20s of 16k mono is
   ~640KB, everything past it is dropped and the utterance is closed. */
const MAX_BYTES = 20 * 16_000 * 2; /* 20s @16k mono PCM16 */

function wavFromPcm(pcm, rate) {
  const r = rate || 16000;
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + pcm.length, 4); head.write("WAVE", 8);
  head.write("fmt ", 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(r, 24); head.writeUInt32LE(r * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write("data", 36); head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

async function transcribe(wav, key, lang, modelSource) {
  if (!key) throw new Error("no speech key on the server");
  /* model ids rot (2.5-flash is gone for new keys), so the live vision/model list
     from the server is tried first and the old ids are only a last resort */
  let live = [];
  try {
    const asked = typeof modelSource === "function"
      ? await Promise.race([modelSource(), new Promise(r => setTimeout(() => r([]), 4000))])
      : (modelSource || []);
    live = Array.isArray(asked) ? asked : [];
  } catch (e) { live = []; }
  /* audio input is a flash feature; a pro/thinking id would burn the whole budget */
  const models = [...new Set([...live.filter(n => /flash/i.test(String(n))), "gemini-3.8-flash", "gemini-3.6-flash", "gemini-2.5-flash", "gemini-2.0-flash"])].slice(0, 4);
  const prompt = "Transcribe this audio exactly as spoken. Reply with the transcript only — no quotes, no notes" +
    (lang === "hi" ? ", in Devanagari if the speech is Hindi (Hinglish stays Roman)." : ".");
  let lastErr = "";
  const tried = [];
  for (const model of models) {
    try {
      const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + encodeURIComponent(key), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: "audio/wav", data: wav.toString("base64") } }] }],
          /* no thinking: a transcript must be the spoken words, not a reasoning
             preamble (3.x models otherwise answer with a "thought" part first) */
          generationConfig: Object.assign({ temperature: 0, maxOutputTokens: 500 }, /^gemini-(3|2\.5)/.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {})
        }),
        signal: AbortSignal.timeout(12_000)
      });
      if (!r.ok) { lastErr = "stt " + r.status; tried.push(model + ":" + r.status); continue; }
      const j = await r.json();
      const t = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts || [])
        .filter(p => p && !p.thought)
        .map(p => p.text || "").join("").trim()
        .replace(/^thought\s*[:\-]?\s*/i, "");
      if (t) return t.replace(/^["'`]+|["'`]+$/g, "").trim();
      lastErr = "empty transcript"; tried.push(model + ":empty");
    } catch (e) { lastErr = String((e && e.message) || e); tried.push(model + ":" + lastErr.slice(0, 24)); }
  }
  throw new Error("speech failed (" + (tried.join(", ") || lastErr || "no model") + ")");
}

function attachAudioWs(server, deps) {
  const d = deps || {};
  let WebSocketServer;
  try { WebSocketServer = require("ws").WebSocketServer; } catch (e) {
    console.log("[ws] ws package missing — /ws/audio disabled");
    return null;
  }
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  const allowed = d.allowedOrigins || null;

  function originOk(req) {
    if (!allowed || !allowed.length) return true;
    const o = (req.headers.origin || "").replace(/\/$/, "");
    if (!o) return true; /* native clients / curl have no origin */
    return allowed.some(a => o === a.replace(/\/$/, "")) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(o);
  }

  server.on("upgrade", (req, socket, head) => {
    let pathname = "/";
    try { pathname = new URL(req.url, "http://x").pathname; } catch (e) {}
    if (pathname !== "/ws/audio") return; /* let anything else 404 normally */
    if (!originOk(req)) { try { socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); } catch (e) {} try { socket.destroy(); } catch (e) {} return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
  });

  wss.on("connection", ws => {
    const st = { chunks: [], bytes: 0, rate: 16000, lang: "en", running: false, alive: true, startedAt: 0, history: [] };
    const send = o => { try { if (ws.readyState === 1) ws.send(JSON.stringify(o)); } catch (e) {} };
    send({ type: "ready", sampleRate: st.rate, maxSeconds: 20 });

    const reset = () => { st.chunks = []; st.bytes = 0; st.running = false; };

    async function finish() {
      if (st.running) return;
      st.running = true;
      const pcm = Buffer.concat(st.chunks);
      reset();
      if (pcm.length < 3200) { send({ type: "error", message: "too short — hold the mic a moment longer" }); st.running = false; return; }
      const started = Date.now();
      try {
        const text = await transcribe(wavFromPcm(pcm, st.rate), d.geminiKey, st.lang, d.models);
        send({ type: "transcript", text, ms: Date.now() - started });
        if (!text) { send({ type: "done" }); st.running = false; return; }
        const answer = await d.answer(text, { lang: st.lang, signal: ws, history: st.history.slice(-6) });
        if (!answer) { send({ type: "error", message: "brain busy — try again in a moment" }); send({ type: "done" }); st.running = false; return; }
        /* spoken conversation keeps its thread: the next utterance sees this exchange */
        st.history.push({ role: "user", content: text }, { role: "assistant", content: String(answer).slice(0, 1200) });
        if (st.history.length > 8) st.history = st.history.slice(-8);
        /* stream the answer in readable slices: the page can start speaking the first
           sentence while the rest is still arriving */
        const parts = String(answer).match(/[^.!?\n]+[.!?\n]?\s*/g) || [String(answer)];
        let sent = "";
        for (const part of parts) {
          if (!st.alive) break;
          sent += part;
          send({ type: "delta", text: part });
          await new Promise(r => setTimeout(r, 35));
        }
        if (d.tts && st.alive) {
          try {
            const audio = await d.tts(sent.slice(0, 700), st.lang);
            if (audio && audio.buf) send({ type: "audio", mime: audio.type || "audio/mpeg", data: Buffer.from(audio.buf).toString("base64") });
          } catch (e) {}
        }
        send({ type: "done", totalMs: Date.now() - started });
      } catch (e) {
        send({ type: "error", message: String(e.message || e).slice(0, 180) });
        send({ type: "done" });
      } finally { st.running = false; }
    }

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        if (st.bytes + data.length > MAX_BYTES) { finish(); return; }
        st.chunks.push(Buffer.from(data)); st.bytes += data.length;
        if (!st.startedAt) st.startedAt = Date.now();
        return;
      }
      let msg = null;
      try { msg = JSON.parse(String(data)); } catch (e) { return; }
      if (!msg || !msg.type) return;
      if (msg.type === "start") {
        reset();
        st.rate = Math.min(Math.max(parseInt(msg.rate, 10) || 16000, 8000), 48000);
        st.lang = msg.lang === "hi" ? "hi" : "en";
        st.startedAt = Date.now();
        send({ type: "listening", rate: st.rate, lang: st.lang });
      } else if (msg.type === "stop") finish();
      else if (msg.type === "cancel") { reset(); send({ type: "cancelled" }); }
      else if (msg.type === "ping") send({ type: "pong" });
    });
    ws.on("close", () => { st.alive = false; reset(); });
    ws.on("error", () => { st.alive = false; });
  });

  const timer = setInterval(() => {
    wss.clients.forEach(ws => { try { if (ws.readyState === 1) ws.send(JSON.stringify({ type: "ping" })); } catch (e) {} });
  }, 25_000);
  if (timer.unref) timer.unref();

  console.log("[ws] /ws/audio armed");
  return wss;
}

module.exports = { attachAudioWs, wavFromPcm, transcribe };

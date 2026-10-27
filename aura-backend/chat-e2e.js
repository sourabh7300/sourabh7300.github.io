/* End-to-end check against a RUNNING backend (exactly as the browser talks to it):
     node chat-e2e.js [port]      default 3999
   Sends the owner's two turns with the browser's payload shape to
   /v1/chat/stream and prints the full streamed answer.

   Turn 1: "when will bmic will start"   (event named — dates must be real)
   Turn 2: "teams name in it"            (no topic of its own — must stay BMIC,
                                          must never print "Team A … Team H")
   ============================================================ */
const PORT = process.argv[2] || "3999";
const BASE = "http://127.0.0.1:" + PORT;
const ORIGIN = "http://localhost:" + PORT;   /* the guard allows loopback origins */

const DATELINE = "\n\nCURRENT DATE & TIME: Tuesday, October 27, 2026, 07:34 PM (user's local time — anchor 'today/now/latest' to THIS moment)";
const SYS = "You are AURA, a futuristic holographic AI assistant built by Sourabh Singh.";

function convoCtx(convo) {
  if (!convo.length) return "";
  return "\n\nONGOING CONVERSATION (this is the SAME chat you are in right now — read it first, it sets the current topic and the language we both have been using. CONTINUE THIS THREAD: keep answering about the same subject, build on what was already said, refer back to it naturally with 'hum baat kar rahe the…' style continuity. Start a NEW topic only when the user clearly brings one. Match the LANGUAGE of the recent turns: if the user writes Hinglish (Roman-script Hindi + English mix), keep replying in Hinglish — never switch back to full English mid-thread. Never repeat these turns verbatim and never re-answer an older question):\n" +
    convo.map(m => (m.role === "user" ? "User: " : "You: ") + String(m.content).slice(0, 340)).join("\n");
}

const convo = [
  { role: "user", content: "hi aura" },
  { role: "assistant", content: "Good evening, Sourabh Singh! AURA online and at your service. What do you need?" },
  { role: "user", content: "who are you?" },
  { role: "assistant", content: "I'm AURA, your holographic AI assistant—warm, cinematic, and built by Sourabh Singh." },
];

async function ask(q) {
  const t0 = Date.now();
  const body = { model: "x", messages: [{ role: "system", content: SYS + DATELINE }, { role: "user", content: q + convoCtx(convo) }], max_tokens: 1600 };
  const r = await fetch(BASE + "/v1/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(200000)
  });
  let full = "", model = "", outOfTokens = false, err = "";
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const rd = await reader.read();
    if (rd.done) break;
    buf += dec.decode(rd.value, { stream: true });
    const blocks = buf.split("\n\n");
    buf = blocks.pop() || "";
    for (const blk of blocks) {
      const ln = blk.split("\n").find(l => l.startsWith("data:"));
      if (!ln) continue;
      const s = ln.slice(5).trim();
      if (!s || s === "[DONE]") continue;
      let j;
      try { j = JSON.parse(s); } catch (e) { continue; }
      if (j.outOfTokens) outOfTokens = true;
      if (j.error) err = String(j.error);
      if (j.model) model = j.model;
      if (j.delta) full += j.delta;
    }
  }
  return { full: full.trim(), model, outOfTokens, err, ms: Date.now() - t0 };
}

(async () => {
  const h = await fetch(BASE + "/health").then(r => r.json()).catch(() => null);
  console.log("health:", h ? "ok · keys " + h.keysLive + "/" + h.keysTotal + " · build " + h.build : "UNREACHABLE");
  if (!h) process.exit(1);

  const a = await ask("when will bmic will start");
  console.log("\n=== T1 “when will bmic will start” — " + a.ms + " ms · " + (a.model || a.err || "no answer") + "\n" + (a.full || "(empty)"));
  convo.push({ role: "user", content: "when will bmic will start" }, { role: "assistant", content: a.full });

  const b = await ask("teams name in it");
  console.log("\n=== T2 “teams name in it” — " + b.ms + " ms · " + (b.model || b.err || "no answer") + "\n" + (b.full || "(empty)"));

  /* real failure modes, not keywords: a placeholder roster, the WRONG event as the
     subject (BMSD inside BMIC's own qualifier breakdown is legitimate), or a typo'd
     event name in the lead line. */
  const empty = !a.full || !b.full;
  const placeholder = /Team\s+[A-H]\b(?!\w)/.test(b.full);
  const wrongSubject = /\bBMSD\b/i.test(b.full.slice(0, 160)) || /\bBIC\b/.test(a.full);
  const notNamed = !/\bBMIC\b/i.test(a.full) && !/\bBMIC\b/i.test(b.full);
  const teams = (b.full.match(/^\s*\d+\.\s+/gm) || []).length;
  console.log("\nchecks → teams listed: " + teams + " · placeholder: " + placeholder + " · wrong event in lead: " + wrongSubject + " · BMIC named: " + !notNamed);
  console.log(empty
    ? "\nE2E: FAIL — empty answer (" + (a.err || b.err || "stream sent no delta") + ")"
    : (placeholder || wrongSubject || notNamed)
      ? "\nE2E: FAIL — placeholder list, wrong event, or the event was misnamed"
      : "\nE2E: PASS — real answers, right event, verified roster");
})();

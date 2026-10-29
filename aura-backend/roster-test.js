/* ============================================================
   BMIC chat regression (27 Oct 2026)

   Reproduces the OWNER'S EXACT CONVERSATION the way the browser sends it:
     system = persona + dateLine("CURRENT DATE & TIME: ...")
     user   = question + convoCtx("ONGOING CONVERSATION ...") + webBlock

   Turn 1: "when will bmic will start"   → real dates, correct event
   Turn 2: "teams name in it"            → REAL rosters, never "Team A … Team H"

   Run:  node roster-test.js      (network needed for the Liquipedia lane)
   ============================================================ */
process.env.SQUAD_AUTOPILOT = "0";
/* this script REQUIRES the server for its pipeline, it is not the server: keep the
   listener off (binding is the default now, see the PORT block in server.js) */
process.env.AURA_NO_LISTEN = "1";
const S = require("./server.js");

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

/* mirrors the backend's own stream-route call, not a hand-made shortcut: __q is the
   WHOLE flattened user blob, __merged is what keeps the event topic in it */
function fastPath(g) {
  const __q = S.lastUserMsg(g);
  const __merged = S.followUpQuery(g, __q);
  return { merged: __merged, answer: S.esportsFastAnswer(g, __merged, __q) };
}

async function turn(q) {
  const msgs = [{ role: "system", content: SYS + DATELINE }, { role: "user", content: q + convoCtx(convo) }];
  console.log("\n=== USER: " + q);
  console.log("   searchQuery → " + S.searchQuery(msgs));
  const t0 = Date.now();
  const g = await S.groundChat(msgs);
  const block = String(g[g.length - 1].content);
  const esp = /AUTHORITATIVE ESPORTS FACTS/.test(block);
  const noWeb = /No live results were found/.test(block);
  console.log("   groundChat → " + (Date.now() - t0) + " ms · " + (noWeb ? "NO RESULTS" : (esp ? "ESPORTS FACTS injected" : "web block injected")));
  const f = S.evidenceFacts(g);
  console.log("   facts → teams=" + f.list.length + " · start=" + (f.start || "-") + " · page=" + (f.page || "-"));
  if (f.list.length) console.log("   list → " + f.list.join(" | "));
  return g;
}

(async () => {
  const g1 = await turn("when will bmic will start");
  const fast1 = fastPath(g1);
  console.log("   fast-answer path → " + (fast1.answer ? "FIRED" : "not a roster ask (model answers from evidence)"));

  convo.push({ role: "user", content: "when will bmic will start" });
  convo.push({ role: "assistant", content: "BMIC 2026 kicks off on 30 October 2026 and runs to 8 November 2026 in Mumbai." });

  const g2 = await turn("teams name in it");
  const fast2 = fastPath(g2);
  console.log("   fast-answer path → " + (fast2.answer ? "FIRED (merged: " + fast2.merged.slice(0, 60) + ")" : "NOT fired"));
  if (fast2.answer) console.log("\n--- ANSWER ---\n" + fast2.answer + "\n--------------");
  else console.log("   !! roster question did not get the deterministic verified list");

  const good = fast2.answer && !/Team\s+[A-H]\b(?!\w)/.test(fast2.answer) && S.evidenceFacts(g2).list.length >= 3;
  console.log(good ? "\nRESULT: PASS — verified roster path works end to end" : "\nRESULT: FAIL — see above");
  process.exit(good ? 0 : 1);
})();

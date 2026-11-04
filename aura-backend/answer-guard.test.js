/* Answer guard tests (4 Nov 2026).
 *
 * Two live drafts that reached the site:
 *   "Mera naam Nemotron hai, aur main NVIDIA ke … भाषा मॉडल हूँ।"   (asked about a slow laptop)
 *   "Main AURA hoon. Main GPT-4 architecture pe kaam karta hoon."   (asked who are you)
 *   the same Hinglish question answered in Devanagari by the stream lane.
 *
 * The guard that rejects them lives in server.js next to the fact rules; these
 * assertions pin its behaviour so a future prompt edit cannot silently reopen it.
 *
 * Run: node answer-guard.test.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const start = src.indexOf("const DEVANAGARI");
const end = src.indexOf("function isSmallTalk");
if (start < 0 || end < 0) { console.error("could not locate the answer guard in server.js"); process.exit(1); }
const guard = new Function(src.slice(start, end) +
  "; return { derailedAnswer, scriptMismatch, needsRewrite, scriptNote };")();

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  → got " + JSON.stringify(extra) : "")); }
}

console.log("A. identity leaks are rejected");
ok("vendor self-introduction (the live Nemotron draft)",
  guard.derailedAnswer("bhai mera laptop slow chal raha hai kya karu",
    "Mera naam Nemotron hai, aur main NVIDIA ke शोधकर्ताओं द्वारा विकसित एक भाषा मॉडल हूँ।") === true);
ok("model claim inside a who-are-you answer",
  guard.derailedAnswer("tum kaun ho bhai, kis model pe ho",
    "Main AURA hoon. Main GPT-4 architecture pe kaam karta hoon.") === true);
ok("plain identity answer is allowed",
  guard.derailedAnswer("tum kaun ho", "Main AURA hoon. Aapki madad ke liye hazir.") === false);
ok("a real definition of someone else's model is allowed",
  guard.derailedAnswer("what is gpt-4", "GPT-4 is a large language model released by OpenAI.") === false);
ok("a technical definition is allowed",
  guard.derailedAnswer("what is a transformer", "A transformer is a neural network architecture that uses attention.") === false);

console.log("B. script mirroring");
ok("Devanagari answer to a Roman Hinglish question is flagged",
  guard.scriptMismatch("mera phone 20 percent pe band ho jata hai",
    "फोन की बैटरी 20% पर बंद हो जाने के कुछ सामान्य कारण और उनके समाधान नीचे दिए गए हैं।") === true);
ok("Roman Hinglish answer passes",
  guard.scriptMismatch("mera phone 20 percent pe band ho jata hai",
    "Bhai, phone ki battery 20% pe band hone ke kuch common reasons hain.") === false);
ok("English in, English out passes",
  guard.scriptMismatch("what is the capital of australia", "Canberra is the capital of Australia.") === false);
ok("Devanagari question gets a Devanagari reply",
  guard.scriptNote("मेरा फोन बंद हो जाता है") === "SCRIPT: the user wrote Devanagari — reply in Devanagari.");
ok("Hinglish question asks for Roman letters",
  /Roman letters only/.test(guard.scriptNote("bhai kya karu")));
ok("English question needs no script note",
  guard.scriptNote("what is the capital of australia") === "");

console.log("C. one decision for both defects");
ok("needsRewrite covers identity and script",
  guard.needsRewrite("bhai laptop slow", "Mera naam Nemotron hai.") === true &&
  guard.needsRewrite("bhai laptop slow", "लैपटॉप धीमा है, कुछ apps बंद करो।") === true &&
  guard.needsRewrite("bhai laptop slow", "Bhai kuch background apps band karo.") === false);

console.log("\n" + (fail ? "FAILED " + fail + " (" + pass + " passed)" : "all " + pass + " checks passed"));
process.exit(fail ? 1 : 0);

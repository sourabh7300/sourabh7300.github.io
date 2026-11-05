/* Freshness tests (4 Nov 2026).
 *
 * Owner report: "yeh 2024 ke hisab se hi answers detaa hai". Three defects made
 * that possible and each is pinned here:
 *   1. the "can this have changed?" list only matched news words, so "best phone
 *      under 30k", "python latest version" and "who is the CEO of X" answered
 *      from memory;
 *   2. a search for a "best/latest" ask carried no year, so it returned last
 *      year's list;
 *   3. a draft that admitted "as of my last update in 2024" was shown as the
 *      answer instead of earning a live search.
 *
 * Run: node freshness.test.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
function slice(startMark, endMark) {
  const a = src.indexOf(startMark), b = src.indexOf(endMark);
  if (a < 0 || b < 0) { console.error("could not locate " + startMark + " in server.js"); process.exit(1); }
  return src.slice(a, b);
}
const mod = new Function(
  slice("const FRESH_RE", "async function realSearch") +
  slice("const DEVANAGARI", "function isSmallTalk") +
  "; return { FRESH_RE, withYearAnchor, staleExcuse, needsRewrite };"
)();

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  → got " + JSON.stringify(extra) : "")); }
}

const year = new Date().getFullYear();

console.log("A. values that move earn a live search");
[
  "best phone under 30000",
  "python ka latest version kya hai",
  "who is the ceo of openai",
  "kaunsa laptop lunga 60k me",
  "iphone ki price kitni hai",
  "nvidia ka new gpu kab launch hoga",
  "current chief minister of bihar",
  "top 5 gaming laptops"
].forEach(q => ok("search: " + q, mod.FRESH_RE.test(q) === true));

console.log("B. stable knowledge does not pay for a search");
[
  "what is the capital of australia",
  "explain quantum entanglement",
  "reverse a string in python",
  "17*23+45",
  "what is a transformer"
].forEach(q => ok("no search: " + q, mod.FRESH_RE.test(q) === false));

console.log("C. search queries carry the current year");
ok("best phone → best phone " + year,
  mod.withYearAnchor("best phone under 30000") === "best phone under 30000 " + year,
  mod.withYearAnchor("best phone under 30000"));
ok("an explicit year is respected",
  mod.withYearAnchor("best phone 2025") === "best phone 2025", mod.withYearAnchor("best phone 2025"));
ok("a stable question is untouched",
  mod.withYearAnchor("what is the capital of australia") === "what is the capital of australia",
  mod.withYearAnchor("what is the capital of australia"));

console.log("D. the 2024 excuse is recognised");
[
  "As of my last update in 2024, the latest iPhone is the 16.",
  "I don't have access to real-time information.",
  "My knowledge cutoff is early 2024.",
  "Meri jankari 2024 tak hi hai."
].forEach(a => ok("stale: " + a.slice(0, 42), mod.staleExcuse(a) === true));
ok("a normal answer is not stale", mod.staleExcuse("Canberra is the capital of Australia.") === false);

/* OWNER REPORT 4 Nov 2026 (round 2): the live page still said "latest Python is 3.13,
 * October 2024" while the web said 3.15 in 2026. The page asks on the non-stream lane
 * and ships its own search block, which the server trusted blindly. */
const mod2 = new Function(
  slice("const CUR_YEAR = new Date().getFullYear();", "/* one exit for every answer lane") +
  slice("const FRESH_RE", "async function realSearch") +
  "; return { staleFact, evidenceIsCurrent, newestYear };"
)();

console.log("E. a confident stale answer is caught, not just a cutoff excuse");
const ASK = "python ka latest version kya hai abhi";
ok("3.13 / October 2024 draft is stale",
  mod2.staleFact(ASK, "Abhi Python ka latest stable version 3.13 hai, October 2024 mein release hua.", "old blog 2024") === true);
ok("3.14.8 / October 2026 draft is fresh",
  mod2.staleFact(ASK, "Python 3.14.8 latest hai (October 2026).", "blog 2026") === false);
ok("a stable fact from the past is not stale",
  mod2.staleFact("what is python", "Python was created in 1991.", "") === false);
ok("a non-fresh question is never flagged",
  mod2.staleFact("reverse a string in python", "Use s[::-1] - a 1991 trick.", "2026 news") === false);

console.log("F. a date line is not current evidence, and the typed lane grounds");
ok("the page's own date line is not a results block",
  mod2.evidenceIsCurrent([{ role: "system", content: "CURRENT DATE & TIME: Wednesday, 4 November 2026." }]) === false);
ok("a block naming this year counts",
  mod2.evidenceIsCurrent([{ role: "system", content: "LIVE WEB RESULTS: Python 3.15 released October 2026." }]) === true);
ok("a block from an older year does not",
  mod2.evidenceIsCurrent([{ role: "system", content: "LIVE WEB RESULTS: Python 3.13, October 2024." }]) === false);
{
  const route = src.slice(src.indexOf('app.post("/v1/chat/completions"'), src.indexOf('app.post("/v1/chat/stream"'));
  ok("the non-stream lane runs the same grounding", /groundChat\(messages\)/.test(route));
  ok("the repair can fall back to the main rotation", /const l = await llm1\(m2/.test(src));
}

console.log("G. a source hedge never opens the answer");
const mod3 = new Function(
  slice("const HEDGE_HEAD", "/* one exit for every answer lane") +
  "; return { stripHedge };"
)();
ok("the hedge clause is dropped, the fact stays",
  mod3.stripHedge("I couldn’t find that detail in the provided sources, but Satya Nadella is the current CEO of Microsoft.") ===
  "Satya Nadella is the current CEO of Microsoft.",
  mod3.stripHedge("I couldn’t find that detail in the provided sources, but Satya Nadella is the current CEO of Microsoft."));
ok("a leading hedge sentence goes too",
  mod3.stripHedge("The provided sources don't mention today's match. However, the last one was on 2 Nov.") ===
  "the last one was on 2 Nov.",
  mod3.stripHedge("The provided sources don't mention today's match. However, the last one was on 2 Nov."));
ok("a plain answer is untouched",
  mod3.stripHedge("Python 3.14.8 hai (October 2026).") === "Python 3.14.8 hai (October 2026).");

console.log("H. an unverified 'nothing today' is not shown as fact");
const mod4 = new Function(
  slice("const NEG_TODAY", "function isSmallTalk") +
  slice("function systemText", "/* Incoming evidence") +
  "; return { NEG_TODAY, todayInEvidence };"
)();
ok("'Aaj India ka koi match nahi hai' is caught",
  mod4.NEG_TODAY.test("Aaj India ka koi match nahi hai.") === true);
ok("a dated answer is not touched",
  mod4.NEG_TODAY.test("Aaj India vs South Africa ka match hai, 5 Nov ko.") === false);
ok("evidence with no date cannot prove a negative",
  mod4.todayInEvidence([{ role: "system", content: "LIVE WEB RESULTS: cricket news, undated." }]) === false);

console.log("\n" + (fail ? "FAILED " + fail + " (" + pass + " passed)" : "all " + pass + " checks passed"));
process.exit(fail ? 1 : 0);

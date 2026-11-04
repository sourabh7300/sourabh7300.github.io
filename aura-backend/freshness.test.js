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

console.log("\n" + (fail ? "FAILED " + fail + " (" + pass + " passed)" : "all " + pass + " checks passed"));
process.exit(fail ? 1 : 0);

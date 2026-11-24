/* Evidence relevance gate tests (23 Nov 2026)
 *
 * Each case is a search result set the live lanes actually returned. Freshness was
 * always checked; relevance was not, so these pin the behaviour that stops an
 * unrelated but recent headline from becoming the evidence for an answer.
 *
 * Run: node evidence-gate.test.js
 */
"use strict";

const G = require("./evidence-gate");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  → got " + JSON.stringify(extra) : "")); }
}
const titles = list => list.map(h => h.title);

console.log("A. a title question keeps only pages about that company");
const intelOff = [
  { title: "Microsoft CEO Satya Nadella outlines the next AI push", extract: "Nadella said Microsoft will keep investing in AI infrastructure." },
  { title: "Why tech layoffs keep coming in 2026", extract: "Microsoft, Meta and Amazon all cut roles this year." },
];
{
  const g = G.gateHits("who is the CEO of Intel", intelOff);
  ok("no Intel page → nothing is evidence", g.hits.length === 0 && g.offTopic === true, titles(g.hits));
}
const intelMixed = [
  { title: "Microsoft CEO Satya Nadella outlines the next AI push", extract: "Nadella said Microsoft will keep investing." },
  { title: "Intel cuts more jobs as CEO Lip-Bu Tan pushes efficiency", extract: "Intel is laying off employees again." },
  { title: "Intel foundry update", extract: "The company signed its first external 18A customer." },
];
{
  const g = G.gateHits("who is the CEO of Intel", intelMixed);
  ok("the Microsoft story is dropped", g.dropped.length === 1 && /Microsoft/.test(g.dropped[0].title));
  ok("both Intel pages survive, in order", g.hits.length === 2 && /jobs/.test(g.hits[0].title) && /foundry/.test(g.hits[1].title), titles(g.hits));
  ok("not flagged off-topic", g.offTopic === false);
}

console.log("B. a version/price ask is not answered from an unrelated release story");
{
  const g = G.gateHits("python ka latest version kya hai", [
    { title: "LiteLLM supply-chain incident hits Python packages", extract: "A malicious package was published to PyPI." },
    { title: "Node.js security patch released", extract: "Node 24.2 fixes three issues." },
  ]);
  ok("PyPI story mentions Python — it is about the ecosystem, kept", g.hits.length === 1 && /LiteLLM/.test(g.hits[0].title), titles(g.hits));
  const g2 = G.gateHits("python ka latest version kya hai", [
    { title: "Node.js security patch released", extract: "Node 24.2 fixes three issues." },
    { title: "Windows 11 update breaks printers", extract: "The update shipped this week." },
  ]);
  ok("nothing about Python → off-topic, no evidence", g2.offTopic === true && g2.hits.length === 0, titles(g2.hits));
}

console.log("C. the coach question from the live retest");
const coachOff = [{ title: "Asian Games coach says the squad is ready", extract: "The coach spoke to reporters before the final." }];
{
  const g = G.gateHits("India cricket team ka coach kaun hai", coachOff);
  ok("an Asian Games coach story is not India cricket evidence", g.offTopic === true && g.hits.length === 0, titles(g.hits));
  const g2 = G.gateHits("India cricket team ka coach kaun hai", [
    { title: "Gautam Gambhir named head coach of the Indian team", extract: "The BCCI confirmed the appointment on Tuesday." },
  ]);
  ok("a real India coach story passes (india ⊂ indian)", g2.hits.length === 1 && g2.offTopic === false, titles(g2.hits));
}

console.log("D. a winner question with no nameable subject is never filtered");
{
  const hits = [
    { title: "Alabama tops the high-school esports rankings", extract: "PlayVS standings." },
    { title: "Valorant Champions final ends 3-2", extract: "A dramatic grand final." },
  ];
  const g = G.gateHits("aaj kaun jeeta", hits);
  ok("no anchors → every hit kept, gate disabled", g.hits.length === 2 && g.offTopic === false, g.profile.anchors);
  const g2 = G.gateHits("who won today", hits);
  ok("same for English", g2.hits.length === 2 && g2.offTopic === false, g2.profile.anchors);
}

console.log("E. acronyms are subjects, and near-misses do not pass");
{
  const g = G.gateHits("BMIC 2026 teams list", [
    { title: "BMSD 2026 team list announced", extract: "Eight teams will compete in BMSD." },
    { title: "BMIC 2026: invited teams revealed", extract: "The BMIC lineup is out." },
  ]);
  ok("BMSD is not BMIC", g.hits.length === 1 && /BMIC/.test(g.hits[0].title), titles(g.hits));
}

console.log("F. spelling variants and aliases");
{
  ok("bharat maps to india", G.topicProfile("bharat ka coach kaun hai").anchors.indexOf("india") >= 0, G.topicProfile("bharat ka coach kaun hai").anchors);
  ok("usa maps to united states as one subject", G.topicProfile("usa president kaun hai").anchors.join("|") === "united states", G.topicProfile("usa president kaun hai").anchors);
  const g = G.gateHits("usa president kaun hai", [{ title: "Donald Trump is the US president", extract: "He took office in January." }]);
  ok("US president story matches the alias anchor", g.hits.length === 1 && !g.offTopic, titles(g.hits));
}

console.log("G. ordering, empty input and shape");
{
  const hits = [{ title: "Tesla price cut in Europe", extract: "Model 3 price falls." }];
  const g = G.gateHits("tesla price", hits);
  ok("relevant hits keep their order", g.hits.length === 1 && g.hits[0] === hits[0]);
  ok("empty hit list is not off-topic", G.gateHits("tesla price", []).offTopic === false);
  ok("junk entries are ignored", G.gateHits("tesla price", [null, undefined]).hits.length === 0);
  ok("gate result always carries a profile", !!G.gateHits("tesla price", hits).profile);
}

console.log("\n" + (fail ? "FAILED " + fail + " (" + pass + " passed)" : "all " + pass + " checks passed"));
process.exit(fail ? 1 : 0);

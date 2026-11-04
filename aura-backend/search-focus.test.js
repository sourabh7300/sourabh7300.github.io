/* checks the result-question focusing used by toolSearch (see search-focus.js) */
const F = require("./search-focus");
const NOW = new Date("2026-11-04T09:00:00Z");
let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.log("FAIL " + name); } }

ok("result ask: kaun jeeta", F.isResultAsk("bhai esports me aaj kaun jeeta? ek line"));
ok("result ask: who won", F.isResultAsk("who won the valorant grand final today"));
ok("result ask: score", F.isResultAsk("what was the final score of the match"));
ok("not result ask: definition", !F.isResultAsk("what is a monad"));
ok("not result ask: latest price", !F.isResultAsk("latest iphone price"));

ok("game: valorant", F.gameIn("valorant grand final") === "Valorant");
ok("game: bgmi alias", F.gameIn("BGMI finals kab hai") === "BGMI");
ok("game: ipl", F.gameIn("ipl ka match") === "IPL");
ok("game: none", F.gameIn("who won the election") === "");

const vq = F.sharpenQuery("who won the valorant grand final today", NOW);
ok("sharpen keeps game", /^Valorant tournament grand final result/.test(vq));
ok("sharpen carries date", vq.includes("4 November 2026"));
ok("sharpen strips chatter", !/bhai/.test(F.sharpenQuery("bhai esports me aaj kaun jeeta", NOW)));

const junk = { title: "USA TODAY Sports announces National High School Esports Championship", url: "https://sports.yahoo.com/x" };
const real = { title: "Valorant Champions 2026 grand final: Paper Rex beat FNATIC 3-1", url: "https://www.vlr.gg/123" };
ok("junk scores low", F.scoreHit(junk) < 0);
ok("result scores high", F.scoreHit(real) >= 5);
ok("rank puts result first", F.rankHits([junk, real])[0] === real);
ok("needs more when junk only", F.needsResultSearch([junk]));
ok("no extra search when result present", !F.needsResultSearch([real]));
ok("empty input safe", F.rankHits(null).length === 0 && F.isResultAsk("") === false);

console.log("pass " + pass + " · fail " + fail);
process.exit(fail ? 1 : 0);

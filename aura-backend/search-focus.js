/* SEARCH FOCUS (4 Nov 2026)
   Owner report: "latest bhi nahi bata raha, purani search bhi bilkul shi nahi".
   Root cause found by inspecting a live call: the question "bhai esports me aaj kaun
   jeeta" was passed to the search API almost verbatim, so Tavily answered with generic
   *news* about high-school esports championships — dated articles, no scores, no winner.
   The model then (correctly) refused to invent a winner, which reads like "AURA doesn't
   know anything latest".

   A result question needs a result-shaped query and result-shaped sources. This module
   rewrites the query for win/score/standings questions, names the game when the user
   named one, and ranks what comes back by (a) result-carrying domains, (b) a score
   pattern, (c) recency — so the answer lane sees an actual final score instead of a
   press release about a tournament that has not happened yet. */

const GAMES = [
  [/counter[\s-]?strike|\bcs2\b|\bcsgo\b/i, "Counter-Strike 2"],
  [/valorant|\bvct\b/i, "Valorant"],
  [/dota\s?2|\bdota\b/i, "Dota 2"],
  [/bgmi|\bbmic\b|\bpubg/i, "BGMI"],
  [/free\s?fire/i, "Free Fire"],
  [/league\s+of\s+legends|\blol\b|\bworlds\b/i, "League of Legends"],
  [/mobile\s+legends|\bmlbb\b/i, "Mobile Legends"],
  [/apex\s+legends/i, "Apex Legends"],
  [/fortnite/i, "Fortnite"],
  [/call\s+of\s+duty|\bcodm?\b/i, "Call of Duty"],
  [/rocket\s+league/i, "Rocket League"],
  [/overwatch/i, "Overwatch"],
  [/clash\s+royale/i, "Clash Royale"],
  [/eafc|fifae|fifa\s?e/i, "EA FC"],
  [/\bipl\b/i, "IPL"],
  [/\bbbl\b/i, "BBL"],
  [/\bpsl\b/i, "PSL"],
  [/\bworld\s+cup\b/i, "World Cup"],
  [/\bcricket\b/i, "cricket"],
  [/\bfootball\b|\bpremier league\b|\bfifa\b/i, "football"],
  [/\btennis\b|\batp\b|\bwta\b/i, "tennis"],
];

/* the question is asking for a RESULT, not for background */
const RESULT_ASK = /(who\s+(won|win|is\s+winning|is\s+leading)|kaun\s+(jeeta|jita|jeetega|jitega)|kaun\s+jeeta|jeeta|jita|winner|champion|final\s+score|score|scorecard|results?|standings|points\s+table|h2h|kaun\s+jeeta|match\s+(ka|kab|result)|aaj\s+ka\s+match)/i;

/* a page that actually carries a result */
const RESULT_DOMAINS = [
  "liquipedia.net", "hltv.org", "vlr.gg", "escharts.com", "dotesports.com",
  "oneesports.gg", "esportsinsider.com", "gameriv.com", "talkesport.com",
  "flashscore.com", "sofascore.com", "espn.com", "espncricinfo.com",
  "bbc.com/sport", "skysports.com", "goal.com", "atptour.com", "wtatennis.com",
];

const SCORE_SHAPE = /\b\d{1,3}\s*[-–:to]{1,3}\s*\d{1,3}\b|\b\d+\s*-\s*\d+\s*\(/;
const WIN_WORD = /\b(beat|beats|defeated|wins?|won|champions?|lifts? the trophy|clinch(ed)?)\b/i;

function gameIn(q) {
  const s = String(q || "");
  for (const [re, name] of GAMES) if (re.test(s)) return name;
  return "";
}

function isResultAsk(q) {
  return RESULT_ASK.test(String(q || ""));
}

/* "bhai esports me aaj kaun jeeta? ek line" -> "Valorant esports final result today ..."
   Keeps the user's own subject when we cannot name a game, and always carries an
   explicit date so the search engine's freshness filter has something to anchor to. */
function sharpenQuery(q, now) {
  const d = now instanceof Date ? now : new Date();
  const day = d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const game = gameIn(q);
  const subject = game || "esports";
  const asked = String(q || "").toLowerCase();
  const kind = /points\s+table|standings/i.test(asked) ? "standings"
    : /schedule|fixture|kab\b/i.test(asked) ? "fixture schedule"
      : /final|championship|grand/i.test(asked) ? "grand final result"
        : "match result";
  /* sports and leagues already name a competition, so they take no "tournament" prefix */
  const COMPETITION = /^(cricket|football|tennis|IPL|BBL|PSL|World Cup)$/;
  return (COMPETITION.test(subject)
    ? subject + " " + kind + " " + day
    : subject + " tournament " + kind + " " + day).replace(/\s+/g, " ").trim();
}

/* score a single hit for "does this page actually contain the outcome?" */
function scoreHit(h) {
  const url = String((h && h.url) || "").toLowerCase();
  const text = String((h && (h.title || "")) + " " + ((h && h.extract) || "")) + "";
  let s = 0;
  for (const d of RESULT_DOMAINS) if (url.includes(d)) { s += 4; break; }
  if (SCORE_SHAPE.test(text)) s += 3;
  if (WIN_WORD.test(text)) s += 2;
  if (/\b(today|yesterday|hours? ago)\b/i.test(text)) s += 1;
  if (/high\s*school|collegiate|scholastic|playvs/i.test(text)) s -= 4; /* the junk that started this */
  if (/how to watch|where to watch|preview|tickets|odds|betting/i.test(text)) s -= 2;
  return s;
}

function rankHits(hits) {
  return (Array.isArray(hits) ? hits.slice() : [])
    .map((h, i) => ({ h, s: scoreHit(h), i }))
    .sort((a, b) => (b.s - a.s) || (a.i - b.i))
    .map(x => x.h);
}

/* worth spending an extra search call only when the top hit carries no result at all */
function needsResultSearch(hits) {
  const top = (Array.isArray(hits) ? hits : []).slice(0, 3);
  if (!top.length) return true;
  return !top.some(h => scoreHit(h) >= 3);
}

module.exports = { gameIn, isResultAsk, sharpenQuery, scoreHit, rankHits, needsResultSearch, RESULT_ASK, RESULT_DOMAINS };

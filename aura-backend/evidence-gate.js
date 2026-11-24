/* EVIDENCE RELEVANCE GATE (23 Nov 2026)
   Two live defects made the search lane actively harmful instead of helpful:
     * "who won in esports today" was answered from a dated headline about an
       Alabama high-school league — fresh, but about a different subject;
     * a title question was answered with a hedge because the results on hand were
       about something else entirely, so the model (correctly) said the sources did
       not name the holder.
   Freshness was checked; RELEVANCE never was. This module reads the question, keeps
   only the hits that actually talk about the same subject, and tells the caller when
   nothing matched — so an unrelated headline is no longer treated as evidence.

   FAIL-OPEN BY DESIGN: a question with no nameable subject ("who won today") is
   never filtered, and the gate never invents evidence. It only removes pages whose
   text never mentions the thing the user asked about. */

/* question words, filler and connectives — they say nothing about the subject */
const STOP = new Set((
  "a an the is are was were be been being am do does did doing done have has had " +
  "who whom whose what when where which why how whether of in on at to for from by with without " +
  "and or but not no nor so than then this that these those it its they them their there here " +
  "he she him his her you your i me my we our us can could will would shall should may might must " +
  "about into over under after before between during any all some such very just also too only " +
  "more most much many few own same other another please tell give show answer say explain list " +
  "name per via vs versus full form means mean " +
  "ka ki ke kya kaun kon kise kis kisko hai hain ho hua hui tha thi the nahi nahin na bata batao " +
  "batana mujhe mera meri tum aap main hum ham karo kar karna karte karta abhi aaj kal kuch koi " +
  "bhi aur par se me mein kaunsa konsa kitna kitni kitne kab kahan kaise kaisa kyun kyu bhai yaar " +
  "jeeta jita jeetega jeeti hara haara haan ok okay"
).split(/\s+/));

/* words that describe the KIND of fact wanted, never the subject: a question like
   "latest Intel CEO" has exactly one subject — intel */
const GENERIC = new Set((
  "latest newest new current currently today tonight now recent recently live breaking news update updates " +
  "updated version versions price prices cost costs release released launch launched review reviews " +
  "best top ranking rankings list lists specs spec sale deal offer cheap " +
  "winner winners won win wins champion champions score scores result results standings table tables " +
  "final finals match matches game games tournament trophy title titles " +
  "ceo cfo cto president pm minister coach captain owner founder chief executive officer " +
  "team teams squad squads player players company companies stock shares market year month week day time date " +
  "meaning definition definition difference role salary age net worth wife height"
).split(/\s+/));

/* the same subject, spelled the way the user spells it */
const ALIAS = {
  bharat: "india", hindustan: "india", america: "united states", usa: "united states",
  "u.s.": "united states", us: "united states", britain: "united kingdom", uk: "united kingdom",
  "united kingdom": "united kingdom", england: "united kingdom",
};

/* every spelling of a canonical subject: the user's word and the words a page uses */
const ALIASES_OF = {};
for (const k of Object.keys(ALIAS)) {
  const canon = ALIAS[k];
  (ALIASES_OF[canon] = ALIASES_OF[canon] || [canon]).push(k);
}

const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* a word must match at its start, not mid-token: india ⊂ indian, gambhir ⊂ gambhir's */
function stem(t) {
  return t.length >= 7 ? t.slice(0, 6) : t.length >= 5 ? t.slice(0, 5) : t;
}

function mentions(text, term) {
  const t = String(text || "").toLowerCase();
  if (!t || !term) return false;
  if (term.indexOf(" ") >= 0) return t.indexOf(term) >= 0;
  if (new RegExp("\\b" + esc(term) + "\\b").test(t)) return true;
  /* prefix at a word start, so india matches indian and gambhir matches gambhir's —
     a trailing word boundary would reject every inflected spelling */
  const s = stem(term);
  return new RegExp("\\b" + esc(s)).test(t);
}

const NORM = s => String(s || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");

/* what is this question ABOUT? anchors = subject words, generic = the asked-for kind */
function topicProfile(ask) {
  const toks = NORM(ask).match(/[a-z0-9][a-z0-9.+#-]*/g) || [];
  const anchors = [], generic = [];
  for (let t of toks) {
    t = t.replace(/^[.+#-]+|[.+#-]+$/g, "");
    if (!t || t.length < 3 || STOP.has(t)) continue;
    if (ALIAS[t]) t = ALIAS[t];
    if (/^\d+$/.test(t)) continue;                  /* years and prices are not subjects */
    if (GENERIC.has(t)) { if (generic.indexOf(t) < 0) generic.push(t); continue; }
    if (anchors.indexOf(t) < 0) anchors.push(t);
  }
  return { anchors, generic };
}

/* everything the search engine gave us about one page */
function hitText(h) {
  if (!h) return "";
  return NORM(String(h.title || "") + " " + String(h.extract || "") + " " + String(h.snippet || "") + " " + String(h.url || ""));
}

/* how many of the question's subjects a hit mentions */
function matchCount(profile, hit) {
  const text = hitText(hit);
  if (!text) return 0;
  let n = 0;
  for (const a of profile.anchors) {
    const forms = ALIASES_OF[a] || [a];
    if (forms.some(f => mentions(text, f))) n++;
  }
  return n;
}

/* gateHits(ask, hits) → { hits, dropped, offTopic, profile }
   hits     — the relevant pages, same order as the search returned them
   dropped  — the pages that never mention the subject (kept for logging/debug)
   offTopic — true when the search found pages but none of them are about the ask */
function gateHits(ask, hits, opts) {
  const list = (Array.isArray(hits) ? hits : []).filter(Boolean);
  const profile = topicProfile(ask);
  const out = { hits: list, dropped: [], offTopic: false, profile };
  if (!list.length) return out;
  /* nothing nameable in the question ("who won today", "aaj ka match") → hands off */
  if (!profile.anchors.length) return out;
  const o = opts || {};
  const need = o.minMatch || (profile.anchors.length >= 3 ? Math.ceil(profile.anchors.length / 2) : 1);
  const keep = [], drop = [];
  for (const h of list) (matchCount(profile, h) >= need ? keep : drop).push(h);
  out.dropped = drop;
  if (!keep.length) { out.hits = []; out.offTopic = true; return out; }
  out.hits = keep;
  return out;
}

module.exports = { gateHits, topicProfile, matchCount, mentions, topicTerms: topicProfile, _stop: STOP, _generic: GENERIC };

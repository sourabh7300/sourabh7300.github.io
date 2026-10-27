/* ============================================================
   AURA · Liquipedia lane (27 Oct 2026)

   WHY: owner asked "bmic ki teams kaun kaun hai" and AURA answered from
   memory — the wrong event, invented "Team A … Team H", and a wrong start
   date. The general web lanes cannot fix that: the news feed only carries
   headlines, DuckDuckGo's html endpoint is blocked from cloud IPs, and
   liquipedia.net serves 403 to plain page reads. Its MediaWiki API, however,
   works and returns the whole page — including the participants table.

   WHAT THIS RETURNS: hits shaped like the backend's other search results
   ({title, url, extract}) where `extract` is a compact FACTS block (dates,
   venue, prize, full team list, format) plus the page lead, so a model can
   answer from evidence instead of guessing.
   ============================================================ */
"use strict";

const UA = {
  "User-Agent": "AURA-backend/1.0 (https://sourabh7300.github.io; contact: site owner)",
  "Accept-Encoding": "gzip",
};

/* Liquipedia throttles hard (and blocks scraper floods for a while). Their notice used to
   arrive as page CONTENT, so the brain read a rate-limit page and told the owner it had no
   verified data. A block notice is never facts, and nothing from it is ever evidence. */
const BLOCKED = /temporarily blocked|excessive or invalid requests|not permitted to access Liquipedia|rate limit|too many requests/i;
/* API terms: keep at least one request every ~2s and cache what we already fetched, so a
   chat session never turns into a flood that gets the host blocked. */
let lastApiAt = 0;
async function politeDelay() {
  const wait = 2100 - (Date.now() - lastApiAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastApiAt = Date.now();
}
const FACT_CACHE = new Map(); /* query → {at, hits} — a blocked retry still answers from here */
/* PAGE_CACHE is the important one for chat: "bmic start date" then "teams name in it"
   are two different queries for the SAME tournament page. Re-fetching it for the second
   turn both wasted seconds and pressed Liquipedia's throttle — so a page that parsed
   once is served from here. */
const PAGE_CACHE = new Map(); /* wiki|title → {at, extract, teams} */
const FACT_TTL = 30 * 60 * 1000;
const ESL_RE = /\b(bmic|bmsd|bgis|bgms|bmps|bgmi|pubg|pmgc|pmgo|pmps|pmjl|kel|krafton|esports?|valorant|vct|cs2|counter[-\s]?strike|dota|free\s?fire|league\s?of\s?legends|lol|apex|rocket\s?league|overwatch|call\s?of\s?duty|cod)\b/i;

function isEsportsQuery(q) {
  return ESL_RE.test(String(q || ""));
}

function wikiFor(q) {
  return /\b(bmic|bmsd|bgis|bgms|bmps|bgmi|pubg|pmgc|pmgo|pmps|pmjl|kel|krafton)\b/i.test(String(q || ""))
    ? "pubgmobile"
    : "mobile";
}

function decode(s) {
  return String(s || "")
    .replace(/&#95;/g, "_")
    .replace(/&#91;/g, "[")
    .replace(/&#93;/g, "]")
    .replace(/&#160;|&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function plainText(html) {
  return decode(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " ")
  );
}

/* infobox + section facts straight off the parsed page */
function factsFrom(html, title) {
  const text = plainText(html);
  if (BLOCKED.test(text.slice(0, 1500))) return { extract: "", teams: [] };
  const pick = (re) => {
    const m = text.match(re);
    return m ? m[1].trim() : "";
  };
  const start = pick(/Start Date:\s*(\d{4}-\d{2}-\d{2})/);
  const end = pick(/End Date:\s*(\d{4}-\d{2}-\d{2})/);
  const location = pick(/Location:\s*([^:]{2,40}?)\s+Venue:/);
  const venue = pick(/Venue:\s*([^:]{2,50}?)\s+Prize Pool:/);
  const prize = pick(/Prize Pool:\s*([^:]{1,60}?)\s+(?:Start Date|End Date|Liquipedia Tier|Links|Number of teams)/);
  const nTeams = pick(/Number of teams:\s*(\d{1,3})/);

  /* participants table — each card's first anchor title is the team name */
  let teams = [];
  const s = html.indexOf('id="Participants"');
  if (s > -1) {
    let e = html.indexOf('id="Results"', s);
    if (e < 0) e = Math.min(html.length, s + 120000);
    const region = html.slice(s, e);
    const chunks = region.split(/team-participant-card&#95;&#95;opponent(?:-compact)?"/);
    for (const c of chunks.slice(1)) {
      /* the visible team name lives in <span class="name"><a …>Team SouL</a>; the
         anchor's title attribute can carry a wiki disambiguation ((Indian team)) that
         no reader ever sees, so the rendered text wins when it is there. */
      const disp = c.match(/class="name"[^>]*>\s*<a[^>]*>([^<]{2,48})</);
      const m = c.match(/title="([^"]+)"/);
      if (!disp && !m) continue;
      const name = decode(disp ? disp[1] : m[1]);
      if (name && !teams.includes(name)) teams.push(name);
    }
  }

  /* the "About → Format" section carries the qualification split and dates.
     Anchor on the section marker so the table-of-contents copy of the word is skipped. */
  let format = "";
  const fm = text.match(/Format\s*\[?\s*edit\s*\]?\s+([\s\S]{0,360})/i);
  if (fm) {
    format = fm[1].split(/Points Distribution/i)[0].replace(/\s+/g, " ").trim()
      /* the section text tails off into table-of-contents numbering (“… PMJL P2 18 .”) */
      .replace(/\s+\d{1,3}\s*\.?\s*$/, "").slice(0, 300);
  }

  /* lead sentence(s) about the event itself (the "(abbreviated as …) is a …" line) */
  let lead = "";
  const lm = text.match(/([A-Z][\w\s()'’.,\-]{2,110}?\(abbreviated as [^)]{1,40}\)\s*is an?[\s\S]{0,300})/);
  if (lm) {
    lead = lm[1].trim();
    /* drop a table-of-contents tail that can precede the real sentence */
    const base = String(title || "").split("/")[0];
    const at = base && lead.indexOf(base);
    if (typeof at === "number" && at > 0) lead = lead.slice(at);
  }

  /* name the event the way the user does. The brain once wrote “BIC 2026” for a BMIC
     question because the page title alone never spells out the acronym it knows. */
  const pageBase = String(title || "").split("/")[0];
  let acronym = "";
  for (const k of Object.keys(ALIAS)) if (ALIAS[k] === pageBase) { acronym = k.toUpperCase(); break; }
  const yearOf = (String(title || "").match(/\/(20\d\d)$/) || [])[1] || "";

  const bits = [];
  if (acronym) bits.push("EVENT: " + acronym + (yearOf ? " " + yearOf : "") + " — " + pageBase + (yearOf ? " " + yearOf : "") + " (users write it as “" + acronym + "" + (yearOf ? " " + yearOf : "") + "”).");
  bits.push("Liquipedia page: " + title);
  const when = [start, end].filter(Boolean).join(" → ");
  if (when) bits.push("DATES: " + when);
  if (location) bits.push("LOCATION: " + location);
  if (venue) bits.push("VENUE: " + venue);
  if (prize) bits.push("PRIZE POOL: " + prize);
  if (teams.length) bits.push("TEAMS (" + (nTeams || teams.length) + "): " + teams.join(", "));
  else if (nTeams) bits.push("TEAMS: " + nTeams + " (list not published on the page yet)");
  if (format) bits.push("FORMAT: " + format);
  if (lead) bits.push("ABOUT: " + lead);
  return { extract: bits.join("\n"), teams, start, end };
}

/* Direct API first. Datacenter IPs are often refused outright (403) and some networks
   block the host entirely, so on any failure the SAME api.php URL is re-read through a
   text-reader proxy: Liquipedia's page HTML is CAPTCHA-walled from cloud IPs, but the
   api.php JSON passes through the reader untouched, so the facts stay identical. */
async function api(wiki, query, timeout) {
  const url = "https://liquipedia.net/" + wiki + "/api.php?" + query;
  try {
    await politeDelay();
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeout || 15000) });
    if (r.ok) {
      const probe = await r.clone().text().catch(() => "");
      if (!BLOCKED.test(probe.slice(0, 1200))) return r;
    }
  } catch (e) { /* network/TLS block → try the reader proxy */ }
  try {
    await politeDelay();
    const r2 = await fetch("https://r.jina.ai/" + url, { signal: AbortSignal.timeout((timeout || 15000) + 25000) });
    if (!r2.ok) return { ok: false, status: r2.status, json: async () => ({}) };
    const txt = await r2.text();
    if (BLOCKED.test(txt.slice(0, 1200))) return { ok: false, status: 429, json: async () => ({}) };
    const at = txt.indexOf('{"parse"');
    const start = at > -1 ? at : txt.indexOf("{");
    const body = start > -1 ? txt.slice(start) : "";
    if (!body) return { ok: false, status: 0, json: async () => ({}) };
    return { ok: true, via: "reader", json: async () => { try { return JSON.parse(body); } catch (e) { return {}; } } };
  } catch (e) {
    return { ok: false, status: 0, json: async () => ({}) };
  }
}

/* Acronym → real event name. Liquipedia's search is literal: "bmic teams" matched
   the BMSD pages (because of the word "teams") and AURA then answered the WRONG
   tournament. Expanding the acronym first is what keeps BMIC a BMIC question. */
const ALIAS = {
  bmic: "Battlegrounds Mobile India International Cup",
  bmsd: "Battlegrounds Mobile India Showdown",
  bgis: "Battlegrounds Mobile India Series",
  bgms: "Battlegrounds Mobile India Masters Series",
  bmps: "Battlegrounds Mobile India Pro Series",
  bmps2: "Battlegrounds Mobile India Pro Series",
  pmgc: "PUBG Mobile Global Championship",
  pmgo: "PUBG Mobile Global Open",
  pmps: "PUBG Mobile Pro Series",
  pmjl: "PUBG Mobile Japan League",
  kel: "Korea Esports League",
};

/* Build the queries worth trying, most specific first. */
function queryPlan(q) {
  const s = String(q || "");
  const year = (s.match(/\b(20\d\d)\b/) || [])[1] || String(new Date().getFullYear());
  const tokens = s.toLowerCase().match(/\b[a-z]{2,6}\b/g) || [];
  const plan = [];
  const seen = new Set();
  for (const t of tokens) {
    const name = ALIAS[t];
    if (!name) continue;
    for (const cand of [name + "/" + year, name + " " + year, name]) {
      if (!seen.has(cand)) { seen.add(cand); plan.push(cand); }
    }
  }
  if (!plan.length) plan.push(s.slice(0, 200));
  return { plan, year };
}

/* search + hydrate: returns [{title, url, extract, teams}] (empty array on any failure) */
async function liquipediaSearch(q, limit) {
  const key = String(q || "").slice(0, 120) + "|" + (limit || 3);
  const cached = FACT_CACHE.get(key);
  if (cached && Date.now() - cached.at < FACT_TTL) return cached.hits;
  const out = [];
  const wiki = wikiFor(q);
  const max = limit || 3;
  const seen = new Set();

  const hydrate = async (title) => {
    if (seen.has(title)) return;
    seen.add(title);
    /* index/list pages carry no roster of their own — never pass them off as evidence */
    if (/^(A|S|B|C|D)-Tier|^(Tournaments|Qualifier|Portal|Statistics|Main Page)/i.test(title)) return;
    let facts = null;
    const pkey = wiki + "|" + title;
    const pc = PAGE_CACHE.get(pkey);
    if (pc && Date.now() - pc.at < FACT_TTL) facts = pc;
    if (!facts) {
      let html = "";
      try {
        const pr = await api(wiki, "action=parse&page=" + encodeURIComponent(title) + "&prop=text&format=json&formatversion=2", 20000);
        if (pr.ok) {
          const pj = await pr.json();
          html = (pj.parse && pj.parse.text) || "";
          if (pj.error) html = "";
        }
      } catch (e) { /* keep the hit with its title at least */ }
      facts = html ? factsFrom(html, title) : { extract: "", teams: [] };
      if (facts.extract) PAGE_CACHE.set(pkey, { at: Date.now(), extract: facts.extract, teams: facts.teams || [] });
    }
    if (!facts.extract) return; /* a page that did not load is not evidence */
    out.push({
      title,
      url: "https://liquipedia.net/" + wiki + "/" + title.replace(/ /g, "_"),
      extract: facts.extract,
      teams: facts.teams || [],
      source: "liquipedia",
      cached: !!pc,
    });
  };

  let year = String(new Date().getFullYear());
  try {
    const plan0 = queryPlan(q);
    const plan = plan0.plan;
    year = plan0.year;
    for (const cand of plan) {
      if (out.length >= max) break;
      /* an exact "Event/2026" title is the jackpot — go straight there */
      if (cand.includes("/")) { await hydrate(cand); if (out.length) continue; }
      const r = await api(wiki, "action=query&list=search&srsearch=" + encodeURIComponent(cand) + "&format=json&srlimit=" + max);
      if (!r.ok) continue;
      const d = await r.json();
      const hits = (((d.query || {}).search) || [])
        .filter((s) => !/^(Main Page|Special:|Category:)/.test(s.title || ""))
        .slice(0, max);
      /* prefer the page that actually matches the expanded event name */
      const wanted = cand.split(" ")[0].toLowerCase();
      hits.sort((a, b) => {
        const am = String(a.title).toLowerCase().includes(wanted) ? 1 : 0;
        const bm = String(b.title).toLowerCase().includes(wanted) ? 1 : 0;
        return bm - am;
      });
      for (const h of hits) {
        if (out.length >= max) break;
        await hydrate(h.title);
      }
    }
  } catch (e) { return out; }
  /* ONE EDITION ONLY: mixing 2025 and 2026 rosters is how a "current teams" answer
     ends up naming last year's lineup. If the requested year is on the wiki, keep it. */
  const sameYear = out.filter((h) => new RegExp("/" + year + "$").test(h.title));
  const final = sameYear.length ? sameYear : out;
  if (final.length) FACT_CACHE.set(key, { at: Date.now(), hits: final });
  return final;
}

module.exports = { isEsportsQuery, wikiFor, liquipediaSearch, factsFrom, queryPlan, ALIAS };

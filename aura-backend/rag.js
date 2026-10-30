/* ============ RAG MEMORY — the documents she actually remembers ============
   Until now "my documents" lived in the browser's localStorage: re-upload on every
   device, no similarity search (substring matching), no citations the server could
   trust. This module is the real retrieval layer:
     • ingest:  500-char chunks with 50-char overlap, paragraph-aware
     • embed:   Gemini text-embedding-004 when the vision key is live, else a
                deterministic hashed n-gram vector (same dimensions) so the lane
                still works on a key-less instance
     • search:  cosine similarity, top-k, one hit per chunk, page numbers preserved
     • persist: Firestore (aura_rag/<owner>/files/<id>) when accounts are configured,
                plus a hot in-memory copy per owner with a TTL
   Vectors are quantised to int8 and base64'd so a 60-chunk file costs ~60KB in
   Firestore instead of ~350KB. Query-time cosine uses the same quantised values, so
   ranking is identical to what was stored. */
const crypto = require("crypto");
const DIM = 768;
const CHUNK = 500, OVERLAP = 50;
const MAX_CHUNKS = 400, MAX_TEXT = 3_000_000;
const TTL_MS = 6 * 60 * 60 * 1000;

function ownerKey(raw) {
  const s = String(raw || "").replace(/[^A-Za-z0-9_.:-]/g, "");
  if (s && s.length >= 4) return s.slice(0, 120);
  return "guest:" + crypto.createHash("sha1").update(String(raw || "anon")).digest("hex").slice(0, 16);
}

/* ---- chunking: paragraph boundaries first, hard slice only when a paragraph is huge ---- */
function chunkText(text, opts) {
  const size = (opts && opts.size) || CHUNK;
  const overlap = (opts && opts.overlap) != null ? opts.overlap : OVERLAP;
  const src = String(text || "").replace(/\r\n/g, "\n").replace(/\u0000/g, "").trim();
  if (!src) return [];
  const paras = src.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const out = [];
  let buf = "";
  const push = () => {
    const t = buf.trim();
    if (t) out.push(t);
    buf = "";
  };
  for (const p of paras) {
    if (p.length > size) {
      push();
      for (let i = 0; i < p.length; i += size - overlap) {
        const seg = p.slice(i, i + size).trim();
        if (seg) out.push(seg);
        if (out.length >= MAX_CHUNKS) return out;
      }
      continue;
    }
    if ((buf + "\n\n" + p).length > size) push();
    buf = buf ? buf + "\n\n" + p : p;
    if (out.length >= MAX_CHUNKS) break;
  }
  push();
  /* a small tail attached to its neighbour beats a 40-char orphan chunk */
  if (out.length > 1 && out[out.length - 1].length < 80) {
    const tail = out.pop();
    out[out.length - 1] = (out[out.length - 1] + "\n\n" + tail).slice(0, size + 120);
  }
  return out.slice(0, MAX_CHUNKS);
}

/* ---- embeddings ---- */
function hashedVector(text) {
  /* offline fallback: word + 3-gram hashing into DIM buckets, L2-normalised.
     Not semantic, but it makes the lane functional without any provider key. */
  const v = new Float32Array(DIM);
  const t = String(text || "").toLowerCase().replace(/[^a-z0-9\u0900-\u097F\s]/g, " ");
  const words = t.split(/\s+/).filter(Boolean);
  const bump = (tok, w) => {
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) { h ^= tok.charCodeAt(i); h = Math.imul(h, 16777619); }
    v[(h >>> 0) % DIM] += w;
  };
  words.forEach(word => bump(word, 1));
  for (let i = 0; i < words.length - 2; i++) bump(words[i] + "_" + words[i + 1] + "_" + words[i + 2], 0.6);
  return v;
}
function quantise(vec) {
  const v = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  let max = 0;
  for (let i = 0; i < v.length; i++) max = Math.max(max, Math.abs(v[i]));
  const scale = max > 0 ? 127 / max : 1;
  const buf = Buffer.alloc(v.length);
  for (let i = 0; i < v.length; i++) buf[i] = Math.max(-127, Math.min(127, Math.round(v[i] * scale))) & 0xff;
  return buf;
}
function dequantise(buf) {
  const v = new Float32Array(buf.length);
  for (let i = 0; i < buf.length; i++) { const b = buf[i]; v[i] = (b > 127 ? b - 256 : b) / 127; }
  return v;
}
function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}
function normalise(vec) {
  let n = 0;
  for (let i = 0; i < vec.length; i++) n += vec[i] * vec[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / n;
  return out;
}

function createRag(opts) {
  const o = opts || {};
  const geminiKey = o.geminiKey || "";
  const db = o.db || null;               /* () => firestore instance or null */
  const cache = new Map();               /* owner → { files: Map(id→file), at } */
  const embedCache = new Map();          /* sha1(text) → Float32Array */
  const engine = { name: geminiKey ? "gemini" : "hashed", model: geminiKey ? "gemini-embedding-001" : "hashed-ngram", dim: DIM, downSince: 0 };

  async function embedBatch(texts) {
    const list = texts.map(t => String(t || "").slice(0, 8000));
    const out = new Array(list.length);
    const need = [];
    list.forEach((t, i) => {
      const k = crypto.createHash("sha1").update(t).digest("hex");
      const hit = embedCache.get(k);
      if (hit) out[i] = hit; else need.push({ i, t, k });
    });
    if (!need.length) return out;
    let done = false;
    /* the embedding model moved (text-embedding-004 → gemini-embedding-001); try the
       current id first, then the legacy one, then stay honest with hashed vectors */
    const models = ["gemini-embedding-001", "text-embedding-004"];
    if (geminiKey && Date.now() > engine.downSince) {
      for (const model of models) {
        try {
          const req = { model: "models/" + model, content: { parts: [{ text: "" }] }, taskType: "RETRIEVAL_DOCUMENT" };
          const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":batchEmbedContents?key=" + encodeURIComponent(geminiKey), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ requests: need.map(n => Object.assign({}, req, { content: { parts: [{ text: n.t }] } }, model === "gemini-embedding-001" ? { outputDimensionality: DIM } : {})) }),
            signal: AbortSignal.timeout(20_000)
          });
          if (r.ok) {
            const j = await r.json();
            const arr = j.embeddings || [];
            if (arr.length === need.length) {
              need.forEach((n, idx) => {
                const v = normalise(Float32Array.from(arr[idx].values || []));
                if (v.length) { out[n.i] = v; embedCache.set(n.k, v); }
              });
              done = true; engine.name = "gemini"; engine.model = model;
              break;
            }
          } else if (r.status !== 400 && r.status !== 404) {
            break; /* auth/ratelimit: retrying the other id will not help */
          }
        } catch (e) { break; /* network → fallback below */ }
      }
      if (!done) engine.downSince = Date.now() + 6 * 60 * 60_000;
    }
    if (!done || out.some(v => !v)) {
      need.forEach(n => {
        if (out[n.i]) return;
        const v = normalise(hashedVector(n.t));
        out[n.i] = v; embedCache.set(n.k, v);
        if (!done) engine.name = "hashed";
      });
    }
    if (embedCache.size > 4000) embedCache.clear();
    return out;
  }

  function bucket(owner) {
    const k = ownerKey(owner);
    let b = cache.get(k);
    if (!b) { b = { files: new Map(), at: Date.now() }; cache.set(k, b); }
    b.at = Date.now();
    return { key: k, bucket: b };
  }

  function fileDoc(owner, id) {
    if (!db) return null;
    try {
      const inst = typeof db === "function" ? db() : db;
      if (!inst) return null;
      return inst.collection("aura_rag").doc(ownerKey(owner)).collection("files").doc(id);
    } catch (e) { return null; }
  }

  async function warm(owner) {
    const { bucket: b } = bucket(owner);
    if (b.files.size || b.loaded) return b;
    if (!db) { b.loaded = true; return b; }
    try {
      const inst = typeof db === "function" ? db() : db;
      if (!inst) { b.loaded = true; return b; }
      const snap = await inst.collection("aura_rag").doc(ownerKey(owner)).collection("files").limit(30).get();
      snap.forEach(d => {
        const v = d.data() || {};
        const chunks = (v.chunks || []).map(c => ({ i: c.i, p: c.p, t: c.t, v: dequantise(Buffer.from(c.v || "", "base64")) }));
        if (chunks.length) b.files.set(d.id, { id: d.id, name: v.name || "document", pages: v.pages || 0, chunks, at: v.at || 0 });
      });
    } catch (e) { /* offline → memory only */ }
    b.loaded = true;
    return b;
  }

  async function addFile(owner, input) {
    const name = String((input && input.name) || "document").slice(0, 120);
    const text = String((input && input.text) || "").slice(0, MAX_TEXT);
    if (!text.trim()) throw new Error("empty document");
    const pieces = chunkText(text);
    if (!pieces.length) throw new Error("no readable text in this document");
    const pages = Math.max(1, parseInt(input && input.pages, 10) || 1);
    const vecs = await embedBatch(pieces);
    /* page numbers: proportional to the chunk's position in the document */
    const chunks = pieces.map((t, i) => ({
      i,
      /* a one-chunk document is page 1; otherwise map the chunk through the page count */
      p: pieces.length === 1 ? 1 : Math.max(1, Math.min(pages, Math.round(((i + 0.5) / pieces.length) * pages))),
      t,
      v: quantise(vecs[i])
    }));
    const id = crypto.createHash("sha1").update(ownerKey(owner) + "|" + name).digest("hex").slice(0, 16);
    const file = { id, name, pages, chunks, at: Date.now() };
    const { bucket: b } = bucket(owner);
    b.files.set(id, file); b.loaded = true;
    const doc = fileDoc(owner, id);
    if (doc) {
      try {
        await doc.set({
          name, pages, at: file.at, engine: engine.name,
          chunks: chunks.map(c => ({ i: c.i, p: c.p, t: c.t.slice(0, 1200), v: c.v.toString("base64") }))
        });
      } catch (e) { /* instance has no disk — memory copy still serves this session */ }
    }
    return { id, name, pages, chunks: chunks.length, engine: engine.model, dim: DIM };
  }

  async function list(owner) {
    const b = await warm(owner);
    return [...b.files.values()].map(f => ({ id: f.id, name: f.name, pages: f.pages, chunks: f.chunks.length, at: f.at }));
  }

  async function removeFile(owner, id) {
    const b = await warm(owner);
    const had = b.files.delete(id);
    const doc = fileDoc(owner, id);
    if (doc) { try { await doc.delete(); } catch (e) {} }
    return had;
  }

  async function removeAll(owner) {
    const b = await warm(owner);
    b.files.clear();
    const inst = (() => { try { return typeof db === "function" ? db() : db; } catch (e) { return null; } })();
    if (inst) {
      try {
        const snap = await inst.collection("aura_rag").doc(ownerKey(owner)).collection("files").listDocuments();
        await Promise.all(snap.map(d => d.delete().catch(() => {})));
      } catch (e) {}
    }
    return true;
  }

  const STOP = new Set("a an the is are was were do does did how what when where which who why of in on at to for from and or but with without about any some can could would should i my me you your it its this that these those hai kya kaise kitna kitne ka ki ke me se par aur ya nahi batao".split(" "));
  function words(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9\u0900-\u097F\s]/g, " ").split(/\s+/).filter(w => w.length > 2 && !STOP.has(w));
  }
  async function retrieve(owner, question, k) {
    const q = String(question || "").trim();
    if (!q) return [];
    const b = await warm(owner);
    if (!b.files.size) return [];
    const [qv] = await embedBatch([q]);
    const qw = [...new Set(words(q))];
    /* HYBRID: a semantic score alone is unreliable on the hashed fallback engine and
       still misses exact nouns (order ids, scheme names) even with Gemini vectors. The
       lexical overlap is what makes "refund policy" find the refund paragraph. */
    const minScore = engine.name === "gemini" ? 0.22 : 0.06;
    const scored = [];
    for (const f of b.files.values()) {
      for (const c of f.chunks) {
        const v = c.v instanceof Float32Array ? c.v : dequantise(Buffer.from(c.v || [], "base64"));
        const cw = new Set(words(c.t));
        let hit = 0; for (const w of qw) if (cw.has(w)) hit++;
        const overlap = qw.length ? hit / qw.length : 0;
        const score = cosine(qv, v) + 0.35 * overlap;
        if (score > minScore) scored.push({ file: f.name, page: c.p || 1, text: c.t, score });
      }
    }
    scored.sort((a, b2) => b2.score - a.score);
    const top = [], seen = new Set();
    for (const h of scored) {
      const sig = h.text.slice(0, 90);
      if (seen.has(sig)) continue;
      seen.add(sig); top.push(h);
      if (top.length >= Math.min(Math.max(parseInt(k, 10) || 5, 1), 10)) break;
    }
    return top;
  }

  /* prompt block — the same shape the browser used to build, now server-owned */
  function contextBlock(hits, limit) {
    if (!hits || !hits.length) return "";
    const cap = limit || 700;
    return "\n\nTHE USER'S OWN DOCUMENTS — excerpts from files THEY uploaded. When the question touches one of these, READ the excerpt and answer from it with your own understanding: explain it, solve the problem, connect the ideas — exactly as if you had read the document yourself. Cite file and page once, like [notes.pdf p.3]. If the excerpts don't cover the question, say that in one line and answer from your own knowledge:\n" +
      hits.map(h => "[ " + h.file + " · p." + h.page + " ] " + String(h.text || "").slice(0, cap)).join("\n---\n");
  }

  function stats() {
    const owners = [...cache.values()].reduce((n, b) => n + b.files.size, 0);
    return { owners: cache.size, files: owners, engine: engine.name, dim: DIM, persistent: !!db };
  }

  return { addFile, list, removeFile, removeAll, retrieve, contextBlock, stats, chunkText, engine };
}

module.exports = { createRag, chunkText, hashedVector, cosine, quantise, dequantise, ownerKey, DIM };

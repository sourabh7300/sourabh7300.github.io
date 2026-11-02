/* Measures time-to-first-token and total time on /v1/chat/stream.
   Usage: node _bench_stream.js [base] */
const BASE = process.argv[2] || "http://127.0.0.1:4799";

const CASES = [
  { name: "casual", messages: [{ role: "user", content: "hi bhai kaise ho" }] },
  { name: "stable-knowledge", messages: [{ role: "user", content: "what is a compiler in simple words" }] },
  { name: "fresh", messages: [{ role: "user", content: "latest AI news today" }] }
];

async function one(c) {
  const t0 = Date.now();
  let ttfb = 0, firstToken = 0, text = "";
  const r = await fetch(BASE + "/v1/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:8123" },
    body: JSON.stringify({ messages: c.messages, max_tokens: 400 }),
    signal: AbortSignal.timeout(60_000)
  });
  ttfb = Date.now() - t0;
  if (!String(r.headers.get("content-type")||"").includes("event-stream")) { const t = await r.text(); return { name: c.name, status: r.status, body: t.slice(0,120) }; }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const blocks = buf.split("\n\n");
    buf = blocks.pop() || "";
    for (const b of blocks) {
      const line = b.split("\n").find(l => l.startsWith("data:"));
      if (!line) continue;
      const s = line.slice(5).trim();
      if (!s || s === "[DONE]") continue;
      let j = null;
      try { j = JSON.parse(s); } catch (e) { continue; }
      if (!firstToken && j.delta) firstToken = Date.now() - t0;
      if (j.delta) text += j.delta;
    }
  }
  return { name: c.name, ttfb, firstToken: firstToken || -1, total: Date.now() - t0, chars: text.length, head: text.slice(0, 60).replace(/\s+/g, " ") };
}

(async () => {
  for (const c of CASES) {
    const a = await one(c);          // cold
    const b = await one(c);          // warm
    console.log(JSON.stringify({ ...a, warmFirstToken: b.firstToken, warmTotal: b.total, head: a.head || b.head }));
  }
})();

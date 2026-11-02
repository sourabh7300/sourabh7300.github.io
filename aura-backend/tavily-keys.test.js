/* Tavily key bank — regression test for the bank spliced into server.js.
   Run: node tavily-keys.test.js
   Covers the promises the bank makes: a daily budget that never overshoots the
   month, drain-vs-spread ordering, 429 cooldown skip, refunds, and a clean null
   (not a crash) when the bank is empty. */
const fs = require("fs");
const src = fs.readFileSync(__dirname + "/server.js", "utf8");
const start = src.indexOf("/* ============ TAVILY KEY BANK");
const provAt = src.indexOf("function searchProvider()", start);
if (start < 0 || provAt < 0) { console.error("FAIL: key bank not found in server.js"); process.exit(1); }
const block = src.slice(start, src.indexOf("}", src.indexOf('return "free";', provAt)) + 1);

function run(env) {
  Object.assign(process.env, env);
  return new Function(`
    const TODAY = () => new Date().toISOString().slice(0, 10);
    ${block}
    return { TAVILY_KEYS, tavPick, tavRefund, tavUsageReport, tavDailyBudget, tavDayUsed, tavCool, TAV_MONTHLY };
  `)();
}

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  → got " + JSON.stringify(extra) : "")); }
};

console.log("A. spread · 60 credits/month · 2 keys");
const A = run({ TAVILY_API_KEY: "AAAAfake1", TAVILY_API_KEY_2: "BBBBfake2", TAVILY_MONTHLY_CREDITS: "60", TAVILY_STRATEGY: "spread", TAVILY_RPM: "100" });
ok("both keys loaded", A.TAVILY_KEYS.length === 2, A.TAVILY_KEYS.length);
ok("budget splits 60 over the days left", A.tavDailyBudget("AAAAfake1") === Math.ceil(60 / new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 0)).getUTCDate()), A.tavDailyBudget("AAAAfake1"));
const picks = [];
for (let i = 0; i < 20; i++) { const k = A.tavPick(1); if (!k) break; picks.push(k.slice(0, 4)); }
ok("keys alternate (spread)", picks.length > 1 && picks[0] !== picks[1], picks.slice(0, 4));
ok("stops when the bank is spent", picks.length < 20, picks.length);
ok("todayLeft never negative", A.tavUsageReport().todayLeft >= 0, A.tavUsageReport().todayLeft);
ok("masked labels only", A.tavUsageReport().keys.every(k => /^t\d…/.test(k.id)), A.tavUsageReport().keys.map(k => k.id));

console.log("B. refund");
const B = run({ TAVILY_API_KEY: "CCCCfake3", TAVILY_API_KEY_2: "", TAVILY_MONTHLY_CREDITS: "60", TAVILY_STRATEGY: "spread", TAVILY_RPM: "100" });
const k1 = B.tavPick(1);
ok("credit charged", !!k1 && B.tavDayUsed(k1) === 1, k1 ? B.tavDayUsed(k1) : null);
B.tavRefund(k1, 1);
ok("refund returns it", B.tavDayUsed(k1) === 0, B.tavDayUsed(k1));

console.log("C. drain strategy");
const C = run({ TAVILY_API_KEY: "DDDDfake4", TAVILY_API_KEY_2: "EEEEfake5", TAVILY_MONTHLY_CREDITS: "60", TAVILY_STRATEGY: "drain", TAVILY_RPM: "100" });
const dayCap = C.tavDailyBudget("DDDDfake4");
const drain = [];
for (let i = 0; i < dayCap + 2; i++) { const k = C.tavPick(1); if (!k) break; drain.push(k.slice(0, 4)); }
ok("key 1 empties before key 2 is touched", drain.slice(0, dayCap).every(x => x === "DDDD") && drain[dayCap] === "EEEE", drain);

console.log("D. 429 cooldown");
const D = run({ TAVILY_API_KEY: "FFFFfake6", TAVILY_API_KEY_2: "GGGGfake7", TAVILY_MONTHLY_CREDITS: "60", TAVILY_STRATEGY: "spread", TAVILY_RPM: "100" });
D.tavCool.set("FFFFfake6", Date.now() + 60000);
const d1 = D.tavPick(1);
ok("cooling key skipped", d1 === "GGGGfake7", d1);

console.log("E. monthly cap");
const E = run({ TAVILY_API_KEY: "HHHHfake8", TAVILY_API_KEY_2: "", TAVILY_MONTHLY_CREDITS: "1", TAVILY_STRATEGY: "spread", TAVILY_RPM: "100" });
ok("first credit allowed", !!E.tavPick(1));
ok("second refused at the cap", E.tavPick(1) === null, E.tavPick(1));
ok("monthLeft clamps at 0", E.tavUsageReport().monthLeft === 0, E.tavUsageReport().monthLeft);

console.log("F. no keys");
const F = run({ TAVILY_API_KEY: "", TAVILY_API_KEY_2: "", TAVILY_MONTHLY_CREDITS: "1000" });
ok("null, not a crash", F.tavPick(1) === null);
ok("provider falls back to free", F.tavUsageReport().provider === "free", F.tavUsageReport().provider);

console.log("\n" + (fail ? "FAILED " + fail + " (" + pass + " passed)" : "all " + pass + " checks passed"));
process.exit(fail ? 1 : 0);

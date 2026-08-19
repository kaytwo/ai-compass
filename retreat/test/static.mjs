// Static + logic verification of the built app, without a browser.
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (scripts.length !== 1) throw new Error("expected exactly one inline script, got " + scripts.length);
const src = scripts[0];

// 1. does it parse?
new vm.Script(src, { filename: "app.js" });
console.log("parse: OK");

// 2. no leftover build placeholders
for (const p of ["/*__DATA__*/", "/*__APP__*/"]) {
  if (html.includes(p)) throw new Error("placeholder left in output: " + p);
}
console.log("placeholders: OK");

// 3. no external requests
const ext = [...html.matchAll(/(?:src|href)\s*=\s*["'](https?:)?\/\/[^"']+/g)].map((m) => m[0]);
console.log("external refs:", ext.length ? ext : "none");
if (ext.length) throw new Error("app is not self-contained");

// 3b. favicon must exist and be inline (an external one would break self-containment)
{
  const m = html.match(/<link rel="icon" href="(data:image\/svg\+xml,[^"]+)"/);
  if (!m) throw new Error("no inline favicon");
  const svg = decodeURIComponent(m[1].replace("data:image/svg+xml,", ""));
  if (!/^<svg[\s\S]*<\/svg>$/.test(svg.trim())) throw new Error("favicon is not a well-formed SVG");
  if (!/viewBox=/.test(svg)) throw new Error("favicon has no viewBox — it won't scale");
  console.log(`favicon: inline SVG, ${m[1].length} chars, decodes cleanly  OK`);
}

// 4. run the classifier from the BUILT file and compare against upstream's own scoring
//    for every archetype's seed, plus a set of real answer vectors.
const grab = (re) => src.match(re)[1];
const ctx = vm.createContext({});
vm.runInContext(
  `const QUESTIONS=${grab(/const QUESTIONS = (\[[\s\S]*?\n\]);/)};` +
    `const ARCHETYPES=${grab(/const ARCHETYPES = (\[[\s\S]*?\n\]);/)};` +
    `const SEEDS=${grab(/const SEEDS = (\[\[.*?\]\]);/)};` +
    `const ICOV=${grab(/const ICOV = (\[\[.*?\]\]);/)};` +
    src.match(/function mdist[\s\S]*?\n}/)[0] +
    src.match(/function seedIndex[\s\S]*?\n}/)[0] +
    src.match(/function score[\s\S]*?\n}/)[0] +
    `globalThis.API={QUESTIONS,ARCHETYPES,SEEDS,seedIndex,score};`,
  ctx
);
const { QUESTIONS, ARCHETYPES, SEEDS, seedIndex, score } = ctx.API;

let bad = 0;
SEEDS.forEach((s, i) => { if (seedIndex(s[0], s[1]) !== i) bad++; });
console.log(`seed self-classification: ${SEEDS.length - bad}/${SEEDS.length} correct`);
if (bad) throw new Error("classifier disagrees with its own seeds");

// upstream's computeScores, transcribed, must agree with our score()
function upstreamScore(answers) {
  let iSum = 0, vSum = 0, n = 0;
  for (const [qIdx, optIdx] of Object.entries(answers)) {
    const opt = QUESTIONS[parseInt(qIdx)].options[optIdx];
    iSum += opt.impact; vSum += opt.valence; n++;
  }
  if (n === 0) return { impact: 0, valence: 0 };
  return { impact: iSum / n, valence: vSum / n };
}

// (a) single-selection answers must score EXACTLY as upstream does
let mismatches = 0, seen = new Set();
for (let t = 0; t < 20000; t++) {
  const single = {}, wrapped = {};
  QUESTIONS.forEach((q, j) => {
    if (Math.random() < 0.15) return; // exercise skipping too
    const k = Math.floor(Math.random() * q.options.length);
    single[j] = k;
    wrapped[j] = [k];
  });
  const mine = score(wrapped), theirs = upstreamScore(single);
  if (Math.abs(mine.impact - theirs.impact) > 1e-12 || Math.abs(mine.valence - theirs.valence) > 1e-12) mismatches++;
  if (mine.n) seen.add(seedIndex(mine.impact, mine.valence));
}
console.log(`single-select scoring vs upstream over 20000 answer sets: ${mismatches} mismatches`);
if (mismatches) throw new Error("scoring diverged from upstream on single selections");
console.log(`archetypes reached in that sample: ${seen.size}/${ARCHETYPES.length}`);

// (b) multi-select must average, and "none" must not contribute
{
  const q0 = QUESTIONS[0].options;
  const both = score({ 0: [0, 1] });
  const expectI = (q0[0].impact + q0[1].impact) / 2;
  if (Math.abs(both.impact - expectI) > 1e-12) throw new Error("multi-select did not average");
  if (both.n !== 1) throw new Error("multi-select should still count as one question");
  console.log(`multi-select averages: [0,1] -> impact ${both.impact} (expected ${expectI})  OK`);

  const withNone = score({ 0: [0], 1: "none" });
  const only = score({ 0: [0] });
  if (withNone.impact !== only.impact || withNone.n !== only.n) throw new Error('"none" leaked into the score');
  console.log(`"none of these" contributes nothing to the score  OK`);

  if (score({ 0: "none" }).n !== 0) throw new Error("all-none should score nothing");
  const src2 = src;
  if (!/function addressed/.test(src2)) throw new Error("addressed() missing");
  console.log(`all-"none" yields no score  OK`);
}

// 4b. permalink encoding must round-trip every answer shape, including
//     multi-select, "none", and skipped questions
{
  const ctx2 = vm.createContext({ btoa: (s) => Buffer.from(s, "binary").toString("base64"),
                                  atob: (s) => Buffer.from(s, "base64").toString("binary") });
  vm.runInContext(
    `const QUESTIONS=${grab(/const QUESTIONS = (\[[\s\S]*?\n\]);/)};` +
      `const NONE="none";const NONE_BYTE=0xff;` +
      src.match(/function encodeAnswers[\s\S]*?\n}/)[0] +
      src.match(/function decodeAnswers[\s\S]*?\n}/)[0] +
      `globalThis.P={encodeAnswers,decodeAnswers};`,
    ctx2
  );
  const { encodeAnswers, decodeAnswers } = ctx2.P;

  const norm = (a) => JSON.stringify(Object.keys(a).sort((x, y) => x - y).map((k) => [k, a[k]]));
  let fails = 0, maxLen = 0;
  for (let t = 0; t < 5000; t++) {
    const a = {};
    QUESTIONS.forEach((q, j) => {
      const r = Math.random();
      if (r < 0.15) return;                       // skipped
      if (r < 0.25) { a[j] = "none"; return; }    // none of these
      const picks = [];
      for (let i = 0; i < q.options.length; i++) if (Math.random() < 0.35) picks.push(i);
      if (!picks.length) picks.push(Math.floor(Math.random() * q.options.length));
      a[j] = picks;
    });
    const enc = encodeAnswers(a);
    maxLen = Math.max(maxLen, enc.length);
    if (norm(decodeAnswers(enc)) !== norm(a)) fails++;
  }
  console.log(`permalink round-trip over 5000 answer sets: ${fails} failures, max ${maxLen} chars`);
  if (fails) throw new Error("permalink encoding does not round-trip");

  for (const junk of ["", "!!!!", "zzzz", "AAAA", "a".repeat(500)]) {
    const r = decodeAnswers(junk);
    if (r !== null && typeof r !== "object") throw new Error("decode returned junk for " + JSON.stringify(junk));
  }
  console.log("malformed permalinks rejected safely  OK");
}

// 5. localStorage keys are room-scoped (no cross-room bleed)
// solo answers must not share a storage scope with any room's
if (!/KEY = \(k\) => "aicompass:v\d+:" \+ \(ROOM \|\| "solo"\)/.test(src)) {
  throw new Error("storage keys not room-scoped/versioned");
}
console.log("room-scoped storage (solo kept separate): OK");

// nothing may be posted to the server without a room
if (!/async function submit\(\) \{\s*\n\s*if \(!ROOM\) return;/.test(src)) {
  throw new Error("submit() does not guard on ROOM — solo answers could leak to the server");
}
console.log("solo answers never posted: OK");

// 6. retention window — a deliberate figure, not an accident of editing
{
  const worker = fs.readFileSync(new URL("../src/worker.js", import.meta.url), "utf8");
  const days = Number((worker.match(/RETENTION_DAYS = (\d+)/) || [])[1]);
  if (days !== 30) throw new Error("retention window is " + days + " days, expected 30");
  if (!/DELETE FROM entries WHERE updated_at < \?1/.test(worker)) {
    throw new Error("retention sweep query missing or changed shape");
  }
  console.log(`retention: ${days} days, swept by updated_at  OK`);
}

console.log("\nAll static checks passed.");

#!/usr/bin/env node
/**
 * Refit the AI Compass classifier constants (SEEDS, ICOV, VIEW).
 *
 * Why this exists: index.html says those constants were "Built by ai_sim.py",
 * but that script was never published. Without it nobody can change the
 * question set — adding or editing an option shifts the population distribution
 * the constants were fit against, silently decalibrating the classifier. This
 * is a reconstruction of that pipeline so the quiz content can evolve again.
 *
 * The pipeline, matching what index.html's comments describe:
 *
 *   1. Simulate a population of coherent respondents (people answer in a way
 *      correlated across questions; uniform-random answering is not a
 *      population, it's noise).
 *   2. Score each respondent with the LIVE formula: the mean of the chosen
 *      options' (impact, valence).
 *   3. ICOV = inverse of the population covariance. This whitens the cloud,
 *      which is what stops the strong impact/valence correlation from
 *      collapsing every territory into a diagonal band.
 *   4. Seed each archetype at the centroid of the respondents who fall in its
 *      original `bounds` rectangle (the hand-authored concept anchors),
 *      with the rectangle mapped onto the population by quantile.
 *   5. Classify by nearest seed under the Mahalanobis metric.
 *
 * Usage:
 *   node tools/fit-seeds.mjs                 # fit, print diagnostics, don't write
 *   node tools/fit-seeds.mjs --write         # also splice the constants into index.html
 *   node tools/fit-seeds.mjs --n 400000      # bigger population
 *   node tools/fit-seeds.mjs --file path.html
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// ---- args ----

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf("--" + name);
  return i === -1 ? fallback : argv[i + 1];
};
const N = +flag("n", 200000);
const SEED = +flag("seed", 20260806);
const WRITE = argv.includes("--write");
// --evaluate scores the constants ALREADY SHIPPED in the file against the same
// simulated population, so shipped and refit can be compared like for like.
const EVALUATE = argv.includes("--evaluate");
const TARGET = path.resolve(flag("file", path.join(here, "..", "index.html")));

// ---- deterministic RNG so refits are reproducible ----

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
function gauss() {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---- load quiz content ----

const html = fs.readFileSync(TARGET, "utf8");
const grab = (re, label) => {
  const m = html.match(re);
  if (!m) throw new Error(`could not find ${label} in ${TARGET}`);
  return m[1];
};
const QUESTIONS = new Function(`return ${grab(/const QUESTIONS = (\[[\s\S]*?\n\]);/, "QUESTIONS")}`)();
const ARCHETYPES = new Function(`return ${grab(/const ARCHETYPES = (\[[\s\S]*?\n\]);/, "ARCHETYPES")}`)();

for (const [i, a] of ARCHETYPES.entries()) {
  if (!Array.isArray(a.bounds) || a.bounds.length !== 4) {
    throw new Error(`archetype ${i} (${a.name}) has no usable bounds rectangle`);
  }
}

// ---- 1. simulate a coherent population ----
//
// Each respondent has a latent disposition (tx, ty) in option-space. For each
// question they pick among that question's options with probability falling off
// with distance from their disposition — so a person who thinks AI is overhyped
// and bad tends to pick overhyped-and-bad options throughout, which is what
// makes the population a cloud with structure rather than a blob at the origin.
//
// TEMP controls coherence: 0 would make everyone a perfect ideologue, large
// values would make everyone random. LATENT_SD sets how spread out dispositions
// are. Both are chosen so the resulting cloud's extent matches the shipped VIEW.

const TEMP = +flag("temp", 2.8);
const LATENT_SD = +flag("spread", 4.6);
const SKIP_RATE = +flag("skip", 0.06);
// --multi models the proposed multi-select: with this probability a respondent
// picks two options for a question instead of one, contributing their average.
// Averaging pulls each answer toward the question's centroid, so this shrinks
// the population cloud — the point of the flag is to measure how much.
const MULTI_RATE = +flag("multi", 0);

const xs = new Float64Array(N);
const ys = new Float64Array(N);

for (let p = 0; p < N; p++) {
  const tx = gauss() * LATENT_SD;
  const ty = gauss() * LATENT_SD;
  let iSum = 0, vSum = 0, n = 0;

  for (const q of QUESTIONS) {
    if (rand() < SKIP_RATE) continue;
    const opts = q.options;
    let total = 0;
    const w = new Array(opts.length);
    for (let k = 0; k < opts.length; k++) {
      const dx = opts[k].impact - tx, dy = opts[k].valence - ty;
      w[k] = Math.exp(-(dx * dx + dy * dy) / (2 * TEMP * TEMP));
      total += w[k];
    }
    const draw = () => {
      let r = rand() * total;
      for (let k = 0; k < opts.length; k++) { r -= w[k]; if (r <= 0) return k; }
      return opts.length - 1;
    };
    const pick = draw();

    if (MULTI_RATE > 0 && opts.length > 1 && rand() < MULTI_RATE) {
      let second = draw();
      if (second === pick) second = (pick + 1) % opts.length;
      iSum += (opts[pick].impact + opts[second].impact) / 2;
      vSum += (opts[pick].valence + opts[second].valence) / 2;
    } else {
      iSum += opts[pick].impact; vSum += opts[pick].valence;
    }
    n++;
  }

  if (n === 0) { p--; continue; } // vanishingly rare; redraw
  xs[p] = iSum / n;
  ys[p] = vSum / n;
}

// ---- 2. population covariance -> ICOV ----

let mx = 0, my = 0;
for (let i = 0; i < N; i++) { mx += xs[i]; my += ys[i]; }
mx /= N; my /= N;

let sxx = 0, syy = 0, sxy = 0;
for (let i = 0; i < N; i++) {
  const dx = xs[i] - mx, dy = ys[i] - my;
  sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
}
sxx /= N - 1; syy /= N - 1; sxy /= N - 1;

const det = sxx * syy - sxy * sxy;
if (!(Math.abs(det) > 1e-12)) throw new Error("population covariance is singular");
const FITTED_ICOV = [
  [syy / det, -sxy / det],
  [-sxy / det, sxx / det],
];

const shipped = {
  SEEDS: (() => { const m = html.match(/const SEEDS\s*=\s*(\[\[[\s\S]*?\]\]);/); return m ? new Function(`return ${m[1]}`)() : null; })(),
  ICOV: (() => { const m = html.match(/const ICOV\s*=\s*(\[\[[\s\S]*?\]\]);/); return m ? new Function(`return ${m[1]}`)() : null; })(),
};

if (EVALUATE && (!shipped.SEEDS || !shipped.ICOV)) {
  throw new Error("--evaluate needs SEEDS and ICOV already present in the file");
}

// Diagnostics below run against whichever constants we're judging.
const ICOV = EVALUATE ? shipped.ICOV : FITTED_ICOV;

const mdist = (x, y, sx, sy) => {
  const dx = x - sx, dy = y - sy;
  return dx * (ICOV[0][0] * dx + ICOV[0][1] * dy) + dy * (ICOV[1][0] * dx + ICOV[1][1] * dy);
};

// ---- 3. map the hand-authored bounds rectangles onto the population ----
//
// bounds are authored on a notional -10..10 scale; the realized scores live on a
// narrower, off-center range. Map by quantile on each axis independently so the
// rectangles keep their relative arrangement while covering the actual cloud.

const sortedX = Float64Array.from(xs).sort();
const sortedY = Float64Array.from(ys).sort();
const quantile = (sorted, q) => {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
};
const toScore = (sorted, v) => quantile(sorted, (Math.max(-10, Math.min(10, v)) + 10) / 20);

const rects = ARCHETYPES.map((a) => {
  const [i0, i1, v0, v1] = a.bounds;
  return { x0: toScore(sortedX, i0), x1: toScore(sortedX, i1), y0: toScore(sortedY, v0), y1: toScore(sortedY, v1) };
});

// ---- 4. seed = centroid of the respondents in each rectangle ----

const sums = ARCHETYPES.map(() => ({ x: 0, y: 0, n: 0 }));
for (let i = 0; i < N; i++) {
  const x = xs[i], y = ys[i];
  // a point can satisfy several rectangles (they overlap); credit the one whose
  // centre it is closest to, so seeds stay separated
  let best = -1, bestD = Infinity;
  for (let a = 0; a < rects.length; a++) {
    const r = rects[a];
    if (x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1) continue;
    const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2;
    const d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
    if (d < bestD) { bestD = d; best = a; }
  }
  if (best >= 0) { sums[best].x += x; sums[best].y += y; sums[best].n++; }
}

const empty = [];
const FITTED_SEEDS = ARCHETYPES.map((a, i) => {
  const s = sums[i];
  if (s.n === 0) {
    empty.push(a.name);
    // fall back to the rectangle's centre so the archetype still has a position
    return [(rects[i].x0 + rects[i].x1) / 2, (rects[i].y0 + rects[i].y1) / 2];
  }
  return [+(s.x / s.n).toFixed(4), +(s.y / s.n).toFixed(4)];
});

const SEEDS = EVALUATE ? shipped.SEEDS : FITTED_SEEDS;

const seedIndex = (x, y) => {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < SEEDS.length; i++) {
    const d = mdist(x, y, SEEDS[i][0], SEEDS[i][1]);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
};

// ---- 5. VIEW: the display window, trimmed to where people actually land ----

const VIEW = [
  +quantile(sortedX, 0.001).toFixed(2), +quantile(sortedX, 0.999).toFixed(2),
  +quantile(sortedY, 0.001).toFixed(2), +quantile(sortedY, 0.999).toFixed(2),
];

// ---- diagnostics ----

const counts = new Array(ARCHETYPES.length).fill(0);
for (let i = 0; i < N; i++) counts[seedIndex(xs[i], ys[i])]++;

// is every archetype actually attainable by some real answer combination?
const unreachable = [];
for (let a = 0; a < ARCHETYPES.length; a++) {
  const pick = QUESTIONS.map(() => 0);
  const mean = () => {
    let sx = 0, sy = 0;
    QUESTIONS.forEach((q, j) => { sx += q.options[pick[j]].impact; sy += q.options[pick[j]].valence; });
    return [sx / QUESTIONS.length, sy / QUESTIONS.length];
  };
  for (let it = 0; it < 80; it++) {
    let moved = false;
    for (let j = 0; j < QUESTIONS.length; j++) {
      let bestK = pick[j], bestD = Infinity;
      for (let k = 0; k < QUESTIONS[j].options.length; k++) {
        pick[j] = k;
        const [x, y] = mean();
        const d = mdist(x, y, SEEDS[a][0], SEEDS[a][1]);
        if (d < bestD) { bestD = d; bestK = k; }
      }
      if (bestK !== pick[j]) moved = true;
      pick[j] = bestK;
    }
    if (!moved) break;
  }
  const [x, y] = mean();
  if (seedIndex(x, y) !== a) unreachable.push({ name: ARCHETYPES[a].name, lands: ARCHETYPES[seedIndex(x, y)].name });
}

console.log(`population: ${N.toLocaleString()} simulated respondents over ${QUESTIONS.length} questions, ${ARCHETYPES.length} archetypes`);
console.log(`params: temp=${TEMP} spread=${LATENT_SD} skip=${SKIP_RATE} seed=${SEED}`);
console.log(`\ncovariance: sxx=${sxx.toFixed(4)} syy=${syy.toFixed(4)} sxy=${sxy.toFixed(4)}  (corr ${(sxy / Math.sqrt(sxx * syy)).toFixed(3)})`);
console.log(`VIEW: [${VIEW.join(", ")}]`);

if (empty.length) console.log(`\nWARNING: no simulated respondent fell in the bounds of: ${empty.join(", ")}`);
if (unreachable.length) {
  console.log(`\nWARNING: ${unreachable.length} archetype(s) unreachable by any answer combination:`);
  for (const u of unreachable) console.log(`  ${u.name}  ->  lands on ${u.lands}`);
} else {
  console.log(`\nreachability: all ${ARCHETYPES.length} archetypes attainable by some answer combination`);
}

console.log("\nshare of the simulated population by archetype:");
ARCHETYPES.map((a, i) => [a.name, counts[i] / N])
  .sort((p, q) => q[1] - p[1])
  .forEach(([name, share]) => console.log(`  ${(share * 100).toFixed(2).padStart(6)}%  ${name}`));

const shares = counts.map((c) => c / N);
const gini = (() => {
  const s = shares.slice().sort((a, b) => a - b);
  let cum = 0, weighted = 0;
  s.forEach((v, i) => { cum += v; weighted += (i + 1) * v; });
  return (2 * weighted) / (s.length * cum) - (s.length + 1) / s.length;
})();
console.log(`\nconcentration (Gini over archetype shares): ${gini.toFixed(3)}  — 0 = perfectly even, 1 = winner-take-all`);

// how far did the refit land from the constants currently shipped?
if (!EVALUATE && shipped.SEEDS && shipped.SEEDS.length === FITTED_SEEDS.length) {
  let sum = 0, worst = 0, worstName = "";
  FITTED_SEEDS.forEach((s, i) => {
    const d = Math.hypot(s[0] - shipped.SEEDS[i][0], s[1] - shipped.SEEDS[i][1]);
    sum += d;
    if (d > worst) { worst = d; worstName = ARCHETYPES[i].name; }
  });
  console.log(`\nagreement with the shipped SEEDS: mean drift ${(sum / FITTED_SEEDS.length).toFixed(3)}, worst ${worst.toFixed(3)} (${worstName})`);
  console.log(`shipped ICOV [[${shipped.ICOV[0].map((v) => v.toFixed(4))}],[${shipped.ICOV[1].map((v) => v.toFixed(4))}]]`);
  console.log(`fitted  ICOV [[${FITTED_ICOV[0].map((v) => v.toFixed(4))}],[${FITTED_ICOV[1].map((v) => v.toFixed(4))}]]`);
}

// ---- output ----

const fmt = (v) => (Array.isArray(v) ? `[${v.map(fmt).join(",")}]` : String(v));
const block =
  `const SEEDS=${fmt(FITTED_SEEDS)};\n` +
  `const ICOV=[[${FITTED_ICOV[0][0].toFixed(6)}, ${FITTED_ICOV[0][1].toFixed(6)}], [${FITTED_ICOV[1][0].toFixed(6)}, ${FITTED_ICOV[1][1].toFixed(6)}]];\n` +
  `const VIEW=${fmt(VIEW)};`;

if (EVALUATE) {
  console.log("\n(--evaluate: judged the constants already in the file; nothing was fitted or written)");
} else if (WRITE) {
  if (unreachable.length) {
    console.error(`\nrefusing to --write: ${unreachable.length} archetype(s) would be unreachable. Adjust the questions or the bounds first.`);
    process.exit(1);
  }
  let out = html;
  out = out.replace(/const SEEDS=\[\[[\s\S]*?\]\];/, () => block.split("\n")[0]);
  out = out.replace(/const ICOV=\[\[[\s\S]*?\]\];/, () => block.split("\n")[1]);
  out = out.replace(/const VIEW=\[[^\]]*\];/, () => block.split("\n")[2]);
  if (out === html) throw new Error("could not splice constants — the declarations did not match");
  fs.writeFileSync(TARGET, out);
  console.log(`\nwrote new constants into ${path.relative(process.cwd(), TARGET)}`);
} else {
  console.log("\n" + block);
  console.log("\n(run again with --write to splice these into index.html)");
}

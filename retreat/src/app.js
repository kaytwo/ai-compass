"use strict";
// The AI Compass — retreat edition. No framework, no CDN, no build-time network access.
// Quiz content and classifier constants are injected verbatim from ../index.html by build.mjs.

/*__DATA__*/

// ---- classifier (unchanged from upstream: nearest seed in the Mahalanobis metric) ----

function mdist(x, y, sx, sy) {
  const dx = x - sx, dy = y - sy;
  return dx * (ICOV[0][0] * dx + ICOV[0][1] * dy) + dy * (ICOV[1][0] * dx + ICOV[1][1] * dy);
}

function seedIndex(x, y) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < SEEDS.length; i++) {
    const d = mdist(x, y, SEEDS[i][0], SEEDS[i][1]);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// An answer is an array of chosen option indices, or NONE for "none of these".
// Picking several averages them, so a question contributes one point either way
// and a single selection scores exactly as upstream does.
const NONE = "none";

function score(answers) {
  let iSum = 0, vSum = 0, n = 0;
  for (const qIdx of Object.keys(answers)) {
    const picks = answers[qIdx];
    if (!Array.isArray(picks) || !picks.length) continue; // unanswered, or NONE
    const opts = QUESTIONS[+qIdx].options;
    let qi = 0, qv = 0, m = 0;
    for (const p of picks) {
      const opt = opts[p];
      if (!opt) continue;
      qi += opt.impact; qv += opt.valence; m++;
    }
    if (!m) continue;
    iSum += qi / m; vSum += qv / m; n++;
  }
  if (!n) return { impact: 0, valence: 0, n: 0 };
  return { impact: iSum / n, valence: vSum / n, n };
}

// how many questions the person has engaged with (a deliberate "none" counts)
function addressed(answers) {
  return Object.keys(answers).filter((k) => {
    const v = answers[k];
    return v === NONE || (Array.isArray(v) && v.length > 0);
  }).length;
}

// ---- reference-point links ----
//
// Kept here rather than in ../index.html so that file stays byte-identical to
// upstream. Keyed by ARCHETYPES[].person; build.mjs fails if any is missing.
// Preference: the person's own primary site where that's what they're known
// for, Wikipedia where there's no reachable personal site or it blocks readers.
const REFERENCE_LINKS = {
  "Emily Bender": "https://faculty.washington.edu/ebender/",
  "Jaron Lanier": "https://www.jaronlanier.com/",
  "Dan Luu": "https://danluu.com/",
  "Holly Herndon": "https://en.wikipedia.org/wiki/Holly_Herndon",
  "Sam Kriss": "https://samkriss.substack.com/",
  "Cal Newport": "https://calnewport.com/",
  "Cartoons Hate Her": "https://www.cartoonshateher.com/",
  "Cory Doctorow": "https://pluralistic.net/",
  "Ed Zitron": "https://www.wheresyoured.at/",
  "Matt Levine": "https://en.wikipedia.org/wiki/Matt_Levine",
  "Kara Swisher": "https://en.wikipedia.org/wiki/Kara_Swisher",
  "Aella": "https://knowingless.com/",
  "Katja Grace": "https://aiimpacts.org/author/katja/",
  "Molly White": "https://www.mollywhite.net/",
  "Kelsey Piper": "https://www.vox.com/authors/kelsey-piper",
  "Ethan Mollick": "https://www.oneusefulthing.org/",
  "Matt Yglesias": "https://www.slowboring.com/",
  "Simon Willison": "https://simonwillison.net/",
  "Paul Graham": "https://paulgraham.com/",
  "Peter Thiel": "https://en.wikipedia.org/wiki/Peter_Thiel",
  "Ezra Klein": "https://www.nytimes.com/by/ezra-klein",
  "kontextmaschine": "https://kontextmaschine.tumblr.com/",
  "Amanda Askell": "https://askell.io/",
  "Marc Andreessen": "https://pmarca.substack.com/",
  "Robin Hanson": "https://www.overcomingbias.com/",
  "Eliezer Yudkowsky": "https://en.wikipedia.org/wiki/Eliezer_Yudkowsky",
  "Connor Leahy": "https://www.conjecture.dev/",
  "Sam Altman": "https://blog.samaltman.com/",
  "Lex Fridman": "https://lexfridman.com/",
  "Ray Kurzweil": "https://www.thekurzweillibrary.com/",
};

function referenceLink(person) {
  const href = REFERENCE_LINKS[person];
  const label = el("span", { text: person });
  if (!href) return label;
  return el("a", { href, target: "_blank", rel: "noopener noreferrer", class: "saintlink", text: person });
}

// ---- answer permalinks ----
//
// One byte per question: 0 = unanswered, 0xff = "none of these", otherwise a
// bitmask of the chosen option indices. Base64url'd, so a full answer set is
// ~20 characters and rides in the fragment — it never reaches the server.

const NONE_BYTE = 0xff;

function encodeAnswers(answers) {
  const bytes = new Uint8Array(QUESTIONS.length);
  for (let q = 0; q < QUESTIONS.length; q++) {
    const v = answers[q];
    if (v === NONE) { bytes[q] = NONE_BYTE; continue; }
    if (!Array.isArray(v) || !v.length) continue;
    let mask = 0;
    for (const i of v) if (i >= 0 && i < 7) mask |= 1 << i;
    bytes[q] = mask;
  }
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeAnswers(str) {
  try {
    const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    if (bin.length !== QUESTIONS.length) return null;
    const answers = {};
    for (let q = 0; q < QUESTIONS.length; q++) {
      const b = bin.charCodeAt(q);
      if (b === 0) continue;
      if (b === NONE_BYTE) { answers[q] = NONE; continue; }
      const picks = [];
      for (let i = 0; i < QUESTIONS[q].options.length; i++) if (b & (1 << i)) picks.push(i);
      if (picks.length) answers[q] = picks;
    }
    return answers;
  } catch (e) {
    return null; // malformed link; fall back to a fresh start
  }
}

function shareUrl(answers) {
  const u = new URL(location.href);
  u.hash = "a=" + encodeAnswers(answers);
  return u.toString();
}

// ---- room + identity ----

const ADJECTIVES = ["Amber", "Brisk", "Candid", "Dapper", "Eager", "Fleet", "Gentle", "Hazel",
  "Ivory", "Jolly", "Keen", "Lucid", "Mellow", "Nimble", "Opal", "Placid", "Quiet", "Russet",
  "Solemn", "Tidy", "Umber", "Velvet", "Wry", "Zesty"];
const ANIMALS = ["Otter", "Heron", "Marten", "Falcon", "Badger", "Lynx", "Puffin", "Ibex",
  "Raven", "Seal", "Tapir", "Vole", "Wren", "Yak", "Bison", "Crane", "Dormouse", "Egret",
  "Ferret", "Gannet", "Hare", "Jackdaw", "Kestrel", "Loon"];

function anonHandle() {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const b = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  return a + " " + b;
}

function roomFromUrl() {
  const p = new URLSearchParams(location.search);
  const raw = (p.get("room") || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(raw) ? raw : "";
}

// Taking the quiz is the default; joining a group is opt-in. A room only exists
// if the URL named one (a shared invite link) or the person chose to share
// afterwards, so nothing is attributed to anyone until they ask for it.
const URL_ROOM = roomFromUrl();
const IS_BOARD = new URLSearchParams(location.search).has("board");

// v4: skipping is no longer allowed, so part-finished v3 state is invalid.
// (v3 gave solo answers their own storage scope, separate from any room.)
let ROOM = URL_ROOM;
const KEY = (k) => "aicompass:v4:" + (ROOM || "solo") + ":" + k;

function load(k, fallback) {
  try {
    const v = localStorage.getItem(KEY(k));
    return v === null ? fallback : JSON.parse(v);
  } catch (e) { return fallback; }
}
function save(k, v) {
  try { localStorage.setItem(KEY(k), JSON.stringify(v)); } catch (e) { /* private mode */ }
}

// ---- state ----

// A shared link (#a=...) wins over whatever this browser had saved, so opening
// someone else's result shows theirs rather than silently resuming yours.
const linked = location.hash.startsWith("#a=") ? decodeAnswers(location.hash.slice(3)) : null;

const state = {
  // With a room in the URL you land in that room's flow; without one you go
  // straight into the quiz (or back to your own saved result).
  view: ROOM
    ? (IS_BOARD ? "board" : (linked || load("answers", null) ? "result" : "intro"))
    : (linked || load("answers", null) ? "result" : "quiz"),
  // An invite link already says "I want to be on this board" — but the name
  // is still asked for at the end, once you can see what it goes next to.
  joining: !!URL_ROOM,
  name: load("name", "") || anonHandle(),
  nameWasLoaded: !!load("name", ""),
  answers: linked || load("answers", null) || {},
  // A linked result belongs to whoever sent it, so don't offer to post it to the
  // board under this browser's identity until the viewer takes it themselves.
  fromLink: !!linked,
  current: 0,
  entryId: load("entryId", null),
  others: [],
  hover: null,          // id of the respondent dot under the pointer
  region: null,         // {x, y, idx} of the territory under the pointer
  highlightIdx: -1,     // archetype to emphasise on the all-points map
  backTo: "result",
  status: "",
  statusErr: false,
  submitting: false,
};

// ---- API ----

async function api(method, path, body) {
  const res = await fetch("/api/room/" + encodeURIComponent(ROOM) + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { /* non-JSON error page */ }
  if (!res.ok) throw new Error((data && data.error) || ("HTTP " + res.status));
  return data;
}

// True exactly when the join form's inputs are on screen. state.joining alone
// isn't enough: it defaults to true for invite links, including on the board.
function joinFormOpen() {
  return state.joining && state.view === "result" && !state.fromLink && !state.entryId;
}

// Insert or replace an entry in the local board without waiting for a re-list.
function mergeEntry(entry) {
  const rest = state.others.filter((e) => e.id !== entry.id);
  rest.push(entry);
  rest.sort((a, b) => (a.t || 0) - (b.t || 0));
  state.others = rest;
}

async function refresh() {
  if (!ROOM) return;
  try {
    const data = await api("GET", "");
    // D1 is strongly consistent, so a read after our own write always contains
    // it — no need to defend against a read that's missing our entry (the KV
    // version had to pin it locally).
    state.others = data.entries || [];
    if (state.status && state.statusErr) { state.status = ""; state.statusErr = false; }
  } catch (e) {
    state.status = "Can't reach the board (" + e.message + "). Retrying…";
    state.statusErr = true;
  }
  // Rendering rebuilds the join form's inputs, so a 4s poll landing mid-typing
  // would wipe a half-entered name. The counts catch up on the next poll.
  if (!joinFormOpen()) render();
}

async function submit() {
  if (!ROOM) return; // solo: nothing is ever sent
  const { impact, valence, n } = score(state.answers);
  if (!n) return;
  state.submitting = true;
  state.status = "Saving…";
  state.statusErr = false;
  render();
  try {
    const data = await api("POST", "", {
      id: state.entryId || undefined,
      name: state.name,
      i: impact,
      v: valence,
      a: seedIndex(impact, valence),
    });
    state.entryId = data.id;
    save("entryId", data.id);
    // Show yourself without waiting for the next poll. The write response
    // already carries the stored row, so this is just avoiding a round trip.
    if (data.entry) mergeEntry(data.entry);
    state.status = "Saved. You're on the board.";
  } catch (e) {
    state.status = "Couldn't save: " + e.message;
    state.statusErr = true;
  }
  state.submitting = false;
  render();
  refresh();
}

// ---- chart ----

const CHART_PAD = 44;

function drawChart(canvas, opts) {
  const size = opts.size;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width = size + "px";
  canvas.style.height = size + "px";
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const pad = CHART_PAD, plot = size - pad * 2;
  const [vx0, vx1, vy0, vy1] = VIEW;
  const xS = (v) => pad + ((v - vx0) / (vx1 - vx0)) * plot;
  const yS = (v) => pad + ((vy1 - v) / (vy1 - vy0)) * plot;
  const xI = (px) => vx0 + ((px - pad) / plot) * (vx1 - vx0);
  const yI = (py) => vy1 - ((py - pad) / plot) * (vy1 - vy0);

  ctx.fillStyle = "#1a1a2e";
  ctx.fillRect(0, 0, size, size);

  const hoveredRegionIdx = opts.region ? opts.region.idx : -1;
  const STEP = 5;
  for (let py = pad; py < pad + plot; py += STEP) {
    for (let px = pad; px < pad + plot; px += STEP) {
      const i = seedIndex(xI(px + STEP / 2), yI(py + STEP / 2));
      ctx.fillStyle = ARCHETYPES[i].color;
      // the territory under the pointer lights up, so the label has something
      // to point at rather than naming an invisible boundary
      ctx.globalAlpha = i === hoveredRegionIdx ? 0.62
        : i === opts.highlightIdx ? 0.5
        : (opts.big ? 0.26 : 0.2);
      ctx.fillRect(px, py, STEP, STEP);
    }
  }
  ctx.globalAlpha = 1;

  // seed dots + numbers, for the "all compass points" map
  if (opts.showNumbers) {
    SEEDS.forEach((s, i) => {
      const sx = xS(s[0]), sy = yS(s[1]);
      ctx.fillStyle = ARCHETYPES[i].color;
      ctx.globalAlpha = i === opts.highlightIdx ? 1 : 0.8;
      ctx.beginPath(); ctx.arc(sx, sy, i === opts.highlightIdx ? 4 : 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.font = "bold 9px system-ui, sans-serif";
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillText(String(i + 1), sx + 5, sy);
    });
    ctx.globalAlpha = 1; ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
  }

  // axis cross
  const cx = xS(0), cy = yS(0);
  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(cx, pad); ctx.lineTo(cx, pad + plot); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(pad, cy); ctx.lineTo(pad + plot, cy); ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.font = "bold 9px system-ui, sans-serif";
  ctx.textAlign = "right"; ctx.fillText("OVERHYPED", cx - 8, cy - 6);
  ctx.textAlign = "left"; ctx.fillText("TRANSFORMATIVE", cx + 8, cy - 6);
  ctx.textAlign = "center"; ctx.fillText("GOOD", cx, pad - 10);
  ctx.fillText("BAD", cx, pad + plot + 16);

  // everyone else's positions, with their screen coords cached for hit-testing
  const hits = [];
  const r = opts.big ? 8 : 6;
  (opts.others || []).forEach((e) => {
    const px = xS(e.i), py = yS(e.v);
    hits.push({ x: px, y: py, entry: e });
    const mine = opts.myId && e.id === opts.myId;
    if (mine) return; // drawn last, on top
    ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle = ARCHETYPES[e.a] ? ARCHETYPES[e.a].color : "#fff";
    ctx.globalAlpha = 0.75;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(26,26,46,0.85)";
    ctx.stroke();
  });

  // own point last so it always reads on top
  const own = opts.point;
  if (own) {
    const px = xS(own[0]), py = yS(own[1]);
    const grad = ctx.createRadialGradient(px, py, 0, px, py, 22);
    grad.addColorStop(0, "rgba(255,255,255,0.5)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(px, py, 22, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = opts.highlightIdx >= 0 ? ARCHETYPES[opts.highlightIdx].color : "#fff";
    ctx.beginPath(); ctx.arc(px, py, 8, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 2.5; ctx.stroke();
  }

  // On the projected board, put names on the chart itself — reading a dot off a
  // legend doesn't work from the back of a room. Greedy vertical de-collision;
  // above ~28 people the labels stop being legible anyway, so fall back to chips.
  if (opts.big && hits.length && hits.length <= 28) {
    ctx.font = "600 12px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const placed = [];
    for (const h of hits.slice().sort((a, b) => a.y - b.y)) {
      const w = ctx.measureText(h.entry.name).width;
      const flip = h.x + r + 8 + w > size - 4; // label would run off the right edge
      let lx = flip ? h.x - r - 8 - w : h.x + r + 8;
      let ly = h.y;
      // nudge down past any label already occupying this slot
      for (const p of placed) {
        if (Math.abs(p.ly - ly) < 15 && lx < p.lx + p.w + 6 && lx + w + 6 > p.lx) {
          ly = p.ly + 15;
        }
      }
      placed.push({ lx, ly, w });
      ctx.fillStyle = "rgba(12,12,24,0.72)";
      ctx.fillRect(lx - 4, ly - 8, w + 8, 16);
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.fillText(h.entry.name, lx, ly);
    }
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
  }

  // hovered/tapped label
  if (opts.hover) {
    const h = hits.find((p) => p.entry.id === opts.hover);
    if (h) {
      const label = h.entry.name;
      ctx.font = "600 12px system-ui, sans-serif";
      const w = ctx.measureText(label).width + 14;
      let lx = h.x - w / 2;
      lx = Math.max(2, Math.min(size - w - 2, lx));
      const ly = h.y - r - 26;
      ctx.fillStyle = "rgba(12,12,24,0.92)";
      ctx.beginPath();
      (ctx.roundRect ? ctx.roundRect(lx, ly, w, 22, 6) : ctx.rect(lx, ly, w, 22));
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(label, lx + w / 2, ly + 11);
      ctx.textBaseline = "alphabetic";
    }
  }

  // Region label: name the territory under the pointer. Without this the map is
  // 30 unlabelled colour patches, which is useless on a projected board.
  if (opts.region) {
    const { x: rx, y: ry, idx } = opts.region;
    const a = ARCHETYPES[idx];
    ctx.font = "600 12px system-ui, sans-serif";
    const w = ctx.measureText(a.name).width + 16;
    let lx = Math.max(2, Math.min(size - w - 2, rx - w / 2));
    let ly = ry + 16;
    if (ly + 24 > size) ly = ry - 34;
    ctx.fillStyle = "rgba(12,12,24,0.92)";
    ctx.beginPath();
    (ctx.roundRect ? ctx.roundRect(lx, ly, w, 22, 6) : ctx.rect(lx, ly, w, 22));
    ctx.fill();
    ctx.strokeStyle = a.color; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(a.name, lx + w / 2, ly + 11);
    ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
  }

  ctx.strokeStyle = "rgba(255,255,255,0.1)";
  ctx.lineWidth = 1;
  ctx.strokeRect(pad, pad, plot, plot);

  canvas.__hits = hits;
  canvas.__geom = { pad, plot, size, xI, yI };
}

// Renders a chart into a container and keeps it correctly sized as the
// container changes (rotation, window resize) — the upstream version draws once.
function mountChart(container, opts) {
  const canvas = document.createElement("canvas");
  container.appendChild(canvas);

  const paint = () => {
    const max = opts.maxSize || (opts.big ? 700 : 460);
    const size = Math.max(240, Math.min(container.clientWidth, max));
    drawChart(canvas, Object.assign({}, opts, { size, hover: state.hover, region: state.region }));
  };
  paint();

  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(paint);
    ro.observe(container);
  } else {
    window.addEventListener("resize", paint);
  }

  const pick = (ev) => {
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left, y = ev.clientY - rect.top;

    // a person's dot wins over the region they're standing in
    let found = null, bestD = 18 * 18;
    for (const h of canvas.__hits || []) {
      const d = (h.x - x) * (h.x - x) + (h.y - y) * (h.y - y);
      if (d < bestD) { bestD = d; found = h.entry.id; }
    }

    let region = null;
    const g = canvas.__geom;
    if (!found && g && x >= g.pad && x <= g.pad + g.plot && y >= g.pad && y <= g.pad + g.plot) {
      region = { x, y, idx: seedIndex(g.xI(x), g.yI(y)) };
    }

    const changed = found !== state.hover ||
      (region ? region.idx : null) !== (state.region ? state.region.idx : null) ||
      (region && state.region && (region.x !== state.region.x || region.y !== state.region.y));
    state.hover = found;
    state.region = region;
    if (changed) paint();
  };
  canvas.addEventListener("mousemove", pick);
  canvas.addEventListener("click", pick);
  canvas.addEventListener("mouseleave", () => {
    if (state.hover || state.region) { state.hover = null; state.region = null; paint(); }
  });
  return canvas;
}

// ---- tiny DOM helper ----

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  for (const k in attrs || {}) {
    const v = attrs[k];
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.slice(0, 2) === "on") node.addEventListener(k.slice(2), v);
    else if (k === "style") node.setAttribute("style", v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of [].concat(children || [])) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

// ---- views ----

function viewIntro() {
  // Deliberately no name field. Following an invite link shouldn't mean naming
  // yourself before you know what the name gets attached to — it's asked for on
  // the result screen instead, exactly as in the solo opt-in flow.
  const start = () => { state.view = "quiz"; render(); };

  return el("div", { class: "wrap" }, [
    el("h1", { text: "The AI Compass" }),
    el("p", { class: "sub" }, [
      "Room ", el("span", { class: "roomcode", text: ROOM }), " · ",
      state.others.length + (state.others.length === 1 ? " person" : " people") + " on the board",
    ]),
    el("p", { class: "hint", text: QUESTIONS.length + " questions. Pick as many options as apply — and if none fits exactly, pick the closest." }),
    // The sharpest expert criticism of the original was that it treats "AI" as
    // one thing. Scoping it up front costs nothing and heads off the objection
    // that e.g. medical advances aren't coming from chatbots.
    el("p", { class: "scopenote" }, [
      el("strong", { text: "\"AI\" here means generative AI — chatbots and LLMs" }),
      " — as it's discussed in public, not machine learning generally. " +
      "Narrow ML in medicine, protein folding, and forecasting is a different subject and mostly predates this wave.",
    ]),
    el("p", { class: "fieldhint", style: "text-align:center",
      text: state.entryId
        ? "You're already on this board — finishing again moves your dot."
        : "Nothing goes on the board until you've seen your result and chosen a name." }),
    el("div", { class: "row" }, [
      el("button", { class: "cta", onclick: start, text: "Start" }),
      el("button", { class: "btn", text: "Just show me the board",
        onclick: () => { state.view = "board"; render(); } }),
    ]),
  ]);
}

function viewQuiz() {
  const q = QUESTIONS[state.current];
  const answered = addressed(state.answers);
  const selected = state.answers[state.current];
  const picks = Array.isArray(selected) ? selected : [];
  const isNone = selected === NONE;
  const isAnswered = isNone || picks.length > 0;
  const isLast = state.current === QUESTIONS.length - 1;

  // Toggle, because several options can be true at once — the most common
  // complaint about the original was being forced to pick one of three
  // simultaneously-valid answers.
  const toggle = (i) => {
    const next = picks.includes(i) ? picks.filter((p) => p !== i) : picks.concat(i).sort((a, b) => a - b);
    if (next.length) state.answers[state.current] = next;
    else delete state.answers[state.current];
    save("answers", state.answers);
    render();
  };

  const chooseNone = () => {
    if (isNone) delete state.answers[state.current];
    else state.answers[state.current] = NONE;
    save("answers", state.answers);
    render();
  };

  return el("div", { class: "wrap" }, [
    el("h1", { text: "The AI Compass" }),
    ROOM
      ? el("p", { class: "sub" }, ["Room ", el("span", { class: "roomcode", text: ROOM })])
      : el("p", { class: "sub", text: "Where do you actually land on AI?" }),
    el("div", { class: "bar" }, [
      el("i", { style: "width:" + (answered / QUESTIONS.length) * 100 + "%" }),
    ]),
    el("div", { class: "topic", text: q.topic }),
    el("div", { class: "count", text: (state.current + 1) + " / " + QUESTIONS.length }),
    el("div", { class: "prompt", text: q.prompt }),
    // No skipping: an unanswered question would be scored over a smaller
    // denominator, which inflates the variance of the result and throws people
    // outward into extreme archetypes. Forcing a least-bad choice keeps every
    // result computed over the same 15 questions.
    el("p", { class: "multihint",
      text: "Pick as many as apply. If none fits exactly, choose the least bad one — every question counts." }),
    el("div", { class: "opts", role: "group", "aria-label": q.prompt },
      q.options.map((opt, i) =>
        el("button", {
          class: "opt", text: opt.text, "aria-pressed": picks.includes(i) ? "true" : "false",
          onclick: () => toggle(i),
        })
      ).concat([
        el("button", {
          class: "opt none", text: "None of these fit my view",
          "aria-pressed": isNone ? "true" : "false", onclick: chooseNone,
        }),
      ])),
    picks.length > 1
      ? el("p", { class: "multihint", text: picks.length + " selected — they'll be averaged." })
      : null,
    el("div", { class: "nav" }, [
      el("button", {
        class: "ghost", text: "← Back", disabled: state.current === 0,
        onclick: () => { if (state.current > 0) { state.current--; render(); } },
      }),
      el("div", { class: "row", style: "margin:0" }, [
        // No Skip. Advancing requires an answer, so every result is computed
        // over all 15 questions.
        !isLast
          ? el("button", { class: "btn", text: "Next →", disabled: !isAnswered,
              onclick: () => { state.current++; render(); } })
          : el("button", { class: "cta", text: "See my result", disabled: !isAnswered,
              onclick: () => {
                state.view = "result"; render();
                // A retake by someone already on the board moves their dot. A
                // first run posts nothing yet — the name comes next.
                if (state.entryId) submit();
              } }),
      ]),
    ]),
  ]);
}

function roster() {
  if (!state.others.length) return null;
  const sorted = state.others.slice().sort((a, b) => a.name.localeCompare(b.name));
  return el("div", { class: "roster" }, sorted.map((e) =>
    el("span", {
      class: "chip" + (e.id === state.entryId ? " me" : ""),
      onmouseenter: () => { state.hover = e.id; render(); },
      onmouseleave: () => { state.hover = null; render(); },
      title: ARCHETYPES[e.a] ? ARCHETYPES[e.a].name : "",
    }, [
      el("i", { style: "background:" + (ARCHETYPES[e.a] ? ARCHETYPES[e.a].color : "#fff") }),
      e.name,
    ])
  ));
}

// Opting in to a group: adopt the room, carry the already-given answers across
// into that room's storage scope, put the room in the URL so a reload stays put,
// and only then post anything.
function joinRoom(code, name) {
  const room = code.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  if (!room) {
    state.status = "Pick a room code first.";
    state.statusErr = true;
    render();
    return;
  }
  const answers = state.answers;
  ROOM = room;
  state.name = (name || "").trim() || anonHandle();
  state.answers = answers;
  state.entryId = load("entryId", null); // may already have posted to this room before
  state.joining = false;
  save("name", state.name);
  save("answers", state.answers);

  const u = new URL(location.href);
  u.searchParams.set("room", room);
  u.hash = "";
  history.replaceState(null, "", u.toString());

  render();
  submit();
  refresh();
}

async function copyLink() {
  const url = shareUrl(state.answers);
  try {
    await navigator.clipboard.writeText(url);
    state.status = "Link copied.";
  } catch (e) {
    // clipboard needs a secure context and permission; put it in the URL bar instead
    history.replaceState(null, "", url);
    state.status = "Couldn't copy — the link is in your address bar.";
  }
  state.statusErr = false;
  render();
}

function viewAll() {
  const chartBox = el("div", { style: "max-width:560px;margin:0 auto" });
  const node = el("div", { class: "wrap" }, [
    el("h1", { text: "All " + ARCHETYPES.length + " compass points" }),
    el("p", { class: "sub",
      text: "The whole map. Hover or tap a region on the chart to name it; the numbers match the list." }),
    chartBox,
    el("div", { class: "alllist" }, ARCHETYPES.map((a, i) =>
      el("div", { class: "allrow" + (i === state.highlightIdx ? " on" : "") }, [
        el("div", { class: "allnum", text: String(i + 1) }),
        el("div", { class: "allswatch", style: "background:" + a.color }),
        el("div", { style: "flex:1" }, [
          el("div", { class: "allname", style: "color:" + a.color, text: a.name }),
          el("div", { class: "saint" }, ["reference point: ", referenceLink(a.person)]),
          el("div", { class: "adesc", style: "font-size:14px", text: a.desc }),
        ]),
      ])
    )),
    el("div", { class: "row" }, [
      el("button", { class: "btn", text: "← Back",
        onclick: () => { state.view = state.backTo || "result"; render(); } }),
    ]),
  ]);
  queueMicrotask(() => mountChart(chartBox, {
    showNumbers: true,
    highlightIdx: state.highlightIdx >= 0 ? state.highlightIdx : -1,
    size: 560,
  }));
  return node;
}

function joinForm() {
  // When the room came from the URL there's nothing to choose: don't make people
  // retype a code they were handed, and don't let them mistype it into a board
  // of one. Only the name is missing.
  const fixed = !!URL_ROOM;
  const roomInput = fixed ? null : el("input", {
    type: "text", placeholder: "e.g. offsite-2026", "aria-label": "Room code", value: "",
  });
  const nameInput = el("input", {
    type: "text", maxlength: "24", "aria-label": "Your display name", value: state.name,
  });
  const go = () => joinRoom(fixed ? ROOM : roomInput.value, nameInput.value);
  const onEnter = (e) => { if (e.key === "Enter") go(); };
  if (roomInput) roomInput.addEventListener("keydown", onEnter);
  nameInput.addEventListener("keydown", onEnter);

  return el("div", { class: "joinbox" }, [
    el("div", { class: "eyebrow", text: fixed ? "Post to the group" : "Share with a group" }),
    el("p", { class: "hint", style: "text-align:left;margin:0 0 14px" }, fixed
      ? ["Your dot and display name go on the board for room ",
         el("span", { class: "roomcode", text: ROOM }),
         ", visible to anyone with that code."]
      : ["Everyone in the group uses the same room code. Your position and display name become visible to anyone with that code."]),
    roomInput ? el("label", { text: "Room code" }) : null,
    roomInput,
    el("label", { style: fixed ? "" : "margin-top:12px", text: "Show up as" }),
    nameInput,
    el("p", { class: "fieldhint",
      text: state.nameWasLoaded
        ? "This is the name you used last time — change it if you'd like."
        : "This is what the group sees next to your dot — your real name, or anything you like. We've filled in a random pseudonym; keep it to stay anonymous." }),
    el("div", { class: "row" }, [
      el("button", { class: "cta", text: "Post to the group", onclick: go }),
      el("button", { class: "ghost", text: fixed ? "Not now" : "Cancel",
        onclick: () => { state.joining = false; render(); } }),
    ]),
  ]);
}

function viewResult() {
  const { impact, valence, n } = score(state.answers);
  const idx = seedIndex(impact, valence);
  const a = ARCHETYPES[idx];
  const chartBox = el("div", { style: "max-width:460px;margin:0 auto" });

  const node = el("div", { class: "wrap" }, [
    el("h1", { text: state.fromLink ? "A shared AI Compass" : "Your AI Compass" }),
    el("p", { class: "sub" }, ROOM
      ? [n + " of " + QUESTIONS.length + " scored · room ", el("span", { class: "roomcode", text: ROOM })]
      : [n + " of " + QUESTIONS.length + " scored"]),
    chartBox,
    el("div", { class: "card" }, [
      el("div", { class: "eyebrow", text: state.fromLink ? "They are..." : "You are..." }),
      el("div", { class: "aname", style: "color:" + a.color, text: a.name }),
      el("div", { class: "saint" }, ["reference point: ", referenceLink(a.person)]),
      el("div", { class: "adesc", text: a.desc }),
      el("div", { class: "coords",
        text: "Impact: " + (impact > 0 ? "+" : "") + impact.toFixed(1) +
              "   •   Valence: " + (valence > 0 ? "+" : "") + valence.toFixed(1) }),
    ]),
    state.fromLink
      ? el("p", { class: "hint", style: "margin-top:18px",
          text: "You're looking at someone else's result from a shared link. Take it yourself to get on the board." })
      : ROOM
        ? el("p", { class: "sub", style: "margin-top:22px",
            text: state.others.length
              ? state.others.length + (state.others.length === 1 ? " person" : " people") + " on the board so far"
              : "Nobody else has submitted yet." })
        : null,
    state.fromLink || !ROOM ? null : roster(),

    // Nothing is posted until there's a name to post it under — an invite link
    // in the URL is no exception. entryId set means it's already up there.
    !state.fromLink && !state.entryId && !state.joining
      ? el("div", { style: "text-align:center;margin-top:22px" }, [
          el("button", { class: "btn", text: ROOM ? "Put me on the board" : "Share with a group",
            onclick: () => { state.joining = true; state.status = ""; state.statusErr = false; render(); } }),
          el("p", { class: "hint", style: "margin-top:10px",
            text: "Your answers stay on this device unless you choose this." }),
        ])
      : null,
    joinFormOpen() ? joinForm() : null,

    el("div", { style: "text-align:center;margin-top:18px" }, [
      el("button", { class: "linkish", style: "font-size:13px",
        text: "Show me all " + ARCHETYPES.length + " compass points →",
        onclick: () => {
          state.backTo = "result"; state.highlightIdx = idx; state.view = "all";
          state.region = null; render(); window.scrollTo(0, 0);
        } }),
    ]),
    el("div", { class: "row" }, [
      ROOM ? el("button", { class: "btn", text: "Open the big board",
        onclick: () => { state.view = "board"; render(); } }) : null,
      el("button", { class: "btn", text: "Copy link to these answers", onclick: copyLink }),
      el("button", { class: state.fromLink ? "cta" : "btn", text: state.fromLink ? "Take it myself" : "Retake",
        onclick: () => {
          state.answers = {}; state.current = 0; state.view = "quiz";
          state.fromLink = false; state.joining = !!URL_ROOM;
          if (location.hash) history.replaceState(null, "", location.pathname + location.search);
          save("answers", state.answers); render();
        } }),
    ]),
    el("div", { class: "status" + (state.statusErr ? " err" : ""), text: state.status }),
  ]);

  queueMicrotask(() => mountChart(chartBox, {
    point: [impact, valence], highlightIdx: idx, others: state.others, myId: state.entryId,
  }));
  return node;
}

function viewBoard() {
  const chartBox = el("div", { style: "max-width:700px;margin:0 auto" });
  const mine = state.entryId ? state.others.find((e) => e.id === state.entryId) : null;

  const node = el("div", { class: "wrap" }, [
    el("h1", { text: "Where the room landed" }),
    el("p", { class: "sub" }, [
      state.others.length + (state.others.length === 1 ? " response" : " responses") + " · room ",
      el("span", { class: "roomcode", text: ROOM }), " · updates automatically",
    ]),
    chartBox,
    roster(),
    el("div", { class: "row" }, [
      el("button", { class: "btn", text: state.entryId ? "Back to my result" : "Take the quiz",
        onclick: () => { state.view = state.entryId ? "result" : "intro"; render(); } }),
      el("button", { class: "btn", text: "All " + ARCHETYPES.length + " compass points",
        onclick: () => {
          state.backTo = "board"; state.highlightIdx = mine ? mine.a : -1;
          state.view = "all"; state.region = null; render(); window.scrollTo(0, 0);
        } }),
    ]),
    el("div", { class: "status" + (state.statusErr ? " err" : ""), text: state.status }),
  ]);

  queueMicrotask(() => mountChart(chartBox, {
    others: state.others, myId: state.entryId, big: true,
    point: mine ? [mine.i, mine.v] : null,
    highlightIdx: mine ? mine.a : -1,
  }));
  return node;
}

// ---- render loop ----

function render() {
  const root = document.getElementById("root");
  root.textContent = "";
  document.body.classList.toggle("board", state.view === "board");
  const view =
    state.view === "intro" ? viewIntro() :
    state.view === "quiz" ? viewQuiz() :
    state.view === "result" ? viewResult() :
    state.view === "all" ? viewAll() :
    viewBoard();
  root.appendChild(view);
}

render();

// ROOM can be adopted mid-session (opting in to a group), so these re-check it
// each time rather than being installed conditionally at startup.
if (ROOM) refresh();
setInterval(() => {
  if (!ROOM) return;
  if (state.view === "board" || state.view === "result" || state.view === "intro") refresh();
}, 4000);
document.addEventListener("visibilitychange", () => {
  if (ROOM && !document.hidden) refresh();
});

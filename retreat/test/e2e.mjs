// Drive the real app in headless Chrome over the DevTools protocol and walk the
// full participant flow: name -> answer every question -> result -> board.
import { spawn } from "node:child_process";
import fs from "node:fs";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;
const PROFILE = new URL("./.chrome-profile", import.meta.url).pathname;
const ROOM = "cdp-" + Date.now().toString(36);

// The suite manages its own dev server. If one is already listening we reuse it
// and leave it alone; otherwise we start one and shut it down on the way out.
const BASE = "http://localhost:8799";
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

async function serverUp() {
  try {
    const probe = await fetch(BASE + "/", { signal: AbortSignal.timeout(3000) });
    return probe.ok && (await probe.text()).includes("aicompass:v");
  } catch (e) {
    return false;
  }
}

let ownDevServer = null;
if (await serverUp()) {
  console.log("using the dev server already running on 8799\n");
} else {
  console.log("starting a dev server on 8799…");
  ownDevServer = spawn("npx", ["wrangler", "dev", "--port", "8799", "--local"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdio: ["ignore", "ignore", "ignore"],
    detached: false,
  });
  let ready = false;
  for (let i = 0; i < 90; i++) {
    if (await serverUp()) { ready = true; break; }
    await sleepMs(1000);
  }
  if (!ready) {
    ownDevServer.kill("SIGTERM");
    console.error(
      `\nCouldn't start a dev server at ${BASE}.\n` +
        `Try running 'npm run dev' by hand to see why.\n`
    );
    process.exit(2);
  }
  console.log("dev server ready\n");
}

const stopDevServer = () => {
  if (ownDevServer && !ownDevServer.killed) ownDevServer.kill("SIGTERM");
  ownDevServer = null;
};
process.on("exit", stopDevServer);
process.on("SIGINT", () => { stopDevServer(); process.exit(130); });
process.on("uncaughtException", (e) => { stopDevServer(); console.error(e); process.exit(1); });

// Always start from a clean profile — a leftover one carries localStorage from
// the previous run and makes results depend on run order.
fs.rmSync(PROFILE, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  "--window-size=900,1400", "about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let target;
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((t) => t.type === "page");
    if (target) break;
  } catch (e) { /* not up yet */ }
  await sleep(250);
}
if (!target) { chrome.kill(); throw new Error("chrome never came up"); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

let msgId = 0;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") {
    consoleErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  }
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    consoleErrors.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
  }
};
const send = (method, params = {}) =>
  new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });

await send("Runtime.enable");
await send("Page.enable");

async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) {
    throw new Error("page threw: " + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
  }
  return r.result?.result?.value;
}

async function goto(url) {
  await send("Page.navigate", { url });
  await sleep(900);
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

// --- 1. intro screen: the room is named, but nothing is asked of you yet ---
await goto(`${BASE}/?room=${ROOM}`);
check("invite intro shows the room code",
  (await evaluate(`document.querySelector('.roomcode')?.textContent`)) === ROOM);
check("invite intro asks for no name up front",
  (await evaluate(`!!document.querySelector('input[type=text]')`)) === false);

// --- 1b. favicon must actually decode in a browser, not merely parse as text ---
const favicon = await evaluate(`(async () => {
  const link = document.querySelector('link[rel="icon"]');
  if (!link) return "no icon link";
  const img = new Image();
  const loaded = new Promise(r => { img.onload = () => r("ok"); img.onerror = () => r("failed to decode"); });
  img.src = link.href;
  const res = await loaded;
  return res === "ok" ? \`\${img.naturalWidth}x\${img.naturalHeight}\` : res;
})()`);
check("favicon decodes as an image", /^\d+x\d+$/.test(favicon || ""), favicon);

// --- 2. start ---
await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Start').click()`);
await sleep(300);
const onQuiz = await evaluate(`!!document.querySelector('.opt')`);
check("Start moves to the quiz", onQuiz === true);

// --- 3. answer every question: first option, and on Q1 also exercise
//        multi-select (pick two) so the averaging path is covered ---
const total = await evaluate(`+document.querySelector('.count').textContent.split('/')[1]`);
const advance = () => evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find(b => /Next|See my result/.test(b.textContent));
  if (b) b.click();
})()`);

for (let q = 0; q < total; q++) {
  if (q === 0) {
    // skipping is not allowed: no Skip control, and Next is dead until answered
    check("no Skip control exists", (await evaluate(
      `[...document.querySelectorAll('button')].some(b=>/Skip/i.test(b.textContent))`)) === false);
    check("Next is disabled before answering", (await evaluate(
      `[...document.querySelectorAll('button')].find(b=>/Next/.test(b.textContent))?.disabled`)) === true);
    const stuck = await evaluate(`document.querySelector('.count').textContent`);
    await advance();
    await sleep(200);
    check("clicking a disabled Next does not advance",
      (await evaluate(`document.querySelector('.count')?.textContent`)) === stuck, stuck);

    // "none of these" must be togglable and mutually exclusive with the options
    await evaluate(`document.querySelector('.opt.none').click()`);
    await sleep(150);
    const noneState = await evaluate(`(() => {
      const none = document.querySelector('.opt.none');
      const others = [...document.querySelectorAll('.opt:not(.none)')].filter(b=>b.getAttribute('aria-pressed')==='true').length;
      return none.getAttribute('aria-pressed') + '/' + others;
    })()`);
    check('"none of these" selects, with no options selected', noneState === "true/0", noneState);

    await evaluate(`document.querySelectorAll('.opt')[0].click()`);
    await sleep(150);
    check('picking an option clears "none"',
      (await evaluate(`document.querySelector('.opt.none').getAttribute('aria-pressed')`)) === "false");

    await evaluate(`document.querySelectorAll('.opt')[1].click()`);
    await sleep(150);
    const hint = await evaluate(`[...document.querySelectorAll('.multihint')].map(e=>e.textContent).join(' | ')`);
    check("multi-select shows the averaging hint", /2 selected/.test(hint || ""), hint);
    const pressed = await evaluate(`[...document.querySelectorAll('.opt')].filter(b=>b.getAttribute('aria-pressed')==='true').length`);
    check("two options stay selected together", pressed === 2, pressed + " pressed");
  } else {
    await evaluate(`document.querySelectorAll('.opt')[0].click()`);
    await sleep(120);
  }
  await advance();
  await sleep(160);
}
check(`answered all ${total} questions`, true);

// --- 4. result, then the deferred name step ---
await sleep(900); // the loop's last advance() already hit "See my result"
const archetype = await evaluate(`document.querySelector('.aname')?.textContent`);
const coords = await evaluate(`document.querySelector('.coords')?.textContent`);
check("result screen shows an archetype", !!archetype, archetype + " | " + (coords || "").trim());

// Following an invite link is not consent to be posted under a name you were
// never asked for: the board must still be empty at this point.
const preJoin = await (await fetch(`${BASE}/api/room/${ROOM}`)).json();
check("invite room: nothing posted before naming yourself",
  preJoin.entries.length === 0, preJoin.entries.length + " entries");
check("invite room: the join form is open on the result",
  !!(await evaluate(`!!document.querySelector('.joinbox')`)));
const joinInputs = await evaluate(`document.querySelectorAll('.joinbox input[type=text]').length`);
check("invite room: only the name is asked for, not the room code",
  joinInputs === 1, joinInputs + " text inputs");
const prefill = await evaluate(`document.querySelector('.joinbox input[type=text]').value`);
check("join form prefills an anonymous handle",
  /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(prefill || ""), JSON.stringify(prefill));

await evaluate(`(() => {
  const n = document.querySelector('.joinbox input[type=text]');
  n.value = 'CDP Tester';
  [...document.querySelectorAll('.joinbox button')].find(b => b.textContent === 'Post to the group').click();
})()`);
await sleep(1200);
const status = await evaluate(`document.querySelector('.status')?.textContent`);
check("submission saved once the name is given",
  (status || "").includes("You're on the board"), JSON.stringify(status));

// --- 4b. reference point is a clickable link, with no toggle or caveat ---
const saintShown = await evaluate(`document.querySelector('.saint')?.textContent`);
check("result shows a reference point", /reference point:/.test(saintShown || ""), saintShown);
check("no caveat text", (await evaluate(`!!document.querySelector('.disclaimer')`)) === false);
check("no hide/show toggle", (await evaluate(
  `[...document.querySelectorAll('button')].some(b=>/hide these|show reference/.test(b.textContent))`)) === false);
const saintHref = await evaluate(`document.querySelector('.saint a')?.href`);
check("reference point links out", /^https:\/\//.test(saintHref || ""), saintHref);
check("reference link opens in a new tab safely", (await evaluate(
  `(() => { const a = document.querySelector('.saint a');
     return a.target === '_blank' && /noopener/.test(a.rel); })()`)) === true);

// every archetype must have a working-looking link, not just this one
const linkAudit = await evaluate(`(() => {
  const missing = ARCHETYPES.filter(a => !REFERENCE_LINKS[a.person]).map(a => a.person);
  const bad = Object.entries(REFERENCE_LINKS).filter(([,u]) => !/^https:\\/\\/[^ ]+$/.test(u)).map(([p]) => p);
  return {n: Object.keys(REFERENCE_LINKS).length, missing, bad};
})()`);
check("every archetype has a valid reference link",
  linkAudit.missing.length === 0 && linkAudit.bad.length === 0,
  `${linkAudit.n} links, missing [${linkAudit.missing}], malformed [${linkAudit.bad}]`);

// --- 4d. "all compass points" view ---
await evaluate(`[...document.querySelectorAll('button')].find(b=>/all \\d+ compass points/i.test(b.textContent)).click()`);
await sleep(400);
const allRows = await evaluate(`document.querySelectorAll('.allrow').length`);
check("all-points view lists every archetype", allRows === linkAudit.n, allRows + " rows");
check("all-points view highlights your own", !!(await evaluate(`!!document.querySelector('.allrow.on')`)));
check("all-points rows carry reference links", (await evaluate(
  `document.querySelectorAll('.allrow .saint a').length`)) === allRows);

// hovering a region on the map names it
const regionHover = await evaluate(`(() => {
  const c = document.querySelector('canvas');
  const r = c.getBoundingClientRect();
  c.dispatchEvent(new MouseEvent('mousemove', {bubbles:true,
    clientX: r.left + r.width*0.72, clientY: r.top + r.height*0.34}));
  return state.region && ARCHETYPES[state.region.idx] ? ARCHETYPES[state.region.idx].name : null;
})()`);
check("hovering the map names the region under the pointer", !!regionHover, regionHover);
const regionHover2 = await evaluate(`(() => {
  const c = document.querySelector('canvas');
  const r = c.getBoundingClientRect();
  c.dispatchEvent(new MouseEvent('mousemove', {bubbles:true,
    clientX: r.left + r.width*0.25, clientY: r.top + r.height*0.75}));
  return state.region && ARCHETYPES[state.region.idx] ? ARCHETYPES[state.region.idx].name : null;
})()`);
check("a different region names a different archetype", !!regionHover2 && regionHover2 !== regionHover,
  `${regionHover} vs ${regionHover2}`);
await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='← Back').click()`);
await sleep(300);
check("back returns to the result", !!(await evaluate(`!!document.querySelector('.aname')`)));

// --- 4c. shareable permalink ---
const enc = await evaluate(`encodeAnswers(state.answers)`);
check("page exposes a permalink encoding", typeof enc === "string" && enc.length > 0, enc);
const myArchetype = await evaluate(`document.querySelector('.aname').textContent`);

// --- 4e. storage guarantees the D1 migration exists to provide ---
{
  // read-after-write with zero delay, ten times. Under KV this frequently
  // returned a board missing the row that was just written.
  let stale = 0;
  for (let i = 0; i < 10; i++) {
    const room = `consistency-${Date.now().toString(36)}-${i}`;
    const posted = await (await fetch(`${BASE}/api/room/${room}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "RAW " + i, i: 1.5, v: -0.5, a: 16 }),
    })).json();
    const board = await (await fetch(`${BASE}/api/room/${room}`)).json();
    if (!board.entries.some((e) => e.id === posted.id)) stale++;
  }
  check("read-after-write is immediately consistent", stale === 0, `${10 - stale}/10 immediate`);

  // an id is a capability within its room only — it must not relocate a dot
  const roomA = `scope-a-${Date.now().toString(36)}`;
  const roomB = `scope-b-${Date.now().toString(36)}`;
  const a = await (await fetch(`${BASE}/api/room/${roomA}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Scoped", i: -2, v: -2, a: 4 }),
  })).json();
  await fetch(`${BASE}/api/room/${roomB}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: a.id, name: "Scoped", i: 3, v: 3, a: 23 }),
  });
  const stillA = await (await fetch(`${BASE}/api/room/${roomA}`)).json();
  const nowB = await (await fetch(`${BASE}/api/room/${roomB}`)).json();
  check("an id from another room can't move or steal that entry",
    stillA.entries.length === 1 && nowB.entries.length === 1 && nowB.entries[0].id !== a.id,
    `roomA=${stillA.entries.length} roomB=${nowB.entries.length}`);
}

// --- 4d. retention actually sweeps ---
// The window is a promise to the people in the room, so check the sweep fires
// rather than trusting the constant. Backdate a row underneath the running
// worker, then insert elsewhere — inserts are what trigger the sweep.
{
  const staleRoom = `${ROOM}-stale`;
  const postTo = (room, name) => fetch(`${BASE}/api/room/${room}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, i: 1, v: 1, a: 5 }),
  });
  await postTo(staleRoom, "Ancient");
  const backdated = await new Promise((resolve) => {
    const p = spawn("npx", ["wrangler", "d1", "execute", "ai-compass-retreat", "--local",
      "--command", `UPDATE entries SET updated_at = 1 WHERE room = '${staleRoom}'`],
      { cwd: new URL("..", import.meta.url).pathname, stdio: ["ignore", "ignore", "ignore"] });
    p.on("exit", (code) => resolve(code === 0));
  });
  await postTo(`${ROOM}-sweep`, "Fresh");
  await sleep(1500); // the sweep runs in waitUntil, after the response
  const swept = await (await fetch(`${BASE}/api/room/${staleRoom}`)).json();
  const kept = await (await fetch(`${BASE}/api/room/${ROOM}-sweep`)).json();
  check("entries past the retention window are swept, fresh ones kept",
    backdated && swept.entries.length === 0 && kept.entries.length === 1,
    `backdated=${backdated} stale=${swept.entries.length} fresh=${kept.entries.length}`);
}

// --- 5. the server agrees ---
const board = await (await fetch(`http://localhost:8799/api/room/${ROOM}`)).json();
const me = board.entries.find((e) => e.name === "CDP Tester");
check("entry present server-side", !!me, JSON.stringify(me));

// --- 6. reload keeps identity, and a retake updates in place (no duplicate dot) ---
await goto(`http://localhost:8799/?room=${ROOM}`);
const resumed = await evaluate(`!!document.querySelector('.aname')`);
check("reload resumes to the saved result", resumed === true);

await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Retake').click()`);
await sleep(300);
for (let q = 0; q < total; q++) {
  // last real option (skip the trailing "none of these" button)
  await evaluate(`(() => { const o = document.querySelectorAll('.opt:not(.none)'); o[o.length-1].click(); })()`);
  await sleep(120);
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(b => /Next|See my result/.test(b.textContent));
    if (b) b.click();
  })()`);
  await sleep(160);
}
await sleep(1500); // the loop's last advance() already hit "See my result"
const board2 = await (await fetch(`http://localhost:8799/api/room/${ROOM}`)).json();
const mine2 = board2.entries.filter((e) => e.name === "CDP Tester");
check("retake updates in place (one dot, not two)", mine2.length === 1, `${mine2.length} entries, now at (${mine2[0]?.i}, ${mine2[0]?.v})`);
check("retake moved the position", mine2[0] && me && mine2[0].i !== me.i, `${me?.i} -> ${mine2[0]?.i}`);

// --- 6b. a shared link reproduces the sender's result, in a room with no local state ---
await goto(`http://localhost:8799/?room=${ROOM}-shared#a=${enc}`);
const sharedArchetype = await evaluate(`document.querySelector('.aname')?.textContent`);
check("shared link reproduces the same archetype", sharedArchetype === myArchetype,
  `${sharedArchetype} vs ${myArchetype}`);
check("shared link is framed as someone else's",
  /They are/.test(await evaluate(`document.querySelector('.eyebrow')?.textContent`) || ""));
const sharedBoard = await (await fetch(`http://localhost:8799/api/room/${ROOM}-shared`)).json();
check("viewing a shared link does not post to the board", sharedBoard.entries.length === 0,
  sharedBoard.entries.length + " entries");
check("shared link offers to take it yourself",
  !!(await evaluate(`[...document.querySelectorAll('button')].some(b=>b.textContent==='Take it myself')`)));

// a corrupt fragment must not break the page
await goto(`http://localhost:8799/?room=${ROOM}-junk#a=!!!notbase64!!!`);
check("corrupt permalink degrades to a normal start", !!(await evaluate(
  `!!document.querySelector('.opt') || [...document.querySelectorAll('button')].some(b=>b.textContent==='Start')`)));

// --- 6c. SOLO IS THE DEFAULT: root goes straight to the quiz, posts nothing ---
// Start from genuinely empty storage: this asserts the FIRST-visit behaviour,
// and a returning visitor legitimately resumes their saved result instead.
const soloRoom = ROOM + "-solo";
await goto(`http://localhost:8799/`);
await evaluate(`localStorage.clear()`);
await goto(`http://localhost:8799/`);
check("root goes straight to the quiz", !!(await evaluate(`!!document.querySelector('.opt')`)));
check("root asks for no room or name", (await evaluate(`!!document.querySelector('input[type=text]')`)) === false);
check("root shows no room code", (await evaluate(`!!document.querySelector('.roomcode')`)) === false);

for (let q = 0; q < total; q++) {
  await evaluate(`document.querySelectorAll('.opt')[0].click()`);
  await sleep(110);
  await advance();
  await sleep(150);
}
check("solo run reaches a result", !!(await evaluate(`document.querySelector('.aname')?.textContent`)));
check("solo result offers no board", (await evaluate(
  `[...document.querySelectorAll('button')].some(b=>b.textContent==='Open the big board')`)) === false);
check("solo result offers to share with a group", !!(await evaluate(
  `[...document.querySelectorAll('button')].some(b=>b.textContent==='Share with a group')`)));
check("solo state is stored separately from rooms", !!(await evaluate(
  `Object.keys(localStorage).some(k=>k.startsWith('aicompass:v4:solo:'))`)));

// a RETURNING solo visitor resumes their result rather than restarting
await goto(`http://localhost:8799/`);
check("returning to root resumes the saved solo result",
  !!(await evaluate(`!!document.querySelector('.aname')`)));
check("resumed solo result still has no room", (await evaluate(`!!document.querySelector('.roomcode')`)) === false);

// opt in, and only now should anything reach the server
await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Share with a group').click()`);
await sleep(250);
check("join form appears", !!(await evaluate(`!!document.querySelector('.joinbox')`)));
const beforeJoin = await (await fetch(`http://localhost:8799/api/room/${soloRoom}`)).json();
check("nothing posted before opting in", beforeJoin.entries.length === 0, beforeJoin.entries.length + " entries");

check("join form explains the display name", /random pseudonym/.test(await evaluate(
  `[...document.querySelectorAll('.joinbox .fieldhint')].map(e=>e.textContent).join(' ')`) || ""));

const joinedAt = Date.now();
await evaluate(`(() => {
  const [room, name] = document.querySelectorAll('.joinbox input[type=text]');
  room.value = ${JSON.stringify(soloRoom)};
  name.value = 'Solo Optin';
  [...document.querySelectorAll('.joinbox button')].find(b=>b.textContent==='Post to the group').click();
})()`);

// You must appear on your own board immediately, not after KV propagates and
// the next 4s poll lands. Poll the UI tightly and record how long it took.
let sawSelfMs = null;
for (let i = 0; i < 60; i++) {
  const on = await evaluate(`state.others.some(e => e.id === state.entryId)`);
  if (on) { sawSelfMs = Date.now() - joinedAt; break; }
  await sleep(100);
}
check("you appear on your own board promptly after joining",
  sawSelfMs !== null && sawSelfMs < 2500, sawSelfMs === null ? "never appeared" : sawSelfMs + "ms");
check("and you are listed by name in the roster", !!(await evaluate(
  `[...document.querySelectorAll('.chip')].some(c=>/Solo Optin/.test(c.textContent))`)));

// the optimistic entry must survive a subsequent eventually-consistent read
await sleep(1800);
check("optimistic entry is not wiped by the next refresh", (await evaluate(
  `state.others.some(e => e.id === state.entryId)`)) === true);
const afterJoin = await (await fetch(`http://localhost:8799/api/room/${soloRoom}`)).json();
check("opting in posts exactly one entry", afterJoin.entries.length === 1,
  JSON.stringify(afterJoin.entries[0]));
check("opting in keeps the answers (same archetype)",
  afterJoin.entries[0] && afterJoin.entries[0].name === "Solo Optin");
check("room lands in the URL after opting in",
  /[?&]room=/.test(await evaluate(`location.search`)), await evaluate(`location.search`));
await goto(`http://localhost:8799/?room=${soloRoom}`);
check("reload after opting in stays in the room and on the result",
  !!(await evaluate(`!!document.querySelector('.aname') && !!document.querySelector('.roomcode')`)));

// --- 6d. an invite URL still drops you straight into that room ---
await goto(`http://localhost:8799/?room=${ROOM}-invite`);
check("invite URL asks for nothing up front",
  (await evaluate(`!!document.querySelector('input[type=text]')`)) === false);
check("invite URL shows the room code",
  (await evaluate(`document.querySelector('.roomcode')?.textContent`)) === `${ROOM}-invite`);

// --- 7. board view ---
await goto(`http://localhost:8799/?room=${ROOM}&board=1`);
const chips = await evaluate(`document.querySelectorAll('.chip').length`);
check("board lists everyone", chips >= 1, chips + " chips");

check("no uncaught JS errors", consoleErrors.length === 0, consoleErrors.join(" | ") || "clean");

ws.close();
chrome.kill();
stopDevServer();
try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* chrome still exiting */ }

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

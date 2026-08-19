#!/usr/bin/env node
/**
 * Inspect and repair rooms in the D1 database.
 *
 * This is a convenience wrapper — unlike the KV version it replaced, nothing
 * here is load-bearing. You can do all of it directly:
 *
 *   npx wrangler d1 execute ai-compass-retreat --remote \
 *     --command "SELECT room, COUNT(*) FROM entries GROUP BY room"
 *
 *   npx wrangler d1 execute ai-compass-retreat --remote \
 *     --command "UPDATE entries SET room='offsite-2026' WHERE room='offsite2026'"
 *
 * Usage:
 *   node tools/rooms.mjs                      list rooms, flag likely typos
 *   node tools/rooms.mjs --room offsite-2026  show one room's entries
 *   node tools/rooms.mjs --move BAD GOOD      preview moving every entry
 *   node tools/rooms.mjs --move BAD GOOD --yes            actually move them
 *   node tools/rooms.mjs --move BAD GOOD --id <uuid> --yes  move just one
 *   node tools/rooms.mjs --sql "SELECT ..."   run your own read-only query
 *
 * Targets production by default; --local uses the dev database instead.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

const toml = fs.readFileSync(path.join(root, "wrangler.toml"), "utf8");
const DB = (toml.match(/\[\[d1_databases\]\][\s\S]*?database_name\s*=\s*"([^"]+)"/) || [])[1];
if (!DB) {
  console.error("No D1 database in wrangler.toml.");
  process.exit(1);
}

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf("--" + name);
  return i === -1 ? null : argv[i + 1];
};
const has = (name) => argv.includes("--" + name);
const STORE = has("local") ? "--local" : "--remote";

function sql(command) {
  let out;
  try {
    out = execFileSync(
      "npx",
      ["wrangler", "d1", "execute", DB, STORE, "--json", "--command", command],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 }
    );
  } catch (e) {
    const msg = (e.stderr || e.stdout || "").toString().replace(/\[[0-9;]*m/g, "")
      .split("\n").filter((l) => /ERROR|error|✘/.test(l)).join("\n").trim();
    console.error(`\nquery failed:\n${msg || e.message}\n`);
    process.exit(1);
  }
  const start = out.indexOf("[");
  if (start === -1) return [];
  const parsed = JSON.parse(out.slice(start));
  return (parsed[0] && parsed[0].results) || [];
}

const quote = (s) => "'" + String(s).replace(/'/g, "''") + "'";

// Levenshtein, for spotting "offsite2026" next to "offsite-2026"
function edits(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

// ---- arbitrary read-only query ----

const custom = flag("sql");
if (custom) {
  if (!/^\s*select\b/i.test(custom)) {
    console.error("--sql only runs SELECT. Use --move, or wrangler d1 execute directly.");
    process.exit(1);
  }
  const rows = sql(custom);
  console.log(rows.length ? JSON.stringify(rows, null, 1) : "(no rows)");
  process.exit(0);
}

// ---- move ----

const moveIdx = argv.indexOf("--move");
if (moveIdx !== -1) {
  const from = argv[moveIdx + 1], to = argv[moveIdx + 2];
  if (!from || !to || from.startsWith("--") || to.startsWith("--")) {
    console.error("usage: --move <from-room> <to-room> [--id <uuid>] [--yes]");
    process.exit(1);
  }
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(to)) {
    console.error(`"${to}" is not a valid room code (the app would reject it).`);
    process.exit(1);
  }
  const onlyId = flag("id");
  const where = `room = ${quote(from)}` + (onlyId ? ` AND id = ${quote(onlyId)}` : "");
  const moving = sql(`SELECT id, name, impact, valence FROM entries WHERE ${where} ORDER BY created_at`);

  if (!moving.length) {
    console.error(`Nothing to move from "${from}"${onlyId ? ` with id ${onlyId}` : ""}.`);
    process.exit(1);
  }

  console.log(`Moving ${moving.length} ${moving.length === 1 ? "entry" : "entries"}: ${from} -> ${to}\n`);
  for (const e of moving) console.log(`  ${e.name}  (${e.impact}, ${e.valence})  ${e.id}`);

  if (!has("yes")) {
    console.log(`\nDry run. Re-run with --yes to apply.`);
    process.exit(0);
  }

  // One statement, atomic — the KV version had to write-then-delete per entry.
  sql(`UPDATE entries SET room = ${quote(to)} WHERE ${where}`);
  console.log(`\nMoved. Anyone affected still has the old room in their URL, so send them the corrected link.`);
  process.exit(0);
}

// ---- single room ----

const one = flag("room");
if (one) {
  const list = sql(
    `SELECT id, name, impact, valence, archetype, created_at
       FROM entries WHERE room = ${quote(one)} ORDER BY created_at`
  );
  if (!list.length) {
    console.error(`No entries in room "${one}".`);
    process.exit(1);
  }
  console.log(`${one} — ${list.length} ${list.length === 1 ? "entry" : "entries"}\n`);
  for (const e of list) {
    console.log(
      `  ${new Date(e.created_at).toISOString().slice(11, 16)}  ${String(e.name).padEnd(24)}` +
        `  impact ${String(e.impact).padStart(7)}  valence ${String(e.valence).padStart(7)}  ${e.id}`
    );
  }
  process.exit(0);
}

// ---- overview + typo detection ----

const rooms = sql(
  `SELECT room, COUNT(*) AS n, GROUP_CONCAT(name, ', ') AS names
     FROM entries GROUP BY room ORDER BY n DESC`
);

if (!rooms.length) {
  console.log("No entries yet.");
  process.exit(0);
}

const total = rooms.reduce((s, r) => s + r.n, 0);
console.log(`${total} entries across ${rooms.length} room(s)\n`);
for (const r of rooms) {
  console.log(`  ${String(r.n).padStart(3)}  ${r.room.padEnd(24)}  ${String(r.names || "").slice(0, 90)}`);
}

const suspects = [];
for (const a of rooms) {
  for (const b of rooms) {
    if (a.room === b.room) continue;
    if (b.n > a.n * 3 && edits(a.room, b.room) <= 2) {
      suspects.push([a.room, a.n, b.room, b.n, edits(a.room, b.room)]);
    }
  }
}

if (suspects.length) {
  console.log(`\nPossible typos:`);
  for (const [bad, n, good, m, d] of suspects) {
    console.log(`  "${bad}" (${n}) looks like "${good}" (${m}) — ${d} character${d === 1 ? "" : "s"} apart`);
    console.log(`      npm run rooms -- --move ${bad} ${good} --yes`);
  }
} else if (rooms.length > 1) {
  console.log(`\nNo near-miss room codes detected. Rooms with very few entries are still worth a look.`);
}

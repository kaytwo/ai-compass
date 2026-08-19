// Builds retreat/public/index.html from the upstream ../index.html plus src/app.js.
//
// The quiz content (QUESTIONS, ARCHETYPES) and the classifier calibration
// (SEEDS, ICOV, VIEW) are *extracted* from the upstream file rather than copied
// by hand, so re-running this after pulling upstream picks up their changes.
//
// Note: SEEDS/ICOV are fit against the exact upstream option set. If you change
// the options, they need refitting (upstream's ai_sim.py is not published).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const upstream = fs.readFileSync(path.join(here, "..", "index.html"), "utf8");

function extract(re, label) {
  const m = upstream.match(re);
  if (!m) throw new Error(`could not find ${label} in ../index.html`);
  return m[1];
}

const DATA = {
  QUESTIONS: extract(/const QUESTIONS = (\[[\s\S]*?\n\]);/, "QUESTIONS"),
  ARCHETYPES: extract(/const ARCHETYPES = (\[[\s\S]*?\n\]);/, "ARCHETYPES"),
  SEEDS: extract(/const SEEDS=(\[\[.*?\]\]);/, "SEEDS"),
  ICOV: extract(/const ICOV=(\[\[.*?\]\]);/, "ICOV"),
  VIEW: extract(/const VIEW=(\[.*?\]);/, "VIEW"),
};

// sanity-check the extracted source actually evaluates to what we expect
const check = new Function(`return {
  QUESTIONS: ${DATA.QUESTIONS},
  ARCHETYPES: ${DATA.ARCHETYPES},
  SEEDS: ${DATA.SEEDS},
  ICOV: ${DATA.ICOV},
  VIEW: ${DATA.VIEW}
}`)();

if (check.SEEDS.length !== check.ARCHETYPES.length) {
  throw new Error(`SEEDS (${check.SEEDS.length}) and ARCHETYPES (${check.ARCHETYPES.length}) must align by index`);
}
if (!check.QUESTIONS.length) throw new Error("no questions extracted");

const dataBlock = Object.entries(DATA)
  .map(([k, v]) => `const ${k} = ${v};`)
  .join("\n");

const app = fs.readFileSync(path.join(here, "src", "app.js"), "utf8");
if (!app.includes("/*__DATA__*/")) throw new Error("src/app.js is missing the /*__DATA__*/ placeholder");

// Every archetype's reference point must have a link. Upstream can rename or
// re-cast a person at any time, and a silently link-less name is easy to miss.
{
  const m = app.match(/const REFERENCE_LINKS = (\{[\s\S]*?\n\});/);
  if (!m) throw new Error("could not find REFERENCE_LINKS in src/app.js");
  const links = new Function(`return ${m[1]}`)();
  const missing = check.ARCHETYPES.map((a) => a.person).filter((p) => !links[p]);
  if (missing.length) {
    throw new Error(
      `no reference link for: ${missing.join(", ")}\n` +
        `Add them to REFERENCE_LINKS in src/app.js.`
    );
  }
  const unused = Object.keys(links).filter((p) => !check.ARCHETYPES.some((a) => a.person === p));
  if (unused.length) console.warn(`  note: unused reference links (person renamed upstream?): ${unused.join(", ")}`);
}

const html = fs
  .readFileSync(path.join(here, "src", "index.template.html"), "utf8")
  .replace("/*__APP__*/", () => app.replace("/*__DATA__*/", () => dataBlock));

const out = path.join(here, "public", "index.html");
fs.writeFileSync(out, html);

console.log(
  `built ${path.relative(process.cwd(), out)} — ` +
    `${check.QUESTIONS.length} questions, ${check.ARCHETYPES.length} archetypes, ` +
    `${(html.length / 1024).toFixed(0)} KB, zero external requests`
);

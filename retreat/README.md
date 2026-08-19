# The AI Compass — retreat edition

A shared-board variant of [the AI Compass](https://bambamramfan.github.io/ai-compass/):
everyone in the room takes the quiz, and all the results land as dots on one
projected chart.

The quiz content and the classifier calibration are **extracted from
`../index.html` at build time**, not copied. Scoring is bit-identical to
upstream (verified over 20,000 random answer vectors). Pull upstream, re-run
`npm run build`, and this picks up their changes.

## Setup

```sh
cd retreat
npx wrangler login          # one time, opens a browser
npm run migrate             # applies the schema to the production D1 database
npm run deploy              # build + static checks + ship
```

`npm run deploy` is self-contained — it doesn't need a dev server or a browser.
Run `npm test` first if you want the full browser suite to gate the deploy.

`npm run dev` runs it locally against a local SQLite database — run
`npm run migrate:local` once first. No Cloudflare account needed for that.

## Solo by default, groups by opt-in

The root URL is **just the quiz**. No room, no name, no polling, and nothing
sent to the server — answers stay in `localStorage` on that device. The result
screen offers **Share with a group**, which asks for a room code and a display
name and only then posts anything. Enforced by a test: `submit()` returns early
without a room, and the browser suite checks the room is still empty at the
moment the join form is open.

A room in the query string still drops you straight into that room, which is
what you want for a retreat invite link — but **the name is asked for at the
end either way**. An invite link says "put me on this board"; it doesn't say
"here is what to call me", and asking before the quiz means naming yourself
before you know what the name gets attached to. So the invite flow is the
generic flow with the room code already filled in: take the quiz, see your
result, then choose a name and post. Nothing reaches the server before that —
asserted by a test that fetches the room's board at the moment the result
appears and requires it to be empty.

The only difference from the solo opt-in is that the room code is fixed text
rather than an input, so nobody can typo a code they were handed into a private
board of one.

A retake by someone already on the board skips all of it and just moves their
dot.

## Running the activity

Pick a room code — anything matching `[a-z0-9][a-z0-9-]{0,31}`, e.g. `offsite-2026`.

| Who | URL |
|---|---|
| Participants | `https://<your-worker>.workers.dev/?room=offsite-2026` |
| Projector | `https://<your-worker>.workers.dev/?room=offsite-2026&board=1` |
| Anyone, solo | `https://<your-worker>.workers.dev/` |

The board polls every 4 seconds, so dots appear as people finish. Participants
get an anonymous handle (`Umber Raven`) prefilled, which they can replace with
their real name. The poll skips its repaint while the name box is open, since
rebuilding the form would wipe a half-typed name. Names are drawn on the chart itself up to 28 people; past that
it falls back to the chip legend below the chart.

Retaking updates your existing dot rather than adding a second one — the entry
id is kept in `localStorage`, scoped per room.

## Multi-select and "none of these"

Each question accepts **any number of options**; the selected ones are averaged,
so a question contributes one point to your score either way. Picking exactly
one scores identically to upstream — verified over 20,000 random answer sets.

This was the most-requested change in the public reaction (people repeatedly said
several options were simultaneously true — "theft, slop, and drafting tool all
feel valid to me"). There's also an explicit **"None of these fit my view"**,
distinct from skipping: it records that you engaged with the question but
contributes nothing to the score.

**Skipping is not allowed.** Next stays disabled until a question is answered,
so every result is computed over all 15 questions. Averaging over fewer answers
inflates variance and throws people outward into extreme archetypes: the same
person's position drifts 1.03 units on 11 answers and 2.41 on 5, against
territories only ~1.5-2 units across. "None of these" is the one deliberate
exception and still drops the question — imputing a value was considered and
rejected, because the natural imputation (that question's option average) biases
toward the middling view the question offers, which is precisely wrong for
someone who picked "none" because every option was too mild.

Averaging pulls each answer toward its question's centroid, so heavy
multi-selecting shrinks the population cloud. Measured with
`node ../tools/fit-seeds.mjs --evaluate --multi <rate>`:

| multi-select rate | concentration (Gini) | archetypes reachable |
|---|---|---|
| 0 (upstream behaviour) | 0.237 | 30 / 30 |
| 0.15 | 0.250 | 30 / 30 |
| 0.30 | 0.293 | 30 / 30 |
| 0.50 | 0.368 | 30 / 30 |

Mild, and nothing becomes unreachable, so the shipped `SEEDS`/`ICOV` are still
valid — no refit needed.

## Shareable result links

The result screen has **Copy link to these answers**. The answer set is encoded
in the URL *fragment* (`#a=…`), one byte per question — a bitmask of the chosen
options, `0xff` for "none of these", `0` for skipped. A full 15-question answer
set is 20 characters, and because it's a fragment it never reaches the server.

Opening someone else's link shows *their* result, framed as theirs, and does
**not** post anything to the board — there's a "Take it myself" button for that.
Malformed fragments fall back to a normal start.

## Named reference points

"Patron saint" is relabelled **reference point**, and each name links out so
people can read the person rather than just recognise the name. Links live in
`REFERENCE_LINKS` in `src/app.js` — deliberately *not* in `../index.html`, so
that file stays byte-identical to upstream. `build.mjs` fails the build if any
archetype's person has no link, and warns if a link is left orphaned by an
upstream rename.

All 30 were checked to resolve. Preference is the person's own primary site
where that's what they're known for (`pluralistic.net`, `wheresyoured.at`,
`simonwillison.net`), and Wikipedia where there's no reachable personal site or
the site blocks readers (Herndon, Swisher, Levine, Yudkowsky).

Deliberately **not** done: reassigning anyone. Upstream issues #1 (Doctorow) and
#2 (Herndon) are substantive factual objections, and picking replacement names
is an editorial call for a human, not something to do unilaterally.

## All 30 compass points

Both the result screen and the big board link to a full map: every territory
numbered, with each archetype's name, reference-point link, and description.
Hovering or tapping a region on any chart lights that territory up and names it
— without that the map is 30 unlabelled colour patches, which is no use on a
projected board.

## Scope note

The intro states plainly that "AI" here means generative AI — chatbots and LLMs —
not machine learning generally. This was the sharpest expert criticism of the
original ("medical advancements are not coming from LLMs", from someone who did
their PhD in the area). It costs nothing and changes no options, so no
recalibration was needed.

## Tests

```sh
npm test            # build + static checks + full browser click-through
npm run test:static # scoring, self-containment, classifier sanity — no browser
npm run test:e2e    # drives headless Chrome over CDP, 66 checks
```

Nothing to set up: `test:e2e` reuses a dev server if one is already listening on
8799, otherwise starts its own and shuts it down afterwards. It needs Chrome at
`/Applications/Google Chrome.app`.

## Storage model

D1 (SQLite), one row per submission:

```sql
CREATE TABLE entries (
  id TEXT PRIMARY KEY, room TEXT NOT NULL, name TEXT NOT NULL,
  impact REAL NOT NULL, valence REAL NOT NULL, archetype INTEGER NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_entries_room ON entries (room, created_at);
```

A board read is one indexed `SELECT`. A row per submission (rather than one blob
per room) means two people finishing simultaneously can't clobber each other —
a blob would need read-modify-write and would silently lose one of them.

`id` is the capability the client holds: presenting it updates that row, which
is how a retake replaces your dot instead of adding a second one. It's scoped to
its room, so an id from one room can't move or overwrite an entry in another.

D1 has no TTL, so a retention sweep (`DELETE ... WHERE updated_at < ?`) runs
opportunistically on write via `ctx.waitUntil`, off the response path, and
failures there can never break a submission.

**Retention is 30 days** (`RETENTION_DAYS` in `src/worker.js`), measured per
entry from its last update, not per room — a room stays alive as long as people
keep retaking in it, and empties 30 days after its last activity.

It's a floor, not a deadline: the sweep only runs when someone new joins *some*
room, so on a quiet deployment old rows sit there until the next arrival.
Nothing is deleted early; something may be deleted late. Run the `DELETE` by
hand if you want it gone on a schedule. Both halves are tested — the constant in
`test/static.mjs`, and the sweep itself in `test/e2e.mjs`, which backdates a row
underneath the running worker and checks it disappears while a fresh one stays.

### Why not KV

This was KV first. Two things drove the switch, both visible in the diff:

1. **KV is eventually consistent.** The `list()` immediately after a write often
   didn't contain that write, so you'd sit looking at a board you weren't on for
   ~10 seconds. That needed a client-side optimistic-merge-and-pin to paper over.
   D1 is read-after-write consistent — verified by a test that posts and reads
   back with no delay, ten times.
2. **KV wasn't inspectable.** To keep board reads to one operation, the payload
   had to live in the KV key's *metadata* (values were empty strings), which made
   `wrangler kv key get` useless and forced a bespoke browsing tool. Now it's SQL.

What the switch did *not* change: it's still polling. Other people's dots appear
on the next 4s refresh. A Durable Object with a WebSocket is the fix if that ever
matters.

## Inspecting and repairing rooms

It's a database, so you can just ask it:

```sh
npx wrangler d1 execute ai-compass-retreat --remote \
  --command "SELECT room, COUNT(*) FROM entries GROUP BY room"
```

Fixing a mistyped room code is one atomic statement:

```sh
npx wrangler d1 execute ai-compass-retreat --remote \
  --command "UPDATE entries SET room='offsite-2026' WHERE room='offsite2026'"
```

`npm run rooms` is a thin convenience wrapper over exactly that:

```sh
npm run rooms                            # rooms, counts, names, likely typos
npm run rooms -- --room offsite-2026     # one room in detail
npm run rooms -- --move BAD GOOD         # preview
npm run rooms -- --move BAD GOOD --yes   # apply
npm run rooms -- --sql "SELECT ..."      # your own read-only query
```

Add `--local` for the dev database. `--move` dry-runs unless given `--yes`.

Typo detection flags any room whose code is within two edits of a much busier
room. Moving someone doesn't update their browser — their URL still has the old
room code, so send them the corrected link.

## Limits and validation

- 300 responses per room, 24-character names, control characters stripped.
- Room codes are validated server-side; coordinates and archetype index are
  range-checked.
- There is **no authentication**. Anyone with the room code can post a dot, and
  anyone who guesses a room code can read it. That's the right trade for a
  retreat activity; don't put anything sensitive in a display name.

## Differences from upstream

- No React, no Babel, no CDN — one self-contained 66 KB HTML file instead of
  ~3 MB of CDN JavaScript compiled in the browser. Matters on conference wifi,
  and upstream already ships a fallback UI for when its CDN is blocked.
- The chart redraws on resize/rotate (upstream draws once at mount).
- Solo by default, group participation opt-in (see above).
- Multi-select and "none of these" (see above).
- Shareable answer permalinks; reference points link out.
- No skipping; an "all 30 compass points" map with hover-to-name regions.
- A favicon (inline SVG data URI, so the page stays self-contained).

Deliberately *not* changed: the question wording, the option set, and the
single-selection scoring. Changing the options would decalibrate `SEEDS`/`ICOV`.
`../tools/fit-seeds.mjs` exists to recalibrate when you do want to change them.

## Layout

```
build.mjs               extracts quiz data from ../index.html, emits public/index.html
migrations/             D1 schema (npm run migrate / migrate:local)
src/index.template.html page shell and styles
src/app.js              the app (vanilla JS)
src/worker.js           API + static asset serving
public/index.html       build output — generated, don't edit
test/static.mjs         scoring/self-containment checks, no browser needed
test/e2e.mjs            headless-Chrome click-through; starts its own dev server
tools/rooms.mjs         inspect/repair rooms — a wrapper over `wrangler d1 execute`
../tools/fit-seeds.mjs  refit or audit the classifier constants
```

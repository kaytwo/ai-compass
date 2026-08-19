/**
 * The AI Compass — retreat edition.
 *
 * Storage is D1 (SQLite). It replaced a KV design, and the reasons are worth
 * keeping written down:
 *
 *   - D1 is strongly consistent. Under KV, the list() immediately after a write
 *     often didn't contain that write, so you sat looking at a board you weren't
 *     on for ~10 seconds. That needed a client-side optimistic merge to hide.
 *   - One row per submission means concurrent finishers can't clobber each other
 *     (a single per-room blob would need read-modify-write and would lose one of
 *     them), while a board read is still a single query.
 *   - It's inspectable. The KV design had to stash the payload in key *metadata*
 *     to keep board reads to one operation, which made `kv key get` useless and
 *     forced a bespoke browsing tool. Here it's SELECT.
 *
 * Still polling, not push — other people's dots appear on the client's next
 * refresh. A Durable Object with a WebSocket is the fix if that's ever wanted.
 */

const MAX_ENTRIES_PER_ROOM = 300;
const MAX_NAME_LEN = 24;
const RETENTION_DAYS = 30;
// Per entry, measured from its last update — not per room. A room stays alive as
// long as people keep retaking in it, and empties out 30 days after its last
// activity. Only a floor, though: see the sweep in insertNew().
const RETENTION_MS = 1000 * 60 * 60 * 24 * RETENTION_DAYS;
const ROOM_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ID_RE = /^[0-9a-f-]{36}$/i;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const bad = (msg, status = 400) => json({ error: msg }, status);

function cleanName(raw) {
  if (typeof raw !== "string") return "";
  // strip control chars and collapse whitespace so nothing can wreck the board layout
  const s = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return s.slice(0, MAX_NAME_LEN);
}

const finite = (n, lo, hi) => typeof n === "number" && Number.isFinite(n) && n >= lo && n <= hi;

const toEntry = (row) => ({
  id: row.id,
  name: row.name,
  i: row.impact,
  v: row.valence,
  a: row.archetype,
  t: row.created_at,
});

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/room\/([^/]+)\/?$/);

    if (!match) {
      if (url.pathname.startsWith("/api/")) return bad("not found", 404);
      return env.ASSETS.fetch(request);
    }

    if (!env.DB) return bad("D1 binding missing — check wrangler.toml", 500);

    const room = decodeURIComponent(match[1]).toLowerCase();
    if (!ROOM_RE.test(room)) return bad("invalid room code");

    if (request.method === "GET") {
      const { results } = await env.DB
        .prepare(
          `SELECT id, name, impact, valence, archetype, created_at
             FROM entries WHERE room = ?1 ORDER BY created_at LIMIT ?2`
        )
        .bind(room, MAX_ENTRIES_PER_ROOM)
        .all();
      return json({ room, entries: (results || []).map(toEntry) });
    }

    if (request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return bad("expected a JSON body");
      }
      if (!body || typeof body !== "object") return bad("expected a JSON object");

      const name = cleanName(body.name) || "Anonymous";
      if (!finite(body.i, -20, 20) || !finite(body.v, -20, 20)) return bad("coordinates out of range");
      if (!Number.isInteger(body.a) || body.a < 0 || body.a > 99) return bad("invalid archetype index");

      const now = Date.now();
      const impact = +body.i.toFixed(3);
      const valence = +body.v.toFixed(3);

      // A retake reuses the caller's id so the board updates in place rather
      // than growing a trail of stale dots for the same person. The update is
      // scoped to the room, so an id from one room can't rewrite another's.
      const claimed = typeof body.id === "string" && ID_RE.test(body.id) ? body.id : null;

      if (claimed) {
        const updated = await env.DB
          .prepare(
            `UPDATE entries SET name = ?1, impact = ?2, valence = ?3, archetype = ?4, updated_at = ?5
              WHERE id = ?6 AND room = ?7`
          )
          .bind(name, impact, valence, body.a, now, claimed, room)
          .run();
        if (updated.meta && updated.meta.changes > 0) {
          const row = await env.DB
            .prepare(`SELECT id, name, impact, valence, archetype, created_at FROM entries WHERE id = ?1`)
            .bind(claimed)
            .first();
          return json({ id: claimed, entry: toEntry(row) });
        }
        // fall through: this id isn't in this room. If it belongs to a *different*
        // room, don't reuse it — under KV each room held its own key, so an id
        // was never a capability across rooms, and an INSERT..ON CONFLICT here
        // would silently relocate that person's dot out of the other room.
        const elsewhere = await env.DB
          .prepare(`SELECT room FROM entries WHERE id = ?1`)
          .bind(claimed)
          .first();
        if (elsewhere) return await insertNew(env, ctx, room, name, impact, valence, body.a, now, null);
      }

      return await insertNew(env, ctx, room, name, impact, valence, body.a, now, claimed);
    }

    return bad("method not allowed", 405);
  },
};

async function insertNew(env, ctx, room, name, impact, valence, archetype, now, claimed) {
  const full = await env.DB
    .prepare(`SELECT COUNT(*) AS count FROM entries WHERE room = ?1`)
    .bind(room)
    .first();
  if ((full ? full.count : 0) >= MAX_ENTRIES_PER_ROOM) {
    return bad("this room is full (" + MAX_ENTRIES_PER_ROOM + " responses)", 429);
  }

  const id = claimed || crypto.randomUUID();
  await env.DB
    .prepare(
      `INSERT INTO entries (id, room, name, impact, valence, archetype, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`
    )
    .bind(id, room, name, impact, valence, archetype, now)
    .run();

  // Opportunistic retention sweep, off the response path. KV expired rows for
  // us via expirationTtl; D1 has no TTL, so this stands in for it. Note this
  // only fires when someone NEW joins some room — a retake doesn't trigger it,
  // and a quiet deployment sweeps nothing. So RETENTION_DAYS is a "not deleted
  // before" guarantee, not a "deleted by".
  ctx.waitUntil(
    env.DB.prepare(`DELETE FROM entries WHERE updated_at < ?1`)
      .bind(now - RETENTION_MS)
      .run()
      .catch(() => {}) // a failed sweep must never break a submission
  );

  return json({ id, entry: { id, name, i: impact, v: valence, a: archetype, t: now } });
}

-- One row per submission. `id` is the client-held capability: whoever has it can
-- update that row (that's how a retake replaces your dot instead of adding a
-- second one), scoped to the room it belongs to.
CREATE TABLE IF NOT EXISTS entries (
  id         TEXT    PRIMARY KEY,
  room       TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  impact     REAL    NOT NULL,
  valence    REAL    NOT NULL,
  archetype  INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Board reads are always "everyone in this room, oldest first".
CREATE INDEX IF NOT EXISTS idx_entries_room ON entries (room, created_at);

-- KV expired rows for us via expirationTtl; D1 has no TTL, so old rooms are
-- swept opportunistically on write instead. This index keeps that sweep cheap.
CREATE INDEX IF NOT EXISTS idx_entries_updated ON entries (updated_at);

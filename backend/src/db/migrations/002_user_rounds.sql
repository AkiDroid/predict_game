-- Durable per-user round history (stats). Sessions live in Redis, not here.

CREATE TABLE user_rounds (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  played_at INTEGER NOT NULL,
  payload TEXT NOT NULL
) STRICT;

CREATE INDEX user_rounds_user_played_idx ON user_rounds(user_id, played_at);

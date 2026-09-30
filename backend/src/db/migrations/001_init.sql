-- Application state. Candle series stay in data/processed/*.bin.
-- users and sessions are reserved for the account system and have no writers yet.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
) STRICT;

CREATE INDEX sessions_user_id_idx ON sessions(user_id);

-- Answer index for an open round. user_id is null until login stamps the player.
CREATE TABLE rounds (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  symbol TEXT NOT NULL,
  play_tf TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('direction', 'bracket')),
  last_idx INTEGER NOT NULL,
  next_idx INTEGER NOT NULL,
  cutoff INTEGER NOT NULL,
  vol_bucket TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'revealed', 'expired')),
  created_at INTEGER NOT NULL,
  revealed_at INTEGER
) STRICT;

CREATE INDEX rounds_status_created_idx ON rounds(status, created_at);
CREATE INDEX rounds_user_id_idx ON rounds(user_id);

CREATE TABLE series_catalog (
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  bar_count INTEGER NOT NULL,
  t_from INTEGER NOT NULL,
  t_to INTEGER NOT NULL,
  loaded_at INTEGER NOT NULL,
  PRIMARY KEY (symbol, timeframe)
) STRICT;

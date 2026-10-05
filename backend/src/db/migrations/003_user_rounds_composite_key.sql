-- Round ids are client-generated, so they only need to be unique per user.

CREATE TABLE user_rounds_new (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  played_at INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
) STRICT;

INSERT INTO user_rounds_new (user_id, id, played_at, payload)
SELECT user_id, id, played_at, payload FROM user_rounds;

DROP TABLE user_rounds;
ALTER TABLE user_rounds_new RENAME TO user_rounds;

CREATE INDEX user_rounds_user_played_idx ON user_rounds(user_id, played_at);

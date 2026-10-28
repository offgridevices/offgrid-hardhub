-- Accounts, sign-in and projects. A project's conversation and design live
-- in its ProjectRoom Durable Object; this table is the index the project
-- list reads.

CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  -- who runs the AI for this person (protocol LlmSettings)
  llm_provider TEXT NOT NULL DEFAULT 'anthropic',
  llm_model    TEXT NOT NULL DEFAULT 'claude-opus-5-5',
  llm_base_url TEXT,
  created_at  TEXT NOT NULL
);

-- only the SHA-256 of a session token is stored
CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

-- one-time sign-in links, also stored hashed
CREATE TABLE login_tokens (
  token_hash  TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT
);

CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  stage       TEXT NOT NULL DEFAULT 'idea',
  thumbnail   TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX projects_user ON projects(user_id, updated_at);

-- the person's own AI provider keys, AES-GCM encrypted with KEY_ENCRYPTION_KEY;
-- only the last four characters are ever returned
CREATE TABLE api_keys (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,
  ciphertext  TEXT NOT NULL,
  iv          TEXT NOT NULL,
  last4       TEXT NOT NULL,
  added_at    TEXT NOT NULL,
  PRIMARY KEY (user_id, provider)
);

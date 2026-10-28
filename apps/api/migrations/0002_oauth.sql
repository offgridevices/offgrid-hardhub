-- Agents that connect over MCP (Claude, ChatGPT, Codex...) sign in with
-- OAuth 2.1: they register themselves, the person allows them on the consent
-- page, and they get an access token (a session row marked with the client)
-- and a refresh token. Every token and code is stored only as its SHA-256.

-- clients that registered themselves (RFC 7591); clients that identify with
-- a metadata URL (client_id is that https URL) are cached here too
CREATE TABLE oauth_clients (
  client_id     TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  redirect_uris TEXT NOT NULL, -- JSON array
  created_at    TEXT NOT NULL
);

-- one-time authorization codes, PKCE-bound, ten minutes
CREATE TABLE oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  used_at        TEXT
);

-- one row per allowed connection: its current refresh token, and the access
-- token issued with it (replaced together on every refresh)
CREATE TABLE oauth_grants (
  refresh_hash  TEXT PRIMARY KEY,
  access_hash   TEXT NOT NULL,
  client_id     TEXT NOT NULL,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connected_at  TEXT NOT NULL,
  refreshed_at  TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);
CREATE INDEX oauth_grants_user ON oauth_grants(user_id, client_id);

-- an access token is a session that only the MCP endpoint accepts
ALTER TABLE sessions ADD COLUMN client_id TEXT;

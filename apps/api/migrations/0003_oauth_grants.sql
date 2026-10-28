-- Each allowed connection gets a stable id that its codes, refresh tokens and
-- access tokens all point to, so one call can end all of it: on Disconnect,
-- on a code used twice, or on a refresh token used again after it was rotated
-- (someone else holds a copy). prev_hash is the refresh token just replaced.
-- Access tokens now find their grant through sessions.grant_id, so
-- oauth_grants.access_hash is no longer used (left empty).
ALTER TABLE oauth_grants ADD COLUMN grant_id TEXT;
ALTER TABLE oauth_grants ADD COLUMN prev_hash TEXT;
ALTER TABLE oauth_grants ADD COLUMN rotated_at TEXT;
CREATE INDEX oauth_grants_prev ON oauth_grants(prev_hash);
CREATE INDEX oauth_grants_grant ON oauth_grants(grant_id);

ALTER TABLE oauth_codes ADD COLUMN grant_id TEXT;
CREATE INDEX oauth_codes_user ON oauth_codes(user_id, client_id);

ALTER TABLE sessions ADD COLUMN grant_id TEXT;
CREATE INDEX sessions_grant ON sessions(grant_id);

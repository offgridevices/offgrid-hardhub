-- Sign-in by email and password, with no email service. The emailed one-time
-- links (login_tokens) are gone.
ALTER TABLE users ADD COLUMN password_hash TEXT;
DROP TABLE login_tokens;

-- failed sign-ins per email, so a password cannot be guessed quickly
CREATE TABLE login_failures (
  email     TEXT PRIMARY KEY,
  count     INTEGER NOT NULL,
  first_at  TEXT NOT NULL
);

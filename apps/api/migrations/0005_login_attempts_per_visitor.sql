-- Sign-in attempts are counted per email and visitor address ("email|ip"),
-- so a stranger guessing at an email cannot lock its owner out.
ALTER TABLE login_failures RENAME COLUMN email TO key;

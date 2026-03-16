ALTER TABLE users
  ADD COLUMN IF NOT EXISTS auth_provider text DEFAULT 'password';

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS google_sub text NULL;

UPDATE users
SET auth_provider = 'password'
WHERE auth_provider IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_unique
ON users (google_sub)
WHERE google_sub IS NOT NULL;

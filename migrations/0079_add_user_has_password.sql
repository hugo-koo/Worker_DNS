-- Track whether a user has explicitly configured a password (0 = passwordless account with server-generated 64-char placeholder hash)
ALTER TABLE users ADD COLUMN has_password INTEGER NOT NULL DEFAULT 1;

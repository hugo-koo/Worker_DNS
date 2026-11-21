-- Migration 0076: Allow the same passkey credential_id to be bound to multiple users (many-to-many)
-- Replaces the global UNIQUE constraint on passkeys(credential_id) with a composite UNIQUE(user_id, credential_id).

PRAGMA foreign_keys = OFF;

CREATE TABLE passkeys_new (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    credential_id TEXT NOT NULL,
    public_key TEXT NOT NULL,
    algorithm INTEGER NOT NULL DEFAULT -7,
    sign_count INTEGER NOT NULL DEFAULT 0,
    transports TEXT,
    aaguid TEXT,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO passkeys_new (
    id, user_id, name, credential_id, public_key, algorithm, sign_count, transports, aaguid, created_at, last_used_at
)
SELECT
    id, user_id, name, credential_id, public_key, algorithm, sign_count, transports, aaguid, created_at, last_used_at
FROM passkeys;

DROP TABLE passkeys;
ALTER TABLE passkeys_new RENAME TO passkeys;

CREATE INDEX IF NOT EXISTS idx_passkeys_user ON passkeys(user_id);
CREATE INDEX IF NOT EXISTS idx_passkeys_credential ON passkeys(credential_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_passkeys_user_credential ON passkeys(user_id, credential_id);

PRAGMA foreign_keys = ON;

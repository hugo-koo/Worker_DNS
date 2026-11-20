-- Decouple access_points ownership from profiles so each Access Point belongs to a user (owner_id)
-- and can dynamically switch its bound profile (profile_id, nullable with ON DELETE SET NULL).
PRAGMA foreign_keys = OFF;

CREATE TABLE access_points_new (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    profile_id TEXT,
    name TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE SET NULL
);

INSERT INTO access_points_new (id, owner_id, profile_id, name, token, created_at, updated_at)
SELECT
    ap.id,
    p.owner_id,
    ap.profile_id,
    ap.name,
    ap.token,
    ap.created_at,
    ap.updated_at
FROM access_points ap
JOIN profiles p ON ap.profile_id = p.id;

DROP TABLE access_points;
ALTER TABLE access_points_new RENAME TO access_points;

CREATE INDEX IF NOT EXISTS idx_access_points_owner ON access_points(owner_id);
CREATE INDEX IF NOT EXISTS idx_access_points_profile ON access_points(profile_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_access_points_token ON access_points(token);

PRAGMA foreign_keys = ON;

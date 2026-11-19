-- Migration 0073: Persist system filter lists independently and allow user-level lists per scope
--
-- 1. system_lists: Authoritative registry of admin-distributed system filter lists.
--    Ensures distributing a list writes to System Filter Lists even when all existing users already
--    have the URL in user_lists (and are skipped) or when there are zero users.
-- 2. user_lists: Scope uniqueness updated from UNIQUE(user_id, url) to UNIQUE(user_id, url, is_system)
--    so a user can explicitly add a URL to User-Level Filter Lists even if it is already active
--    as a system-distributed list (is_system = 1).

PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS system_lists (
    url TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO system_lists (url, created_at)
SELECT url, MIN(created_at)
FROM user_lists
WHERE is_system = 1
GROUP BY url;

CREATE TABLE IF NOT EXISTS user_lists_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    url TEXT NOT NULL,
    is_system INTEGER DEFAULT 0, -- 0: User-created, 1: System-distributed
    enabled INTEGER DEFAULT 1,    -- Default enabled state for the user
    created_at INTEGER NOT NULL,  -- Integer Unix timestamp in seconds
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, url, is_system)
);

INSERT OR IGNORE INTO user_lists_v2 (id, user_id, url, is_system, enabled, created_at)
SELECT id, user_id, url, is_system, enabled, created_at
FROM user_lists;

DROP TABLE user_lists;
ALTER TABLE user_lists_v2 RENAME TO user_lists;

CREATE INDEX IF NOT EXISTS idx_user_lists_user_id ON user_lists(user_id);
CREATE INDEX IF NOT EXISTS idx_user_lists_url ON user_lists(url);

PRAGMA foreign_keys = ON;

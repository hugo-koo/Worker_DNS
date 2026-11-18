-- Migration 0071: Eliminate write amplification across logs, hourly_rollups, and kem_keys
--
-- 1. Purge dead, unread E2EE rollup rows (key LIKE 'enc:%') from hourly_rollups.
-- 2. Drop all secondary indexes on logs (including idx_logs_kem_key_id) and rebuild logs
--    without the kem_key_id FOREIGN KEY constraint so KemKeyModel orphan cleanup never
--    triggers full-table scans when idx_logs_kem_key_id is absent.
--    Reduces logs write amplification from 3 rows/insert down to 1 (D1/SQLite) or 2 (Turso).
-- 3. Rebuild kem_keys as WITHOUT ROWID to cut rowid double-write overhead on D1/SQLite
--    (automatically stripped by Turso migration runner if WITHOUT ROWID is unsupported).

PRAGMA foreign_keys = OFF;

-- 1. Remove historical unread encrypted rollup rows
DELETE FROM hourly_rollups WHERE key LIKE 'enc:%';

-- 2. Drop all secondary indexes on logs
DROP INDEX IF EXISTS idx_logs_kem_key_id;
DROP INDEX IF EXISTS idx_logs_profile_time;
DROP INDEX IF EXISTS idx_logs_domain;
DROP INDEX IF EXISTS idx_logs_access_point;
DROP INDEX IF EXISTS idx_logs_profile_ap_time;
DROP INDEX IF EXISTS idx_logs_profile_action_time;
DROP INDEX IF EXISTS idx_logs_profile_geo_time;
DROP INDEX IF EXISTS idx_logs_profile_reason_time;
DROP INDEX IF EXISTS idx_logs_profile_domain_time;
DROP INDEX IF EXISTS idx_logs_profile_record_type_time;

-- 3. Rebuild logs as clustered WITHOUT ROWID without foreign-key constraint on kem_key_id
CREATE TABLE IF NOT EXISTS logs_v3 (
    profile_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    id INTEGER NOT NULL,
    client_ip TEXT,
    geo_country TEXT,
    domain TEXT NOT NULL,
    record_type TEXT NOT NULL,
    action TEXT CHECK(action IN ('PASS', 'BLOCK', 'REDIRECT', 'FAIL')) NOT NULL,
    reason TEXT,
    answer TEXT,
    dest_geoip TEXT,
    ecs TEXT,
    upstream TEXT,
    latency INTEGER,
    access_point_id TEXT,
    dest_country_code TEXT,
    dest_country TEXT,
    dest_isp TEXT,
    encrypted_payload TEXT,
    encrypt_version INTEGER NOT NULL DEFAULT 0,
    kem_key_id TEXT,
    PRIMARY KEY (profile_id, timestamp, id)
) WITHOUT ROWID;

INSERT INTO logs_v3 (
    profile_id, timestamp, id, client_ip, geo_country, domain, record_type, action,
    reason, answer, dest_geoip, ecs, upstream, latency, access_point_id,
    dest_country_code, dest_country, dest_isp, encrypted_payload, encrypt_version, kem_key_id
)
SELECT
    profile_id, timestamp, id, client_ip, geo_country, domain, record_type, action,
    reason, answer, dest_geoip, ecs, upstream, latency, access_point_id,
    dest_country_code, dest_country, dest_isp, encrypted_payload, encrypt_version, kem_key_id
FROM logs;

DROP TABLE logs;
ALTER TABLE logs_v3 RENAME TO logs;

-- 4. Rebuild kem_keys as WITHOUT ROWID to reduce rowid write amplification
CREATE TABLE IF NOT EXISTS kem_keys_v2 (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    kem_ct TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
) WITHOUT ROWID;

INSERT INTO kem_keys_v2 (id, profile_id, kem_ct, created_at, expires_at)
SELECT id, profile_id, kem_ct, created_at, expires_at FROM kem_keys;

DROP TABLE kem_keys;
ALTER TABLE kem_keys_v2 RENAME TO kem_keys;

CREATE INDEX IF NOT EXISTS idx_kem_keys_profile_time ON kem_keys(profile_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kem_keys_created_at ON kem_keys(created_at);

PRAGMA foreign_keys = ON;

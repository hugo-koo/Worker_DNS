-- Migration 0072: Rebuild hourly_rollups as clustered WITHOUT ROWID and compact dead encrypted entries
-- Complements 0071 by compacting freed B-tree pages after enc:% deletions, ensuring WITHOUT ROWID
-- clustering on supporting SQLite/D1 engines, and excluding any remaining unread enc:% rows.

CREATE TABLE IF NOT EXISTS hourly_rollups_v2 (
    profile_id TEXT NOT NULL,
    metric_type TEXT NOT NULL,
    hour_timestamp INTEGER NOT NULL,
    key TEXT NOT NULL,
    sub_key TEXT NOT NULL DEFAULT '',
    access_point_id TEXT NOT NULL DEFAULT '',
    count INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (
        profile_id,
        metric_type,
        hour_timestamp,
        key,
        sub_key,
        access_point_id
    )
) WITHOUT ROWID;

INSERT OR IGNORE INTO hourly_rollups_v2 (profile_id, metric_type, hour_timestamp, key, sub_key, access_point_id, count)
SELECT profile_id, metric_type, hour_timestamp, key, sub_key, access_point_id, count
FROM hourly_rollups
WHERE key NOT LIKE 'enc:%';

DROP TABLE hourly_rollups;
ALTER TABLE hourly_rollups_v2 RENAME TO hourly_rollups;

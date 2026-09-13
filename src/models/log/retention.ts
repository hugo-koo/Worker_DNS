import { D1Database } from "@cloudflare/workers-types";

/**
 * Model responsible for enforcing log retention policies and purging
 * expired raw resolution logs and rollup records.
 */
export class LogRetentionModel {
  constructor(private readonly db: D1Database) {}

  /**
   * Global log cleanup: runs on every cron trigger.
   *
   * Applies two independent safety caps per profile:
   *   1. Time-based: deletes logs older than min(user_setting, MAX_LOG_RETENTION_DAYS).
   *      The global cap prevents users from setting arbitrarily long retention periods
   *      (e.g. 360 days) that would cause D1 to overflow.
   *   2. Batch limiting: deletes at most 10,000 rows per profile per run to avoid
   *      exhausting daily D1 write quotas or causing CPU execution timeouts.
   *
   * Also purges expired entries from domain, log, client, and destination rollups.
   *
   * @param maxRetentionDays - Hard cap on log retention days (default 30).
   */
  async cleanupGlobal(maxRetentionDays = 30): Promise<void> {
    try {
      const { results: profiles } = await this.db.prepare(
        "SELECT id, settings FROM profiles"
      ).all<{ id: string; settings: string }>();

      if (!profiles || profiles.length === 0) {
        return;
      }

      const statements = [];

      for (const profile of profiles) {
        // ── 1. Time-based retention calculation ─────────────────────────────────
        let days = 30;
        try {
          const settings = JSON.parse(profile.settings);
          if (settings?.log_retention_days != null) {
            days = Number(settings.log_retention_days);
          }
        } catch {
          // Use default on parse error
        }

        // Enforce global hard cap: user setting cannot exceed maxRetentionDays
        const effectiveDays = Math.min(days, maxRetentionDays);
        const threshold = Math.floor(Date.now() / 1000 - effectiveDays * 24 * 3600);

        // Purge expired rollups matching retention policy
        statements.push(
          this.db.prepare(
            "DELETE FROM domain_hourly_rollups WHERE profile_id = ? AND hour_timestamp < ?"
          ).bind(profile.id, threshold)
        );
        statements.push(
          this.db.prepare(
            "DELETE FROM log_hourly_rollups WHERE profile_id = ? AND hour_timestamp < ?"
          ).bind(profile.id, threshold)
        );
        statements.push(
          this.db.prepare(
            "DELETE FROM client_hourly_rollups WHERE profile_id = ? AND hour_timestamp < ?"
          ).bind(profile.id, threshold)
        );
        statements.push(
          this.db.prepare(
            "DELETE FROM destination_hourly_rollups WHERE profile_id = ? AND hour_timestamp < ?"
          ).bind(profile.id, threshold)
        );

        // Delete up to 10,000 rows per profile per hourly cron run to prevent write spikes
        statements.push(
          this.db.prepare(`
            DELETE FROM logs WHERE (profile_id, timestamp, id) IN (
              SELECT profile_id, timestamp, id FROM logs WHERE profile_id = ? AND timestamp < ? LIMIT 10000
            )
          `).bind(profile.id, threshold)
        );
      }

      if (statements.length > 0) {
        // Chunk deletions into batches of 50 to avoid D1 batch limit exceptions
        const CHUNK_SIZE = 50;
        for (let i = 0; i < statements.length; i += CHUNK_SIZE) {
          const chunk = statements.slice(i, i + CHUNK_SIZE);
          await this.db.batch(chunk);
        }
      }

      console.log(
        `[LogRetentionModel] cleanupGlobal: processed ${profiles.length} profile(s), maxRetentionDays=${maxRetentionDays}d`
      );
    } catch (e: any) {
      console.error("[LogRetentionModel] cleanupGlobal failed:", e.message || e);
    }
  }
}

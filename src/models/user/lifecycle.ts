import { D1Database } from "@cloudflare/workers-types";
import { InactivityPolicyResult } from "./types";
import { prepareBoundedLogDeleteStatement } from "../log/core";

/**
 * Handles account activity timestamp tracking and automated data retention / inactivity cleanup policies.
 *
 * Single Responsibility: Account resolution activity tracking and periodic inactivity retention enforcement.
 */
export class UserLifecycleModel {
  constructor(private db: D1Database, private env?: unknown) {}

  /**
   * Updates the `last_active_at` timestamp of the user who owns the specified profile.
   * Called on incoming DNS queries to keep the user active.
   *
   * @param profileId Profile identifier.
   * @param now Current timestamp in seconds.
   * @returns True if the update succeeded.
   */
  async updateLastActiveByProfile(profileId: string, now: number): Promise<boolean> {
    const result = await this.db
      .prepare("UPDATE users SET last_active_at = ? WHERE id = (SELECT owner_id FROM profiles WHERE id = ?)")
      .bind(now, profileId)
      .run();
    return result.success;
  }

  /**
   * Applies the inactivity retention policies strictly based on DNS resolution activity:
   * 
   * 1. Inactivity Log Purge (INACTIVE_LOG_PURGE_DAYS, default 30 days):
   *    Cleans up all query logs and pre-aggregated hourly rollups for non-admin accounts that have had no DNS
   *    resolution traffic for consecutive days. All DNS profiles, custom lists, access points, and routing keys
   *    are completely preserved.
   * 
   * 2. Account Abandonment Cleanup (INACTIVITY_THRESHOLD_DAYS, default 180 days):
   *    Deletes abandoned non-admin user accounts that have had no DNS resolution activity for consecutive days.
   *    Judged strictly by resolution activity (last_active_at, or created_at if no queries ever resolved),
   *    NEVER by web login activity. Deleting the user cascades to all their profiles, access points, and metadata.
   *
   * @param now Current timestamp in seconds.
   * @param options Optional overrides for threshold days (useful for unit tests or customized triggers).
   * @returns Statistics on cleared profiles, deleted user accounts, and purged logs.
   */
  async applyInactivityPolicy(
    now: number,
    options?: { inactivityDays?: number; inactiveLogPurgeDays?: number; maxLogDeleteRows?: number }
  ): Promise<InactivityPolicyResult> {
    const envObj = (this.env || {}) as Record<string, unknown>;

    // 1. Resolve INACTIVITY_THRESHOLD_DAYS (Default: 180 days)
    const rawInactivityDays = options?.inactivityDays ?? envObj.INACTIVITY_THRESHOLD_DAYS;
    const parsedInactivityDays = rawInactivityDays !== undefined && rawInactivityDays !== ''
      ? Number(rawInactivityDays)
      : 180;
    const inactivityDays = Number.isFinite(parsedInactivityDays) && parsedInactivityDays > 0
      ? parsedInactivityDays
      : 180;

    // 2. Resolve INACTIVE_LOG_PURGE_DAYS (Default: 30 days, aliases: INACTIVE_LOG_CLEANUP_DAYS)
    const rawPurgeDays = options?.inactiveLogPurgeDays ?? envObj.INACTIVE_LOG_PURGE_DAYS ?? envObj.INACTIVE_LOG_CLEANUP_DAYS;
    const parsedPurgeDays = rawPurgeDays !== undefined && rawPurgeDays !== ''
      ? Number(rawPurgeDays)
      : 30;
    const inactiveLogPurgeDays = Number.isFinite(parsedPurgeDays) && parsedPurgeDays > 0
      ? parsedPurgeDays
      : 30;

    const maxLogDeleteRows = options?.maxLogDeleteRows && options.maxLogDeleteRows > 0
      ? options.maxLogDeleteRows
      : 5000;

    const purgeCutoff = now - inactiveLogPurgeDays * 24 * 3600;
    const abandonCutoff = now - inactivityDays * 24 * 3600;
    // Ensure all logs from accounts eligible for either log purge or abandonment are cleaned
    const logPurgeCutoff = Math.max(purgeCutoff, abandonCutoff);

    // 1. 清理闲置账号的历史查询日志与预聚合时序（使用有界批量删除，防止单一高流量废弃账号击穿写配额）
    const { results: logPurgeProfiles } = await this.db.prepare(`
      SELECT p.id
      FROM profiles p
      JOIN users u ON p.owner_id = u.id
      WHERE u.role = 'user'
        AND (u.last_active_at < ? OR (u.last_active_at IS NULL AND u.created_at < ?))
    `).bind(logPurgeCutoff, logPurgeCutoff).all<{ id: string }>();

    let purgedLogsCount = 0;
    const METRIC_TYPES = ['action', 'client', 'dest', 'domain', 'isp'] as const;

    if (logPurgeProfiles && logPurgeProfiles.length > 0) {
      const rollupDeleteStmts = logPurgeProfiles.flatMap((p) =>
        METRIC_TYPES.map((metric) =>
          this.db.prepare("DELETE FROM hourly_rollups WHERE profile_id = ? AND metric_type = ?").bind(p.id, metric)
        )
      );
      for (let i = 0; i < rollupDeleteStmts.length; i += 50) {
        await this.db.batch(rollupDeleteStmts.slice(i, i + 50));
      }

      let remainingBudget = maxLogDeleteRows;
      for (const p of logPurgeProfiles) {
        if (remainingBudget <= 0) break;
        const stmt = await prepareBoundedLogDeleteStatement(this.db, p.id, now + 86400, remainingBudget);
        if (!stmt) continue;
        const res = await stmt.run();
        const deleted = res.meta?.changes ?? res.meta?.rows_written ?? 0;
        purgedLogsCount += deleted;
        remainingBudget -= deleted;
      }
    }

    // 2. 判定长期废弃休眠账号 (根据解析活动判断，而非登录时间)：
    //    仅当名下所有 Profile 的 logs 已清空时再删除 Profile 与 User，避免孤儿日志残留或大事务锁表。
    const deleteAbandonedProfilesStmt = this.db.prepare(`
      DELETE FROM profiles 
      WHERE owner_id IN (
        SELECT id FROM users 
        WHERE role = 'user' 
          AND (last_active_at < ? OR (last_active_at IS NULL AND created_at < ?))
      )
      AND NOT EXISTS (SELECT 1 FROM logs l WHERE l.profile_id = profiles.id LIMIT 1)
    `).bind(abandonCutoff, abandonCutoff);

    const deleteAbandonedUsersStmt = this.db.prepare(`
      DELETE FROM users
      WHERE role = 'user'
        AND (last_active_at < ? OR (last_active_at IS NULL AND created_at < ?))
        AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.owner_id = users.id LIMIT 1)
    `).bind(abandonCutoff, abandonCutoff);

    const profRes = await deleteAbandonedProfilesStmt.run();
    const userRes = await deleteAbandonedUsersStmt.run();

    return {
      clearedProfiles: profRes.meta?.changes || 0,
      deletedUsers: userRes.meta?.changes || 0,
      purgedLogsCount
    };
  }
}

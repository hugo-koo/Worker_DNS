import { D1Database } from "@cloudflare/workers-types";
import { LogAggregationModel } from "../aggregation";
import { DomainCountResult } from "./types";
import { computeRollupWindow, buildRollupUnionParts, hasActiveE2eeKey } from "./rollupWindow";

/**
 * Handles top allowed and top blocked domain analytics.
 * Leverages `domain_hourly_rollups` to eliminate scanning millions of historical rows.
 */
export class LogDomainAnalytics {
  constructor(
    private readonly db: D1Database,
    private readonly aggregation?: LogAggregationModel
  ) {}

  /**
   * Retrieves top allowed domains for a given time range.
   *
   * @param profileId - Profile identifier.
   * @param since - Start timestamp in seconds.
   * @param until - End timestamp in seconds.
   * @param accessPointId - Optional device filter.
   * @returns Array of top allowed domain records ordered by count descending.
   */
  async getTopAllowed(
    profileId: string,
    since: number,
    until: number,
    accessPointId?: string
  ): Promise<DomainCountResult[]> {
    return this.queryTopDomains(profileId, since, until, "PASS", accessPointId);
  }

  /**
   * Retrieves top blocked/redirected domains for a given time range.
   *
   * @param profileId - Profile identifier.
   * @param since - Start timestamp in seconds.
   * @param until - End timestamp in seconds.
   * @param accessPointId - Optional device filter.
   * @returns Array of top blocked domain records ordered by count descending.
   */
  async getTopBlocked(
    profileId: string,
    since: number,
    until: number,
    accessPointId?: string
  ): Promise<DomainCountResult[]> {
    return this.queryTopDomains(profileId, since, until, "BLOCK_OR_REDIRECT", accessPointId);
  }

  private async queryTopDomains(
    profileId: string,
    since: number,
    until: number,
    mode: "PASS" | "BLOCK_OR_REDIRECT",
    accessPointId?: string
  ): Promise<DomainCountResult[]> {
    const rollupSubKeyFilter =
      mode === "PASS" ? "sub_key = 'PASS'" : "sub_key IN ('BLOCK', 'REDIRECT')";
    const logActionFilter =
      mode === "PASS" ? "action = 'PASS'" : "action IN ('BLOCK', 'REDIRECT')";

    const queryRawDomains = async (fromTs: number, toTs: number): Promise<DomainCountResult[]> => {
      let queryStr = `SELECT domain, COUNT(*) as count FROM logs WHERE profile_id = ? AND timestamp >= ? AND timestamp <= ? AND domain IS NOT NULL AND domain != '' AND domain != '[Encrypted]' AND ${logActionFilter}`;
      const params: (string | number)[] = [profileId, fromTs, toTs];
      if (accessPointId) {
        queryStr += " AND access_point_id = ?";
        params.push(accessPointId);
      }
      queryStr += " GROUP BY domain ORDER BY count DESC LIMIT 10";
      const { results } = await this.db
        .prepare(queryStr)
        .bind(...params)
        .all<DomainCountResult>();
      return results;
    };

    if (!this.aggregation) {
      if (await hasActiveE2eeKey(this.db, profileId)) return [];
      return queryRawDomains(since, until);
    }

    const [latestRollupHour, isE2eeActive] = await Promise.all([
      this.aggregation.getLatestDomainRollupHour(profileId),
      hasActiveE2eeKey(this.db, profileId)
    ]);
    const window = computeRollupWindow(since, until, latestRollupHour);

    if (!window.useRollups) {
      if (isE2eeActive) return [];
      return queryRawDomains(since, until);
    }

    const union = buildRollupUnionParts(
      since,
      until,
      window,
      (startHour, endHour) => {
        let where = `profile_id = ? AND metric_type = 'domain' AND ${rollupSubKeyFilter} AND key NOT LIKE 'enc:%' AND hour_timestamp >= ? AND hour_timestamp < ?`;
        const params: (string | number)[] = [profileId, startHour, endHour];
        if (accessPointId) {
          where += " AND access_point_id = ?";
          params.push(accessPointId);
        }
        return {
          sql: `SELECT key as domain, count FROM hourly_rollups WHERE ${where}`,
          params
        };
      },
      (fromTs, toTs) => {
        let where = `profile_id = ? AND timestamp >= ? AND timestamp <= ? AND ${logActionFilter} AND domain IS NOT NULL AND domain != '' AND domain != '[Encrypted]'`;
        const params: (string | number)[] = [profileId, fromTs, toTs];
        if (accessPointId) {
          where += " AND access_point_id = ?";
          params.push(accessPointId);
        }
        return {
          sql: `SELECT domain, COUNT(*) as count FROM logs WHERE ${where} GROUP BY domain`,
          params
        };
      },
      { skipTailLogs: isE2eeActive }
    );

    const { results } = await this.db
      .prepare(`SELECT domain, SUM(count) as count FROM (${union.sql}) GROUP BY domain ORDER BY count DESC LIMIT 10`)
      .bind(...union.params)
      .all<DomainCountResult>();

    return results;
  }
}

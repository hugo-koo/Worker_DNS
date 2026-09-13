import { D1Database } from "@cloudflare/workers-types";
import { LogAggregationModel } from "../aggregation";
import { DomainCountResult } from "./types";

/**
 * Handles top allowed and top blocked domain analytics.
 * Combines `domain_hourly_rollups` with recent raw `logs` to eliminate
 * multi-million row table scans while ensuring up-to-the-minute accuracy.
 */
export class LogDomainAnalytics {
  constructor(
    private readonly db: D1Database,
    private readonly aggregation: LogAggregationModel
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
    if (accessPointId) {
      const queryStr =
        "SELECT domain, COUNT(*) as count FROM logs WHERE profile_id = ? AND timestamp >= ? AND timestamp <= ? AND action = 'PASS' AND access_point_id = ? GROUP BY domain ORDER BY count DESC LIMIT 10";
      const { results } = await this.db
        .prepare(queryStr)
        .bind(profileId, since, until, accessPointId)
        .all<DomainCountResult>();
      return results;
    }

    const latestRollupHour = await this.aggregation.getLatestRollupHour(profileId);
    const cutoff = latestRollupHour !== null ? latestRollupHour + 3600 : since;

    // Case 1: No rollups available or entire range is after cutoff -> query raw logs only
    if (cutoff <= since) {
      const queryStr =
        "SELECT domain, COUNT(*) as count FROM logs WHERE profile_id = ? AND timestamp >= ? AND timestamp <= ? AND action = 'PASS' GROUP BY domain ORDER BY count DESC LIMIT 10";
      const { results } = await this.db
        .prepare(queryStr)
        .bind(profileId, since, until)
        .all<DomainCountResult>();
      return results;
    }

    // Case 2: Entire range is within completed rollups
    if (cutoff > until) {
      const sinceHour = Math.floor(since / 3600) * 3600;
      const queryStr = `
        SELECT domain, SUM(count) as count
        FROM domain_hourly_rollups
        WHERE profile_id = ? AND action = 'PASS' AND hour_timestamp >= ? AND hour_timestamp <= ?
        GROUP BY domain
        ORDER BY count DESC
        LIMIT 10
      `;
      const { results } = await this.db
        .prepare(queryStr)
        .bind(profileId, sinceHour, until)
        .all<DomainCountResult>();
      return results;
    }

    // Case 3: Spans historical rollups and unaggregated logs -> Hybrid UNION ALL query
    const sinceHour = Math.floor(since / 3600) * 3600;
    const queryStr = `
      SELECT domain, SUM(count) as count FROM (
        SELECT domain, count
        FROM domain_hourly_rollups
        WHERE profile_id = ? AND action = 'PASS' AND hour_timestamp >= ? AND hour_timestamp < ?
        UNION ALL
        SELECT domain, COUNT(*) as count
        FROM logs
        WHERE profile_id = ? AND timestamp >= ? AND timestamp <= ? AND action = 'PASS'
        GROUP BY domain
      ) GROUP BY domain ORDER BY count DESC LIMIT 10
    `;
    const { results } = await this.db
      .prepare(queryStr)
      .bind(profileId, sinceHour, cutoff, profileId, cutoff, until)
      .all<DomainCountResult>();
    return results;
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
    if (accessPointId) {
      const queryStr =
        "SELECT domain, COUNT(*) as count FROM logs WHERE profile_id = ? AND timestamp >= ? AND timestamp <= ? AND action IN ('BLOCK', 'REDIRECT') AND access_point_id = ? GROUP BY domain ORDER BY count DESC LIMIT 10";
      const { results } = await this.db
        .prepare(queryStr)
        .bind(profileId, since, until, accessPointId)
        .all<DomainCountResult>();
      return results;
    }

    const latestRollupHour = await this.aggregation.getLatestRollupHour(profileId);
    const cutoff = latestRollupHour !== null ? latestRollupHour + 3600 : since;

    // Case 1: No rollups available or entire range is after cutoff -> query raw logs only
    if (cutoff <= since) {
      const queryStr =
        "SELECT domain, COUNT(*) as count FROM logs WHERE profile_id = ? AND timestamp >= ? AND timestamp <= ? AND action IN ('BLOCK', 'REDIRECT') GROUP BY domain ORDER BY count DESC LIMIT 10";
      const { results } = await this.db
        .prepare(queryStr)
        .bind(profileId, since, until)
        .all<DomainCountResult>();
      return results;
    }

    // Case 2: Entire range is within completed rollups
    if (cutoff > until) {
      const sinceHour = Math.floor(since / 3600) * 3600;
      const queryStr = `
        SELECT domain, SUM(count) as count
        FROM domain_hourly_rollups
        WHERE profile_id = ? AND action IN ('BLOCK', 'REDIRECT') AND hour_timestamp >= ? AND hour_timestamp <= ?
        GROUP BY domain
        ORDER BY count DESC
        LIMIT 10
      `;
      const { results } = await this.db
        .prepare(queryStr)
        .bind(profileId, sinceHour, until)
        .all<DomainCountResult>();
      return results;
    }

    // Case 3: Spans historical rollups and unaggregated logs -> Hybrid UNION ALL query
    const sinceHour = Math.floor(since / 3600) * 3600;
    const queryStr = `
      SELECT domain, SUM(count) as count FROM (
        SELECT domain, count
        FROM domain_hourly_rollups
        WHERE profile_id = ? AND action IN ('BLOCK', 'REDIRECT') AND hour_timestamp >= ? AND hour_timestamp < ?
        UNION ALL
        SELECT domain, COUNT(*) as count
        FROM logs
        WHERE profile_id = ? AND timestamp >= ? AND timestamp <= ? AND action IN ('BLOCK', 'REDIRECT')
        GROUP BY domain
      ) GROUP BY domain ORDER BY count DESC LIMIT 10
    `;
    const { results } = await this.db
      .prepare(queryStr)
      .bind(profileId, sinceHour, cutoff, profileId, cutoff, until)
      .all<DomainCountResult>();
    return results;
  }
}

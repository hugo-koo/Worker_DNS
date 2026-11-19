import { D1Database } from "@cloudflare/workers-types";
import { LogAggregationModel } from "../aggregation";
import { ActionCountResult, TimeSeriesTrendPoint } from "./types";
import { computeRollupWindow, buildRollupUnionParts } from "./rollupWindow";

/**
 * Handles action volume summaries and time-series trend analytics.
 * Leverages `log_hourly_rollups` and hybrid UNION ALL queries to provide
 * sub-millisecond, full-dataset analytics over large log volumes.
 */
export class LogTrafficAnalytics {
  constructor(
    private readonly db: D1Database,
    private readonly aggregation?: LogAggregationModel
  ) {}

  /**
   * Retrieves action counts (PASS, BLOCK, REDIRECT, FAIL) for a given time range.
   *
   * @param profileId - Profile identifier.
   * @param since - Start timestamp in seconds.
   * @param until - End timestamp in seconds.
   * @param search - Optional domain search substring.
   * @param accessPointId - Optional device/access point ID.
   * @param destCountry - Optional destination country code.
   * @param isp - Optional ISP name filter.
   * @param status - Optional action status filter (e.g. PASS, BLOCK).
   * @param exact - Optional boolean flag to force exact count query against raw logs table directly.
   * @returns Array of action counts.
   */
  async getSummary(
    profileId: string,
    since: number,
    until: number,
    search?: string,
    accessPointId?: string,
    destCountry?: string,
    isp?: string,
    status?: string,
    exact?: boolean
  ): Promise<ActionCountResult[]> {
    // Only fall back to raw logs when filters cannot be served by hourly_rollups (`action`, `access_point_id`).
    if (exact || search || destCountry || isp || !this.aggregation) {
      let queryStr =
        "SELECT action, COUNT(*) as count FROM logs WHERE profile_id = ? AND timestamp >= ? AND timestamp <= ?";
      const params: (string | number)[] = [profileId, since, until];
      if (search) {
        queryStr += " AND domain LIKE ?";
        params.push(`%${search}%`);
      }
      if (accessPointId) {
        queryStr += " AND access_point_id = ?";
        params.push(accessPointId);
      }
      if (status) {
        queryStr += " AND action = ?";
        params.push(status);
      }
      if (destCountry) {
        queryStr += ` AND UPPER(CASE 
          WHEN dest_country_code IS NOT NULL AND dest_country_code != '' THEN dest_country_code
          WHEN dest_geoip IS NOT NULL AND dest_geoip != '' AND dest_geoip LIKE '{%' THEN json_extract(dest_geoip, '$.country_code')
          ELSE ''
        END) = ?`;
        params.push(destCountry.toUpperCase());
      }
      if (isp) {
        queryStr += ` AND (CASE 
          WHEN dest_isp IS NOT NULL AND dest_isp != '' THEN dest_isp
          WHEN dest_geoip IS NOT NULL AND dest_geoip != '' AND dest_geoip LIKE '{%' THEN COALESCE(NULLIF(json_extract(dest_geoip, '$.isp'), ''), json_extract(dest_geoip, '$.org'))
          ELSE ''
        END) = ?`;
        params.push(isp);
      }
      queryStr += " GROUP BY action";
      const { results } = await this.db
        .prepare(queryStr)
        .bind(...params)
        .all<ActionCountResult>();
      return results;
    }

    const latestRollupHour = await this.aggregation.getLatestRollupHour(profileId);
    const window = computeRollupWindow(since, until, latestRollupHour);

    if (!window.useRollups) {
      let queryStr =
        "SELECT action, COUNT(*) as count FROM logs WHERE profile_id = ? AND timestamp >= ? AND timestamp <= ?";
      const params: (string | number)[] = [profileId, since, until];
      if (accessPointId) {
        queryStr += " AND access_point_id = ?";
        params.push(accessPointId);
      }
      if (status) {
        queryStr += " AND action = ?";
        params.push(status);
      }
      queryStr += " GROUP BY action";
      const { results } = await this.db
        .prepare(queryStr)
        .bind(...params)
        .all<ActionCountResult>();
      return results;
    }

    const union = buildRollupUnionParts(
      since,
      until,
      window,
      (startHour, endHour) => {
        let where = "profile_id = ? AND metric_type = 'action' AND hour_timestamp >= ? AND hour_timestamp < ?";
        const params: (string | number)[] = [profileId, startHour, endHour];
        if (accessPointId) {
          where += " AND access_point_id = ?";
          params.push(accessPointId);
        }
        if (status) {
          where += " AND key = ?";
          params.push(status);
        }
        return {
          sql: `SELECT key as action, count FROM hourly_rollups WHERE ${where}`,
          params
        };
      },
      (fromTs, toTs) => {
        let where = "profile_id = ? AND timestamp >= ? AND timestamp <= ?";
        const params: (string | number)[] = [profileId, fromTs, toTs];
        if (accessPointId) {
          where += " AND access_point_id = ?";
          params.push(accessPointId);
        }
        if (status) {
          where += " AND action = ?";
          params.push(status);
        }
        return {
          sql: `SELECT action, COUNT(*) as count FROM logs WHERE ${where} GROUP BY action`,
          params
        };
      }
    );

    const { results } = await this.db
      .prepare(`SELECT action, SUM(count) as count FROM (${union.sql}) GROUP BY action`)
      .bind(...union.params)
      .all<ActionCountResult>();

    return results;
  }

  /**
   * Retrieves timeseries trend data aggregated by interval.
   *
   * @param profileId - Profile identifier.
   * @param since - Start timestamp in seconds.
   * @param until - End timestamp in seconds.
   * @param interval - SQL group by expression (e.g. `(timestamp/3600)*3600` or `(timestamp/86400)*86400`).
   * @param accessPointId - Optional device filter.
   * @returns Array of timeseries points ordered by timestamp ascending.
   */
  async getTrend(
    profileId: string,
    since: number,
    until: number,
    interval: string,
    accessPointId?: string
  ): Promise<TimeSeriesTrendPoint[]> {
    const isHourly = interval.includes("3600");
    const isDaily = interval.includes("86400");

    // If sub-hour interval or rollups disabled, query raw logs directly;
    // hourly/daily intervals with accessPointId are supported directly by hourly_rollups.
    if ((!isHourly && !isDaily) || !this.aggregation) {
      const SAFE_INTERVALS = new Set([
        "(timestamp/60)*60",
        "(timestamp/300)*300",
        "(timestamp/900)*900",
        "(timestamp/3600)*3600",
        "(timestamp/86400)*86400"
      ]);
      const safeInterval = SAFE_INTERVALS.has(interval.trim()) ? interval.trim() : "(timestamp/3600)*3600";

      let queryStr = `SELECT ${safeInterval} as timestamp, action, COUNT(*) as count FROM logs WHERE profile_id = ? AND timestamp >= ? AND timestamp <= ?`;
      const params: (string | number)[] = [profileId, since, until];
      if (accessPointId) {
        queryStr += " AND access_point_id = ?";
        params.push(accessPointId);
      }
      queryStr += ` GROUP BY ${safeInterval}, action ORDER BY timestamp ASC`;
      const { results } = await this.db
        .prepare(queryStr)
        .bind(...params)
        .all<TimeSeriesTrendPoint>();
      return results;
    }

    const latestRollupHour = await this.aggregation.getLatestRollupHour(profileId);
    const window = computeRollupWindow(since, until, latestRollupHour);
    const rollupInterval = isDaily ? "(hour_timestamp / 86400) * 86400" : "hour_timestamp";
    const logsInterval = isDaily ? "(timestamp / 86400) * 86400" : "(timestamp / 3600) * 3600";

    if (!window.useRollups) {
      let queryStr = `SELECT ${logsInterval} as timestamp, action, COUNT(*) as count FROM logs WHERE profile_id = ? AND timestamp >= ? AND timestamp <= ?`;
      const params: (string | number)[] = [profileId, since, until];
      if (accessPointId) {
        queryStr += " AND access_point_id = ?";
        params.push(accessPointId);
      }
      queryStr += ` GROUP BY ${logsInterval}, action ORDER BY timestamp ASC`;
      const { results } = await this.db
        .prepare(queryStr)
        .bind(...params)
        .all<TimeSeriesTrendPoint>();
      return results;
    }

    const union = buildRollupUnionParts(
      since,
      until,
      window,
      (startHour, endHour) => {
        let where = "profile_id = ? AND metric_type = 'action' AND hour_timestamp >= ? AND hour_timestamp < ?";
        const params: (string | number)[] = [profileId, startHour, endHour];
        if (accessPointId) {
          where += " AND access_point_id = ?";
          params.push(accessPointId);
        }
        return {
          sql: `SELECT ${rollupInterval} as timestamp, key as action, count FROM hourly_rollups WHERE ${where}`,
          params
        };
      },
      (fromTs, toTs) => {
        let where = "profile_id = ? AND timestamp >= ? AND timestamp <= ?";
        const params: (string | number)[] = [profileId, fromTs, toTs];
        if (accessPointId) {
          where += " AND access_point_id = ?";
          params.push(accessPointId);
        }
        return {
          sql: `SELECT ${logsInterval} as timestamp, action, COUNT(*) as count FROM logs WHERE ${where} GROUP BY ${logsInterval}, action`,
          params
        };
      }
    );

    const { results } = await this.db
      .prepare(`SELECT timestamp, action, SUM(count) as count FROM (${union.sql}) GROUP BY timestamp, action ORDER BY timestamp ASC`)
      .bind(...union.params)
      .all<TimeSeriesTrendPoint>();

    return results;
  }
}

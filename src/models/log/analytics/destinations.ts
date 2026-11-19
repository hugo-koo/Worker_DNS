import { D1Database } from "@cloudflare/workers-types";
import { LogAggregationModel } from "../aggregation";
import { DestinationCountResult, ISPCountResult } from "./types";
import { computeRollupWindow, buildRollupUnionParts, hasActiveE2eeKey } from "./rollupWindow";

/**
 * Handles geographic destination country and ISP distribution analytics.
 * Leverages `destination_hourly_rollups` to reduce D1 row reads by >99%
 * and eliminates expensive runtime JSON parsing across historical rows.
 */
export class LogDestinationAnalytics {
  constructor(
    private readonly db: D1Database,
    private readonly aggregation?: LogAggregationModel
  ) {}

  /**
   * Retrieves top destination countries for a given time range.
   *
   * @param profileId - Profile identifier.
   * @param since - Start timestamp in seconds.
   * @param until - End timestamp in seconds.
   * @param accessPointId - Optional device/access point ID.
   * @param limit - Maximum number of destinations to return (default 250).
   * @returns Array of destination country records ordered by query count descending.
   */
  async getDestinations(
    profileId: string,
    since: number,
    until: number,
    accessPointId?: string,
    limit = 250
  ): Promise<DestinationCountResult[]> {
    const queryRawDestinations = async (fromTs: number, toTs: number): Promise<DestinationCountResult[]> => {
      let queryStr = `
        SELECT 
          UPPER(CASE 
            WHEN dest_country_code IS NOT NULL AND dest_country_code != '' THEN dest_country_code
            WHEN dest_geoip IS NOT NULL AND dest_geoip != '' AND dest_geoip LIKE '{%' THEN json_extract(dest_geoip, '$.country_code')
            ELSE NULL 
          END) as country_code,
          MAX(CASE 
            WHEN dest_country IS NOT NULL AND dest_country != '' THEN dest_country
            WHEN dest_geoip IS NOT NULL AND dest_geoip != '' AND dest_geoip LIKE '{%' THEN json_extract(dest_geoip, '$.country')
            ELSE 'Unknown'
          END) as country,
          COUNT(*) as count
        FROM logs 
        WHERE profile_id = ? AND timestamp >= ? AND timestamp <= ? 
          AND (
            (dest_country_code IS NOT NULL AND dest_country_code != '')
            OR
            (dest_geoip IS NOT NULL AND dest_geoip != '' AND dest_geoip LIKE '{%' AND json_extract(dest_geoip, '$.country_code') IS NOT NULL AND json_extract(dest_geoip, '$.country_code') != '')
          )
      `;
      const params: (string | number)[] = [profileId, fromTs, toTs];
      if (accessPointId) {
        queryStr += " AND access_point_id = ?";
        params.push(accessPointId);
      }
      queryStr += ` GROUP BY country_code ORDER BY count DESC LIMIT ${limit}`;
      const { results } = await this.db
        .prepare(queryStr)
        .bind(...params)
        .all<DestinationCountResult>();
      return results;
    };

    if (!this.aggregation) {
      if (await hasActiveE2eeKey(this.db, profileId)) return [];
      return queryRawDestinations(since, until);
    }

    const [latestRollupHour, isE2eeActive] = await Promise.all([
      this.aggregation.getLatestDestinationRollupHour(profileId),
      hasActiveE2eeKey(this.db, profileId)
    ]);
    const window = computeRollupWindow(since, until, latestRollupHour);

    if (!window.useRollups) {
      if (isE2eeActive) return [];
      return queryRawDestinations(since, until);
    }

    const union = buildRollupUnionParts(
      since,
      until,
      window,
      (startHour, endHour) => {
        let where = "profile_id = ? AND metric_type = 'dest' AND key NOT LIKE 'enc:%' AND hour_timestamp >= ? AND hour_timestamp < ?";
        const params: (string | number)[] = [profileId, startHour, endHour];
        if (accessPointId) {
          where += " AND access_point_id = ?";
          params.push(accessPointId);
        }
        return {
          sql: `SELECT key as country_code, sub_key as country, count FROM hourly_rollups WHERE ${where}`,
          params
        };
      },
      (fromTs, toTs) => {
        let logWhere = `
          profile_id = ? AND timestamp >= ? AND timestamp <= ?
          AND (
            (dest_country_code IS NOT NULL AND dest_country_code != '')
            OR
            (dest_geoip IS NOT NULL AND dest_geoip != '' AND dest_geoip LIKE '{%' AND json_extract(dest_geoip, '$.country_code') IS NOT NULL AND json_extract(dest_geoip, '$.country_code') != '')
          )
        `;
        const params: (string | number)[] = [profileId, fromTs, toTs];
        if (accessPointId) {
          logWhere += " AND access_point_id = ?";
          params.push(accessPointId);
        }
        return {
          sql: `
            SELECT 
              UPPER(CASE 
                WHEN dest_country_code IS NOT NULL AND dest_country_code != '' THEN dest_country_code
                WHEN dest_geoip IS NOT NULL AND dest_geoip != '' AND dest_geoip LIKE '{%' THEN json_extract(dest_geoip, '$.country_code')
                ELSE ''
              END) as country_code,
              MAX(CASE 
                WHEN dest_country IS NOT NULL AND dest_country != '' THEN dest_country
                WHEN dest_geoip IS NOT NULL AND dest_geoip != '' AND dest_geoip LIKE '{%' THEN json_extract(dest_geoip, '$.country')
                ELSE 'Unknown'
              END) as country,
              COUNT(*) as count
            FROM logs
            WHERE ${logWhere}
            GROUP BY country_code
          `,
          params
        };
      },
      { skipTailLogs: isE2eeActive }
    );

    const { results } = await this.db
      .prepare(`SELECT country_code, MAX(country) as country, SUM(count) as count FROM (${union.sql}) WHERE country_code != '' GROUP BY country_code ORDER BY count DESC LIMIT ${limit}`)
      .bind(...union.params)
      .all<DestinationCountResult>();

    return results;
  }

  /**
   * Retrieves ISP distribution for queries matching an optional country code.
   * Leverages `hourly_rollups` with metric_type='isp' to achieve instant responses
   * and consistent historical totals across all retention policies.
   *
   * @param profileId - Profile identifier.
   * @param countryCode - Optional ISO 2-letter country code.
   * @param since - Start timestamp in seconds.
   * @param until - End timestamp in seconds.
   * @param accessPointId - Optional device filter.
   * @param limit - Maximum number of ISPs to return (default 250).
   * @returns Array of ISP count records.
   */
  async getISPByCountry(
    profileId: string,
    countryCode: string | undefined,
    since: number,
    until: number,
    accessPointId?: string,
    limit = 250
  ): Promise<ISPCountResult[]> {
    const rawLogsQuery = async (fromTs: number, toTs: number): Promise<ISPCountResult[]> => {
      let queryStr = `
        SELECT 
          CASE 
            WHEN dest_isp IS NOT NULL AND dest_isp != '' THEN dest_isp
            WHEN dest_geoip IS NOT NULL AND dest_geoip != '' AND dest_geoip LIKE '{%' THEN COALESCE(NULLIF(json_extract(dest_geoip, '$.isp'), ''), json_extract(dest_geoip, '$.org'))
            ELSE NULL 
          END as name, 
          COUNT(*) as count 
        FROM logs 
        WHERE profile_id = ? 
          AND timestamp >= ? 
          AND timestamp <= ? 
          AND (
            (dest_isp IS NOT NULL AND dest_isp != '')
            OR
            (dest_geoip IS NOT NULL AND dest_geoip != '' AND dest_geoip LIKE '{%' AND (
              (json_extract(dest_geoip, '$.isp') IS NOT NULL AND json_extract(dest_geoip, '$.isp') != '')
              OR
              (json_extract(dest_geoip, '$.org') IS NOT NULL AND json_extract(dest_geoip, '$.org') != '')
            ))
          )
      `;
      const params: (string | number)[] = [profileId, fromTs, toTs];
      if (countryCode) {
        queryStr += ` AND UPPER(CASE 
          WHEN dest_country_code IS NOT NULL AND dest_country_code != '' THEN dest_country_code
          WHEN dest_geoip IS NOT NULL AND dest_geoip != '' AND dest_geoip LIKE '{%' THEN json_extract(dest_geoip, '$.country_code')
          ELSE ''
        END) = ?`;
        params.push(countryCode.toUpperCase());
      }
      if (accessPointId) {
        queryStr += " AND access_point_id = ?";
        params.push(accessPointId);
      }
      queryStr += ` GROUP BY name ORDER BY count DESC LIMIT ${limit}`;
      const { results } = await this.db
        .prepare(queryStr)
        .bind(...params)
        .all<{ name: string | null; count: number }>();

      return results.map((r) => ({
        name: r.name || "Unknown",
        count: r.count
      }));
    };

    if (!this.aggregation) {
      if (await hasActiveE2eeKey(this.db, profileId)) return [];
      return rawLogsQuery(since, until);
    }

    const [latestRollupHour, isE2eeActive] = await Promise.all([
      this.aggregation.getLatestISPRollupHour(profileId),
      hasActiveE2eeKey(this.db, profileId)
    ]);
    const window = computeRollupWindow(since, until, latestRollupHour);

    if (!window.useRollups) {
      if (isE2eeActive) return [];
      return rawLogsQuery(since, until);
    }

    const union = buildRollupUnionParts(
      since,
      until,
      window,
      (startHour, endHour) => {
        let where = "profile_id = ? AND metric_type = 'isp' AND key NOT LIKE 'enc:%' AND hour_timestamp >= ? AND hour_timestamp < ?";
        const params: (string | number)[] = [profileId, startHour, endHour];
        if (countryCode) {
          where += " AND key = ?";
          params.push(countryCode.toUpperCase());
        }
        if (accessPointId) {
          where += " AND access_point_id = ?";
          params.push(accessPointId);
        }
        return {
          sql: `SELECT sub_key as name, count FROM hourly_rollups WHERE ${where}`,
          params
        };
      },
      (fromTs, toTs) => {
        let logWhere = `
          profile_id = ? AND timestamp >= ? AND timestamp <= ?
          AND (
            (dest_isp IS NOT NULL AND dest_isp != '')
            OR
            (dest_geoip IS NOT NULL AND dest_geoip != '' AND dest_geoip LIKE '{%' AND (
              (json_extract(dest_geoip, '$.isp') IS NOT NULL AND json_extract(dest_geoip, '$.isp') != '')
              OR
              (json_extract(dest_geoip, '$.org') IS NOT NULL AND json_extract(dest_geoip, '$.org') != '')
            ))
          )
        `;
        const params: (string | number)[] = [profileId, fromTs, toTs];
        if (countryCode) {
          logWhere += ` AND UPPER(CASE 
            WHEN dest_country_code IS NOT NULL AND dest_country_code != '' THEN dest_country_code
            WHEN dest_geoip IS NOT NULL AND dest_geoip != '' AND dest_geoip LIKE '{%' THEN json_extract(dest_geoip, '$.country_code')
            ELSE ''
          END) = ?`;
          params.push(countryCode.toUpperCase());
        }
        if (accessPointId) {
          logWhere += " AND access_point_id = ?";
          params.push(accessPointId);
        }
        return {
          sql: `
            SELECT 
              CASE 
                WHEN dest_isp IS NOT NULL AND dest_isp != '' THEN dest_isp
                WHEN dest_geoip IS NOT NULL AND dest_geoip != '' AND dest_geoip LIKE '{%' THEN COALESCE(NULLIF(json_extract(dest_geoip, '$.isp'), ''), json_extract(dest_geoip, '$.org'))
                ELSE 'Unknown'
              END as name, 
              COUNT(*) as count 
            FROM logs 
            WHERE ${logWhere}
            GROUP BY name
          `,
          params
        };
      },
      { skipTailLogs: isE2eeActive }
    );

    const { results } = await this.db
      .prepare(`SELECT name, SUM(count) as count FROM (${union.sql}) WHERE name IS NOT NULL AND name != '' GROUP BY name ORDER BY count DESC LIMIT ${limit}`)
      .bind(...union.params)
      .all<{ name: string | null; count: number }>();

    return results.map((r) => ({
      name: r.name || "Unknown",
      count: r.count
    }));
  }
}

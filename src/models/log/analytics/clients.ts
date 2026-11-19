import { D1Database } from "@cloudflare/workers-types";
import { LogAggregationModel } from "../aggregation";
import { ClientCountResult } from "./types";
import { computeRollupWindow, buildRollupUnionParts, hasActiveE2eeKey } from "./rollupWindow";

/**
 * Handles client device and IP-level analytics.
 * Leverages `client_hourly_rollups` to reduce D1 row reads by >98%
 * while capturing live active devices for the current hour.
 */
export class LogClientAnalytics {
  constructor(
    private readonly db: D1Database,
    private readonly aggregation?: LogAggregationModel
  ) {}

  /**
   * Retrieves top client IPs and locations for a given time range.
   *
   * @param profileId - Profile identifier.
   * @param since - Start timestamp in seconds.
   * @param until - End timestamp in seconds.
   * @param accessPointId - Optional device/access point ID.
   * @returns Array of top client records ordered by query count descending.
   */
  async getClients(
    profileId: string,
    since: number,
    until: number,
    accessPointId?: string
  ): Promise<ClientCountResult[]> {
    const queryRawClients = async (fromTs: number, toTs: number): Promise<ClientCountResult[]> => {
      let queryStr =
        "SELECT client_ip, geo_country, COUNT(*) as count FROM logs WHERE profile_id = ? AND timestamp >= ? AND timestamp <= ? AND client_ip IS NOT NULL AND client_ip != '' AND client_ip != '[Encrypted]'";
      const params: (string | number)[] = [profileId, fromTs, toTs];
      if (accessPointId) {
        queryStr += " AND access_point_id = ?";
        params.push(accessPointId);
      }
      queryStr += " GROUP BY client_ip, geo_country ORDER BY count DESC LIMIT 20";
      const { results } = await this.db
        .prepare(queryStr)
        .bind(...params)
        .all<ClientCountResult>();
      return results;
    };

    if (!this.aggregation) {
      if (await hasActiveE2eeKey(this.db, profileId)) return [];
      return queryRawClients(since, until);
    }

    const [latestRollupHour, isE2eeActive] = await Promise.all([
      this.aggregation.getLatestClientRollupHour(profileId),
      hasActiveE2eeKey(this.db, profileId)
    ]);
    const window = computeRollupWindow(since, until, latestRollupHour);

    if (!window.useRollups) {
      if (isE2eeActive) return [];
      return queryRawClients(since, until);
    }

    const union = buildRollupUnionParts(
      since,
      until,
      window,
      (startHour, endHour) => {
        let where = "profile_id = ? AND metric_type = 'client' AND key NOT LIKE 'enc:%' AND hour_timestamp >= ? AND hour_timestamp < ?";
        const params: (string | number)[] = [profileId, startHour, endHour];
        if (accessPointId) {
          where += " AND access_point_id = ?";
          params.push(accessPointId);
        }
        return {
          sql: `SELECT key as client_ip, sub_key as geo_country, count FROM hourly_rollups WHERE ${where}`,
          params
        };
      },
      (fromTs, toTs) => {
        let where = "profile_id = ? AND timestamp >= ? AND timestamp <= ? AND client_ip IS NOT NULL AND client_ip != '' AND client_ip != '[Encrypted]'";
        const params: (string | number)[] = [profileId, fromTs, toTs];
        if (accessPointId) {
          where += " AND access_point_id = ?";
          params.push(accessPointId);
        }
        return {
          sql: `SELECT client_ip, COALESCE(geo_country, '') as geo_country, COUNT(*) as count FROM logs WHERE ${where} GROUP BY client_ip, COALESCE(geo_country, '')`,
          params
        };
      },
      { skipTailLogs: isE2eeActive }
    );

    const { results } = await this.db
      .prepare(`SELECT client_ip, NULLIF(geo_country, '') as geo_country, SUM(count) as count FROM (${union.sql}) GROUP BY client_ip, geo_country ORDER BY count DESC LIMIT 20`)
      .bind(...union.params)
      .all<ClientCountResult>();

    return results;
  }
}

/**
 * @file queryService.ts
 * @description Local SQLite query service for logs, analytical aggregations, and ISP distributions.
 */

import type { AnalyticsData } from '../../views/AnalyticsView/types';
import type {
  LocalQueryLogsParams,
  LocalQueryResult,
  LocalAnalyticsParams,
  LocalQueryISPsParams
} from './types';
import type { LocalDbWorkerBridge } from './workerBridge';
import { e2ee } from '../e2ee';
import { decryptRowsOnRead } from './logDecryption';

/**
 * Service executing typed queries against the local SQLite database.
 */
export class LocalDbQueryService {
  private readonly bridge: LocalDbWorkerBridge;

  constructor(bridge: LocalDbWorkerBridge) {
    this.bridge = bridge;
  }

  /**
   * Queries local logs from SQLite with pagination, search, and action filters.
   * Performs opportunistic on-read decryption when E2EE is unlocked so scrolling into
   * older locally-cached encrypted entries never exposes stale [Encrypted] placeholders.
   *
   * @param params - Filter and pagination criteria.
   * @returns Paginated query result with rows and summary stats.
   */
  async queryLogs(params: LocalQueryLogsParams): Promise<LocalQueryResult> {
    await this.bridge.init();
    const res = await this.bridge.sendRequest<LocalQueryResult>('QUERY_LOGS', params);
    const decryptedRows = await decryptRowsOnRead(this.bridge, e2ee, params.profileId, res.rows);
    return decryptedRows === res.rows ? res : { ...res, rows: decryptedRows };
  }

  /**
   * Queries local analytics aggregations directly using SQLite GROUP BY queries.
   *
   * @param params - Time boundary and grouping parameters.
   * @returns Aggregated analytics data matching the AnalyticsData schema.
   */
  async queryAnalytics(params: LocalAnalyticsParams): Promise<AnalyticsData> {
    await this.bridge.init();
    return this.bridge.sendRequest<AnalyticsData>('QUERY_ANALYTICS', params);
  }

  /**
   * Queries local ISP aggregations optionally filtered by country code from SQLite.
   *
   * @param params - ISP filtering criteria.
   * @returns Array of ISP items with name and query count.
   */
  async queryISPs(params: LocalQueryISPsParams): Promise<{ name: string; count: number }[]> {
    await this.bridge.init();
    return this.bridge.sendRequest<{ name: string; count: number }[]>('QUERY_ISPS', params);
  }
}

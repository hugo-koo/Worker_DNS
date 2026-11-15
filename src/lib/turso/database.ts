/**
 * @file database.ts
 * @description Cloudflare Workers D1Database compatible client for Turso / libSQL over HTTP (Hrana v2).
 */

import {
  D1Database,
  D1PreparedStatement,
  D1Result,
  D1ExecResult,
  D1DatabaseSession
} from '@cloudflare/workers-types';
import {
  HranaRequest,
  HranaStepResult,
  HranaExecuteResult,
  HranaPipelineResponse,
  toHranaValue,
  fromHranaValue
} from './protocol';
import { normalizeTursoUrl } from './config';
import { splitSqlStatements } from './sql';
import { TursoD1PreparedStatement } from './statement';

/**
 * Turso Database implementation adhering to Cloudflare Workers D1Database interface.
 */
export class TursoD1Database implements D1Database {
  public readonly url: string;
  public readonly authToken: string;
  public readonly endpoint: string;
  private selectCache = new Map<string, { result: HranaExecuteResult; expiresAt: number }>();
  private readonly maxSelectCacheEntries = 300;

  constructor(url: string, authToken: string) {
    this.url = url;
    this.authToken = authToken;
    this.endpoint = `${normalizeTursoUrl(url)}/v2/pipeline`;
  }

  private isReadOnlyQuery(sql: string): boolean {
    const trimmed = sql.trim().toUpperCase();
    return trimmed.startsWith('SELECT') || trimmed.startsWith('PRAGMA');
  }

  /**
   * Clears in-memory SELECT cache when mutating queries execute.
   */
  clearSelectCache(): void {
    this.selectCache.clear();
  }

  prepare(query: string): D1PreparedStatement {
    return new TursoD1PreparedStatement(this, query) as unknown as D1PreparedStatement;
  }

  private isTransientHttpStatus(status: number): boolean {
    return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
  }

  private isTransientSqliteBusy(code?: string, message?: string): boolean {
    const combined = `${code || ''} ${message || ''}`.toLowerCase();
    return combined.includes('sqlite_busy') || combined.includes('database is locked');
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Executes a pipeline request against Turso HTTP API.
   * Retries transient network/edge errors (408/429/5xx) with short backoff.
   *
   * @param requests - Array of Hrana operations to evaluate.
   * @param timeoutMs - Optional execution timeout in milliseconds (default 20,000ms).
   * @returns Array of step results.
   */
  async executePipeline(requests: HranaRequest[], timeoutMs = 20000): Promise<HranaStepResult[]> {
    const maxRetries = 2;
    const retryDelaysMs = [150, 350];

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort(new Error(`[Turso D1] Pipeline request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      try {
        const res = await fetch(this.endpoint, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.authToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ requests }),
          signal: controller.signal
        });

        if (!res.ok) {
          const errorBody = await res.text().catch(() => '');
          const err = new Error(`[Turso D1] HTTP ${res.status} ${res.statusText}: ${errorBody}`);
          if (attempt < maxRetries && this.isTransientHttpStatus(res.status)) {
            await this.sleep(retryDelaysMs[attempt]);
            continue;
          }
          throw err;
        }

        const json = (await res.json()) as HranaPipelineResponse;
        return json.results || [];
      } catch (err: unknown) {
        if (attempt < maxRetries && !controller.signal.aborted) {
          const msg = err instanceof Error ? err.message : String(err);
          // Do not retry non-transient HTTP 4xx errors already formatted above
          if (!msg.startsWith('[Turso D1] HTTP ')) {
            await this.sleep(retryDelaysMs[attempt]);
            continue;
          }
        }
        throw err;
      } finally {
        clearTimeout(timeoutId);
      }
    }

    throw new Error('[Turso D1] Pipeline execution failed after retries');
  }

  /**
   * Executes a single parameterized statement and returns the raw execute result.
   * Caches read-only SELECT queries in-memory for 30 seconds to protect against subrequest exhaustion.
   *
   * @param sql - SQL query text.
   * @param params - Query parameters.
   * @returns HranaExecuteResult object.
   */
  async executeStatement(sql: string, params: any[]): Promise<HranaExecuteResult> {
    const isReadOnly = this.isReadOnlyQuery(sql);
    const cacheKey = isReadOnly ? `${sql}::${JSON.stringify(params)}` : '';

    if (isReadOnly) {
      const cached = this.selectCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.result;
      }
    } else {
      this.clearSelectCache();
    }

    const hranaArgs = params.map(toHranaValue);
    const needsFkOn = !isReadOnly && !/^\s*PRAGMA\s+foreign_keys/i.test(sql);
    const pipelineReqs: HranaRequest[] = [];
    if (needsFkOn) {
      pipelineReqs.push({ type: 'execute', stmt: { sql: 'PRAGMA foreign_keys = ON' } });
    }
    pipelineReqs.push(
      {
        type: 'execute',
        stmt: {
          sql,
          args: hranaArgs
        }
      },
      { type: 'close' }
    );
    const maxBusyRetries = 2;
    const busyDelaysMs = [150, 350];
    let first: HranaStepResult | undefined;

    for (let attempt = 0; attempt <= maxBusyRetries; attempt++) {
      const results = await this.executePipeline(pipelineReqs);
      first = results[needsFkOn ? 1 : 0];
      if (!first) {
        throw new Error(`[Turso D1] Empty response from pipeline for SQL: ${sql}`);
      }
      if (first.type === 'error' || first.error) {
        if (
          attempt < maxBusyRetries &&
          this.isTransientSqliteBusy(first.error?.code, first.error?.message)
        ) {
          await this.sleep(busyDelaysMs[attempt]);
          continue;
        }
        const msg = first.error?.message || 'Unknown database error';
        throw new Error(`[Turso D1] Query error: ${msg}\nSQL: ${sql}`);
      }
      break;
    }

    const result = first!.response?.result ?? {
      cols: [],
      rows: [],
      affected_row_count: 0,
      last_insert_rowid: null
    };

    if (isReadOnly) {
      if (this.selectCache.size >= this.maxSelectCacheEntries) {
        const oldestKey = this.selectCache.keys().next().value;
        if (oldestKey !== undefined) this.selectCache.delete(oldestKey);
      }
      this.selectCache.set(cacheKey, { result, expiresAt: Date.now() + 30_000 });
    }

    return result;
  }

  /**
   * Executes multiple prepared statements atomically inside a transaction.
   * Automatically clears SELECT cache as mutations may occur in the batch.
   *
   * @param statements - Array of prepared statements to batch.
   * @returns Array of D1Result objects.
   */
  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.clearSelectCache();
    if (statements.length === 0) return [];
    const start = Date.now();

    const requests: HranaRequest[] = [
      { type: 'execute', stmt: { sql: 'PRAGMA foreign_keys = ON' } },
      { type: 'execute', stmt: { sql: 'BEGIN IMMEDIATE' } }
    ];

    for (const s of statements) {
      const ts = s as unknown as TursoD1PreparedStatement;
      requests.push({
        type: 'execute',
        stmt: {
          sql: ts.sql,
          args: ts.getParams().map(toHranaValue)
        }
      });
    }

    requests.push(
      { type: 'execute', stmt: { sql: 'COMMIT' } },
      { type: 'close' }
    );

    const maxBusyRetries = 2;
    const busyDelaysMs = [150, 350];
    let stepResults: HranaStepResult[] = [];

    for (let attempt = 0; attempt <= maxBusyRetries; attempt++) {
      stepResults = await this.executePipeline(requests);
      let shouldRetryBusy = false;

      // Check if any step failed
      for (let i = 0; i < stepResults.length; i++) {
        const step = stepResults[i];
        if (step.type === 'error' || step.error) {
          // Best-effort rollback
          try {
            await this.executePipeline([
              { type: 'execute', stmt: { sql: 'ROLLBACK' } },
              { type: 'close' }
            ]);
          } catch {
            // Ignore rollback failure
          }

          if (
            attempt < maxBusyRetries &&
            this.isTransientSqliteBusy(step.error?.code, step.error?.message)
          ) {
            shouldRetryBusy = true;
            await this.sleep(busyDelaysMs[attempt]);
            break;
          }

          const sqlIndex = i - 2;
          const failedSql =
            sqlIndex >= 0 && sqlIndex < statements.length
              ? (statements[sqlIndex] as unknown as TursoD1PreparedStatement).sql
              : 'TRANSACTION';
          throw new Error(
            `[Turso D1] Batch statement ${i} failed: ${step.error?.message || 'Error'}\nSQL: ${failedSql}`
          );
        }
      }

      if (!shouldRetryBusy) {
        break;
      }
    }

    // Extract statement execution results (indices 2 to statements.length + 1)
    const results: D1Result<T>[] = [];
    for (let i = 0; i < statements.length; i++) {
      const step = stepResults[i + 2];
      const execResult = step.response?.result ?? {
        cols: [],
        rows: [],
        affected_row_count: 0,
        last_insert_rowid: null
      };

      const rows: T[] = execResult.rows.map((row) => {
        const obj: Record<string, any> = {};
        for (let c = 0; c < execResult.cols.length; c++) {
          obj[execResult.cols[c].name] = fromHranaValue(row[c]);
        }
        return obj as T;
      });

      results.push({
        results: rows,
        success: true,
        meta: {
          duration: Date.now() - start,
          size_after: 0,
          rows_read: rows.length,
          rows_written: execResult.affected_row_count || 0,
          last_row_id: execResult.last_insert_rowid ? Number(execResult.last_insert_rowid) : 0,
          changed_db: (execResult.affected_row_count || 0) > 0,
          changes: execResult.affected_row_count || 0
        }
      });
    }

    return results;
  }

  /**
   * Executes raw multi-statement SQL strings.
   *
   * @param query - Raw SQL text (supports semicolon-delimited multiple statements).
   * @returns D1ExecResult object.
   */
  async exec(query: string): Promise<D1ExecResult> {
    this.clearSelectCache();
    const start = Date.now();
    const stmts = splitSqlStatements(query);
    if (stmts.length === 0) {
      return { count: 0, duration: 0 };
    }

    const requests: HranaRequest[] = stmts.map((s) => ({
      type: 'execute',
      stmt: { sql: s }
    }));
    requests.push({ type: 'close' });

    const stepResults = await this.executePipeline(requests);
    for (let i = 0; i < stmts.length; i++) {
      const step = stepResults[i];
      if (step.type === 'error' || step.error) {
        throw new Error(
          `[Turso D1] Exec error on statement ${i + 1}: ${step.error?.message || 'Error'}\nSQL: ${stmts[i]}`
        );
      }
    }

    return {
      count: stmts.length,
      duration: Date.now() - start
    };
  }

  async dump(): Promise<ArrayBuffer> {
    throw new Error('dump() is not supported in TursoD1Database');
  }

  withSession(_constraintOrBookmark?: string): D1DatabaseSession {
    const session = Object.assign(this, {
      getBookmark: () => null
    });
    return session as unknown as D1DatabaseSession;
  }
}

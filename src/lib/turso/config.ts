/**
 * @file config.ts
 * @description Turso / libSQL URL normalization, masking, and database service detection.
 */

import { Env } from '../../types';

/**
 * Supported database service engine types.
 */
export type DatabaseServiceType = 'D1' | 'Turso' | 'File';

/**
 * Normalizes a Turso / libSQL connection URL to standard HTTPS endpoint.
 * Supports `libsql://`, `turso://`, `https://`, and `http://` schemes.
 *
 * @param rawUrl - Input database URL (e.g., libsql://db-org.turso.io or turso://db-org.turso.io).
 * @returns Normalized HTTPS URL string.
 */
export function normalizeTursoUrl(rawUrl: string): string {
  let url = rawUrl.trim();
  if (/^libsql:\/\//i.test(url)) {
    url = 'https://' + url.slice('libsql://'.length);
  } else if (/^turso:\/\//i.test(url)) {
    url = 'https://' + url.slice('turso://'.length);
  } else if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }
  return url.replace(/\/+$/, '');
}

/**
 * Safely masks a database URL for user-facing logs and diagnostics.
 *
 * @param rawUrl - Database URL to mask.
 * @returns Masked URL.
 */
export function maskDatabaseUrl(rawUrl: string): string {
  try {
    const normalized = normalizeTursoUrl(rawUrl);
    const u = new URL(normalized);
    return `${u.protocol}//${u.host}`;
  } catch {
    return rawUrl.slice(0, 16) + '...';
  }
}

/**
 * Checks whether Turso database is configured in the given environment.
 *
 * @param env - Application environment bindings or process.env.
 * @returns True if Turso database URL and auth token are present.
 */
export function isTursoConfigured(env?: Partial<Env> | NodeJS.ProcessEnv | null): boolean {
  if (!env) return false;
  const url = (env.TURSO_DATABASE_URL || (env as any).TURSO_URL)?.trim();
  const token = env.TURSO_AUTH_TOKEN?.trim();
  return Boolean(url && token);
}

export interface TursoHealthResult {
  ok: boolean;
  errorCode?: 'missing' | 'invalid_url' | 'auth_failed' | 'quota_exceeded' | 'unreachable';
  message?: string;
}

/**
 * Checks whether a Turso error message or HTTP error body indicates a plan quota / blocked-operations state.
 *
 * @param message - Raw error message or response body from Turso.
 * @returns True if Turso blocked reads/writes due to usage quota exhaustion.
 */
export function isTursoQuotaError(message?: string | null): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return (
    lower.includes('operation was blocked') ||
    lower.includes('reads are blocked') ||
    lower.includes('writes are blocked') ||
    lower.includes('sql read operations are forbidden') ||
    lower.includes('sql write operations are forbidden') ||
    lower.includes('exceeded your usage quota') ||
    lower.includes('upgrade your plan')
  );
}

const tursoHealthCache = new Map<string, { result: TursoHealthResult; expiresAt: number }>();

/**
 * Verifies that the configured Turso URL and Auth Token are valid and reachable.
 * Caches healthy results for 60s and failures for 10s per credential pair to avoid
 * adding latency to every request while promptly surfacing misconfigurations.
 *
 * @param env - Application environment bindings or process.env.
 * @returns TursoHealthResult indicating connectivity and auth status.
 */
export async function verifyTursoConnection(
  env?: Partial<Env> | NodeJS.ProcessEnv | null
): Promise<TursoHealthResult> {
  if (!env) {
    return {
      ok: false,
      errorCode: 'missing',
      message: 'TURSO_DATABASE_URL or TURSO_AUTH_TOKEN is not configured.'
    };
  }
  const rawUrl = (env.TURSO_DATABASE_URL || (env as any).TURSO_URL)?.trim() || '';
  const token = env.TURSO_AUTH_TOKEN?.trim() || '';
  if (!rawUrl || !token) {
    return {
      ok: false,
      errorCode: 'missing',
      message: 'TURSO_DATABASE_URL or TURSO_AUTH_TOKEN is not configured.'
    };
  }

  let normalizedUrl: string;
  try {
    normalizedUrl = normalizeTursoUrl(rawUrl);
    const parsed = new URL(normalizedUrl);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) {
      throw new Error('Invalid Turso URL protocol or host');
    }
  } catch {
    return {
      ok: false,
      errorCode: 'invalid_url',
      message: 'TURSO_DATABASE_URL is invalid. Expected a valid libsql://, turso://, or https:// URL.'
    };
  }

  const cacheKey = `${normalizedUrl}::${token.slice(0, 8)}:${token.length}`;
  const now = Date.now();
  const cached = tursoHealthCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.result;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  let result: TursoHealthResult;

  try {
    const res = await fetch(`${normalizedUrl}/v2/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        requests: [
          { type: 'execute', stmt: { sql: 'SELECT 1' } },
          { type: 'close' }
        ]
      }),
      signal: controller.signal
    });

    if (res.status === 401) {
      result = {
        ok: false,
        errorCode: 'auth_failed',
        message: `Turso authentication failed (HTTP ${res.status}). Please verify TURSO_AUTH_TOKEN.`
      };
    } else if (res.status === 403) {
      const errBody = await res.text().catch(() => '');
      if (isTursoQuotaError(errBody)) {
        result = {
          ok: false,
          errorCode: 'quota_exceeded',
          message: `Turso quota exceeded (DNS fail-open to FAIL_OPEN_UPSTREAM active): ${errBody}`
        };
      } else {
        result = {
          ok: false,
          errorCode: 'auth_failed',
          message: `Turso authentication failed (HTTP ${res.status}). Please verify TURSO_AUTH_TOKEN.`
        };
      }
    } else if (res.status === 402) {
      const errBody = await res.text().catch(() => '');
      result = {
        ok: false,
        errorCode: 'quota_exceeded',
        message: `Turso quota exceeded (DNS fail-open to FAIL_OPEN_UPSTREAM active): ${errBody || 'HTTP 402 Payment Required'}`
      };
    } else if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      if (isTursoQuotaError(errBody)) {
        result = {
          ok: false,
          errorCode: 'quota_exceeded',
          message: `Turso quota exceeded (DNS fail-open to FAIL_OPEN_UPSTREAM active): ${errBody}`
        };
      } else {
        result = {
          ok: false,
          errorCode: 'unreachable',
          message: `Turso endpoint returned HTTP ${res.status}. Please verify TURSO_DATABASE_URL.`
        };
      }
    } else {
      const json = (await res.json().catch(() => null)) as { results?: Array<{ type?: string; error?: { message?: string } }> } | null;
      const first = json?.results?.[0];
      if (!first || first.type === 'error' || first.error) {
        const probeErrMsg = first?.error?.message || 'Unexpected response';
        if (isTursoQuotaError(probeErrMsg)) {
          result = {
            ok: false,
            errorCode: 'quota_exceeded',
            message: `Turso quota exceeded (DNS fail-open to FAIL_OPEN_UPSTREAM active): ${probeErrMsg}`
          };
        } else {
          result = {
            ok: false,
            errorCode: 'unreachable',
            message: `Turso query probe failed: ${probeErrMsg}`
          };
        }
      } else {
        result = { ok: true };
      }
    }
  } catch (err: any) {
    const isAbort = err?.name === 'AbortError';
    result = {
      ok: false,
      errorCode: 'unreachable',
      message: isAbort
        ? 'Turso connection timed out. Please verify TURSO_DATABASE_URL and network connectivity.'
        : 'Unable to reach Turso endpoint. Please verify TURSO_DATABASE_URL.'
    };
  } finally {
    clearTimeout(timeoutId);
  }

  if (tursoHealthCache.size >= 32) {
    const firstKey = tursoHealthCache.keys().next().value;
    if (firstKey !== undefined) tursoHealthCache.delete(firstKey);
  }
  const cacheTtlMs = result.ok
    ? 300_000
    : result.errorCode === 'quota_exceeded'
      ? 60_000
      : 5_000;
  tursoHealthCache.set(cacheKey, {
    result,
    expiresAt: now + cacheTtlMs
  });
  return result;
}

/**
 * Resolves the active database service type ('D1' | 'Turso' | 'File') based on environment variables.
 * - Serverless mode (Cloudflare Workers) defaults to 'D1'.
 * - Serverfull mode (Node.js/Bun/Docker) defaults to 'File'.
 * - Explicit DATABASE_SERVICE ('D1', 'Turso', 'File', case-insensitive) takes highest precedence.
 * - If DATABASE_SERVICE is omitted but Turso credentials are fully configured, automatically resolves to 'Turso'.
 *
 * @param env - Application environment bindings or process.env.
 * @param isServerfull - True if running in Serverfull mode.
 * @returns Resolved DatabaseServiceType ('D1' | 'Turso' | 'File').
 */
export function getDatabaseService(
  env?: Partial<Env> | NodeJS.ProcessEnv | null,
  isServerfull = false
): DatabaseServiceType {
  const raw = (env?.DATABASE_SERVICE || (env as any)?.DB_SERVICE)?.trim().toLowerCase();
  if (raw === 'turso') return 'Turso';
  if (raw === 'd1') return 'D1';
  if (raw === 'file') return 'File';

  // If DATABASE_SERVICE is not explicitly set, but Turso credentials are fully provided, auto-enable Turso
  if (isTursoConfigured(env)) {
    return 'Turso';
  }

  // Standard platform defaults: D1 for Serverless, File for Serverfull
  return isServerfull ? 'File' : 'D1';
}

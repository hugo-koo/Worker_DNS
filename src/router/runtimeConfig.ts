/**
 * @file runtimeConfig.ts
 * @description Runtime environment detection, database readiness verification, and frontend config serialization.
 */

import { Env } from '../types';
import { DatabaseServiceType, TursoHealthResult, isTursoConfigured, verifyTursoConnection } from '../lib/turso';
import { isUsableJwtSecret } from '../lib/jwt';
import { getDemoDomain, isDemoMode } from '../lib/demoConfig';

export interface DbConfigStatus {
  isDbMissing: boolean;
  isDbQuotaExceeded: boolean;
  dbErrorCode?: TursoHealthResult['errorCode'];
  dbErrorMessage: string;
}

export interface RouterRuntimeContext {
  isServerfull: boolean;
  dbService: DatabaseServiceType;
  nonce: string;
}

/**
 * Detects whether the Worker is running in Serverfull (Node.js/Docker) mode.
 */
export function detectServerfullMode(env: Env): boolean {
  return Boolean(
    env.DATABASE_SERVICE === 'File' ||
    env.SERVERFULL_DEFAULT_PROFILE_KEY !== undefined ||
    env.SERVERFULL_HOST !== undefined ||
    env.SERVERFULL_DOT_DOMAIN !== undefined ||
    env.SERVERFULL_HTTP_PORT !== undefined ||
    env.SERVERFULL_HTTPS_PORT !== undefined ||
    env.SERVERFULL_DB_PATH !== undefined
  );
}

/**
 * Resolves database availability and Turso connectivity/auth status.
 */
export async function resolveDbConfigStatus(
  env: Env,
  isServerfull: boolean,
  dbService: DatabaseServiceType
): Promise<DbConfigStatus> {
  if (dbService === 'Turso') {
    if (!isTursoConfigured(env) || !env.DB) {
      return {
        isDbMissing: true,
        isDbQuotaExceeded: false,
        dbErrorCode: 'missing',
        dbErrorMessage: 'DATABASE_SERVICE is set to Turso, but TURSO_DATABASE_URL or TURSO_AUTH_TOKEN is not configured.'
      };
    }
    const health = await verifyTursoConnection(env);
    if (!health.ok) {
      if (health.errorCode === 'quota_exceeded') {
        return {
          isDbMissing: false,
          isDbQuotaExceeded: true,
          dbErrorCode: 'quota_exceeded',
          dbErrorMessage: health.message || 'Turso usage quota exceeded (DNS fail-open active).'
        };
      }
      return {
        isDbMissing: true,
        isDbQuotaExceeded: false,
        dbErrorCode: health.errorCode,
        dbErrorMessage: health.message || 'Turso connection verification failed.'
      };
    }
    return { isDbMissing: false, isDbQuotaExceeded: false, dbErrorMessage: '' };
  }

  if (dbService === 'File') {
    if (!isServerfull) {
      return {
        isDbMissing: true,
        isDbQuotaExceeded: false,
        dbErrorMessage: "DATABASE_SERVICE='File' is not supported in Cloudflare Workers. Please configure D1 database binding or use DATABASE_SERVICE='Turso'."
      };
    }
    if (!env.DB) {
      return {
        isDbMissing: true,
        isDbQuotaExceeded: false,
        dbErrorMessage: 'Database file is missing. Please restart the service or verify file permissions.'
      };
    }
    return { isDbMissing: false, isDbQuotaExceeded: false, dbErrorMessage: '' };
  }

  // Default: 'D1'
  if (isServerfull) {
    return {
      isDbMissing: true,
      isDbQuotaExceeded: false,
      dbErrorMessage: "DATABASE_SERVICE='D1' is designed for Cloudflare Workers. In Serverfull mode, please set DATABASE_SERVICE='File' or 'Turso'."
    };
  }
  try {
    return {
      isDbMissing: !env.DB,
      isDbQuotaExceeded: false,
      dbErrorMessage: !env.DB ? 'D1 database binding is not configured.' : ''
    };
  } catch {
    return {
      isDbMissing: true,
      isDbQuotaExceeded: false,
      dbErrorMessage: 'D1 database binding is not configured.'
    };
  }
}

/**
 * Builds the serialized JSON configuration injected into HTML responses for the frontend SPA.
 */
export async function buildRuntimeConfigJson(
  env: Env,
  runtimeCtx: RouterRuntimeContext
): Promise<string> {
  const { isDbMissing, isDbQuotaExceeded, dbErrorCode, dbErrorMessage } = await resolveDbConfigStatus(
    env,
    runtimeCtx.isServerfull,
    runtimeCtx.dbService
  );
  const isJwtSecretMissing = !isUsableJwtSecret(env.JWT_SECRET);

  try {
    const demoMode = isDemoMode(env);
    return JSON.stringify({
      nonce: runtimeCtx.nonce,
      isDbMissing,
      isDbQuotaExceeded,
      dbErrorCode,
      dbError: dbErrorMessage || undefined,
      isJwtSecretMissing,
      isServerfull: runtimeCtx.isServerfull,
      databaseService: runtimeCtx.dbService,
      isTurso: runtimeCtx.dbService === 'Turso',
      mode: runtimeCtx.isServerfull ? 'serverfull' : 'cloudflare',
      isDemoMode: demoMode,
      demoDomain: demoMode ? getDemoDomain(env) : undefined
    });
  } catch {
    return '{}';
  }
}

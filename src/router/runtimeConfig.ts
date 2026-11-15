/**
 * @file runtimeConfig.ts
 * @description Runtime environment detection, database readiness verification, and frontend config serialization.
 */

import { Env } from '../types';
import { DatabaseServiceType, isTursoConfigured, verifyTursoConnection } from '../lib/turso';
import { isUsableJwtSecret } from '../lib/jwt';

export interface DbConfigStatus {
  isDbMissing: boolean;
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
        dbErrorMessage: 'DATABASE_SERVICE is set to Turso, but TURSO_DATABASE_URL or TURSO_AUTH_TOKEN is not configured.'
      };
    }
    const health = await verifyTursoConnection(env);
    if (!health.ok) {
      return {
        isDbMissing: true,
        dbErrorMessage: health.message || 'Turso connection verification failed.'
      };
    }
    return { isDbMissing: false, dbErrorMessage: '' };
  }

  if (dbService === 'File') {
    if (!isServerfull) {
      return {
        isDbMissing: true,
        dbErrorMessage: "DATABASE_SERVICE='File' is not supported in Cloudflare Workers. Please configure D1 database binding or use DATABASE_SERVICE='Turso'."
      };
    }
    if (!env.DB) {
      return {
        isDbMissing: true,
        dbErrorMessage: 'Database file is missing. Please restart the service or verify file permissions.'
      };
    }
    return { isDbMissing: false, dbErrorMessage: '' };
  }

  // Default: 'D1'
  if (isServerfull) {
    return {
      isDbMissing: true,
      dbErrorMessage: "DATABASE_SERVICE='D1' is designed for Cloudflare Workers. In Serverfull mode, please set DATABASE_SERVICE='File' or 'Turso'."
    };
  }
  try {
    return {
      isDbMissing: !env.DB,
      dbErrorMessage: !env.DB ? 'D1 database binding is not configured.' : ''
    };
  } catch {
    return {
      isDbMissing: true,
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
  const { isDbMissing, dbErrorMessage } = await resolveDbConfigStatus(
    env,
    runtimeCtx.isServerfull,
    runtimeCtx.dbService
  );
  const isJwtSecretMissing = !isUsableJwtSecret(env.JWT_SECRET);

  try {
    return JSON.stringify({
      nonce: runtimeCtx.nonce,
      isDbMissing,
      dbError: dbErrorMessage || undefined,
      isJwtSecretMissing,
      isServerfull: runtimeCtx.isServerfull,
      databaseService: runtimeCtx.dbService,
      isTurso: runtimeCtx.dbService === 'Turso',
      mode: runtimeCtx.isServerfull ? 'serverfull' : 'cloudflare'
    });
  } catch {
    return '{}';
  }
}

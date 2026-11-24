/**
 * @file api.ts
 * @description Business API router handling configuration gating, auth/session enforcement, CSRF, and sub-route dispatch.
 */

import { Env, User, ExecutionContext } from '../types';
import { getCurrentUser, validateCsrf } from '../lib/middleware';
import { isUsableJwtSecret } from '../lib/jwt';
import { handleAuthRequest } from '../api/auth';
import { handleProfilesRequest } from '../api/profiles';
import { handleAccessPointsRequest } from '../api/accessPoints';
import { handleAccountRequest } from '../api/account';
import { handleSystemRequest } from '../api/system';
import { resolveDbConfigStatus, RouterRuntimeContext } from './runtimeConfig';

const PUBLIC_API_EXACT_ROUTES = new Set<string>([
  '/api/auth/login',
  '/api/auth/signup',
  '/api/auth/prelogin',
  '/api/auth/check-username',
  '/api/auth/check-invite-code',
  '/api/auth/config',
  '/api/auth/refresh',
  '/api/auth/logout',
  '/api/auth/unlock-session',
  '/api/clientinfo',
  '/api/substitute',
  '/api/resolve',
  '/api/geoip'
]);

const PAUSED_ALLOWED_ROUTES = new Set<string>([
  '/api/auth/unlock-session',
  '/api/auth/logout',
  '/api/auth/refresh'
]);

function isPublicApiRoute(pathname: string): boolean {
  return (
    PUBLIC_API_EXACT_ROUTES.has(pathname) ||
    pathname.startsWith('/api/icon/') ||
    pathname.startsWith('/api/presets/') ||
    pathname.startsWith('/api/auth/forgot-password') ||
    pathname.startsWith('/api/auth/find-username')
  );
}

/**
 * Handles `/api/*` requests and returns both the HTTP response and authenticated user (if any).
 */
export async function handleApiRouter(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  runtimeCtx: RouterRuntimeContext
): Promise<{ response: Response; currentUser: User | null }> {
  const { isDbMissing, isDbQuotaExceeded, dbErrorCode, dbErrorMessage } = await resolveDbConfigStatus(
    env,
    runtimeCtx.isServerfull,
    runtimeCtx.dbService
  );
  const isJwtSecretMissing = !isUsableJwtSecret(env.JWT_SECRET);

  if (isDbMissing || isJwtSecretMissing) {
    return {
      currentUser: null,
      response: new Response(JSON.stringify({
        error: 'configuration_error',
        isDbMissing,
        isJwtSecretMissing,
        databaseService: runtimeCtx.dbService,
        message: dbErrorMessage || 'DNS Worker is not fully configured. Please configure the database and JWT_SECRET secret variable.'
      }), {
        status: 503,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      })
    };
  }

  if (isDbQuotaExceeded) {
    return {
      currentUser: null,
      response: new Response(JSON.stringify({
        error: 'database_quota_exceeded',
        isDbMissing: false,
        isDbQuotaExceeded: true,
        dbErrorCode,
        databaseService: runtimeCtx.dbService,
        message: dbErrorMessage || 'Database usage quota exceeded. Management API is temporarily paused while DNS fail-open remains active.'
      }), {
        status: 503,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      })
    };
  }

  const currentUser = await getCurrentUser(request, env, ctx);
  const isPublicRoute = isPublicApiRoute(url.pathname);

  if (!currentUser && !isPublicRoute) {
    return { currentUser, response: new Response('Unauthorized', { status: 401 }) };
  }

  if (currentUser && currentUser.isPaused) {
    const isAllowedWhilePaused =
      PAUSED_ALLOWED_ROUTES.has(url.pathname) ||
      (url.pathname === '/api/account/me' && request.method === 'PATCH');
    if (!isAllowedWhilePaused) {
      return { currentUser, response: new Response('session_paused', { status: 403 }) };
    }
  }

  if (currentUser && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) && !isPublicRoute) {
    if (!validateCsrf(request)) {
      return { currentUser, response: new Response('CSRF validation failed', { status: 403 }) };
    }
  }

  if (url.pathname.startsWith('/api/auth/')) {
    return { currentUser, response: await handleAuthRequest(request, env) };
  }

  if (
    url.pathname === '/api/clientinfo' ||
    url.pathname === '/api/substitute' ||
    url.pathname === '/api/resolve' ||
    url.pathname === '/api/geoip' ||
    url.pathname.startsWith('/api/presets/') ||
    url.pathname.startsWith('/api/icon/')
  ) {
    return { currentUser, response: await handleSystemRequest(request, env) };
  }

  if (url.pathname.startsWith('/api/profiles')) {
    return { currentUser, response: await handleProfilesRequest(request, env, currentUser, ctx) };
  }

  if (url.pathname === '/api/access_points' || url.pathname.startsWith('/api/access_points/')) {
    return { currentUser, response: await handleAccessPointsRequest(request, env, currentUser!, ctx) };
  }

  if (url.pathname.startsWith('/api/account') || url.pathname.startsWith('/api/admin')) {
    return { currentUser, response: await handleAccountRequest(request, env, currentUser!, ctx) };
  }

  return { currentUser, response: new Response('API Not Found', { status: 404 }) };
}

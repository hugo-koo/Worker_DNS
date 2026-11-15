/**
 * @file index.ts
 * @description Top-level HTTP request router and response finalizer (CSRF cookie, DoH CORS, security headers).
 */

import { Env, User, ExecutionContext } from '../types';
import { readCsrfCookie, createCsrfCookie, generateId } from '../lib/auth';
import { applySecurityHeaders } from '../lib/middleware';
import { generateLinuxSetupScript } from '../utils/linuxSetup';
import { ACCESS_KEY_REGEX } from '../utils/validator';
import { handleDoHRequest } from '../api/doh';
import { handleMapDataRequest } from '../api/mapData';
import { handleApiRouter } from './api';
import { handleAssetsRouter } from './assets';
import { RouterRuntimeContext } from './runtimeConfig';

export { detectServerfullMode, resolveDbConfigStatus } from './runtimeConfig';
export type { RouterRuntimeContext } from './runtimeConfig';

/**
 * Dispatches an incoming HTTP request to the matching subsystem router.
 */
export async function routeRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  runtimeCtx: RouterRuntimeContext
): Promise<{ response: Response; currentUser: User | null }> {
  const url = new URL(request.url);

  if (url.pathname === '/world-110m.json') {
    return { currentUser: null, response: await handleMapDataRequest(request, env, ctx) };
  }

  if (url.pathname.startsWith('/api/')) {
    return handleApiRouter(request, url, env, ctx, runtimeCtx);
  }

  if (url.pathname === '/setup.sh') {
    const key = url.searchParams.get('key');
    if (!key || !ACCESS_KEY_REGEX.test(key)) {
      return { currentUser: null, response: new Response('Missing or invalid key parameter', { status: 400 }) };
    }
    if (!/^https?:\/\/[a-zA-Z0-9.-]+(:\d{1,5})?$/.test(url.origin)) {
      return { currentUser: null, response: new Response('Invalid Host header', { status: 400 }) };
    }
    const script = generateLinuxSetupScript(url.origin, key);
    return {
      currentUser: null,
      response: new Response(script, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-cache'
        }
      })
    };
  }

  const rawKey = url.pathname.slice(1);
  const isKeyValid = ACCESS_KEY_REGEX.test(rawKey);
  const isDnsQueryPath = url.pathname === '/dns-query';
  const isDoHRequest =
    request.method === 'POST' ||
    url.searchParams.has('dns') ||
    request.headers.get('accept')?.includes('dns-message');

  if ((isKeyValid || isDnsQueryPath) && (isDoHRequest || request.method === 'OPTIONS')) {
    if (request.method === 'OPTIONS') {
      return {
        currentUser: null,
        response: new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Accept',
            'Access-Control-Max-Age': '86400'
          }
        })
      };
    }
    return {
      currentUser: null,
      response: await handleDoHRequest(request, env, ctx, isDnsQueryPath ? '' : rawKey)
    };
  }

  return {
    currentUser: null,
    response: await handleAssetsRouter(request, url, env, runtimeCtx)
  };
}

/**
 * Applies CSRF cookie issuance, DoH CORS headers, and CSP/security headers to the outgoing response.
 */
export function finalizeResponse(
  request: Request,
  initialResponse: Response,
  env: Env,
  currentUser: User | null,
  nonce: string
): Response {
  let response = initialResponse;

  if (currentUser && !readCsrfCookie(request.headers.get('Cookie'))) {
    const isKeepLoggedIn = currentUser.sessionId?.startsWith('k_');
    const csrfToken = generateId(32);
    const cookieValue = createCsrfCookie(csrfToken, env, isKeepLoggedIn);
    try {
      response.headers.append('Set-Cookie', cookieValue);
    } catch {
      const newHeaders = new Headers(response.headers);
      newHeaders.append('Set-Cookie', cookieValue);
      response = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders
      });
    }
  }

  if (response.headers.get('Content-Type')?.includes('application/dns-message')) {
    const dohHeaders = new Headers(response.headers);
    dohHeaders.set('Access-Control-Allow-Origin', '*');
    dohHeaders.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    dohHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Accept');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: dohHeaders
    });
  }

  return applySecurityHeaders(response, nonce);
}

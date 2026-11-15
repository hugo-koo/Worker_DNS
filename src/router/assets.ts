/**
 * @file assets.ts
 * @description Static asset hosting, SPA fallback routing, WASM MIME enforcement, and HTML runtime config injection.
 */

import { Env } from '../types';
import { buildRuntimeConfigJson, RouterRuntimeContext } from './runtimeConfig';

/**
 * Serves static assets via `env.ASSETS` with SPA fallback and HTML config injection.
 */
export async function handleAssetsRouter(
  request: Request,
  url: URL,
  env: Env,
  runtimeCtx: RouterRuntimeContext
): Promise<Response> {
  try {
    let response = await (env as any).ASSETS.fetch(request);
    if (response.status === 404 && !url.pathname.startsWith('/assets/') && (request.method === 'GET' || request.method === 'HEAD')) {
      response = await (env as any).ASSETS.fetch(new Request(url.origin + '/', {
        method: request.method,
        headers: request.headers
      }));
    }

    if (url.pathname.endsWith('.wasm')) {
      const wasmHeaders = new Headers(response.headers);
      wasmHeaders.set('Content-Type', 'application/wasm');
      wasmHeaders.set('Cross-Origin-Resource-Policy', 'same-origin');
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: wasmHeaders
      });
    }

    const contentType = response.headers.get('Content-Type') || '';
    if (contentType.includes('text/html')) {
      const configStr = await buildRuntimeConfigJson(env, runtimeCtx);
      return new HTMLRewriter()
        .on('head', {
          element(element) {
            element.prepend(`<script nonce="${runtimeCtx.nonce}">window.DNS_WORKER_CONFIG = ${configStr};</script>`, { html: true });
          }
        })
        .transform(response);
    }

    return response;
  } catch {
    return new Response('Asset Fetch Error', { status: 500 });
  }
}

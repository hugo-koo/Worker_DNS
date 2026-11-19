/**
 * @file assets.ts
 * @description Static asset hosting, SPA fallback routing, WASM MIME enforcement, and HTML runtime config injection.
 */

import { Env } from '../types';
import { buildRuntimeConfigJson, RouterRuntimeContext } from './runtimeConfig';

/**
 * Creates a request clone without conditional cache headers so HTML/SPA document fetches
 * never return `304 Not Modified` with an empty body before runtime config/nonce injection.
 */
function createUnconditionalAssetRequest(urlString: string, source: Request): Request {
  const headers = new Headers(source.headers);
  headers.delete('If-None-Match');
  headers.delete('If-Modified-Since');
  return new Request(urlString, {
    method: source.method,
    headers
  });
}

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
    const isDocumentLikePath =
      url.pathname === '/' ||
      url.pathname.endsWith('.html') ||
      (!url.pathname.startsWith('/assets/') && !/\.[a-zA-Z0-9]{1,8}$/.test(url.pathname));
    const initialAssetReq = isDocumentLikePath
      ? createUnconditionalAssetRequest(request.url, request)
      : request;

    let response = await (env as any).ASSETS.fetch(initialAssetReq);
    if (response.status === 404 && !url.pathname.startsWith('/assets/') && (request.method === 'GET' || request.method === 'HEAD')) {
      response = await (env as any).ASSETS.fetch(createUnconditionalAssetRequest(url.origin + '/', request));
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
      const htmlHeaders = new Headers(response.headers);
      // Every HTML response embeds a per-request CSP nonce; caching or ETag revalidation would mismatch the nonce.
      htmlHeaders.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      htmlHeaders.delete('ETag');
      const uncachedHtmlResponse = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: htmlHeaders
      });

      return new HTMLRewriter()
        .on('head', {
          element(element) {
            element.prepend(`<script nonce="${runtimeCtx.nonce}">window.DNS_WORKER_CONFIG = ${configStr};</script>`, { html: true });
          }
        })
        .transform(uncachedHtmlResponse);
    }

    return response;
  } catch {
    return new Response('Asset Fetch Error', { status: 500 });
  }
}

/**
 * @file assets.ts
 * @description Static asset file serving and MIME mapping for Web Dashboard in Serverfull mode.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Env } from '../../types';
import { getPackageRoot } from '../config';
import { SizeCappedMap } from '../../pipeline/cache';

interface CachedStaticAsset {
  content: Uint8Array;
  contentType: string;
  cacheControl: string;
  etag: string;
  mtimeMs: number;
}

const MAX_CACHED_ASSET_BYTES = 4 * 1024 * 1024;
const assetMemoryCache = new SizeCappedMap<string, CachedStaticAsset>(256);

export const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm'
};

/**
 * Attaches the static asset file-serving handler to the worker Env if not already attached.
 *
 * @param env - The Cloudflare/Serverfull Env object.
 * @param staticDir - Optional path to the directory containing static frontend files.
 */
export function attachStaticAssetHandler(env: Env, staticDir?: string): void {
  if (env.ASSETS) return;

  const targetDir = staticDir || path.join(getPackageRoot(), 'static');

  env.ASSETS = {
    fetch: async (req: Request): Promise<Response> => {
      try {
        const url = new URL(req.url);
        let pathname = decodeURIComponent(url.pathname);
        if (pathname === '/' || pathname === '') {
          pathname = '/index.html';
        }

        const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
        const filePath = path.join(targetDir, safePath);
        const relPath = safePath.replace(/^[/\\]+/, '');
        const isImmutableAsset = relPath.startsWith('assets/') || relPath.startsWith('assets\\');

        let assetEntry = assetMemoryCache.get(filePath);
        if (!assetEntry || !isImmutableAsset) {
          let stat: fs.Stats;
          try {
            stat = await fs.promises.stat(filePath);
          } catch {
            return new Response('Not Found', { status: 404 });
          }
          if (!stat.isFile()) {
            return new Response('Not Found', { status: 404 });
          }

          const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
          if (!assetEntry || assetEntry.mtimeMs !== stat.mtimeMs || assetEntry.etag !== etag) {
            const ext = path.extname(filePath).toLowerCase();
            const contentType = MIME_TYPES[ext] || 'application/octet-stream';
            // HTML documents carry per-request CSP nonces and runtime config; unhashed root assets (favicon, sw.js) must also revalidate.
            const cacheControl =
              ext === '.html'
                ? 'no-store, no-cache, must-revalidate'
                : isImmutableAsset
                  ? 'public, max-age=31536000, immutable'
                  : 'public, max-age=0, must-revalidate';
            const rawBuf = await fs.promises.readFile(filePath);
            const loaded: CachedStaticAsset = {
              content: new Uint8Array(rawBuf.buffer, rawBuf.byteOffset, rawBuf.byteLength),
              contentType,
              cacheControl,
              etag,
              mtimeMs: stat.mtimeMs
            };
            if (loaded.content.byteLength <= MAX_CACHED_ASSET_BYTES) {
              assetMemoryCache.set(filePath, loaded);
            }
            assetEntry = loaded;
          }
        }

        const isHtml = assetEntry.contentType.includes('text/html');
        const ifNoneMatch = req.headers.get('If-None-Match');
        if (!isHtml && ifNoneMatch && ifNoneMatch.split(',').some((tag) => tag.trim() === assetEntry!.etag)) {
          return new Response(null, {
            status: 304,
            headers: {
              'ETag': assetEntry.etag,
              'Cache-Control': assetEntry.cacheControl
            }
          });
        }

        const bodyBytes = req.method === 'HEAD' ? null : (assetEntry.content as unknown as BodyInit);
        const responseHeaders: Record<string, string> = {
          'Content-Type': assetEntry.contentType,
          'Cache-Control': assetEntry.cacheControl,
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'credentialless',
          'Cross-Origin-Resource-Policy': 'same-origin'
        };
        if (!isHtml) {
          responseHeaders['ETag'] = assetEntry.etag;
        }
        return new Response(bodyBytes, {
          status: 200,
          headers: responseHeaders
        });
      } catch {
        return new Response('Asset Error', { status: 500 });
      }
    }
  };
}

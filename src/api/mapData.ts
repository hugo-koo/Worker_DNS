import { Env, ExecutionContext } from '../types';
import { getSystemVersion } from '../constants/version';

const MAP_CACHE_URL = 'https://obex.local/world-110m-v3.json';
const UPSTREAM_MAP_URLS: readonly string[] = [
  'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json',
  'https://openlayers.org/en/latest/examples/data/topojson/world-110m.json',
];

interface TopoGeometry {
  id?: string | number | null;
  [key: string]: unknown;
}

interface TopoJsonPayload {
  type?: unknown;
  objects?: {
    countries?: { geometries?: TopoGeometry[]; [key: string]: unknown };
    land?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Validates that a parsed payload is a usable world TopoJSON object containing country geometries.
 */
function isValidWorldTopology(data: unknown): data is TopoJsonPayload {
  if (!data || typeof data !== 'object') return false;
  const topo = data as TopoJsonPayload;
  const countries = topo.objects?.countries;
  return (
    topo.type === 'Topology' &&
    Boolean(countries) &&
    Array.isArray(countries?.geometries) &&
    countries.geometries.length > 0
  );
}

/**
 * Normalizes TopoJSON object keys (`countries` first) and pads numeric geometry IDs to 3 digits.
 */
function normalizeWorldTopology(data: TopoJsonPayload): TopoJsonPayload {
  if (data.objects) {
    const sortedObjects: Record<string, unknown> = {};
    if (data.objects.countries) {
      sortedObjects.countries = data.objects.countries;
    }
    if (data.objects.land) {
      sortedObjects.land = data.objects.land;
    }
    data.objects = sortedObjects;
  }

  const geometries = data.objects?.countries?.geometries;
  if (Array.isArray(geometries)) {
    geometries.forEach((geom) => {
      if (geom.id !== undefined && geom.id !== null) {
        geom.id = String(geom.id).padStart(3, '0');
      }
    });
  }

  return data;
}

/**
 * Intercepts `/world-110m.json` requests, validates cached TopoJSON integrity (self-healing if
 * a local or edge cache entry is corrupted), fetches from openlayers.org on miss, normalizes
 * 3-digit padded country IDs, and caches the response for 30 days.
 */
export async function handleMapDataRequest(
  _request: Request,
  _env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const cache = typeof caches !== 'undefined' ? (caches as { default?: Cache }).default : undefined;
  const cacheKey = new Request(MAP_CACHE_URL, { method: 'GET' });

  if (cache && typeof cache.match === 'function') {
    try {
      const cached = await cache.match(cacheKey);
      if (cached && cached.ok) {
        const cachedText = await cached.clone().text();
        if (cachedText && !cachedText.startsWith('\u0000')) {
          const parsed: unknown = JSON.parse(cachedText);
          if (isValidWorldTopology(parsed)) {
            return cached;
          }
        }
        console.warn('[MapData API Proxy] Evicting corrupted cached TopoJSON entry.');
        ctx.waitUntil(cache.delete(cacheKey));
      }
    } catch (err) {
      console.warn('[MapData API Proxy] Cache validation failed, refreshing upstream:', err);
      if (typeof cache.delete === 'function') {
        ctx.waitUntil(cache.delete(cacheKey));
      }
    }
  }

  let lastError: unknown = null;
  for (const upstreamUrl of UPSTREAM_MAP_URLS) {
    try {
      const res = await fetch(upstreamUrl, {
        headers: {
          'User-Agent': `DNS-Worker/${getSystemVersion()} (Cloudflare Worker Map Proxy)`,
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        throw new Error(`Failed to fetch map data from ${upstreamUrl}: ${res.status}`);
      }

      const rawData: unknown = await res.json();
      if (!isValidWorldTopology(rawData)) {
        throw new Error(`Upstream map payload from ${upstreamUrl} is missing valid TopoJSON country geometries`);
      }

      const normalized = normalizeWorldTopology(rawData);
      const response = new Response(JSON.stringify(normalized), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=2592000',
          'Access-Control-Allow-Origin': '*',
        },
      });

      if (cache && typeof cache.put === 'function') {
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
      }

      return response;
    } catch (e) {
      lastError = e;
      console.warn(`[MapData API Proxy] Upstream source failed (${upstreamUrl}):`, e);
    }
  }

  console.error('[MapData API Proxy] All map upstream sources failed:', lastError);
  return new Response(JSON.stringify({ error: 'Failed to fetch map data' }), {
    status: 502,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

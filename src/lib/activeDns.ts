import { SizeCappedMap } from "../pipeline/cache";
import { cacheUtils } from "../utils/cache";

const ACTIVE_DNS_MAX_ENTRIES = 50_000;
const CANONICAL_ACTIVE_DNS_ORIGIN = "https://active-dns.dns-worker.internal";

export interface ActiveDnsEntry {
  profileId: string;
  expiresAt: number;
}

export type ActiveDnsSyncPublisher = (
  ip: string,
  profileId: string,
  expiresAt: number
) => void;

const activeDnsMemoryMap = new SizeCappedMap<string, ActiveDnsEntry>(ACTIVE_DNS_MAX_ENTRIES);
let syncPublisher: ActiveDnsSyncPublisher | null = null;

/**
 * Normalizes a client IP string for consistent Active DNS tracking across transports
 * (DoH HTTP, DoT TLS, UDP DNS, dual-stack `::ffff:` IPv4-mapped IPv6, and bracketed IPv6).
 *
 * @param rawIp - Raw client IP string.
 * @returns Normalized IP string.
 */
export function normalizeActiveDnsIp(rawIp: string): string {
  let ip = rawIp.trim();
  if (!ip) {
    return "";
  }

  if (ip.startsWith("[")) {
    const closeIdx = ip.indexOf("]");
    if (closeIdx > 1) {
      ip = ip.slice(1, closeIdx);
    }
  } else if (ip.includes(":") && ip.indexOf(":") === ip.lastIndexOf(":")) {
    const [hostPart, portPart] = ip.split(":");
    if (portPart && /^\d+$/.test(portPart) && /^(\d{1,3}\.){3}\d{1,3}$/.test(hostPart)) {
      ip = hostPart;
    }
  }

  if (ip.toLowerCase().startsWith("::ffff:")) {
    ip = ip.slice(7);
  }

  return ip.toLowerCase();
}

/**
 * Registers an IPC publisher used by Serverfull cluster workers to synchronize
 * active DNS connections across worker processes.
 *
 * @param publisher - Callback invoked whenever this process records a connection.
 */
export function registerActiveDnsSyncPublisher(publisher: ActiveDnsSyncPublisher | null): void {
  syncPublisher = publisher;
}

/**
 * Applies an active DNS entry replicated from another Serverfull cluster worker.
 *
 * @param ip - Normalized client IP.
 * @param profileId - Active profile identifier.
 * @param expiresAt - Expiration timestamp in epoch milliseconds.
 */
export function applySyncedActiveDnsConnection(
  ip: string,
  profileId: string,
  expiresAt: number
): void {
  if (!ip || !profileId || profileId === "default" || expiresAt <= Date.now()) {
    return;
  }
  const normalizedIp = normalizeActiveDnsIp(ip);
  if (!normalizedIp) {
    return;
  }
  const existing = activeDnsMemoryMap.get(normalizedIp);
  if (!existing || expiresAt >= existing.expiresAt) {
    activeDnsMemoryMap.set(normalizedIp, { profileId, expiresAt });
  }
}

function buildCanonicalActiveDnsUrl(normalizedIp: string): string {
  return `${CANONICAL_ACTIVE_DNS_ORIGIN}/__cache__/${encodeURIComponent(`active_dns:${normalizedIp}`)}`;
}

/**
 * Records an active DNS connection for a client IP (supporting DoH, DoT, and UDP transports).
 *
 * In Serverfull mode, records into an origin-independent in-memory LRU map and replicates via
 * cluster IPC when running with multiple workers. In Cloudflare Workers mode, stores under a
 * canonical cache origin so DoH and Dashboard subdomains always read the same key.
 *
 * @param cache - Optional Web Cache API instance.
 * @param rawClientIp - Client IP address.
 * @param profileId - Matched profile ID.
 * @param ttlSeconds - Activity TTL window in seconds.
 * @param isServerfull - Whether Serverfull mode is active.
 */
export async function recordActiveDnsConnection(
  cache: Cache | null | undefined,
  rawClientIp: string,
  profileId: string,
  ttlSeconds: number,
  isServerfull: boolean
): Promise<void> {
  const normalizedIp = normalizeActiveDnsIp(rawClientIp);
  if (!normalizedIp || !profileId || profileId === "default") {
    return;
  }

  const safeTtlSec = Math.max(1, Math.floor(ttlSeconds));
  const expiresAt = Date.now() + safeTtlSec * 1000;

  if (isServerfull) {
    activeDnsMemoryMap.set(normalizedIp, { profileId, expiresAt });
    syncPublisher?.(normalizedIp, profileId, expiresAt);
    return;
  }

  if (cache) {
    const response = new Response(JSON.stringify(profileId), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${safeTtlSec}`,
      },
    });
    await cache.put(buildCanonicalActiveDnsUrl(normalizedIp), response);
  }
}

/**
 * Looks up the currently active DNS profile ID for a client IP within the active TTL window.
 *
 * @param cache - Optional Web Cache API instance.
 * @param rawClientIp - Client IP address.
 * @param isServerfull - Whether Serverfull mode is active.
 * @returns Active profile ID or null when inactive/expired.
 */
export async function getActiveDnsConnection(
  cache: Cache | null | undefined,
  rawClientIp: string,
  isServerfull: boolean
): Promise<string | null> {
  const normalizedIp = normalizeActiveDnsIp(rawClientIp);
  if (!normalizedIp) {
    return null;
  }

  if (isServerfull) {
    const entry = activeDnsMemoryMap.get(normalizedIp);
    if (!entry) {
      return null;
    }
    if (Date.now() > entry.expiresAt) {
      activeDnsMemoryMap.delete(normalizedIp);
      return null;
    }
    return entry.profileId;
  }

  if (cache) {
    const canonicalHit = await cache.match(buildCanonicalActiveDnsUrl(normalizedIp));
    if (canonicalHit) {
      return (await canonicalHit.json()) as string;
    }
    return cacheUtils.get<string>(cache, `active_dns:${normalizedIp}`);
  }

  return null;
}

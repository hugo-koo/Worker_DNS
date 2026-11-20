import { Env } from '../types';
import { getPresetEchFrontingDomains } from '../utils/ech/constants';
import { fetchGeoIP } from '../utils/geoip';
import { isPublicInternetIP } from '../utils/validator';
import {
  DEFAULT_SUBSTITUTE_DOMAIN,
  getPresetUpstreams,
  getPresetExternalFilters
} from '../constants/presets';
import { detectServerfullMode } from '../router/runtimeConfig';
import { getActiveDnsConnection } from '../lib/activeDns';
import {
  buildDemoClientInfoPayload,
  getDemoGeoIpPayload,
  getDemoResolvePayload,
  getDemoSubstitutePayload,
  isDemoMode,
} from '../lib/demoConfig';

/**
 * Handles system/utility routes like /api/clientinfo and /api/substitute
 */
export async function handleSystemRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const cache = typeof caches !== 'undefined' ? (caches as any).default : null;

  if (url.pathname === '/api/clientinfo') {
    const isServerfull = detectServerfullMode(env);
    const demoMode = isDemoMode(env);
    if (demoMode) {
      let connectedDemoProfileId: string | null = null;
      if (env.DB) {
        try {
          const row = await env.DB.prepare("SELECT id FROM profiles ORDER BY created_at DESC LIMIT 1")
            .first<{ id: string }>();
          connectedDemoProfileId = row?.id || null;
        } catch {
          // Ignore optional demo lookup errors
        }
      }
      return new Response(
        JSON.stringify(
          buildDemoClientInfoPayload(env, {
            isServerfull,
            connectedProfileId: connectedDemoProfileId,
          })
        ),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    const clientIp = request.headers.get("CF-Connecting-IP") || "127.0.0.1";
    const connectedProfileId = await getActiveDnsConnection(cache, clientIp, isServerfull);
    const cf = (request as { cf?: Record<string, unknown> }).cf;

    const isKnownGeoCode = (val?: string): boolean => {
      if (!val) return false;
      const upper = val.trim().toUpperCase();
      return Boolean(upper && upper !== "UNKNOWN" && upper !== "UN" && upper !== "XX" && upper !== "T1");
    };

    const strOrEmpty = (val: unknown): string => (typeof val === "string" ? val.trim() : "");

    let country = "";
    let countryCode = "";
    let region = "";
    let city = "";
    let timezone = "";
    let asn = 0;
    let asOrganization = "";

    const resolveViaGeoIP = async (): Promise<void> => {
      try {
        const geo = await fetchGeoIP(clientIp);
        if (!geo) return;
        country = geo.country || geo.country_code || "UNKNOWN";
        countryCode = geo.country_code || "UNKNOWN";
        region = geo.region || "UNKNOWN";
        city = geo.city || "UNKNOWN";
        timezone = geo.timezone || "UNKNOWN";
        asOrganization = geo.org || geo.isp || "UNKNOWN";
        if (!asn && geo.as) {
          const asnMatch = geo.as.match(/^AS(\d+)/i);
          if (asnMatch) asn = Number(asnMatch[1]);
        }
      } catch (e) {
        console.warn(`[ClientInfo] Failed resolving geoip for ${clientIp}:`, e);
      }
    };

    if (!isPublicInternetIP(clientIp)) {
      country = "Private Network";
      countryCode = "LAN";
      region = "LAN";
      city = "Local";
      timezone = "UNKNOWN";
      asOrganization = "Private Network";
    } else if (cf && !isServerfull) {
      // In Cloudflare Workers edge runtime, request.cf is guaranteed to match CF-Connecting-IP.
      country = strOrEmpty(cf.country);
      countryCode = country;
      region = strOrEmpty(cf.region);
      city = strOrEmpty(cf.city);
      timezone = strOrEmpty(cf.timezone);
      asn = cf.asn ? Number(cf.asn) : 0;
      asOrganization = strOrEmpty(cf.asOrganization);

      if (!isKnownGeoCode(country)) {
        await resolveViaGeoIP();
      }
    } else {
      // In Serverfull mode, always derive location authoritatively from the resolved clientIp
      // so Current Location strictly matches Egress IP Address regardless of proxy CF-* headers.
      await resolveViaGeoIP();

      // Only fall back to proxy-provided CF-* headers if GeoIP lookup failed completely.
      if (!isKnownGeoCode(country)) {
        const headerCountry = strOrEmpty(request.headers.get("CF-IPCountry"));
        if (isKnownGeoCode(headerCountry)) {
          country = headerCountry;
          countryCode = headerCountry;
        }
        region = region || strOrEmpty(request.headers.get("CF-Region"));
        city = city || strOrEmpty(request.headers.get("CF-IPCity"));
        timezone = timezone || strOrEmpty(request.headers.get("CF-Timezone"));
        if (!asn && request.headers.get("CF-ASN")) {
          asn = Number(request.headers.get("CF-ASN")) || 0;
        }
        asOrganization = asOrganization || strOrEmpty(request.headers.get("CF-AS-Org"));
      }
    }

    return new Response(JSON.stringify({
      ip: clientIp,
      country: country || "UNKNOWN",
      countryCode: countryCode || undefined,
      region: region || "UNKNOWN",
      city: city || "UNKNOWN",
      timezone: timezone || "UNKNOWN",
      asn: asn || 0,
      asOrganization: asOrganization || "UNKNOWN",
      connectedProfileId: connectedProfileId || null,
      substituteDomain: env.SUBSTITUTE_DOMAIN || DEFAULT_SUBSTITUTE_DOMAIN,
      dotDomain: env.SERVERFULL_DOT_DOMAIN || env.DOT_DOMAIN || null,
      isServerfull,
      mode: isServerfull ? 'serverfull' : 'cloudflare'
    }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (url.pathname === '/api/substitute') {
    if (isDemoMode(env)) {
      return new Response(JSON.stringify(getDemoSubstitutePayload()), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const subDomain = env.SUBSTITUTE_DOMAIN || DEFAULT_SUBSTITUTE_DOMAIN;
    let substituteDomainIp: string | null = null;
    let substituteDomainIpv6: string | null = null;

    const resolveRecord = async (type: 'A' | 'AAAA'): Promise<string | null> => {
      const dnsServers = [
        'https://cloudflare-dns.com/dns-query',
        'https://1.1.1.1/dns-query'
      ];
      for (const server of dnsServers) {
        try {
          const res = await fetch(`${server}?name=${subDomain}&type=${type}`, {
            headers: { 'Accept': 'application/dns-json' },
            signal: AbortSignal.timeout(3000)
          });
          if (res.ok) {
            const data = await res.json() as any;
            if (data?.Answer?.length > 0) {
              const record = data.Answer.find((a: any) => a.type === (type === 'A' ? 1 : 28));
              if (record?.data) {
                return record.data;
              }
            }
          }
        } catch (e) {
          console.error(`[Substitute Resolve] Failed resolving ${type} via ${server}:`, e);
        }
      }
      return null;
    };

    try {
      const [ip, ipv6] = await Promise.all([
        resolveRecord('A'),
        resolveRecord('AAAA')
      ]);
      substituteDomainIp = ip;
      substituteDomainIpv6 = ipv6;
    } catch (e) {
      console.error('[Substitute API] Error resolving substitute domain:', e);
    }

    return new Response(JSON.stringify({
      ip: substituteDomainIp,
      ipv6: substituteDomainIpv6
    }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (url.pathname === '/api/presets/upstreams') {
    const upstreams = getPresetUpstreams(env);
    return new Response(JSON.stringify(upstreams), { headers: { 'Content-Type': 'application/json' } });
  }

  if (url.pathname === '/api/presets/filters') {
    const filters = getPresetExternalFilters(env);
    return new Response(JSON.stringify(filters), { headers: { 'Content-Type': 'application/json' } });
  }

  if (url.pathname === '/api/presets/ech-fronting-domains') {
    const domains = getPresetEchFrontingDomains(env);
    return new Response(JSON.stringify(domains), { headers: { 'Content-Type': 'application/json' } });
  }

  if (url.pathname.startsWith('/api/icon/')) {
    const domain = url.pathname.replace('/api/icon/', '');
    if (!domain || !/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(domain) || domain.includes('..') || domain.includes('/') || domain.includes('\\')) {
      return new Response("Invalid domain format", { status: 400 });
    }
    
    // Proxy request to DuckDuckGo
    const targetUrl = `https://icons.duckduckgo.com/ip3/${domain}`;
    try {
      const iconRes = await fetch(targetUrl);
      
      const newHeaders = new Headers(iconRes.headers);
      newHeaders.set('Cache-Control', 'public, max-age=2592000'); // 30 days
      newHeaders.delete('Access-Control-Allow-Origin'); // Ensure no upstream wildcard bleeds through
      
      return new Response(iconRes.body, {
        status: iconRes.status,
        statusText: iconRes.statusText,
        headers: newHeaders
      });
    } catch (e) {
      return new Response("Error fetching icon", { status: 500 });
    }
  }

  if (url.pathname === '/api/geoip') {
    const rawIp = url.searchParams.get('ip');
    if (isDemoMode(env)) {
      return new Response(JSON.stringify(getDemoGeoIpPayload(rawIp || undefined)), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    const connectingIp = request.headers.get("CF-Connecting-IP");
    const targetIp = (rawIp || connectingIp || "").trim();

    // Reject non-public / private / malformed IP targets before calling external GeoIP API
    if (targetIp && !isPublicInternetIP(targetIp)) {
      return new Response(JSON.stringify({
        success: true,
        ip: targetIp,
        city: 'Local',
        country: 'Private Network',
        flag: { emoji: '🛜' }
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    try {
      if (targetIp) {
        const geo = await fetchGeoIP(targetIp);
        if (geo) {
          return new Response(JSON.stringify({
            success: true,
            ip: targetIp,
            country: geo.country || geo.country_code,
            country_code: geo.country_code,
            region: geo.region || "",
            city: geo.city || "",
            timezone: geo.timezone ? { id: geo.timezone } : undefined,
            connection: (geo.org || geo.isp) ? { org: geo.org || geo.isp } : undefined
          }), { headers: { 'Content-Type': 'application/json' } });
        }
      }

      // If no target IP was determined, query without IP parameter so ipwho.is resolves the caller's / server's public egress IP.
      const geoUrl = targetIp ? `https://ipwho.is/${encodeURIComponent(targetIp)}` : 'https://ipwho.is/';
      const geoRes = await fetch(geoUrl, {
        signal: AbortSignal.timeout(3500)
      });
      if (geoRes.ok) {
        const data = await geoRes.json();
        return new Response(JSON.stringify(data), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
    } catch (e) {
      console.warn(`[System API] Failed resolving geoip for ${targetIp || 'server'}:`, e);
    }
    return new Response(JSON.stringify({ success: false, ip: targetIp || 'unknown' }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (url.pathname === '/api/resolve') {
    if (isDemoMode(env)) {
      return new Response(JSON.stringify(getDemoResolvePayload()), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const domain = url.searchParams.get('name') || url.searchParams.get('domain');
    if (!domain) {
      return new Response(JSON.stringify({ error: "Missing domain parameter" }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Direct IPv4 check
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(domain)) {
      return new Response(JSON.stringify({ ipv4: [domain], ipv6: [] }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Direct IPv6 check
    if (/^([0-9a-fA-F]{0,4}:){1,7}[0-9a-fA-F]{0,4}$/.test(domain)) {
      return new Response(JSON.stringify({ ipv4: [], ipv6: [domain] }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const resolveDoH = async (type: 'A' | 'AAAA'): Promise<string[]> => {
      const servers = ['https://cloudflare-dns.com/dns-query', 'https://1.1.1.1/dns-query'];
      for (const s of servers) {
        try {
          const res = await fetch(`${s}?name=${encodeURIComponent(domain)}&type=${type}`, {
            headers: { Accept: 'application/dns-json' },
            signal: AbortSignal.timeout(3000)
          });
          if (res.ok) {
            const data = (await res.json()) as { Answer?: Array<{ type: number; data: string }> };
            if (Array.isArray(data?.Answer) && data.Answer.length > 0) {
              const typeNum = type === 'A' ? 1 : 28;
              return data.Answer
                .filter((ans) => ans.type === typeNum && typeof ans.data === 'string')
                .map((ans) => ans.data);
            }
          }
        } catch {
          // Continue to next server
        }
      }
      return [];
    };

    try {
      const [ipv4, ipv6] = await Promise.all([
        resolveDoH('A'),
        resolveDoH('AAAA')
      ]);

      return new Response(JSON.stringify({
        ipv4: ipv4.filter((ip) => isPublicInternetIP(ip)),
        ipv6: ipv6.filter((ip) => isPublicInternetIP(ip)),
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (e) {
      console.error('DNS resolve failed:', e);
      return new Response(JSON.stringify({ ipv4: [], ipv6: [], error: 'Internal server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  return new Response("Not Found", { status: 404 });
}

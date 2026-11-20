import { DEFAULT_SUBSTITUTE_DOMAIN } from "../constants/presets";
import type { AccessPointDeviceType } from "../constants/deviceTypes";
import type { Env, ListMetadataStats } from "../types";

/** Default domain displayed across UI endpoints and instructions when demo mode is active. */
export const DEFAULT_DEMO_DOMAIN = "dns.worker.domain";

/** Canonical demo client identity & location telemetry (Single Source of Truth). */
export interface DemoClientInfoDefaults {
  ip: string;
  country: string;
  countryCode: string;
  region: string;
  city: string;
  timezone: string;
  asn: number;
  asOrganization: string;
}

export const DEMO_CLIENT_INFO: Readonly<DemoClientInfoDefaults> = {
  ip: "203.0.113.42",
  country: "Japan",
  countryCode: "JP",
  region: "Tokyo",
  city: "Tokyo",
  timezone: "Asia/Tokyo",
  asn: 13335,
  asOrganization: "Cloudflare, Inc.",
};

/** Canonical demo substitute domain IPs returned by `/api/substitute` & `/api/resolve`. */
export const DEMO_SUBSTITUTE_IPS: Readonly<{
  ipv4: readonly string[];
  ipv6: readonly string[];
}> = {
  ipv4: ["198.51.100.10", "198.51.100.20"],
  ipv6: ["2001:db8::53", "2001:db8::54"],
};

export interface DemoAccessPointSpec {
  name: string;
  targetProfileRole: "primary" | "office" | "kids" | "unbound";
  deviceType: AccessPointDeviceType;
}

/** Canonical demo Access Point devices across desktop, mobile, tablet, router, NAS, TV, and browser. */
export const DEMO_ACCESS_POINT_SPECS: readonly DemoAccessPointSpec[] = [
  { name: "OpenWrt-Router", targetProfileRole: "primary", deviceType: "openwrt" },
  { name: "MacBook-Pro", targetProfileRole: "primary", deviceType: "macos" },
  { name: "TrueNAS-NAS", targetProfileRole: "office", deviceType: "nas" },
  { name: "Windows-11-Desktop", targetProfileRole: "primary", deviceType: "windows" },
  { name: "iPhone-16", targetProfileRole: "primary", deviceType: "ios" },
  { name: "Pixel-9-Android", targetProfileRole: "primary", deviceType: "android" },
  { name: "Linux-Workstation", targetProfileRole: "office", deviceType: "linux" },
  { name: "Chrome-Browser-Work", targetProfileRole: "office", deviceType: "chrome" },
  { name: "Kids-iPad", targetProfileRole: "kids", deviceType: "ios" },
  { name: "Smart-TV-LivingRoom", targetProfileRole: "unbound", deviceType: "android_tv" },
];

export interface DemoRuleSpec {
  type: "ALLOW" | "BLOCK" | "REDIRECT";
  pattern: string;
  include_subdomains: boolean;
  v_a?: string | null;
  v_aaaa?: string | null;
  v_cname?: string | null;
  v_txt?: string | null;
}

/** Primary demo Custom Rules seeded for the main Profile. */
export const DEMO_PRIMARY_RULES: readonly DemoRuleSpec[] = [
  { type: "BLOCK", pattern: "metrics.icloud-tracker.example", include_subdomains: true },
  { type: "BLOCK", pattern: "ads-sdk.mobile-analytics.example", include_subdomains: true },
  { type: "BLOCK", pattern: "pixel.ad-exchange.example", include_subdomains: false },
  { type: "BLOCK", pattern: "telemetry.smarttv-vendor.example", include_subdomains: true },
  { type: "ALLOW", pattern: "api.github.com", include_subdomains: false },
  { type: "ALLOW", pattern: "cdn.jsdelivr.net", include_subdomains: false },
  { type: "ALLOW", pattern: "ocsp.digicert.com", include_subdomains: false },
  { type: "REDIRECT", pattern: "nas.home.lan", include_subdomains: false, v_a: "192.168.10.50", v_aaaa: "fd00:10::50" },
  { type: "REDIRECT", pattern: "router.home.lan", include_subdomains: false, v_a: "192.168.10.1" },
  { type: "REDIRECT", pattern: "docs.internal.lan", include_subdomains: false, v_cname: `portal.${DEFAULT_DEMO_DOMAIN}` },
  { type: "REDIRECT", pattern: `status.${DEFAULT_DEMO_DOMAIN}`, include_subdomains: false, v_txt: "v=demo1 profile=default" },
];

/** Demo Custom Rules seeded for the Kids Safe companion Profile. */
export const DEMO_KIDS_RULES: readonly DemoRuleSpec[] = [
  { type: "BLOCK", pattern: "gaming-ads.example", include_subdomains: true },
  { type: "ALLOW", pattern: "khanacademy.org", include_subdomains: true },
  { type: "ALLOW", pattern: "wikipedia.org", include_subdomains: true },
];

export interface DemoListSpec {
  url: string;
  enabled: boolean;
  stats: ListMetadataStats;
}

/** Demo External Blocklist subscriptions and pre-synced statistics. */
export const DEMO_EXTERNAL_LISTS: readonly DemoListSpec[] = [
  {
    url: "https://big.oisd.nl",
    enabled: true,
    stats: {
      total_rules: 342810,
      exact_rules: 12410,
      subdomain_rules: 329980,
      wildcard_rules: 0,
      regex_rules: 0,
      exception_rules: 420,
      rewrite_rules: 0,
      comment_lines: 1850,
      unsupported_lines: 0,
      total_bytes: 7824190,
    },
  },
  {
    url: "https://adguardteam.github.io/HostlistsRegistry/assets/filter_1.txt",
    enabled: true,
    stats: {
      total_rules: 98420,
      exact_rules: 4120,
      subdomain_rules: 93800,
      wildcard_rules: 0,
      regex_rules: 12,
      exception_rules: 310,
      rewrite_rules: 178,
      comment_lines: 640,
      unsupported_lines: 0,
      total_bytes: 2145300,
    },
  },
  {
    url: "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/pro.plus.txt",
    enabled: true,
    stats: {
      total_rules: 412650,
      exact_rules: 8300,
      subdomain_rules: 403950,
      wildcard_rules: 0,
      regex_rules: 0,
      exception_rules: 400,
      rewrite_rules: 0,
      comment_lines: 1220,
      unsupported_lines: 0,
      total_bytes: 9412800,
    },
  },
  {
    url: "https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts",
    enabled: false,
    stats: {
      total_rules: 158900,
      exact_rules: 158900,
      subdomain_rules: 0,
      wildcard_rules: 0,
      regex_rules: 0,
      exception_rules: 0,
      rewrite_rules: 0,
      comment_lines: 980,
      unsupported_lines: 0,
      total_bytes: 4920100,
    },
  },
];

export interface DemoTrafficTemplate {
  domain: string;
  recordType: string;
  action: "PASS" | "BLOCK" | "REDIRECT";
  reason: string;
  answer: string;
  destCode: string;
  destCountry: string;
  destCity: string;
  destRegion: string;
  destIsp: string;
  destAsn: string;
  latencyMs: number;
}

/** Sample DNS resolution log templates across PASS, BLOCK, and REDIRECT decisions. */
export const DEMO_TRAFFIC_TEMPLATES: readonly DemoTrafficTemplate[] = [
  {
    domain: "api.github.com",
    recordType: "A",
    action: "PASS",
    reason: "Custom Rule (ALLOW)",
    answer: "140.82.121.6",
    destCode: "US",
    destCountry: "United States",
    destCity: "San Francisco",
    destRegion: "California",
    destIsp: "GitHub, Inc.",
    destAsn: "AS36459 GitHub, Inc.",
    latencyMs: 9,
  },
  {
    domain: "cloudflare.com",
    recordType: "HTTPS",
    action: "PASS",
    reason: "Upstream Resolved",
    answer: "104.16.132.229",
    destCode: "US",
    destCountry: "United States",
    destCity: "San Jose",
    destRegion: "California",
    destIsp: "Cloudflare, Inc.",
    destAsn: "AS13335 Cloudflare, Inc.",
    latencyMs: 4,
  },
  {
    domain: "cdn.jsdelivr.net",
    recordType: "A",
    action: "PASS",
    reason: "Custom Rule (ALLOW)",
    answer: "151.101.1.229",
    destCode: "JP",
    destCountry: "Japan",
    destCity: "Tokyo",
    destRegion: "Tokyo",
    destIsp: "Fastly, Inc.",
    destAsn: "AS54113 Fastly, Inc.",
    latencyMs: 6,
  },
  {
    domain: "www.google.com",
    recordType: "AAAA",
    action: "PASS",
    reason: "Upstream Resolved",
    answer: "2404:6800:4008:c02::6a",
    destCode: "SG",
    destCountry: "Singapore",
    destCity: "Singapore",
    destRegion: "Singapore",
    destIsp: "Google LLC",
    destAsn: "AS15169 Google LLC",
    latencyMs: 11,
  },
  {
    domain: "apple.com",
    recordType: "HTTPS",
    action: "PASS",
    reason: "Upstream Resolved",
    answer: "17.253.144.10",
    destCode: "US",
    destCountry: "United States",
    destCity: "Cupertino",
    destRegion: "California",
    destIsp: "Apple Inc.",
    destAsn: "AS714 Apple Inc.",
    latencyMs: 8,
  },
  {
    domain: "registry.npmjs.org",
    recordType: "A",
    action: "PASS",
    reason: "Upstream Resolved",
    answer: "104.16.25.34",
    destCode: "DE",
    destCountry: "Germany",
    destCity: "Frankfurt",
    destRegion: "Hesse",
    destIsp: "Cloudflare, Inc.",
    destAsn: "AS13335 Cloudflare, Inc.",
    latencyMs: 14,
  },
  {
    domain: "s3.amazonaws.com",
    recordType: "A",
    action: "PASS",
    reason: "Upstream Resolved",
    answer: "52.217.163.80",
    destCode: "US",
    destCountry: "United States",
    destCity: "Ashburn",
    destRegion: "Virginia",
    destIsp: "Amazon.com, Inc.",
    destAsn: "AS16509 Amazon.com, Inc.",
    latencyMs: 17,
  },
  {
    domain: "assets.ubuntu.com",
    recordType: "AAAA",
    action: "PASS",
    reason: "Upstream Resolved",
    answer: "2620:2d:4000:1::27",
    destCode: "GB",
    destCountry: "United Kingdom",
    destCity: "London",
    destRegion: "England",
    destIsp: "Canonical Group Limited",
    destAsn: "AS41231 Canonical Group Limited",
    latencyMs: 19,
  },
  {
    domain: "store.steampowered.com",
    recordType: "A",
    action: "PASS",
    reason: "Upstream Resolved",
    answer: "23.214.172.81",
    destCode: "CA",
    destCountry: "Canada",
    destCity: "Toronto",
    destRegion: "Ontario",
    destIsp: "Akamai Technologies, Inc.",
    destAsn: "AS20940 Akamai International B.V.",
    latencyMs: 13,
  },
  {
    domain: "ovhcloud.com",
    recordType: "A",
    action: "PASS",
    reason: "Upstream Resolved",
    answer: "198.27.92.1",
    destCode: "FR",
    destCountry: "France",
    destCity: "Paris",
    destRegion: "Ile-de-France",
    destIsp: "OVH SAS",
    destAsn: "AS16276 OVH SAS",
    latencyMs: 22,
  },
  {
    domain: "www.wto.org",
    recordType: "A",
    action: "PASS",
    reason: "Upstream Resolved",
    answer: "193.242.192.60",
    destCode: "NL",
    destCountry: "Netherlands",
    destCity: "Amsterdam",
    destRegion: "North Holland",
    destIsp: "Cloudflare, Inc.",
    destAsn: "AS13335 Cloudflare, Inc.",
    latencyMs: 12,
  },
  {
    domain: "metrics.icloud-tracker.example",
    recordType: "A",
    action: "BLOCK",
    reason: "Custom Rule (BLOCK)",
    answer: "0.0.0.0",
    destCode: "US",
    destCountry: "United States",
    destCity: "Ashburn",
    destRegion: "Virginia",
    destIsp: "Amazon.com, Inc.",
    destAsn: "AS16509 Amazon.com, Inc.",
    latencyMs: 2,
  },
  {
    domain: "ads-sdk.mobile-analytics.example",
    recordType: "HTTPS",
    action: "BLOCK",
    reason: "External List (oisd)",
    answer: "0.0.0.0",
    destCode: "US",
    destCountry: "United States",
    destCity: "San Jose",
    destRegion: "California",
    destIsp: "Google LLC",
    destAsn: "AS15169 Google LLC",
    latencyMs: 2,
  },
  {
    domain: "doubleclick-metrics.example",
    recordType: "A",
    action: "BLOCK",
    reason: "External List (hagezi)",
    answer: "0.0.0.0",
    destCode: "DE",
    destCountry: "Germany",
    destCity: "Nuremberg",
    destRegion: "Bavaria",
    destIsp: "Hetzner Online GmbH",
    destAsn: "AS24940 Hetzner Online GmbH",
    latencyMs: 3,
  },
  {
    domain: "telemetry.smarttv-vendor.example",
    recordType: "AAAA",
    action: "BLOCK",
    reason: "Custom Rule (BLOCK)",
    answer: "::",
    destCode: "JP",
    destCountry: "Japan",
    destCity: "Tokyo",
    destRegion: "Tokyo",
    destIsp: "Amazon Data Services Japan",
    destAsn: "AS16509 Amazon.com, Inc.",
    latencyMs: 2,
  },
  {
    domain: "nas.home.lan",
    recordType: "A",
    action: "REDIRECT",
    reason: "Custom Redirect",
    answer: "192.168.10.50",
    destCode: "",
    destCountry: "",
    destCity: "",
    destRegion: "",
    destIsp: "",
    destAsn: "",
    latencyMs: 1,
  },
  {
    domain: "docs.internal.lan",
    recordType: "CNAME",
    action: "REDIRECT",
    reason: "Custom Redirect",
    answer: `portal.${DEFAULT_DEMO_DOMAIN}`,
    destCode: "",
    destCountry: "",
    destCity: "",
    destRegion: "",
    destIsp: "",
    destAsn: "",
    latencyMs: 1,
  },
];

export interface DemoClientProfile {
  apName: string;
  clientIp: string;
  geoCountry: string;
}

/** Simulated client IP & GeoIP pool mapped to primary demo Access Points. */
export const DEMO_CLIENT_POOL: readonly DemoClientProfile[] = [
  { apName: "MacBook-Pro", clientIp: "203.0.113.10", geoCountry: "JP" },
  { apName: "Windows-11-Desktop", clientIp: "203.0.113.18", geoCountry: "US" },
  { apName: "iPhone-16", clientIp: "203.0.113.24", geoCountry: "JP" },
  { apName: "Pixel-9-Android", clientIp: "198.51.100.88", geoCountry: "SG" },
  { apName: "OpenWrt-Router", clientIp: "2001:db8::42", geoCountry: "US" },
  { apName: "TrueNAS-NAS", clientIp: "198.51.100.120", geoCountry: "DE" },
];

export interface DemoClientInfoPayload extends DemoClientInfoDefaults {
  connectedProfileId: string | null;
  substituteDomain: string;
  dotDomain: string;
  isServerfull: boolean;
  mode: "serverfull" | "cloudflare";
  isDemoMode: true;
  demoDomain: string;
}

export interface DemoSubstitutePayload {
  ip: string | null;
  ipv6: string | null;
  ipv4List: string[];
  ipv6List: string[];
}

export interface DemoGeoIpPayload {
  success: true;
  ip: string;
  country: string;
  country_code: string;
  region: string;
  city: string;
  timezone: { id: string };
  connection: { org: string };
}

/**
 * Checks whether Demo Mode is enabled via environment configuration (`DEMO_MODE`).
 *
 * @param env - Worker or Serverfull environment bindings.
 * @returns True if demo mode is enabled.
 */
export function isDemoMode(env?: Partial<Env>): boolean {
  const raw = env?.DEMO_MODE;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw === 1;
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
  }
  return false;
}

/**
 * Resolves the canonical hostname displayed throughout Demo Mode endpoints and instructions.
 *
 * @param env - Worker or Serverfull environment bindings.
 * @returns Sanitized demo hostname (defaults to `dns.worker.domain`).
 */
export function getDemoDomain(env?: Partial<Env>): string {
  const raw = (env?.DEMO_DOMAIN ?? "").toString().trim();
  if (!raw) return DEFAULT_DEMO_DOMAIN;
  return raw.replace(/^https?:\/\//i, "").replace(/\/+$/, "") || DEFAULT_DEMO_DOMAIN;
}

/**
 * Builds the canonical `/api/clientinfo` response object for Demo Mode from `DEMO_CLIENT_INFO`.
 *
 * @param env - Worker or Serverfull environment bindings.
 * @param options - Runtime mode metadata and active connected Profile ID.
 * @returns Structured `/api/clientinfo` JSON payload.
 */
export function buildDemoClientInfoPayload(
  env: Partial<Env>,
  options: { isServerfull: boolean; connectedProfileId: string | null }
): DemoClientInfoPayload {
  const demoDomain = getDemoDomain(env);
  return {
    ...DEMO_CLIENT_INFO,
    connectedProfileId: options.connectedProfileId,
    substituteDomain: env.SUBSTITUTE_DOMAIN || DEFAULT_SUBSTITUTE_DOMAIN,
    dotDomain: demoDomain,
    isServerfull: options.isServerfull,
    mode: options.isServerfull ? "serverfull" : "cloudflare",
    isDemoMode: true,
    demoDomain,
  };
}

/**
 * Builds the canonical `/api/substitute` response object for Demo Mode from `DEMO_SUBSTITUTE_IPS`.
 */
export function getDemoSubstitutePayload(): DemoSubstitutePayload {
  return {
    ip: DEMO_SUBSTITUTE_IPS.ipv4[0] ?? null,
    ipv6: DEMO_SUBSTITUTE_IPS.ipv6[0] ?? null,
    ipv4List: [...DEMO_SUBSTITUTE_IPS.ipv4],
    ipv6List: [...DEMO_SUBSTITUTE_IPS.ipv6],
  };
}

/**
 * Builds the canonical `/api/geoip` response object for Demo Mode from `DEMO_CLIENT_INFO`.
 */
export function getDemoGeoIpPayload(ip?: string): DemoGeoIpPayload {
  return {
    success: true,
    ip: ip?.trim() || DEMO_CLIENT_INFO.ip,
    country: DEMO_CLIENT_INFO.country,
    country_code: DEMO_CLIENT_INFO.countryCode,
    region: DEMO_CLIENT_INFO.region,
    city: DEMO_CLIENT_INFO.city,
    timezone: { id: DEMO_CLIENT_INFO.timezone },
    connection: { org: DEMO_CLIENT_INFO.asOrganization },
  };
}

/**
 * Builds the canonical `/api/resolve` response object for Demo Mode from `DEMO_SUBSTITUTE_IPS`.
 */
export function getDemoResolvePayload(): { ipv4: string[]; ipv6: string[] } {
  return {
    ipv4: [...DEMO_SUBSTITUTE_IPS.ipv4],
    ipv6: [...DEMO_SUBSTITUTE_IPS.ipv6],
  };
}

export interface DemoAnalyticsQueryOptions {
  profileId: string;
  range: string | null;
  since: number;
  until: number;
  accessPointId?: string;
  demoDomain?: string;
}

export interface DemoAnalyticsResultPayload {
  summary: { action: string; count: number }[];
  trend: { timestamp: number; action: string; count: number }[];
  top_allowed: { domain: string; count: number }[];
  top_blocked: { domain: string; count: number }[];
  clients: { client_ip: string; geo_country: string | null; count: number }[];
  destinations: { country_code: string; country: string; count: number }[];
}

function hashSeedString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function resolveDemoAnalyticsBucketSec(range: string | null): number {
  switch (range) {
    case "10m":
    case "1h":
      return 60;
    case "7d":
    case "30d":
      return 86400;
    case "24h":
    case "custom":
    default:
      return range === null ? 60 : 3600;
  }
}

function distributeByWeight<T>(items: readonly T[], total: number, weights: readonly number[]): number[] {
  if (items.length === 0 || total <= 0) return items.map(() => 0);
  const weightSum = weights.reduce((acc, w) => acc + w, 0) || items.length;
  const counts = items.map((_, i) => Math.floor((total * (weights[i] ?? 1)) / weightSum));
  let assigned = counts.reduce((acc, c) => acc + c, 0);
  let idx = 0;
  while (assigned < total) {
    counts[idx % counts.length] += 1;
    assigned += 1;
    idx += 1;
  }
  return counts;
}

/**
 * Dynamically generates continuous, mathematically consistent Demo Mode `/stats` analytics
 * for any requested time range (`10m`, `1h`, `24h`, `7d`, `30d`, or arbitrary `custom` range),
 * profile, or Access Point filter from the canonical `demoConfig` fixtures.
 *
 * @param options - Requested analytics window, profile, and optional device filter.
 * @returns Complete dashboard analytics dataset matching `/api/profiles/:id/analytics`.
 */
export function buildDemoAnalyticsPayload(
  options: DemoAnalyticsQueryOptions
): DemoAnalyticsResultPayload {
  const safeUntil = Number.isFinite(options.until) ? Math.floor(options.until) : Math.floor(Date.now() / 1000);
  const safeSince = Number.isFinite(options.since)
    ? Math.min(Math.floor(options.since), safeUntil)
    : safeUntil - 3600;
  const bucketSec = resolveDemoAnalyticsBucketSec(options.range);
  const baseSeed = hashSeedString(`${options.profileId}|${options.accessPointId || "all"}`);
  const apScale = options.accessPointId ? 0.3 : 1;

  const startBucket = Math.floor(safeSince / bucketSec) * bucketSec;
  const endBucket = Math.max(startBucket, Math.floor(safeUntil / bucketSec) * bucketSec);
  const totalSpanBuckets = Math.floor((endBucket - startBucket) / bucketSec) + 1;
  const maxRenderedBuckets = 744; // Up to 31 full days at hourly granularity
  const stepMultiplier = totalSpanBuckets > maxRenderedBuckets ? Math.ceil(totalSpanBuckets / maxRenderedBuckets) : 1;
  const effectiveStep = bucketSec * stepMultiplier;

  const passScale = bucketSec >= 86400 ? 3200 : bucketSec >= 3600 ? 150 : 6;
  const blockScale = bucketSec >= 86400 ? 950 : bucketSec >= 3600 ? 45 : 2;
  const redirectScale = bucketSec >= 86400 ? 320 : bucketSec >= 3600 ? 15 : 1;

  const trend: { timestamp: number; action: string; count: number }[] = [];
  let totalPass = 0;
  let totalBlock = 0;
  let totalRedirect = 0;

  for (let ts = startBucket, idx = 0; ts <= endBucket; ts += effectiveStep, idx++) {
    const wave = 0.72 + 0.48 * (0.5 + 0.5 * Math.sin(idx * 0.55 + (baseSeed % 11)));
    const jitter = ((hashSeedString(`${baseSeed}:${ts}`) % 37) - 18) / 100;
    const factor = Math.max(0.35, (wave + jitter) * apScale * stepMultiplier);

    const passCount = Math.max(2, Math.round(passScale * factor));
    const blockCount = Math.max(1, Math.round(blockScale * factor));
    const redirectCount = Math.max(idx % 3 === 0 ? 1 : 0, Math.round(redirectScale * factor * 0.85));

    totalPass += passCount;
    totalBlock += blockCount;
    totalRedirect += redirectCount;

    trend.push({ timestamp: ts, action: "PASS", count: passCount });
    trend.push({ timestamp: ts, action: "BLOCK", count: blockCount });
    if (redirectCount > 0) {
      trend.push({ timestamp: ts, action: "REDIRECT", count: redirectCount });
    }
  }

  const summary = [
    { action: "PASS", count: totalPass },
    { action: "BLOCK", count: totalBlock },
    { action: "REDIRECT", count: totalRedirect },
  ];

  const passTemplates = DEMO_TRAFFIC_TEMPLATES.filter((t) => t.action === "PASS");
  const blockTemplates = DEMO_TRAFFIC_TEMPLATES.filter((t) => t.action === "BLOCK");
  const passWeights = passTemplates.map((_, i) => Math.max(2, passTemplates.length + 2 - i));
  const blockWeights = blockTemplates.map((_, i) => Math.max(2, blockTemplates.length + 2 - i));

  const passCounts = distributeByWeight(passTemplates, totalPass, passWeights);
  const blockCounts = distributeByWeight(blockTemplates, totalBlock, blockWeights);

  const demoDomain = options.demoDomain?.trim() || DEFAULT_DEMO_DOMAIN;
  const top_allowed = passTemplates
    .map((tpl, i) => ({
      domain: tpl.domain.replace(DEFAULT_DEMO_DOMAIN, demoDomain),
      count: passCounts[i] || 0,
    }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const top_blocked = blockTemplates
    .map((tpl, i) => ({
      domain: tpl.domain.replace(DEFAULT_DEMO_DOMAIN, demoDomain),
      count: blockCounts[i] || 0,
    }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const totalQueries = totalPass + totalBlock + totalRedirect;
  const clientPool = options.accessPointId
    ? [DEMO_CLIENT_POOL[baseSeed % DEMO_CLIENT_POOL.length]]
    : DEMO_CLIENT_POOL;
  const clientWeights = clientPool.map((_, i) => Math.max(1, clientPool.length - i));
  const clientCounts = distributeByWeight(clientPool, totalQueries, clientWeights);

  const clients = clientPool
    .map((client, i) => ({
      client_ip: client.clientIp,
      geo_country: client.geoCountry,
      count: clientCounts[i] || 0,
    }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count);

  const destAggregate = new Map<string, { country_code: string; country: string; count: number }>();
  const geoTemplates = DEMO_TRAFFIC_TEMPLATES.filter((t) => Boolean(t.destCode));
  const geoCounts = distributeByWeight(
    geoTemplates,
    totalPass + totalBlock,
    geoTemplates.map((_, i) => Math.max(1, geoTemplates.length - i))
  );
  geoTemplates.forEach((tpl, i) => {
    const c = geoCounts[i] || 0;
    if (c <= 0) return;
    const prev = destAggregate.get(tpl.destCode);
    if (prev) {
      prev.count += c;
    } else {
      destAggregate.set(tpl.destCode, {
        country_code: tpl.destCode,
        country: tpl.destCountry,
        count: c,
      });
    }
  });

  const destinations = Array.from(destAggregate.values()).sort((a, b) => b.count - a.count);

  return {
    summary,
    trend,
    top_allowed,
    top_blocked,
    clients,
    destinations,
  };
}

/**
 * Builds country-level ISP distribution for `/api/profiles/:id/analytics/isps` in Demo Mode.
 *
 * @param options - Country filter, analytics window, and optional device/limit parameters.
 * @returns Array of ISP counts ordered descending.
 */
export function buildDemoAnalyticsIspsPayload(options: {
  countryCode?: string;
  profileId: string;
  range: string | null;
  since: number;
  until: number;
  accessPointId?: string;
  limit?: number;
}): { name: string; count: number }[] {
  const analytics = buildDemoAnalyticsPayload(options);
  const totalForCountry = options.countryCode
    ? analytics.destinations.find((d) => d.country_code.toUpperCase() === options.countryCode!.toUpperCase())?.count ||
      analytics.destinations[0]?.count ||
      50
    : analytics.summary.reduce((acc, s) => acc + s.count, 0);

  const upperCode = options.countryCode?.trim().toUpperCase();
  const matchingTemplates = DEMO_TRAFFIC_TEMPLATES.filter(
    (t) => Boolean(t.destIsp) && (!upperCode || t.destCode.toUpperCase() === upperCode)
  );
  const ispSource =
    matchingTemplates.length > 0
      ? matchingTemplates
      : DEMO_TRAFFIC_TEMPLATES.filter((t) => Boolean(t.destIsp));

  const uniqueIsps = Array.from(new Set(ispSource.map((t) => t.destIsp)));
  const weights = uniqueIsps.map((_, i) => Math.max(1, uniqueIsps.length - i));
  const counts = distributeByWeight(uniqueIsps, totalForCountry, weights);
  const cap = options.limit && options.limit > 0 ? options.limit : 20;

  return uniqueIsps
    .map((name, i) => ({ name, count: counts[i] || 0 }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, cap);
}

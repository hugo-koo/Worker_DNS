import { Env, ProfileSettings, Rule } from "../types";
import { BloomFilter } from "../utils/bloom";
import { cacheUtils } from "../utils/cache";
import { zeroizeBuffer } from "../utils/memory";
import { AdGuardProfileEngine, AdGuardPayload } from "../lib/adguard";
import { detectServerfullMode } from "../router/runtimeConfig";

export interface DnsCacheEntry {
  profileId: string;
  answer: Uint8Array;
  ttl: number;
  action: "PASS";
  reason?: string;
  expiresAt: number;
}

export interface ConfigCacheEntry {
  settings: ProfileSettings;
  rules: Rule[];
  timestamp: number;
  adguard?: AdGuardPayload | null;
  hasBloom?: boolean;
}

/**
 * 高性能、零依赖的容量受限 Map (LRU 淘汰策略)。
 * 利用 JavaScript Map 保证的“按插入顺序迭代”特性，在 O(1) 复杂度内自动淘汰最旧的数据。
 */
export class SizeCappedMap<K, V> extends Map<K, V> {
  constructor(
    private maxEntries: number,
    private readonly onEvict?: (value: V) => void
  ) {
    super();
  }

  /**
   * 动态调整容量上限。若缩容，主动淘汰超出配额的最旧记录。
   */
  setMaxEntries(max: number): void {
    this.maxEntries = Math.max(1, max);
    while (this.size > this.maxEntries) {
      const oldestKey = this.keys().next().value;
      if (oldestKey !== undefined) {
        this.delete(oldestKey);
      } else {
        break;
      }
    }
  }

  /**
   * 获取当前最大容量。
   */
  getMaxEntries(): number {
    return this.maxEntries;
  }

  override delete(key: K): boolean {
    const existing = super.get(key);
    const removed = super.delete(key);
    if (removed && existing !== undefined) {
      this.onEvict?.(existing);
    }
    return removed;
  }

  override clear(): void {
    if (this.onEvict) {
      for (const value of super.values()) {
        this.onEvict(value);
      }
    }
    super.clear();
  }

  override set(key: K, value: V): this {
    const previous = super.get(key);
    // 若键不存在且即将超出容量，淘汰最旧的记录 (第一项)
    if (previous === undefined && this.size >= this.maxEntries) {
      const oldestKey = this.keys().next().value;
      if (oldestKey !== undefined) {
        this.delete(oldestKey);
      }
    } else if (previous !== undefined && previous !== value) {
      this.onEvict?.(previous);
    }
    // 重新更新插入顺序，使其作为最近活跃项移到链表末尾
    super.delete(key);
    super.set(key, value);
    return this;
  }
}

// --- L1 Memory Cache (Isolate 全局，容量硬性限制) ---
// 布隆过滤器占用较大（每个 ~2.4MB），限制最多缓存 3 个 Profile，内存硬顶为 ~7.2MB，规避 GC 抖动崩溃
export const bloomMemoryMap = new SizeCappedMap<string, { bloom: BloomFilter; ts: number }>(3);

// 基础配置体积较小，允许缓存 200 个 Profile
export const configCache = new SizeCappedMap<string, ConfigCacheEntry>(200);

// AdGuard 扩展规则引擎内存缓存 (L1 内存缓存，限制最多 20 个 Profile)
export const adguardMemoryMap = new SizeCappedMap<string, { engine: AdGuardProfileEngine; ts: number }>(20);

/** 默认 DNS 缓存容量为 20,000 (20k) 条，统一适用于 Serverless 与 Serverfull 模式 */
export const DEFAULT_DNS_CACHE_SIZE = 20000;

/** Maximum Worker RAM dwell time (5 minutes) for cached DNS answers to minimize plaintext query residency. */
export const MAX_DNS_CACHE_TTL_SEC = 300;

// DNS 缓存默认容量 20k；淘汰或失效时立即清零响应报文缓冲区，键名采用摘要避免明文域名驻留 Map Key
export const dnsCache = new SizeCappedMap<string, DnsCacheEntry>(
  DEFAULT_DNS_CACHE_SIZE,
  (entry) => zeroizeBuffer(entry.answer)
);

let lastDnsSweepAt = 0;

/**
 * Computes an opaque SHA-256 digest key for the Worker in-memory DNS cache so
 * plaintext queried domain names are not retained as enumerable Map keys.
 */
export async function computeDnsCacheKey(
  profileId: string,
  domain: string,
  recordType: string
): Promise<string> {
  const raw = new TextEncoder().encode(`${profileId}\0${domain.toLowerCase()}\0${recordType}`);
  try {
    const digest = await crypto.subtle.digest("SHA-256", raw);
    const bytes = new Uint8Array(digest);
    let hex = "";
    for (let i = 0; i < bytes.length; i++) {
      hex += bytes[i].toString(16).padStart(2, "0");
    }
    return hex;
  } finally {
    zeroizeBuffer(raw);
  }
}

/**
 * Sweeps expired DNS cache entries from Worker memory and zeroes their answer buffers.
 */
export function sweepExpiredDnsCache(now: number = Date.now()): void {
  for (const [key, entry] of dnsCache.entries()) {
    if (!entry || now >= entry.expiresAt) {
      dnsCache.delete(key);
    }
  }
  lastDnsSweepAt = now;
}

/**
 * Retrieves an unexpired cached DNS entry, immediately deleting and scrubbing if expired.
 */
export function getCachedDnsEntry(cacheKey: string, now: number = Date.now()): DnsCacheEntry | null {
  const entry = dnsCache.get(cacheKey);
  if (!entry) return null;
  if (now >= entry.expiresAt || !(entry.answer instanceof Uint8Array)) {
    dnsCache.delete(cacheKey);
    return null;
  }
  return entry;
}

/**
 * Stores a DNS answer in Worker memory with bounded TTL and periodic expired-entry sweeping.
 */
export function setCachedDnsEntry(cacheKey: string, entry: DnsCacheEntry, now: number = Date.now()): void {
  if (now - lastDnsSweepAt >= 30_000) {
    sweepExpiredDnsCache(now);
  }
  dnsCache.set(cacheKey, {
    ...entry,
    answer: new Uint8Array(entry.answer),
  });
}

/**
 * 动态同步 DNS 缓存容量与运行时缓存上限。支持在 Serverless (Cloudflare Workers) 与 Serverfull (Node.js/Bun) 模式下统一生效。
 *
 * @param env 包含可选 DNS_CACHE_SIZE / BLOOM_CACHE_SIZE 配置项的环境变量集合
 */
export function syncDnsCacheSize(env?: Env): void {
  const configured = env?.DNS_CACHE_SIZE ?? (typeof process !== "undefined" ? process.env?.DNS_CACHE_SIZE : undefined);
  if (configured !== undefined && configured !== null && configured !== "") {
    const parsed = typeof configured === "number" ? configured : parseInt(String(configured), 10);
    if (!isNaN(parsed) && parsed > 0 && parsed !== dnsCache.getMaxEntries()) {
      dnsCache.setMaxEntries(parsed);
    }
  }

  const isServerfull = env ? detectServerfullMode(env) : false;
  const configuredBloom = env?.BLOOM_CACHE_SIZE ?? env?.SERVERFULL_BLOOM_CACHE_SIZE;
  let targetBloomMax = isServerfull ? 32 : 3;
  if (configuredBloom !== undefined && configuredBloom !== null && configuredBloom !== "") {
    const parsedBloom = typeof configuredBloom === "number" ? configuredBloom : parseInt(String(configuredBloom), 10);
    if (!isNaN(parsedBloom) && parsedBloom > 0) {
      targetBloomMax = parsedBloom;
    }
  }
  if (bloomMemoryMap.getMaxEntries() !== targetBloomMax) {
    bloomMemoryMap.setMaxEntries(targetBloomMax);
  }

  const targetConfigMax = isServerfull ? 500 : 200;
  if (configCache.getMaxEntries() !== targetConfigMax) {
    configCache.setMaxEntries(targetConfigMax);
  }
}

// Profile Key 到 Profile 元数据映射缓存 (L1 内存缓存，限制最多 500 个 Key)
export const profileKeyMemoryMap = new SizeCappedMap<string, { data: any; ts: number }>(500);

type ProfileKeyInvalidatePublisher = (profileKey: string) => void;
let profileKeyInvalidatePublisher: ProfileKeyInvalidatePublisher | null = null;

/**
 * Registers an IPC publisher to broadcast profile key cache invalidations across cluster workers.
 */
export function registerProfileKeyInvalidatePublisher(
  publisher: ProfileKeyInvalidatePublisher | null
): void {
  profileKeyInvalidatePublisher = publisher;
}

/**
 * Evicts a profile key / access point token from local L1 memory and notifies peer cluster workers.
 */
export function invalidateProfileKeyCache(profileKey: string, propagate = true): void {
  if (!profileKey) return;
  profileKeyMemoryMap.delete(profileKey);
  if (propagate) {
    profileKeyInvalidatePublisher?.(profileKey);
  }
}

// 默认 Profile 元数据内存缓存 (L1 内存缓存，5 分钟 TTL，防范 UDP DNS 高频穿透)
export let defaultProfileMemoryCache: { data: any; ts: number } | null = null;
export function setDefaultProfileMemoryCache(entry: { data: any; ts: number } | null): void {
  defaultProfileMemoryCache = entry;
}

/**
 * 通过 Cloudflare Zone Cache Purge API 全球按 Tag 主动失效缓存。
 * 需配置 CF_ZONE_ID 与 CF_PURGE_TOKEN (具备 Zone -> Cache Purge 权限)。
 * 若未配置或调用失败，仅记录日志，不阻断主业务流程。
 */
async function purgeTags(env: Env, tags: string[]): Promise<void> {
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/purge_cache`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CF_PURGE_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tags }),
    });
    if (!res.ok) {
      const errorText = await res.text();
      console.error(`[Cache] Global cache purge failed (HTTP ${res.status}):`, errorText);
    }
  } catch (e: any) {
    console.error("[Cache] Global cache purge error:", e?.message || e);
  }
}

export const PROFILE_CACHE_KEY_PREFIX = "profile_v8";

export const pipelineCache = {
  /**
   * 清理指定 Profile 的各级缓存。
   * 包含 L1 内存缓存、L2 本地数据中心 Cache API，以及 (若配置了 env) L2 全球边缘节点 Cache-Tag 失效。
   *
   * 签名支持多种重载形式，确保向后完全兼容：
   * - clear(profileId)
   * - clear(profileId, clearBloom)
   * - clear(profileId, env)
   * - clear(profileId, clearBloom, env)
   * - clear(profileId, env, clearBloom)
   */
  async clear(
    profileId: string,
    clearBloomOrEnv: boolean | Env = true,
    envOrClearBloom?: Env | boolean
  ): Promise<void> {
    let clearBloom = true;
    let targetEnv: Env | undefined;

    if (typeof clearBloomOrEnv === "boolean") {
      clearBloom = clearBloomOrEnv;
      if (envOrClearBloom && typeof envOrClearBloom === "object") {
        targetEnv = envOrClearBloom as Env;
      }
    } else if (clearBloomOrEnv && typeof clearBloomOrEnv === "object") {
      targetEnv = clearBloomOrEnv as Env;
      if (typeof envOrClearBloom === "boolean") {
        clearBloom = envOrClearBloom;
      }
    }

    // 清理 L1 (内存)
    configCache.delete(profileId);
    adguardMemoryMap.delete(profileId);
    if (clearBloom) {
      bloomMemoryMap.delete(profileId);
    }
    profileKeyMemoryMap.clear();
    defaultProfileMemoryCache = null;
    for (const [key, entry] of dnsCache.entries()) {
      if (entry.profileId === profileId || key.startsWith(`${profileId}:`)) {
        dnsCache.delete(key);
      }
    }
    
    // 清理 L2 (本地数据中心 Cache API)
    try {
      if (typeof caches !== "undefined" && caches && (caches as any).default) {
        const cache = (caches as any).default;
        const tasks: Promise<any>[] = [
          cacheUtils.delete(cache, `${PROFILE_CACHE_KEY_PREFIX}:${profileId}`),
          cacheUtils.delete(cache, `profile_v7:${profileId}`),
          cacheUtils.delete(cache, `profile_v6:${profileId}`)
        ];
        if (clearBloom) {
          tasks.push(cacheUtils.delete(cache, `bloom-bin:${profileId}`));
          // 防御性清理旧版硬编码 URL
          tasks.push(cache.delete(`https://dns-worker.local/bloom-bin/${profileId}`));
        }
        await Promise.all(tasks);
      }
    } catch (e) {
      console.error("Failed to clear cache API:", e);
    }

    // 清理 L2 全球边缘节点 (Cloudflare Zone Cache Purge by Tag)
    if (targetEnv && targetEnv.CF_ZONE_ID && targetEnv.CF_PURGE_TOKEN) {
      const tags = [`profile-${profileId}`];
      if (clearBloom) {
        tags.push(`bloom-${profileId}`);
      }
      await purgeTags(targetEnv, tags);
    }
  }
};

/**
 * @file test_memory_lifecycle.ts
 * @description Tests for minimal memory residency lifecycle: explicit buffer zeroization,
 * Worker DNS cache key hashing / TTL cap / buffer scrubbing / E2EE & zero-retention bypass,
 * immediate ingress E2EE sealing in logBatcher, and frontend KeyStore/DecryptEngine lifecycle.
 */

import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { D1Database, ExecutionContext } from "@cloudflare/workers-types";
import { NodeD1Database, runMigrations } from "../src/serverfull/db";
import { zeroizeBuffer, zeroizeBuffers } from "../src/utils/memory";
import {
  computeDnsCacheKey,
  dnsCache,
  getCachedDnsEntry,
  MAX_DNS_CACHE_TTL_SEC,
  setCachedDnsEntry,
  sweepExpiredDnsCache,
} from "../src/pipeline/cache";
import {
  enqueueLog,
  flushLogBatch,
  invalidateProfileLogKeyCache,
} from "../src/pipeline/logBatcher";
import { recordSuccessAndCache } from "../src/pipeline/resolver/observability";
import { generatePqcLogKeyPair } from "../src/lib/crypto/e2ee/pqc";
import { buildDNSQuery, buildResponse } from "../src/utils/dns";
import type { Env, ProfileSettings, ResolutionLog } from "../src/types";
import { KeyStore } from "../web/src/services/e2ee/keyStore";
import { DecryptEngine, MAX_DEK_CACHE_ENTRIES } from "../web/src/services/e2ee/decryptEngine";

function createTestDb(): D1Database {
  const sqlite = new DatabaseSync(":memory:");
  runMigrations(sqlite, path.join(process.cwd(), "migrations"));
  return new NodeD1Database(sqlite) as unknown as D1Database;
}

function createTrackingCtx(): { ctx: ExecutionContext; drain: () => Promise<void> } {
  const pending: Promise<unknown>[] = [];
  const ctx: ExecutionContext = {
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
    },
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
  return {
    ctx,
    async drain() {
      while (pending.length > 0) {
        const batch = pending.splice(0, pending.length);
        await Promise.allSettled(batch);
      }
    },
  };
}

function createMockWebStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  };
}

async function main(): Promise<void> {
  // 1. Buffer zeroization tests
  const u8 = new Uint8Array([1, 2, 3, 4, 5]);
  const ab = new Uint8Array([9, 8, 7, 6]).buffer;
  zeroizeBuffer(u8);
  assert.deepEqual(Array.from(u8), [0, 0, 0, 0, 0]);
  zeroizeBuffers(null, undefined, ab);
  assert.deepEqual(Array.from(new Uint8Array(ab)), [0, 0, 0, 0]);

  // 2. Worker dnsCache: opaque hashed keys, answer buffer scrubbing on expiry/delete, 300s max TTL
  assert.equal(MAX_DNS_CACHE_TTL_SEC, 300);
  dnsCache.clear();

  const hashedKey = await computeDnsCacheKey("prof-1", "secret-domain.example.com", "A");
  assert.equal(hashedKey.includes("secret-domain"), false, "Cache key must not contain plaintext domain");
  assert.equal(hashedKey.length, 64);

  const wireAnswer = new Uint8Array([10, 20, 30, 40, 50]);
  setCachedDnsEntry(hashedKey, {
    profileId: "prof-1",
    answer: wireAnswer,
    ttl: 60,
    action: "PASS",
    expiresAt: Date.now() + 60_000,
  });
  const storedEntry = dnsCache.get(hashedKey);
  assert.ok(storedEntry);
  assert.notEqual(storedEntry.answer, wireAnswer, "dnsCache should store defensive copy");

  // Expire & sweep should remove and zeroize answer buffer
  storedEntry.expiresAt = Date.now() - 1;
  assert.equal(getCachedDnsEntry(hashedKey), null);
  assert.deepEqual(Array.from(storedEntry.answer), [0, 0, 0, 0, 0], "Expired DNS answer must be zeroed");

  // Sweep also clears expired entries proactively
  const expiredKey = await computeDnsCacheKey("prof-1", "expired.example.com", "A");
  setCachedDnsEntry(expiredKey, {
    profileId: "prof-1",
    answer: new Uint8Array([7, 7, 7]),
    ttl: 10,
    action: "PASS",
    expiresAt: Date.now() - 5000,
  });
  const expiredStored = dnsCache.get(expiredKey)!;
  sweepExpiredDnsCache();
  assert.equal(dnsCache.size, 0);
  assert.deepEqual(Array.from(expiredStored.answer), [0, 0, 0]);

  // 3. Ingress E2EE sealing in logBatcher (encrypt & redact plaintext before batch flush)
  const db = createTestDb();
  const nowSec = Math.floor(Date.now() / 1000);
  const e2eeProfileId = "prof-e2ee-1";
  const plainProfileId = "prof-plain-1";

  await db
    .prepare("INSERT INTO users (id, username, hashed_password, created_at) VALUES (?, ?, ?, ?)")
    .bind("user-mem-1", "memuser", "placeholder", nowSec)
    .run();

  await db
    .prepare("INSERT INTO profiles (id, owner_id, name, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(e2eeProfileId, "user-mem-1", "E2EE Profile", "{}", nowSec, nowSec)
    .run();

  await db
    .prepare("INSERT INTO profiles (id, owner_id, name, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(plainProfileId, "user-mem-1", "Plain Profile", "{}", nowSec, nowSec)
    .run();

  const pqcPair = generatePqcLogKeyPair();
  await db
    .prepare("INSERT INTO user_log_keys (profile_id, public_key, created_at, is_active) VALUES (?, ?, ?, 1)")
    .bind(e2eeProfileId, JSON.stringify({ alg: "P256-MLKEM768", pqc_pk: pqcPair.publicKeyBase64 }), nowSec)
    .run();
  invalidateProfileLogKeyCache(e2eeProfileId);

  const env: Env = { DB: db } as unknown as Env;
  const { ctx, drain } = createTrackingCtx();

  const sensitiveLog: ResolutionLog = {
    profile_id: e2eeProfileId,
    timestamp: nowSec,
    client_ip: "203.0.113.42",
    geo_country: "SG",
    domain: "private-bank.example.com",
    record_type: "A",
    action: "PASS",
    reason: "Upstream OK",
    answer: "93.184.216.34",
    ecs: "203.0.113.0/24",
    upstream: "https://cloudflare-dns.com/dns-query",
    latency: 15,
  };

  const settings: ProfileSettings = {
    upstream: ["https://cloudflare-dns.com/dns-query"],
    default_policy: "ALLOW",
    log_retention_days: 30,
    ecs: { enabled: false, use_client_ip: false },
  };

  enqueueLog(sensitiveLog, settings, env, ctx);
  await drain();

  // After enqueue sealing + flush/scrubbing, sensitiveLog must have zero plaintext remnants
  assert.equal(sensitiveLog.domain, "");
  assert.equal(sensitiveLog.client_ip, "");
  assert.equal(sensitiveLog.answer, undefined);
  assert.equal(sensitiveLog.ecs, undefined);
  assert.equal(sensitiveLog.upstream, undefined);

  await flushLogBatch(env, ctx);
  const persistedRow = await db
    .prepare("SELECT domain, client_ip, encrypt_version, kem_key_id, encrypted_payload FROM logs WHERE profile_id = ?")
    .bind(e2eeProfileId)
    .first<{
      domain: string;
      client_ip: string;
      encrypt_version: number;
      kem_key_id: string | null;
      encrypted_payload: string | null;
    }>();

  assert.ok(persistedRow);
  assert.equal(persistedRow.domain, "");
  assert.equal(persistedRow.client_ip, "");
  assert.equal(persistedRow.encrypt_version, 2);
  assert.ok(persistedRow.kem_key_id);
  assert.ok(persistedRow.encrypted_payload && !persistedRow.encrypted_payload.includes("private-bank"));

  // 3b. Regression test: burst >= 40 logs triggering immediate flushLogBatch inside enqueueLog must never deadlock
  const burstCtx = createTrackingCtx();
  for (let i = 0; i < 45; i++) {
    enqueueLog(
      {
        profile_id: plainProfileId,
        timestamp: nowSec,
        client_ip: "198.51.100.10",
        geo_country: "JP",
        domain: `burst-${i}.example.com`,
        record_type: "A",
        action: "PASS",
        latency: 5,
      },
      settings,
      env,
      burstCtx.ctx
    );
  }
  await Promise.race([
    burstCtx.drain(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("enqueueLog immediate flush deadlocked")), 15000)),
  ]);
  await flushLogBatch(env, burstCtx.ctx);
  const burstCountRow = await db
    .prepare("SELECT COUNT(*) as cnt FROM logs WHERE profile_id = ?")
    .bind(plainProfileId)
    .first<{ cnt: number }>();
  assert.equal(burstCountRow?.cnt, 45, "All 45 burst logs must flush to DB without deadlock");

  // 4. recordSuccessAndCache bypasses dnsCache for E2EE and zero-retention profiles, and caps TTL for plain profiles
  dnsCache.clear();
  const sampleQueryRaw = buildDNSQuery("secret-query.example.com", "A");
  const sampleAnswer = buildResponse(sampleQueryRaw, "A", "93.184.216.34", 3600);
  const req = new Request("https://example.com/dns-query", {
    headers: { "CF-IPCountry": "SG" },
  });

  // 4a. E2EE profile skips dnsCache
  const ctxE2ee = createTrackingCtx();
  recordSuccessAndCache(
    req,
    { name: "secret-query.example.com", type: "A", raw: sampleQueryRaw },
    { profileId: e2eeProfileId, startTime: Date.now(), env, ctx: ctxE2ee.ctx },
    settings,
    "PASS",
    undefined,
    [{ name: "secret-query.example.com", type: "A", data: "93.184.216.34", ttl: 3600 }],
    sampleAnswer,
    3600,
    "https://cloudflare-dns.com/dns-query"
  );
  await ctxE2ee.drain();
  assert.equal(dnsCache.size, 0, "E2EE profiles must not populate Worker in-memory dnsCache");

  // 4b. Zero-retention profile skips dnsCache
  const ctxZero = createTrackingCtx();
  recordSuccessAndCache(
    req,
    { name: "zero-ret.example.com", type: "A", raw: sampleQueryRaw },
    { profileId: plainProfileId, startTime: Date.now(), env, ctx: ctxZero.ctx },
    { ...settings, log_retention_days: 0 },
    "PASS",
    undefined,
    [{ name: "zero-ret.example.com", type: "A", data: "93.184.216.34", ttl: 3600 }],
    sampleAnswer,
    3600,
    "https://cloudflare-dns.com/dns-query"
  );
  await ctxZero.drain();
  assert.equal(dnsCache.size, 0, "Zero-retention profiles must not populate Worker in-memory dnsCache");

  // 4c. Normal profile caches with hashed key and TTL <= 300s
  const ctxPlain = createTrackingCtx();
  recordSuccessAndCache(
    req,
    { name: "normal.example.com", type: "A", raw: sampleQueryRaw },
    { profileId: plainProfileId, startTime: Date.now(), env, ctx: ctxPlain.ctx },
    settings,
    "PASS",
    undefined,
    [{ name: "normal.example.com", type: "A", data: "93.184.216.34", ttl: 3600 }],
    sampleAnswer,
    3600,
    "https://cloudflare-dns.com/dns-query"
  );
  await ctxPlain.drain();
  assert.equal(dnsCache.size, 1);
  const plainKey = await computeDnsCacheKey(plainProfileId, "normal.example.com", "A");
  const plainEntry = getCachedDnsEntry(plainKey);
  assert.ok(plainEntry);
  assert.equal(plainEntry.ttl, MAX_DNS_CACHE_TTL_SEC);
  dnsCache.clear();
  await flushLogBatch(env, ctxPlain.ctx);

  // 5. Frontend KeyStore & DecryptEngine minimal residency lifecycle checks
  const mockSession = createMockWebStorage();
  const mockLocal = createMockWebStorage();
  mockSession.setItem("dns_worker_e2ee_sk_account", JSON.stringify({ alg: "P256-MLKEM768", seedBase64: "legacy" }));
  mockLocal.setItem("obex_e2ee_sk_prof1", JSON.stringify({ alg: "P256-MLKEM768", seedBase64: "legacy" }));
  (globalThis as unknown as { sessionStorage: Storage; localStorage: Storage }).sessionStorage = mockSession;
  (globalThis as unknown as { sessionStorage: Storage; localStorage: Storage }).localStorage = mockLocal;

  const keyStore = new KeyStore(1000);
  assert.equal(mockSession.getItem("dns_worker_e2ee_sk_account"), null, "KeyStore must purge sessionStorage key");
  assert.equal(mockLocal.getItem("obex_e2ee_sk_prof1"), null, "KeyStore must purge legacy localStorage key");

  const unlockedObj = { alg: "P256-MLKEM768" as const, seedBase64: pqcPair.secretKeyBase64 };
  keyStore.setPrivateKey("account", unlockedObj);
  assert.equal(mockSession.getItem("dns_worker_e2ee_sk_account"), null, "KeyStore must never write private key to sessionStorage");
  assert.equal(keyStore.isUnlocked(), true);

  // Idle expiration purges unlocked key and scrubs seedBase64
  const engine = new DecryptEngine(keyStore);
  assert.equal(MAX_DEK_CACHE_ENTRIES, 64);

  // Decrypt actual PQC-encrypted row persisted in step 3
  const decrypted = await engine.decryptLogEntry(e2eeProfileId, {
    id: 1,
    timestamp: nowSec,
    client_ip: "",
    geo_country: "",
    domain: "",
    record_type: "A",
    action: "PASS",
    encrypt_version: 2,
    kem_key_id: persistedRow.kem_key_id,
    kem_ct: (
      await db
        .prepare("SELECT kem_ct FROM kem_keys WHERE id = ?")
        .bind(persistedRow.kem_key_id)
        .first<{ kem_ct: string }>()
    )?.kem_ct,
    encrypted_payload: persistedRow.encrypted_payload,
  });
  assert.equal(decrypted.domain, "private-bank.example.com");
  assert.equal(decrypted.client_ip, "203.0.113.42");

  keyStore.clearStorage();
  assert.equal(unlockedObj.seedBase64, "", "clearStorage must scrub seedBase64 on discarded key object");
  assert.equal(keyStore.isUnlocked(), false);

  console.log("[PASS] All minimal memory residency lifecycle tests passed!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * @file test_fail_open_turso.ts
 * @description Verifies that when Turso/D1 read operations are blocked
 * (e.g. "Operation was blocked: SQL read operations are forbidden"),
 * all DNS resolution paths seamlessly fail open to FAIL_OPEN_UPSTREAM
 * without throwing 500s or crashing.
 */

import assert from "node:assert";
import http from "node:http";
import { createHttpRequestHandler } from "../src/serverfull/http/handler";
import { initNodeGlobals } from "../src/serverfull/cache";
import { SystemSettingsModel } from "../src/models/systemSettings";
import { ensureCloudflareIpRangesLoaded, isCloudflareIp } from "../src/utils/ech";
import { resolveProfileByKey, resolveDefaultProfile, handleDoHRequest } from "../src/api/doh";
import { pipeline } from "../src/pipeline";
import { configCache, profileKeyMemoryMap } from "../src/pipeline/cache";
import { isTursoQuotaError, verifyTursoConnection, TursoD1Database } from "../src/lib/turso";
import { resolveDbConfigStatus } from "../src/router/runtimeConfig";
import { buildDNSQuery, parseDNSAnswer } from "../src/utils/dns";
import { Context, Env, ExecutionContext } from "../src/types";
import {
  AccessKeyDoNamespace,
  AccessKeyEntry,
  AccessKeyLookupResult,
  AccessKeyRegistryStub,
  deleteAccessKeysInDo,
  upsertAccessKeysInDo
} from "../src/lib/accessKeyRegistry";
import { routeRequest } from "../src/router";

console.log(">>> [TEST] Running Turso Read-Blocked Fail-Open Fallback Tests...");

// 1. Create a simulated blocked Turso D1 database
const BLOCKED_ERROR_MSG = "[Turso D1] Query error: Operation was blocked: SQL read operations are forbidden (reads are blocked, do you need to upgrade your plan?)";

const mockBlockedDb: any = {
  prepare: (sql: string) => ({
    bind: (..._params: any[]) => ({
      first: async () => {
        throw new Error(`${BLOCKED_ERROR_MSG} SQL: ${sql}`);
      },
      all: async () => {
        throw new Error(`${BLOCKED_ERROR_MSG} SQL: ${sql}`);
      },
      run: async () => {
        throw new Error(`${BLOCKED_ERROR_MSG} SQL: ${sql}`);
      }
    }),
    first: async () => {
      throw new Error(`${BLOCKED_ERROR_MSG} SQL: ${sql}`);
    },
    all: async () => {
      throw new Error(`${BLOCKED_ERROR_MSG} SQL: ${sql}`);
    },
    run: async () => {
      throw new Error(`${BLOCKED_ERROR_MSG} SQL: ${sql}`);
    }
  }),
  batch: async () => {
    throw new Error(`${BLOCKED_ERROR_MSG} batch()`);
  }
};

const mockEnv = {
  DB: mockBlockedDb,
  FAIL_OPEN_UPSTREAM: "https://1.1.1.1/dns-query"
} as unknown as Env;

const mockCtx = {
  waitUntil: (p: Promise<any>) => { p.catch(() => {}); },
  passThroughOnException: () => {}
} as unknown as ExecutionContext;

async function runTests() {
  // Test 1: SystemSettingsModel.get under blocked reads
  const settingsModel = new SystemSettingsModel(mockBlockedDb);
  const siteKey = await settingsModel.get("turnstile_site_key");
  assert.strictEqual(siteKey, null, "get() must catch blocked read error and return null gracefully");
  console.log("  PASS: SystemSettingsModel.get gracefully returns null on blocked read");

  // Test 2: SystemSettingsModel.getAll under blocked reads
  const allSettings = await settingsModel.getAll();
  assert.ok(typeof allSettings === "object", "getAll() must return an object on blocked read");
  console.log("  PASS: SystemSettingsModel.getAll gracefully returns empty/cached object on blocked read");

  // Test 3: ensureCloudflareIpRangesLoaded under blocked reads
  await ensureCloudflareIpRangesLoaded(mockBlockedDb);
  // Verify that known Cloudflare IP is recognized via fallback preset
  const isCf = isCloudflareIp("104.16.1.1");
  assert.strictEqual(isCf, true, "104.16.1.1 must be recognized as Cloudflare IP via static preset fallback");
  console.log("  PASS: ensureCloudflareIpRangesLoaded fell back to preset Cloudflare CIDRs safely");

  // Test 4: resolveProfileByKey under blocked reads
  const fallbackProfile = await resolveProfileByKey("testkey123", mockEnv, mockCtx);
  assert.ok(fallbackProfile !== null, "resolveProfileByKey must provide emergency fallback profile");
  assert.strictEqual(fallbackProfile?.name, "Emergency Fallback");
  const parsedSettings = JSON.parse(fallbackProfile.settings);
  assert.strictEqual(parsedSettings.upstream[0], "https://1.1.1.1/dns-query", "Fallback profile must point to FAIL_OPEN_UPSTREAM");
  console.log("  PASS: resolveProfileByKey provides Emergency Fallback profile pointing to FAIL_OPEN_UPSTREAM");

  // Test 5: resolveDefaultProfile under blocked reads
  const defaultProfile = await resolveDefaultProfile(mockEnv, mockCtx);
  assert.ok(defaultProfile !== null, "resolveDefaultProfile must provide default fallback profile");
  const defaultSettings = JSON.parse(defaultProfile!.settings);
  assert.strictEqual(defaultSettings.upstream[0], "https://1.1.1.1/dns-query");
  console.log("  PASS: resolveDefaultProfile returns default profile pointing to FAIL_OPEN_UPSTREAM");

  // Test 6: Full pipeline resolution with blocked DB
  const rawQuery = buildDNSQuery("example.com", "A");
  const context: Context = {
    profileId: "testkey123",
    startTime: Date.now(),
    env: mockEnv,
    ctx: mockCtx
  };
  const request = new Request("https://dns.example.com/testkey123", {
    method: "POST",
    headers: { "Content-Type": "application/dns-message" },
    body: rawQuery
  });

  const result = await pipeline.process(
    request,
    { name: "example.com", type: "A", raw: rawQuery },
    context
  );

  assert.strictEqual(result.action, "PASS", "Pipeline must successfully resolve and PASS");
  assert.ok(result.answer.length > 0, "Pipeline must return valid DNS wire answer");
  const answers = parseDNSAnswer(result.answer);
  assert.ok(answers.length > 0, "Parsed DNS answers must not be empty");
  console.log(`  PASS: Full pipeline resolved example.com -> ${answers.map(a => a.data).join(", ")} via fail-open upstream`);

  // Test 7: End-to-end handleDoHRequest under blocked DB (must skip redundant DB reads and serve FAIL_OPEN_UPSTREAM)
  profileKeyMemoryMap.clear();
  configCache.clear();
  // Seed stale/poisoned config under same key to ensure emergency fallback is NOT overridden by profileId === profileKey
  configCache.set("dohkey99", {
    settings: {
      upstream: ["http://127.0.0.1/unreachable"],
      default_policy: "ALLOW",
      log_retention_days: 0,
      ecs: { enabled: false, use_client_ip: false }
    },
    rules: [],
    timestamp: Date.now()
  });

  let dbPrepareCount = 0;
  const countingBlockedDb: any = {
    prepare: (sql: string) => {
      dbPrepareCount++;
      return mockBlockedDb.prepare(sql);
    },
    batch: mockBlockedDb.batch
  };
  const dohEnv = { DB: countingBlockedDb, FAIL_OPEN_UPSTREAM: "https://1.1.1.1/dns-query" } as unknown as Env;
  const dohReq = new Request("https://dns.example.com/dohkey99", {
    method: "POST",
    headers: { "Content-Type": "application/dns-message" },
    body: rawQuery
  });
  const dohRes = await handleDoHRequest(dohReq, dohEnv, mockCtx, "dohkey99");
  assert.strictEqual(dohRes.status, 200, "DoH fail-open response must be HTTP 200");
  const dohAnswerBytes = new Uint8Array(await dohRes.arrayBuffer());
  assert.ok(dohAnswerBytes.length > 0, "DoH fail-open response body must be non-empty");
  assert.ok(parseDNSAnswer(dohAnswerBytes).length > 0, "DoH fail-open answer must parse cleanly");
  assert.strictEqual(dbPrepareCount, 1, "Emergency fallback must issue only 1 DB lookup (findByKey) and bypass pipelineConfig DB reads");
  console.log("  PASS: handleDoHRequest end-to-end fails open cleanly without redundant DB reads or configCache override");

  // Test 8: handleDoHRequest fails open when cached profile upstream fails (action === 'FAIL')
  profileKeyMemoryMap.set("brokenup", {
    ts: Date.now(),
    data: {
      id: "prof_broken",
      name: "Cached Broken Profile",
      owner_id: "u1",
      settings: JSON.stringify({
        upstream: ["http://127.0.0.1/blocked-local"],
        default_policy: "ALLOW",
        log_retention_days: 0,
        ecs: { enabled: false, use_client_ip: false }
      }),
      created_at: 1,
      updated_at: 1
    }
  });
  configCache.set("prof_broken", {
    settings: {
      upstream: ["http://127.0.0.1/blocked-local"],
      default_policy: "ALLOW",
      log_retention_days: 0,
      ecs: { enabled: false, use_client_ip: false }
    },
    rules: [],
    timestamp: Date.now()
  });
  const brokenReq = new Request("https://dns.example.com/brokenup", {
    method: "POST",
    headers: { "Content-Type": "application/dns-message" },
    body: rawQuery
  });
  const brokenRes = await handleDoHRequest(brokenReq, mockEnv, mockCtx, "brokenup");
  assert.strictEqual(brokenRes.status, 200, "DoH must fail open instead of returning empty body when upstream fails");
  const brokenAnswer = new Uint8Array(await brokenRes.arrayBuffer());
  assert.ok(parseDNSAnswer(brokenAnswer).length > 0, "DoH fallback answer must resolve via FAIL_OPEN_UPSTREAM");
  console.log("  PASS: handleDoHRequest fails open to FAIL_OPEN_UPSTREAM when cached profile upstream returns FAIL");

  // Test 9 & 10: isTursoQuotaError, verifyTursoConnection classification, and TursoD1Database read circuit breaker
  assert.strictEqual(
    isTursoQuotaError("Operation was blocked: SQL read operations are forbidden (reads are blocked, do you need to upgrade your plan?)"),
    true,
    "isTursoQuotaError must recognize Turso blocked-reads error"
  );
  assert.strictEqual(isTursoQuotaError("no such table: users"), false, "Regular SQL errors must not trigger quota error");

  const originalFetch = globalThis.fetch;
  let tursoFetchCalls = 0;
  try {
    globalThis.fetch = (async () => {
      tursoFetchCalls++;
      return new Response(JSON.stringify({
        results: [{
          type: "error",
          error: {
            code: "BLOCKED",
            message: "Operation was blocked: SQL read operations are forbidden (reads are blocked, do you need to upgrade your plan?)"
          }
        }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    const quotaEnv = {
      DB: mockBlockedDb,
      DATABASE_SERVICE: "Turso",
      TURSO_DATABASE_URL: "turso://quota-test.turso.io",
      TURSO_AUTH_TOKEN: "test-token-12345"
    } as unknown as Env;
    const health = await verifyTursoConnection(quotaEnv);
    assert.strictEqual(health.ok, false);
    assert.strictEqual(health.errorCode, "quota_exceeded", "verifyTursoConnection must classify blocked reads as quota_exceeded");
    assert.ok(health.message?.includes("FAIL_OPEN_UPSTREAM"), "Quota error message should mention DNS fail-open active");

    const dbStatus = await resolveDbConfigStatus(quotaEnv, false, "Turso");
    assert.strictEqual(dbStatus.isDbMissing, false, "Quota exhaustion must NOT mark DB as missing/unconfigured");
    assert.strictEqual(dbStatus.isDbQuotaExceeded, true, "Quota exhaustion must set isDbQuotaExceeded=true");
    assert.strictEqual(dbStatus.dbErrorCode, "quota_exceeded");

    const tursoDb = new TursoD1Database("turso://quota-test.turso.io", "test-token-12345");
    tursoFetchCalls = 0;
    await assert.rejects(() => tursoDb.prepare("SELECT * FROM profiles WHERE id = ?").bind("a").first());
    assert.strictEqual(tursoFetchCalls, 1, "First blocked read calls Turso once");
    await assert.rejects(() => tursoDb.prepare("SELECT * FROM rules WHERE profile_id = ?").bind("b").all());
    assert.strictEqual(tursoFetchCalls, 1, "Subsequent reads within cooldown must fast-fail without hitting Turso HTTP API");
    console.log("  PASS: verifyTursoConnection & TursoD1Database quota circuit breaker passed");
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Test 11: Durable Object Access Key registry during DB offline / FAIL_OPEN + /dns-query rejection
  profileKeyMemoryMap.clear();
  configCache.clear();

  const shardStore = new Map<string, { keys: Map<string, AccessKeyEntry>; populated: boolean }>();
  const mockDoNamespace: AccessKeyDoNamespace = {
    getByName(shardName: string): AccessKeyRegistryStub {
      if (!shardStore.has(shardName)) {
        shardStore.set(shardName, { keys: new Map(), populated: false });
      }
      const shard = shardStore.get(shardName)!;
      return {
        async upsertKeys(entries: AccessKeyEntry[]) {
          for (const e of entries) shard.keys.set(e.accessKey, e);
          shard.populated = true;
        },
        async deleteKeys(keys: string[]) {
          for (const k of keys) shard.keys.delete(k);
          shard.populated = true;
        },
        async replaceSnapshot(entries: AccessKeyEntry[]) {
          shard.keys.clear();
          for (const e of entries) shard.keys.set(e.accessKey, e);
          shard.populated = true;
        },
        async lookupKey(accessKey: string): Promise<AccessKeyLookupResult> {
          const rec = shard.keys.get(accessKey);
          return rec
            ? { found: true, populated: true, record: rec }
            : { found: false, populated: shard.populated };
        }
      };
    }
  };

  const doEnv = {
    DB: mockBlockedDb,
    ACCESS_KEY_DO: mockDoNamespace,
    FAIL_OPEN_UPSTREAM: "https://1.1.1.1/dns-query"
  } as unknown as Env;

  // Seed one legitimate Access Key into DO, and also mark shard for 'badkey9' populated without adding it
  await upsertAccessKeysInDo(doEnv, [
    {
      accessKey: "validk1",
      profileId: "prof_do_1",
      ownerId: "user_do_1",
      accessPointId: "ap_do_1",
      accessPointName: "Laptop",
      updatedAt: Math.floor(Date.now() / 1000)
    }
  ]);
  // Ensure shard for 'badkey9' is marked seeded (empty populated shard)
  await deleteAccessKeysInDo(doEnv, ["badkey9"]);

  const resolvedDoProfile = await resolveProfileByKey("validk1", doEnv, mockCtx);
  assert.ok(resolvedDoProfile !== null, "Registered Access Key in DO must resolve during DB outage");
  assert.strictEqual(resolvedDoProfile?.id, "prof_do_1");
  assert.strictEqual(resolvedDoProfile?.access_point_id, "ap_do_1");
  assert.strictEqual(resolvedDoProfile?.access_point_name, "Laptop");
  assert.strictEqual(resolvedDoProfile?.isEmergencyFallback, true);

  const validDoReq = new Request("https://dns.example.com/validk1", {
    method: "POST",
    headers: { "Content-Type": "application/dns-message" },
    body: rawQuery
  });
  const validDoRes = await handleDoHRequest(validDoReq, doEnv, mockCtx, "validk1");
  assert.strictEqual(validDoRes.status, 200, "Valid DO-backed Access Key must resolve DoH query during DB outage");

  const invalidDoRes = await handleDoHRequest(
    new Request("https://dns.example.com/badkey9", {
      method: "POST",
      headers: { "Content-Type": "application/dns-message" },
      body: rawQuery
    }),
    doEnv,
    mockCtx,
    "badkey9"
  );
  assert.strictEqual(invalidDoRes.status, 404, "Unregistered Access Key must be rejected (404) when DO shard is populated");

  // Revoke validk1 and clear L1 cache -> must now reject with 404
  await deleteAccessKeysInDo(doEnv, ["validk1"]);
  profileKeyMemoryMap.delete("validk1");
  const revokedDoRes = await handleDoHRequest(validDoReq, doEnv, mockCtx, "validk1");
  assert.strictEqual(revokedDoRes.status, 404, "Revoked Access Key removed from DO must return 404 during DB outage");

  // Verify /dns-query is NOT routed to DoH handler
  const dnsQueryRouteRes = await routeRequest(
    new Request("https://dns.example.com/dns-query", {
      method: "POST",
      headers: { "Content-Type": "application/dns-message" },
      body: rawQuery
    }),
    { ...doEnv, ASSETS: { fetch: async () => new Response("Not Found", { status: 404 }) } } as unknown as Env,
    mockCtx,
    { isServerfull: false, dbService: "D1", nonce: "testnonce" }
  );
  assert.strictEqual(dnsQueryRouteRes.response.status, 404);
  assert.notStrictEqual(await dnsQueryRouteRes.response.text(), "Invalid Profile Key", "/dns-query must not invoke DoH handler");
  console.log("  PASS: Durable Object Access Key FAIL_OPEN persistence & /dns-query removal verified");

  // Test 12: Serverfull reverse proxy (Caddy/Nginx) X-Http-Version preservation over HTTP/1.1 hop
  initNodeGlobals();
  await upsertAccessKeysInDo(doEnv, [
    {
      accessKey: "caddyk1",
      profileId: "prof_caddy_1",
      ownerId: "user_do_1",
      accessPointId: "ap_caddy_1",
      accessPointName: "CaddyClient",
      updatedAt: Math.floor(Date.now() / 1000)
    }
  ]);
  profileKeyMemoryMap.delete("caddyk1");

  const proxyHandlerEnv = {
    ...doEnv,
    SERVERFULL_DB_PATH: ":memory:",
    DATABASE_SERVICE: "File"
  } as unknown as Env;
  const proxyServer = http.createServer(createHttpRequestHandler(proxyHandlerEnv, "http", "127.0.0.1", 0));
  await new Promise<void>((resolve) => proxyServer.listen(0, "127.0.0.1", resolve));
  try {
    const addr = proxyServer.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${addr.port}/caddyk1`;

    // Without X-Http-Version over HTTP/1.1 hop -> 505
    const noHeaderRes = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/dns-message" },
      body: rawQuery
    });
    assert.strictEqual(noHeaderRes.status, 505, "HTTP/1.1 without trusted X-Http-Version must return 505");

    // With Caddy `header_up X-Http-Version HTTP/2.0` -> 200
    const h2HeaderRes = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/dns-message",
        "X-Http-Version": "HTTP/2.0"
      },
      body: rawQuery
    });
    assert.strictEqual(h2HeaderRes.status, 200, "Trusted loopback proxy with X-Http-Version: HTTP/2.0 must return 200");

    // With Caddy `header_up X-Http-Version HTTP/3.0` -> 200
    const h3HeaderRes = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/dns-message",
        "X-Http-Version": "HTTP/3.0"
      },
      body: rawQuery
    });
    assert.strictEqual(h3HeaderRes.status, 200, "Trusted loopback proxy with X-Http-Version: HTTP/3.0 must return 200");

    // With Caddy `header_up X-Http-Version HTTP/1.1` (client actually used HTTP/1.1) -> 505
    const h1HeaderRes = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/dns-message",
        "X-Http-Version": "HTTP/1.1"
      },
      body: rawQuery
    });
    assert.strictEqual(h1HeaderRes.status, 505, "Client HTTP/1.1 forwarded via X-Http-Version must still return 505");
    console.log("  PASS: Serverfull reverse proxy X-Http-Version (Caddy HTTP/2 & HTTP/3) verified");
  } finally {
    await new Promise<void>((resolve) => proxyServer.close(() => resolve()));
  }

  console.log("\n======================================================");
  console.log("   ALL TURSO BLOCKED READ FAIL-OPEN TESTS PASSED!     ");
  console.log("======================================================");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});

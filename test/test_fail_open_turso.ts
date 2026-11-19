/**
 * @file test_fail_open_turso.ts
 * @description Verifies that when Turso/D1 read operations are blocked
 * (e.g. "Operation was blocked: SQL read operations are forbidden"),
 * all DNS resolution paths seamlessly fail open to FAIL_OPEN_UPSTREAM
 * without throwing 500s or crashing.
 */

import assert from "node:assert";
import { SystemSettingsModel } from "../src/models/systemSettings";
import { ensureCloudflareIpRangesLoaded, isCloudflareIp } from "../src/utils/ech";
import { resolveProfileByKey, resolveDefaultProfile, handleDoHRequest } from "../src/api/doh";
import { pipeline } from "../src/pipeline";
import { configCache, profileKeyMemoryMap } from "../src/pipeline/cache";
import { isTursoQuotaError, verifyTursoConnection, TursoD1Database } from "../src/lib/turso";
import { resolveDbConfigStatus } from "../src/router/runtimeConfig";
import { buildDNSQuery, parseDNSAnswer } from "../src/utils/dns";
import { Context, Env, ExecutionContext } from "../src/types";

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

  console.log("\n======================================================");
  console.log("   ALL TURSO BLOCKED READ FAIL-OPEN TESTS PASSED!     ");
  console.log("======================================================");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});

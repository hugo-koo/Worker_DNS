/**
 * @file test_sql_hardening.ts
 * @description Tests for SQL defense-in-depth helpers, bounded LIMIT parameterization,
 * escaped LIKE pattern queries, and removal of ProfileModel.list raw SQL fragment API.
 */

import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { D1Database } from "@cloudflare/workers-types";
import { NodeD1Database, runMigrations } from "../src/serverfull/db";
import { escapeLikePattern, normalizeBoundedLimit } from "../src/utils/sql";
import { LogCoreModel } from "../src/models/log/core";
import { LogTrafficAnalytics } from "../src/models/log/analytics/traffic";
import { LogDestinationAnalytics } from "../src/models/log/analytics/destinations";
import { ProfileModel } from "../src/models/profile";

function createTestDb(): D1Database {
  const sqlite = new DatabaseSync(":memory:");
  runMigrations(sqlite, path.join(process.cwd(), "migrations"));
  return new NodeD1Database(sqlite) as unknown as D1Database;
}

async function main(): Promise<void> {
  // 1. normalizeBoundedLimit unit checks
  assert.equal(normalizeBoundedLimit(undefined, 50, 1000), 50);
  assert.equal(normalizeBoundedLimit(null, 50, 1000), 50);
  assert.equal(normalizeBoundedLimit(-1, 50, 1000), 50);
  assert.equal(normalizeBoundedLimit(0, 250, 1000), 250);
  assert.equal(normalizeBoundedLimit(Number.NaN, 50, 1000), 50);
  assert.equal(normalizeBoundedLimit(Infinity, 50, 1000), 50);
  assert.equal(normalizeBoundedLimit("bad", 50, 1000), 50);
  assert.equal(normalizeBoundedLimit(12.9, 50, 1000), 12);
  assert.equal(normalizeBoundedLimit(999999, 50, 1000), 1000);
  assert.equal(normalizeBoundedLimit(1, 50, 1000), 1);

  // 2. escapeLikePattern unit checks
  assert.equal(escapeLikePattern("example.com"), "example.com");
  assert.equal(escapeLikePattern("100%_test\\path"), "100\\%\\_test\\\\path");

  // 3. ProfileModel no longer exposes raw filterSql list() method
  assert.equal(
    typeof (ProfileModel.prototype as unknown as Record<string, unknown>).list,
    "undefined",
    "ProfileModel.prototype.list should be removed"
  );

  // 4. Seed in-memory SQLite DB with realistic + wildcard-like domain logs
  const db = createTestDb();
  const profileId = "prof-sql-test";
  const nowSec = Math.floor(Date.now() / 1000);

  await db
    .prepare("INSERT INTO users (id, username, hashed_password, created_at) VALUES (?, ?, ?, ?)")
    .bind("user-1", "sqltestuser", "placeholder-hash", nowSec)
    .run();

  await db
    .prepare("INSERT INTO profiles (id, owner_id, name, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(profileId, "user-1", "SQL Hardening Profile", "{}", nowSec, nowSec)
    .run();

  const logCore = new LogCoreModel(db);
  const traffic = new LogTrafficAnalytics(db);
  const destinations = new LogDestinationAnalytics(db);

  const sampleDomains = [
    { domain: "100%_literal.example.com", countryCode: "US", country: "United States", isp: "Cloudflare" },
    { domain: "1000literal.example.com", countryCode: "US", country: "United States", isp: "Cloudflare" },
    { domain: "a_b.example.org", countryCode: "DE", country: "Germany", isp: "Hetzner" },
    { domain: "axb.example.org", countryCode: "JP", country: "Japan", isp: "IIJ" },
    { domain: "back\\slash.example.net", countryCode: "SG", country: "Singapore", isp: "OVH" },
  ];

  const statements = sampleDomains.map((item, idx) =>
    logCore.createInsertStatement({
      profile_id: profileId,
      timestamp: nowSec - idx,
      client_ip: "192.0.2.10",
      geo_country: "US",
      domain: item.domain,
      record_type: "A",
      action: "PASS",
      dest_country_code: item.countryCode,
      dest_country: item.country,
      dest_isp: item.isp,
    })
  );
  await db.batch(statements);

  // 5. LogCoreModel.getLogs escapes LIKE wildcards (% and _ and \)
  const percentMatches = await logCore.getLogs(profileId, {
    since: nowSec - 60,
    until: nowSec + 60,
    search: "100%_",
    limit: 50,
  });
  assert.equal(percentMatches.length, 1);
  assert.equal(percentMatches[0].domain, "100%_literal.example.com");

  const underscoreMatches = await logCore.getLogs(profileId, {
    since: nowSec - 60,
    until: nowSec + 60,
    search: "a_b",
    limit: 50,
  });
  assert.equal(underscoreMatches.length, 1);
  assert.equal(underscoreMatches[0].domain, "a_b.example.org");

  const backslashMatches = await logCore.getLogs(profileId, {
    since: nowSec - 60,
    until: nowSec + 60,
    search: "back\\slash",
    limit: 50,
  });
  assert.equal(backslashMatches.length, 1);
  assert.equal(backslashMatches[0].domain, "back\\slash.example.net");

  // 6. LogCoreModel.getLogs clamps negative/oversized limits safely instead of returning 0 or crashing
  const negativeLimitLogs = await logCore.getLogs(profileId, {
    since: nowSec - 60,
    until: nowSec + 60,
    limit: -1,
  });
  assert.equal(negativeLimitLogs.length, sampleDomains.length);

  // 7. LogTrafficAnalytics.getSummary escapes LIKE wildcards
  const summary = await traffic.getSummary(profileId, nowSec - 60, nowSec + 60, "a_b");
  assert.equal(summary.length, 1);
  assert.equal(summary[0].action, "PASS");
  assert.equal(summary[0].count, 1);

  // 8. LogDestinationAnalytics enforces bounded limits cleanly for -1 and oversized limits
  const destNegLimit = await destinations.getDestinations(profileId, nowSec - 60, nowSec + 60, undefined, -1);
  assert.equal(destNegLimit.length, 4);

  const destHugeLimit = await destinations.getDestinations(profileId, nowSec - 60, nowSec + 60, undefined, 999999);
  assert.equal(destHugeLimit.length, 4);

  const ispNegLimit = await destinations.getISPByCountry(profileId, "US", nowSec - 60, nowSec + 60, undefined, -1);
  assert.equal(ispNegLimit.length, 1);
  assert.equal(ispNegLimit[0].name, "Cloudflare");

  console.log("test_sql_hardening passed!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

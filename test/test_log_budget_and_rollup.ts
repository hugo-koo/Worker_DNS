/// <reference types="node" />
import assert from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { NodeD1Database } from "../src/serverfull/db";
import { LogRetentionModel } from "../src/models/log/retention";
import { LogAggregationModel } from "../src/models/log/aggregation";
import { LogCoreModel } from "../src/models/log/core";
import { LogAnalyticsModel } from "../src/models/log/analytics";
import { SystemSettingsModel } from "../src/models/systemSettings";

async function runTests() {
  console.log(">>> [TEST] Running Log Deletion Budget & Domain Rollup Filter Tests...\n");

  // 1. Test LogRetentionModel.cleanupGlobal batchLimit distribution
  console.log("1. Testing LogRetentionModel.cleanupGlobal batchLimit distribution...");
  {
    const executedQueries: { query: string; params: any[] }[] = [];
    const boundLimits: number[] = [];

    const mockDb: any = {
      prepare(query: string) {
        const createObj = (boundArgs: any[] = []) => ({
          query,
          params: boundArgs,
          bind(...args: any[]) {
            return createObj(args);
          },
          async all() {
            if (query.includes("SELECT id, settings FROM profiles")) {
              return {
                results: [
                  { id: "p1", settings: JSON.stringify({ log_retention_days: 7 }) },
                  { id: "p2", settings: JSON.stringify({ log_retention_days: 7 }) },
                  { id: "p3", settings: JSON.stringify({ log_retention_days: 7 }) }
                ]
              };
            }
            if (query.includes("SELECT timestamp, id FROM logs")) {
              const limit = Number(boundArgs[2] || 0);
              boundLimits.push(limit);
              return {
                results: Array.from({ length: limit }, (_, idx) => ({
                  timestamp: 1000 + idx,
                  id: idx + 1
                }))
              };
            }
            return { results: [] };
          },
          async first() {
            return null;
          },
          async run() {
            return { success: true };
          }
        });
        return createObj();
      },
      async batch(statements: any[]) {
        for (const s of statements) {
          executedQueries.push({ query: s.query, params: s.params });
        }
        return [];
      }
    };

    const retentionModel = new LogRetentionModel(mockDb);

    // Run cleanupGlobal with batchLimit = 900 across 3 profiles
    // Expected perProfileLimit = Math.floor(900 / 3) = 300
    await retentionModel.cleanupGlobal(30, 900);

    assert.deepStrictEqual(boundLimits, [300, 300, 300], "Boundary lookup must bind perProfileLimit = 300");

    const deleteStatements = executedQueries.filter(q => q.query.includes("DELETE FROM logs WHERE"));
    assert.strictEqual(deleteStatements.length, 3, "Should generate delete statement for each profile");

    for (const stmt of deleteStatements) {
      assert(!stmt.query.includes("(profile_id, timestamp, id) IN"), "Must not use multi-column tuple IN subquery");
      assert(stmt.query.includes("timestamp <= ?"), "Must use bounded range predicate for indexed deletion");
    }

    const rollupDeletes = executedQueries.filter(q => q.query.includes("DELETE FROM hourly_rollups"));
    assert.strictEqual(rollupDeletes.length, 15, "Should generate 5 metric type (action, client, dest, domain, isp) delete statements for each of the 3 profiles");
    for (const stmt of rollupDeletes) {
      assert(stmt.query.includes("metric_type = ?"), "Must bind metric_type to enable composite primary key B-Tree range scan");
    }

    console.log("  Passed: batchLimit 900 correctly distributed to 300 per profile, hourly_rollups indexed deletions generated.");
  }

  // 2. Test LogAggregationModel.aggregateHourlyRollups with minDomainCount
  console.log("\n2. Testing LogAggregationModel.aggregateHourlyRollups with minDomainCount...");
  {
    const executedQueries: { query: string; params: any[] }[] = [];

    const mockDb: any = {
      prepare(query: string) {
        return {
          async all() {
            if (query.includes("FROM profiles")) {
              return { results: [{ id: "p1" }] };
            }
            return { results: [] };
          },
          bind(...args: any[]) {
            return {
              query,
              params: args,
              async first() {
                if (query.includes("FROM system_settings")) {
                  return { value: "1000000" };
                }
                if (query.includes("FROM logs")) {
                  return { 1: 1 };
                }
                return null;
              },
              async all() {
                if (query.includes("FROM profiles")) {
                  return { results: [{ id: "p1" }] };
                }
                return { results: [] };
              },
              async run() {
                return { success: true, meta: { changes: 1 } };
              }
            };
          }
        };
      },
      async batch(statements: any[]) {
        for (const s of statements) {
          executedQueries.push({ query: s.query, params: s.params });
        }
        return statements.map(() => ({ meta: { changes: 1 } }));
      }
    };

    const aggModel = new LogAggregationModel(mockDb);

    // Run aggregation for 1 hour with minDomainCount = 2
    await aggModel.aggregateHourlyRollups(1000000, 1003600, 2);

    const domainRollupStmt = executedQueries.find(q => q.query.includes("INSERT INTO hourly_rollups") && q.query.includes("'domain'"));
    assert(domainRollupStmt !== undefined, "domain hourly_rollups statement must be executed");
    assert(domainRollupStmt.query.includes("HAVING COUNT(*) >= ?"), "Query must include HAVING COUNT(*) >= ?");

    const boundMinCount = domainRollupStmt.params[4];
    assert.strictEqual(boundMinCount, 2, "HAVING clause must bind minDomainCount (2)");

    console.log("  Passed: hourly_rollups domain metric binds HAVING COUNT(*) >= 2.");
  }

  // 3. Test LogCoreModel.cleanup maxRows default
  console.log("\n3. Testing LogCoreModel.cleanup default maxRows...");
  {
    let passedBatchLimit = 0;

    const mockDb: any = {
      prepare(query: string) {
        return {
          bind(...args: any[]) {
            if (query.includes("SELECT timestamp, id FROM logs")) {
              passedBatchLimit = args[2];
            }
            return {
              async all() {
                if (query.includes("SELECT timestamp, id FROM logs")) {
                  return { results: [{ timestamp: 999, id: 1 }] };
                }
                return { results: [] };
              },
              async run() {
                return { success: true, meta: { changes: 500 } };
              }
            };
          }
        };
      },
      async batch() {
        return [];
      }
    };

    const coreModel = new LogCoreModel(mockDb);
    // Call cleanup without maxRows (defaults to 1000)
    const deleted = await coreModel.cleanup("p1", 1000000);
    assert.strictEqual(passedBatchLimit, 1000, "Default batch limit in cleanup must be 1000");
    assert.strictEqual(deleted, 500, "Should report deleted rows correctly");

    console.log("  Passed: LogCoreModel.cleanup defaults to 1000 maxRows.");
  }

  // 4. Test LogRetentionModel.cleanupGlobal daily budget enforcement
  console.log("\n4. Testing LogRetentionModel.cleanupGlobal daily budget enforcement...");
  {
    const todayDate = new Date().toISOString().slice(0, 10);
    const mockSettings: Record<string, string> = {
      log_cleanup_daily_date: todayDate,
      log_cleanup_daily_count: "20000"
    };

    const mockSettingsModel: any = {
      async get(key: string) {
        return mockSettings[key] || null;
      },
      async setMany(settings: Record<string, string>) {
        Object.assign(mockSettings, settings);
        return true;
      }
    };

    const executedQueries: { query: string; params: any[] }[] = [];
    const mockDb: any = {
      prepare(query: string) {
        const createObj = (boundArgs: any[] = []) => ({
          query,
          params: boundArgs,
          bind(...args: any[]) {
            return createObj(args);
          },
          async all() {
            if (query.includes("SELECT id, settings FROM profiles")) {
              return { results: [{ id: "p1", settings: "{}" }] };
            }
            return { results: [] };
          },
          async run() {
            return { meta: { changes: 0 } };
          }
        });
        return createObj();
      },
      async batch(statements: any[]) {
        for (const s of statements) {
          executedQueries.push({ query: s.query, params: s.params });
        }
        return statements.map(() => ({ meta: { changes: 0 } }));
      }
    };

    const retentionModel = new LogRetentionModel(mockDb, mockSettingsModel);

    // Call cleanupGlobal with dailyBudget = 20000 (already reached)
    await retentionModel.cleanupGlobal(30, 1000, 20000);

    const logDeleteStmts = executedQueries.filter(q => q.query.includes("DELETE FROM logs WHERE"));
    assert.strictEqual(logDeleteStmts.length, 0, "When daily budget is exhausted, NO DELETE FROM logs statements should be executed");

    // But rollups should still be cleaned up
    const rollupDeleteStmts = executedQueries.filter(q => q.query.includes("hourly_rollups"));
    assert(rollupDeleteStmts.length > 0, "Rollup cleanups should still run");

    console.log("  Passed: Log deletions skipped when daily budget is exhausted.");
  }

  // 5. Test LogRetentionModel.cleanupGlobal remaining budget capping and persistence
  console.log("\n5. Testing LogRetentionModel.cleanupGlobal remaining budget capping and persistence...");
  {
    const todayDate = new Date().toISOString().slice(0, 10);
    const mockSettings: Record<string, string> = {
      log_cleanup_daily_date: todayDate,
      log_cleanup_daily_count: "19800"
    };

    const mockSettingsModel: any = {
      async get(key: string) {
        return mockSettings[key] || null;
      },
      async setMany(settings: Record<string, string>) {
        Object.assign(mockSettings, settings);
        return true;
      }
    };

    const executedQueries: { query: string; params: any[] }[] = [];
    const boundLimits: number[] = [];
    const mockDb: any = {
      prepare(query: string) {
        const createObj = (boundArgs: any[] = []) => ({
          query,
          params: boundArgs,
          bind(...args: any[]) {
            return createObj(args);
          },
          async all() {
            if (query.includes("SELECT id, settings FROM profiles")) {
              return {
                results: [
                  { id: "p1", settings: "{}" },
                  { id: "p2", settings: "{}" }
                ]
              };
            }
            if (query.includes("SELECT timestamp, id FROM logs")) {
              const limit = Number(boundArgs[2] || 0);
              boundLimits.push(limit);
              return {
                results: Array.from({ length: limit }, (_, idx) => ({
                  timestamp: 1000 + idx,
                  id: idx + 1
                }))
              };
            }
            return { results: [] };
          },
          async first() {
            return null;
          },
          async run() {
            return { meta: { changes: 0 } };
          }
        });
        return createObj();
      },
      async batch(statements: any[]) {
        for (const s of statements) {
          executedQueries.push({ query: s.query, params: s.params });
        }
        return statements.map(() => ({ meta: { changes: 100 } }));
      }
    };

    const retentionModel = new LogRetentionModel(mockDb, mockSettingsModel);

    // Remaining budget = 20000 - 19800 = 200
    // Batch limit = 1000
    // Effective batch limit = min(1000, 200) = 200
    // 2 profiles -> perProfileLimit = 200 / 2 = 100
    await retentionModel.cleanupGlobal(30, 1000, 20000);

    assert.deepStrictEqual(boundLimits, [100, 100], "Should cap perProfileLimit to 100 based on remaining budget");
    const logDeleteStmts = executedQueries.filter(q => q.query.includes("DELETE FROM logs WHERE"));
    assert.strictEqual(logDeleteStmts.length, 2, "Should execute delete for both profiles");

    // Total deleted in batch: 2 statements * 100 changes = 200
    // Updated count in mockSettings: 19800 + 200 = 20000
    assert.strictEqual(mockSettings.log_cleanup_daily_count, "20000", "Should update daily deleted count to 20000");

    console.log("  Passed: Log deletions capped to remaining daily budget and counter persisted.");
  }

  // 6. Real SQLite test: bounded range deletion & E2EE plaintext-skip in aggregateHourlyRollups
  console.log("\n6. Testing real SQLite bounded log deletion and E2EE rollup scan skip...");
  {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      CREATE TABLE profiles (id TEXT PRIMARY KEY, settings TEXT);
      CREATE TABLE system_settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);
      CREATE TABLE logs (
        profile_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        id INTEGER NOT NULL,
        domain TEXT NOT NULL,
        record_type TEXT NOT NULL,
        action TEXT NOT NULL,
        client_ip TEXT,
        geo_country TEXT,
        dest_country_code TEXT,
        dest_country TEXT,
        dest_isp TEXT,
        dest_geoip TEXT,
        access_point_id TEXT,
        encrypt_version INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (profile_id, timestamp, id)
      );
      INSERT INTO profiles (id, settings) VALUES ('p_e2ee', '{}');
    `);

    const insertLog = sqlite.prepare(
      "INSERT INTO logs (profile_id, timestamp, id, domain, record_type, action, encrypt_version) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    // Insert 5 logs in completed hour 3600..7199 (including 2 sharing same timestamp 3600)
    insertLog.run("p_e2ee", 3600, 1, "", "A", "PASS", 2);
    insertLog.run("p_e2ee", 3600, 2, "", "A", "BLOCK", 2);
    insertLog.run("p_e2ee", 3700, 3, "", "A", "PASS", 2);
    insertLog.run("p_e2ee", 3800, 4, "", "A", "PASS", 2);
    insertLog.run("p_e2ee", 9000, 5, "", "A", "PASS", 2); // newer than cutoff

    const db = new NodeD1Database(sqlite);
    const aggModel = new LogAggregationModel(db);
    await aggModel.ensureRollupTables();
    await aggModel.aggregateHourlyRollups(3600, 7200, 1);

    const rollupRows = sqlite.prepare("SELECT metric_type, key, count FROM hourly_rollups WHERE profile_id = 'p_e2ee'").all() as { metric_type: string; key: string; count: number }[];
    assert(rollupRows.every((r) => r.metric_type === "action"), "Only action rollups should exist for E2EE-only hour");
    assert.strictEqual(rollupRows.find((r) => r.key === "PASS")?.count, 3);
    assert.strictEqual(rollupRows.find((r) => r.key === "BLOCK")?.count, 1);

    const coreModel = new LogCoreModel(db);
    const deleted = await coreModel.cleanup("p_e2ee", 7200, 2);
    assert.strictEqual(deleted, 2, "Bounded cleanup must delete exactly maxRows=2 oldest logs");

    const remainingIds = (sqlite.prepare("SELECT id FROM logs ORDER BY timestamp ASC, id ASC").all() as { id: number }[]).map((r) => r.id);
    assert.deepStrictEqual(remainingIds, [3, 4, 5], "Oldest two logs (id 1, 2) must be deleted while newer logs remain");
    console.log("  Passed: Bounded range deletion and E2EE rollup scan skip verified on real SQLite.");
  }

  // 7. Orphan hourly_rollups keyset cleanup (no NOT IN full-table scan)
  console.log("\n7. Testing orphan hourly_rollups keyset cleanup...");
  {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      CREATE TABLE profiles (id TEXT PRIMARY KEY, settings TEXT);
      CREATE TABLE system_settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);
      CREATE TABLE logs (
        profile_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        id INTEGER NOT NULL,
        domain TEXT NOT NULL,
        record_type TEXT NOT NULL,
        action TEXT NOT NULL,
        PRIMARY KEY (profile_id, timestamp, id)
      );
      CREATE TABLE kem_keys (id TEXT PRIMARY KEY, profile_id TEXT, kem_ct TEXT, created_at INTEGER, expires_at INTEGER);
      INSERT INTO profiles (id, settings) VALUES ('active_prof', '{"log_retention_days":7}');
    `);
    const db = new NodeD1Database(sqlite);
    const aggModel = new LogAggregationModel(db);
    await aggModel.ensureRollupTables();
    const recentHour = Math.floor(Date.now() / 1000 / 3600) * 3600 - 3600;
    sqlite.prepare(
      "INSERT INTO hourly_rollups (profile_id, metric_type, hour_timestamp, key, sub_key, access_point_id, count) VALUES (?, 'action', ?, 'PASS', '', '', 5)"
    ).run("active_prof", recentHour);
    sqlite.prepare(
      "INSERT INTO hourly_rollups (profile_id, metric_type, hour_timestamp, key, sub_key, access_point_id, count) VALUES (?, 'action', ?, 'PASS', '', '', 9)"
    ).run("orphan_prof", recentHour);

    const queriesExecuted: string[] = [];
    const trackedDb = {
      prepare(sql: string) {
        queriesExecuted.push(sql);
        return db.prepare(sql);
      },
      batch(stmts: any[]) {
        return db.batch(stmts);
      }
    } as any;

    const retentionModel = new LogRetentionModel(trackedDb);
    SystemSettingsModel.clearMemoryCache();
    await retentionModel.cleanupGlobal(30, 100, 20000);

    assert(
      !queriesExecuted.some((q) => q.includes("NOT IN (SELECT id FROM profiles)")),
      "Orphan cleanup must NOT use full-table NOT IN subquery"
    );
    assert(
      queriesExecuted.some((q) => q.includes("profile_id > ? ORDER BY profile_id ASC LIMIT 1")),
      "Orphan cleanup must step by clustered profile_id keyset cursor"
    );
    const remainingRollups = sqlite.prepare("SELECT profile_id FROM hourly_rollups").all() as { profile_id: string }[];
    assert.deepStrictEqual(remainingRollups.map((r) => r.profile_id), ["active_prof"]);
    console.log("  Passed: Orphan hourly_rollups deleted via keyset seeks without full-table scan.");
  }

  // 8. accessPointId uses hourly_rollups & E2EE short-circuits plaintext-only raw log scans
  console.log("\n8. Testing accessPointId rollup usage and E2EE raw scan short-circuit...");
  {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      CREATE TABLE user_log_keys (profile_id TEXT PRIMARY KEY, public_key TEXT, is_active INTEGER DEFAULT 1);
      CREATE TABLE logs (
        profile_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        id INTEGER NOT NULL,
        domain TEXT NOT NULL,
        record_type TEXT NOT NULL,
        action TEXT NOT NULL,
        client_ip TEXT,
        geo_country TEXT,
        dest_country_code TEXT,
        dest_country TEXT,
        dest_isp TEXT,
        dest_geoip TEXT,
        access_point_id TEXT,
        encrypt_version INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (profile_id, timestamp, id)
      );
      INSERT INTO user_log_keys (profile_id, public_key, is_active) VALUES ('e2ee_prof', '{}', 1);
    `);
    const db = new NodeD1Database(sqlite);
    const aggModel = new LogAggregationModel(db);
    await aggModel.ensureRollupTables();

    const nowSec = Math.floor(Date.now() / 1000);
    const prevHour = Math.floor(nowSec / 3600) * 3600 - 3600;
    const prev2Hour = prevHour - 3600;
    sqlite.prepare(
      "INSERT INTO hourly_rollups (profile_id, metric_type, hour_timestamp, key, sub_key, access_point_id, count) VALUES ('e2ee_prof', 'action', ?, 'PASS', '', 'ap_1', 42)"
    ).run(prevHour);
    sqlite.prepare(
      "INSERT INTO hourly_rollups (profile_id, metric_type, hour_timestamp, key, sub_key, access_point_id, count) VALUES ('e2ee_prof', 'action', ?, 'PASS', '', 'ap_2', 10)"
    ).run(prevHour);
    // Deliberately leave raw logs encrypted so any raw scan would show in query log
    sqlite.prepare(
      "INSERT INTO logs (profile_id, timestamp, id, domain, record_type, action, client_ip, access_point_id, encrypt_version) VALUES ('e2ee_prof', ?, 1, '[Encrypted]', 'A', 'PASS', '[Encrypted]', 'ap_1', 2)"
    ).run(prevHour + 10);

    const executedSqls: string[] = [];
    const spyingDb = {
      prepare(sql: string) {
        executedSqls.push(sql);
        return db.prepare(sql);
      }
    } as any;

    const analytics = new LogAnalyticsModel(spyingDb, aggModel);
    const summary = await analytics.getSummary("e2ee_prof", prev2Hour, prevHour + 3599, undefined, "ap_1");
    assert.strictEqual(summary.find((s) => s.action === "PASS")?.count, 42, "Summary for ap_1 must come accurately from hourly_rollups");
    const trend = await analytics.getTrend("e2ee_prof", prev2Hour, prevHour + 3599, "(timestamp/3600)*3600", "ap_1");
    assert.strictEqual(trend.find((t) => t.timestamp === prevHour)?.count, 42, "Trend for ap_1 must read from hourly_rollups");
    assert(
      !executedSqls.some((s) => s.includes("FROM logs")),
      "getSummary and getTrend with accessPointId inside rolled-up window must not touch raw logs"
    );

    executedSqls.length = 0;
    const [topAllowed, topBlocked, clients, destinations, isps] = await Promise.all([
      analytics.getTopAllowed("e2ee_prof", prev2Hour, nowSec),
      analytics.getTopBlocked("e2ee_prof", prev2Hour, nowSec),
      analytics.getClients("e2ee_prof", prev2Hour, nowSec),
      analytics.getDestinations("e2ee_prof", prev2Hour, nowSec),
      analytics.getISPByCountry("e2ee_prof", undefined, prev2Hour, nowSec)
    ]);
    assert.deepStrictEqual([topAllowed, topBlocked, clients, destinations, isps], [[], [], [], [], []]);
    assert(
      !executedSqls.some((s) => s.includes("FROM logs")),
      "E2EE active profile must short-circuit plaintext-only analytics without scanning raw logs"
    );
    console.log("  Passed: accessPointId reads rollups and E2EE skips raw plaintext-only log scans.");
  }

  console.log("\n>>> [TEST] All Log Deletion Budget & Domain Rollup Filter tests passed successfully!\n");
}

runTests().catch(err => {
  console.error(">>> [TEST ERROR]", err);
  process.exit(1);
});

/**
 * @file test_performance_and_runtime.ts
 * @description Unit tests for unified DNS_CACHE_SIZE, V8 engine tuning, cluster scaling,
 * SQLite concurrency maintenance, and multi-runtime execution coordination.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  dnsCache,
  bloomMemoryMap,
  configCache,
  DEFAULT_DNS_CACHE_SIZE,
  syncDnsCacheSize,
  SizeCappedMap
} from '../src/pipeline/cache';
import { tuneV8Engine } from '../src/serverfull/v8';
import { getClusterInfo } from '../src/serverfull/cluster';
import { NodeD1Database } from '../src/serverfull/db';
import { attachStaticAssetHandler } from '../src/serverfull/http/assets';
import { getActiveRuntimeDescription, handleRuntimeSwitch } from '../src/serverfull/commands/checkEnv';
import { getServerfullConfig } from '../src/serverfull/config';

console.log('================================================================');
console.log('   High-Performance Runtime, Cache & Concurrency Test Suite     ');
console.log('================================================================\n');

// 1. Validate DEFAULT_DNS_CACHE_SIZE and SizeCappedMap
console.log('1. Validating unified DNS_CACHE_SIZE and default 20k capacity...');
if (DEFAULT_DNS_CACHE_SIZE !== 20000) {
  throw new Error(`Expected DEFAULT_DNS_CACHE_SIZE = 20000, got ${DEFAULT_DNS_CACHE_SIZE}`);
}
if (dnsCache.getMaxEntries() !== 20000) {
  throw new Error(`Expected initial dnsCache capacity 20000, got ${dnsCache.getMaxEntries()}`);
}
console.log('   ✓ Default 20,000 DNS cache capacity verified.');

// 2. Validate dynamic syncDnsCacheSize
console.log('2. Validating dynamic syncDnsCacheSize with custom Env values...');
syncDnsCacheSize({ DNS_CACHE_SIZE: 35000 } as any);
if (dnsCache.getMaxEntries() !== 35000) {
  throw new Error(`Expected dnsCache capacity 35000, got ${dnsCache.getMaxEntries()}`);
}

// Reset back to 20k
syncDnsCacheSize({ DNS_CACHE_SIZE: 20000 } as any);
if (dnsCache.getMaxEntries() !== 20000) {
  throw new Error(`Expected dnsCache capacity 20000, got ${dnsCache.getMaxEntries()}`);
}

// Test SizeCappedMap LRU eviction behavior
const testMap = new SizeCappedMap<string, number>(3);
testMap.set('a', 1);
testMap.set('b', 2);
testMap.set('c', 3);
testMap.set('d', 4); // should evict 'a'
if (testMap.has('a') || !testMap.has('b') || !testMap.has('d')) {
  throw new Error('SizeCappedMap failed to evict oldest entry on overflow');
}
testMap.setMaxEntries(2); // should evict 'b'
if (testMap.size !== 2 || testMap.has('b') || !testMap.has('c') || !testMap.has('d')) {
  throw new Error('SizeCappedMap failed to downsize properly on setMaxEntries');
}
console.log('   ✓ Dynamic cache resizing and LRU eviction verified.');

// 3. Validate tuneV8Engine execution
console.log('3. Validating V8 engine tuning...');
tuneV8Engine();
console.log('   ✓ V8 engine runtime tuning executed successfully.');

// 4. Validate Cluster info resolution
console.log('4. Validating multi-core cluster info resolution...');
const singleCluster = getClusterInfo(1);
if (singleCluster.workersCount !== 1) {
  throw new Error(`Expected workersCount = 1, got ${singleCluster.workersCount}`);
}

const multiCluster = getClusterInfo(4);
const isBun = Boolean((process.versions as Record<string, string | undefined>).bun);
if (!isBun && multiCluster.workersCount !== 4) {
  throw new Error(`Expected workersCount = 4 under Node, got ${multiCluster.workersCount}`);
}
console.log(`   ✓ Cluster worker count verified (Node/Bun auto-adaptive: ${multiCluster.workersCount} workers).`);

// 5. Validate SQLite concurrency maintenance (checkpoint & optimize)
console.log('5. Validating SQLite WAL checkpoint and PRAGMA optimize...');
const tempDb = new DatabaseSync(':memory:');
tempDb.exec('PRAGMA foreign_keys = ON;');
tempDb.exec('CREATE TABLE test_perf (id INTEGER PRIMARY KEY, name TEXT);');
tempDb.exec("INSERT INTO test_perf (name) VALUES ('alpha'), ('beta');");

const nodeD1 = new NodeD1Database(tempDb, ':memory:');
// Verify checkpoint does not throw on in-memory or WAL db
nodeD1.checkpoint('PASSIVE');
nodeD1.checkpoint('TRUNCATE');
// Verify optimize executes successfully
nodeD1.optimize();
nodeD1.close();
console.log('   ✓ SQLite PRAGMA wal_checkpoint and PRAGMA optimize verified.');

// 6. Validate Runtime description and switching
console.log('6. Validating active runtime description and switcher...');
const runtimeDesc = getActiveRuntimeDescription();
if (!runtimeDesc.includes('v') || (!runtimeDesc.includes('Node.js') && !runtimeDesc.includes('Bun'))) {
  throw new Error(`Unexpected runtime description: ${runtimeDesc}`);
}
console.log(`   ✓ Active runtime description: ${runtimeDesc}`);

const noSwitch = handleRuntimeSwitch(isBun ? 'bun' : 'node');
if (noSwitch) {
  throw new Error('handleRuntimeSwitch should not switch when target matches the active runtime');
}
console.log('   ✓ Runtime switch guard verified.');

// 7. Validate CLI configuration parsing for workers and cache size
console.log('7. Validating ServerfullConfig workers & dnsCacheSize resolution...');
const { config, env } = getServerfullConfig({
  workers: '4',
  'dns-cache-size': '25000'
} as any);

if (config.workers !== 4) {
  throw new Error(`Expected config.workers = 4, got ${config.workers}`);
}
if (config.dnsCacheSize !== 25000) {
  throw new Error(`Expected config.dnsCacheSize = 25000, got ${config.dnsCacheSize}`);
}
if (env.DNS_CACHE_SIZE !== 25000) {
  throw new Error(`Expected env.DNS_CACHE_SIZE = 25000, got ${env.DNS_CACHE_SIZE}`);
}
console.log('   ✓ CLI options and environment mapping verified.');

// 8. Validate Serverfull vs Workers bloomMemoryMap & configCache scaling
console.log('8. Validating Serverfull vs Workers Bloom & Config cache capacity scaling...');
syncDnsCacheSize({ DATABASE_SERVICE: 'D1' } as any);
if (bloomMemoryMap.getMaxEntries() !== 3 || configCache.getMaxEntries() !== 200) {
  throw new Error(`Expected Workers limits (3 / 200), got (${bloomMemoryMap.getMaxEntries()} / ${configCache.getMaxEntries()})`);
}
syncDnsCacheSize({ SERVERFULL_DB_PATH: ':memory:', DATABASE_SERVICE: 'File' } as any);
if (bloomMemoryMap.getMaxEntries() !== 32 || configCache.getMaxEntries() !== 500) {
  throw new Error(`Expected Serverfull limits (32 / 500), got (${bloomMemoryMap.getMaxEntries()} / ${configCache.getMaxEntries()})`);
}
syncDnsCacheSize({ SERVERFULL_DB_PATH: ':memory:', BLOOM_CACHE_SIZE: 48 } as any);
if (bloomMemoryMap.getMaxEntries() !== 48) {
  throw new Error(`Expected custom BLOOM_CACHE_SIZE 48, got ${bloomMemoryMap.getMaxEntries()}`);
}
console.log('   ✓ Bloom & Config cache runtime capacity scaling verified.');

// 9. Validate NodeD1Database StatementSync LRU caching and exec() invalidation
console.log('9. Validating NodeD1Database prepared statement caching...');
async function runAsyncPerfChecks() {
  const cachedDb = new DatabaseSync(':memory:');
  cachedDb.exec('CREATE TABLE kv_stmt (k TEXT PRIMARY KEY, v TEXT);');
  let prepareCalls = 0;
  const origPrepare = cachedDb.prepare.bind(cachedDb);
  (cachedDb as any).prepare = (sql: string) => {
    prepareCalls++;
    return origPrepare(sql);
  };
  const d1 = new NodeD1Database(cachedDb, ':memory:');
  await d1.prepare('INSERT INTO kv_stmt (k, v) VALUES (?, ?)').bind('k1', 'v1').run();
  await d1.prepare('INSERT INTO kv_stmt (k, v) VALUES (?, ?)').bind('k2', 'v2').run();
  assert.strictEqual(prepareCalls, 1, `Expected 1 prepare() call for repeated INSERT SQL, got ${prepareCalls}`);
  const row1 = await d1.prepare('SELECT v FROM kv_stmt WHERE k = ?').bind('k1').first<{ v: string }>();
  const row2 = await d1.prepare('SELECT v FROM kv_stmt WHERE k = ?').bind('k2').first<{ v: string }>();
  assert.strictEqual(row1?.v, 'v1');
  assert.strictEqual(row2?.v, 'v2');
  assert.strictEqual(prepareCalls, 2, `Expected cached SELECT statement reuse (prepareCalls=${prepareCalls})`);
  await d1.exec('SELECT 1');
  await d1.prepare('SELECT v FROM kv_stmt WHERE k = ?').bind('k1').first<{ v: string }>();
  assert.strictEqual(prepareCalls, 3, `Expected exec() to clear statement cache (prepareCalls=${prepareCalls})`);
  d1.close();
  console.log('   ✓ NodeD1Database StatementSync LRU caching verified.');

  // 10. Validate Serverfull static asset cache + ETag / 304
  console.log('10. Validating static asset memory cache & ETag / 304 Not Modified...');
  const assetTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dns-worker-assets-'));
  try {
    fs.mkdirSync(path.join(assetTmpDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(assetTmpDir, 'assets', 'app-123.js'), 'console.log("ok");');
    const mockAssetEnv: any = {};
    attachStaticAssetHandler(mockAssetEnv, assetTmpDir);

    const firstRes = await mockAssetEnv.ASSETS.fetch(new Request('http://127.0.0.1/assets/app-123.js'));
    if (firstRes.status !== 200) {
      throw new Error(`Expected 200 for first static asset request, got ${firstRes.status}`);
    }
    const etag = firstRes.headers.get('ETag');
    if (!etag) {
      throw new Error('Expected ETag header on static asset response');
    }
    // Delete file on disk to prove immutable /assets/* serves directly from memory cache
    fs.unlinkSync(path.join(assetTmpDir, 'assets', 'app-123.js'));
    const cachedRes = await mockAssetEnv.ASSETS.fetch(new Request('http://127.0.0.1/assets/app-123.js'));
    if (cachedRes.status !== 200 || (await cachedRes.text()) !== 'console.log("ok");') {
      throw new Error('Expected immutable static asset to serve from memory cache');
    }
    const notModRes = await mockAssetEnv.ASSETS.fetch(
      new Request('http://127.0.0.1/assets/app-123.js', { headers: { 'If-None-Match': etag } })
    );
    if (notModRes.status !== 304) {
      throw new Error(`Expected 304 Not Modified for matching If-None-Match, got ${notModRes.status}`);
    }
    console.log('   ✓ Static asset memory cache and ETag 304 verified.');
  } finally {
    fs.rmSync(assetTmpDir, { recursive: true, force: true });
  }
}

runAsyncPerfChecks()
  .then(() => {
    console.log('\n================================================================');
    console.log('   ALL HIGH-PERFORMANCE RUNTIME TESTS PASSED!                   ');
    console.log('================================================================\n');
  })
  .catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });

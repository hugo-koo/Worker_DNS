/**
 * @file test_bun_compat.ts
 * @description Comprehensive compatibility test suite for running Serverfull mode
 * on both Bun (>= 1.4.0) and Node.js (>= 22.5.0) with progressive auto-switch and fallback.
 */

import assert from 'node:assert';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import zlib from 'node:zlib';
import {
  isCompatibleBunVersion,
  stripRuntimeFlags,
  resolveRuntimeSwitchPlan,
  getActiveRuntimeDescription,
  probeRuntimeBinary,
  type RuntimeProbeResult
} from '../src/serverfull/commands/checkEnv';
import { tuneV8Engine } from '../src/serverfull/v8';
import { getClusterInfo } from '../src/serverfull/cluster';
import { generateSystemdUnit } from '../src/serverfull/service/systemd';
import { initNodeGlobals } from '../src/serverfull/cache';
import { initServerfullDb } from '../src/serverfull/db';
import { UdpDnsServer } from '../src/serverfull/udp';
import { DotDnsServer } from '../src/serverfull/dot';
import { HttpServer, HttpsServer } from '../src/serverfull/http';
import { ServerfullSnapshotManager } from '../src/serverfull/snapshot';
import { buildDNSQuery, parseDNSAnswer } from '../src/utils/dns';
import { Env } from '../src/types';

function testRuntimeSelectionAndFallback(): void {
  console.log('1. Testing Bun semver validation, arg stripping, and progressive fallback plan...');

  assert.strictEqual(isCompatibleBunVersion('1.4.0'), true);
  assert.strictEqual(isCompatibleBunVersion('v1.4.5'), true);
  assert.strictEqual(isCompatibleBunVersion('1.5.0-canary.1'), true);
  assert.strictEqual(isCompatibleBunVersion('2.0.0'), true);
  assert.strictEqual(isCompatibleBunVersion('1.3.12'), false);
  assert.strictEqual(isCompatibleBunVersion('0.8.5'), false);
  assert.strictEqual(isCompatibleBunVersion('invalid'), false);

  assert.deepStrictEqual(
    stripRuntimeFlags(['dist/serverfull.mjs', '--runtime', 'bun', '--port', '3000']),
    ['dist/serverfull.mjs', '--port', '3000']
  );
  assert.deepStrictEqual(
    stripRuntimeFlags(['dist/serverfull.mjs', '--runtime=node', 'status']),
    ['dist/serverfull.mjs', 'status']
  );
  assert.deepStrictEqual(
    stripRuntimeFlags(['dist/serverfull.mjs', '--runtime', '--status']),
    ['dist/serverfull.mjs', '--status']
  );

  const mockBunOk: RuntimeProbeResult = { executable: 'bun', version: '1.4.5', compatible: true };
  const mockBunOld: RuntimeProbeResult = { executable: 'bun', version: '1.3.8', compatible: false };
  const mockNodeOk: RuntimeProbeResult = { executable: 'node', version: '24.2.0', compatible: true };

  // Default ('auto') under Node prefers Bun >= 1.4.0
  const autoPreferBun = resolveRuntimeSwitchPlan(undefined, {
    versions: { node: '24.2.0' },
    env: {},
    argv: ['dist/serverfull.mjs', 'status'],
    probeBinary: (rt) => (rt === 'bun' ? mockBunOk : mockNodeOk)
  });
  assert.strictEqual(autoPreferBun.action, 'switch');
  assert.strictEqual(autoPreferBun.executable, mockBunOk.executable);
  assert.strictEqual(autoPreferBun.reason, 'auto-prefer-bun');

  // Auto stays on Node when explicit multi-worker clustering (>1) is requested
  const autoMultiWorker = resolveRuntimeSwitchPlan('auto', {
    versions: { node: '24.2.0' },
    env: {},
    workers: '4',
    argv: ['dist/serverfull.mjs', '-w', '4'],
    probeBinary: () => mockBunOk
  });
  assert.strictEqual(autoMultiWorker.action, 'keep');
  assert.strictEqual(autoMultiWorker.reason, 'multi-worker-node-preferred');

  // Explicit --runtime bun overrides even with workers=4
  const explicitBunMultiWorker = resolveRuntimeSwitchPlan('bun', {
    versions: { node: '24.2.0' },
    env: {},
    workers: '4',
    argv: ['dist/serverfull.mjs', '--runtime', 'bun', '-w', '4'],
    probeBinary: () => mockBunOk
  });
  assert.strictEqual(explicitBunMultiWorker.action, 'switch');
  assert.strictEqual(explicitBunMultiWorker.reason, 'explicit-bun');
  assert.deepStrictEqual(explicitBunMultiWorker.cleanArgs, ['dist/serverfull.mjs', '-w', '4']);

  // Fallback to Node when Bun is outdated (< 1.4.0)
  const autoOutdatedBun = resolveRuntimeSwitchPlan(undefined, {
    versions: { node: '24.2.0' },
    env: {},
    argv: ['dist/serverfull.mjs'],
    probeBinary: () => mockBunOld
  });
  assert.strictEqual(autoOutdatedBun.action, 'keep');
  assert.strictEqual(autoOutdatedBun.reason, 'bun-outdated-fallback-node');

  // Fallback to Node when Bun binary is missing
  const autoMissingBun = resolveRuntimeSwitchPlan(undefined, {
    versions: { node: '24.2.0' },
    env: {},
    argv: ['dist/serverfull.mjs'],
    probeBinary: () => null
  });
  assert.strictEqual(autoMissingBun.action, 'keep');
  assert.strictEqual(autoMissingBun.reason, 'bun-missing-fallback-node');

  // Explicit --runtime node keeps Node or switches back from Bun
  const forceNodeOnNode = resolveRuntimeSwitchPlan('node', {
    versions: { node: '24.2.0' },
    env: {},
    probeBinary: () => mockBunOk
  });
  assert.strictEqual(forceNodeOnNode.action, 'keep');
  assert.strictEqual(forceNodeOnNode.reason, 'already-node');

  const forceNodeOnBun = resolveRuntimeSwitchPlan('node', {
    versions: { node: '24.3.0', bun: '1.4.5' },
    env: {},
    argv: ['dist/serverfull.mjs', '--runtime', 'node'],
    probeBinary: (rt) => (rt === 'node' ? mockNodeOk : mockBunOk)
  });
  assert.strictEqual(forceNodeOnBun.action, 'switch');
  assert.strictEqual(forceNodeOnBun.executable, mockNodeOk.executable);
  assert.strictEqual(forceNodeOnBun.reason, 'explicit-node-from-bun');

  // Env recursion guard prevents infinite spawn loops
  const guarded = resolveRuntimeSwitchPlan('bun', {
    versions: { node: '24.2.0' },
    env: { DNS_WORKER_SWITCHED_RUNTIME: '1' },
    probeBinary: () => mockBunOk
  });
  assert.strictEqual(guarded.action, 'keep');
  assert.strictEqual(guarded.reason, 'already-switched');

  // Unknown runtime falls back safely
  const unknownRt = resolveRuntimeSwitchPlan('deno', {
    versions: { node: '24.2.0' },
    env: {},
    probeBinary: () => mockBunOk
  });
  assert.strictEqual(unknownRt.action, 'keep');
  assert.strictEqual(unknownRt.reason, 'unknown-runtime');

  console.log('   ✓ Runtime selection and fallback matrix passed.');
}

function testRuntimeSpecificHelpers(): void {
  console.log('2. Testing runtime description, V8/cluster guards, and systemd generation...');

  tuneV8Engine();
  const isBun = Boolean((process.versions as Record<string, string | undefined>).bun);
  const desc = getActiveRuntimeDescription();
  assert(
    isBun ? desc.startsWith('Bun v') && desc.includes('JavaScriptCore') : desc.startsWith('Node.js v') && desc.includes('V8'),
    `Unexpected active runtime description: ${desc}`
  );

  const clusterInfo = getClusterInfo(4);
  assert.strictEqual(clusterInfo.workersCount, isBun ? 1 : 4);

  const bunSystemd = generateSystemdUnit({
    execCmd: 'bun /opt/dns-worker/dist/serverfull.mjs',
    nodePath: '/home/u/.bun/bin/bun',
    scriptPath: '/opt/dns-worker/dist/serverfull.mjs',
    workDir: '/opt/dns-worker',
    user: 'dnsworker'
  });
  assert(!bunSystemd.includes('NODE_OPTIONS='), 'Bun systemd unit should omit V8 NODE_OPTIONS');
  assert(bunSystemd.includes('ExecStart=bun /opt/dns-worker/dist/serverfull.mjs'), 'Bun systemd unit must contain bare bun ExecStart');

  const nodeSystemd = generateSystemdUnit({
    execCmd: 'node /opt/dns-worker/dist/serverfull.mjs',
    nodePath: '/home/dnsworker/.nvm/versions/node/v24.21.0/bin/node',
    scriptPath: '/opt/dns-worker/dist/serverfull.mjs',
    workDir: '/opt/dns-worker',
    user: 'dnsworker'
  });
  assert(nodeSystemd.includes('ExecStart=node /opt/dns-worker/dist/serverfull.mjs'), 'Node systemd unit must contain bare node ExecStart');
  assert(nodeSystemd.includes('Environment="NODE_OPTIONS=--max-semi-space-size=64"'), 'Node systemd unit must use valid NODE_OPTIONS');
  assert(!nodeSystemd.includes('--turbo-fast-api-calls'), 'NODE_OPTIONS must omit --turbo-fast-api-calls (Node exit code 9)');
  assert(nodeSystemd.includes('Environment="PATH=/home/dnsworker/.bun/bin:/usr/local/sbin:/usr/local/bin:'), 'Systemd unit must preserve standard PATH with ~/.bun/bin');
  assert(!nodeSystemd.includes('/home/dnsworker/.nvm/'), 'Systemd unit must not hardcode NVM paths');

  console.log(`   ✓ Helpers verified under active runtime: ${desc}.`);
}

async function testServerfullTransportsAndSnapshot(): Promise<void> {
  console.log('3. Testing UDP DNS, DoT, HTTP/HTTPS (H1+H2), and Zstd snapshot subprocess...');

  initNodeGlobals();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dns-worker-bun-compat-'));
  const dbPath = path.join(tmpDir, 'compat.sqlite');
  const db = initServerfullDb(dbPath);

  const now = Math.floor(Date.now() / 1000);
  await db.prepare('INSERT INTO users (id, username, hashed_password, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind('u1', 'compatadmin', 'hash', 'admin', now).run();
  await db.prepare('INSERT INTO profiles (id, name, settings, owner_id, profile_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind('p1', 'Compat Profile', JSON.stringify({ default_policy: 'ALLOW' }), 'u1', 'compatkey1', now, now).run();
  await db.prepare('INSERT INTO rules (profile_id, type, pattern, record_type) VALUES (?, ?, ?, ?)')
    .bind('p1', 'BLOCK', 'blocked.compat.test', 'A').run();

  const snapshotDir = path.join(tmpDir, 'snapshots');
  const env: Env = {
    DB: db as unknown as Env['DB'],
    ASSETS: null as unknown as Env['ASSETS'],
    JWT_SECRET: 'compat_test_jwt_secret_000000000000',
    DATABASE_SERVICE: 'File',
    SERVERFULL_DB_PATH: dbPath,
    SERVERFULL_SNAPSHOT_DIR: snapshotDir,
    SERVERFULL_DEFAULT_PROFILE_KEY: 'compatkey1',
    SERVERFULL_DOT_DOMAIN: 'dns.local'
  };

  const udpPort = 15453;
  const dotPort = 18953;
  const httpPort = 23400;
  const httpsPort = 24543;
  const keyPath = path.join(process.cwd(), 'test', 'fixtures', 'tls', 'test_key.pem');
  const certPath = path.join(process.cwd(), 'test', 'fixtures', 'tls', 'test_cert.pem');

  const udpServer = new UdpDnsServer({ port: udpPort, host: '127.0.0.1', defaultProfileKey: 'compatkey1', env });
  const dotServer = new DotDnsServer({
    port: dotPort,
    host: '127.0.0.1',
    tlsKeyPath: keyPath,
    tlsCertPath: certPath,
    defaultProfileKey: 'compatkey1',
    dotDomain: 'dns.local',
    env
  });
  const httpServer = new HttpServer({ port: httpPort, host: '127.0.0.1', env });
  const httpsServer = new HttpsServer({ port: httpsPort, host: '127.0.0.1', certPath, keyPath, env });

  await udpServer.start();
  await dotServer.start();
  await httpServer.start();
  await httpsServer.start();

  try {
    // 3a. UDP DNS blocked query (0.0.0.0 local resolution without needing external internet)
    const udpResp = await new Promise<Buffer>((resolve, reject) => {
      const client = dgram.createSocket('udp4');
      const query = buildDNSQuery('blocked.compat.test', 'A');
      const timer = setTimeout(() => {
        try { client.close(); } catch {}
        reject(new Error('UDP query timed out'));
      }, 4000);
      client.once('message', (msg) => {
        clearTimeout(timer);
        client.close();
        resolve(msg);
      });
      client.send(query, udpPort, '127.0.0.1', (err) => {
        if (err) {
          clearTimeout(timer);
          try { client.close(); } catch {}
          reject(err);
        }
      });
    });
    const parsedUdp = parseDNSAnswer(new Uint8Array(udpResp));
    assert(parsedUdp.some((a) => a.data === '0.0.0.0'), 'UDP server must return 0.0.0.0 for blocked rule');

    // 3b. Plain HTTP API response
    const httpStatus = await new Promise<number>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${httpPort}/api/status`, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
    });
    assert(httpStatus >= 200 && httpStatus < 500, `Unexpected HTTP status: ${httpStatus}`);

    // 3c. HTTPS HTTP/1.1 + HTTP/2 (ALPN) using pinned test CA certificate
    const tlsCaPem = fs.readFileSync(certPath);
    const httpsH1Status = await new Promise<number>((resolve, reject) => {
      const req = https.get(
        `https://127.0.0.1:${httpsPort}/api/status`,
        {
          ca: tlsCaPem,
          servername: 'dns.local',
          checkServerIdentity: (_host, cert) => tls.checkServerIdentity('dns.local', cert)
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );
      req.on('error', reject);
    });
    assert(httpsH1Status >= 200 && httpsH1Status < 500, `Unexpected HTTPS H1 status: ${httpsH1Status}`);

    const h2Status = await new Promise<number>((resolve, reject) => {
      const client = http2.connect(`https://127.0.0.1:${httpsPort}`, {
        ca: tlsCaPem,
        servername: 'dns.local',
        checkServerIdentity: (_host, cert) => tls.checkServerIdentity('dns.local', cert)
      });
      client.on('error', reject);
      const req = client.request({ ':path': '/api/status', ':method': 'GET' });
      req.on('response', (headers) => {
        const status = Number(headers[':status'] ?? 0);
        req.resume();
        client.close();
        resolve(status);
      });
      req.on('error', reject);
      req.end();
    });
    assert(h2Status >= 200 && h2Status < 500, `Unexpected HTTP/2 status: ${h2Status}`);

    // 3d. Zstd Snapshot capture subprocess under active runtime (Bun or Node)
    if (typeof zlib.createZstdCompress === 'function') {
      const manager = new ServerfullSnapshotManager(env);
      const started = await manager.startCapture();
      assert.ok(started.id);

      let snapshots = manager.pruneAndListSnapshots();
      const deadline = Date.now() + 15000;
      while (snapshots.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 150));
        const overview = await manager.getOverview();
        snapshots = overview.snapshots;
        if (snapshots.length === 0 && !overview.activeCapture) {
          throw new Error('Snapshot capture ended without producing a snapshot');
        }
      }
      assert(snapshots.length >= 1, 'Snapshot capture subprocess must produce a completed .sqlite.zst archive');

      const zstPath = path.join(snapshotDir, snapshots[0].filename);
      const compressed = fs.readFileSync(zstPath);
      const decompressed = zlib.zstdDecompressSync(compressed);
      assert(decompressed.subarray(0, 15).toString('utf-8') === 'SQLite format 3', 'Decompressed snapshot must be a valid SQLite header');
    }

    console.log('   ✓ UDP, DoT startup, HTTP/HTTPS (H1 & H2), and Zstd snapshot subprocess passed.');
  } finally {
    await Promise.all([
      udpServer.stop(),
      dotServer.stop(),
      httpServer.stop(),
      httpsServer.stop()
    ]);
    try { db.rawDb.close(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

async function run(): Promise<void> {
  console.log('================================================================');
  console.log('   Bun & Dual-Runtime Compatibility Test Suite                  ');
  console.log('================================================================\n');

  testRuntimeSelectionAndFallback();
  testRuntimeSpecificHelpers();
  await testServerfullTransportsAndSnapshot();

  // Optional sanity log on live machine PATH probe (never uses hardcoded absolute user paths)
  const liveBun = probeRuntimeBinary('bun');
  if (liveBun) {
    assert.strictEqual(liveBun.executable, 'bun', 'probeRuntimeBinary must resolve command name "bun" from PATH');
  }
  console.log(`   ℹ Live Bun probe on PATH: ${liveBun ? `${liveBun.executable} (v${liveBun.version}, compatible=${liveBun.compatible})` : 'not in PATH'}`);

  console.log('\n[PASS] All Bun & dual-runtime compatibility tests passed!');
}

run().catch((err) => {
  console.error('[FAIL] Bun compatibility tests failed:', err);
  process.exit(1);
});

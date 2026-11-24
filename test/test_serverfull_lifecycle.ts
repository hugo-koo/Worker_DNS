/**
 * @file test_serverfull_lifecycle.ts
 * @description Tests Serverfull 3-channel release checks, environment detection,
 * graceful restart coordination, and /api/admin/runtime REST endpoints.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import type { D1Database } from '@cloudflare/workers-types';
import {
  buildChannelUpdateCommand,
  detectReleaseChannel,
  detectServerfullEnvironment,
  ServerfullLifecycleManager,
} from '../src/serverfull/lifecycle';
import { handleAdminRequest } from '../src/api/account/admin';
import type { Env, ExecutionContext, ServerfullLifecycleBridge, User } from '../src/types';

function createMockCtx(): ExecutionContext {
  return {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
}

const ADMIN_USER: User = {
  id: 'admin-1',
  username: 'admin',
  role: 'admin',
};

function testReleaseChannelDetection(): void {
  assert.equal(detectReleaseChannel('1.3.5'), 'latest');
  assert.equal(detectReleaseChannel('1.3.5-alpha.abc1234'), 'alpha');
  assert.equal(detectReleaseChannel('1.3.5-alpha'), 'alpha');
  assert.equal(detectReleaseChannel('1.3.5-canary.def5678'), 'canary');
  assert.equal(detectReleaseChannel('1.3.5-canary'), 'canary');
}

function testEnvironmentDetectionAndCommands(): void {
  // 1. Linux systemd + npm global install
  const systemdEnv = detectServerfullEnvironment({
    platform: 'linux',
    env: { INVOCATION_ID: '1234567890abcdef' },
    packageRoot: '/usr/lib/node_modules/dns-worker',
    existsSync: () => false,
  });
  assert.equal(systemdEnv.serviceManager, 'systemd');
  assert.equal(systemdEnv.installMethod, 'npm-global');
  assert.equal(systemdEnv.canRestart, true);
  assert.equal(systemdEnv.restartReason, null);
  assert.equal(
    buildChannelUpdateCommand('alpha', systemdEnv.installMethod, systemdEnv.serviceManager),
    'npm i -g dns-worker@alpha && dns-worker service restart'
  );

  // 2. Docker container detected via /.dockerenv
  const dockerEnv = detectServerfullEnvironment({
    platform: 'linux',
    env: {},
    packageRoot: '/app',
    existsSync: (p: string) => p === '/.dockerenv',
  });
  assert.equal(dockerEnv.serviceManager, 'docker');
  assert.equal(dockerEnv.installMethod, 'docker');
  assert.equal(dockerEnv.canRestart, true);
  assert.equal(
    buildChannelUpdateCommand('canary', dockerEnv.installMethod, dockerEnv.serviceManager),
    'docker pull hugokoo/dns-worker:canary'
  );

  // 3. Windows Task Scheduler (no auto-restart loop)
  const schtasksEnv = detectServerfullEnvironment({
    platform: 'win32',
    env: { USERNAME: 'SYSTEM', USERDOMAIN: 'NT AUTHORITY', ProgramData: 'C:\\ProgramData' },
    packageRoot: 'C:\\Users\\Administrator\\AppData\\Roaming\\npm\\node_modules\\dns-worker',
    argv1: 'C:\\Users\\Administrator\\AppData\\Roaming\\npm\\node_modules\\dns-worker\\dist\\serverfull.mjs',
    cwd: 'C:\\ProgramData\\DNS-Worker',
    existsSync: () => false,
  });
  assert.equal(schtasksEnv.serviceManager, 'schtasks');
  assert.equal(schtasksEnv.installMethod, 'npm-global');
  assert.equal(schtasksEnv.canRestart, false);
  assert.equal(schtasksEnv.restartReason, 'windows_no_auto_restart');
  assert.equal(
    buildChannelUpdateCommand('latest', schtasksEnv.installMethod, schtasksEnv.serviceManager),
    'npm i -g dns-worker@latest && dns-worker service restart'
  );

  // 4. Source checkout (unmanaged process)
  const sourceRoot = path.join('/workspace', 'DNS-Worker');
  const sourceEnv = detectServerfullEnvironment({
    platform: 'linux',
    env: {},
    packageRoot: sourceRoot,
    existsSync: (p: string) => path.normalize(p) === path.normalize(path.join(sourceRoot, '.git')),
  });
  assert.equal(sourceEnv.serviceManager, 'none');
  assert.equal(sourceEnv.installMethod, 'source');
  assert.equal(sourceEnv.canRestart, false);
  assert.equal(sourceEnv.restartReason, 'unmanaged_process');
  assert.equal(
    buildChannelUpdateCommand('latest', sourceEnv.installMethod, sourceEnv.serviceManager),
    'git pull origin main && npm run build:serverfull'
  );
  assert.equal(
    buildChannelUpdateCommand('canary', sourceEnv.installMethod, sourceEnv.serviceManager),
    'git pull origin dev && npm run build:serverfull'
  );
}

async function testLifecycleManagerCachingAndRestart(): Promise<void> {
  let fetchCount = 0;
  let shouldFailFetch = false;
  let restartCallbackCalls = 0;

  const manager = new ServerfullLifecycleManager({
    currentVersion: '1.3.5',
    startedAt: 1700000000,
    runtime: 'Node.js v24.0.0',
    packageRoot: '/usr/lib/node_modules/dns-worker',
    workersCount: 2,
    cacheTtlSec: 300,
    envInfo: {
      platform: 'linux',
      installMethod: 'npm-global',
      serviceManager: 'systemd',
      canRestart: true,
      restartReason: null,
    },
    onRestart: () => {
      restartCallbackCalls += 1;
    },
    fetchFn: (async () => {
      fetchCount += 1;
      if (shouldFailFetch) {
        throw new Error('ECONNREFUSED registry');
      }
      return new Response(
        JSON.stringify({
          latest: '1.3.5',
          alpha: '1.3.5-alpha.1112223',
          canary: '1.3.5-canary.9998887',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch,
  });

  // First fetch populates cache (only active channel reports updateAvailable)
  const status1 = await manager.getStatus();
  assert.equal(fetchCount, 1);
  assert.equal(status1.supported, true);
  assert.equal(status1.currentChannel, 'latest');
  assert.equal(status1.checkError, null);
  assert.equal(status1.channels.latest.version, '1.3.5');
  assert.equal(status1.channels.latest.updateAvailable, false);
  assert.equal(status1.channels.alpha.version, '1.3.5-alpha.1112223');
  assert.equal(status1.channels.alpha.updateAvailable, false);
  assert.equal(status1.channels.canary.version, '1.3.5-canary.9998887');
  assert.equal(status1.channels.canary.updateAvailable, false);

  // Canary installation only flags updates on canary channel, never on latest/alpha
  const canaryManager = new ServerfullLifecycleManager({
    currentVersion: '1.3.5-canary.0000001',
    startedAt: 1700000000,
    runtime: 'Node.js v24.0.0',
    packageRoot: '/usr/lib/node_modules/dns-worker',
    workersCount: 1,
    envInfo: {
      platform: 'linux',
      installMethod: 'npm-global',
      serviceManager: 'systemd',
      canRestart: true,
      restartReason: null,
    },
    onRestart: () => {},
    fetchFn: (async () =>
      new Response(
        JSON.stringify({
          latest: '1.3.5',
          alpha: '1.3.5-alpha.1112223',
          canary: '1.3.5-canary.9998887',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )) as typeof fetch,
  });
  const canaryStatus = await canaryManager.getStatus();
  assert.equal(canaryStatus.currentChannel, 'canary');
  assert.equal(canaryStatus.channels.latest.updateAvailable, false);
  assert.equal(canaryStatus.channels.alpha.updateAvailable, false);
  assert.equal(canaryStatus.channels.canary.updateAvailable, true);

  // Second call within TTL uses cache
  await manager.getStatus();
  assert.equal(fetchCount, 1);

  // forceRefresh hits registry again and returns a safe generic error while keeping stale tags
  shouldFailFetch = true;
  const statusErr = await manager.getStatus({ forceRefresh: true });
  assert.equal(fetchCount, 2);
  assert.equal(statusErr.checkError, 'Failed to reach npm registry');
  assert.equal(statusErr.channels.alpha.version, '1.3.5-alpha.1112223');

  // requestRestart is idempotent and invokes onRestart after delay
  const res1 = await manager.requestRestart();
  const res2 = await manager.requestRestart();
  assert.equal(res1.accepted, true);
  assert.equal(res2.accepted, true);
  assert.equal(res1.startedAt, 1700000000);
  assert.equal(restartCallbackCalls, 0);

  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(restartCallbackCalls, 1);

  // Unmanaged manager rejects restart
  const unmanaged = new ServerfullLifecycleManager({
    currentVersion: '1.3.5',
    startedAt: 1700000000,
    runtime: 'Node.js v24.0.0',
    packageRoot: '/tmp/dns-worker',
    workersCount: 1,
    envInfo: {
      platform: 'linux',
      installMethod: 'source',
      serviceManager: 'none',
      canRestart: false,
      restartReason: 'unmanaged_process',
    },
    onRestart: () => {},
  });
  await assert.rejects(() => unmanaged.requestRestart(), /restart_unsupported/);
}

async function testAdminRuntimeEndpoints(): Promise<void> {
  const ctx = createMockCtx();
  const dummyDb = {} as D1Database;

  // 1. Serverless mode (no bridge) returns supported: false on GET and 404 on POST /restart
  const serverlessEnv: Env = { DB: dummyDb, ASSETS: {} };
  const slGet = await handleAdminRequest(
    new Request('https://example.com/api/admin/runtime'),
    serverlessEnv,
    ADMIN_USER,
    ['api', 'admin', 'runtime'],
    ctx
  );
  assert.equal(slGet.status, 200);
  assert.deepEqual(await slGet.json(), { supported: false });

  const slPost = await handleAdminRequest(
    new Request('https://example.com/api/admin/runtime/restart', { method: 'POST' }),
    serverlessEnv,
    ADMIN_USER,
    ['api', 'admin', 'runtime', 'restart'],
    ctx
  );
  assert.equal(slPost.status, 404);

  // 2. Demo Mode returns simulated status on GET and 403 on POST /restart
  const demoEnv: Env = { DB: dummyDb, ASSETS: {}, DEMO_MODE: 'true' } as Env;
  const demoGet = await handleAdminRequest(
    new Request('https://example.com/api/admin/runtime'),
    demoEnv,
    ADMIN_USER,
    ['api', 'admin', 'runtime'],
    ctx
  );
  assert.equal(demoGet.status, 200);
  const demoJson = (await demoGet.json()) as { supported: boolean; canRestart: boolean; restartReason: string };
  assert.equal(demoJson.supported, true);
  assert.equal(demoJson.canRestart, false);
  assert.equal(demoJson.restartReason, 'demo_mode');

  const demoPost = await handleAdminRequest(
    new Request('https://example.com/api/admin/runtime/restart', { method: 'POST' }),
    demoEnv,
    ADMIN_USER,
    ['api', 'admin', 'runtime', 'restart'],
    ctx
  );
  assert.equal(demoPost.status, 403);

  // 3. Serverfull mode delegates to SERVERFULL_LIFECYCLE_BRIDGE
  let receivedForceRefresh: boolean | undefined;
  const mockBridge: ServerfullLifecycleBridge = {
    async getStatus(opts) {
      receivedForceRefresh = opts?.forceRefresh;
      return {
        supported: true,
        currentVersion: '1.3.5',
        currentChannel: 'latest',
        startedAt: 1700000100,
        runtime: 'Node.js v24.0.0',
        platform: 'linux',
        installMethod: 'npm-global',
        serviceManager: 'systemd',
        workersCount: 1,
        canRestart: true,
        restartReason: null,
        checkedAt: 1700000200,
        checkError: null,
        channels: {
          latest: { channel: 'latest', version: '1.3.5', updateAvailable: false, updateCommand: 'npm i -g dns-worker@latest && dns-worker service restart' },
          alpha: { channel: 'alpha', version: '1.3.5-alpha.abc1234', updateAvailable: true, updateCommand: 'npm i -g dns-worker@alpha && dns-worker service restart' },
          canary: { channel: 'canary', version: '1.3.5-canary.def5678', updateAvailable: true, updateCommand: 'npm i -g dns-worker@canary && dns-worker service restart' },
        },
      };
    },
    async requestRestart() {
      return {
        accepted: true,
        startedAt: 1700000100,
        estimatedDowntimeSec: 8,
        message: 'Graceful restart scheduled',
      };
    },
  };

  const sfEnv: Env = {
    DB: dummyDb,
    ASSETS: {},
    DATABASE_SERVICE: 'File',
    SERVERFULL_HOST: '0.0.0.0',
    SERVERFULL_SNAPSHOT_BRIDGE: {} as Env['SERVERFULL_SNAPSHOT_BRIDGE'],
    SERVERFULL_LIFECYCLE_BRIDGE: mockBridge,
  };
  const sfGet = await handleAdminRequest(
    new Request('https://example.com/api/admin/runtime?refresh=1'),
    sfEnv,
    ADMIN_USER,
    ['api', 'admin', 'runtime'],
    ctx
  );
  assert.equal(sfGet.status, 200);
  assert.equal(receivedForceRefresh, true);

  const sfPost = await handleAdminRequest(
    new Request('https://example.com/api/admin/runtime/restart', { method: 'POST' }),
    sfEnv,
    ADMIN_USER,
    ['api', 'admin', 'runtime', 'restart'],
    ctx
  );
  assert.equal(sfPost.status, 202);
  const sfPostJson = (await sfPost.json()) as { accepted: boolean; startedAt: number };
  assert.equal(sfPostJson.accepted, true);
  assert.equal(sfPostJson.startedAt, 1700000100);
}

async function run(): Promise<void> {
  testReleaseChannelDetection();
  testEnvironmentDetectionAndCommands();
  await testLifecycleManagerCachingAndRestart();
  await testAdminRuntimeEndpoints();
  console.log('[PASS] All Serverfull lifecycle check & graceful restart tests passed!');
}

run().catch((err) => {
  console.error('[FAIL] test_serverfull_lifecycle failed:', err);
  process.exit(1);
});

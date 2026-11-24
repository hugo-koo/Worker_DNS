/**
 * @file lifecycle.ts
 * @description Serverfull runtime inspection, npm 3-channel update checking (latest / alpha / canary),
 * and safe graceful restart coordination. Host package installation is intentionally omitted for security.
 */

import fs from 'node:fs';
import path from 'node:path';
import type {
  ReleaseChannel,
  ReleaseChannelInfo,
  ServerfullInstallMethod,
  ServerfullLifecycleBridge,
  ServerfullRestartResult,
  ServerfullRuntimeStatus,
  ServerfullServiceManager,
} from '../types';

const NPM_DIST_TAGS_URL = 'https://registry.npmjs.org/-/package/dns-worker/dist-tags';
const DOCKER_REPOSITORY = 'hugokoo/dns-worker';
const DEFAULT_CACHE_TTL_SEC = 300;
const REGISTRY_TIMEOUT_MS = 8000;
const RESTART_DELAY_MS = 400;

export interface DetectEnvironmentOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  packageRoot: string;
  argv1?: string;
  cwd?: string;
  existsSync?: (targetPath: string) => boolean;
  readFileSync?: (targetPath: string, encoding: BufferEncoding) => string;
}

export interface DetectedServerfullEnvironment {
  platform: NodeJS.Platform;
  installMethod: ServerfullInstallMethod;
  serviceManager: ServerfullServiceManager;
  canRestart: boolean;
  restartReason: string | null;
}

export interface ServerfullLifecycleManagerOptions {
  currentVersion: string;
  startedAt: number;
  runtime: string;
  packageRoot: string;
  workersCount: number;
  onRestart: () => void | Promise<void>;
  fetchFn?: typeof fetch;
  cacheTtlSec?: number;
  envInfo?: DetectedServerfullEnvironment;
}

/**
 * Infers the active release channel from a semver string matching GitHub Actions workflows.
 *
 * @param version - Current package version string.
 * @returns Active release channel (`canary`, `alpha`, or `latest`).
 */
export function detectReleaseChannel(version: string): ReleaseChannel {
  const normalized = version.trim().toLowerCase();
  if (normalized.includes('-canary.') || normalized.endsWith('-canary')) {
    return 'canary';
  }
  if (normalized.includes('-alpha.') || normalized.endsWith('-alpha')) {
    return 'alpha';
  }
  return 'latest';
}

/**
 * Detects deployment installation method, process supervisor, and whether graceful self-restart is supported.
 *
 * @param options - Runtime environment and filesystem probes (injectable for deterministic testing).
 * @returns Detected Serverfull environment capabilities.
 */
export function detectServerfullEnvironment(
  options: DetectEnvironmentOptions
): DetectedServerfullEnvironment {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const existsSync = options.existsSync ?? fs.existsSync;
  const readFileSync = options.readFileSync ?? ((p: string, enc: BufferEncoding) => fs.readFileSync(p, enc));
  const normalizedRoot = path.normalize(options.packageRoot);
  const argv1 = options.argv1 ?? (process.argv[1] || '');
  const cwd = options.cwd ?? '';

  let inDocker = false;
  if (existsSync('/.dockerenv')) {
    inDocker = true;
  } else if (platform === 'linux') {
    try {
      if (existsSync('/proc/1/cgroup')) {
        const cgroup = readFileSync('/proc/1/cgroup', 'utf8');
        if (/docker|containerd|kubepods|podman/i.test(cgroup)) {
          inDocker = true;
        }
      }
    } catch {
      // Ignore unreadable cgroup files under restricted containers
    }
  }

  let serviceManager: ServerfullServiceManager = 'none';
  if (inDocker) {
    serviceManager = 'docker';
  } else if (platform === 'linux' && Boolean(env.INVOCATION_ID)) {
    serviceManager = 'systemd';
  } else if (platform === 'win32') {
    const isSystemAccount =
      env.USERNAME?.toUpperCase() === 'SYSTEM' && env.USERDOMAIN?.toUpperCase() === 'NT AUTHORITY';
    const programDataWorkerDir = path.normalize(path.join(env.ProgramData || 'C:\\ProgramData', 'DNS-Worker')).toLowerCase();
    const runsFromTaskDir =
      argv1.toLowerCase().includes(programDataWorkerDir) ||
      cwd.toLowerCase().includes(programDataWorkerDir);
    if (isSystemAccount || runsFromTaskDir) {
      serviceManager = 'schtasks';
    }
  }

  let installMethod: ServerfullInstallMethod = 'unknown';
  if (inDocker) {
    installMethod = 'docker';
  } else if (existsSync(path.join(normalizedRoot, '.git'))) {
    installMethod = 'source';
  } else if (normalizedRoot.includes('_npx')) {
    installMethod = 'npx';
  } else if (normalizedRoot.includes('node_modules')) {
    installMethod = 'npm-global';
  }

  let canRestart = false;
  let restartReason: string | null = 'unmanaged_process';
  if (serviceManager === 'systemd' || serviceManager === 'docker') {
    canRestart = true;
    restartReason = null;
  } else if (serviceManager === 'schtasks') {
    // Windows run-service.bat is a single-shot launcher without an exit loop
    canRestart = false;
    restartReason = 'windows_no_auto_restart';
  }

  return {
    platform,
    installMethod,
    serviceManager,
    canRestart,
    restartReason,
  };
}

/**
 * Generates the recommended host-side update command for a specific channel and deployment mode.
 *
 * @param channel - Target npm/Docker dist-tag channel.
 * @param installMethod - Detected installation method.
 * @param serviceManager - Detected supervisor.
 * @returns Shell command string safe to copy to the host terminal.
 */
export function buildChannelUpdateCommand(
  channel: ReleaseChannel,
  installMethod: ServerfullInstallMethod,
  serviceManager: ServerfullServiceManager
): string {
  if (installMethod === 'docker' || serviceManager === 'docker') {
    return `docker pull ${DOCKER_REPOSITORY}:${channel}`;
  }
  if (installMethod === 'source') {
    const branch = channel === 'canary' ? 'dev' : 'main';
    return `git pull origin ${branch} && npm run build:serverfull`;
  }
  if (serviceManager === 'systemd' || serviceManager === 'schtasks') {
    return `npm i -g dns-worker@${channel} && dns-worker service restart`;
  }
  return `npm i -g dns-worker@${channel}`;
}

/**
 * Coordinates npm registry 3-channel release checks and safe graceful process restarts.
 */
export class ServerfullLifecycleManager implements ServerfullLifecycleBridge {
  private readonly currentVersion: string;
  private readonly currentChannel: ReleaseChannel;
  private readonly startedAt: number;
  private readonly runtime: string;
  private readonly workersCount: number;
  private readonly onRestart: () => void | Promise<void>;
  private readonly fetchFn: typeof fetch;
  private readonly cacheTtlSec: number;
  private readonly envInfo: DetectedServerfullEnvironment;

  private cachedTags: Partial<Record<ReleaseChannel, string>> | null = null;
  private cachedAt: number | null = null;
  private lastCheckError: string | null = null;
  private inflightCheck: Promise<void> | null = null;
  private restartScheduled = false;

  constructor(options: ServerfullLifecycleManagerOptions) {
    this.currentVersion = options.currentVersion;
    this.currentChannel = detectReleaseChannel(options.currentVersion);
    this.startedAt = options.startedAt;
    this.runtime = options.runtime;
    this.workersCount = Math.max(1, options.workersCount);
    this.onRestart = options.onRestart;
    this.fetchFn = options.fetchFn ?? fetch;
    this.cacheTtlSec = options.cacheTtlSec ?? DEFAULT_CACHE_TTL_SEC;
    this.envInfo =
      options.envInfo ??
      detectServerfullEnvironment({
        packageRoot: options.packageRoot,
      });
  }

  /**
   * Returns current runtime metadata, supervisor capabilities, and 3-channel update status.
   *
   * @param options - Optional flags (`forceRefresh` bypasses the 5-minute dist-tags cache).
   * @returns Runtime status snapshot suitable for admin dashboard consumption.
   */
  public async getStatus(options?: { forceRefresh?: boolean }): Promise<ServerfullRuntimeStatus> {
    const forceRefresh = Boolean(options?.forceRefresh);
    const nowSec = Math.floor(Date.now() / 1000);
    const isCacheFresh =
      !forceRefresh &&
      this.cachedAt !== null &&
      this.cachedTags !== null &&
      this.lastCheckError === null &&
      nowSec - this.cachedAt < this.cacheTtlSec;

    if (!isCacheFresh) {
      await this.refreshRegistryDistTags();
    }

    const tags = this.cachedTags ?? {};
    const buildChannel = (channel: ReleaseChannel): ReleaseChannelInfo => {
      const remoteVersion = typeof tags[channel] === 'string' && tags[channel] ? tags[channel] : null;
      return {
        channel,
        version: remoteVersion,
        // Only flag updates for the active channel the service is actually tracking
        updateAvailable:
          channel === this.currentChannel &&
          Boolean(remoteVersion && remoteVersion !== this.currentVersion),
        updateCommand: buildChannelUpdateCommand(
          channel,
          this.envInfo.installMethod,
          this.envInfo.serviceManager
        ),
      };
    };

    return {
      supported: true,
      currentVersion: this.currentVersion,
      currentChannel: this.currentChannel,
      startedAt: this.startedAt,
      runtime: this.runtime,
      platform: this.envInfo.platform,
      installMethod: this.envInfo.installMethod,
      serviceManager: this.envInfo.serviceManager,
      workersCount: this.workersCount,
      canRestart: this.envInfo.canRestart,
      restartReason: this.envInfo.restartReason,
      checkedAt: this.cachedAt,
      checkError: this.lastCheckError,
      channels: {
        latest: buildChannel('latest'),
        alpha: buildChannel('alpha'),
        canary: buildChannel('canary'),
      },
    };
  }

  /**
   * Schedules a graceful shutdown so a process supervisor (`systemd` or Docker) cleanly restarts the service.
   *
   * @throws Error with message `'restart_unsupported'` if the active runtime has no auto-restart supervisor.
   * @returns Accepted restart metadata containing prior `startedAt` for client recovery polling.
   */
  public async requestRestart(): Promise<ServerfullRestartResult> {
    if (!this.envInfo.canRestart) {
      throw new Error('restart_unsupported');
    }

    if (!this.restartScheduled) {
      this.restartScheduled = true;
      setTimeout(() => {
        Promise.resolve(this.onRestart()).catch((err) => {
          console.error('[Serverfull Lifecycle] Restart callback failed:', err);
        });
      }, RESTART_DELAY_MS);
    }

    return {
      accepted: true,
      startedAt: this.startedAt,
      estimatedDowntimeSec: this.envInfo.serviceManager === 'systemd' ? 8 : 5,
      message: 'Graceful restart scheduled',
    };
  }

  private async refreshRegistryDistTags(): Promise<void> {
    if (this.inflightCheck) {
      return this.inflightCheck;
    }

    this.inflightCheck = (async () => {
      try {
        const res = await this.fetchFn(NPM_DIST_TAGS_URL, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
        });
        if (!res.ok) {
          this.cachedAt = Math.floor(Date.now() / 1000);
          this.lastCheckError = `npm registry returned HTTP ${res.status}`;
          return;
        }
        const data = (await res.json()) as Record<string, unknown>;
        const nextTags: Partial<Record<ReleaseChannel, string>> = {};
        for (const ch of ['latest', 'alpha', 'canary'] as const) {
          const val = data[ch];
          if (typeof val === 'string' && val.trim()) {
            nextTags[ch] = val.trim();
          }
        }
        this.cachedTags = nextTags;
        this.cachedAt = Math.floor(Date.now() / 1000);
        this.lastCheckError = null;
      } catch (err: unknown) {
        console.warn('[Serverfull Lifecycle] Failed to fetch npm dist-tags:', err);
        this.cachedAt = Math.floor(Date.now() / 1000);
        this.lastCheckError =
          err instanceof Error && err.name === 'TimeoutError'
            ? 'npm registry request timed out'
            : 'Failed to reach npm registry';
      } finally {
        this.inflightCheck = null;
      }
    })();

    return this.inflightCheck;
  }
}

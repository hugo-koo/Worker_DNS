/**
 * @file snapshot.ts
 * @description Serverfull local SQLite snapshot engine (.sqlite.zst), disk usage inspection,
 * retention/count pruning, and multi-worker-safe abortable capture via isolated subprocesses.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { spawn, ChildProcess } from 'node:child_process';
import zlib from 'node:zlib';
import type {
  ActiveSnapshotCapture,
  DatabaseSnapshotItem,
  DatabaseSnapshotOverview,
  DatabaseStorageStats,
  Env,
  ServerfullSnapshotBridge,
} from '../types';
import { getDefaultDbPath } from './paths';

const SNAPSHOT_FILE_REGEX =
  /^dns-worker-snapshot-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-([a-f0-9]{6})\.sqlite\.zst$/;
const LOCK_FILENAME = '.snapshot-active.json';
const ORPHAN_TMP_AGE_MS = 10 * 60 * 1000;

interface SnapshotLockState {
  id: string;
  pid: number;
  startedAt: number;
  stage: 'vacuumming' | 'compressing' | 'cancelling';
  progress: number;
  cancelRequested: boolean;
}

export interface ResolvedSnapshotConfig {
  dbPath: string;
  dbDir: string;
  snapshotDir: string;
  retentionDays: number;
  maxCount: number;
}

/**
 * Resolves snapshot directory, retention window (default 7 days), and max retained count (default 3)
 * from Serverfull environment configuration.
 */
export function resolveSnapshotConfig(env: Partial<Env>): ResolvedSnapshotConfig {
  const rawDbPath = (env.SERVERFULL_DB_PATH || process.env.SERVERFULL_DB_PATH || process.env.DB_PATH || getDefaultDbPath()).trim();
  const dbPath = path.resolve(rawDbPath);
  const dbDir = path.dirname(dbPath);

  const rawSnapshotDir = (env.SERVERFULL_SNAPSHOT_DIR ?? process.env.SERVERFULL_SNAPSHOT_DIR ?? '').toString().trim();
  const snapshotDir = rawSnapshotDir ? path.resolve(rawSnapshotDir) : dbDir;

  const rawRetention = env.SERVERFULL_SNAPSHOT_RETENTION_DAYS ?? process.env.SERVERFULL_SNAPSHOT_RETENTION_DAYS;
  let retentionDays = 7;
  if (rawRetention !== undefined && rawRetention !== null && String(rawRetention).trim() !== '') {
    const parsed = Number(rawRetention);
    if (Number.isFinite(parsed) && parsed >= 0) {
      retentionDays = Math.floor(parsed);
    }
  }

  const rawMaxCount = env.SERVERFULL_SNAPSHOT_MAX_COUNT ?? process.env.SERVERFULL_SNAPSHOT_MAX_COUNT;
  let maxCount = 3;
  if (rawMaxCount !== undefined && rawMaxCount !== null && String(rawMaxCount).trim() !== '') {
    const parsed = Number(rawMaxCount);
    if (Number.isFinite(parsed) && parsed >= 1) {
      maxCount = Math.floor(parsed);
    }
  }

  return {
    dbPath,
    dbDir,
    snapshotDir,
    retentionDays,
    maxCount,
  };
}

function getFileSizeSafe(filePath: string): number {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    return code === 'EPERM';
  }
}

function parseSnapshotTimestamp(filename: string, fallbackSec: number): number {
  const match = SNAPSHOT_FILE_REGEX.exec(filename);
  if (!match) return fallbackSec;
  const [, yr, mo, dy, hr, mi, sc] = match;
  const utcMs = Date.UTC(
    Number(yr),
    Number(mo) - 1,
    Number(dy),
    Number(hr),
    Number(mi),
    Number(sc)
  );
  return Number.isFinite(utcMs) ? Math.floor(utcMs / 1000) : fallbackSec;
}

function formatSnapshotTimestampUtc(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/**
 * Self-contained CommonJS script executed inside an isolated subprocess so `VACUUM INTO`
 * and Zstd compression never block the main DNS/HTTP event loop and can be aborted instantly.
 */
const CAPTURE_SUBPROCESS_SCRIPT = `
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { DatabaseSync } = require('node:sqlite');

async function run() {
  const dbPath = process.env.SNAPSHOT_DB_PATH;
  const tmpSqlite = process.env.SNAPSHOT_TMP_SQLITE;
  const tmpZst = process.env.SNAPSHOT_TMP_ZST;
  const finalZst = process.env.SNAPSHOT_FINAL_ZST;
  const lockPath = process.env.SNAPSHOT_LOCK_PATH;

  if (typeof zlib.createZstdCompress !== 'function') {
    throw new Error('Zstd compression is not supported in this Node.js runtime (requires Node.js >= 22.15).');
  }

  const readLock = () => {
    try {
      return JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    } catch {
      return null;
    }
  };

  const cleanupTemps = () => {
    try { fs.rmSync(tmpSqlite, { force: true }); } catch {}
    try { fs.rmSync(tmpZst, { force: true }); } catch {}
  };

  let db;
  try {
    db = new DatabaseSync(dbPath, { timeout: 10000 });
    db.exec('PRAGMA busy_timeout = 10000;');
    const escapedTarget = tmpSqlite.replace(/'/g, "''");
    db.exec("VACUUM INTO '" + escapedTarget + "';");
  } finally {
    try { db?.close(); } catch {}
  }

  const lockAfterVacuum = readLock();
  if (!lockAfterVacuum || lockAfterVacuum.cancelRequested) {
    cleanupTemps();
    return;
  }

  try {
    lockAfterVacuum.stage = 'compressing';
    lockAfterVacuum.progress = 50;
    fs.writeFileSync(lockPath, JSON.stringify(lockAfterVacuum), 'utf-8');
  } catch {}

  const zstdOptions = zlib.constants && typeof zlib.constants.ZSTD_c_compressionLevel === 'number'
    ? { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } }
    : undefined;

  let totalSqliteBytes = 0;
  try {
    totalSqliteBytes = fs.statSync(tmpSqlite).size;
  } catch {}

  let processedBytes = 0;
  let lastReportedPct = 50;
  const readStream = fs.createReadStream(tmpSqlite);
  readStream.on('data', (chunk) => {
    processedBytes += chunk.length;
    if (totalSqliteBytes > 0) {
      const nextPct = Math.min(99, 50 + Math.floor((processedBytes / totalSqliteBytes) * 49));
      if (nextPct > lastReportedPct) {
        lastReportedPct = nextPct;
        try {
          const cur = readLock();
          if (cur && !cur.cancelRequested) {
            cur.stage = 'compressing';
            cur.progress = nextPct;
            fs.writeFileSync(lockPath, JSON.stringify(cur), 'utf-8');
          }
        } catch {}
      }
    }
  });

  await pipeline(
    readStream,
    zlib.createZstdCompress(zstdOptions),
    fs.createWriteStream(tmpZst)
  );

  try { fs.rmSync(tmpSqlite, { force: true }); } catch {}

  const lockBeforeCommit = readLock();
  if (!lockBeforeCommit || lockBeforeCommit.cancelRequested) {
    cleanupTemps();
    return;
  }

  fs.renameSync(tmpZst, finalZst);
  try { fs.rmSync(lockPath, { force: true }); } catch {}
}

run().catch((err) => {
  try { fs.rmSync(process.env.SNAPSHOT_TMP_SQLITE, { force: true }); } catch {}
  try { fs.rmSync(process.env.SNAPSHOT_TMP_ZST, { force: true }); } catch {}
  console.error('[Snapshot Subprocess Error]:', err && err.message ? err.message : err);
  process.exit(1);
});
`;

/**
 * Manages SQLite `.sqlite.zst` snapshots, storage telemetry, retention policies,
 * and abortable background capture for Serverfull `File` mode.
 */
export class ServerfullSnapshotManager implements ServerfullSnapshotBridge {
  private activeChild: ChildProcess | null = null;
  private activeMonitorTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly env: Partial<Env>) {}

  private getConfig(): ResolvedSnapshotConfig {
    return resolveSnapshotConfig(this.env);
  }

  private ensureSnapshotDir(snapshotDir: string): void {
    if (!fs.existsSync(snapshotDir)) {
      fs.mkdirSync(snapshotDir, { recursive: true });
    }
  }

  private getLockPath(snapshotDir: string): string {
    return path.join(snapshotDir, LOCK_FILENAME);
  }

  private readActiveLock(snapshotDir: string): SnapshotLockState | null {
    const lockPath = this.getLockPath(snapshotDir);
    if (!fs.existsSync(lockPath)) return null;

    try {
      const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as SnapshotLockState;
      if (!parsed || typeof parsed.id !== 'string' || typeof parsed.pid !== 'number') {
        fs.rmSync(lockPath, { force: true });
        return null;
      }
      if (!isProcessAlive(parsed.pid)) {
        // Recover from crashed capture subprocess by cleaning stale lock and temp artifacts
        this.cleanupTempArtifacts(snapshotDir, parsed.id);
        fs.rmSync(lockPath, { force: true });
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private cleanupTempArtifacts(snapshotDir: string, captureId?: string): void {
    try {
      const entries = fs.readdirSync(snapshotDir);
      const nowMs = Date.now();
      for (const entry of entries) {
        if (!entry.startsWith('.tmp-')) continue;
        const full = path.join(snapshotDir, entry);
        if (captureId && entry.startsWith(`.tmp-${captureId}`)) {
          fs.rmSync(full, { force: true });
          continue;
        }
        try {
          const stat = fs.statSync(full);
          if (nowMs - stat.mtimeMs > ORPHAN_TMP_AGE_MS) {
            fs.rmSync(full, { force: true });
          }
        } catch {}
      }
    } catch {}
  }

  /**
   * Lists completed snapshots and removes any expired entries or excess oldest entries
   * beyond the configured `maxCount`.
   */
  public pruneAndListSnapshots(): DatabaseSnapshotItem[] {
    const cfg = this.getConfig();
    this.ensureSnapshotDir(cfg.snapshotDir);

    const activeLock = this.readActiveLock(cfg.snapshotDir);
    if (!activeLock) {
      this.cleanupTempArtifacts(cfg.snapshotDir);
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const retentionSec = cfg.retentionDays > 0 ? cfg.retentionDays * 86400 : 0;

    let entries: string[] = [];
    try {
      entries = fs.readdirSync(cfg.snapshotDir);
    } catch {
      return [];
    }

    const items: DatabaseSnapshotItem[] = [];
    for (const entry of entries) {
      if (!SNAPSHOT_FILE_REGEX.test(entry)) continue;
      const fullPath = path.join(cfg.snapshotDir, entry);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
        if (!stat.isFile()) continue;
      } catch {
        continue;
      }

      const fallbackCreated = Math.floor(stat.mtimeMs / 1000);
      const createdAt = parseSnapshotTimestamp(entry, fallbackCreated);
      const expiresAt = retentionSec > 0 ? createdAt + retentionSec : 0;

      if (expiresAt > 0 && nowSec >= expiresAt) {
        try {
          fs.rmSync(fullPath, { force: true });
        } catch {}
        continue;
      }

      items.push({
        filename: entry,
        sizeBytes: stat.size,
        createdAt,
        expiresAt,
      });
    }

    items.sort((a, b) => {
      if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
      return b.filename.localeCompare(a.filename);
    });

    if (items.length > cfg.maxCount) {
      const excess = items.splice(cfg.maxCount);
      for (const old of excess) {
        try {
          fs.rmSync(path.join(cfg.snapshotDir, old.filename), { force: true });
        } catch {}
      }
    }

    return items;
  }

  /**
   * Computes disk capacity/free space for `SERVERFULL_DB_PATH` (and snapshot directory if separate)
   * along with database and completed snapshot storage consumption.
   */
  public getStorageStats(snapshots?: DatabaseSnapshotItem[]): DatabaseStorageStats {
    const cfg = this.getConfig();
    this.ensureSnapshotDir(cfg.snapshotDir);

    const dbMainBytes = getFileSizeSafe(cfg.dbPath);
    const dbWalBytes = getFileSizeSafe(`${cfg.dbPath}-wal`);
    const dbShmBytes = getFileSizeSafe(`${cfg.dbPath}-shm`);
    const dbTotalBytes = dbMainBytes + dbWalBytes + dbShmBytes;

    const currentSnapshots = snapshots ?? this.pruneAndListSnapshots();
    const snapshotsTotalBytes = currentSnapshots.reduce((sum, item) => sum + item.sizeBytes, 0);

    let diskTotalBytes = 0;
    let diskFreeBytes = 0;
    const dbStatTarget = fs.existsSync(cfg.dbDir) ? cfg.dbDir : path.dirname(cfg.dbDir);
    try {
      const statFs = fs.statfsSync(dbStatTarget);
      diskTotalBytes = Number(statFs.blocks) * Number(statFs.bsize);
      diskFreeBytes = Number(statFs.bavail) * Number(statFs.bsize);
    } catch {
      diskTotalBytes = 0;
      diskFreeBytes = 0;
    }
    const diskUsedBytes = Math.max(0, diskTotalBytes - diskFreeBytes);

    let sameFilesystem: boolean;
    let snapshotDiskTotalBytes: number | undefined;
    let snapshotDiskFreeBytes: number | undefined;

    try {
      const dbDev = fs.statSync(dbStatTarget).dev;
      const snapDev = fs.statSync(cfg.snapshotDir).dev;
      sameFilesystem = dbDev === snapDev;
      if (!sameFilesystem) {
        const snapStatFs = fs.statfsSync(cfg.snapshotDir);
        snapshotDiskTotalBytes = Number(snapStatFs.blocks) * Number(snapStatFs.bsize);
        snapshotDiskFreeBytes = Number(snapStatFs.bavail) * Number(snapStatFs.bsize);
      }
    } catch {
      sameFilesystem = cfg.dbDir === cfg.snapshotDir;
    }

    return {
      dbPath: cfg.dbPath,
      snapshotDir: cfg.snapshotDir,
      sameFilesystem,
      diskTotalBytes,
      diskFreeBytes,
      diskUsedBytes,
      dbMainBytes,
      dbWalBytes,
      dbShmBytes,
      dbTotalBytes,
      snapshotsTotalBytes,
      snapshotDiskTotalBytes,
      snapshotDiskFreeBytes,
    };
  }

  public async getOverview(): Promise<DatabaseSnapshotOverview> {
    const cfg = this.getConfig();
    const snapshots = this.pruneAndListSnapshots();
    const lock = this.readActiveLock(cfg.snapshotDir);
    const storage = this.getStorageStats(snapshots);

    let activeCapture: ActiveSnapshotCapture | null = null;
    if (lock) {
      let progress = typeof lock.progress === 'number' ? Math.max(0, Math.min(99, lock.progress)) : 0;
      if (!lock.cancelRequested && lock.stage === 'vacuumming' && storage.dbMainBytes > 0) {
        const tmpSqliteSize = getFileSizeSafe(path.join(cfg.snapshotDir, `.tmp-${lock.id}.sqlite`));
        if (tmpSqliteSize > 0) {
          const vacuumPct = Math.min(48, Math.max(5, Math.round((tmpSqliteSize / storage.dbMainBytes) * 48)));
          progress = Math.max(progress, vacuumPct);
        }
      }
      activeCapture = {
        id: lock.id,
        startedAt: lock.startedAt,
        stage: lock.cancelRequested ? 'cancelling' : lock.stage,
        progress,
      };
    }

    return {
      supported: true,
      storage,
      snapshots,
      activeCapture,
      config: {
        retentionDays: cfg.retentionDays,
        maxCount: cfg.maxCount,
        snapshotDir: cfg.snapshotDir,
      },
    };
  }

  public async startCapture(): Promise<ActiveSnapshotCapture> {
    if (typeof zlib.createZstdCompress !== 'function') {
      throw new Error('ZSTD_UNSUPPORTED: Current JavaScript runtime does not support native Zstd compression.');
    }

    const cfg = this.getConfig();
    this.ensureSnapshotDir(cfg.snapshotDir);

    // Clear stale lock if previous worker crashed
    const existingLock = this.readActiveLock(cfg.snapshotDir);
    if (existingLock) {
      throw new Error('SNAPSHOT_IN_PROGRESS');
    }

    const startedAt = Math.floor(Date.now() / 1000);
    const shortId = crypto.randomBytes(3).toString('hex');
    const id = `${formatSnapshotTimestampUtc(startedAt)}-${shortId}`;
    const finalFilename = `dns-worker-snapshot-${id}.sqlite.zst`;

    const tmpSqlite = path.join(cfg.snapshotDir, `.tmp-${id}.sqlite`);
    const tmpZst = path.join(cfg.snapshotDir, `.tmp-${id}.sqlite.zst`);
    const finalZst = path.join(cfg.snapshotDir, finalFilename);
    const lockPath = this.getLockPath(cfg.snapshotDir);

    const initialLock: SnapshotLockState = {
      id,
      pid: process.pid,
      startedAt,
      stage: 'vacuumming',
      progress: 0,
      cancelRequested: false,
    };

    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeFileSync(fd, JSON.stringify(initialLock), 'utf-8');
      } finally {
        fs.closeSync(fd);
      }
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'EEXIST') {
        throw new Error('SNAPSHOT_IN_PROGRESS');
      }
      throw err;
    }

    const isBun = Boolean((process.versions as Record<string, string | undefined>).bun);
    const execArgs = isBun
      ? ['-e', CAPTURE_SUBPROCESS_SCRIPT]
      : ['--input-type=commonjs', '-e', CAPTURE_SUBPROCESS_SCRIPT];

    let child: ChildProcess;
    try {
      child = spawn(
        process.execPath,
        execArgs,
        {
          stdio: ['ignore', 'ignore', 'pipe'],
          env: {
            ...process.env,
            SNAPSHOT_DB_PATH: cfg.dbPath,
            SNAPSHOT_TMP_SQLITE: tmpSqlite,
            SNAPSHOT_TMP_ZST: tmpZst,
            SNAPSHOT_FINAL_ZST: finalZst,
            SNAPSHOT_LOCK_PATH: lockPath,
          },
        }
      );
      if (child.pid) {
        fs.writeFileSync(
          lockPath,
          JSON.stringify({ ...initialLock, pid: child.pid }),
          'utf-8'
        );
      }
    } catch (err) {
      try { fs.rmSync(lockPath, { force: true }); } catch {}
      throw err;
    }

    this.activeChild = child;

    let stderrBuf = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf-8');
    });

    // Cross-worker abort watcher: if another cluster worker flips cancelRequested, kill immediately
    if (this.activeMonitorTimer) {
      clearInterval(this.activeMonitorTimer);
    }
    this.activeMonitorTimer = setInterval(() => {
      try {
        if (!fs.existsSync(lockPath)) return;
        const lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as SnapshotLockState;
        if (lock.cancelRequested && this.activeChild === child) {
          try { child.kill('SIGKILL'); } catch {}
        }
      } catch {}
    }, 200);

    child.once('exit', (code, signal) => {
      if (this.activeChild === child) {
        this.activeChild = null;
      }
      if (this.activeMonitorTimer) {
        clearInterval(this.activeMonitorTimer);
        this.activeMonitorTimer = null;
      }

      if (code !== 0 && !signal) {
        console.error(`[Snapshot] Capture ${id} exited with code ${code}: ${stderrBuf.trim()}`);
      }

      this.cleanupTempArtifacts(cfg.snapshotDir, id);
      try {
        if (fs.existsSync(lockPath)) {
          const cur = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as SnapshotLockState;
          if (cur.id === id) {
            fs.rmSync(lockPath, { force: true });
          }
        }
      } catch {
        try { fs.rmSync(lockPath, { force: true }); } catch {}
      }

      // Enforce retention & maxCount after capture settles
      this.pruneAndListSnapshots();
    });

    return {
      id,
      startedAt,
      stage: 'vacuumming',
      progress: 0,
    };
  }

  public async abortCapture(): Promise<{ aborted: boolean }> {
    const cfg = this.getConfig();
    const lockPath = this.getLockPath(cfg.snapshotDir);
    const lock = this.readActiveLock(cfg.snapshotDir);
    if (!lock) {
      this.cleanupTempArtifacts(cfg.snapshotDir);
      return { aborted: false };
    }

    // Persist cancelRequested so the owning cluster worker terminates the child immediately
    const updated: SnapshotLockState = {
      ...lock,
      stage: 'cancelling',
      cancelRequested: true,
    };
    try {
      fs.writeFileSync(lockPath, JSON.stringify(updated), 'utf-8');
    } catch {}

    // If this process owns the subprocess (or subprocess PID is directly reachable), terminate now
    if (this.activeChild) {
      try {
        this.activeChild.kill('SIGKILL');
      } catch {}
    } else if (isProcessAlive(lock.pid)) {
      try {
        process.kill(lock.pid, 'SIGKILL');
      } catch {}
    }

    // Wait briefly until temp files & lock are reclaimed so UI refresh reflects aborted state cleanly
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      if (!fs.existsSync(lockPath) || !isProcessAlive(lock.pid)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 60));
    }

    if (!isProcessAlive(lock.pid)) {
      this.cleanupTempArtifacts(cfg.snapshotDir, lock.id);
      try { fs.rmSync(lockPath, { force: true }); } catch {}
    }

    return { aborted: true };
  }

  public async deleteSnapshots(filenames: string[]): Promise<{ deletedCount: number }> {
    const cfg = this.getConfig();
    this.ensureSnapshotDir(cfg.snapshotDir);
    const resolvedDir = path.resolve(cfg.snapshotDir);

    let deletedCount = 0;
    const uniqueNames = Array.from(new Set(filenames));
    for (const rawName of uniqueNames) {
      if (!SNAPSHOT_FILE_REGEX.test(rawName)) continue;
      const targetPath = path.resolve(resolvedDir, rawName);
      if (!targetPath.startsWith(resolvedDir + path.sep)) continue;
      if (fs.existsSync(targetPath)) {
        fs.rmSync(targetPath, { force: true });
        deletedCount++;
      }
    }

    return { deletedCount };
  }

  public async openSnapshotDownload(filename: string, rangeHeader?: string | null): Promise<{
    stream: ReadableStream<Uint8Array> | null;
    status: 200 | 206 | 416;
    sizeBytes: number;
    contentLength: number;
    contentRange?: string;
    etag: string;
    filename: string;
  } | null> {
    if (!SNAPSHOT_FILE_REGEX.test(filename)) {
      return null;
    }

    const cfg = this.getConfig();
    const resolvedDir = path.resolve(cfg.snapshotDir);
    const targetPath = path.resolve(resolvedDir, filename);
    if (!targetPath.startsWith(resolvedDir + path.sep)) {
      return null;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(targetPath);
      if (!stat.isFile()) return null;
    } catch {
      return null;
    }

    const sizeBytes = stat.size;
    const etag = `"${sizeBytes}-${Math.floor(stat.mtimeMs)}"`;

    if (rangeHeader && rangeHeader.trim().toLowerCase().startsWith('bytes=')) {
      const rangeSpec = rangeHeader.trim().slice(6).split(',')[0]?.trim() || '';
      const match = /^(\d*)-(\d*)$/.exec(rangeSpec);
      if (!match || (match[1] === '' && match[2] === '') || sizeBytes === 0) {
        return {
          stream: null,
          status: 416,
          sizeBytes,
          contentLength: 0,
          contentRange: `bytes */${sizeBytes}`,
          etag,
          filename,
        };
      }

      let start: number;
      let end: number;
      if (match[1] === '') {
        // Suffix byte range: last N bytes
        const suffixLen = Number(match[2]);
        if (!Number.isFinite(suffixLen) || suffixLen <= 0) {
          return {
            stream: null,
            status: 416,
            sizeBytes,
            contentLength: 0,
            contentRange: `bytes */${sizeBytes}`,
            etag,
            filename,
          };
        }
        start = Math.max(0, sizeBytes - suffixLen);
        end = sizeBytes - 1;
      } else {
        start = Number(match[1]);
        end = match[2] === '' ? sizeBytes - 1 : Math.min(sizeBytes - 1, Number(match[2]));
      }

      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= sizeBytes || end < start) {
        return {
          stream: null,
          status: 416,
          sizeBytes,
          contentLength: 0,
          contentRange: `bytes */${sizeBytes}`,
          etag,
          filename,
        };
      }

      const nodeStream = fs.createReadStream(targetPath, { start, end });
      const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
      return {
        stream: webStream,
        status: 206,
        sizeBytes,
        contentLength: end - start + 1,
        contentRange: `bytes ${start}-${end}/${sizeBytes}`,
        etag,
        filename,
      };
    }

    const nodeStream = fs.createReadStream(targetPath);
    const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
    return {
      stream: webStream,
      status: 200,
      sizeBytes,
      contentLength: sizeBytes,
      etag,
      filename,
    };
  }
}

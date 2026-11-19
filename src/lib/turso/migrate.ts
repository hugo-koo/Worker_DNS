/**
 * @file migrate.ts
 * @description Automatic SQL schema migration runner for Turso (libSQL) database.
 * Supports both universal runtime auto-migration (Cloudflare Workers via EMBEDDED_MIGRATIONS)
 * and filesystem-based migrations (Node.js Serverfull mode & CLI tools).
 */

import { D1Database } from '@cloudflare/workers-types';
import { TursoD1Database } from './index';
import { EMBEDDED_MIGRATIONS } from './embeddedMigrations';
import { splitSqlStatements } from './sql';

let nodeFs: any = null;
let nodePath: any = null;

async function getFs() {
  if (!nodeFs && typeof process !== 'undefined' && process.versions?.node) {
    try {
      nodeFs = await import('node:fs');
      nodePath = await import('node:path');
    } catch {
      nodeFs = null;
      nodePath = null;
    }
  }
  return { fs: nodeFs, path: nodePath };
}

/**
 * Migration statistics result.
 */
export interface TursoMigrationStats {
  count: number;
  completed: boolean;
  totalAvailable: number;
  appliedCount: number;
  pendingCount: number;
  lastApplied: string | null;
  pendingFiles: string[];
}

/**
 * Ensures the `d1_migrations` table exists on database,
 * automatically migrating legacy records if available.
 *
 * @param db - D1Database or TursoD1Database instance.
 */
export async function ensureTursoMigrationsTable(db: D1Database | TursoD1Database): Promise<void> {
  // Use prepare().run() with single-line SQL to prevent Cloudflare D1 multi-line exec parser bugs
  await db
    .prepare(
      'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, applied_at INTEGER NOT NULL)'
    )
    .run();

  // Safely import legacy _cf_d1_migrations records if table exists (for backward compatibility)
  try {
    const legacyTable = await db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_cf_d1_migrations'")
      .first<{ name: string }>();
    if (legacyTable?.name) {
      await db
        .prepare('INSERT OR IGNORE INTO d1_migrations (name, applied_at) SELECT name, applied_at FROM _cf_d1_migrations')
        .run();
    }
  } catch {
    // Expected on Cloudflare D1 where _cf_ prefix is restricted or table does not exist
  }
}

function isIdempotentSchemaError(msgLower: string, stmtUpper: string): boolean {
  const isDuplicateColumn = msgLower.includes('duplicate column name') && stmtUpper.startsWith('ALTER TABLE');
  const isAlreadyExists = msgLower.includes('already exists') && (stmtUpper.startsWith('CREATE') || stmtUpper.startsWith('ALTER'));
  return isDuplicateColumn || isAlreadyExists;
}

function stripWithoutRowidClause(stmt: string): string | null {
  if (!/\)\s*WITHOUT\s+ROWID\s*;?\s*$/i.test(stmt)) {
    return null;
  }
  return stmt.replace(/\)\s*WITHOUT\s+ROWID\s*;?\s*$/i, ')');
}

function extractTableRebuildPairs(stmts: string[]): Array<{ tempTable: string; targetTable: string }> {
  const pairs: Array<{ tempTable: string; targetTable: string }> = [];
  for (const stmt of stmts) {
    const match = stmt.match(/ALTER\s+TABLE\s+["'`]?([a-zA-Z0-9_]+)["'`]?\s+RENAME\s+TO\s+["'`]?([a-zA-Z0-9_]+)["'`]?/i);
    if (match && match[1] && match[2] && match[1] !== match[2]) {
      pairs.push({ tempTable: match[1], targetTable: match[2] });
    }
  }
  return pairs;
}

async function recoverInterruptedTableRebuilds(
  db: D1Database | TursoD1Database,
  pairs: Array<{ tempTable: string; targetTable: string }>
): Promise<boolean> {
  let recovered = false;
  for (const { tempTable, targetTable } of pairs) {
    const rows = await db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN (?, ?)")
      .bind(tempTable, targetTable)
      .all<{ name: string }>();
    const existing = new Set((rows.results || []).map((r) => r.name));
    if (existing.has(tempTable) && existing.has(targetTable)) {
      console.warn(`[Migrations] Dropping leftover temporary table "${tempTable}" before retrying migration.`);
      await db.prepare(`DROP TABLE IF EXISTS "${tempTable}"`).run();
      recovered = true;
    } else if (existing.has(tempTable) && !existing.has(targetTable)) {
      console.warn(`[Migrations] Completing interrupted rename "${tempTable}" -> "${targetTable}".`);
      await db.prepare(`ALTER TABLE "${tempTable}" RENAME TO "${targetTable}"`).run();
      recovered = true;
    }
  }
  return recovered;
}

async function runSingleMigrationStmt(
  db: D1Database | TursoD1Database,
  stmt: string,
  stmtIndex: number,
  disableForeignKeys = false
): Promise<void> {
  if ('executePipeline' in db && typeof (db as any).executePipeline === 'function') {
    const pipelineReqs: Array<{ type: 'execute'; stmt: { sql: string } } | { type: 'close' }> = [];
    if (disableForeignKeys && !/^\s*PRAGMA\s+foreign_keys/i.test(stmt)) {
      pipelineReqs.push({ type: 'execute', stmt: { sql: 'PRAGMA foreign_keys = OFF' } });
    }
    pipelineReqs.push({ type: 'execute', stmt: { sql: stmt } });
    pipelineReqs.push({ type: 'close' });

    const results = await (db as any).executePipeline(pipelineReqs, 60000);
    const execIndex = pipelineReqs.length - 2;
    const first = results[execIndex];
    if (first && (first.type === 'error' || first.error)) {
      const errMsg = first.error?.message || 'Error';
      if (isIdempotentSchemaError(errMsg.toLowerCase(), stmt.toUpperCase())) {
        console.warn(`[Migrations] Tolerating idempotent schema state on statement ${stmtIndex + 1}: ${errMsg}`);
        return;
      }
      throw new Error(`[Database D1] Exec error on statement ${stmtIndex + 1}: ${errMsg}\nSQL: ${stmt}`);
    }
    return;
  }

  await db.prepare(stmt).run();
}

async function execStatementsIndividually(
  db: D1Database | TursoD1Database,
  stmts: string[],
  tempTableNames: Set<string>
): Promise<void> {
  let disableForeignKeys = false;
  for (let i = 0; i < stmts.length; i++) {
    const stmt = stmts[i].trim();
    if (!stmt) continue;

    if (/^\s*PRAGMA\s+foreign_keys\s*=\s*(off|0|false)\s*$/i.test(stmt)) {
      disableForeignKeys = true;
    } else if (/^\s*PRAGMA\s+foreign_keys\s*=\s*(on|1|true)\s*$/i.test(stmt)) {
      disableForeignKeys = false;
    }

    try {
      await runSingleMigrationStmt(db, stmt, i, disableForeignKeys);
    } catch (err: any) {
      const msg = (err?.message || '').toLowerCase();
      const stmtUpper = stmt.toUpperCase();
      const createsTempRebuildTable = Array.from(tempTableNames).some((name) =>
        new RegExp(`^CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?["'\`]?${name}["'\`]?\\b`, 'i').test(stmt)
      );

      if (!createsTempRebuildTable && isIdempotentSchemaError(msg, stmtUpper)) {
        console.warn(`[Migrations] Tolerating idempotent schema state on statement ${i + 1}: ${err.message}`);
        continue;
      }

      // TursoDB (Limbo) does not yet support `WITHOUT ROWID`; strip and retry cleanly
      const fallbackStmt = stripWithoutRowidClause(stmt);
      if (fallbackStmt && (msg.includes('without rowid') || msg.includes('parse error') || msg.includes('syntax error') || msg.includes('not supported'))) {
        console.warn(`[Migrations] Engine rejected WITHOUT ROWID on statement ${i + 1}; retrying as standard rowid table.`);
        await runSingleMigrationStmt(db, fallbackStmt, i, disableForeignKeys);
        continue;
      }

      throw err;
    }
  }
}

/**
 * Executes a migration SQL script, batching statements over Turso's Hrana pipeline
 * so PRAGMA state (such as `PRAGMA foreign_keys=off`) persists across table rebuilds
 * and Worker subrequest limits are respected, with automatic recovery for interrupted rebuilds
 * and fallback for `WITHOUT ROWID` / idempotent schema states.
 *
 * @param db - D1Database or TursoD1Database instance.
 * @param sql - Migration script containing one or more SQL statements.
 */
export async function execMigrationSql(db: D1Database | TursoD1Database, sql: string): Promise<void> {
  const stmts = splitSqlStatements(sql).map((s) => s.trim()).filter(Boolean);
  if (stmts.length === 0) return;

  const rebuildPairs = extractTableRebuildPairs(stmts);
  const tempTableNames = new Set(rebuildPairs.map((p) => p.tempTable));

  const runOnce = async (): Promise<void> => {
    if ('executePipeline' in db && typeof (db as any).executePipeline === 'function') {
      const requests: Array<{ type: 'execute'; stmt: { sql: string } } | { type: 'close' }> = [
        ...stmts.map((s) => ({ type: 'execute' as const, stmt: { sql: s } })),
        { type: 'close' as const }
      ];
      const results = await (db as any).executePipeline(requests, 60000);
      const errStepIndex = results.findIndex((r: any) => r && (r.type === 'error' || r.error));
      if (errStepIndex === -1) {
        return;
      }

      const errStep = results[errStepIndex];
      const errMsg = errStep?.error?.message || 'Pipeline error';
      const errMsgLower = errMsg.toLowerCase();

      // If any statement failed due to unsupported WITHOUT ROWID, strip it across all statements and retry pipeline
      if (
        (errMsgLower.includes('without rowid') || errMsgLower.includes('parse error') || errMsgLower.includes('syntax error') || errMsgLower.includes('not supported')) &&
        stmts.some((s) => stripWithoutRowidClause(s) !== null)
      ) {
        const stripped = stmts.map((s) => stripWithoutRowidClause(s) || s);
        const retryReqs = [
          ...stripped.map((s) => ({ type: 'execute' as const, stmt: { sql: s } })),
          { type: 'close' as const }
        ];
        const retryResults = await (db as any).executePipeline(retryReqs, 60000);
        const retryErr = retryResults.find((r: any) => r && (r.type === 'error' || r.error));
        if (!retryErr) {
          return;
        }
      }

      // Fall back to statement-by-statement execution (carrying PRAGMA foreign_keys state)
      await execStatementsIndividually(db, stmts, tempTableNames);
      return;
    }

    await execStatementsIndividually(db, stmts, tempTableNames);
  };

  try {
    await runOnce();
  } catch (err: any) {
    const msg = (err?.message || '').toLowerCase();
    if (
      rebuildPairs.length > 0 &&
      (msg.includes('already exists') || msg.includes('unique constraint') || msg.includes('no such table'))
    ) {
      const didRecover = await recoverInterruptedTableRebuilds(db, rebuildPairs);
      if (didRecover) {
        await runOnce();
        return;
      }
    }
    throw err;
  }
}

/**
 * Resolves the available migrations map.
 * In Node.js environments (CLI, tests, Serverfull), prioritizes dynamically reading from
 * the local filesystem (migrations/ directory) so migrations/*.sql is the absolute Single Source of Truth.
 * In serverless environments (Cloudflare Workers) without filesystem access, falls back to EMBEDDED_MIGRATIONS.
 */
export async function resolveMigrationsMap(
  migrationsOrDir?: string | Record<string, string>
): Promise<Record<string, string>> {
  if (typeof migrationsOrDir === 'object' && migrationsOrDir !== null) {
    return migrationsOrDir;
  }

  const { fs: fsMod, path: pathMod } = await getFs();

  if (typeof migrationsOrDir === 'string') {
    if (fsMod && pathMod && fsMod.existsSync(migrationsOrDir)) {
      const files = fsMod
        .readdirSync(migrationsOrDir)
        .filter((f: string) => f.endsWith('.sql'))
        .sort();
      const map: Record<string, string> = {};
      for (const file of files) {
        map[file] = fsMod.readFileSync(pathMod.join(migrationsOrDir, file), 'utf-8');
      }
      return map;
    }
  }

  // Dynamic filesystem read in Node.js runtime when migrationsOrDir is omitted
  if (fsMod && pathMod) {
    try {
      const defaultDir = pathMod.join(process.cwd(), 'migrations');
      if (fsMod.existsSync(defaultDir)) {
        const files = fsMod
          .readdirSync(defaultDir)
          .filter((f: string) => f.endsWith('.sql'))
          .sort();
        if (files.length > 0) {
          const map: Record<string, string> = {};
          for (const file of files) {
            map[file] = fsMod.readFileSync(pathMod.join(defaultDir, file), 'utf-8');
          }
          return map;
        }
      }
    } catch {
      // Fall through to EMBEDDED_MIGRATIONS
    }
  }

  return EMBEDDED_MIGRATIONS;
}

/**
 * Queries migration status from database.
 *
 * @param db - D1Database or TursoD1Database instance.
 * @param migrationsOrDir - Optional directory path or custom Record<string, string> migration map.
 * @returns Object containing migration progress, applied counts, and pending files list.
 */
export async function getTursoMigrationStats(
  db: D1Database | TursoD1Database,
  migrationsOrDir?: string | Record<string, string>
): Promise<TursoMigrationStats> {
  const migrationsMap = await resolveMigrationsMap(migrationsOrDir);
  const files = Object.keys(migrationsMap).sort();
  try {
    await ensureTursoMigrationsTable(db);
    const appliedQuery = await db
      .prepare('SELECT name FROM d1_migrations')
      .all<{ name: string }>();
    const appliedSet = new Set((appliedQuery.results || []).map((r) => r.name));
    const pendingFiles = files.filter((f) => !appliedSet.has(f));
    const appliedCount = appliedSet.size;
    const lastApplied = (appliedQuery.results || []).length > 0
      ? (appliedQuery.results || []).map((r) => r.name).sort().pop() || null
      : null;

    return {
      count: appliedCount,
      completed: pendingFiles.length === 0,
      totalAvailable: files.length,
      appliedCount,
      pendingCount: pendingFiles.length,
      lastApplied,
      pendingFiles
    };
  } catch (err: any) {
    console.warn('[Turso Migrations] Failed to retrieve migration stats:', err.message || err);
    return {
      count: 0,
      completed: false,
      totalAvailable: files.length,
      appliedCount: 0,
      pendingCount: files.length,
      lastApplied: null,
      pendingFiles: files
    };
  }
}

export interface RunMigrationsOptions {
  /** Optional cap on how many pending migration files to apply in a single invocation (avoids Worker subrequest limits). */
  maxMigrations?: number;
}

/**
 * Runs pending migrations against the database.
 * If migrationsOrDir is omitted, uses the compiled EMBEDDED_MIGRATIONS map,
 * allowing safe execution in serverless runtimes (Cloudflare Workers) without filesystem access.
 *
 * @param db - D1Database or TursoD1Database instance.
 * @param migrationsOrDir - Optional directory path or custom Record<string, string> migration map.
 * @param options - Optional execution limits (e.g. maxMigrations for Worker HTTP requests).
 * @returns Number of newly applied migrations.
 */
export async function runTursoMigrations(
  db: D1Database | TursoD1Database,
  migrationsOrDir?: string | Record<string, string>,
  options?: RunMigrationsOptions
): Promise<number> {
  await ensureTursoMigrationsTable(db);

  const migrationsMap = await resolveMigrationsMap(migrationsOrDir);
  const files = Object.keys(migrationsMap).sort();

  const appliedQuery = await db.prepare('SELECT name FROM d1_migrations').all<{ name: string }>();
  const appliedSet = new Set((appliedQuery.results || []).map((r) => r.name));
  const maxMigrations = options?.maxMigrations && options.maxMigrations > 0 ? options.maxMigrations : Infinity;

  let appliedCount = 0;
  for (const file of files) {
    if (appliedSet.has(file)) continue;
    if (appliedCount >= maxMigrations) break;

    const sql = migrationsMap[file];
    if (!sql || !sql.trim()) continue;

    console.log(`[Database Migrations] Applying ${file}...`);
    try {
      await execMigrationSql(db, sql);
      const appliedAt = Math.floor(Date.now() / 1000);
      await db
        .prepare('INSERT OR REPLACE INTO d1_migrations (name, applied_at) VALUES (?, ?)')
        .bind(file, appliedAt)
        .run();
      appliedCount++;
    } catch (err: any) {
      console.error(`[Database Migrations] Failed to apply ${file}:`, err.message || err);
      throw err;
    }
  }

  if (appliedCount > 0) {
    console.log(`[Database Migrations] Successfully applied ${appliedCount} migration(s).`);
  } else {
    console.log('[Database Migrations] Database schema is up-to-date.');
  }

  return appliedCount;
}

let tursoMigrationsPromise: Promise<number> | null = null;

/**
 * Ensures all schema migrations are applied to database once per worker isolate lifecycle.
 * Deduplicates concurrent execution requests.
 *
 * @param db - D1Database or TursoD1Database instance.
 * @returns Number of applied migrations.
 */
export async function ensureTursoMigrations(db: D1Database | TursoD1Database): Promise<number> {
  if (!tursoMigrationsPromise) {
    tursoMigrationsPromise = runTursoMigrations(db).finally(() => {
      tursoMigrationsPromise = null;
    });
  }
  return tursoMigrationsPromise;
}

// Universal aliases for database migrations across D1, Turso, and SQLite
export const ensureDatabaseMigrationsTable = ensureTursoMigrationsTable;
export const getDatabaseMigrationStats = getTursoMigrationStats;
export const runDatabaseMigrations = runTursoMigrations;

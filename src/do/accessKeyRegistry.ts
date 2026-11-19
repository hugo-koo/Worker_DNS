import { DurableObject } from "cloudflare:workers";
import { Env } from "../types";
import type { AccessKeyEntry, AccessKeyLookupResult } from "../lib/accessKeyRegistry";

interface AccessKeySqlRow extends Record<string, SqlStorageValue> {
  access_key: string;
  profile_id: string;
  owner_id: string;
  access_point_id: string | null;
  access_point_name: string | null;
  updated_at: number;
}

interface MetaSqlRow extends Record<string, SqlStorageValue> {
  value: string;
}

/**
 * SQLite-backed Durable Object storing verified Access Keys for fail-open DNS resolution
 * when the primary D1 or Turso database is offline or quota-limited.
 */
export class AccessKeyRegistry extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS access_keys (
          access_key TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          access_point_id TEXT,
          access_point_name TEXT,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS registry_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    });
  }

  /**
   * Inserts or updates a batch of Access Key records and marks this shard as seeded.
   */
  async upsertKeys(entries: AccessKeyEntry[]): Promise<void> {
    if (entries.length === 0) return;

    this.ctx.storage.transactionSync(() => {
      for (const entry of entries) {
        this.ctx.storage.sql.exec(
          `INSERT INTO access_keys (access_key, profile_id, owner_id, access_point_id, access_point_name, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(access_key) DO UPDATE SET
             profile_id = excluded.profile_id,
             owner_id = excluded.owner_id,
             access_point_id = excluded.access_point_id,
             access_point_name = excluded.access_point_name,
             updated_at = excluded.updated_at`,
          entry.accessKey,
          entry.profileId,
          entry.ownerId,
          entry.accessPointId,
          entry.accessPointName,
          Math.floor(entry.updatedAt || Date.now() / 1000)
        );
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO registry_meta (key, value) VALUES ('seeded', '1')
         ON CONFLICT(key) DO UPDATE SET value = '1'`
      );
    });
  }

  /**
   * Deletes revoked or rotated Access Keys from this shard.
   */
  async deleteKeys(keys: string[]): Promise<void> {
    if (keys.length === 0) return;

    this.ctx.storage.transactionSync(() => {
      for (const key of keys) {
        this.ctx.storage.sql.exec(
          "DELETE FROM access_keys WHERE access_key = ?",
          key
        );
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO registry_meta (key, value) VALUES ('seeded', '1')
         ON CONFLICT(key) DO UPDATE SET value = '1'`
      );
    });
  }

  /**
   * Atomically replaces all keys stored in this shard with the authoritative DB snapshot.
   */
  async replaceSnapshot(entries: AccessKeyEntry[]): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM access_keys");
      for (const entry of entries) {
        this.ctx.storage.sql.exec(
          `INSERT INTO access_keys (access_key, profile_id, owner_id, access_point_id, access_point_name, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          entry.accessKey,
          entry.profileId,
          entry.ownerId,
          entry.accessPointId,
          entry.accessPointName,
          Math.floor(entry.updatedAt || Date.now() / 1000)
        );
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO registry_meta (key, value) VALUES ('seeded', '1')
         ON CONFLICT(key) DO UPDATE SET value = '1'`
      );
    });
  }

  /**
   * Checks whether an Access Key is registered in this shard.
   */
  async lookupKey(accessKey: string): Promise<AccessKeyLookupResult> {
    const rows = this.ctx.storage.sql
      .exec<AccessKeySqlRow>(
        `SELECT access_key, profile_id, owner_id, access_point_id, access_point_name, updated_at
         FROM access_keys WHERE access_key = ? LIMIT 1`,
        accessKey
      )
      .toArray();

    const metaRows = this.ctx.storage.sql
      .exec<MetaSqlRow>("SELECT value FROM registry_meta WHERE key = 'seeded' LIMIT 1")
      .toArray();

    const populated = metaRows.length > 0 && metaRows[0].value === "1";

    if (rows.length === 0) {
      return { found: false, populated };
    }

    const row = rows[0];
    return {
      found: true,
      populated: true,
      record: {
        accessKey: row.access_key,
        profileId: row.profile_id,
        ownerId: row.owner_id,
        accessPointId: row.access_point_id ?? null,
        accessPointName: row.access_point_name ?? null,
        updatedAt: Number(row.updated_at)
      }
    };
  }
}

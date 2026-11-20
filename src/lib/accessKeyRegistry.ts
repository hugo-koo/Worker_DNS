import { D1Database } from "@cloudflare/workers-types";
import { Env } from "../types";
import type { ProfileWithBloom } from "../models/profile";
import { SizeCappedMap } from "../pipeline/cache";

/** Number of deterministic Durable Object shards used to partition Access Key lookups. */
export const ACCESS_KEY_SHARD_COUNT = 16;

/** Persistent Access Key metadata stored inside Durable Object SQLite storage. */
export interface AccessKeyEntry {
  accessKey: string;
  profileId: string;
  ownerId: string;
  accessPointId: string | null;
  accessPointName: string | null;
  updatedAt: number;
}

/** Lookup response returned by the AccessKeyRegistry Durable Object. */
export interface AccessKeyLookupResult {
  found: boolean;
  populated: boolean;
  record?: AccessKeyEntry;
}

/** RPC stub interface implemented by AccessKeyRegistry Durable Object instances. */
export interface AccessKeyRegistryStub {
  upsertKeys(entries: AccessKeyEntry[]): Promise<void>;
  deleteKeys(keys: string[]): Promise<void>;
  replaceSnapshot(entries: AccessKeyEntry[]): Promise<void>;
  lookupKey(accessKey: string): Promise<AccessKeyLookupResult>;
}

/** Namespace binding interface compatible with Cloudflare DurableObjectNamespace and test mocks. */
export interface AccessKeyDoNamespace {
  getByName(name: string): AccessKeyRegistryStub;
}

/** Per-isolate throttle cache preventing redundant DO upserts for hot keys. */
const recentlySyncedKeys = new SizeCappedMap<string, number>(500);
const SYNC_THROTTLE_MS = 3600_000;

/**
 * Computes the deterministic Durable Object shard name for a given Access Key using FNV-1a.
 *
 * @param accessKey - Validated profile key or access point token.
 * @returns Shard identifier string in range `shard-00`..`shard-15`.
 */
export function getAccessKeyShardName(accessKey: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < accessKey.length; i++) {
    hash ^= accessKey.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const idx = (hash >>> 0) % ACCESS_KEY_SHARD_COUNT;
  return `shard-${String(idx).padStart(2, "0")}`;
}

/**
 * Returns the Durable Object namespace if configured on the current runtime environment.
 */
function getDoNamespace(env: Partial<Env>): AccessKeyDoNamespace | null {
  const ns = env.ACCESS_KEY_DO as AccessKeyDoNamespace | undefined;
  if (!ns || typeof ns.getByName !== "function") {
    return null;
  }
  return ns;
}

/**
 * Looks up whether an Access Key is registered in Durable Objects (used during DB fail-open outages).
 *
 * @param env - Worker environment bindings.
 * @param accessKey - Candidate Access Key or profile key.
 * @returns Lookup result from the key's shard, or null if Durable Objects are unavailable.
 */
export async function lookupAccessKeyInDo(
  env: Partial<Env>,
  accessKey: string
): Promise<AccessKeyLookupResult | null> {
  const ns = getDoNamespace(env);
  if (!ns || !accessKey) return null;

  try {
    const stub = ns.getByName(getAccessKeyShardName(accessKey));
    return await stub.lookupKey(accessKey);
  } catch (err) {
    console.warn(`[AccessKeyDO] Lookup failed for key ${accessKey}:`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Persists one or more legitimate Access Key entries into their corresponding Durable Object shards.
 *
 * @param env - Worker environment bindings.
 * @param entries - Key metadata records to store.
 */
export async function upsertAccessKeysInDo(
  env: Partial<Env>,
  entries: AccessKeyEntry[]
): Promise<void> {
  const ns = getDoNamespace(env);
  if (!ns || entries.length === 0) return;

  const byShard = new Map<string, AccessKeyEntry[]>();
  const nowMs = Date.now();

  for (const entry of entries) {
    if (!entry.accessKey) continue;
    recentlySyncedKeys.set(entry.accessKey, nowMs);
    const shard = getAccessKeyShardName(entry.accessKey);
    const list = byShard.get(shard);
    if (list) {
      list.push(entry);
    } else {
      byShard.set(shard, [entry]);
    }
  }

  await Promise.all(
    Array.from(byShard.entries()).map(async ([shard, shardEntries]) => {
      try {
        await ns.getByName(shard).upsertKeys(shardEntries);
      } catch (err) {
        console.warn(`[AccessKeyDO] Upsert failed on ${shard}:`, err instanceof Error ? err.message : String(err));
      }
    })
  );
}

/**
 * Removes revoked or deleted Access Keys from Durable Object shards.
 *
 * @param env - Worker environment bindings.
 * @param keys - List of access keys / tokens to revoke.
 */
export async function deleteAccessKeysInDo(
  env: Partial<Env>,
  keys: string[]
): Promise<void> {
  const ns = getDoNamespace(env);
  if (!ns || keys.length === 0) return;

  const byShard = new Map<string, string[]>();
  for (const key of keys) {
    if (!key) continue;
    recentlySyncedKeys.delete(key);
    const shard = getAccessKeyShardName(key);
    const list = byShard.get(shard);
    if (list) {
      list.push(key);
    } else {
      byShard.set(shard, [key]);
    }
  }

  await Promise.all(
    Array.from(byShard.entries()).map(async ([shard, shardKeys]) => {
      try {
        await ns.getByName(shard).deleteKeys(shardKeys);
      } catch (err) {
        console.warn(`[AccessKeyDO] Delete failed on ${shard}:`, err instanceof Error ? err.message : String(err));
      }
    })
  );
}

/**
 * Lazily synchronizes a DB-verified Access Key to Durable Objects, throttled per isolate.
 *
 * @param env - Worker environment bindings.
 * @param accessKey - Verified Access Key string.
 * @param profile - Resolved profile + access point metadata from DB.
 */
export async function syncResolvedProfileKeyToDo(
  env: Partial<Env>,
  accessKey: string,
  profile: ProfileWithBloom & { access_point_id?: string; access_point_name?: string }
): Promise<void> {
  if (!getDoNamespace(env) || !accessKey) return;

  const nowMs = Date.now();
  const lastSynced = recentlySyncedKeys.get(accessKey);
  if (lastSynced && nowMs - lastSynced < SYNC_THROTTLE_MS) {
    return;
  }

  const nowSec = Math.floor(nowMs / 1000);
  await upsertAccessKeysInDo(env, [
    {
      accessKey,
      profileId: profile.id,
      ownerId: profile.owner_id,
      accessPointId: profile.access_point_id ?? null,
      accessPointName: profile.access_point_name ?? null,
      updatedAt: nowSec
    }
  ]);
}

/**
 * Synchronizes all Access Keys associated with a single profile (profile_key, id, and access_points) from DB to DO.
 *
 * @param db - Active database handle.
 * @param env - Worker environment bindings.
 * @param profileId - Profile ID to synchronize.
 */
export async function syncProfileKeysToDo(
  db: D1Database,
  env: Partial<Env>,
  profileId: string
): Promise<void> {
  if (!getDoNamespace(env)) return;

  try {
    const profile = await db
      .prepare("SELECT id, profile_key, owner_id FROM profiles WHERE id = ?")
      .bind(profileId)
      .first<{ id: string; profile_key: string | null; owner_id: string }>();
    if (!profile) return;

    const { results: accessPoints } = await db
      .prepare("SELECT id, name, token FROM access_points WHERE profile_id = ?")
      .bind(profileId)
      .all<{ id: string; name: string; token: string }>();

    const nowSec = Math.floor(Date.now() / 1000);
    const entryMap = new Map<string, AccessKeyEntry>();

    // Profile-level fallback entries (priority 2)
    entryMap.set(profile.id, {
      accessKey: profile.id,
      profileId: profile.id,
      ownerId: profile.owner_id,
      accessPointId: null,
      accessPointName: null,
      updatedAt: nowSec
    });
    if (profile.profile_key) {
      entryMap.set(profile.profile_key, {
        accessKey: profile.profile_key,
        profileId: profile.id,
        ownerId: profile.owner_id,
        accessPointId: null,
        accessPointName: null,
        updatedAt: nowSec
      });
    }

    // Access point entries take priority (priority 1)
    for (const ap of accessPoints) {
      if (!ap.token) continue;
      entryMap.set(ap.token, {
        accessKey: ap.token,
        profileId: profile.id,
        ownerId: profile.owner_id,
        accessPointId: ap.id,
        accessPointName: ap.name,
        updatedAt: nowSec
      });
    }

    await upsertAccessKeysInDo(env, Array.from(entryMap.values()));
  } catch (err) {
    console.warn(`[AccessKeyDO] Profile sync failed for ${profileId}:`, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Reconciles a single key against the primary database (updates DO if active, removes DO entry if absent).
 * Prevents removing shared keys still in use by another table (e.g. access_point deleted when profile_key matches).
 *
 * @param db - Active database handle.
 * @param env - Worker environment bindings.
 * @param accessKey - Key to reconcile.
 */
export async function syncSingleKeyFromDbToDo(
  db: D1Database,
  env: Partial<Env>,
  accessKey: string
): Promise<void> {
  if (!getDoNamespace(env) || !accessKey) return;

  try {
    const match = await db.prepare(`
      SELECT * FROM (
        SELECT
          COALESCE(p.id, 'default') as profile_id,
          COALESCE(p.owner_id, ap.owner_id) as owner_id,
          ap.id as access_point_id,
          ap.name as access_point_name,
          1 as priority
        FROM access_points ap
        LEFT JOIN profiles p ON ap.profile_id = p.id
        WHERE ap.token = ?
        UNION ALL
        SELECT p.id as profile_id, p.owner_id, NULL as access_point_id, NULL as access_point_name, 2 as priority
        FROM profiles p
        WHERE p.profile_key = ? OR p.id = ?
      )
      ORDER BY priority ASC
      LIMIT 1
    `)
      .bind(accessKey, accessKey, accessKey)
      .first<{
        profile_id: string;
        owner_id: string;
        access_point_id: string | null;
        access_point_name: string | null;
      }>();

    if (match) {
      await upsertAccessKeysInDo(env, [
        {
          accessKey,
          profileId: match.profile_id,
          ownerId: match.owner_id,
          accessPointId: match.access_point_id ?? null,
          accessPointName: match.access_point_name ?? null,
          updatedAt: Math.floor(Date.now() / 1000)
        }
      ]);
    } else {
      await deleteAccessKeysInDo(env, [accessKey]);
    }
  } catch (err) {
    console.warn(`[AccessKeyDO] Single-key reconcile failed for ${accessKey}:`, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Collects all Access Keys owned by a profile before deleting it from DB.
 */
export async function collectProfileAccessKeys(db: D1Database, profileId: string): Promise<string[]> {
  try {
    const [profileRow, apRows] = await Promise.all([
      db.prepare("SELECT id, profile_key FROM profiles WHERE id = ?").bind(profileId).first<{ id: string; profile_key: string | null }>(),
      db.prepare("SELECT token FROM access_points WHERE profile_id = ?").bind(profileId).all<{ token: string }>()
    ]);
    const keys = new Set<string>();
    if (profileRow?.id) keys.add(profileRow.id);
    if (profileRow?.profile_key) keys.add(profileRow.profile_key);
    for (const ap of apRows.results) {
      if (ap.token) keys.add(ap.token);
    }
    return Array.from(keys);
  } catch {
    return [];
  }
}

/**
 * Collects all Access Keys owned by a user before deleting their account/profiles from DB.
 */
export async function collectOwnerAccessKeys(db: D1Database, ownerId: string): Promise<string[]> {
  try {
    const [profileRows, apRows] = await Promise.all([
      db.prepare("SELECT id, profile_key FROM profiles WHERE owner_id = ?").bind(ownerId).all<{ id: string; profile_key: string | null }>(),
      db.prepare("SELECT token FROM access_points WHERE owner_id = ?").bind(ownerId).all<{ token: string }>()
    ]);
    const keys = new Set<string>();
    for (const row of profileRows.results) {
      if (row.id) keys.add(row.id);
      if (row.profile_key) keys.add(row.profile_key);
    }
    for (const ap of apRows.results) {
      if (ap.token) keys.add(ap.token);
    }
    return Array.from(keys);
  } catch {
    return [];
  }
}

/**
 * Performs a full snapshot reconciliation of all valid Access Keys from DB into all 16 DO shards.
 * Intended for cron jobs so pre-existing keys are seeded and deleted/expired keys are purged.
 *
 * @param env - Worker environment bindings.
 * @returns Total number of active Access Keys synced across shards.
 */
export async function syncAllAccessKeysSnapshotToDo(env: Partial<Env>): Promise<number> {
  const ns = getDoNamespace(env);
  if (!ns || !env.DB) return 0;

  const [profilesRes, apRes] = await Promise.all([
    env.DB.prepare("SELECT id, profile_key, owner_id FROM profiles").all<{
      id: string;
      profile_key: string | null;
      owner_id: string;
    }>(),
    env.DB.prepare(
      "SELECT ap.token, ap.id as ap_id, ap.name as ap_name, COALESCE(ap.profile_id, 'default') as profile_id, COALESCE(p.owner_id, ap.owner_id) as owner_id " +
      "FROM access_points ap LEFT JOIN profiles p ON ap.profile_id = p.id"
    ).all<{
      token: string;
      ap_id: string;
      ap_name: string;
      profile_id: string;
      owner_id: string;
    }>()
  ]);

  const nowSec = Math.floor(Date.now() / 1000);
  const nowMs = Date.now();
  const entryMap = new Map<string, AccessKeyEntry>();

  for (const p of profilesRes.results) {
    entryMap.set(p.id, {
      accessKey: p.id,
      profileId: p.id,
      ownerId: p.owner_id,
      accessPointId: null,
      accessPointName: null,
      updatedAt: nowSec
    });
    if (p.profile_key) {
      entryMap.set(p.profile_key, {
        accessKey: p.profile_key,
        profileId: p.id,
        ownerId: p.owner_id,
        accessPointId: null,
        accessPointName: null,
        updatedAt: nowSec
      });
    }
  }

  for (const ap of apRes.results) {
    if (!ap.token) continue;
    entryMap.set(ap.token, {
      accessKey: ap.token,
      profileId: ap.profile_id,
      ownerId: ap.owner_id,
      accessPointId: ap.ap_id,
      accessPointName: ap.ap_name,
      updatedAt: nowSec
    });
  }

  const shardBuckets = new Map<string, AccessKeyEntry[]>();
  for (let i = 0; i < ACCESS_KEY_SHARD_COUNT; i++) {
    shardBuckets.set(`shard-${String(i).padStart(2, "0")}`, []);
  }

  for (const entry of entryMap.values()) {
    recentlySyncedKeys.set(entry.accessKey, nowMs);
    const shard = getAccessKeyShardName(entry.accessKey);
    shardBuckets.get(shard)?.push(entry);
  }

  await Promise.all(
    Array.from(shardBuckets.entries()).map(async ([shard, entries]) => {
      try {
        await ns.getByName(shard).replaceSnapshot(entries);
      } catch (err) {
        console.warn(`[AccessKeyDO] Snapshot sync failed on ${shard}:`, err instanceof Error ? err.message : String(err));
      }
    })
  );

  return entryMap.size;
}

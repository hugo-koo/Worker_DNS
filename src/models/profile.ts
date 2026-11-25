import { D1Database } from "@cloudflare/workers-types";
import { Profile, ProfileSettings } from "../types";
import { generateId, generateZBase32Token } from "../lib/auth";
import { DEFAULT_FAIL_OPEN_UPSTREAM } from "../constants/presets";

export interface ProfileWithBloom extends Profile {
  list_bloom?: string;
  list_updated_at?: number;
}

/**
 * Resolved DNS Profile returned by key/token lookup, with optional bound Access Point metadata.
 * When `unbound_access_point` is true, DNS queries must fall back to Fail-Open resolution.
 */
export interface ResolvedProfileByKey extends ProfileWithBloom {
  access_point_id?: string;
  access_point_name?: string;
  unbound_access_point?: boolean;
}

interface RawKeyLookupRow {
  id: string | null;
  profile_key?: string | null;
  owner_id: string | null;
  name: string | null;
  settings: string | null;
  created_at: number | null;
  updated_at: number | null;
  list_updated_at?: number;
  access_point_id: string | null;
  access_point_name: string | null;
  ap_owner_id: string | null;
  priority: number;
}

export class ProfileModel {
  constructor(private db: D1Database) {}

  // --- Core Profile Methods ---
  async getById(id: string): Promise<ProfileWithBloom | null> {
    return await this.db.prepare("SELECT * FROM profiles WHERE id = ?")
      .bind(id)
      .first<ProfileWithBloom>();
  }

  /**
   * Resolves a DNS Profile by Access Point token, profile_key, or profile id.
   * Priority 1 matches `access_points.token` with a LEFT JOIN so unbound Access Points
   * (`profile_id IS NULL`) explicitly resolve as Fail-Open instead of falling through
   * to `profiles.profile_key` or returning null.
   */
  async findByKey(profileKey: string): Promise<ResolvedProfileByKey | null> {
    try {
      const match = await this.db.prepare(`
        SELECT * FROM (
          SELECT
            p.*,
            ap.id as access_point_id,
            ap.name as access_point_name,
            ap.owner_id as ap_owner_id,
            1 as priority
          FROM access_points ap
          LEFT JOIN profiles p ON ap.profile_id = p.id
          WHERE ap.token = ?
          UNION ALL
          SELECT
            p.*,
            NULL as access_point_id,
            NULL as access_point_name,
            p.owner_id as ap_owner_id,
            2 as priority
          FROM profiles p
          WHERE p.profile_key = ? OR p.id = ?
        )
        ORDER BY priority ASC
        LIMIT 1
      `)
        .bind(profileKey, profileKey, profileKey)
        .first<RawKeyLookupRow>();

      if (!match) {
        return null;
      }

      if (!match.id && match.access_point_id) {
        const nowSec = Math.floor(Date.now() / 1000);
        return {
          id: "default",
          profile_key: profileKey,
          owner_id: match.ap_owner_id || "system",
          name: "Unbound Access Point (Fail-Open)",
          settings: JSON.stringify({
            upstream: [DEFAULT_FAIL_OPEN_UPSTREAM],
            default_policy: "ALLOW",
            log_retention_days: 0,
            ecs: { enabled: true, use_client_ip: true }
          }),
          created_at: nowSec,
          updated_at: nowSec,
          access_point_id: match.access_point_id,
          access_point_name: match.access_point_name ?? undefined,
          unbound_access_point: true,
          isEmergencyFallback: true
        };
      }

      const { ap_owner_id: _apOwnerId, priority: _priority, ...rest } = match;
      return {
        ...(rest as unknown as ProfileWithBloom),
        access_point_id: match.access_point_id ?? undefined,
        access_point_name: match.access_point_name ?? undefined
      };
    } catch (e: any) {
      console.warn("[ProfileModel] findByKey query failed:", e.message || e);
      throw e;
    }
  }

  async listByOwner(ownerId: string): Promise<Profile[]> {
    const { results } = await this.db.prepare("SELECT * FROM profiles WHERE owner_id = ? ORDER BY created_at DESC")
      .bind(ownerId).all<Profile>();
    return results;
  }

  async findByName(ownerId: string, name: string): Promise<Profile | null> {
    return await this.db.prepare("SELECT * FROM profiles WHERE owner_id = ? AND name = ?")
      .bind(ownerId, name).first<Profile | null>();
  }

  async create(profile: { id: string, profile_key?: string, owner_id: string, name: string, settings: ProfileSettings }): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    const apId = generateId(12);
    const MAX_RETRIES = 5;

    // Only auto-create an initial default Access Point when the user has none yet,
    // because Access Points are user-owned and shared across Profiles.
    const existingAp = await this.db
      .prepare("SELECT 1 FROM access_points WHERE owner_id = ? LIMIT 1")
      .bind(profile.owner_id)
      .first();

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const apToken = generateZBase32Token(5);
      const profileKey = profile.profile_key || apToken;
      
      const statements = [
        this.db.prepare(
          "INSERT INTO profiles (id, profile_key, owner_id, name, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).bind(profile.id, profileKey, profile.owner_id, profile.name, JSON.stringify(profile.settings), now, now),
        ...(existingAp
          ? []
          : [
              this.db.prepare(
                "INSERT INTO access_points (id, owner_id, profile_id, name, token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
              ).bind(apId, profile.owner_id, profile.id, "Device-1", apToken, now, now),
            ]),
      ];

      try {
        const results = await this.db.batch(statements);
        return results.every(r => r.success);
      } catch (err: any) {
        if (attempt < MAX_RETRIES - 1 && (String(err).includes("UNIQUE constraint failed") || String(err).includes("SQLITE_CONSTRAINT"))) {
          continue;
        }
        throw err;
      }
    }
    return false;
  }

  async delete(id: string): Promise<boolean> {
    const results = await this.db.batch([
      this.db.prepare("DELETE FROM logs WHERE profile_id = ?").bind(id),
      this.db.prepare("DELETE FROM hourly_rollups WHERE profile_id = ?").bind(id),
      this.db.prepare("DELETE FROM profiles WHERE id = ?").bind(id)
    ]);
    return results.every(r => r.success);
  }

  async deleteByOwner(ownerId: string): Promise<boolean> {
    const results = await this.db.batch([
      this.db.prepare("DELETE FROM logs WHERE profile_id IN (SELECT id FROM profiles WHERE owner_id = ?)").bind(ownerId),
      this.db.prepare("DELETE FROM hourly_rollups WHERE profile_id IN (SELECT id FROM profiles WHERE owner_id = ?)").bind(ownerId),
      this.db.prepare("DELETE FROM profiles WHERE owner_id = ?").bind(ownerId)
    ]);
    return results.every(r => r.success);
  }

  async updateName(id: string, name: string): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    const result = await this.db.prepare("UPDATE profiles SET name = ?, updated_at = ? WHERE id = ?")
      .bind(name, now, id).run();
    return result.success;
  }

  async updateSettings(id: string, settings: ProfileSettings): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    const result = await this.db.prepare(
      "UPDATE profiles SET settings = ?, updated_at = ? WHERE id = ?"
    )
      .bind(JSON.stringify(settings), now, id)
      .run();
    return result.success;
  }

  async rotateKey(id: string, newKey: string): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    const result = await this.db.prepare("UPDATE profiles SET profile_key = ?, updated_at = ? WHERE id = ?")
      .bind(newKey, now, id).run();
    return result.success;
  }

  async getSyncTargets(threshold: number, limit: number): Promise<{id: string}[]> {
    const { results } = await this.db.prepare(
      "SELECT id FROM profiles WHERE (list_updated_at IS NULL OR list_updated_at <= ?) AND EXISTS (SELECT 1 FROM lists WHERE lists.profile_id = profiles.id) ORDER BY list_updated_at ASC LIMIT ?"
    ).bind(threshold, limit).all<{ id: string }>();
    return results;
  }

  async updateListUpdatedAt(profileId: string, now: number): Promise<boolean> {
    const result = await this.db.prepare("UPDATE profiles SET list_updated_at = ? WHERE id = ?").bind(now, profileId).run();
    return result.success;
  }
}

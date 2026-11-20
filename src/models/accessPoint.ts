import { D1Database } from "@cloudflare/workers-types";
import { AccessPoint } from "../types";
import { generateId, generateZBase32Token } from "../lib/auth";
import { DEFAULT_ACCESS_POINT_DEVICE_TYPE, normalizeAccessPointDeviceType } from "../constants/deviceTypes";

export class AccessPointModel {
  constructor(private db: D1Database) {}

  /**
   * Lists all Access Points owned by a user, ordered oldest first.
   */
  async getAccessPointsByOwner(ownerId: string): Promise<AccessPoint[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM access_points WHERE owner_id = ? ORDER BY created_at ASC")
      .bind(ownerId)
      .all<AccessPoint>();
    return results;
  }

  /**
   * Lists Access Points currently bound to a specific Profile.
   */
  async getAccessPoints(profileId: string): Promise<AccessPoint[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM access_points WHERE profile_id = ? ORDER BY created_at ASC")
      .bind(profileId)
      .all<AccessPoint>();
    return results;
  }

  /**
   * Retrieves a single Access Point verifying owner ownership.
   */
  async getByIdAndOwner(id: string, ownerId: string): Promise<AccessPoint | null> {
    const row = await this.db
      .prepare("SELECT * FROM access_points WHERE id = ? AND owner_id = ?")
      .bind(id, ownerId)
      .first<AccessPoint>();
    return row || null;
  }

  /**
   * Creates a user-owned Access Point optionally bound to a profile.
   */
  async addAccessPointForOwner(
    ownerId: string,
    name: string,
    profileId: string | null = null,
    deviceType: string = DEFAULT_ACCESS_POINT_DEVICE_TYPE
  ): Promise<AccessPoint> {
    const now = Math.floor(Date.now() / 1000);
    const id = generateId(12);
    const resolvedDeviceType = normalizeAccessPointDeviceType(deviceType);
    const MAX_RETRIES = 5;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const token = generateZBase32Token(5);
      try {
        await this.db
          .prepare(
            "INSERT INTO access_points (id, owner_id, profile_id, name, token, device_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
          )
          .bind(id, ownerId, profileId, name, token, resolvedDeviceType, now, now)
          .run();
        return {
          id,
          owner_id: ownerId,
          profile_id: profileId,
          name,
          token,
          device_type: resolvedDeviceType,
          created_at: now,
          updated_at: now,
        };
      } catch (err: unknown) {
        if (
          attempt < MAX_RETRIES - 1 &&
          (String(err).includes("UNIQUE constraint failed") ||
            String(err).includes("SQLITE_CONSTRAINT"))
        ) {
          continue;
        }
        throw err;
      }
    }
    throw new Error("Failed to generate a unique access point token");
  }

  /**
   * Updates an Access Point's name, bound profile ID, and/or device type (owner-scoped).
   */
  async updateAccessPointByOwner(
    id: string,
    ownerId: string,
    updates: { name?: string; profile_id?: string | null; device_type?: string }
  ): Promise<boolean> {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (updates.name !== undefined) {
      sets.push("name = ?");
      params.push(updates.name);
    }
    if (updates.profile_id !== undefined) {
      sets.push("profile_id = ?");
      params.push(updates.profile_id);
    }
    if (updates.device_type !== undefined) {
      sets.push("device_type = ?");
      params.push(normalizeAccessPointDeviceType(updates.device_type));
    }
    if (sets.length === 0) {
      return false;
    }

    const now = Math.floor(Date.now() / 1000);
    sets.push("updated_at = ?");
    params.push(now, id, ownerId);

    const result = await this.db
      .prepare(`UPDATE access_points SET ${sets.join(", ")} WHERE id = ? AND owner_id = ?`)
      .bind(...params)
      .run();
    return result.success;
  }

  private async rotateTokenWithCondition(whereSql: string, params: unknown[]): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const MAX_RETRIES = 5;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const newToken = generateZBase32Token(5);
      try {
        const result = await this.db
          .prepare(`UPDATE access_points SET token = ?, updated_at = ? WHERE ${whereSql}`)
          .bind(newToken, now, ...params)
          .run();
        if (!result.success) {
          throw new Error("Failed to update access point token");
        }
        return newToken;
      } catch (err: unknown) {
        if (
          attempt < MAX_RETRIES - 1 &&
          (String(err).includes("UNIQUE constraint failed") ||
            String(err).includes("SQLITE_CONSTRAINT"))
        ) {
          continue;
        }
        throw err;
      }
    }
    throw new Error("Failed to generate a unique access point token");
  }

  /**
   * Rotates the Access Point's token while preserving ownership and profile binding.
   */
  async rotateAccessPointTokenByOwner(id: string, ownerId: string): Promise<string> {
    return this.rotateTokenWithCondition("id = ? AND owner_id = ?", [id, ownerId]);
  }

  /**
   * Deletes an Access Point owned by the user.
   */
  async deleteAccessPointByOwner(id: string, ownerId: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM access_points WHERE id = ? AND owner_id = ?")
      .bind(id, ownerId)
      .run();
    return result.success;
  }

  // --- Legacy profile-scoped wrappers preserved for backwards API compatibility ---

  async addAccessPoint(profileId: string, name: string, ownerId?: string): Promise<AccessPoint> {
    let resolvedOwnerId = ownerId;
    if (!resolvedOwnerId) {
      const profileRow = await this.db
        .prepare("SELECT owner_id FROM profiles WHERE id = ?")
        .bind(profileId)
        .first<{ owner_id: string }>();
      if (!profileRow?.owner_id) {
        throw new Error("Profile owner not found");
      }
      resolvedOwnerId = profileRow.owner_id;
    }
    return this.addAccessPointForOwner(resolvedOwnerId, name, profileId);
  }

  async updateAccessPointName(id: string, profileId: string, name: string): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    const result = await this.db
      .prepare("UPDATE access_points SET name = ?, updated_at = ? WHERE id = ? AND profile_id = ?")
      .bind(name, now, id, profileId)
      .run();
    return result.success;
  }

  async rotateAccessPointToken(id: string, profileId: string): Promise<string> {
    return this.rotateTokenWithCondition("id = ? AND profile_id = ?", [id, profileId]);
  }

  async deleteAccessPoint(id: string, profileId: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM access_points WHERE id = ? AND profile_id = ?")
      .bind(id, profileId)
      .run();
    return result.success;
  }
}

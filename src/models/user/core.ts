import { D1Database } from "@cloudflare/workers-types";
import { User } from "../../types";
import { UserRecord, CreateUserOptions } from "./types";
import { UserSecretProcessor } from "./secrets";
import { generateId } from "../../utils/crypto";
import { GENERATED_USER_ID_REGEX, USER_ID_REGEX } from "../../utils/validator";

const MAX_USER_ID_GENERATION_ATTEMPTS = 16;

/**
 * Handles core user entity lifecycle, querying, profile attributes, and CRUD operations.
 *
 * Single Responsibility: User identity entity persistence and profile metadata management.
 */
export class UserCoreModel {
  constructor(
    private db: D1Database,
    private secretProcessor: UserSecretProcessor
  ) {}

  /**
   * Retrieves a user by their unique identifier.
   * Transparently decrypts/migrates envelope-encrypted secrets if present.
   *
   * @param id The user ID.
   * @returns The user record with decrypted secrets, or null if not found.
   */
  async getById(id: string): Promise<UserRecord | null> {
    const user = await this.db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRecord>();
    return await this.secretProcessor.processUserSecrets(user);
  }

  /**
   * Retrieves a user by their username.
   * Transparently decrypts/migrates envelope-encrypted secrets if present.
   *
   * @param username The username.
   * @returns The user record with decrypted secrets, or null if not found or table doesn't exist.
   */
  async getByUsername(username: string): Promise<UserRecord | null> {
    try {
      const user = await this.db.prepare("SELECT * FROM users WHERE username = ?").bind(username).first<UserRecord>();
      return await this.secretProcessor.processUserSecrets(user);
    } catch (e: unknown) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      if (errorMsg.includes("no such table")) {
        return null;
      }
      throw e;
    }
  }

  /**
   * Retrieves a user by either their username (case-insensitive via COLLATE NOCASE)
   * or their user ID (checking exact match first, then lowercase canonical match).
   *
   * @param identifier - Username or user ID supplied at login.
   * @returns Matching user record with decrypted secrets, or null if not found.
   */
  async getByLoginIdentifier(identifier: string): Promise<UserRecord | null> {
    const trimmed = identifier.trim();
    if (!trimmed) {
      return null;
    }
    const byUsername = await this.getByUsername(trimmed);
    if (byUsername) {
      return byUsername;
    }
    const byExactId = await this.getById(trimmed);
    if (byExactId) {
      return byExactId;
    }
    const lower = trimmed.toLowerCase();
    if (lower !== trimmed) {
      return await this.getById(lower);
    }
    return null;
  }

  /**
   * Checks whether a proposed username or candidate ID conflicts with any existing user ID
   * (case-insensitive, including the caller's own ID) or any other user's username.
   *
   * @param candidate - Candidate username or user ID to check.
   * @param currentUserId - Optional caller user ID excluded from username self-collision during rename.
   * @returns True if a conflict exists.
   */
  async isUsernameConflict(candidate: string, currentUserId?: string): Promise<boolean> {
    const trimmed = candidate.trim();
    if (!trimmed) {
      return true;
    }
    try {
      const row = await this.db
        .prepare(
          "SELECT id FROM users WHERE LOWER(id) = LOWER(?) OR (username = ? AND (? IS NULL OR id != ?)) LIMIT 1"
        )
        .bind(trimmed, trimmed, currentUserId ?? null, currentUserId ?? null)
        .first<{ id: string }>();
      return !!row;
    } catch (e: unknown) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      if (errorMsg.includes("no such table")) {
        return false;
      }
      throw e;
    }
  }

  /**
   * Generates a valid 15-character hex user ID and ensures it does not collide with
   * any existing user ID, existing username, or the registering user's own username.
   *
   * @param reservedUsername - Optional username being registered in the same operation.
   * @returns Valid, collision-free user ID.
   */
  async generateUniqueUserId(reservedUsername?: string): Promise<string> {
    const reservedLower = reservedUsername?.trim().toLowerCase();
    for (let attempt = 0; attempt < MAX_USER_ID_GENERATION_ATTEMPTS; attempt++) {
      const candidate = generateId(15);
      if (!GENERATED_USER_ID_REGEX.test(candidate) || !USER_ID_REGEX.test(candidate)) {
        continue;
      }
      if (reservedLower && candidate.toLowerCase() === reservedLower) {
        continue;
      }
      if (!(await this.isUsernameConflict(candidate))) {
        return candidate;
      }
    }
    throw new Error("Failed to generate a unique valid user ID");
  }

  /**
   * Lists all users in the system, ordered by creation date descending.
   *
   * @returns Array of user summary entities.
   */
  async listAll(): Promise<User[]> {
    const { results } = await this.db.prepare(`
      SELECT 
        u.id, 
        u.username, 
        u.role, 
        u.created_at, 
        u.totp_enabled,
        (SELECT COUNT(1) FROM passkeys p WHERE p.user_id = u.id) as passkeys_count,
        u.timezone,
        u.locale,
        u.invite_code,
        u.has_password,
        u.last_active_at as last_resolve_at
      FROM users u
      ORDER BY u.created_at DESC
    `).all<User>();
    return results;
  }

  /**
   * Atomically creates the first admin user (only if users table is empty) or a standard user
   * within an optional maxUsers quota, preventing concurrent bootstrap/quota TOCTOU races.
   *
   * @param user - Options containing ID, username, password hash, role, timezone, etc.
   * @param maxUsers - Optional maximum user count (0 = unlimited).
   * @returns Outcome status: 'created', 'admin_exists', or 'max_users_reached'.
   */
  async createAtomic(
    user: CreateUserOptions,
    maxUsers: number = 0
  ): Promise<"created" | "admin_exists" | "max_users_reached"> {
    const now = Math.floor(Date.now() / 1000);
    const hasPasswordFlag = user.hasPassword === false ? 0 : 1;
    if (user.role === "admin") {
      const result = await this.db.prepare(
        "INSERT INTO users (id, username, hashed_password, role, created_at, timezone, locale, invite_code, has_password, password_version) " +
        "SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)"
      ).bind(
        user.id,
        user.username,
        user.passwordHash,
        user.role,
        now,
        user.timezone || null,
        user.locale || 'en-US',
        user.inviteCode || null,
        hasPasswordFlag,
        user.passwordVersion ?? 2
      ).run();
      if (!result.success) throw new Error("Failed to create admin user");
      return (result.meta?.changes ?? 0) > 0 ? "created" : "admin_exists";
    }

    if (maxUsers > 0) {
      const result = await this.db.prepare(
        "INSERT INTO users (id, username, hashed_password, role, created_at, timezone, locale, invite_code, has_password, password_version) " +
        "SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM users) < ?"
      ).bind(
        user.id,
        user.username,
        user.passwordHash,
        user.role,
        now,
        user.timezone || null,
        user.locale || 'en-US',
        user.inviteCode || null,
        hasPasswordFlag,
        user.passwordVersion ?? 2,
        maxUsers
      ).run();
      if (!result.success) throw new Error("Failed to create user");
      return (result.meta?.changes ?? 0) > 0 ? "created" : "max_users_reached";
    }

    const ok = await this.create(user);
    if (!ok) throw new Error("Failed to create user");
    return "created";
  }

  /**
   * Registers a new user in the database.
   *
   * @param user Options containing ID, username, password hash, role, timezone, etc.
   * @returns True if insertion succeeded.
   */
  async create(user: CreateUserOptions): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    const hasPasswordFlag = user.hasPassword === false ? 0 : 1;
    const result = await this.db.prepare(
      "INSERT INTO users (id, username, hashed_password, role, created_at, timezone, locale, invite_code, has_password, password_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      user.id,
      user.username,
      user.passwordHash,
      user.role,
      now,
      user.timezone || null,
      user.locale || 'en-US',
      user.inviteCode || null,
      hasPasswordFlag,
      user.passwordVersion ?? 2
    ).run();
    return result.success;
  }

  /**
   * Updates the username of a specified user.
   *
   * @param id The user ID.
   * @param username The new username.
   * @returns True if update succeeded.
   */
  async updateUsername(id: string, username: string): Promise<boolean> {
    const result = await this.db.prepare("UPDATE users SET username = ? WHERE id = ?").bind(username, id).run();
    return result.success;
  }

  /**
   * Updates the preferred timezone of a user.
   *
   * @param id The user ID.
   * @param timezone The timezone string (e.g. 'Asia/Shanghai') or null.
   * @returns True if update succeeded.
   */
  async updateTimezone(id: string, timezone: string | null): Promise<boolean> {
    const result = await this.db.prepare("UPDATE users SET timezone = ? WHERE id = ?").bind(timezone, id).run();
    return result.success;
  }

  /**
   * Updates the preferred UI locale of a user.
   *
   * @param id The user ID.
   * @param locale The locale code (e.g. 'zh-CN', 'en-US') or null.
   * @returns True if update succeeded.
   */
  async updateLocale(id: string, locale: string | null): Promise<boolean> {
    const result = await this.db.prepare("UPDATE users SET locale = ? WHERE id = ?").bind(locale || 'en-US', id).run();
    return result.success;
  }

  /**
   * Deletes a user account by their ID.
   *
   * @param id The user ID.
   * @returns True if deletion succeeded.
   */
  async delete(id: string): Promise<boolean> {
    const result = await this.db.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
    return result.success;
  }

  /**
   * Retrieves the total count of registered users.
   *
   * @returns The total number of users registered in the system.
   */
  async count(): Promise<number> {
    const count = await this.db.prepare("SELECT COUNT(*) as count FROM users").first<number>('count');
    return count ?? 0;
  }

  /**
   * Checks whether the users table is completely empty (no users registered).
   *
   * Security consideration (CWE-636 Fail-Closed):
   * When the query fails, we must NEVER assume the database is empty, as that
   * could lead to privilege escalation (e.g. assigning 'admin' role to new signups).
   *
   * @returns True if there are confirmed 0 users in the database, false otherwise.
   */
  async isEmpty(): Promise<boolean> {
    try {
      const count = await this.db.prepare("SELECT COUNT(*) as count FROM users").first<number>('count');
      return (count ?? 0) === 0;
    } catch (err) {
      console.error("[UserModel] isEmpty: query failed, failing closed (assuming users exist):", err);
      return false;
    }
  }
}

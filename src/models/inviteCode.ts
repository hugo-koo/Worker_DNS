import { D1Database } from "@cloudflare/workers-types";
import { INVITE_CODE_REGEX, normalizeInviteCode } from "../utils/validator";

const INVITE_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const INVITE_CODE_LENGTH = 6;
const MAX_CODE_GEN_ATTEMPTS = 16;

/**
 * Database representation of an invitation code record.
 */
export interface InviteCodeRecord {
  code: string;
  max_uses: number;
  remaining_uses: number;
  /** Expiration Unix timestamp in seconds, or null if never expires. */
  expires_at: number | null;
  /** Last successful consumption Unix timestamp in seconds, or null if unused. */
  last_used_at: number | null;
  /** Creation Unix timestamp in seconds. */
  created_at: number;
  created_by?: string | null;
}

/**
 * Options for creating a new invitation code.
 */
export interface CreateInviteCodeOptions {
  code?: string;
  maxUses: number;
  expiresAt?: number | null;
  createdBy?: string | null;
}

export type InviteCodeValidationError =
  | "invite_code_invalid"
  | "invite_code_expired"
  | "invite_code_exhausted";

export type InviteCodeValidationResult =
  | { valid: true; record: InviteCodeRecord }
  | { valid: false; reason: InviteCodeValidationError };

/**
 * Generates a cryptographically random 6-character uppercase alphanumeric invite code.
 *
 * @returns 6-character `[A-Z0-9]{6}` string.
 */
export function generateRandomInviteCode(): string {
  const randomBytes = new Uint8Array(INVITE_CODE_LENGTH);
  crypto.getRandomValues(randomBytes);
  let result = "";
  for (let i = 0; i < INVITE_CODE_LENGTH; i++) {
    result += INVITE_CODE_ALPHABET[randomBytes[i] % INVITE_CODE_ALPHABET.length];
  }
  return result;
}

/**
 * Manages invite code creation, validation, atomic consumption, and administration.
 */
export class InviteCodeModel {
  constructor(private db: D1Database) {}

  /**
   * Lists all invite codes ordered by creation time descending.
   *
   * @returns Array of invite code records.
   */
  async listAll(): Promise<InviteCodeRecord[]> {
    const { results } = await this.db
      .prepare(
        "SELECT code, max_uses, remaining_uses, expires_at, last_used_at, created_at, created_by FROM invite_codes ORDER BY created_at DESC"
      )
      .all<InviteCodeRecord>();
    return results;
  }

  /**
   * Looks up a single invite code record by normalized code.
   *
   * @param code - Candidate invite code.
   * @returns Matching record or null if not found.
   */
  async getByCode(code: string): Promise<InviteCodeRecord | null> {
    const normalized = normalizeInviteCode(code);
    if (!INVITE_CODE_REGEX.test(normalized)) {
      return null;
    }
    return await this.db
      .prepare(
        "SELECT code, max_uses, remaining_uses, expires_at, last_used_at, created_at, created_by FROM invite_codes WHERE code = ?"
      )
      .bind(normalized)
      .first<InviteCodeRecord>();
  }

  /**
   * Creates a new invite code record with explicit or auto-generated 6-char code.
   *
   * @param options - Creation parameters (`maxUses >= 1`, optional `code`, optional `expiresAt` in Unix seconds).
   * @returns Created InviteCodeRecord.
   */
  async create(options: CreateInviteCodeOptions): Promise<InviteCodeRecord> {
    const now = Math.floor(Date.now() / 1000);
    const maxUses = Math.floor(options.maxUses);
    if (!Number.isFinite(maxUses) || maxUses < 1) {
      throw new Error("invalid_max_uses");
    }

    let expiresAt: number | null = null;
    if (options.expiresAt !== undefined && options.expiresAt !== null) {
      const parsedExp = Math.floor(options.expiresAt);
      if (!Number.isFinite(parsedExp) || parsedExp <= now) {
        throw new Error("invalid_expires_at");
      }
      expiresAt = parsedExp;
    }

    if (options.code !== undefined && options.code.trim() !== "") {
      const normalized = normalizeInviteCode(options.code);
      if (!INVITE_CODE_REGEX.test(normalized)) {
        throw new Error("invalid_invite_code_format");
      }
      const existing = await this.getByCode(normalized);
      if (existing) {
        throw new Error("invite_code_exists");
      }
      await this.db
        .prepare(
          "INSERT INTO invite_codes (code, max_uses, remaining_uses, expires_at, last_used_at, created_at, created_by) VALUES (?, ?, ?, ?, NULL, ?, ?)"
        )
        .bind(normalized, maxUses, maxUses, expiresAt, now, options.createdBy ?? null)
        .run();

      return {
        code: normalized,
        max_uses: maxUses,
        remaining_uses: maxUses,
        expires_at: expiresAt,
        last_used_at: null,
        created_at: now,
        created_by: options.createdBy ?? null,
      };
    }

    for (let attempt = 0; attempt < MAX_CODE_GEN_ATTEMPTS; attempt++) {
      const candidate = generateRandomInviteCode();
      try {
        const res = await this.db
          .prepare(
            "INSERT INTO invite_codes (code, max_uses, remaining_uses, expires_at, last_used_at, created_at, created_by) VALUES (?, ?, ?, ?, NULL, ?, ?)"
          )
          .bind(candidate, maxUses, maxUses, expiresAt, now, options.createdBy ?? null)
          .run();
        if (res.success && (res.meta?.changes ?? 0) > 0) {
          return {
            code: candidate,
            max_uses: maxUses,
            remaining_uses: maxUses,
            expires_at: expiresAt,
            last_used_at: null,
            created_at: now,
            created_by: options.createdBy ?? null,
          };
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("UNIQUE") || msg.includes("PRIMARY KEY")) {
          continue;
        }
        throw err;
      }
    }

    throw new Error("Failed to generate a unique invite code");
  }

  /**
   * Validates whether an invite code exists, is not expired, and has remaining uses.
   *
   * @param code - Candidate invite code.
   * @param now - Current Unix timestamp in seconds (defaults to current time).
   * @returns Validation outcome with specific failure reason.
   */
  async validateForSignup(
    code: string,
    now: number = Math.floor(Date.now() / 1000)
  ): Promise<InviteCodeValidationResult> {
    const normalized = normalizeInviteCode(code);
    if (!INVITE_CODE_REGEX.test(normalized)) {
      return { valid: false, reason: "invite_code_invalid" };
    }

    const record = await this.getByCode(normalized);
    if (!record) {
      return { valid: false, reason: "invite_code_invalid" };
    }
    if (record.expires_at !== null && record.expires_at <= now) {
      return { valid: false, reason: "invite_code_expired" };
    }
    if (record.remaining_uses <= 0) {
      return { valid: false, reason: "invite_code_exhausted" };
    }

    return { valid: true, record };
  }

  /**
   * Atomically decrements remaining uses by 1 and stamps `last_used_at` if valid and available.
   *
   * @param code - Normalized 6-character invite code.
   * @param now - Current Unix timestamp in seconds.
   * @returns True if 1 use was successfully consumed; false if exhausted, expired, or invalid.
   */
  async consumeAtomically(
    code: string,
    now: number = Math.floor(Date.now() / 1000)
  ): Promise<boolean> {
    const normalized = normalizeInviteCode(code);
    if (!INVITE_CODE_REGEX.test(normalized)) {
      return false;
    }

    const result = await this.db
      .prepare(
        "UPDATE invite_codes " +
          "SET remaining_uses = remaining_uses - 1, last_used_at = ? " +
          "WHERE code = ? AND remaining_uses > 0 AND (expires_at IS NULL OR expires_at > ?)"
      )
      .bind(now, normalized, now)
      .run();

    return result.success && (result.meta?.changes ?? 0) > 0;
  }

  /**
   * Refunds 1 invite code use if subsequent user registration fails and rolls back.
   *
   * @param code - Normalized 6-character invite code.
   */
  async refundOne(code: string): Promise<void> {
    const normalized = normalizeInviteCode(code);
    if (!INVITE_CODE_REGEX.test(normalized)) return;
    await this.db
      .prepare(
        "UPDATE invite_codes SET remaining_uses = MIN(max_uses, remaining_uses + 1) WHERE code = ?"
      )
      .bind(normalized)
      .run();
  }

  /**
   * Deletes an invite code record.
   *
   * @param code - Invite code to remove.
   * @returns True if deleted.
   */
  async delete(code: string): Promise<boolean> {
    const normalized = normalizeInviteCode(code);
    if (!INVITE_CODE_REGEX.test(normalized)) return false;
    const result = await this.db
      .prepare("DELETE FROM invite_codes WHERE code = ?")
      .bind(normalized)
      .run();
    return result.success && (result.meta?.changes ?? 0) > 0;
  }
}

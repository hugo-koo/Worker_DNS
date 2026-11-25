/**
 * @file keyStore.ts
 * @description Strictly ephemeral in-memory key store for unlocked E2EE private keys.
 * Never persists private key material to localStorage or sessionStorage, and enforces
 * automatic idle expiration to bound plaintext key residency in memory.
 */

import type { UnlockedPrivateKey, ProfileE2eeStatus } from "./types";

/** Default idle lifetime for unlocked E2EE keys in memory (15 minutes). */
export const DEFAULT_E2EE_IDLE_TTL_MS = 15 * 60 * 1000;

/**
 * Overwrites mutable string fields on a cached key object before discarding its reference.
 */
function scrubKeyObject(sk: UnlockedPrivateKey | undefined): void {
  if (!sk || typeof sk !== "object") return;
  const mutable = sk as unknown as Record<string, unknown>;
  if ("seedBase64" in mutable) {
    mutable.seedBase64 = "";
  }
  if ("d" in mutable) {
    mutable.d = "";
  }
  if ("legacyKey" in mutable && mutable.legacyKey && typeof mutable.legacyKey === "object") {
    const legacy = mutable.legacyKey as Record<string, unknown>;
    if ("d" in legacy) legacy.d = "";
  }
}

export class KeyStore {
  /** Strictly in-memory store for unlocked private keys (profileId or "account" -> UnlockedPrivateKey) */
  private unlockedKeys = new Map<string, UnlockedPrivateKey>();
  private lastAccessedAt = 0;
  private idleTtlMs: number;

  constructor(idleTtlMs: number = DEFAULT_E2EE_IDLE_TTL_MS) {
    this.idleTtlMs = Math.max(1000, idleTtlMs);
    this.purgeWebStorageKeys();
  }

  /**
   * Updates the idle auto-lock TTL for unlocked in-memory keys.
   */
  setIdleTtlMs(idleTtlMs: number): void {
    this.idleTtlMs = Math.max(1000, idleTtlMs);
  }

  /**
   * Checks whether an unlocked key has exceeded its idle residency window and purges if expired.
   */
  private expireIfIdle(now: number = Date.now()): boolean {
    if (this.unlockedKeys.size === 0) return false;
    if (this.lastAccessedAt > 0 && now - this.lastAccessedAt > this.idleTtlMs) {
      this.clearStorage();
      return true;
    }
    return false;
  }

  /**
   * Purges any legacy E2EE private key entries from sessionStorage and localStorage
   * so plaintext secrets never persist to Web Storage.
   */
  private purgeWebStorageKeys(): void {
    try {
      if (typeof sessionStorage !== "undefined") {
        const sessionKeys: string[] = [];
        for (let i = 0; i < sessionStorage.length; i++) {
          const k = sessionStorage.key(i);
          if (k?.startsWith("dns_worker_e2ee_sk_") || k?.startsWith("obex_e2ee_sk_")) {
            sessionKeys.push(k);
          }
        }
        sessionKeys.forEach((k) => sessionStorage.removeItem(k));
      }
    } catch {
      // Ignore Web Storage errors inside Workers / restricted contexts
    }

    try {
      if (typeof localStorage !== "undefined") {
        const localKeys: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k?.startsWith("dns_worker_e2ee_sk_") || k?.startsWith("obex_e2ee_sk_")) {
            localKeys.push(k);
          }
        }
        localKeys.forEach((k) => localStorage.removeItem(k));
      }
    } catch {
      // Ignore Web Storage errors inside Workers / restricted contexts
    }
  }

  /**
   * Checks whether an unlocked private key is structurally compatible with the server's active public key.
   */
  isKeyCompatibleWithServer(sk: UnlockedPrivateKey, serverPublicKeyJson?: string | null): boolean {
    if (!serverPublicKeyJson) return true;
    try {
      const parsed = typeof serverPublicKeyJson === "string" ? JSON.parse(serverPublicKeyJson) : serverPublicKeyJson;
      const serverIsPqc = parsed.alg === "P256-MLKEM768" || Boolean(parsed.pqc_pk);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const keyIsPqc = "seedBase64" in sk || (sk as any).alg === "P256-MLKEM768";
      if (serverIsPqc && !keyIsPqc) {
        return false;
      }
      return true;
    } catch {
      return true;
    }
  }

  /**
   * Validates cached private key against server public key and cleans up stale keys if incompatible.
   */
  validateCachedKeyAgainstStatus(status: ProfileE2eeStatus): void {
    if (!status.publicKey) return;
    const cachedKey = this.getPrivateKey("account");
    if (cachedKey && !this.isKeyCompatibleWithServer(cachedKey, status.publicKey)) {
      console.warn("[E2EE KeyStore] Cached private key does not match server algorithm. Purging stale key.");
      this.clearStorage();
    }
  }

  /**
   * Checks whether the current session has an active, unexpired private key in memory.
   */
  isUnlocked(): boolean {
    return this.getPrivateKey("account") !== null;
  }

  /**
   * Checks whether the current session has an active, unexpired private key for this profile or account.
   */
  isProfileUnlocked(profileId: string): boolean {
    return this.getPrivateKey(profileId) !== null;
  }

  /**
   * Purges legacy profile-specific and account Web Storage entries defensively.
   */
  purgeProfileStorageKeys(): void {
    this.purgeWebStorageKeys();
  }

  /**
   * Gets the unlocked private key from in-memory store (zero Web Storage fallback).
   */
  getPrivateKey(profileId?: string): UnlockedPrivateKey | null {
    const now = Date.now();
    if (this.expireIfIdle(now)) {
      return null;
    }

    if (this.unlockedKeys.has("account")) {
      this.lastAccessedAt = now;
      return this.unlockedKeys.get("account")!;
    }
    if (profileId && this.unlockedKeys.has(profileId)) {
      this.lastAccessedAt = now;
      return this.unlockedKeys.get(profileId)!;
    }

    return null;
  }

  /**
   * Stores the unlocked private key strictly in memory (never sessionStorage or localStorage).
   */
  setPrivateKey(profileOrAccountKey: string, sk: UnlockedPrivateKey): void {
    this.purgeWebStorageKeys();
    for (const [k, existing] of this.unlockedKeys.entries()) {
      if (existing !== sk) {
        scrubKeyObject(existing);
      }
      this.unlockedKeys.delete(k);
    }
    this.unlockedKeys.set("account", sk);
    if (profileOrAccountKey && profileOrAccountKey !== "account") {
      this.unlockedKeys.set(profileOrAccountKey, sk);
    }
    this.lastAccessedAt = Date.now();
  }

  /**
   * Deletes a profile-specific in-memory key and clears any legacy Web Storage entries.
   */
  deleteProfileKey(profileId: string): void {
    const existing = this.unlockedKeys.get(profileId);
    if (existing && existing !== this.unlockedKeys.get("account")) {
      scrubKeyObject(existing);
    }
    this.unlockedKeys.delete(profileId);
    this.purgeWebStorageKeys();
  }

  /**
   * Scrubs and clears all unlocked keys from memory and defensively wipes Web Storage.
   */
  clearStorage(): void {
    for (const existing of this.unlockedKeys.values()) {
      scrubKeyObject(existing);
    }
    this.unlockedKeys.clear();
    this.lastAccessedAt = 0;
    this.purgeWebStorageKeys();
  }
}

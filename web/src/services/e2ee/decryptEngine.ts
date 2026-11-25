/**
 * @file decryptEngine.ts
 * @description Log entry and batch decryption engine for Classical ECDH and Post-Quantum P256-MLKEM768.
 */

import { ml_kem768_p256 } from "@noble/post-quantum/hybrid.js";
import type { LogEntry } from "../../views/LogsView/types";
import type { EncryptedPayload, SensitiveLogData } from "./types";
import { fromBase64, deriveDekFromSharedSecret, decryptSensitiveLogDataWithDek } from "./crypto";
import type { KeyStore } from "./keyStore";
import { zeroizeBuffer, zeroizeBuffers } from "../../utils/memory";

/** Maximum number of derived AES-GCM DEKs kept in memory (LRU bounded). */
export const MAX_DEK_CACHE_ENTRIES = 64;

/** Maximum lifetime of a cached AES-GCM DEK in memory (15 minutes). */
export const DEK_CACHE_TTL_MS = 15 * 60 * 1000;

interface CachedDekEntry {
  dek: CryptoKey;
  expiresAt: number;
}

export class DecryptEngine {
  /** Bounded in-memory DEK LRU+TTL cache: kem_key_id -> CachedDekEntry */
  private dekCache = new Map<string, CachedDekEntry>();
  private keyStore: KeyStore;

  constructor(keyStore: KeyStore) {
    this.keyStore = keyStore;
  }

  /**
   * Retrieves a valid, unexpired DEK from the bounded LRU cache.
   */
  private getCachedDek(kemKeyId: string, now: number = Date.now()): CryptoKey | undefined {
    const entry = this.dekCache.get(kemKeyId);
    if (!entry) return undefined;
    if (now >= entry.expiresAt) {
      this.dekCache.delete(kemKeyId);
      return undefined;
    }
    // Refresh LRU order
    this.dekCache.delete(kemKeyId);
    this.dekCache.set(kemKeyId, entry);
    return entry.dek;
  }

  /**
   * Stores a derived DEK in the bounded LRU+TTL cache, pruning expired and oldest entries.
   */
  private setCachedDek(kemKeyId: string, dek: CryptoKey, now: number = Date.now()): void {
    for (const [k, entry] of this.dekCache.entries()) {
      if (now >= entry.expiresAt) {
        this.dekCache.delete(k);
      }
    }
    if (this.dekCache.has(kemKeyId)) {
      this.dekCache.delete(kemKeyId);
    } else if (this.dekCache.size >= MAX_DEK_CACHE_ENTRIES) {
      const oldestKey = this.dekCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.dekCache.delete(oldestKey);
      }
    }
    this.dekCache.set(kemKeyId, { dek, expiresAt: now + DEK_CACHE_TTL_MS });
  }

  /**
   * Clears in-memory DEK cache.
   */
  clearDekCache(): void {
    this.dekCache.clear();
  }

  /**
   * Decrypts a single log entry if encrypted and if the private key is unlocked.
   */
  async decryptLogEntry(profileId: string, log: LogEntry): Promise<LogEntry> {
    const version = log.encrypt_version ?? (log.encrypted_payload ? 1 : 0);
    if (version === 0 || !log.encrypted_payload) {
      return log;
    }

    const privKey = this.keyStore.getPrivateKey(profileId);
    if (!privKey) {
      // Not unlocked yet, keep placeholder
      return {
        ...log,
        domain: log.domain || "[Encrypted]",
        client_ip: log.client_ip || "[Encrypted]",
      };
    }

    try {
      if (version === 2) {
        // Generation 2: P256-MLKEM768 Periodic Envelope Encryption
        let dek: CryptoKey | undefined;
        if (log.kem_key_id) {
          dek = this.getCachedDek(log.kem_key_id);
          if (!dek && log.kem_ct && "seedBase64" in privKey) {
            const seed = fromBase64(privKey.seedBase64);
            const kemCt = fromBase64(log.kem_ct);
            let sharedSecret: Uint8Array | null = null;
            try {
              sharedSecret = ml_kem768_p256.decapsulate(kemCt, seed);
              dek = await deriveDekFromSharedSecret(sharedSecret);
              this.setCachedDek(log.kem_key_id, dek);
            } finally {
              zeroizeBuffers(seed, kemCt, sharedSecret);
            }
          }
        }

        if (!dek) {
          return {
            ...log,
            domain: log.domain || "[Encrypted]",
            client_ip: log.client_ip || "[Encrypted]",
          };
        }

        const data = await decryptSensitiveLogDataWithDek(dek, log.encrypted_payload);
        let destCountryCode = data.dest_country_code ?? log.dest_country_code;
        let destCountry = data.dest_country ?? log.dest_country;
        let destIsp = data.dest_isp ?? log.dest_isp;
        const rawGeoJson = data.dest_geoip ?? log.dest_geoip;
        if ((!destCountryCode || !destCountry) && rawGeoJson) {
          try {
            const parsed = JSON.parse(rawGeoJson);
            if (!destCountryCode && parsed.country_code) destCountryCode = parsed.country_code.toUpperCase();
            if (!destCountry && parsed.country) destCountry = parsed.country;
            if (!destIsp && parsed.isp) destIsp = parsed.isp;
          } catch {}
        }

        return {
          ...log,
          domain: data.domain || log.domain,
          client_ip: data.client_ip || log.client_ip,
          geo_country: data.geo_country ?? log.geo_country,
          answer: data.answer ?? log.answer,
          dest_geoip: rawGeoJson,
          dest_country_code: destCountryCode,
          dest_country: destCountry,
          dest_isp: destIsp,
          ecs: data.ecs ?? log.ecs,
          upstream: data.upstream ?? log.upstream,
          reason: data.reason ?? log.reason,
          encrypt_version: 0,
        };
      }

      if (version === 1) {
        // Generation 1: Legacy P-256 ECDH
        const payload: EncryptedPayload = JSON.parse(log.encrypted_payload);
        const privKeyJwk = (
          "kty" in privKey
            ? privKey
            : "legacyKey" in privKey && privKey.legacyKey
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ? (privKey as any).legacyKey
            : null
        ) as JsonWebKey | null;
        if (!privKeyJwk) {
          return {
            ...log,
            domain: "[Decryption Failed: Legacy Key Mismatch]",
          };
        }

        const importedPriv = await crypto.subtle.importKey(
          "jwk",
          privKeyJwk,
          { name: "ECDH", namedCurve: "P-256" },
          false,
          ["deriveKey"]
        );

        const importedEphem = await crypto.subtle.importKey(
          "jwk",
          payload.ephem_pk,
          { name: "ECDH", namedCurve: "P-256" },
          false,
          []
        );

        const aesKey = await crypto.subtle.deriveKey(
          { name: "ECDH", public: importedEphem } as unknown as Parameters<SubtleCrypto["deriveKey"]>[0],
          importedPriv,
          { name: "AES-GCM", length: 256 },
          false,
          ["decrypt"]
        );

        const iv = fromBase64(payload.iv);
        const ciphertext = fromBase64(payload.ciphertext);
        let decryptedBytes: ArrayBuffer | null = null;
        let data: SensitiveLogData;
        try {
          decryptedBytes = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: iv as BufferSource },
            aesKey,
            ciphertext as BufferSource
          );

          data = JSON.parse(new TextDecoder().decode(decryptedBytes)) as SensitiveLogData;
        } finally {
          zeroizeBuffer(decryptedBytes);
        }
        let destCountryCode = data.dest_country_code ?? log.dest_country_code;
        let destCountry = data.dest_country ?? log.dest_country;
        let destIsp = data.dest_isp ?? log.dest_isp;
        const rawGeoJson = data.dest_geoip ?? log.dest_geoip;
        if ((!destCountryCode || !destCountry) && rawGeoJson) {
          try {
            const parsed = JSON.parse(rawGeoJson);
            if (!destCountryCode && parsed.country_code) destCountryCode = parsed.country_code.toUpperCase();
            if (!destCountry && parsed.country) destCountry = parsed.country;
            if (!destIsp && parsed.isp) destIsp = parsed.isp;
          } catch {}
        }

        return {
          ...log,
          domain: data.domain || log.domain,
          client_ip: data.client_ip || log.client_ip,
          geo_country: data.geo_country ?? log.geo_country,
          answer: data.answer ?? log.answer,
          dest_geoip: rawGeoJson,
          dest_country_code: destCountryCode,
          dest_country: destCountry,
          dest_isp: destIsp,
          ecs: data.ecs ?? log.ecs,
          upstream: data.upstream ?? log.upstream,
          reason: data.reason ?? log.reason,
          encrypt_version: 0,
        };
      }

      return log;
    } catch (err) {
      console.warn("[E2EE DecryptEngine] Failed to decrypt log #%s:", String(log.id), err);
      return {
        ...log,
        domain: "[Decryption Failed]",
      };
    }
  }

  /**
   * Decrypts a batch of logs concurrently with DEK pre-caching.
   */
  async decryptLogsBatch(profileId: string, logs: LogEntry[]): Promise<LogEntry[]> {
    if (!logs || logs.length === 0) return logs;
    const hasEncrypted = logs.some((l) => (l.encrypt_version ?? (l.encrypted_payload ? 1 : 0)) > 0);
    if (!hasEncrypted) return logs;

    const privKey = this.keyStore.getPrivateKey(profileId);
    if (privKey && "seedBase64" in privKey) {
      const seed = fromBase64(privKey.seedBase64);
      try {
        // Pre-decapsulate any uncached DEKs in the batch
        const missingKeyMap = new Map<string, string>(); // kemKeyId -> kemCt
        for (const log of logs) {
          if (log.encrypt_version === 2 && log.kem_key_id && log.kem_ct && !this.getCachedDek(log.kem_key_id)) {
            missingKeyMap.set(log.kem_key_id, log.kem_ct);
          }
        }

        for (const [kemKeyId, kemCtBase64] of missingKeyMap.entries()) {
          const kemCt = fromBase64(kemCtBase64);
          let sharedSecret: Uint8Array | null = null;
          try {
            sharedSecret = ml_kem768_p256.decapsulate(kemCt, seed);
            const dek = await deriveDekFromSharedSecret(sharedSecret);
            this.setCachedDek(kemKeyId, dek);
          } catch (decapsErr) {
            console.warn(`[E2EE DecryptEngine] Failed to decapsulate DEK for ${kemKeyId}:`, decapsErr);
          } finally {
            zeroizeBuffers(kemCt, sharedSecret);
          }
        }
      } finally {
        zeroizeBuffer(seed);
      }
    }

    return Promise.all(logs.map((log) => this.decryptLogEntry(profileId, log)));
  }
}

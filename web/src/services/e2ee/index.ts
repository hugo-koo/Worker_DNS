/**
 * @file index.ts
 * @description Master facade for Client-side End-to-End Encryption (E2EE) Service.
 * Unifies E2eeCryptoSandbox (Web Worker isolated key custody + bounded DEK cache) and E2eeApi
 * under a backwards-compatible interface.
 */

import type { LogEntry } from "../../views/LogsView/types";
import type {
  ProfileE2eeStatus,
  EncryptedPayload,
  CompactEncryptedLogPayload,
  UnlockedPrivateKey,
  SensitiveLogData
} from "./types";
import { E2eeCryptoSandbox } from "./cryptoSandbox";
import { E2eeApi } from "./api";
import { derivePasskeyKek, type DerivedPasskeyKek, type DerivePasskeyKekOptions } from "./passkeyKek";
import {
  deriveRecoveryKek,
  wrapPrivateKeyWithRecoveryKey,
  unwrapPrivateKeyWithRecoveryKey,
  type WrappedRecoveryKey
} from "./recoveryKek";

export type {
  ProfileE2eeStatus,
  EncryptedPayload,
  CompactEncryptedLogPayload,
  UnlockedPrivateKey,
  SensitiveLogData,
  DerivedPasskeyKek,
  WrappedRecoveryKey
};

export class E2eeService {
  private sandbox = new E2eeCryptoSandbox();
  private api = new E2eeApi(this.sandbox);

  // ── Status & Capabilities ──

  async getUserStatus(): Promise<ProfileE2eeStatus> {
    return this.api.getUserStatus();
  }

  async getStatus(profileId: string): Promise<ProfileE2eeStatus> {
    return this.api.getStatus(profileId);
  }

  isUnlocked(): boolean {
    return this.sandbox.isUnlocked();
  }

  isProfileUnlocked(profileId: string): boolean {
    return this.sandbox.isProfileUnlocked(profileId);
  }

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

  clearStorage(): void {
    this.sandbox.clearStorage();
  }

  // ── Key Derivation & Wrapping ──

  async derivePasskeyKek(
    saltScope: string = "account",
    options?: DerivePasskeyKekOptions
  ): Promise<DerivedPasskeyKek> {
    return derivePasskeyKek(saltScope, options);
  }

  async deriveRecoveryKek(plaintextRecoveryKey: string, salt: Uint8Array): Promise<CryptoKey> {
    return deriveRecoveryKek(plaintextRecoveryKey, salt);
  }

  async wrapPrivateKeyWithRecoveryKey(
    privateKey: UnlockedPrivateKey,
    plaintextRecoveryKey: string
  ): Promise<WrappedRecoveryKey> {
    return wrapPrivateKeyWithRecoveryKey(privateKey, plaintextRecoveryKey);
  }

  async unwrapPrivateKeyWithRecoveryKey(
    encryptedSkBase64: string,
    ivBase64: string,
    saltBase64: string,
    plaintextRecoveryKey: string
  ): Promise<UnlockedPrivateKey> {
    return unwrapPrivateKeyWithRecoveryKey(
      encryptedSkBase64,
      ivBase64,
      saltBase64,
      plaintextRecoveryKey
    );
  }

  // ── Key Lifecycle & Enable / Disable ──

  async enableUserE2ee(passkeyIdOverride?: string): Promise<boolean> {
    return this.api.enableUserE2ee(passkeyIdOverride);
  }

  async rotateUserE2eeKey(passkeyIdOverride?: string): Promise<boolean> {
    return this.api.rotateUserE2eeKey(passkeyIdOverride);
  }

  async enableE2ee(profileId: string, passkeyId: string): Promise<boolean> {
    return this.api.enableE2ee(profileId, passkeyId);
  }

  async disableUserE2ee(): Promise<boolean> {
    return this.api.disableUserE2ee();
  }

  async disableE2ee(profileId: string): Promise<boolean> {
    return this.api.disableE2ee(profileId);
  }

  // ── Unlocking & Enrollment ──

  async unlockUser(): Promise<boolean> {
    return this.api.unlockUser();
  }

  async unlockProfile(profileId: string): Promise<boolean> {
    return this.api.unlockProfile(profileId);
  }

  async unlockWithRecoveryKey(plaintextRecoveryKey: string): Promise<boolean> {
    return this.api.unlockWithRecoveryKey(plaintextRecoveryKey);
  }

  async initUserE2eeWithRecoveryKey(plaintextRecoveryKey: string): Promise<boolean> {
    return this.api.initUserE2eeWithRecoveryKey(plaintextRecoveryKey);
  }

  async wrapCurrentKeyForPasskey(passkeyId?: string, targetPasskeyIds?: string[]): Promise<boolean> {
    return this.api.wrapCurrentKeyForPasskey(passkeyId, targetPasskeyIds);
  }

  async wrapCurrentKeyForRecovery(newRecoveryKey: string): Promise<boolean> {
    return this.api.wrapCurrentKeyForRecovery(newRecoveryKey);
  }

  // ── Log Decryption ──

  async decryptLogEntry(profileId: string, log: LogEntry): Promise<LogEntry> {
    return this.sandbox.decryptLogEntry(profileId, log);
  }

  async decryptLogsBatch(profileId: string, logs: LogEntry[]): Promise<LogEntry[]> {
    return this.sandbox.decryptLogsBatch(profileId, logs);
  }
}

export const e2ee = new E2eeService();

/**
 * @file cryptoSandbox.ts
 * @description Worker-isolated E2EE cryptographic sandbox with seamless in-process fallback
 * for non-Worker test/SSR environments. Keeps unlocked private keys out of the main thread DOM heap
 * whenever Web Workers are available, and enforces ephemeral memory residency everywhere.
 */

import E2eeCryptoWorker from "../../web-worker/e2eeCrypto.worker?worker";
import type { LogEntry } from "../../views/LogsView/types";
import type { ProfileE2eeStatus } from "./types";
import { KeyStore, DEFAULT_E2EE_IDLE_TTL_MS } from "./keyStore";
import { DecryptEngine } from "./decryptEngine";
import {
  generatePqcKeyPairPayload,
  wrapPrivateKeyWithKek,
  unwrapPrivateKeyWithKek,
} from "./keyOperations";
import {
  wrapPrivateKeyWithRecoveryKey,
  unwrapPrivateKeyWithRecoveryKey,
  type WrappedRecoveryKey,
} from "./recoveryKek";
import { zeroizeBuffers } from "../../utils/memory";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

function toDetachedCopy(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  zeroizeBuffers(bytes);
  return copy.buffer;
}

/**
 * Coordinates E2EE key custody and log decryption inside an isolated Web Worker sandbox,
 * maintaining only non-secret unlock status flags synchronously on the main thread.
 */
export class E2eeCryptoSandbox {
  private worker: Worker | null = null;
  private pendingRequests = new Map<string, PendingRequest>();

  // Lightweight non-secret metadata mirror on main thread for synchronous UI checks
  private accountUnlocked = false;
  private profileUnlockedSet = new Set<string>();
  private cachedKeyIsPqc = false;
  private lastTouchedAt = 0;
  private idleTtlMs = DEFAULT_E2EE_IDLE_TTL_MS;

  // Fallback runtime used only when Web Workers are unavailable (e.g. Node unit tests)
  private fallbackKeyStore = new KeyStore(this.idleTtlMs);
  private fallbackDecryptEngine = new DecryptEngine(this.fallbackKeyStore);

  private hasWorkerSupport(): boolean {
    return typeof Worker !== "undefined";
  }

  private getWorker(): Worker {
    if (!this.worker) {
      const worker = new E2eeCryptoWorker();
      worker.onmessage = (e: MessageEvent<{ id: string; success: boolean; data?: unknown; error?: string }>) => {
        const { id, success, data, error } = e.data;
        const pending = this.pendingRequests.get(id);
        if (!pending) return;
        this.pendingRequests.delete(id);
        if (success) {
          pending.resolve(data);
        } else {
          pending.reject(new Error(error || "E2EE crypto worker execution failed"));
        }
      };
      worker.onerror = (err: ErrorEvent) => {
        console.error("[E2eeCryptoSandbox] Worker error:", err);
        for (const [, pending] of this.pendingRequests.entries()) {
          pending.reject(new Error(`E2EE Worker error: ${err.message || "Worker failure"}`));
        }
        this.pendingRequests.clear();
        this.resetMirror();
      };
      this.worker = worker;
    }
    return this.worker;
  }

  private sendWorkerRequest<T>(type: string, payload?: unknown, transferables: Transferable[] = []): Promise<T> {
    const worker = this.getWorker();
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      worker.postMessage({ id, type, payload }, transferables);
    });
  }

  private resetMirror(): void {
    this.accountUnlocked = false;
    this.profileUnlockedSet.clear();
    this.cachedKeyIsPqc = false;
    this.lastTouchedAt = 0;
  }

  private markUnlocked(profileOrAccountKey: string, isPqc: boolean): void {
    this.accountUnlocked = true;
    if (profileOrAccountKey && profileOrAccountKey !== "account") {
      this.profileUnlockedSet.add(profileOrAccountKey);
    }
    this.cachedKeyIsPqc = isPqc;
    this.lastTouchedAt = Date.now();
  }

  private expireMirrorIfIdle(): boolean {
    if (!this.accountUnlocked && this.profileUnlockedSet.size === 0) return false;
    if (this.lastTouchedAt > 0 && Date.now() - this.lastTouchedAt > this.idleTtlMs) {
      this.clearStorage();
      return true;
    }
    return false;
  }

  setIdleTtlMs(idleTtlMs: number): void {
    this.idleTtlMs = Math.max(1000, idleTtlMs);
    this.fallbackKeyStore.setIdleTtlMs(this.idleTtlMs);
    if (this.worker) {
      void this.sendWorkerRequest("SET_IDLE_TTL", { idleTtlMs: this.idleTtlMs }).catch(() => {});
    }
  }

  isUnlocked(): boolean {
    if (!this.hasWorkerSupport()) {
      return this.fallbackKeyStore.isUnlocked();
    }
    if (this.expireMirrorIfIdle()) return false;
    if (this.accountUnlocked) {
      this.lastTouchedAt = Date.now();
    }
    return this.accountUnlocked;
  }

  isProfileUnlocked(profileId: string): boolean {
    if (!this.hasWorkerSupport()) {
      return this.fallbackKeyStore.isProfileUnlocked(profileId);
    }
    if (this.expireMirrorIfIdle()) return false;
    const ok = this.accountUnlocked || this.profileUnlockedSet.has(profileId);
    if (ok) {
      this.lastTouchedAt = Date.now();
    }
    return ok;
  }

  isCurrentKeyCompatibleWithServer(serverPublicKeyJson?: string | null): boolean {
    if (!this.hasWorkerSupport()) {
      const current = this.fallbackKeyStore.getPrivateKey("account");
      return current ? this.fallbackKeyStore.isKeyCompatibleWithServer(current, serverPublicKeyJson) : false;
    }
    if (!this.isUnlocked()) return false;
    if (!serverPublicKeyJson) return true;
    try {
      const parsed = typeof serverPublicKeyJson === "string" ? JSON.parse(serverPublicKeyJson) : serverPublicKeyJson;
      const serverIsPqc = parsed.alg === "P256-MLKEM768" || Boolean(parsed.pqc_pk);
      return !(serverIsPqc && !this.cachedKeyIsPqc);
    } catch {
      return true;
    }
  }

  async validateStatus(status: ProfileE2eeStatus): Promise<void> {
    if (!this.hasWorkerSupport()) {
      const before = this.fallbackKeyStore.isUnlocked();
      this.fallbackKeyStore.validateCachedKeyAgainstStatus(status);
      if (before && !this.fallbackKeyStore.isUnlocked()) {
        this.fallbackDecryptEngine.clearDekCache();
      }
      return;
    }
    if (!this.worker || !this.isUnlocked()) return;
    const res = await this.sendWorkerRequest<{ unlocked: boolean; isPqc: boolean }>(
      "VALIDATE_STATUS",
      { status }
    );
    if (!res.unlocked) {
      this.resetMirror();
    } else {
      this.cachedKeyIsPqc = res.isPqc;
    }
  }

  async generateAndWrapWithKek(
    profileKey: string,
    kek: Uint8Array
  ): Promise<{ publicKeyPayload: { alg: "P256-MLKEM768"; pqc_pk: string }; encryptedSk: string; iv: string }> {
    if (!this.hasWorkerSupport()) {
      try {
        const { publicKeyPayload, privateKeyObj } = generatePqcKeyPairPayload();
        const wrapped = await wrapPrivateKeyWithKek(kek, privateKeyObj);
        this.fallbackKeyStore.setPrivateKey(profileKey, privateKeyObj);
        this.markUnlocked(profileKey, true);
        return { publicKeyPayload, ...wrapped };
      } finally {
        zeroizeBuffers(kek);
      }
    }

    const kekBuffer = toDetachedCopy(kek);
    const res = await this.sendWorkerRequest<{
      publicKeyPayload: { alg: "P256-MLKEM768"; pqc_pk: string };
      encryptedSk: string;
      iv: string;
      isPqc: boolean;
    }>("GENERATE_AND_WRAP_KEK", { profileKey, kekBuffer }, [kekBuffer]);

    this.markUnlocked(profileKey, res.isPqc);
    return {
      publicKeyPayload: res.publicKeyPayload,
      encryptedSk: res.encryptedSk,
      iv: res.iv,
    };
  }

  async generateAndWrapWithRecovery(
    plaintextRecoveryKey: string
  ): Promise<{ publicKeyPayload: { alg: "P256-MLKEM768"; pqc_pk: string }; recovery: WrappedRecoveryKey }> {
    if (!this.hasWorkerSupport()) {
      const { publicKeyPayload, privateKeyObj } = generatePqcKeyPairPayload();
      const recovery = await wrapPrivateKeyWithRecoveryKey(privateKeyObj, plaintextRecoveryKey);
      this.fallbackKeyStore.setPrivateKey("account", privateKeyObj);
      this.markUnlocked("account", true);
      return { publicKeyPayload, recovery };
    }

    const res = await this.sendWorkerRequest<{
      publicKeyPayload: { alg: "P256-MLKEM768"; pqc_pk: string };
      recovery: WrappedRecoveryKey;
      isPqc: boolean;
    }>("GENERATE_AND_WRAP_RECOVERY", { plaintextRecoveryKey });

    this.markUnlocked("account", res.isPqc);
    return {
      publicKeyPayload: res.publicKeyPayload,
      recovery: res.recovery,
    };
  }

  async rotateAndWrapWithKek(
    kek: Uint8Array
  ): Promise<{ publicKeyPayload: { alg: "P256-MLKEM768"; pqc_pk: string }; encryptedSk: string; iv: string }> {
    if (!this.hasWorkerSupport()) {
      try {
        const currentKey = this.fallbackKeyStore.getPrivateKey("account");
        let legacyKey: JsonWebKey | undefined;
        if (currentKey && "kty" in currentKey) {
          legacyKey = currentKey as JsonWebKey;
        } else if (currentKey && "legacyKey" in currentKey) {
          legacyKey = currentKey.legacyKey;
        }
        const { publicKeyPayload, privateKeyObj } = generatePqcKeyPairPayload(legacyKey);
        const wrapped = await wrapPrivateKeyWithKek(kek, privateKeyObj);
        this.fallbackKeyStore.setPrivateKey("account", privateKeyObj);
        this.markUnlocked("account", true);
        return { publicKeyPayload, ...wrapped };
      } finally {
        zeroizeBuffers(kek);
      }
    }

    const kekBuffer = toDetachedCopy(kek);
    const res = await this.sendWorkerRequest<{
      publicKeyPayload: { alg: "P256-MLKEM768"; pqc_pk: string };
      encryptedSk: string;
      iv: string;
      isPqc: boolean;
    }>("ROTATE_AND_WRAP_KEK", { kekBuffer }, [kekBuffer]);

    this.markUnlocked("account", res.isPqc);
    return {
      publicKeyPayload: res.publicKeyPayload,
      encryptedSk: res.encryptedSk,
      iv: res.iv,
    };
  }

  async unwrapWithKek(
    profileKey: string,
    kek: Uint8Array,
    altKek: Uint8Array | undefined,
    ciphertextBuf: Uint8Array,
    ivBuf: Uint8Array
  ): Promise<boolean> {
    if (!this.hasWorkerSupport()) {
      try {
        const privKey = await unwrapPrivateKeyWithKek(kek, altKek, ciphertextBuf, ivBuf);
        this.fallbackKeyStore.setPrivateKey(profileKey, privKey);
        this.markUnlocked(profileKey, "seedBase64" in privKey);
        return true;
      } finally {
        zeroizeBuffers(kek, altKek, ciphertextBuf, ivBuf);
      }
    }

    const kekBuffer = toDetachedCopy(kek);
    const altKekBuffer = altKek ? toDetachedCopy(altKek) : undefined;
    const ciphertextBuffer = toDetachedCopy(ciphertextBuf);
    const ivBuffer = toDetachedCopy(ivBuf);
    const transfers: Transferable[] = [kekBuffer, ciphertextBuffer, ivBuffer];
    if (altKekBuffer) transfers.push(altKekBuffer);

    const res = await this.sendWorkerRequest<{ unlocked: boolean; isPqc: boolean }>(
      "UNWRAP_WITH_KEK",
      { profileKey, kekBuffer, altKekBuffer, ciphertextBuffer, ivBuffer },
      transfers
    );
    if (res.unlocked) {
      this.markUnlocked(profileKey, res.isPqc);
    }
    return res.unlocked;
  }

  async unwrapWithRecoveryKey(
    encryptedSk: string,
    iv: string,
    salt: string,
    plaintextRecoveryKey: string
  ): Promise<boolean> {
    if (!this.hasWorkerSupport()) {
      const privKey = await unwrapPrivateKeyWithRecoveryKey(
        encryptedSk,
        iv,
        salt,
        plaintextRecoveryKey
      );
      this.fallbackKeyStore.setPrivateKey("account", privKey);
      this.markUnlocked("account", "seedBase64" in privKey);
      return true;
    }

    const res = await this.sendWorkerRequest<{ unlocked: boolean; isPqc: boolean }>(
      "UNWRAP_WITH_RECOVERY",
      { encryptedSk, iv, salt, plaintextRecoveryKey }
    );
    if (res.unlocked) {
      this.markUnlocked("account", res.isPqc);
    }
    return res.unlocked;
  }

  async wrapCurrentWithKek(kek: Uint8Array): Promise<{ encryptedSk: string; iv: string }> {
    if (!this.hasWorkerSupport()) {
      try {
        const sk = this.fallbackKeyStore.getPrivateKey("account");
        if (!sk) {
          throw new Error("E2EE is locked in this session. Please unlock E2EE first.");
        }
        return await wrapPrivateKeyWithKek(kek, sk);
      } finally {
        zeroizeBuffers(kek);
      }
    }

    const kekBuffer = toDetachedCopy(kek);
    return await this.sendWorkerRequest<{ encryptedSk: string; iv: string }>(
      "WRAP_CURRENT_WITH_KEK",
      { kekBuffer },
      [kekBuffer]
    );
  }

  async wrapCurrentWithRecoveryKey(plaintextRecoveryKey: string): Promise<WrappedRecoveryKey | null> {
    if (!this.hasWorkerSupport()) {
      const sk = this.fallbackKeyStore.getPrivateKey("account");
      if (!sk) return null;
      return await wrapPrivateKeyWithRecoveryKey(sk, plaintextRecoveryKey);
    }

    return await this.sendWorkerRequest<WrappedRecoveryKey | null>(
      "WRAP_CURRENT_WITH_RECOVERY",
      { plaintextRecoveryKey }
    );
  }

  async decryptLogEntry(profileId: string, log: LogEntry): Promise<LogEntry> {
    if (!this.hasWorkerSupport()) {
      return await this.fallbackDecryptEngine.decryptLogEntry(profileId, log);
    }
    if (!this.isProfileUnlocked(profileId)) {
      const version = log.encrypt_version ?? (log.encrypted_payload ? 1 : 0);
      if (version === 0 || !log.encrypted_payload) return log;
      return {
        ...log,
        domain: log.domain || "[Encrypted]",
        client_ip: log.client_ip || "[Encrypted]",
      };
    }

    const res = await this.sendWorkerRequest<{ log: LogEntry; unlocked: boolean }>(
      "DECRYPT_ENTRY",
      { profileId, log }
    );
    if (!res.unlocked) {
      this.resetMirror();
    } else {
      this.lastTouchedAt = Date.now();
    }
    return res.log;
  }

  async decryptLogsBatch(profileId: string, logs: LogEntry[]): Promise<LogEntry[]> {
    if (!logs || logs.length === 0) return logs;
    const hasEncrypted = logs.some((l) => (l.encrypt_version ?? (l.encrypted_payload ? 1 : 0)) > 0);
    if (!hasEncrypted) return logs;

    if (!this.hasWorkerSupport()) {
      return await this.fallbackDecryptEngine.decryptLogsBatch(profileId, logs);
    }

    if (!this.isProfileUnlocked(profileId)) {
      return logs.map((log) => {
        const version = log.encrypt_version ?? (log.encrypted_payload ? 1 : 0);
        if (version === 0 || !log.encrypted_payload) return log;
        return {
          ...log,
          domain: log.domain || "[Encrypted]",
          client_ip: log.client_ip || "[Encrypted]",
        };
      });
    }

    const res = await this.sendWorkerRequest<{ logs: LogEntry[]; unlocked: boolean }>(
      "DECRYPT_BATCH",
      { profileId, logs }
    );
    if (!res.unlocked) {
      this.resetMirror();
    } else {
      this.lastTouchedAt = Date.now();
    }
    return res.logs;
  }

  deleteProfileKey(profileId: string): void {
    this.profileUnlockedSet.delete(profileId);
    this.fallbackKeyStore.deleteProfileKey(profileId);
    if (this.worker) {
      void this.sendWorkerRequest("DELETE_PROFILE_KEY", { profileId }).catch(() => {});
    }
  }

  clearDekCache(): void {
    this.fallbackDecryptEngine.clearDekCache();
  }

  clearStorage(): void {
    this.resetMirror();
    this.fallbackKeyStore.clearStorage();
    this.fallbackDecryptEngine.clearDekCache();
    if (this.worker) {
      const activeWorker = this.worker;
      this.worker = null;
      for (const [, pending] of this.pendingRequests.entries()) {
        pending.reject(new Error("E2EE sandbox cleared"));
      }
      this.pendingRequests.clear();
      try {
        activeWorker.postMessage({ id: "clear", type: "CLEAR_STORAGE" });
        activeWorker.terminate();
      } catch {
        // Ignore termination failures
      }
    }
  }
}

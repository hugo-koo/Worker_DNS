/**
 * @file e2eeCrypto.worker.ts
 * @description Isolated Web Worker sandbox for E2EE private keys, P256-MLKEM768 keygen/decapsulation,
 * DEK caching, key wrapping/unwrapping, and DNS log decryption.
 * Keeps plaintext private key material out of the main UI thread's V8 heap.
 */

import type { LogEntry } from "../views/LogsView/types";
import type { ProfileE2eeStatus } from "../services/e2ee/types";
import { KeyStore } from "../services/e2ee/keyStore";
import { DecryptEngine } from "../services/e2ee/decryptEngine";
import {
  generatePqcKeyPairPayload,
  wrapPrivateKeyWithKek,
  unwrapPrivateKeyWithKek,
} from "../services/e2ee/keyOperations";
import {
  wrapPrivateKeyWithRecoveryKey,
  unwrapPrivateKeyWithRecoveryKey,
} from "../services/e2ee/recoveryKek";
import { zeroizeBuffer, zeroizeBuffers } from "../utils/memory";

type WorkerRequest =
  | { id: string; type: "SET_IDLE_TTL"; payload: { idleTtlMs: number } }
  | { id: string; type: "VALIDATE_STATUS"; payload: { status: ProfileE2eeStatus } }
  | { id: string; type: "GENERATE_AND_WRAP_KEK"; payload: { profileKey: string; kekBuffer: ArrayBuffer } }
  | { id: string; type: "GENERATE_AND_WRAP_RECOVERY"; payload: { plaintextRecoveryKey: string } }
  | { id: string; type: "ROTATE_AND_WRAP_KEK"; payload: { kekBuffer: ArrayBuffer } }
  | {
      id: string;
      type: "UNWRAP_WITH_KEK";
      payload: {
        profileKey: string;
        kekBuffer: ArrayBuffer;
        altKekBuffer?: ArrayBuffer;
        ciphertextBuffer: ArrayBuffer;
        ivBuffer: ArrayBuffer;
      };
    }
  | {
      id: string;
      type: "UNWRAP_WITH_RECOVERY";
      payload: { encryptedSk: string; iv: string; salt: string; plaintextRecoveryKey: string };
    }
  | { id: string; type: "WRAP_CURRENT_WITH_KEK"; payload: { kekBuffer: ArrayBuffer } }
  | { id: string; type: "WRAP_CURRENT_WITH_RECOVERY"; payload: { plaintextRecoveryKey: string } }
  | { id: string; type: "DECRYPT_ENTRY"; payload: { profileId: string; log: LogEntry } }
  | { id: string; type: "DECRYPT_BATCH"; payload: { profileId: string; logs: LogEntry[] } }
  | { id: string; type: "DELETE_PROFILE_KEY"; payload: { profileId: string } }
  | { id: string; type: "CLEAR_STORAGE" };

const keyStore = new KeyStore();
const decryptEngine = new DecryptEngine(keyStore);

function isActiveKeyPqc(): boolean {
  const current = keyStore.getPrivateKey("account");
  if (!current) return false;
  return "seedBase64" in current;
}

if (typeof self !== "undefined") {
  self.onmessage = async (event: MessageEvent<WorkerRequest>): Promise<void> => {
  const { id, type } = event.data;

  try {
    let data: unknown = null;

    switch (type) {
      case "SET_IDLE_TTL": {
        keyStore.setIdleTtlMs(event.data.payload.idleTtlMs);
        data = { ok: true };
        break;
      }

      case "VALIDATE_STATUS": {
        const before = keyStore.isUnlocked();
        keyStore.validateCachedKeyAgainstStatus(event.data.payload.status);
        const after = keyStore.isUnlocked();
        if (before && !after) {
          decryptEngine.clearDekCache();
        }
        data = { unlocked: after, isPqc: isActiveKeyPqc() };
        break;
      }

      case "GENERATE_AND_WRAP_KEK": {
        const { profileKey, kekBuffer } = event.data.payload;
        try {
          const { publicKeyPayload, privateKeyObj } = generatePqcKeyPairPayload();
          const wrapped = await wrapPrivateKeyWithKek(kekBuffer, privateKeyObj);
          keyStore.setPrivateKey(profileKey, privateKeyObj);
          data = { publicKeyPayload, ...wrapped, isPqc: true };
        } finally {
          zeroizeBuffer(kekBuffer);
        }
        break;
      }

      case "GENERATE_AND_WRAP_RECOVERY": {
        const { plaintextRecoveryKey } = event.data.payload;
        const { publicKeyPayload, privateKeyObj } = generatePqcKeyPairPayload();
        const recovery = await wrapPrivateKeyWithRecoveryKey(privateKeyObj, plaintextRecoveryKey);
        keyStore.setPrivateKey("account", privateKeyObj);
        data = { publicKeyPayload, recovery, isPqc: true };
        break;
      }

      case "ROTATE_AND_WRAP_KEK": {
        const { kekBuffer } = event.data.payload;
        try {
          const currentKey = keyStore.getPrivateKey("account");
          let legacyKey: JsonWebKey | undefined;
          if (currentKey && "kty" in currentKey) {
            legacyKey = currentKey as JsonWebKey;
          } else if (currentKey && "legacyKey" in currentKey) {
            legacyKey = currentKey.legacyKey;
          }
          const { publicKeyPayload, privateKeyObj } = generatePqcKeyPairPayload(legacyKey);
          const wrapped = await wrapPrivateKeyWithKek(kekBuffer, privateKeyObj);
          keyStore.setPrivateKey("account", privateKeyObj);
          data = { publicKeyPayload, ...wrapped, isPqc: true };
        } finally {
          zeroizeBuffer(kekBuffer);
        }
        break;
      }

      case "UNWRAP_WITH_KEK": {
        const { profileKey, kekBuffer, altKekBuffer, ciphertextBuffer, ivBuffer } = event.data.payload;
        try {
          const privKey = await unwrapPrivateKeyWithKek(
            kekBuffer,
            altKekBuffer,
            new Uint8Array(ciphertextBuffer),
            new Uint8Array(ivBuffer)
          );
          keyStore.setPrivateKey(profileKey, privKey);
          data = { unlocked: true, isPqc: "seedBase64" in privKey };
        } finally {
          zeroizeBuffers(kekBuffer, altKekBuffer, ciphertextBuffer, ivBuffer);
        }
        break;
      }

      case "UNWRAP_WITH_RECOVERY": {
        const { encryptedSk, iv, salt, plaintextRecoveryKey } = event.data.payload;
        const privKey = await unwrapPrivateKeyWithRecoveryKey(
          encryptedSk,
          iv,
          salt,
          plaintextRecoveryKey
        );
        keyStore.setPrivateKey("account", privKey);
        data = { unlocked: true, isPqc: "seedBase64" in privKey };
        break;
      }

      case "WRAP_CURRENT_WITH_KEK": {
        const { kekBuffer } = event.data.payload;
        try {
          const sk = keyStore.getPrivateKey("account");
          if (!sk) {
            throw new Error("E2EE is locked in this session. Please unlock E2EE first.");
          }
          data = await wrapPrivateKeyWithKek(kekBuffer, sk);
        } finally {
          zeroizeBuffer(kekBuffer);
        }
        break;
      }

      case "WRAP_CURRENT_WITH_RECOVERY": {
        const sk = keyStore.getPrivateKey("account");
        if (!sk) {
          data = null;
          break;
        }
        data = await wrapPrivateKeyWithRecoveryKey(
          sk,
          event.data.payload.plaintextRecoveryKey
        );
        break;
      }

      case "DECRYPT_ENTRY": {
        const decrypted = await decryptEngine.decryptLogEntry(
          event.data.payload.profileId,
          event.data.payload.log
        );
        data = {
          log: decrypted,
          unlocked: keyStore.isUnlocked(),
        };
        break;
      }

      case "DECRYPT_BATCH": {
        const decrypted = await decryptEngine.decryptLogsBatch(
          event.data.payload.profileId,
          event.data.payload.logs
        );
        data = {
          logs: decrypted,
          unlocked: keyStore.isUnlocked(),
        };
        break;
      }

      case "DELETE_PROFILE_KEY": {
        keyStore.deleteProfileKey(event.data.payload.profileId);
        data = { ok: true };
        break;
      }

      case "CLEAR_STORAGE": {
        keyStore.clearStorage();
        decryptEngine.clearDekCache();
        data = { ok: true };
        break;
      }

      default:
        throw new Error(`Unsupported E2EE worker action: ${String(type)}`);
    }

    self.postMessage({ id, success: true, data });
  } catch (err) {
    self.postMessage({
      id,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  };
}

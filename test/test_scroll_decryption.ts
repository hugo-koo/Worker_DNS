/**
 * @file test_scroll_decryption.ts
 * @description Tests for E2EE log scrolling decryption fixes:
 * 1. runCursorReDecrypt paginates newest-first beyond 1,000 rows without getting stuck on corrupted rows.
 * 2. decryptRowsOnRead decrypts any remaining encrypted rows on read and persists updates back to local SQLite.
 */

import assert from "node:assert/strict";
import { KeyStore } from "../web/src/services/e2ee/keyStore";
import { DecryptEngine } from "../web/src/services/e2ee/decryptEngine";
import {
  runCursorReDecrypt,
  decryptRowsOnRead,
  type LocalBridgeRequester,
  type LogE2eeProvider,
} from "../web/src/services/localDb/logDecryption";
import type { LogEntry } from "../web/src/views/LogsView/types";
import {
  generatePqcLogKeyPair,
  encapsulatePqcDek,
  deriveDekFromSharedSecret,
  encryptSensitiveLogDataWithDek,
} from "../src/lib/crypto/e2ee/pqc";
import { zeroizeBuffer } from "../src/utils/memory";

async function main(): Promise<void> {
  const profileId = "prof-scroll-test";
  const nowSec = Math.floor(Date.now() / 1000);
  const keyPair = generatePqcLogKeyPair();
  const pkBytes = new Uint8Array(Buffer.from(keyPair.publicKeyBase64, "base64"));
  const { kemCtBase64, sharedSecret } = encapsulatePqcDek(pkBytes);
  const serverDek = await deriveDekFromSharedSecret(sharedSecret);
  zeroizeBuffer(sharedSecret);

  const keyStore = new KeyStore();
  keyStore.setPrivateKey("account", {
    alg: "P256-MLKEM768",
    seedBase64: keyPair.secretKeyBase64,
  });
  const decryptEngine = new DecryptEngine(keyStore);
  const cryptoProvider: LogE2eeProvider = {
    isProfileUnlocked: (pid: string) => keyStore.isProfileUnlocked(pid),
    decryptLogsBatch: (pid: string, logs: LogEntry[]) => decryptEngine.decryptLogsBatch(pid, logs),
  };

  assert.equal(cryptoProvider.isProfileUnlocked(profileId), true);

  // Build 1,250 encrypted rows + 1 undecryptable row (to ensure cursor doesn't loop forever)
  const localRows: LogEntry[] = [];
  for (let i = 0; i < 1250; i++) {
    const encryptedPayload = await encryptSensitiveLogDataWithDek(serverDek, {
      domain: `site-${i}.example.com`,
      client_ip: "198.51.100.1",
      geo_country: "US",
      answer: "93.184.216.34",
    });
    localRows.push({
      id: i + 1,
      timestamp: nowSec + i,
      client_ip: "",
      geo_country: "",
      domain: "",
      record_type: "A",
      action: "PASS",
      encrypt_version: 2,
      kem_key_id: "kem_test_1",
      kem_ct: kemCtBase64,
      encrypted_payload: encryptedPayload,
    });
  }

  // Insert a poison row near the top that cannot be decrypted
  localRows.push({
    id: 999999,
    timestamp: nowSec + 1245,
    client_ip: "",
    geo_country: "",
    domain: "[Encrypted]",
    record_type: "A",
    action: "PASS",
    encrypt_version: 2,
    kem_key_id: "kem_missing",
    kem_ct: null,
    encrypted_payload: '{"iv":"AA==","ciphertext":"AA=="}',
  });

  // Sort DESC by (timestamp, id) matching SQLite query behavior
  localRows.sort((a, b) => (b.timestamp - a.timestamp) || (Number(b.id) - Number(a.id)));

  const mockBridge: LocalBridgeRequester = {
    async init() {
      return true;
    },
    async sendRequest<T = unknown>(type: string, payload?: unknown): Promise<T> {
      if (type === "GET_ENCRYPTED_LOGS") {
        const p = payload as {
          limit?: number;
          beforeTimestamp?: number;
          beforeId?: number;
        };
        const limit = p.limit || 500;
        const filtered = localRows.filter((r) => {
          if ((r.encrypt_version ?? 0) <= 0) return false;
          if (p.beforeTimestamp !== undefined && p.beforeId !== undefined) {
            return (
              r.timestamp < p.beforeTimestamp ||
              (r.timestamp === p.beforeTimestamp && Number(r.id) < p.beforeId)
            );
          }
          return true;
        });
        return { rows: filtered.slice(0, limit).map((r) => ({ ...r })) } as T;
      }

      if (type === "UPDATE_LOGS_BATCH") {
        const p = payload as { logs: LogEntry[] };
        let updated = 0;
        for (const u of p.logs) {
          const target = localRows.find((r) => r.timestamp === u.timestamp && r.id === u.id);
          if (target) {
            Object.assign(target, u, { encrypt_version: 0, encrypted_payload: null });
            updated++;
          }
        }
        return { updated } as T;
      }

      throw new Error(`Unexpected worker message: ${type}`);
    },
  };

  // 1. Verify runCursorReDecrypt decrypts all 1,250 valid rows (> 1,000) without stalling on poison row
  const updatedCount = await runCursorReDecrypt(mockBridge, cryptoProvider, profileId);
  assert.equal(updatedCount, 1250, "runCursorReDecrypt must decrypt all 1,250 rows across multiple batches");
  assert.equal(
    localRows.filter((r) => (r.encrypt_version ?? 0) === 0).length,
    1250
  );

  // 2. Inject an un-decrypted historical row deep in localRows and verify decryptRowsOnRead decrypts and persists it
  const deepRow = localRows[localRows.length - 1];
  deepRow.encrypt_version = 2;
  deepRow.domain = "";
  deepRow.client_ip = "";
  deepRow.encrypted_payload = await encryptSensitiveLogDataWithDek(serverDek, {
    domain: "deep-history.example.org",
    client_ip: "198.51.100.99",
    geo_country: "JP",
  });

  const pageRows = await decryptRowsOnRead(mockBridge, cryptoProvider, profileId, [
    { ...deepRow },
  ]);
  assert.equal(pageRows[0].domain, "deep-history.example.org", "decryptRowsOnRead must decrypt encrypted rows on read");
  assert.equal(pageRows[0].encrypt_version, 0);

  // Give fire-and-forget UPDATE_LOGS_BATCH microtask a moment to settle, verify persistence
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(deepRow.domain, "deep-history.example.org");
  assert.equal(deepRow.encrypt_version, 0);

  keyStore.clearStorage();
  decryptEngine.clearDekCache();
  console.log("[PASS] All scroll decryption tests passed!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

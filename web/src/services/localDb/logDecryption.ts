/**
 * @file logDecryption.ts
 * @description Runtime-agnostic E2EE log re-decryption and opportunistic on-read decryption helpers
 * for local SQLite storage.
 */

import type { LogEntry } from '../../views/LogsView/types';

export interface LogE2eeProvider {
  isProfileUnlocked(profileId: string): boolean;
  decryptLogsBatch(profileId: string, logs: LogEntry[]): Promise<LogEntry[]>;
}

export interface LocalBridgeRequester {
  init(): Promise<boolean>;
  sendRequest<T = unknown>(type: string, payload?: unknown): Promise<T>;
}

export const REDECRYPT_BATCH_SIZE = 500;
export const MAX_REDECRYPT_BATCHES = 100;

/**
 * Re-decrypts all pending encrypted local logs for a profile in newest-first order
 * using keyset cursor pagination (`beforeTimestamp`, `beforeId`).
 */
export async function runCursorReDecrypt(
  bridge: LocalBridgeRequester,
  cryptoProvider: LogE2eeProvider,
  profileId: string
): Promise<number> {
  if (!cryptoProvider.isProfileUnlocked(profileId)) return 0;

  await bridge.init();
  let totalUpdated = 0;
  let beforeTimestamp: number | undefined;
  let beforeId: number | undefined;

  for (let batchIdx = 0; batchIdx < MAX_REDECRYPT_BATCHES; batchIdx++) {
    const res = await bridge.sendRequest<{ rows: LogEntry[] }>('GET_ENCRYPTED_LOGS', {
      profileId,
      limit: REDECRYPT_BATCH_SIZE,
      ...(beforeTimestamp !== undefined && beforeId !== undefined
        ? { beforeTimestamp, beforeId }
        : {}),
    });

    if (!res.rows || res.rows.length === 0) {
      break;
    }

    const lastRow = res.rows[res.rows.length - 1];
    const nextTs = Number(lastRow.timestamp);
    const nextId = Number(lastRow.id);

    const decrypted = await cryptoProvider.decryptLogsBatch(profileId, res.rows);
    const successfullyDecrypted = decrypted.filter((l) => (l.encrypt_version ?? 0) === 0);

    if (successfullyDecrypted.length > 0) {
      const updateRes = await bridge.sendRequest<{ updated: number }>('UPDATE_LOGS_BATCH', {
        profileId,
        logs: successfullyDecrypted,
      });
      totalUpdated += updateRes.updated;
    }

    if (res.rows.length < REDECRYPT_BATCH_SIZE || isNaN(nextTs) || isNaN(nextId)) {
      break;
    }

    beforeTimestamp = nextTs;
    beforeId = nextId;
  }

  return totalUpdated;
}

/**
 * Opportunistically decrypts encrypted rows returned by a local query when E2EE is unlocked,
 * persisting successfully decrypted entries back to local SQLite in the background.
 */
export async function decryptRowsOnRead(
  bridge: LocalBridgeRequester,
  cryptoProvider: LogE2eeProvider,
  profileId: string,
  rows: LogEntry[]
): Promise<LogEntry[]> {
  if (!rows || rows.length === 0 || !cryptoProvider.isProfileUnlocked(profileId)) {
    return rows;
  }

  const pendingIndices = new Set<number>();
  rows.forEach((row, idx) => {
    if ((row.encrypt_version ?? (row.encrypted_payload ? 1 : 0)) > 0) {
      pendingIndices.add(idx);
    }
  });

  if (pendingIndices.size === 0) {
    return rows;
  }

  const decryptedRows = await cryptoProvider.decryptLogsBatch(profileId, rows);
  const newlyDecrypted = decryptedRows.filter(
    (row, idx) => pendingIndices.has(idx) && (row.encrypt_version ?? 0) === 0
  );

  if (newlyDecrypted.length > 0) {
    void bridge
      .sendRequest('UPDATE_LOGS_BATCH', {
        profileId,
        logs: newlyDecrypted,
      })
      .catch(() => {});
  }

  return decryptedRows;
}

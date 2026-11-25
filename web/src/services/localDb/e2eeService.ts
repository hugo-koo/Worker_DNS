/**
 * @file e2eeService.ts
 * @description Local E2EE orchestration service for batch re-decrypting local encrypted logs.
 */

import type { LocalDbWorkerBridge } from './workerBridge';
import { e2ee } from '../e2ee';
import { runCursorReDecrypt } from './logDecryption';

/**
 * Service managing client-side decryption of local logs stored in SQLite WASM.
 */
export class LocalDbE2eeService {
  private readonly bridge: LocalDbWorkerBridge;

  constructor(bridge: LocalDbWorkerBridge) {
    this.bridge = bridge;
  }

  /**
   * Re-decrypts all local logs that were previously stored encrypted, walking newest-first
   * via keyset cursor pagination so histories exceeding 1,000 entries are completely unlocked.
   * Called when the user unlocks their Passkey or Recovery key.
   *
   * @param profileId - Profile identifier.
   * @returns Number of successfully re-decrypted records.
   */
  async reDecryptLocalLogs(profileId: string): Promise<number> {
    return runCursorReDecrypt(this.bridge, e2ee, profileId);
  }
}

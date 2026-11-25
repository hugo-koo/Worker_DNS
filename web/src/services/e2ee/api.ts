/**
 * @file api.ts
 * @description High-level orchestrator and API facade for End-to-End Encryption (E2EE).
 * Delegates all private key generation, custody, wrapping, and unwrapping to E2eeCryptoSandbox.
 */

import type { ProfileE2eeStatus } from "./types";
import { fromBase64 } from "./crypto";
import { derivePasskeyKek } from "./passkeyKek";
import type { E2eeCryptoSandbox } from "./cryptoSandbox";
import { zeroizeBuffers } from "../../utils/memory";
import {
  fetchUserE2eeStatus,
  fetchProfileE2eeStatus,
  postEnableUserE2ee,
  postInitUserE2ee,
  postInitProfileE2ee,
  fetchWrappedKey,
  fetchRecoveryWrappedKey,
  postWrapKey,
  postWrapRecoveryKey,
  deleteUserE2ee,
  deleteProfileE2ee,
} from "./http";

export class E2eeApi {
  private sandbox: E2eeCryptoSandbox;

  constructor(sandbox: E2eeCryptoSandbox) {
    this.sandbox = sandbox;
  }

  /**
   * Retrieves account-level E2EE configuration and status.
   */
  async getUserStatus(): Promise<ProfileE2eeStatus> {
    const data = await fetchUserE2eeStatus();
    await this.sandbox.validateStatus(data);
    return data;
  }

  /**
   * Retrieves E2EE configuration and status for a specific profile.
   */
  async getStatus(profileId: string): Promise<ProfileE2eeStatus> {
    const data = await fetchProfileE2eeStatus(profileId);
    await this.sandbox.validateStatus(data);
    return data;
  }

  /**
   * Initializes and enables E2EE at the user/account level using P256-MLKEM768.
   */
  async enableUserE2ee(passkeyIdOverride?: string): Promise<boolean> {
    const status = await this.getUserStatus();
    if (status.hasKeys) {
      await postEnableUserE2ee();
      return true;
    }

    const { kek, altKek, passkeyId } = await derivePasskeyKek("account");
    const chosenPasskeyId = passkeyIdOverride || passkeyId || "primary";

    try {
      const { publicKeyPayload, encryptedSk, iv } =
        await this.sandbox.generateAndWrapWithKek("account", kek);

      await postInitUserE2ee({
        publicKey: publicKeyPayload,
        passkeyId: chosenPasskeyId,
        encryptedSk,
        iv,
      });
      return true;
    } finally {
      zeroizeBuffers(kek, altKek);
    }
  }

  /**
   * Generates a new P256-MLKEM768 keypair and wraps it with the user's Passkey,
   * upgrading from legacy ECDH P-256 or rotating the active post-quantum keypair.
   */
  async rotateUserE2eeKey(passkeyIdOverride?: string): Promise<boolean> {
    const { kek, altKek, passkeyId } = await derivePasskeyKek("account");
    const chosenPasskeyId = passkeyIdOverride || passkeyId || "primary";

    try {
      const { publicKeyPayload, encryptedSk, iv } =
        await this.sandbox.rotateAndWrapWithKek(kek);

      await postInitUserE2ee({
        publicKey: publicKeyPayload,
        passkeyId: chosenPasskeyId,
        encryptedSk,
        iv,
      });
      return true;
    } finally {
      zeroizeBuffers(kek, altKek);
    }
  }

  /**
   * Initializes and enables E2EE for a profile (legacy wrapper).
   */
  async enableE2ee(profileId: string, passkeyId: string): Promise<boolean> {
    const { kek, altKek } = await derivePasskeyKek(profileId);

    try {
      const { publicKeyPayload, encryptedSk, iv } =
        await this.sandbox.generateAndWrapWithKek(profileId, kek);

      await postInitProfileE2ee(profileId, {
        publicKey: publicKeyPayload,
        passkeyId,
        encryptedSk,
        iv,
      });
      return true;
    } finally {
      zeroizeBuffers(kek, altKek);
    }
  }

  /**
   * Unlocks the account's log private key using the device's Passkey with a single prompt.
   */
  async unlockUser(): Promise<boolean> {
    const status = await this.getUserStatus();
    if (!status.hasKeys && !status.enabled && status.wrappedPasskeys.length === 0) return false;

    if (
      this.sandbox.isUnlocked() &&
      this.sandbox.isCurrentKeyCompatibleWithServer(status.publicKey)
    ) {
      return true;
    }

    if (!status.wrappedPasskeys || status.wrappedPasskeys.length === 0) {
      throw new Error("No passkeys have been enrolled in E2EE yet. Please unlock with Recovery Key or reset the keypair.");
    }

    const { kek, altKek, passkeyId } = await derivePasskeyKek("account", {
      targetPasskeyIds: status.wrappedPasskeys,
    });
    const targetPasskeyId = passkeyId || status.wrappedPasskeys[0];

    let ciphertextBuf: Uint8Array | null = null;
    let ivBuf: Uint8Array | null = null;
    try {
      const { encryptedSk, iv } = await fetchWrappedKey(targetPasskeyId);
      ciphertextBuf = fromBase64(encryptedSk);
      ivBuf = fromBase64(iv);

      return await this.sandbox.unwrapWithKek("account", kek, altKek, ciphertextBuf, ivBuf);
    } finally {
      zeroizeBuffers(kek, altKek, ciphertextBuf, ivBuf);
    }
  }

  /**
   * Unlocks the profile's log private key using the device's Passkey.
   */
  async unlockProfile(profileId: string): Promise<boolean> {
    const status = await this.getStatus(profileId);
    if (!status.hasKeys && !status.enabled && status.wrappedPasskeys.length === 0) return false;

    if (
      this.sandbox.isProfileUnlocked(profileId) &&
      this.sandbox.isCurrentKeyCompatibleWithServer(status.publicKey)
    ) {
      return true;
    }

    const { kek, altKek, passkeyId } = await derivePasskeyKek(
      profileId,
      status.wrappedPasskeys?.length ? { targetPasskeyIds: status.wrappedPasskeys } : undefined
    );
    const targetPasskeyId = passkeyId || status.wrappedPasskeys[0];

    let ciphertextBuf: Uint8Array | null = null;
    let ivBuf: Uint8Array | null = null;
    try {
      const { encryptedSk, iv } = await fetchWrappedKey(targetPasskeyId, profileId);
      ciphertextBuf = fromBase64(encryptedSk);
      ivBuf = fromBase64(iv);

      return await this.sandbox.unwrapWithKek(profileId, kek, altKek, ciphertextBuf, ivBuf);
    } finally {
      zeroizeBuffers(kek, altKek, ciphertextBuf, ivBuf);
    }
  }

  /**
   * Initializes account-level E2EE using a fresh Recovery Key and P256-MLKEM768 key pair.
   */
  async initUserE2eeWithRecoveryKey(plaintextRecoveryKey: string): Promise<boolean> {
    const { publicKeyPayload, recovery } =
      await this.sandbox.generateAndWrapWithRecovery(plaintextRecoveryKey);

    await postInitUserE2ee({
      publicKey: publicKeyPayload,
      recovery,
    });

    return true;
  }

  /**
   * Unlocks the account's log private key using the plaintext 30-digit Recovery Key.
   */
  async unlockWithRecoveryKey(plaintextRecoveryKey: string): Promise<boolean> {
    const { encryptedSk, iv, salt } = await fetchRecoveryWrappedKey();

    try {
      return await this.sandbox.unwrapWithRecoveryKey(
        encryptedSk,
        iv,
        salt,
        plaintextRecoveryKey
      );
    } catch {
      throw new Error("Invalid Recovery Key or corrupted data");
    }
  }

  /**
   * Wraps the currently unlocked private key for a newly registered or selected Passkey.
   *
   * @param passkeyId - Specific passkey ID to wrap for (pins WebAuthn prompt to that passkey).
   * @param targetPasskeyIds - Optional list of candidate passkey IDs when enrolling one of multiple unenrolled keys.
   * @returns True if wrapping succeeded on the server.
   */
  async wrapCurrentKeyForPasskey(passkeyId?: string, targetPasskeyIds?: string[]): Promise<boolean> {
    if (!this.sandbox.isUnlocked()) {
      throw new Error("E2EE is locked in this session. Please unlock E2EE first.");
    }

    const targets = targetPasskeyIds?.length ? targetPasskeyIds : passkeyId ? [passkeyId] : undefined;
    const { kek, altKek, passkeyId: derivedPasskeyId } = await derivePasskeyKek(
      "account",
      targets ? { targetPasskeyIds: targets } : undefined
    );
    try {
      const resolvedPasskeyId = passkeyId || derivedPasskeyId;
      if (!resolvedPasskeyId) {
        throw new Error("Could not match the verified Passkey to an account credential.");
      }

      const { encryptedSk, iv } = await this.sandbox.wrapCurrentWithKek(kek);
      return await postWrapKey({ passkeyId: resolvedPasskeyId, encryptedSk, iv });
    } finally {
      zeroizeBuffers(kek, altKek);
    }
  }

  /**
   * Re-wraps the currently unlocked private key with a newly rotated Recovery Key.
   */
  async wrapCurrentKeyForRecovery(newRecoveryKey: string): Promise<boolean> {
    if (!this.sandbox.isUnlocked()) {
      console.warn("[E2EE API] Cannot wrap recovery: private key is not unlocked in this session");
      return false;
    }

    const recoveryWrapped = await this.sandbox.wrapCurrentWithRecoveryKey(newRecoveryKey);
    if (!recoveryWrapped) {
      return false;
    }
    return await postWrapRecoveryKey(recoveryWrapped);
  }

  /**
   * Disables E2EE across the entire user account.
   */
  async disableUserE2ee(): Promise<boolean> {
    await deleteUserE2ee();
    this.sandbox.clearStorage();
    return true;
  }

  /**
   * Disables E2EE for a profile.
   */
  async disableE2ee(profileId: string): Promise<boolean> {
    await deleteProfileE2ee(profileId);
    this.sandbox.deleteProfileKey(profileId);
    return true;
  }
}

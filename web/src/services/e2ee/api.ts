/**
 * @file api.ts
 * @description High-level orchestrator and API facade for End-to-End Encryption (E2EE).
 */

import type { ProfileE2eeStatus, UnlockedPrivateKey } from "./types";
import { fromBase64 } from "./crypto";
import { derivePasskeyKek } from "./passkeyKek";
import { wrapPrivateKeyWithRecoveryKey, unwrapPrivateKeyWithRecoveryKey } from "./recoveryKek";
import type { KeyStore } from "./keyStore";
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
  deleteProfileE2ee
} from "./http";
import {
  generatePqcKeyPairPayload,
  wrapPrivateKeyWithKek,
  unwrapPrivateKeyWithKek
} from "./keyOperations";

export class E2eeApi {
  private keyStore: KeyStore;

  constructor(keyStore: KeyStore) {
    this.keyStore = keyStore;
  }

  /**
   * Retrieves account-level E2EE configuration and status.
   */
  async getUserStatus(): Promise<ProfileE2eeStatus> {
    const data = await fetchUserE2eeStatus();
    this.keyStore.validateCachedKeyAgainstStatus(data);
    return data;
  }

  /**
   * Retrieves E2EE configuration and status for a specific profile.
   */
  async getStatus(profileId: string): Promise<ProfileE2eeStatus> {
    const data = await fetchProfileE2eeStatus(profileId);
    this.keyStore.validateCachedKeyAgainstStatus(data);
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

    const { kek, passkeyId } = await derivePasskeyKek("account");
    const chosenPasskeyId = passkeyIdOverride || passkeyId || "primary";

    // 1. Generate Post-Quantum P256-MLKEM768 KeyPair
    const { publicKeyPayload, privateKeyObj } = generatePqcKeyPairPayload();

    // 2. Wrap SK with Passkey KEK
    const { encryptedSk, iv } = await wrapPrivateKeyWithKek(kek, privateKeyObj);

    // 3. Upload to server
    await postInitUserE2ee({
      publicKey: publicKeyPayload,
      passkeyId: chosenPasskeyId,
      encryptedSk,
      iv
    });

    // Save in session for account
    this.keyStore.setPrivateKey("account", privateKeyObj);
    return true;
  }

  /**
   * Generates a new P256-MLKEM768 keypair and wraps it with the user's Passkey,
   * upgrading from legacy ECDH P-256 or rotating the active post-quantum keypair.
   */
  async rotateUserE2eeKey(passkeyIdOverride?: string): Promise<boolean> {
    const { kek, passkeyId } = await derivePasskeyKek("account");
    const chosenPasskeyId = passkeyIdOverride || passkeyId || "primary";

    // Preserve existing legacy key if present so historical Gen 1 logs remain decryptable
    const currentKey = this.keyStore.getPrivateKey("account");
    let legacyKey: JsonWebKey | undefined = undefined;
    if (currentKey && "kty" in currentKey) {
      legacyKey = currentKey as JsonWebKey;
    } else if (currentKey && "legacyKey" in currentKey) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      legacyKey = (currentKey as any).legacyKey;
    }

    // 1. Generate Post-Quantum P256-MLKEM768 KeyPair
    const { publicKeyPayload, privateKeyObj } = generatePqcKeyPairPayload(legacyKey);

    // 2. Wrap SK with Passkey KEK
    const { encryptedSk, iv } = await wrapPrivateKeyWithKek(kek, privateKeyObj);

    // 3. Upload to server
    await postInitUserE2ee({
      publicKey: publicKeyPayload,
      passkeyId: chosenPasskeyId,
      encryptedSk,
      iv
    });

    // Save in session for account
    this.keyStore.setPrivateKey("account", privateKeyObj);
    return true;
  }

  /**
   * Initializes and enables E2EE for a profile (legacy wrapper).
   */
  async enableE2ee(profileId: string, passkeyId: string): Promise<boolean> {
    const { kek } = await derivePasskeyKek(profileId);

    // 1. Generate Post-Quantum P256-MLKEM768 KeyPair
    const { publicKeyPayload, privateKeyObj } = generatePqcKeyPairPayload();

    // 2. Wrap SK with Passkey KEK
    const { encryptedSk, iv } = await wrapPrivateKeyWithKek(kek, privateKeyObj);

    // 3. Upload to server
    await postInitProfileE2ee(profileId, {
      publicKey: publicKeyPayload,
      passkeyId,
      encryptedSk,
      iv
    });

    // Save in session
    this.keyStore.setPrivateKey(profileId, privateKeyObj);
    this.keyStore.setPrivateKey("account", privateKeyObj);
    return true;
  }

  /**
   * Unlocks the account's log private key using the device's Passkey with a single prompt.
   */
  async unlockUser(): Promise<boolean> {
    const status = await this.getUserStatus();
    if (!status.hasKeys && !status.enabled && status.wrappedPasskeys.length === 0) return false;

    // Only skip if already unlocked with a key compatible with the server's active algorithm
    const cachedKey = this.keyStore.getPrivateKey("account");
    if (cachedKey && this.keyStore.isKeyCompatibleWithServer(cachedKey, status.publicKey)) {
      return true;
    }

    if (!status.wrappedPasskeys || status.wrappedPasskeys.length === 0) {
      throw new Error("No passkeys have been enrolled in E2EE yet. Please unlock with Recovery Key or reset the keypair.");
    }

    const { kek, altKek, passkeyId } = await derivePasskeyKek("account", {
      targetPasskeyIds: status.wrappedPasskeys
    });
    const targetPasskeyId = passkeyId || status.wrappedPasskeys[0];

    const { encryptedSk, iv } = await fetchWrappedKey(targetPasskeyId);
    const ciphertextBuf = fromBase64(encryptedSk);
    const ivBuf = fromBase64(iv);

    const privateKeyObj = await unwrapPrivateKeyWithKek(kek, altKek, ciphertextBuf, ivBuf);
    this.keyStore.setPrivateKey("account", privateKeyObj);
    return true;
  }

  /**
   * Unlocks the profile's log private key using the device's Passkey.
   */
  async unlockProfile(profileId: string): Promise<boolean> {
    const status = await this.getStatus(profileId);
    if (!status.hasKeys && !status.enabled && status.wrappedPasskeys.length === 0) return false;

    // Only skip if already unlocked with a key compatible with the server's active algorithm
    const cachedKey = this.keyStore.getPrivateKey(profileId);
    if (cachedKey && this.keyStore.isKeyCompatibleWithServer(cachedKey, status.publicKey)) {
      return true;
    }

    // Use dual-salt derivation (account + profileId), restricted to enrolled passkeys when known
    const { kek, altKek, passkeyId } = await derivePasskeyKek(
      profileId,
      status.wrappedPasskeys?.length ? { targetPasskeyIds: status.wrappedPasskeys } : undefined
    );
    const targetPasskeyId = passkeyId || status.wrappedPasskeys[0];

    const { encryptedSk, iv } = await fetchWrappedKey(targetPasskeyId, profileId);
    const ciphertextBuf = fromBase64(encryptedSk);
    const ivBuf = fromBase64(iv);

    const privateKeyObj = await unwrapPrivateKeyWithKek(kek, altKek, ciphertextBuf, ivBuf);
    this.keyStore.setPrivateKey(profileId, privateKeyObj);
    this.keyStore.setPrivateKey("account", privateKeyObj);
    return true;
  }

  /**
   * Initializes account-level E2EE using a fresh Recovery Key and P256-MLKEM768 key pair.
   */
  async initUserE2eeWithRecoveryKey(plaintextRecoveryKey: string): Promise<boolean> {
    // 1. Generate Post-Quantum P256-MLKEM768 KeyPair
    const { publicKeyPayload, privateKeyObj } = generatePqcKeyPairPayload();

    // 2. Wrap SK with Recovery Key KEK
    const recoveryWrapped = await wrapPrivateKeyWithRecoveryKey(privateKeyObj, plaintextRecoveryKey);

    // 3. Upload to server
    await postInitUserE2ee({
      publicKey: publicKeyPayload,
      recovery: recoveryWrapped
    });

    // 4. Save in session for account
    this.keyStore.setPrivateKey("account", privateKeyObj);
    return true;
  }

  /**
   * Unlocks the account's log private key using the plaintext 30-digit Recovery Key.
   */
  async unlockWithRecoveryKey(plaintextRecoveryKey: string): Promise<boolean> {
    const { encryptedSk, iv, salt } = await fetchRecoveryWrappedKey();

    let privateKeyObj: UnlockedPrivateKey;
    try {
      privateKeyObj = await unwrapPrivateKeyWithRecoveryKey(
        encryptedSk,
        iv,
        salt,
        plaintextRecoveryKey
      );
    } catch {
      throw new Error("Invalid Recovery Key or corrupted data");
    }

    this.keyStore.setPrivateKey("account", privateKeyObj);
    return true;
  }

  /**
   * Wraps the currently unlocked private key for a newly registered or selected Passkey.
   *
   * @param passkeyId - Specific passkey ID to wrap for (pins WebAuthn prompt to that passkey).
   * @param targetPasskeyIds - Optional list of candidate passkey IDs when enrolling one of multiple unenrolled keys.
   * @returns True if wrapping succeeded on the server.
   */
  async wrapCurrentKeyForPasskey(passkeyId?: string, targetPasskeyIds?: string[]): Promise<boolean> {
    const sk = this.keyStore.getPrivateKey("account");
    if (!sk) {
      throw new Error("E2EE is locked in this session. Please unlock E2EE first.");
    }

    const targets = targetPasskeyIds?.length ? targetPasskeyIds : passkeyId ? [passkeyId] : undefined;
    const { kek, passkeyId: derivedPasskeyId } = await derivePasskeyKek(
      "account",
      targets ? { targetPasskeyIds: targets } : undefined
    );
    const resolvedPasskeyId = passkeyId || derivedPasskeyId;
    if (!resolvedPasskeyId) {
      throw new Error("Could not match the verified Passkey to an account credential.");
    }

    const { encryptedSk, iv } = await wrapPrivateKeyWithKek(kek, sk);
    return await postWrapKey({ passkeyId: resolvedPasskeyId, encryptedSk, iv });
  }

  /**
   * Re-wraps the currently unlocked private key with a newly rotated Recovery Key.
   */
  async wrapCurrentKeyForRecovery(newRecoveryKey: string): Promise<boolean> {
    const sk = this.keyStore.getPrivateKey("account");
    if (!sk) {
      console.warn("[E2EE API] Cannot wrap recovery: private key is not unlocked in this session");
      return false;
    }

    const recoveryWrapped = await wrapPrivateKeyWithRecoveryKey(sk, newRecoveryKey);
    return await postWrapRecoveryKey(recoveryWrapped);
  }

  /**
   * Disables E2EE across the entire user account.
   */
  async disableUserE2ee(): Promise<boolean> {
    await deleteUserE2ee();
    this.keyStore.clearStorage();
    return true;
  }

  /**
   * Disables E2EE for a profile.
   */
  async disableE2ee(profileId: string): Promise<boolean> {
    await deleteProfileE2ee(profileId);
    this.keyStore.deleteProfileKey(profileId);
    return true;
  }
}

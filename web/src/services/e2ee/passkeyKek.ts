/**
 * @file passkeyKek.ts
 * @description WebAuthn PRF extension Key Encryption Key (KEK) derivation logic.
 */

import { getPasskeyAuthOptions, getPasskeys } from "../account";
import { bufferToBase64Url } from "../../utils/webauthn";
import { base64UrlToUint8Array } from "./crypto";
import { zeroizeBuffer } from "../../utils/memory";

export interface DerivedPasskeyKek {
  kek: Uint8Array;
  altKek?: Uint8Array;
  passkeyId?: string;
}

export interface DerivePasskeyKekOptions {
  /** Restrict WebAuthn prompt to specific passkey IDs (database ID or credential ID). */
  targetPasskeyIds?: string[];
}

/**
 * Derives a 256-bit Key Encryption Key (KEK) using WebAuthn Passkey assertion.
 * Leverages WebAuthn PRF extension with dual salt evaluation (account + profileId)
 * to guarantee seamless decryption regardless of key wrap scope.
 */
export async function derivePasskeyKek(
  saltScope: string = "account",
  options?: DerivePasskeyKekOptions
): Promise<DerivedPasskeyKek> {
  const authOptions = await getPasskeyAuthOptions();
  const normalizeB64 = (s: string) => (s || "").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let allowCredentials: any[] = authOptions.allowCredentials || [];
  if (options?.targetPasskeyIds && options.targetPasskeyIds.length > 0) {
    const targetSet = new Set(options.targetPasskeyIds);
    const targetNormSet = new Set(options.targetPasskeyIds.map(normalizeB64));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let filtered = allowCredentials.filter((c: any) => {
      const cId = c?.id ? normalizeB64(String(c.id)) : "";
      return (c?.passkey_id && targetSet.has(c.passkey_id)) || targetSet.has(c?.id) || targetNormSet.has(cId);
    });

    if (filtered.length === 0) {
      const passkeys = await getPasskeys();
      const matchedPasskeys = passkeys.filter(
        (p) => targetSet.has(p.id) || targetSet.has(p.credential_id) || targetNormSet.has(normalizeB64(p.credential_id))
      );
      if (matchedPasskeys.length > 0) {
        const matchedCredIds = new Set(matchedPasskeys.map((p) => normalizeB64(p.credential_id)));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        filtered = allowCredentials.filter((c: any) => matchedCredIds.has(normalizeB64(String(c?.id || ""))));
        if (filtered.length === 0) {
          filtered = matchedPasskeys.map((p) => ({
            id: p.credential_id,
            type: "public-key",
            passkey_id: p.id,
          }));
        }
      }
    }

    if (filtered.length > 0) {
      allowCredentials = filtered;
    }
  }

  // Primary salt is always "account"
  const saltAccount = new Uint8Array(32);
  const encAccount = new TextEncoder().encode("obex-dns-log-e2ee-salt:account");
  saltAccount.set(encAccount.subarray(0, 32));

  // Secondary salt if saltScope is provided and distinct from "account"
  let saltProfile: Uint8Array | undefined;
  if (saltScope && saltScope !== "account") {
    saltProfile = new Uint8Array(32);
    const encProfile = new TextEncoder().encode(`obex-dns-log-e2ee-salt:${saltScope}`);
    saltProfile.set(encProfile.subarray(0, 32));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prfEval: any = {
    first: saltAccount,
  };
  if (saltProfile) {
    prfEval.second = saltProfile;
  }

  const challengeBytes = base64UrlToUint8Array(authOptions.challenge);

  let credential: PublicKeyCredential;
  try {
    credential = (await navigator.credentials.get({
      publicKey: {
        challenge: challengeBytes as BufferSource,
        timeout: 60000,
        userVerification: "preferred",
        rpId: authOptions.rpId || window.location.hostname,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        allowCredentials: allowCredentials.map((c: any) => ({
          ...c,
          id: base64UrlToUint8Array(c.id) as BufferSource,
        })),
        extensions: {
          prf: {
            eval: prfEval,
          },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      },
    })) as PublicKeyCredential;
  } finally {
    zeroizeBuffer(challengeBytes);
  }

  if (!credential) {
    throw new Error("Passkey assertion was cancelled or failed");
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const extResults = credential.getClientExtensionResults() as any;
  let kekBytes: Uint8Array;
  let altKekBytes: Uint8Array | undefined;

  if (extResults?.prf?.results?.first) {
    kekBytes = new Uint8Array(extResults.prf.results.first);
    if (extResults?.prf?.results?.second) {
      altKekBytes = new Uint8Array(extResults.prf.results.second);
    }
  } else {
    throw new Error(
      "Passkey authenticator does not support WebAuthn PRF extension. Please unlock using your Recovery Key."
    );
  }

  // Match credential ID to registered passkey if possible
  let passkeyId = credential.id;
  const rawIdB64Url = credential.rawId ? bufferToBase64Url(credential.rawId) : "";
  const credIdNorm = normalizeB64(credential.id);
  const rawIdNorm = normalizeB64(rawIdB64Url);

  if (allowCredentials.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const match = allowCredentials.find((c: any) => {
      const cNorm = normalizeB64(c.id);
      return cNorm === credIdNorm || cNorm === rawIdNorm || c.passkey_id === credential.id;
    });
    if (match?.passkey_id) passkeyId = match.passkey_id;
  }

  if (!passkeyId || passkeyId === credential.id) {
    try {
      const passkeys = await getPasskeys();
      const match = passkeys.find((p) => {
        const pNorm = normalizeB64(p.credential_id);
        return pNorm === credIdNorm || pNorm === rawIdNorm || p.id === credential.id;
      });
      if (match?.id) {
        passkeyId = match.id;
      } else if (!options?.targetPasskeyIds?.length && passkeys.length > 0) {
        passkeyId = passkeys[0].id;
      }
    } catch (err) {
      console.warn("[E2EE] Could not load passkeys to match credential:", err);
    }
  }

  return { kek: kekBytes, altKek: altKekBytes, passkeyId };
}

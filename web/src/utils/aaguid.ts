export type AuthenticatorKind = "synced" | "platform" | "hardware" | "unknown";

export interface AuthenticatorMetadata {
  provider: string;
  kind: AuthenticatorKind;
}

const ZERO_AAGUID = "00000000-0000-0000-0000-000000000000";

const KNOWN_AAGUIDS: Record<string, AuthenticatorMetadata> = {
  "fbfc3007-154e-4ecc-8c0b-6e020557d7bd": { provider: "iCloud Keychain", kind: "synced" },
  "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4": { provider: "Google Password Manager", kind: "synced" },
  "08987058-cadc-4b81-b6e1-30de50dcbe96": { provider: "Windows Hello", kind: "platform" },
  "9ddd1817-af5a-4672-a2b9-3e3dd95000a9": { provider: "Windows Hello", kind: "platform" },
  "6028b017-b1d4-4c02-b4b3-afcdafc96bb2": { provider: "Windows Hello", kind: "platform" },
  "adce0002-35bc-c60a-648b-0b25f1f05503": { provider: "Chrome / Touch ID", kind: "platform" },
  "2fc0579f-8113-47ea-b116-bb5a8db9202a": { provider: "YubiKey", kind: "hardware" },
  "cb69481e-8ff7-4039-93ec-0a2729a154a8": { provider: "YubiKey", kind: "hardware" },
  "fa2b99dc-9e39-4257-8f92-4a30d23c4118": { provider: "YubiKey", kind: "hardware" },
  "ee882879-721c-4913-9775-3dfcce97072a": { provider: "YubiKey", kind: "hardware" },
  "bada5566-a7aa-401f-bd96-45619a55120d": { provider: "1Password", kind: "synced" },
  "d548826e-79b4-db40-a3d8-11116f7e8349": { provider: "1Password", kind: "synced" },
  "531126d6-e717-415c-9320-3d9aa6981239": { provider: "Dashlane", kind: "synced" },
  "dd4ec289-e01d-41c9-bb89-70fa845d4bf2": { provider: "Bitwarden", kind: "synced" },
};

/**
 * Resolves a WebAuthn FIDO2 AAGUID UUID into human-friendly authenticator metadata.
 *
 * @param aaguid - Raw AAGUID string from passkey attestation metadata
 * @returns Provider name and authenticator kind if known, otherwise `null`
 */
export function resolveAuthenticatorInfo(aaguid?: string | null): AuthenticatorMetadata | null {
  if (!aaguid) return null;
  const normalized = aaguid.trim().toLowerCase();
  if (!normalized || normalized === ZERO_AAGUID) return null;
  return KNOWN_AAGUIDS[normalized] ?? null;
}

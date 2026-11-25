import { zeroizeBuffer, zeroizeBuffers } from "./memory";

/**
 * Resolves the highest configured KEK version (e.g. "v1", "v2", "v101") from environment variables.
 * Scans all environment keys matching KEK_v<N> or KEK_V<N> dynamically without hardcoded version caps.
 * Returns null if no KEK is configured, disabling envelope encryption.
 *
 * @param env - Cloudflare Workers environment bindings or Node.js process.env object
 * @returns Active KEK version string (e.g. "v1") or null if no KEK configured
 */
export function getActiveKekVersion(env: any): string | null {
  if (!env || typeof env !== "object") return null;
  let maxVer = 0;
  for (const key of Object.keys(env)) {
    const match = key.match(/^KEK_[vV](\d+)$/);
    if (match) {
      const val = env[key];
      if (val !== undefined && val !== null && val !== "") {
        const ver = parseInt(match[1], 10);
        if (!isNaN(ver) && ver > maxVer) {
          maxVer = ver;
        }
      }
    }
  }
  if (maxVer > 0) return `v${maxVer}`;
  return null;
}

/**
 * Retrieves the raw KEK secret string for a given version.
 * Note: If version is "v0" or "default" and no explicit KEK_v0 is set, falls back to env.JWT_SECRET
 * for backward compatibility with legacy deployments that encrypted credentials using JWT_SECRET.
 *
 * @param version - KEK version string (e.g. "v1", "v0")
 * @param env - Cloudflare Workers environment bindings or Node.js process.env object
 * @returns Raw KEK secret string or null if not found
 */
export function getKekSecret(version: string, env: any): string | null {
  if (!env) return null;
  const val = env[`KEK_${version}`] || env[`KEK_${version.toUpperCase()}`];
  if (val && typeof val === "string" && val.trim() !== "") {
    return val;
  }
  // Backward compatibility: fallback to JWT_SECRET for legacy v0/default data
  if ((version === "v0" || version === "default") && env.JWT_SECRET && typeof env.JWT_SECRET === "string" && env.JWT_SECRET.trim() !== "") {
    return env.JWT_SECRET;
  }
  return null;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function fromBase64(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function importKekLegacySha256(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const secretData = encoder.encode(secret.trim());
  let hashBuffer: ArrayBuffer | null = null;
  try {
    hashBuffer = await crypto.subtle.digest("SHA-256", secretData);
    return await crypto.subtle.importKey(
      "raw",
      hashBuffer,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"]
    );
  } finally {
    zeroizeBuffers(secretData, hashBuffer);
  }
}

async function importKekHkdf(secret: string, version: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const ikmBytes = encoder.encode(secret.trim());
  try {
    const ikm = await crypto.subtle.importKey(
      "raw",
      ikmBytes,
      { name: "HKDF" },
      false,
      ["deriveKey"]
    );
    return await crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: encoder.encode("obex-envelope-kek-salt-v1"),
        info: encoder.encode(`obex-envelope-kek:${version}`),
      },
      ikm,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  } finally {
    zeroizeBuffer(ikmBytes);
  }
}

async function importKekForRecord(secret: string, version: string, kdf?: string): Promise<CryptoKey> {
  if (kdf === "hkdf-v1") {
    return importKekHkdf(secret, version);
  }
  return importKekLegacySha256(secret);
}

async function importDek(dekBytes: Uint8Array): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    dekBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

export interface EnvelopeEncryptedData {
  ciphertext: string;
  iv: string;
}

export interface EnvelopeEncryptedDek {
  ciphertext: string;
  iv: string;
  kek_version: string;
  kdf?: "hkdf-v1";
  aad_bound?: boolean;
}

/**
 * Encrypts a plaintext string using Envelope Encryption.
 * @returns Encrypted data and encrypted DEK strings (JSON serialized)
 */
export async function encryptEnvelope(
  plainText: string,
  env: any,
  aad?: string
): Promise<{ dataEncrypted: string; dekEncrypted: string } | null> {
  const activeVersion = getActiveKekVersion(env);
  if (!activeVersion) {
    // If no KEK is present in env, skip encryption
    return null;
  }

  const kekSecret = getKekSecret(activeVersion, env);
  if (!kekSecret || typeof kekSecret !== "string" || kekSecret.trim() === "") {
    throw new Error(`KEK version ${activeVersion} is missing or invalid in environment variables`);
  }

  const kekKey = await importKekHkdf(kekSecret, activeVersion);
  const encoder = new TextEncoder();
  const additionalData = aad ? encoder.encode(aad) : undefined;

  // 1. Generate plain Data Encryption Key (DEK) - 256 bits (32 bytes)
  const dekBytes = new Uint8Array(32);
  crypto.getRandomValues(dekBytes);
  const dataIv = new Uint8Array(12);
  crypto.getRandomValues(dataIv);
  const dataBuffer = encoder.encode(plainText);
  const dekIv = new Uint8Array(12);
  crypto.getRandomValues(dekIv);

  try {
    const dekKey = await importDek(dekBytes);

    // 2. Encrypt plaintext data using the DEK via AES-256-GCM
    const encryptedDataBuffer = await crypto.subtle.encrypt(
      additionalData ? { name: "AES-GCM", iv: dataIv, additionalData } : { name: "AES-GCM", iv: dataIv },
      dekKey,
      dataBuffer
    );

    const dataEncrypted: EnvelopeEncryptedData = {
      ciphertext: toBase64(new Uint8Array(encryptedDataBuffer)),
      iv: toBase64(dataIv)
    };

    // 3. Encrypt the DEK using the KEK via AES-256-GCM
    const encryptedDekBuffer = await crypto.subtle.encrypt(
      additionalData ? { name: "AES-GCM", iv: dekIv, additionalData } : { name: "AES-GCM", iv: dekIv },
      kekKey,
      dekBytes
    );

    const dekEncrypted: EnvelopeEncryptedDek = {
      ciphertext: toBase64(new Uint8Array(encryptedDekBuffer)),
      iv: toBase64(dekIv),
      kek_version: activeVersion,
      kdf: "hkdf-v1",
      ...(aad ? { aad_bound: true } : {})
    };

    return {
      dataEncrypted: JSON.stringify(dataEncrypted),
      dekEncrypted: JSON.stringify(dekEncrypted)
    };
  } finally {
    zeroizeBuffers(dekBytes, dataBuffer);
  }
}

/**
 * Decrypts envelope encrypted data using the stored DEK and KEK.
 */
export async function decryptEnvelope(
  dataEncryptedStr: string,
  dekEncryptedStr: string,
  env: any,
  aad?: string
): Promise<string> {
  let dataEncrypted: EnvelopeEncryptedData;
  let dekEncrypted: EnvelopeEncryptedDek;
  try {
    dataEncrypted = JSON.parse(dataEncryptedStr);
    dekEncrypted = JSON.parse(dekEncryptedStr);
  } catch (parseErr) {
    throw new Error(`Failed to parse envelope payload: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
  }

  if (dekEncrypted.aad_bound && !aad) {
    throw new Error("Missing required AAD context for bound envelope payload");
  }
  const additionalData = dekEncrypted.aad_bound && aad ? new TextEncoder().encode(aad) : undefined;

  const kekSecret = getKekSecret(dekEncrypted.kek_version, env);
  if (!kekSecret || typeof kekSecret !== "string" || kekSecret.trim() === "") {
    throw new Error(`Required KEK version ${dekEncrypted.kek_version} is missing or invalid in environment variables`);
  }

  const kekKey = await importKekForRecord(kekSecret, dekEncrypted.kek_version, dekEncrypted.kdf);

  // 1. Decrypt the DEK using the KEK
  const encryptedDekBytes = fromBase64(dekEncrypted.ciphertext);
  const dekIv = fromBase64(dekEncrypted.iv);
  const decryptedDekBuffer = await crypto.subtle.decrypt(
    additionalData ? { name: "AES-GCM", iv: dekIv, additionalData } : { name: "AES-GCM", iv: dekIv },
    kekKey,
    encryptedDekBytes
  );

  const dekBytes = new Uint8Array(decryptedDekBuffer);
  let decryptedDataBuffer: ArrayBuffer | null = null;
  try {
    const dekKey = await importDek(dekBytes);

    // 2. Decrypt the data using the decrypted DEK
    const encryptedDataBytes = fromBase64(dataEncrypted.ciphertext);
    const dataIv = fromBase64(dataEncrypted.iv);
    decryptedDataBuffer = await crypto.subtle.decrypt(
      additionalData ? { name: "AES-GCM", iv: dataIv, additionalData } : { name: "AES-GCM", iv: dataIv },
      dekKey,
      encryptedDataBytes
    );

    const decoder = new TextDecoder();
    return decoder.decode(decryptedDataBuffer);
  } finally {
    zeroizeBuffers(dekBytes, decryptedDekBuffer, decryptedDataBuffer);
  }
}

/**
 * Performs on-the-fly key rotation of the DEK to the highest active KEK version
 * (or upgrades legacy SHA-256 KEK wrapping to HKDF-v1).
 * @returns The new encrypted DEK string (JSON serialized), or null if no rotation occurred.
 */
export async function rotateEnvelopeDek(
  dekEncryptedStr: string,
  env: any,
  aad?: string
): Promise<string | null> {
  if (!env) return null;

  let dekEncrypted: EnvelopeEncryptedDek;
  try {
    dekEncrypted = JSON.parse(dekEncryptedStr);
  } catch {
    return null;
  }

  const activeKekVersion = getActiveKekVersion(env);
  if (!activeKekVersion) {
    return null;
  }

  const currentKekVersion = dekEncrypted.kek_version;
  if (currentKekVersion === activeKekVersion && dekEncrypted.kdf === "hkdf-v1") {
    return null;
  }

  if (dekEncrypted.aad_bound && !aad) {
    return null;
  }
  const additionalData = dekEncrypted.aad_bound && aad ? new TextEncoder().encode(aad) : undefined;

  const nextKekSecret = getKekSecret(activeKekVersion, env);
  if (!nextKekSecret || typeof nextKekSecret !== "string" || nextKekSecret.trim() === "") {
    return null;
  }

  // 1. Decrypt the DEK with current KEK
  const currentKekSecret = getKekSecret(currentKekVersion, env);
  if (!currentKekSecret || typeof currentKekSecret !== "string" || currentKekSecret.trim() === "") {
    throw new Error(`Current KEK version ${currentKekVersion} required for rotation is missing or invalid in environment`);
  }

  const currentKekKey = await importKekForRecord(currentKekSecret, currentKekVersion, dekEncrypted.kdf);
  const encryptedDekBytes = fromBase64(dekEncrypted.ciphertext);
  const dekIv = fromBase64(dekEncrypted.iv);
  const decryptedDekBuffer = await crypto.subtle.decrypt(
    additionalData ? { name: "AES-GCM", iv: dekIv, additionalData } : { name: "AES-GCM", iv: dekIv },
    currentKekKey,
    encryptedDekBytes
  );

  const dekBytes = new Uint8Array(decryptedDekBuffer);
  try {
    // 2. Encrypt the DEK with the active KEK using HKDF-v1
    const nextKekKey = await importKekHkdf(nextKekSecret, activeKekVersion);
    const newDekIv = new Uint8Array(12);
    crypto.getRandomValues(newDekIv);
    const newEncryptedDekBuffer = await crypto.subtle.encrypt(
      additionalData ? { name: "AES-GCM", iv: newDekIv, additionalData } : { name: "AES-GCM", iv: newDekIv },
      nextKekKey,
      dekBytes
    );

    const updatedDekEncrypted: EnvelopeEncryptedDek = {
      ciphertext: toBase64(new Uint8Array(newEncryptedDekBuffer)),
      iv: toBase64(newDekIv),
      kek_version: activeKekVersion,
      kdf: "hkdf-v1",
      ...(dekEncrypted.aad_bound ? { aad_bound: true } : {})
    };

    return JSON.stringify(updatedDekEncrypted);
  } finally {
    zeroizeBuffers(dekBytes, decryptedDekBuffer);
  }
}

/**
 * @file e2ee.ts
 * @description Zero-Knowledge End-to-End Encryption (E2EE) cryptographic primitives.
 * Re-exports types, base64, recovery, classic ECDH, and post-quantum PQC hybrid encryption modules.
 */

export * from './e2ee/types';
export * from './e2ee/base64';
export * from './e2ee/recovery';
export * from './e2ee/classic';
export * from './e2ee/pqc';

import { fromBase64 } from './e2ee/base64';

/**
 * Validates that a client-supplied E2EE public key is either a valid 1249-byte
 * P256-MLKEM768 hybrid public key or a valid ECDH P-256 JWK.
 * Prevents malformed keys from causing runtime encryption failures that could degrade E2EE.
 */
export function isValidE2eePublicKey(rawPublicKey: unknown): boolean {
  let parsed: unknown = rawPublicKey;
  if (typeof rawPublicKey === 'string') {
    try {
      parsed = JSON.parse(rawPublicKey);
    } catch {
      return false;
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    return false;
  }

  const obj = parsed as Record<string, unknown>;
  if ('pqc_pk' in obj) {
    if (obj.alg !== 'P256-MLKEM768' || typeof obj.pqc_pk !== 'string') {
      return false;
    }
    try {
      const bytes = fromBase64(obj.pqc_pk);
      return bytes.byteLength === 1249;
    } catch {
      return false;
    }
  }

  if (obj.kty === 'EC') {
    return (
      obj.crv === 'P-256' &&
      typeof obj.x === 'string' &&
      obj.x.length >= 40 &&
      typeof obj.y === 'string' &&
      obj.y.length >= 40
    );
  }

  return false;
}

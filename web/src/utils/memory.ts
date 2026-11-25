/**
 * @file memory.ts
 * @description Client-side utilities for explicit memory scrubbing (zeroization) of sensitive
 * cryptographic buffers, passwords, KEKs, and decrypted plaintext views.
 */

/**
 * Overwrites a Uint8Array or ArrayBuffer in place with zeroes.
 * Safely ignores null, undefined, or detached buffers.
 *
 * @param buffer - Typed array or ArrayBuffer containing sensitive material.
 */
export function zeroizeBuffer(
  buffer: Uint8Array | ArrayBuffer | null | undefined
): void {
  if (!buffer) return;
  try {
    if (buffer instanceof Uint8Array) {
      buffer.fill(0);
    } else if (buffer instanceof ArrayBuffer && buffer.byteLength > 0) {
      new Uint8Array(buffer).fill(0);
    }
  } catch {
    // Ignore detached ArrayBuffer errors
  }
}

/**
 * Overwrites multiple sensitive buffers in place with zeroes.
 *
 * @param buffers - Sequence of Uint8Array or ArrayBuffer instances to scrub.
 */
export function zeroizeBuffers(
  ...buffers: Array<Uint8Array | ArrayBuffer | null | undefined>
): void {
  for (const buf of buffers) {
    zeroizeBuffer(buf);
  }
}

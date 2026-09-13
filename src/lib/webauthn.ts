/**
 * Zero-dependency WebAuthn / Passkey authentication and attestation engine for Cloudflare Workers.
 * Complies with W3C WebAuthn Level 3 and FIDO2 specifications using native Web Crypto API.
 *
 * Re-exports the modular webauthn subsystem from ./webauthn for backward compatibility.
 */
export * from "./webauthn/index";

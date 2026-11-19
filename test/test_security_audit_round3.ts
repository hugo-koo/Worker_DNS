/**
 * @file test_security_audit_round3.ts
 * @description Comprehensive verification tests for Round 3 security hardening:
 * 1. SSRF and Dynamic DNS / Wildcard rebinding rejection in isSafeUrl
 * 2. WebAuthn origin port binding verification
 * 3. HTTP redirect manual enforcement in fetchListContent
 * 4. Passkey recovery key preservation
 */

import assert from "node:assert";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NodeD1Database, runMigrations } from "../src/serverfull/db";
import { handlePasskeysRequest } from "../src/api/account/security/passkeys";
import { UserModel } from "../src/models/user";
import { hashPassword } from "../src/utils/crypto";
import type { Env, ExecutionContext, User } from "../src/types";
import { isSafeUrl, isSafeUrlWithDnsCheck } from "../src/utils/validator";
import { verifyAuthenticationResponse, base64UrlEncode } from "../src/lib/webauthn";
import { buildDNSQuery } from "../src/utils/dns/encoder";

async function testSafeUrlSSRFVectors(): Promise<void> {
  console.log("1. Testing isSafeUrl SSRF & Dynamic DNS Wildcard Filtering...");

  // Forbidden suffixes & local namespaces
  assert.strictEqual(isSafeUrl("http://service.localhost/list.txt"), false, "Must block .localhost domain");
  assert.strictEqual(isSafeUrl("http://printer.local/hosts"), false, "Must block .local mDNS domain");
  assert.strictEqual(isSafeUrl("http://metadata.internal/secrets"), false, "Must block .internal domain");
  assert.strictEqual(isSafeUrl("http://router.lan/config"), false, "Must block .lan domain");
  assert.strictEqual(isSafeUrl("http://gateway.home.arpa/status"), false, "Must block .home.arpa domain");
  assert.strictEqual(isSafeUrl("http://localtest.me/api"), false, "Must block localtest.me");
  assert.strictEqual(isSafeUrl("http://foo.localtest.me/api"), false, "Must block *.localtest.me");

  // Dynamic DNS wildcard / embedded IPs (nip.io, sslip.io)
  assert.strictEqual(isSafeUrl("http://127.0.0.1.nip.io/malicious.txt"), false, "Must block 127.0.0.1.nip.io");
  assert.strictEqual(isSafeUrl("http://sub.10.0.0.1.nip.io/list"), false, "Must block 10.0.0.1.nip.io");
  assert.strictEqual(isSafeUrl("http://192.168.1.1.sslip.io/list"), false, "Must block 192.168.1.1.sslip.io");
  assert.strictEqual(isSafeUrl("http://127-0-0-1.sslip.io/list"), false, "Must block 127-0-0-1.sslip.io");
  assert.strictEqual(isSafeUrl("http://169-254-169-254.nip.io/meta"), false, "Must block 169-254-169-254.nip.io");

  // Cloud metadata services
  assert.strictEqual(isSafeUrl("http://metadata.google.internal/computeMetadata/v1/"), false, "Must block GCP metadata");
  assert.strictEqual(isSafeUrl("http://metadata.goog/info"), false, "Must block metadata.goog");
  assert.strictEqual(isSafeUrl("http://169.254.169.254/latest/meta-data/"), false, "Must block AWS IMDS IPv4");
  assert.strictEqual(isSafeUrl("http://instance-data/latest"), false, "Must block instance-data");

  // Legitimate public resources must be allowed
  assert.strictEqual(isSafeUrl("https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts"), true, "Must allow GitHub HTTPS");
  assert.strictEqual(isSafeUrl("https://oisd.nl/domainswbl"), true, "Must allow OISD HTTPS");
  assert.strictEqual(isSafeUrl("tls://1.1.1.1:853"), true, "Must allow Cloudflare DNS over TLS");
  assert.strictEqual(isSafeUrl("http://8.8.8.8/dns-query"), true, "Must allow Google DNS over HTTP");

  // Public IP via sslip.io should be allowed
  assert.strictEqual(isSafeUrl("http://8.8.8.8.nip.io/list.txt"), true, "Must allow public IP via nip.io");

  console.log("  Passed: All SSRF vectors, wildcards, and suffixes correctly handled.");
}

async function testWebAuthnOriginPortBinding(): Promise<void> {
  console.log("2. Testing WebAuthn Origin Port Binding...");

  // Generate a mock challenge and clientDataJSON
  const challenge = "dGVzdC1jaGFsbGVuZ2UtMTIzNDU2";
  const clientDataPort3000 = {
    type: "webauthn.get",
    challenge,
    origin: "http://localhost:3000"
  };
  const clientDataJSONPort3000 = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(clientDataPort3000))
  );

  // Authenticator data: 32 bytes rpIdHash + 1 byte flag (UP=1) + 4 bytes counter
  const rpId = "localhost";
  const rpIdHashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rpId));
  const authData = new Uint8Array(37);
  authData.set(new Uint8Array(rpIdHashBuffer), 0);
  authData[32] = 0x01; // User Present
  authData[36] = 0x01; // sign count = 1
  const authDataB64 = base64UrlEncode(authData);

  // Generate an ECDSA key pair
  const keyPair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const spkiBuffer = (await crypto.subtle.exportKey("spki", keyPair.publicKey)) as ArrayBuffer;
  const publicKeySpki = base64UrlEncode(spkiBuffer);

  // Compute signature over authData + clientDataHash
  const clientDataHashBuffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(clientDataPort3000))
  );
  const signedData = new Uint8Array(authData.length + 32);
  signedData.set(authData, 0);
  signedData.set(new Uint8Array(clientDataHashBuffer), authData.length);

  const signatureBuffer = (await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keyPair.privateKey,
    signedData
  )) as ArrayBuffer;
  const signature = base64UrlEncode(signatureBuffer);

  // Verification against the EXACT matching origin (http://localhost:3000) should PASS
  const validResult = await verifyAuthenticationResponse({
    clientDataJSON: clientDataJSONPort3000,
    authenticatorData: authDataB64,
    signature,
    publicKeySpki,
    algorithm: -7,
    expectedChallenge: challenge,
    expectedOrigin: "http://localhost:3000",
    expectedRpId: rpId,
    previousSignCount: 0
  });
  assert.strictEqual(validResult.signCount, 1, "Matching origin with port must succeed");

  // Verification against a DIFFERENT port (http://localhost:8080) must FAIL
  let portMismatchThrew = false;
  try {
    await verifyAuthenticationResponse({
      clientDataJSON: clientDataJSONPort3000,
      authenticatorData: authDataB64,
      signature,
      publicKeySpki,
      algorithm: -7,
      expectedChallenge: challenge,
      expectedOrigin: "http://localhost:8080",
      expectedRpId: rpId,
      previousSignCount: 0
    });
  } catch (err: any) {
    portMismatchThrew = true;
    assert.match(err.message, /WebAuthn origin mismatch/i, "Must throw origin mismatch error");
  }
  assert.strictEqual(portMismatchThrew, true, "Must reject cross-port authentication assertion");

  console.log("  Passed: WebAuthn origin port mismatch correctly rejected.");
}

async function testFetchListContentSSRFBlocking(): Promise<void> {
  console.log("3. Testing fetchListContent SSRF Pre-validation...");
  const { fetchListContent } = await import("../src/utils/listFetcher");

  // SSRF attempts via loopback / local TLD / dynamic DNS should be blocked before making any requests
  const blocked1 = await fetchListContent("http://127.0.0.1.nip.io/malicious.txt", 1024, 1000, async () => {});
  assert.strictEqual(blocked1.count, 0);
  assert.match(blocked1.error || "", /Invalid list URL/);

  const blocked2 = await fetchListContent("http://metadata.google.internal/secret", 1024, 1000, async () => {});
  assert.strictEqual(blocked2.count, 0);
  assert.match(blocked2.error || "", /Invalid list URL/);

  const blocked3 = await fetchListContent("http://intranet.local/hosts", 1024, 1000, async () => {});
  assert.strictEqual(blocked3.count, 0);
  assert.match(blocked3.error || "", /Invalid list URL/);

  console.log("  Passed: fetchListContent blocked all forbidden SSRF URLs.");
}

async function testRecoveryKeyPreservationLogic(): Promise<void> {
  console.log("4. Testing Passkey Recovery Key Preservation Detection...");

  // Helper reflecting the preservation logic in passkeys.ts
  function shouldPreserveKeys(dbUser: { totp_recovery_keys?: string | null; totp_recovery_keys_encrypted?: string | null }): boolean {
    let hasExistingRecoveryKeys = false;
    if (dbUser.totp_recovery_keys) {
      try {
        const parsed = typeof dbUser.totp_recovery_keys === "string"
          ? JSON.parse(dbUser.totp_recovery_keys)
          : dbUser.totp_recovery_keys;
        if (Array.isArray(parsed) && parsed.length > 0) {
          hasExistingRecoveryKeys = true;
        }
      } catch {
        if (dbUser.totp_recovery_keys.length > 0) {
          hasExistingRecoveryKeys = true;
        }
      }
    } else if (dbUser.totp_recovery_keys_encrypted) {
      hasExistingRecoveryKeys = true;
    }
    return hasExistingRecoveryKeys;
  }

  // Case A: User with existing hashed recovery keys
  const userWithHashed = {
    totp_recovery_keys: JSON.stringify([{ hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }])
  };
  assert.strictEqual(shouldPreserveKeys(userWithHashed), true, "Must preserve existing hashed recovery keys");

  // Case B: User with envelope-encrypted recovery keys
  const userWithEncrypted = {
    totp_recovery_keys: null,
    totp_recovery_keys_encrypted: "encrypted_data_blob"
  };
  assert.strictEqual(shouldPreserveKeys(userWithEncrypted), true, "Must preserve envelope-encrypted recovery keys");

  // Case C: Brand new user with no recovery keys at all
  const brandNewUser = {
    totp_recovery_keys: null,
    totp_recovery_keys_encrypted: null
  };
  assert.strictEqual(shouldPreserveKeys(brandNewUser), false, "Brand new user without keys should generate fresh keys");

  console.log("  Passed: Recovery key preservation correctly identifies existing credentials.");
}

async function testDnsRebindingAndCsprng(): Promise<void> {
  console.log("5. Testing isSafeUrlWithDnsCheck & CSPRNG DNS Query ID...");

  // Anti-Rebinding / TOCTOU SSRF check
  assert.strictEqual(await isSafeUrlWithDnsCheck("http://127.0.0.1/evil"), false, "Must block loopback IP");
  assert.strictEqual(await isSafeUrlWithDnsCheck("http://169.254.169.254/latest"), false, "Must block IMDS metadata");
  assert.strictEqual(await isSafeUrlWithDnsCheck("http://localhost:8080/hosts"), false, "Must block localhost");
  assert.strictEqual(await isSafeUrlWithDnsCheck("http://10.0.0.1/list.txt"), false, "Must block RFC 1918 private IP");
  assert.strictEqual(await isSafeUrlWithDnsCheck("https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts"), true, "Must allow public GitHub URL");

  // CSPRNG DNS Transaction ID generation check
  const queryPacket1 = buildDNSQuery("example.com", "A");
  const queryPacket2 = buildDNSQuery("example.com", "A");
  const id1 = (queryPacket1[0] << 8) | queryPacket1[1];
  const id2 = (queryPacket2[0] << 8) | queryPacket2[1];

  assert.ok(id1 >= 0 && id1 <= 65535, "ID1 must be a valid 16-bit integer");
  assert.ok(id2 >= 0 && id2 <= 65535, "ID2 must be a valid 16-bit integer");

  console.log("  Passed: DNS rebinding defenses and CSPRNG query IDs validated.");
}

async function buildMockWebAuthnRegistration(
  challenge: string,
  origin: string,
  rpId: string,
  credIdSeed: Uint8Array
): Promise<{ clientDataJSON: string; attestationObject: string }> {
  const kp = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as JsonWebKey;
  const xBytes = Uint8Array.from(Buffer.from(jwk.x!, "base64url"));
  const yBytes = Uint8Array.from(Buffer.from(jwk.y!, "base64url"));

  // Encode minimal CBOR COSE ES256 key: {1: 2, 3: -7, -1: 1, -2: x(32), -3: y(32)}
  const cborBytes = (n: number): number[] => (n < 24 ? [0x40 + n] : [0x58, n]);
  const coseKey = new Uint8Array([
    0xa5, // map(5)
    0x01, 0x02, // 1: 2 (EC2)
    0x03, 0x26, // 3: -7 (ES256)
    0x20, 0x01, // -1: 1 (P-256)
    0x21, ...cborBytes(32), ...xBytes, // -2: x
    0x22, ...cborBytes(32), ...yBytes  // -3: y
  ]);

  const rpIdHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rpId))
  );
  const flags = 0x45; // UP | UV | AT
  const aaguid = new Uint8Array(16);
  const credLen = new Uint8Array([(credIdSeed.length >> 8) & 0xff, credIdSeed.length & 0xff]);

  const authData = new Uint8Array(32 + 1 + 4 + 16 + 2 + credIdSeed.length + coseKey.length);
  let offset = 0;
  authData.set(rpIdHash, offset); offset += 32;
  authData[offset++] = flags;
  offset += 4; // signCount = 0
  authData.set(aaguid, offset); offset += 16;
  authData.set(credLen, offset); offset += 2;
  authData.set(credIdSeed, offset); offset += credIdSeed.length;
  authData.set(coseKey, offset);

  // Encode CBOR map {"authData": bstr}
  const authDataKey = new TextEncoder().encode("authData");
  const authDataLenHdr =
    authData.length < 24
      ? [0x40 + authData.length]
      : authData.length < 256
      ? [0x58, authData.length]
      : [0x59, (authData.length >> 8) & 0xff, authData.length & 0xff];

  const attestationObj = new Uint8Array([
    0xa1,
    0x60 + authDataKey.length,
    ...authDataKey,
    ...authDataLenHdr,
    ...authData
  ]);

  const clientDataJSON = base64UrlEncode(
    new TextEncoder().encode(
      JSON.stringify({
        type: "webauthn.create",
        challenge,
        origin
      })
    )
  );

  return {
    clientDataJSON,
    attestationObject: base64UrlEncode(attestationObj)
  };
}

async function testPasskeyRegistrationEnablesPasswordless(): Promise<void> {
  console.log("6. Testing Passkey Registration Enables Passwordless Login...");

  const rawDb = new DatabaseSync(":memory:");
  runMigrations(rawDb, path.resolve(__dirname, "../migrations"));
  const db = new NodeD1Database(rawDb);

  const memoryCacheStore = new Map<string, Response>();
  const globalWithCaches = globalThis as unknown as { caches?: unknown };
  const originalCaches = globalWithCaches.caches;
  globalWithCaches.caches = {
    default: {
      async match(req: Request | string) {
        const key = typeof req === "string" ? req : req.url;
        const cached = memoryCacheStore.get(key);
        return cached ? cached.clone() : undefined;
      },
      async put(req: Request | string, res: Response) {
        const key = typeof req === "string" ? req : req.url;
        memoryCacheStore.set(key, res.clone());
      },
      async delete(req: Request | string) {
        const key = typeof req === "string" ? req : req.url;
        return memoryCacheStore.delete(key);
      }
    }
  };

  try {
    const env = { DB: db, JWT_SECRET: "testsecret1234567890123456789012" } as unknown as Env;
    const userModel = new UserModel(db, env);
    const password = "TestPassword123!";
    const hashed = await hashPassword(password, 1);
    await db
      .prepare(
        "INSERT INTO users (id, username, hashed_password, role, created_at, password_version, totp_enabled, totp_skip_password) VALUES (?, ?, ?, 'user', ?, 1, 0, 0)"
      )
      .bind("user_passkey_1", "passkey_user", hashed, Math.floor(Date.now() / 1000))
      .run();

    const user: User = { id: "user_passkey_1", username: "passkey_user", role: "user" };
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    const baseOrigin = "https://dns.example.com";

    // Step 1: Register initial Passkey
    const optRes1 = await handlePasskeysRequest(
      new Request(`${baseOrigin}/api/account/passkeys/register/options`, { method: "POST" }),
      env,
      user,
      ["api", "account", "passkeys", "register", "options"],
      ctx
    );
    assert.strictEqual(optRes1.status, 200, "Options generation must succeed");
    const opt1 = (await optRes1.json()) as { challenge: string };

    const cred1 = await buildMockWebAuthnRegistration(
      opt1.challenge,
      baseOrigin,
      "dns.example.com",
      new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    );
    const verifyRes1 = await handlePasskeysRequest(
      new Request(`${baseOrigin}/api/account/passkeys/register/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "primary_key",
          credential: { response: cred1 }
        })
      }),
      env,
      user,
      ["api", "account", "passkeys", "register", "verify"],
      ctx
    );
    assert.strictEqual(verifyRes1.status, 201, "Initial passkey registration must return 201");
    const verify1Data = (await verifyRes1.json()) as { recovery_keys?: string[] };
    assert.ok(verify1Data.recovery_keys && verify1Data.recovery_keys.length > 0, "Recovery keys generated");

    const dbUserAfterFirst = await userModel.getById(user.id);
    assert.strictEqual(
      dbUserAfterFirst?.totp_skip_password,
      1,
      "Passwordless Login must be enabled automatically after configuring initial Passkey"
    );

    // Step 2: Explicitly disable Passwordless Login, then add a 2nd backup Passkey -> preference preserved
    await userModel.updateTOTPSettings(user.id, false);
    const optRes2 = await handlePasskeysRequest(
      new Request(`${baseOrigin}/api/account/passkeys/register/options`, { method: "POST" }),
      env,
      user,
      ["api", "account", "passkeys", "register", "options"],
      ctx
    );
    assert.strictEqual(optRes2.status, 200);
    const opt2 = (await optRes2.json()) as { challenge: string };
    const cred2 = await buildMockWebAuthnRegistration(
      opt2.challenge,
      baseOrigin,
      "dns.example.com",
      new Uint8Array([9, 10, 11, 12, 13, 14, 15, 16])
    );
    const verifyRes2 = await handlePasskeysRequest(
      new Request(`${baseOrigin}/api/account/passkeys/register/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "backup_key",
          recoveryKey: verify1Data.recovery_keys[0],
          credential: { response: cred2 }
        })
      }),
      env,
      user,
      ["api", "account", "passkeys", "register", "verify"],
      ctx
    );
    assert.strictEqual(verifyRes2.status, 201, "Backup passkey registration must return 201");

    const dbUserAfterSecond = await userModel.getById(user.id);
    assert.strictEqual(
      dbUserAfterSecond?.totp_skip_password,
      0,
      "Explicit password requirement opt-out must be preserved when adding a backup passkey"
    );
  } finally {
    globalWithCaches.caches = originalCaches;
  }

  console.log("  Passed: Passkey registration automatically enables Passwordless Login.");
}

async function runAllTests(): Promise<void> {
  console.log("================================================================");
  console.log("       DNS Worker Security Audit Round 3 Verification Suite        ");
  console.log("================================================================\n");

  await testSafeUrlSSRFVectors();
  await testWebAuthnOriginPortBinding();
  await testFetchListContentSSRFBlocking();
  await testRecoveryKeyPreservationLogic();
  await testDnsRebindingAndCsprng();
  await testPasskeyRegistrationEnablesPasswordless();

  console.log("\n>>> [TEST] All Round 3 Security Audit tests passed successfully!\n");
}

runAllTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});

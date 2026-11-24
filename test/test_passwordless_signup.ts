/**
 * @file test_passwordless_signup.ts
 * @description End-to-end tests for passwordless user registration, 64-char server-hashed
 * placeholder password, Recovery Key generation, MFA lockouts, and adding a password later.
 */

import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { D1Database } from "@cloudflare/workers-types";
import { NodeD1Database, runMigrations } from "../src/serverfull/db";
import { handleAuthRegisterRequest } from "../src/api/auth/register";
import { handleLoginRequest } from "../src/api/auth/login";
import { handleMeRequest } from "../src/api/account/me";
import { handleSecurityRequest } from "../src/api/account/security";
import { generateTOTPSecret } from "../src/lib/totp";
import type { Env, ExecutionContext, User } from "../src/types";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

async function computeTotpAtStep(secret: string, counter: number): Promise<string> {
  const normalized = secret.replace(/[\s=]+/g, "").toUpperCase();
  const bytes: number[] = [];
  let buffer = 0;
  let bitsLeft = 0;
  for (const ch of normalized) {
    const val = BASE32_ALPHABET.indexOf(ch);
    if (val === -1) continue;
    buffer = (buffer << 5) | val;
    bitsLeft += 5;
    if (bitsLeft >= 8) {
      bitsLeft -= 8;
      bytes.push((buffer >> bitsLeft) & 0xff);
    }
  }
  const counterBytes = new Uint8Array(8);
  const view = new DataView(counterBytes.buffer);
  view.setUint32(4, counter >>> 0, false);
  view.setUint32(0, Math.floor(counter / 0x100000000) >>> 0, false);
  const key = await crypto.subtle.importKey("raw", new Uint8Array(bytes), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const hmac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counterBytes));
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (code % 1000000).toString().padStart(6, "0");
}

function createMockCache(): Cache {
  const store = new Map<string, Response>();
  return {
    async match(request: RequestInfo | URL) {
      const key = typeof request === "string" ? request : request instanceof URL ? request.toString() : request.url;
      const cached = store.get(key);
      return cached ? cached.clone() : undefined;
    },
    async put(request: RequestInfo | URL, response: Response) {
      const key = typeof request === "string" ? request : request instanceof URL ? request.toString() : request.url;
      store.set(key, response.clone());
    },
    async delete(request: RequestInfo | URL) {
      const key = typeof request === "string" ? request : request instanceof URL ? request.toString() : request.url;
      return store.delete(key);
    },
  } as unknown as Cache;
}

function createMockCtx(): ExecutionContext {
  return {
    waitUntil: (p: Promise<unknown>) => {
      p.catch(() => {});
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function run(): Promise<void> {
  const prevCaches = (globalThis as { caches?: unknown }).caches;
  (globalThis as { caches: { default: Cache } }).caches = { default: createMockCache() };

  const sqlite = new DatabaseSync(":memory:");
  runMigrations(sqlite, path.join(process.cwd(), "migrations"));
  const d1 = new NodeD1Database(sqlite) as unknown as D1Database;

  const env: Env = {
    DB: d1,
    ASSETS: {},
    JWT_SECRET: "a_super_secure_random_jwt_secret_key_for_testing_1234567890",
  };
  const ctx = createMockCtx();

  try {
    // 1. Register a passwordless user (`skipPassword: true`)
    const signupReq = new Request("https://example.com/api/auth/signup", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CF-Connecting-IP": "198.51.100.10",
        "CF-IPLatitude": "37.7749",
        "CF-IPLongitude": "-122.4194",
      },
      body: JSON.stringify({
        username: "pwlessuser",
        skipPassword: true,
        turnstileToken: null,
      }),
    });
    const signupRes = await handleAuthRegisterRequest(signupReq, env);
    assert.equal(signupRes.status, 200, `Signup failed: ${signupRes.status}`);
    const signupJson = (await signupRes.json()) as {
      success: boolean;
      accessToken: string;
      recoveryKey: string;
    };
    assert.equal(signupJson.success, true);
    assert.ok(signupJson.accessToken, "Expected accessToken on passwordless signup");
    assert.ok(signupJson.recoveryKey, "Expected recoveryKey to be retained for passwordless signup");

    // Check DB row: has_password = 0, totp_skip_password = 1, hashed_password populated (v2 PBKDF2 hash)
    const dbRow = await d1
      .prepare("SELECT id, username, hashed_password, has_password, totp_skip_password, password_version FROM users WHERE username = ?")
      .bind("pwlessuser")
      .first<{
        id: string;
        username: string;
        hashed_password: string;
        has_password: number;
        totp_skip_password: number;
        password_version: number;
      }>();
    assert.ok(dbRow, "User row missing");
    assert.equal(dbRow.has_password, 0);
    assert.equal(dbRow.totp_skip_password, 1);
    assert.equal(dbRow.password_version, 2);
    assert.ok(dbRow.hashed_password && dbRow.hashed_password.length > 32, "Server-hashed placeholder password must be stored");

    const user: User = { id: dbRow.id, username: dbRow.username, role: "admin" };

    // 2. Enroll TOTP for the passwordless account
    const totpSecret = generateTOTPSecret();
    const step = Math.floor(Date.now() / 1000 / 30);
    const code = await computeTotpAtStep(totpSecret, step);
    const salt1 = crypto.randomUUID();
    const hash1 = await sha256Hex(code + salt1);

    const confirmTotpRes = await handleSecurityRequest(
      new Request("https://example.com/api/account/totp/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.10" },
        body: JSON.stringify({ secret: totpSecret, totpTokenHash: hash1, salt: salt1 }),
      }),
      env,
      user,
      ["api", "account", "totp", "confirm"],
      ctx
    );
    assert.equal(confirmTotpRes.status, 200);

    // 3. GET /api/account/me reports has_password: false and totp_skip_password: true
    const meRes = await handleMeRequest(
      new Request("https://example.com/api/account/me"),
      env,
      user,
      ["api", "account", "me"],
      ctx
    );
    assert.equal(meRes.status, 200);
    const meJson = (await meRes.json()) as {
      has_password: boolean;
      totp_skip_password: boolean;
      totp_enabled: boolean;
      has_recovery_keys: boolean;
    };
    assert.equal(meJson.has_password, false);
    assert.equal(meJson.totp_skip_password, true);
    assert.equal(meJson.totp_enabled, true);
    assert.equal(meJson.has_recovery_keys, true);

    // 4. Attempting to disable passwordless login fails with 400 passwordless_cannot_disable
    const disablePwlessRes = await handleSecurityRequest(
      new Request("https://example.com/api/account/mfa/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skip_password: false }),
      }),
      env,
      user,
      ["api", "account", "mfa", "settings"],
      ctx
    );
    assert.equal(disablePwlessRes.status, 400);
    assert.equal(await disablePwlessRes.text(), "passwordless_cannot_disable");

    // 5. Attempting to remove the last MFA factor (TOTP) while passwordless fails with 400
    const codeForDelete = await computeTotpAtStep(totpSecret, step - 1);
    const salt2 = crypto.randomUUID();
    const hash2 = await sha256Hex(codeForDelete + salt2);
    const deleteTotpRes = await handleSecurityRequest(
      new Request("https://example.com/api/account/totp", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ totpTokenHash: hash2, totpSalt: salt2 }),
      }),
      env,
      user,
      ["api", "account", "totp"],
      ctx
    );
    assert.equal(deleteTotpRes.status, 400);
    assert.equal(await deleteTotpRes.text(), "cannot_remove_last_mfa_without_password");

    // 6. Prelogin reports requires_password: false, requires_totp: true
    const preloginRes = await handleLoginRequest(
      new Request("https://example.com/api/auth/prelogin", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.10" },
        body: JSON.stringify({ username: "pwlessuser", turnstileToken: null }),
      }),
      env
    );
    assert.equal(preloginRes.status, 200);
    const preloginJson = (await preloginRes.json()) as {
      requires_password: boolean;
      requires_totp: boolean;
    };
    assert.equal(preloginJson.requires_password, false);
    assert.equal(preloginJson.requires_totp, true);

    // 7. Adding a password via TOTP verification flips has_password -> 1 and allows disabling passwordless later
    const codeForAddPw = await computeTotpAtStep(totpSecret, step + 1);
    const salt3 = crypto.randomUUID();
    const hash3 = await sha256Hex(codeForAddPw + salt3);
    const newClientHash = await sha256Hex("MyAddedStrongPassword!123");
    const addPwRes = await handleSecurityRequest(
      new Request("https://example.com/api/account/password", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.10" },
        body: JSON.stringify({
          totpTokenHash: hash3,
          totpSalt: salt3,
          newPassword: newClientHash,
        }),
      }),
      env,
      user,
      ["api", "account", "password"],
      ctx
    );
    assert.equal(addPwRes.status, 200);

    const meAfterAdd = await (
      await handleMeRequest(new Request("https://example.com/api/account/me"), env, user, ["api", "account", "me"], ctx)
    ).json() as { has_password: boolean };
    assert.equal(meAfterAdd.has_password, true);

    // Now disabling passwordless login succeeds
    const disableAfterAddRes = await handleSecurityRequest(
      new Request("https://example.com/api/account/mfa/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skip_password: false }),
      }),
      env,
      user,
      ["api", "account", "mfa", "settings"],
      ctx
    );
    assert.equal(disableAfterAddRes.status, 200);

    console.log("[PASS] All passwordless signup & account management tests passed!");
  } finally {
    sqlite.close();
    if (prevCaches === undefined) {
      delete (globalThis as { caches?: unknown }).caches;
    } else {
      (globalThis as { caches?: unknown }).caches = prevCaches;
    }
  }
}

run().catch((err) => {
  console.error("[FAIL] test_passwordless_signup failed:", err);
  process.exit(1);
});

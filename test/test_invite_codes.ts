/**
 * @file test_invite_codes.ts
 * @description Integration and unit tests for user invite code registration, admin management, and rate limiting.
 */

import assert from "node:assert";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { handleAuthRegisterRequest } from "../src/api/auth/register";
import { handleAuthConfigRequest } from "../src/api/auth/config";
import { handleAdminRequest } from "../src/api/account/admin";
import { InviteCodeModel } from "../src/models/inviteCode";
import { SystemSettingsModel } from "../src/models/systemSettings";
import { UserModel } from "../src/models/user";
import { NodeD1Database, runMigrations } from "../src/serverfull/db";
import { INVITE_CODE_REGEX } from "../src/utils/validator";
import type { Env, User, ExecutionContext } from "../src/types";

class MockCache {
  private store = new Map<string, Response>();
  async match(req: Request | string): Promise<Response | undefined> {
    const key = typeof req === "string" ? req : req.url;
    const hit = this.store.get(key);
    return hit ? hit.clone() : undefined;
  }
  async put(req: Request | string, res: Response): Promise<void> {
    const key = typeof req === "string" ? req : req.url;
    this.store.set(key, res);
  }
  async delete(req: Request | string): Promise<boolean> {
    const key = typeof req === "string" ? req : req.url;
    return this.store.delete(key);
  }
}

const mockCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function buildSignupRequest(username: string, inviteCode?: string, ip: string = "198.51.100.10"): Request {
  return new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": ip,
      "CF-IPCountry": "US",
      "CF-IPLatitude": "37.7749",
      "CF-IPLongitude": "-122.4194",
    },
    body: JSON.stringify({
      username,
      password: "ValidPassword!123456",
      turnstileToken: null,
      ...(inviteCode !== undefined ? { inviteCode } : {}),
    }),
  });
}

async function runInviteCodeTestSuite(): Promise<void> {
  console.log("================================================================");
  console.log("          Invite Code Registration Test Suite                   ");
  console.log("================================================================");

  const rawDb = new DatabaseSync(":memory:");
  const migrationsDir = path.resolve(__dirname, "../migrations");
  runMigrations(rawDb, migrationsDir);
  const db = new NodeD1Database(rawDb);

  const mockCache = new MockCache();
  (globalThis as any).caches = { default: mockCache };
  SystemSettingsModel.clearMemoryCache();

  const env: Env = {
    DB: db,
    ASSETS: { fetch: async () => new Response("Not Found", { status: 404 }) },
    JWT_SECRET: "test_jwt_secret_must_be_at_least_32_characters_long_for_security",
  };

  const userModel = new UserModel(db, env);
  const inviteModel = new InviteCodeModel(db);

  // 1. Bootstrap first admin (exempt from invite code even if setting toggled)
  const settingsResPre = await handleAuthConfigRequest(
    new Request("http://localhost/api/auth/config"),
    env
  );
  const configPre = (await settingsResPre.json()) as { has_users: boolean; invite_code_enabled: boolean };
  assert.strictEqual(configPre.has_users, false);
  assert.strictEqual(configPre.invite_code_enabled, false);

  const adminRegRes = await handleAuthRegisterRequest(buildSignupRequest("admin_user", undefined, "198.51.100.1"), env);
  assert.strictEqual(adminRegRes.status, 200, "Initial admin bootstrap must succeed without invite code");

  const usersAfterAdmin = await userModel.listAll();
  const adminUser: User = {
    id: usersAfterAdmin[0].id,
    username: usersAfterAdmin[0].username,
    role: "admin",
  };

  // 2. Enable invite code registration via admin settings PATCH
  const toggleRes = await handleAdminRequest(
    new Request("http://localhost/api/admin/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invite_code_enabled: "true" }),
    }),
    env,
    adminUser,
    ["api", "admin", "settings"],
    mockCtx
  );
  assert.strictEqual(toggleRes.status, 200);

  const configAfter = (await (
    await handleAuthConfigRequest(new Request("http://localhost/api/auth/config"), env)
  ).json()) as { has_users: boolean; invite_code_enabled: boolean };
  assert.strictEqual(configAfter.has_users, true);
  assert.strictEqual(configAfter.invite_code_enabled, true);

  // 3. Create auto-generated & custom 6-char invite codes via admin API
  const createAutoRes = await handleAdminRequest(
    new Request("http://localhost/api/admin/invite-codes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ max_uses: 2, expires_at: Math.floor(Date.now() / 1000) + 3600 }),
    }),
    env,
    adminUser,
    ["api", "admin", "invite-codes"],
    mockCtx
  );
  assert.strictEqual(createAutoRes.status, 201);
  const autoCodeRecord = (await createAutoRes.json()) as {
    code: string;
    max_uses: number;
    remaining_uses: number;
    expires_at: number | null;
    last_used_at: number | null;
  };
  assert.ok(INVITE_CODE_REGEX.test(autoCodeRecord.code), `Generated code must match 6-char [A-Z0-9]: ${autoCodeRecord.code}`);
  assert.strictEqual(autoCodeRecord.max_uses, 2);
  assert.strictEqual(autoCodeRecord.remaining_uses, 2);
  assert.strictEqual(autoCodeRecord.last_used_at, null);

  // Invalid format rejected
  const badCreateRes = await handleAdminRequest(
    new Request("http://localhost/api/admin/invite-codes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "bad-1", max_uses: 1 }),
    }),
    env,
    adminUser,
    ["api", "admin", "invite-codes"],
    mockCtx
  );
  assert.strictEqual(badCreateRes.status, 400);

  // 4. Signup without invite code or with bad code rejected
  const missingCodeRes = await handleAuthRegisterRequest(buildSignupRequest("bob_user", undefined, "198.51.100.2"), env);
  assert.strictEqual(missingCodeRes.status, 400);
  assert.strictEqual(await missingCodeRes.text(), "invite_code_required");

  // 5. Signup with valid invite code succeeds, tracks user.invite_code, decrements remaining_uses, stamps last_used_at
  const validSignupRes = await handleAuthRegisterRequest(
    buildSignupRequest("alice_user", autoCodeRecord.code, "198.51.100.3"),
    env
  );
  assert.strictEqual(validSignupRes.status, 200);

  const usersList = await userModel.listAll();
  const alice = usersList.find((u) => u.username === "alice_user");
  assert.ok(alice, "alice_user must exist");
  assert.strictEqual(alice.invite_code, autoCodeRecord.code, "User row must record consumed invite_code");

  const updatedInvite = await inviteModel.getByCode(autoCodeRecord.code);
  assert.ok(updatedInvite);
  assert.strictEqual(updatedInvite.max_uses, 2);
  assert.strictEqual(updatedInvite.remaining_uses, 1);
  assert.ok(typeof updatedInvite.last_used_at === "number" && updatedInvite.last_used_at > 0);

  // 6. Exhaust remaining use then ensure exhausted error on next signup
  const validSignup2Res = await handleAuthRegisterRequest(
    buildSignupRequest("carol_user", autoCodeRecord.code, "198.51.100.4"),
    env
  );
  assert.strictEqual(validSignup2Res.status, 200);

  const exhaustedRes = await handleAuthRegisterRequest(
    buildSignupRequest("dave_user", autoCodeRecord.code, "198.51.100.5"),
    env
  );
  assert.strictEqual(exhaustedRes.status, 400);
  assert.strictEqual(await exhaustedRes.text(), "invite_code_exhausted");

  // 7. Expired invite code check
  const expiredInsertTime = Math.floor(Date.now() / 1000) - 10;
  await db
    .prepare(
      "INSERT INTO invite_codes (code, max_uses, remaining_uses, expires_at, last_used_at, created_at, created_by) VALUES ('EXP999', 5, 5, ?, NULL, ?, 'admin')"
    )
    .bind(expiredInsertTime, expiredInsertTime - 100)
    .run();

  const expiredCheckRes = await handleAuthConfigRequest(
    new Request("http://localhost/api/auth/check-invite-code", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.20" },
      body: JSON.stringify({ inviteCode: "EXP999" }),
    }),
    env
  );
  assert.strictEqual(expiredCheckRes.status, 400);
  assert.strictEqual(await expiredCheckRes.text(), "invite_code_expired");

  // 8. Rate limiting on invite code verification: 5 attempts/min per IP, 6th returns 429
  const rateLimitIp = "198.51.100.99";
  for (let i = 1; i <= 5; i++) {
    const res = await handleAuthConfigRequest(
      new Request("http://localhost/api/auth/check-invite-code", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": rateLimitIp },
        body: JSON.stringify({ inviteCode: "NOPE01" }),
      }),
      env
    );
    assert.strictEqual(res.status, 400, `Attempt ${i} should be checked normally`);
  }
  const sixthAttemptRes = await handleAuthConfigRequest(
    new Request("http://localhost/api/auth/check-invite-code", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": rateLimitIp },
      body: JSON.stringify({ inviteCode: "NOPE01" }),
    }),
    env
  );
  assert.strictEqual(sixthAttemptRes.status, 429, "6th invite verification within 60s must return 429");

  // 9. Admin list & delete invite code
  const listRes = await handleAdminRequest(
    new Request("http://localhost/api/admin/invite-codes"),
    env,
    adminUser,
    ["api", "admin", "invite-codes"],
    mockCtx
  );
  assert.strictEqual(listRes.status, 200);
  const listed = (await listRes.json()) as Array<{ code: string }>;
  assert.ok(listed.some((item) => item.code === autoCodeRecord.code));

  const delRes = await handleAdminRequest(
    new Request(`http://localhost/api/admin/invite-codes/${autoCodeRecord.code}`, { method: "DELETE" }),
    env,
    adminUser,
    ["api", "admin", "invite-codes", autoCodeRecord.code],
    mockCtx
  );
  assert.strictEqual(delRes.status, 204);

  console.log("[PASS] All invite code registration, management, and 5/min rate-limit tests passed!");
}

runInviteCodeTestSuite().catch((err) => {
  console.error(err);
  process.exit(1);
});

import { Env, User, ExecutionContext } from "../../../types";
import { generateSessionHash } from "../../../utils/crypto";
import {
  generateTOTPSecret,
  getTOTPUri,
  generateRecoveryKeys,
  hashRecoveryKey,
  verifyTOTPWithStep,
  StoredRecoveryKeyItem
} from "../../../lib/totp";
import { cacheUtils } from "../../../utils/cache";
import { UserModel } from "../../../models/user";
import { ActivityLogModel } from "../../../models/activityLog";
import { PasskeyModel } from "../../../models/passkey";
import { verifyUserReauth, ReauthPayload } from "./reauth";

/**
 * Handles TOTP multi-factor authentication and unified MFA settings:
 * - GET /api/account/totp/setup (generate new secret and QR URI)
 * - POST /api/account/totp/confirm (verify token and activate TOTP + generate recovery keys)
 * - POST /api/account/totp/test (verify token without modifying account state)
 * - PATCH /api/account/totp/settings (skip_password toggle)
 * - DELETE /api/account/totp (disable TOTP)
 * - PATCH /api/account/mfa/settings (unified skip_password toggle)
 *
 * @param request - Inbound HTTP Request.
 * @param env - Cloudflare Worker environment bindings.
 * @param user - Current authenticated user.
 * @param pathParts - URL pathname components.
 * @param ctx - Execution context.
 * @returns Response indicating operation outcome.
 */
export async function handleTotpAndMfaRequest(
  request: Request,
  env: Env,
  user: User,
  pathParts: string[],
  _ctx: ExecutionContext
): Promise<Response> {
  const userModel = new UserModel(env.DB, env);
  const activityLog = new ActivityLogModel(env.DB);
  const clientIp = request.headers.get("CF-Connecting-IP") || "127.0.0.1";
  const userAgent = request.headers.get("User-Agent");
  const action = pathParts[2];
  const sessionHash = user.sessionId ? await generateSessionHash(user.sessionId, user.id) : null;

  // ─── TOTP 管理接口 (/api/account/totp/...) ───
  if (action === "totp") {
    const subAction = pathParts[3];

    // GET /api/account/totp/setup — generate new TOTP secret (not yet saved)
    if (subAction === "setup" && request.method === "GET") {
      const dbUser = await userModel.getById(user.id);
      if (dbUser?.totp_enabled) {
        return new Response("TOTP is already enabled", { status: 409 });
      }
      const secret = generateTOTPSecret();
      const host = new URL(request.url).hostname;
      const uri = getTOTPUri(secret, dbUser?.username || "user", host);
      return new Response(JSON.stringify({ secret, uri }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // POST /api/account/totp/confirm — verify TOTP code and activate
    if (subAction === "confirm" && request.method === "POST") {
      const body = (await request.json()) as ReauthPayload & {
        secret: string;
        totpTokenHash: string;
        salt?: string;
      };
      const { secret, totpTokenHash, salt } = body;
      if (!secret || !totpTokenHash) return new Response("Missing secret or token", { status: 400 });

      // Enforce Base32 secret with at least 160 bits (32 Base32 characters)
      const normalizedSecret = String(secret).replace(/[\s=]+/g, "").toUpperCase();
      if (!/^[A-Z2-7]{32,}$/.test(normalizedSecret)) {
        return new Response("Invalid or weak TOTP secret", { status: 400 });
      }

      const dbUser = await userModel.getById(user.id);
      if (!dbUser) return new Response("User not found", { status: 404 });

      // Prevent silent TOTP overwrite or passwordless downgrade without step-up reauthentication
      if (dbUser.totp_enabled) {
        const authResult = await verifyUserReauth(dbUser, body, env, request, { sessionId: user.sessionId });
        if (!authResult.success) {
          await activityLog.record(user.id, "totp_verify_fail", clientIp, userAgent, { flow: "totp_reenroll", reason: authResult.reason }, sessionHash);
          return new Response(authResult.error || "Re-authentication required to replace TOTP", { status: 403 });
        }
      }

      const totpResult = await verifyTOTPWithStep(normalizedSecret, totpTokenHash, salt);
      if (!totpResult.valid) return new Response("Invalid TOTP code", { status: 400 });

      // Generate recovery keys, store only hash under envelope encryption
      const plaintextKeys = generateRecoveryKeys();
      const storedItems = await Promise.all(
        plaintextKeys.map(async (k) => ({
          hash: await hashRecoveryKey(k)
        }))
      );

      await userModel.updateTOTP(user.id, normalizedSecret, storedItems as any);
      // Only enable passwordless mode on initial enrollment if user has no passwordless restriction;
      // keep existing totp_skip_password setting when re-enrolling.
      if (!dbUser.totp_enabled) {
        await userModel.updateTOTPSettings(user.id, true);
      }
      await activityLog.record(user.id, "totp_setup", clientIp, userAgent, undefined, sessionHash);

      return new Response(JSON.stringify({ success: true, recovery_keys: plaintextKeys }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // POST /api/account/totp/test — verify TOTP code without modifying account state
    if (subAction === "test" && request.method === "POST") {
      const cache = (caches as any).default;
      const rateLimitKey = `totp_test_fail:${user.id}`;
      if (await cacheUtils.isRateLimited(cache, rateLimitKey, 10, 900)) {
        return new Response(JSON.stringify({ success: false, message: "Too many failed attempts" }), {
          status: 429,
          headers: { "Content-Type": "application/json" }
        });
      }

      const dbUser = await userModel.getById(user.id);
      if (!dbUser?.totp_enabled || !dbUser?.totp_secret) {
        return new Response(JSON.stringify({ success: false, message: "TOTP is not enabled" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }

      const { token, totpTokenHash, salt } = (await request.json()) as {
        token?: string;
        totpTokenHash?: string;
        salt?: string;
      };

      const codeToVerify = totpTokenHash || token;
      if (!codeToVerify) {
        return new Response(JSON.stringify({ success: false, message: "Missing token" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }

      const totpResult = await verifyTOTPWithStep(dbUser.totp_secret, codeToVerify, salt);
      if (!totpResult.valid) {
        await activityLog.record(user.id, "totp_verify_fail", clientIp, userAgent, { flow: "mfa_test" }, sessionHash);
        return new Response(JSON.stringify({ success: false, message: "Invalid TOTP code" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }

      if (totpResult.timeStep !== undefined) {
        const replayKey = `totp_used:${user.id}:${totpResult.timeStep}`;
        if (await cacheUtils.get(cache, replayKey)) {
          return new Response(JSON.stringify({ success: false, message: "TOTP code has already been used" }), {
            status: 400,
            headers: { "Content-Type": "application/json" }
          });
        }
        await cacheUtils.set(cache, replayKey, 1, 90);
      }

      await cacheUtils.delete(cache, `ratelimit:${rateLimitKey}`);
      await activityLog.record(user.id, "totp_verify_success", clientIp, userAgent, { flow: "mfa_test" }, sessionHash);

      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // PATCH /api/account/totp/settings — update skip_password toggle
    if (subAction === "settings" && request.method === "PATCH") {
      const dbUser = await userModel.getById(user.id);
      if (!dbUser) return new Response("User not found", { status: 404 });
      const passkeyModel = new PasskeyModel(env.DB);
      const passkeys = await passkeyModel.listByUser(user.id);
      const hasMfa = !!dbUser.totp_enabled || passkeys.length > 0;
      if (!hasMfa) return new Response("MFA is not enabled", { status: 400 });

      const body = (await request.json()) as ReauthPayload & { skip_password: boolean };
      if (body.skip_password) {
        const authResult = await verifyUserReauth(dbUser, body, env, request, { sessionId: user.sessionId });
        if (!authResult.success) {
          return new Response(authResult.error || "Re-authentication required", { status: 403 });
        }
      }
      await userModel.updateTOTPSettings(user.id, !!body.skip_password);
      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // DELETE /api/account/totp — disable TOTP (strictly requires step-up reauthentication)
    if (!subAction && request.method === "DELETE") {
      const body = (await request.json().catch(() => ({}))) as ReauthPayload;
      const dbUser = await userModel.getById(user.id);
      if (!dbUser) return new Response("User not found", { status: 404 });

      const authResult = await verifyUserReauth(dbUser, body, env, request, { sessionId: user.sessionId });
      if (!authResult.success) {
        await activityLog.record(user.id, "totp_verify_fail", clientIp, userAgent, { reason: authResult.reason }, sessionHash);
        return new Response(authResult.error || "Authentication failed", { status: 400 });
      }

      const passkeyModel = new PasskeyModel(env.DB);
      const passkeys = await passkeyModel.listByUser(user.id);
      const hasPasskey = passkeys.length > 0;

      await userModel.removeTOTP(user.id, hasPasskey);
      await activityLog.record(user.id, "totp_removed", clientIp, userAgent, { method: authResult.method }, sessionHash);
      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" }
      });
    }
  }

  // ─── 统一 MFA 设置接口 (/api/account/mfa/settings) ───
  if (action === "mfa" && pathParts[3] === "settings" && request.method === "PATCH") {
    const dbUser = await userModel.getById(user.id);
    if (!dbUser) return new Response("User not found", { status: 404 });
    const passkeyModel = new PasskeyModel(env.DB);
    const passkeys = await passkeyModel.listByUser(user.id);
    const hasMfa = !!dbUser.totp_enabled || passkeys.length > 0;
    if (!hasMfa) return new Response("MFA is not enabled", { status: 400 });

    const body = (await request.json()) as ReauthPayload & { skip_password: boolean };
    if (body.skip_password) {
      const authResult = await verifyUserReauth(dbUser, body, env, request, { sessionId: user.sessionId });
      if (!authResult.success) {
        return new Response(authResult.error || "Re-authentication required", { status: 403 });
      }
    }
    await userModel.updateTOTPSettings(user.id, !!body.skip_password);
    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  return new Response("Not Found", { status: 404 });
}

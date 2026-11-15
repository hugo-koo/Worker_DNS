import { Env, User, ExecutionContext } from "../../../types";
import { generateSessionHash } from "../../../utils/crypto";
import { UserModel, StoredRecoveryKey } from "../../../models/user";
import { ActivityLogModel } from "../../../models/activityLog";
import { PasskeyModel } from "../../../models/passkey";
import { PASSKEY_NAME_REGEX } from "../../../utils/validator";
import {
  generateWebAuthnChallenge,
  base64UrlEncode,
  verifyRegistrationResponse,
  verifyAuthenticationResponse
} from "../../../lib/webauthn";
import { cacheUtils } from "../../../utils/cache";
import { generateRecoveryKeys, hashRecoveryKey } from "../../../lib/totp";
import { verifyUserReauth, ReauthPayload } from "./reauth";

/**
 * Handles WebAuthn Passkeys lifecycle endpoints:
 * - GET /api/account/passkeys (list user passkeys)
 * - POST /api/account/passkeys/auth-options (generate authentication challenge for logged-in user)
 * - POST /api/account/passkeys/register/options (generate registration options & challenge)
 * - POST /api/account/passkeys/register/verify (verify registration response and persist passkey)
 * - PATCH /api/account/passkeys/:id (rename passkey)
 * - DELETE /api/account/passkeys/:id (delete passkey)
 *
 * @param request - Inbound HTTP Request.
 * @param env - Cloudflare Worker environment bindings.
 * @param user - Current authenticated user.
 * @param pathParts - URL pathname components.
 * @param ctx - Execution context.
 * @returns Response indicating operation outcome.
 */
export async function handlePasskeysRequest(
  request: Request,
  env: Env,
  user: User,
  pathParts: string[],
  _ctx: ExecutionContext
): Promise<Response> {
  const userModel = new UserModel(env.DB, env);
  const passkeyModel = new PasskeyModel(env.DB);
  const activityLog = new ActivityLogModel(env.DB);
  const clientIp = request.headers.get("CF-Connecting-IP") || "127.0.0.1";
  const userAgent = request.headers.get("User-Agent");
  const subAction = pathParts[3];
  const sessionHash = user.sessionId ? await generateSessionHash(user.sessionId, user.id) : null;

  // GET /api/account/passkeys — 列出当前用户的所有通行密钥
  if (!subAction && request.method === "GET") {
    const passkeys = await passkeyModel.listByUser(user.id);
    return new Response(JSON.stringify(passkeys), {
      headers: { "Content-Type": "application/json" }
    });
  }

  // POST /api/account/passkeys/auth-options — 生成已登录用户的通行密钥认证选项与挑战
  if (subAction === "auth-options" && request.method === "POST") {
    const existingPasskeys = await passkeyModel.listByUser(user.id);
    if (existingPasskeys.length === 0) {
      return new Response("No passkeys registered", { status: 400 });
    }

    let targetPasskeyId: string | undefined;
    try {
      if (request.headers.get("content-type")?.includes("application/json")) {
        const body = (await request.json()) as { passkeyId?: string };
        targetPasskeyId = body?.passkeyId;
      }
    } catch {
      // ignore empty or non-json body
    }

    const availablePasskeys = targetPasskeyId
      ? existingPasskeys.filter((p) => p.id === targetPasskeyId)
      : existingPasskeys;

    if (availablePasskeys.length === 0) {
      return new Response("Target passkey not found", { status: 404 });
    }

    const challenge = generateWebAuthnChallenge();
    const requestUrl = new URL(request.url);
    const rpId = requestUrl.hostname;
    const purpose = targetPasskeyId ? "test" : "reauth";
    const cache = (caches as any).default;
    await cacheUtils.set(cache, `webauthn_auth_challenge:${user.id}`, {
      challenge,
      rpId,
      sessionId: user.sessionId,
      purpose
    }, 300);

    const options = {
      challenge,
      rpId,
      timeout: 60000,
      userVerification: "preferred",
      allowCredentials: availablePasskeys.map((p) => ({
        id: p.credential_id,
        passkey_id: p.id,
        type: "public-key",
        transports: p.transports ? JSON.parse(p.transports) : undefined
      }))
    };

    return new Response(JSON.stringify(options), {
      headers: { "Content-Type": "application/json" }
    });
  }

  // POST /api/account/passkeys/test — 验证通行密钥测试
  if (subAction === "test" && request.method === "POST") {
    const cache = (caches as any).default;
    const challengeKey = `webauthn_auth_challenge:${user.id}`;
    const cachedState = await cacheUtils.get<{
      challenge: string;
      rpId: string;
      sessionId?: string;
      purpose?: string;
    }>(cache, challengeKey);
    if (!cachedState) {
      return new Response("Test session expired, please try again", { status: 400 });
    }
    if (cachedState.purpose === "reauth" || (cachedState.sessionId && user.sessionId && cachedState.sessionId !== user.sessionId)) {
      return new Response("Test session mismatch, please try again", { status: 400 });
    }

    const body = (await request.json()) as {
      credential?: any;
      passkeyAssertion?: any;
      id?: string;
      response?: any;
    };
    const assertion = body.credential || body.passkeyAssertion || body;
    if (!assertion || !assertion.response || !assertion.id) {
      return new Response("Invalid credential data", { status: 400 });
    }

    const userPasskeys = await passkeyModel.listByUser(user.id);
    const passkey = userPasskeys.find((p) => p.credential_id === assertion.id);
    if (!passkey) {
      await cacheUtils.delete(cache, challengeKey);
      return new Response("Passkey not recognized for this account", { status: 404 });
    }

    const requestUrl = new URL(request.url);
    try {
      const { signCount } = await verifyAuthenticationResponse({
        clientDataJSON: assertion.response.clientDataJSON,
        authenticatorData: assertion.response.authenticatorData,
        signature: assertion.response.signature,
        publicKeySpki: passkey.public_key,
        algorithm: passkey.algorithm,
        expectedChallenge: cachedState.challenge,
        expectedOrigin: `${requestUrl.protocol}//${requestUrl.host}`,
        expectedRpId: cachedState.rpId,
        previousSignCount: passkey.sign_count
      });

      await passkeyModel.updateUsage(passkey.id, signCount);
      await cacheUtils.delete(cache, challengeKey);
      await activityLog.record(
        user.id,
        "passkey_verify_success",
        clientIp,
        userAgent,
        { flow: "mfa_test", name: passkey.name, id: passkey.id },
        sessionHash
      );

      return new Response(
        JSON.stringify({
          success: true,
          passkey: {
            id: passkey.id,
            name: passkey.name
          }
        }),
        {
          headers: { "Content-Type": "application/json" }
        }
      );
    } catch (err: any) {
      await cacheUtils.delete(cache, challengeKey);
      await activityLog.record(
        user.id,
        "passkey_verify_fail",
        clientIp,
        userAgent,
        { flow: "mfa_test", name: passkey.name, id: passkey.id, error: err.message || "failed" },
        sessionHash
      );
      console.warn("[Passkey Test] Verification failed:", err.message || err);
      return new Response("Passkey verification failed", { status: 400 });
    }
  }

  // POST /api/account/passkeys/register/options — 生成通行密钥注册挑战与参数
  if (subAction === "register" && pathParts[4] === "options" && request.method === "POST") {
    const existingPasskeys = await passkeyModel.listByUser(user.id);
    const challenge = generateWebAuthnChallenge();
    const requestUrl = new URL(request.url);
    const rpId = requestUrl.hostname;
    const cache = (caches as any).default;
    await cacheUtils.set(cache, `webauthn_reg_challenge:${user.id}`, { challenge, rpId }, 300);

    const dbUser = await userModel.getById(user.id);
    const username = dbUser?.username || user.username || "";
    const userDisplayName = username ? `${username} (${rpId})` : rpId;

    const options = {
      challenge,
      rp: {
        name: rpId,
        id: rpId
      },
      user: {
        id: base64UrlEncode(new TextEncoder().encode(user.id)),
        name: username || rpId,
        displayName: userDisplayName
      },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 }, // ES256
        { type: "public-key", alg: -257 } // RS256
      ],
      authenticatorSelection: {
        userVerification: "preferred",
        residentKey: "preferred"
      },
      timeout: 60000,
      excludeCredentials: existingPasskeys.map((p) => ({
        id: p.credential_id,
        type: "public-key",
        transports: p.transports ? JSON.parse(p.transports) : undefined
      }))
    };

    return new Response(JSON.stringify(options), {
      headers: { "Content-Type": "application/json" }
    });
  }

  // POST /api/account/passkeys/register/verify — 验证注册响应并保存通行密钥
  if (subAction === "register" && pathParts[4] === "verify" && request.method === "POST") {
    const cache = (caches as any).default;
    const cachedState = await cacheUtils.get<{ challenge: string; rpId: string }>(cache, `webauthn_reg_challenge:${user.id}`);
    if (!cachedState) {
      return new Response("Registration session expired, please try again", { status: 400 });
    }
    await cacheUtils.delete(cache, `webauthn_reg_challenge:${user.id}`);

    const body = (await request.json()) as ReauthPayload & { name?: string; credential?: any };
    const { name, credential } = body;
    if (!credential || !credential.response) {
      return new Response("Invalid credential data", { status: 400 });
    }

    const dbUserBefore = await userModel.getById(user.id);
    if (!dbUserBefore) return new Response("User not found", { status: 404 });
    const existingPasskeysBefore = await passkeyModel.listByUser(user.id);
    // Require step-up reauth when adding a passkey to an account that already has MFA enabled
    if (dbUserBefore.totp_enabled || existingPasskeysBefore.length > 0) {
      const authResult = await verifyUserReauth(dbUserBefore, body, env, request, { sessionId: user.sessionId });
      if (!authResult.success) {
        return new Response(authResult.error || "Re-authentication required", { status: 403 });
      }
    }

    const requestUrl = new URL(request.url);
    const expectedOrigin = `${requestUrl.protocol}//${requestUrl.host}`;
    try {
      const parsed = await verifyRegistrationResponse({
        clientDataJSON: credential.response.clientDataJSON,
        attestationObject: credential.response.attestationObject,
        expectedChallenge: cachedState.challenge,
        expectedOrigin,
        expectedRpId: cachedState.rpId
      });

      // Check if credential ID is already registered
      const existing = await passkeyModel.getByCredentialId(parsed.credentialId);
      if (existing) {
        return new Response("This passkey is already registered", { status: 409 });
      }

      const passkeyName = (name || "").trim();
      if (!PASSKEY_NAME_REGEX.test(passkeyName)) {
        return new Response("Invalid Passkey name format", { status: 400 });
      }
      const transports = Array.isArray(credential.response.transports) ? credential.response.transports : undefined;

      const created = await passkeyModel.create({
        userId: user.id,
        name: passkeyName,
        credentialId: parsed.credentialId,
        publicKey: parsed.publicKeySpki,
        algorithm: parsed.algorithm,
        signCount: parsed.signCount,
        transports,
        aaguid: parsed.aaguid
      });

      // Only keep existing passwordless setting; do not silently downgrade password requirement
      // without explicit user opt-in via /api/account/mfa/settings (which enforces reauth).
      await userModel.updateTOTPSettings(user.id, !!dbUserBefore.totp_skip_password);

      const dbUser = await userModel.getById(user.id);
      let recoveryKeys: string[] = [];
      if (dbUser) {
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

        // Only generate emergency recovery keys if the account does not already have recovery keys configured.
        // Existing recovery keys (hashed or envelope-encrypted) must never be overwritten on passkey addition.
        if (!hasExistingRecoveryKeys) {
          const plaintextKeys = generateRecoveryKeys();
          const storedItems: StoredRecoveryKey[] = await Promise.all(
            plaintextKeys.map(async (k) => ({
              hash: await hashRecoveryKey(k)
            }))
          );
          await userModel.updateRecoveryKeys(user.id, storedItems);
          recoveryKeys = plaintextKeys;
        }
      }

      await activityLog.record(user.id, "passkey_registered", clientIp, userAgent, { name: passkeyName }, sessionHash);
      return new Response(
        JSON.stringify({
          ...created,
          recovery_keys: recoveryKeys.length > 0 ? recoveryKeys : undefined
        }),
        {
          status: 201,
          headers: { "Content-Type": "application/json" }
        }
      );
    } catch (err: any) {
      console.warn("[Passkey Registration] Verification failed:", err.message || err);
      return new Response("Passkey registration failed", { status: 400 });
    }
  }

  // PATCH /api/account/passkeys/:id — 重命名通行密钥
  if (subAction && request.method === "PATCH") {
    const passkeyId = subAction;
    const { name } = (await request.json()) as { name?: string };
    const trimmedName = (name || "").trim();
    if (!trimmedName || !PASSKEY_NAME_REGEX.test(trimmedName)) {
      return new Response("Invalid Passkey name format", { status: 400 });
    }

    const passkey = await passkeyModel.getById(passkeyId, user.id);
    if (!passkey) return new Response("Passkey not found", { status: 404 });

    const success = await passkeyModel.updateName(passkeyId, user.id, trimmedName);
    return new Response(JSON.stringify({ success }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  // DELETE /api/account/passkeys/:id — 删除通行密钥 (enforcing step-up reauthentication)
  if (subAction && request.method === "DELETE") {
    const passkeyId = subAction;
    const passkey = await passkeyModel.getById(passkeyId, user.id);
    if (!passkey) return new Response("Passkey not found", { status: 404 });

    const dbUser = await userModel.getById(user.id);
    if (!dbUser) return new Response("User not found", { status: 404 });

    let body: ReauthPayload = {};
    try {
      if (request.headers.get("content-type")?.includes("application/json")) {
        body = (await request.json()) as ReauthPayload;
      }
    } catch {}

    const authResult = await verifyUserReauth(dbUser, body, env, request, { sessionId: user.sessionId });
    if (!authResult.success) {
      await activityLog.record(user.id, "passkey_verify_fail", clientIp, userAgent, { reason: authResult.reason }, sessionHash);
      return new Response(authResult.error || "Authentication failed", { status: 400 });
    }

    await passkeyModel.delete(passkeyId, user.id);
    try {
      await env.DB.prepare("DELETE FROM user_passkey_wrapped_keys WHERE passkey_id = ?").bind(passkeyId).run();
    } catch {
      // Ignore if E2EE wrapped key table is unavailable or already cascaded
    }
    await activityLog.record(user.id, "passkey_deleted", clientIp, userAgent, { name: passkey.name, method: authResult.method }, sessionHash);

    // Re-read fresh user record after deletion to prevent stale totp_enabled race
    const freshUser = await userModel.getById(user.id);
    const remainingPasskeys = await passkeyModel.countByUser(user.id);
    if (remainingPasskeys === 0 && !freshUser?.totp_enabled) {
      await userModel.updateTOTPSettings(user.id, false);
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  return new Response("Not Found", { status: 404 });
}

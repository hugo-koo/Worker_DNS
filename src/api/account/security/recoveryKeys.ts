import { Env, User, ExecutionContext } from "../../../types";
import { generateSessionHash } from "../../../utils/crypto";
import { UserModel } from "../../../models/user";
import { ActivityLogModel } from "../../../models/activityLog";
import { generateRecoveryKey, hashRecoveryKey, StoredRecoveryKeyItem } from "../../../lib/totp";
import { verifyUserReauth, ReauthPayload } from "./reauth";

/**
 * Handles emergency recovery keys management endpoints:
 * - POST /api/account/recovery-keys/view (re-authenticate and view decrypted recovery keys)
 * - POST /api/account/recovery-keys/rotate (re-authenticate and rotate recovery keys)
 *
 * @param request - Inbound HTTP Request.
 * @param env - Cloudflare Worker environment bindings.
 * @param user - Current authenticated user.
 * @param pathParts - URL pathname components.
 * @param ctx - Execution context.
 * @returns Response indicating operation outcome.
 */
export async function handleRecoveryKeysRequest(
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
  const subAction = pathParts[3];
  const sessionHash = user.sessionId ? await generateSessionHash(user.sessionId, user.id) : null;

  // POST /api/account/recovery-keys/view — 安全核验后解密查看恢复密钥
  if (subAction === "view" && request.method === "POST") {
    const body = (await request.json()) as ReauthPayload;
    const dbUser = await userModel.getById(user.id);
    if (!dbUser) return new Response("User not found", { status: 404 });

    const authResult = await verifyUserReauth(dbUser, body, env, request);
    if (!authResult.success) {
      return new Response(authResult.error || "Authentication failed", { status: 400 });
    }

    if (!dbUser.totp_recovery_keys) {
      return new Response(
        JSON.stringify({
          has_keys: false,
          is_legacy: false,
          recovery_keys: []
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    let parsed: any = null;
    try {
      parsed = typeof dbUser.totp_recovery_keys === "string"
        ? JSON.parse(dbUser.totp_recovery_keys)
        : dbUser.totp_recovery_keys;
    } catch {
      parsed = [dbUser.totp_recovery_keys];
    }

    if (!Array.isArray(parsed)) {
      parsed = [parsed];
    }

    const keys: string[] = [];
    let isLegacy = false;
    for (const item of parsed) {
      if (typeof item === "object" && item?.key) {
        keys.push(item.key);
      } else if (typeof item === "string") {
        if (/^[a-fA-F0-9]{64}$/.test(item.trim())) {
          isLegacy = true;
        } else {
          keys.push(item);
        }
      }
    }

    return new Response(
      JSON.stringify({
        has_keys: keys.length > 0 || isLegacy,
        is_legacy: isLegacy && keys.length === 0,
        recovery_keys: keys
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  // POST /api/account/recovery-keys/rotate — 安全核验后轮换恢复密钥
  if (subAction === "rotate" && request.method === "POST") {
    const body = (await request.json()) as ReauthPayload;
    const dbUser = await userModel.getById(user.id);
    if (!dbUser) return new Response("User not found", { status: 404 });

    const authResult = await verifyUserReauth(dbUser, body, env, request);
    if (!authResult.success) {
      return new Response(authResult.error || "Authentication failed", { status: 400 });
    }

    const plaintextKey = generateRecoveryKey();
    const hashedKey = await hashRecoveryKey(plaintextKey);
    const newItems: StoredRecoveryKeyItem[] = [{ key: plaintextKey, hash: hashedKey }];

    await userModel.updateRecoveryKeys(user.id, newItems);
    await activityLog.record(user.id, "recovery_key_rotated" as any, clientIp, userAgent, { method: authResult.method }, sessionHash);

    return new Response(
      JSON.stringify({
        success: true,
        recovery_key: plaintextKey
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  return new Response("Not Found", { status: 404 });
}

import { Env } from "../../../types";
import { verifyPassword } from "../../../utils/crypto";
import { verifyTOTPWithStep, findMatchingRecoveryKey } from "../../../lib/totp";
import { PasskeyModel } from "../../../models/passkey";
import { UserModel } from "../../../models/user";
import { verifyAuthenticationResponse } from "../../../lib/webauthn";
import { cacheUtils } from "../../../utils/cache";
import { isDemoMode, isDemoPasskeyCredentialId } from "../../../lib/demoConfig";

export interface ReauthPayload {
  password?: string;
  oldPassword?: string;
  totpTokenHash?: string;
  totpSalt?: string;
  passkeyAssertion?: any;
  recoveryKey?: string;
}

export interface ReauthOptions {
  /** Session ID of the authenticated caller for step-up challenge binding. */
  sessionId?: string;
}

export interface ReauthResult {
  success: boolean;
  method?: "password" | "totp" | "passkey" | "recovery_key";
  error?: string;
  reason?: string;
}

/**
 * Re-authenticates the current user using Passkey, TOTP, Recovery Key, or Current Password.
 * Enforces MFA whenever the account has TOTP or Passkeys enabled (password alone is rejected),
 * tracks per-user failed attempts, enforces TOTP anti-replay, consumes recovery keys,
 * and binds WebAuthn challenges to the caller's session and step-up purpose.
 *
 * @param dbUser - Target database user record containing credentials.
 * @param payload - Inbound client re-authentication payload.
 * @param env - Cloudflare Worker environment bindings.
 * @param request - Current HTTP request for origin and header resolution.
 * @param options - Optional context such as caller sessionId.
 * @returns Verification result detailing success status, authentication method, and failure reasons.
 */
export async function verifyUserReauth(
  dbUser: any,
  payload: ReauthPayload,
  env: Env,
  request: Request,
  options?: ReauthOptions
): Promise<ReauthResult> {
  const cache = (caches as any).default;
  const rateLimitKey = `reauth_fail:${dbUser.id}`;
  if (await cacheUtils.isRateLimited(cache, rateLimitKey, 10, 900)) {
    return {
      success: false,
      error: "Too many failed re-authentication attempts. Please try again later.",
      reason: "reauth_rate_limited"
    };
  }

  const passkeyModel = new PasskeyModel(env.DB);
  const allUserPasskeys = await passkeyModel.listByUser(dbUser.id);
  const userPasskeys = isDemoMode(env)
    ? allUserPasskeys.filter((p) => !isDemoPasskeyCredentialId(p.credential_id))
    : allUserPasskeys;
  const hasPasskeys = userPasskeys.length > 0;
  const hasTotp = !!dbUser.totp_enabled && !!dbUser.totp_secret;
  const hasMfa = hasTotp || hasPasskeys;

  // 1. Passkey assertion check
  if (payload.passkeyAssertion) {
    const challengeKey = `webauthn_auth_challenge:${dbUser.id}`;
    const cachedState = await cacheUtils.get<{
      challenge: string;
      rpId: string;
      sessionId?: string;
      purpose?: string;
    }>(cache, challengeKey);
    if (!cachedState) {
      return { success: false, error: "Passkey session expired, please try again", reason: "passkey_session_expired" };
    }
    if (cachedState.purpose === "test") {
      return { success: false, error: "Passkey challenge purpose mismatch", reason: "passkey_purpose_mismatch" };
    }
    if (cachedState.sessionId && options?.sessionId && cachedState.sessionId !== options.sessionId) {
      return { success: false, error: "Passkey challenge does not match active session", reason: "passkey_session_mismatch" };
    }

    const passkey = userPasskeys.find((p) => p.credential_id === payload.passkeyAssertion.id);
    if (!passkey) {
      await cacheUtils.delete(cache, challengeKey);
      return { success: false, error: "Passkey not found", reason: "passkey_not_found" };
    }

    const requestUrl = new URL(request.url);
    try {
      const { signCount } = await verifyAuthenticationResponse({
        clientDataJSON: payload.passkeyAssertion.response.clientDataJSON,
        authenticatorData: payload.passkeyAssertion.response.authenticatorData,
        signature: payload.passkeyAssertion.response.signature,
        publicKeySpki: passkey.public_key,
        algorithm: passkey.algorithm,
        expectedChallenge: cachedState.challenge,
        expectedOrigin: `${requestUrl.protocol}//${requestUrl.host}`,
        expectedRpId: cachedState.rpId,
        previousSignCount: passkey.sign_count,
        requireUserVerification: !!dbUser.totp_skip_password || !(payload.oldPassword || payload.password)
      });

      await passkeyModel.updateUsage(passkey.id, signCount);
      await cacheUtils.delete(cache, challengeKey);
      await cacheUtils.delete(cache, `ratelimit:${rateLimitKey}`);
      return { success: true, method: "passkey" };
    } catch {
      // Consume the challenge on failure to prevent brute-force or cross-flow replay
      await cacheUtils.delete(cache, challengeKey);
      return { success: false, error: "Invalid Passkey signature", reason: "invalid_passkey" };
    }
  }

  // 2. TOTP token hash check (with unified anti-replay protection)
  if (payload.totpTokenHash) {
    if (!hasTotp) {
      return { success: false, error: "TOTP is not enabled", reason: "totp_not_enabled" };
    }
    const totpResult = await verifyTOTPWithStep(dbUser.totp_secret, payload.totpTokenHash, payload.totpSalt);
    if (!totpResult.valid) {
      return { success: false, error: "Invalid TOTP code", reason: "invalid_totp" };
    }
    if (totpResult.timeStep !== undefined) {
      const replayKey = `totp_used:${dbUser.id}:${totpResult.timeStep}`;
      if (await cacheUtils.get(cache, replayKey)) {
        return {
          success: false,
          error: "TOTP code has already been used. Please wait for the next 30-second code.",
          reason: "totp_replay_blocked"
        };
      }
      await cacheUtils.set(cache, replayKey, 1, 90);
    }
    await cacheUtils.delete(cache, `ratelimit:${rateLimitKey}`);
    return { success: true, method: "totp" };
  }

  // 3. Recovery Key check (strictly single-use: consumed upon verification)
  if (payload.recoveryKey) {
    let storedHashes: any[] = [];
    try {
      storedHashes = typeof dbUser.totp_recovery_keys === "string"
        ? JSON.parse(dbUser.totp_recovery_keys)
        : dbUser.totp_recovery_keys || [];
      if (!Array.isArray(storedHashes)) storedHashes = [storedHashes];
    } catch {}
    const matchIndex = await findMatchingRecoveryKey(payload.recoveryKey, storedHashes);
    if (matchIndex === -1) {
      return { success: false, error: "Invalid Recovery Key", reason: "invalid_recovery_key" };
    }
    const userModel = new UserModel(env.DB, env);
    await userModel.consumeRecoveryKey(dbUser.id, matchIndex, storedHashes);
    await cacheUtils.delete(cache, `ratelimit:${rateLimitKey}`);
    return { success: true, method: "recovery_key" };
  }

  // 4. Password check (oldPassword or password) — rejected alone when MFA is enabled or password is unset
  const pwd = payload.oldPassword || payload.password;
  if (pwd) {
    if (dbUser.has_password === 0) {
      return {
        success: false,
        error: "Password is not configured for this account",
        reason: "password_not_set"
      };
    }
    if (hasMfa) {
      return {
        success: false,
        error: "MFA verification (Passkey, TOTP, or Recovery Key) is required for this account",
        reason: "mfa_required"
      };
    }
    const valid = await verifyPassword(pwd, dbUser.hashed_password, dbUser.password_version ?? 1);
    if (!valid) {
      return { success: false, error: "Current password is incorrect", reason: "wrong_current_password" };
    }
    await cacheUtils.delete(cache, `ratelimit:${rateLimitKey}`);
    return { success: true, method: "password" };
  }

  return { success: false, error: "Authentication required (Passkey, Recovery Key, or Password)", reason: "no_credentials_provided" };
}

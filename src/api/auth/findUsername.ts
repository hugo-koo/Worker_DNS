import { Env, Passkey } from "../../types";
import { PasskeyModel } from "../../models/passkey";
import { ActivityLogModel } from "../../models/activityLog";
import { SystemSettingsModel } from "../../models/systemSettings";
import { cacheUtils } from "../../utils/cache";
import { generateId } from "../../utils/crypto";
import { verifyTurnstile } from "./utils";
import { withTokenLock } from "../../lib/preauth";
import { generateWebAuthnChallenge, verifyAuthenticationResponse } from "../../lib/webauthn";

interface FindUsernameChallengeState {
  challenge: string;
  rpId: string;
}

interface FindUsernameOptionsRequest {
  turnstileToken?: string | null;
}

interface PasskeyAssertionResponsePayload {
  clientDataJSON?: string;
  authenticatorData?: string;
  signature?: string;
  userHandle?: string | null;
}

interface PasskeyAssertionPayload {
  id?: string;
  rawId?: string;
  response?: PasskeyAssertionResponsePayload;
}

interface FindUsernameVerifyRequest {
  challengeToken?: string;
  passkeyAssertion?: PasskeyAssertionPayload;
}

export interface FoundUsernameAccount {
  userId: string;
  username: string;
  passkeyName: string;
}

/**
 * Queries minimal public user identity fields for a set of verified user IDs.
 * Chunks ID batches to stay well within D1 SQLite parameter limits.
 *
 * @param db - D1 database binding.
 * @param userIds - List of verified user IDs.
 * @returns Map from user ID to `{ id, username }`.
 */
async function loadUsersByIds(
  db: Env["DB"],
  userIds: string[]
): Promise<Map<string, { id: string; username: string }>> {
  const userMap = new Map<string, { id: string; username: string }>();
  const uniqueIds = Array.from(new Set(userIds));
  const CHUNK_SIZE = 50;

  for (let i = 0; i < uniqueIds.length; i += CHUNK_SIZE) {
    const chunk = uniqueIds.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    const { results } = await db
      .prepare(`SELECT id, username FROM users WHERE id IN (${placeholders})`)
      .bind(...chunk)
      .all<{ id: string; username: string }>();

    for (const row of results || []) {
      userMap.set(row.id, row);
    }
  }

  return userMap;
}

/**
 * Handles the 2-step Passkey-based Find Username flow (supporting many-to-many
 * bindings between Passkey credential IDs and user accounts):
 * 1. POST /api/auth/find-username/options — check Turnstile/rate limit and issue WebAuthn challenge
 * 2. POST /api/auth/find-username/verify  — verify Passkey assertion and return all matching usernames
 *
 * @param request - Inbound HTTP Request.
 * @param env - Cloudflare Worker environment bindings.
 * @returns JSON or text HTTP Response.
 */
export async function handleFindUsernameRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const cache = (caches as unknown as { default: Cache }).default;
  const clientIp = request.headers.get("CF-Connecting-IP") || "127.0.0.1";
  const userAgent = request.headers.get("User-Agent");

  // Step 1: Issue WebAuthn discoverable challenge
  if (path === "/api/auth/find-username/options" && request.method === "POST") {
    if (await cacheUtils.isRateLimited(cache, `find_username_ip:${clientIp}`, 10, 600)) {
      return new Response("Too many attempts", { status: 429 });
    }

    let body: FindUsernameOptionsRequest = {};
    try {
      if (request.headers.get("content-type")?.includes("application/json")) {
        body = (await request.json()) as FindUsernameOptionsRequest;
      }
    } catch {
      return new Response("Invalid request body", { status: 400 });
    }

    const settingsModel = new SystemSettingsModel(env.DB);
    const [secretKey, enabled] = await Promise.all([
      settingsModel.get("turnstile_secret_key"),
      settingsModel.get("turnstile_enabled_login")
    ]);
    const effectiveSecret = secretKey || env.TURNSTILE_SECRET_KEY || "";
    if (enabled === "true") {
      if (!effectiveSecret) {
        return new Response("Turnstile verification is enabled but secret key is not configured", { status: 503 });
      }
      if (!(await verifyTurnstile(body.turnstileToken || "", effectiveSecret, clientIp))) {
        return new Response("Verification failed", { status: 400 });
      }
    }

    const challenge = generateWebAuthnChallenge();
    const challengeToken = generateId(32);
    const rpId = url.hostname;

    await cacheUtils.set(
      cache,
      `find_username_challenge:${challengeToken}`,
      { challenge, rpId } satisfies FindUsernameChallengeState,
      180
    );

    return new Response(
      JSON.stringify({
        challengeToken,
        challenge,
        rpId,
        timeout: 60000,
        userVerification: "preferred"
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );
  }

  // Step 2: Verify Passkey signature and return all associated accounts
  if (path === "/api/auth/find-username/verify" && request.method === "POST") {
    if (await cacheUtils.isRateLimited(cache, `find_username_verify_ip:${clientIp}`, 15, 600)) {
      return new Response("Too many attempts", { status: 429 });
    }

    let body: FindUsernameVerifyRequest;
    try {
      body = (await request.json()) as FindUsernameVerifyRequest;
    } catch {
      return new Response("Invalid request body", { status: 400 });
    }

    const challengeToken = typeof body.challengeToken === "string" ? body.challengeToken.trim() : "";
    const assertion = body.passkeyAssertion;
    const credentialId = assertion?.id || assertion?.rawId || "";
    const assertionResponse = assertion?.response;

    if (
      !challengeToken ||
      !credentialId ||
      !assertionResponse?.clientDataJSON ||
      !assertionResponse?.authenticatorData ||
      !assertionResponse?.signature
    ) {
      return new Response("Invalid request parameters", { status: 400 });
    }

    const clientDataJSON = assertionResponse.clientDataJSON;
    const authenticatorData = assertionResponse.authenticatorData;
    const signature = assertionResponse.signature;

    return withTokenLock(`find_username:${challengeToken}`, async () => {
      const challengeKey = `find_username_challenge:${challengeToken}`;
      const state = await cacheUtils.get<FindUsernameChallengeState>(cache, challengeKey);
      if (!state) {
        return new Response("Challenge expired, please try again", { status: 400 });
      }
      // Single-use challenge: consume immediately to prevent replay
      await cacheUtils.delete(cache, challengeKey);

      const passkeyModel = new PasskeyModel(env.DB);
      const activityLog = new ActivityLogModel(env.DB);
      const matchedPasskeys = await passkeyModel.listByCredentialId(credentialId);

      if (matchedPasskeys.length === 0) {
        return new Response("No account found for this Passkey", { status: 404 });
      }

      // Verify all candidate bindings BEFORE mutating any sign_count in D1,
      // so shared credentials never fail monotonic checks against an already-updated sibling row.
      const verifiedEntries: Array<{ passkey: Passkey; signCount: number }> = [];
      let lastVerifyError = "Passkey verification failed";

      for (const pk of matchedPasskeys) {
        try {
          const { signCount } = await verifyAuthenticationResponse({
            clientDataJSON,
            authenticatorData,
            signature,
            publicKeySpki: pk.public_key,
            algorithm: pk.algorithm,
            expectedChallenge: state.challenge,
            expectedOrigin: `${url.protocol}//${url.host}`,
            expectedRpId: state.rpId,
            previousSignCount: pk.sign_count
          });
          verifiedEntries.push({ passkey: pk, signCount });
        } catch (err: unknown) {
          lastVerifyError = err instanceof Error ? err.message : String(err);
        }
      }

      if (verifiedEntries.length === 0) {
        const failedUserIds = Array.from(new Set(matchedPasskeys.map((pk) => pk.user_id)));
        await Promise.all(
          failedUserIds.map((uid) =>
            activityLog.record(uid, "passkey_verify_fail", clientIp, userAgent, {
              flow: "find_username",
              error: lastVerifyError
            })
          )
        );
        return new Response("Passkey verification failed", { status: 400 });
      }

      const userMap = await loadUsersByIds(
        env.DB,
        verifiedEntries.map((entry) => entry.passkey.user_id)
      );

      const seenUserIds = new Set<string>();
      const accounts: FoundUsernameAccount[] = [];
      const postVerifyUpdates: Array<Promise<unknown>> = [];

      for (const entry of verifiedEntries) {
        const dbUser = userMap.get(entry.passkey.user_id);
        if (!dbUser) continue;

        // Update usage on all verified bindings (without double-syncing inside loop)
        postVerifyUpdates.push(passkeyModel.updateUsage(entry.passkey.id, entry.signCount, false));

        if (!seenUserIds.has(dbUser.id)) {
          seenUserIds.add(dbUser.id);
          accounts.push({
            userId: dbUser.id,
            username: dbUser.username,
            passkeyName: entry.passkey.name
          });
          postVerifyUpdates.push(
            activityLog.record(dbUser.id, "passkey_verify_success", clientIp, userAgent, {
              flow: "find_username",
              passkeyName: entry.passkey.name
            })
          );
        }
      }

      await Promise.all(postVerifyUpdates);

      if (accounts.length === 0) {
        return new Response("No account found for this Passkey", { status: 404 });
      }

      accounts.sort((a, b) => a.username.localeCompare(b.username));

      return new Response(
        JSON.stringify({
          success: true,
          accounts
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      );
    });
  }

  return new Response("Not Found", { status: 404 });
}

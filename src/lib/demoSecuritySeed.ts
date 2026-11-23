import type { Env, Passkey, Profile } from "../types";
import { PasskeyModel } from "../models/passkey";
import { DEMO_PASSKEY_PREFIX, DEMO_PASSKEY_SPECS, isDemoPasskeyCredentialId } from "./demoConfig";
import { generatePqcLogKeyPair } from "./crypto/e2ee/pqc";

/**
 * Generates deterministic Base64 bytes of fixed length for synthetic Demo wrapped keys
 * so DB rows satisfy non-empty cryptographic field invariants without storing secrets.
 */
function buildSyntheticBase64(seedLabel: string, byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  for (let i = 0; i < byteLength; i++) {
    const code = seedLabel.charCodeAt(i % seedLabel.length);
    bytes[i] = (code + i * 31) & 0xff;
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Seeds the canonical Demo Passkeys (iCloud Keychain, Google Password Manager,
 * Windows Hello, YubiKey) idempotently for a Demo user account.
 *
 * @param env - Worker environment bindings
 * @param userId - Demo user ID
 * @returns Complete passkey list for the user after seeding
 */
export async function ensureDemoPasskeys(env: Env, userId: string): Promise<Passkey[]> {
  const passkeyModel = new PasskeyModel(env.DB);
  let passkeys = await passkeyModel.listByUser(userId);
  const existingCredentialIds = new Set(passkeys.map((pk) => pk.credential_id));
  const nowSec = Math.floor(Date.now() / 1000);

  let createdAny = false;
  for (const spec of DEMO_PASSKEY_SPECS) {
    const credentialId = `${DEMO_PASSKEY_PREFIX}${userId}-${spec.idSuffix}`;
    if (existingCredentialIds.has(credentialId)) {
      continue;
    }

    const created = await passkeyModel.create({
      userId,
      name: spec.name,
      credentialId,
      publicKey: buildSyntheticBase64(credentialId, 65),
      algorithm: spec.algorithm,
      signCount: spec.signCount,
      transports: [...spec.transports],
      aaguid: spec.aaguid,
    });

    const createdAt = Math.max(1, nowSec - spec.createdOffsetSec);
    const lastUsedAt = Math.max(createdAt, nowSec - spec.lastUsedOffsetSec);
    await env.DB.prepare(
      "UPDATE passkeys SET created_at = ?, last_used_at = ? WHERE id = ?"
    )
      .bind(createdAt, lastUsedAt, created.id)
      .run();

    createdAny = true;
  }

  if (createdAny) {
    passkeys = await passkeyModel.listByUser(userId);
  }

  // Enable Passwordless Login by default for Demo accounts showcasing Passkeys
  const onlyDemoPasskeys =
    passkeys.length > 0 && passkeys.every((pk) => isDemoPasskeyCredentialId(pk.credential_id));
  if (createdAny || onlyDemoPasskeys) {
    await env.DB.prepare(
      "UPDATE users SET totp_skip_password = 1 WHERE id = ? AND COALESCE(totp_skip_password, 0) = 0"
    )
      .bind(userId)
      .run();
  }

  return passkeys;
}

/**
 * Enables Post-Quantum E2EE (`P256-MLKEM768`) idempotently across all Demo user profiles
 * and links wrapped key entries for every Demo passkey and recovery fallback.
 *
 * Preserves existing configuration if the Demo user already has `user_log_keys` rows
 * (for example, if toggled off during an interactive demo session), while still
 * backfilling any newly added Demo passkey wrappers.
 *
 * @param env - Worker environment bindings
 * @param profiles - User's profiles (primary profile listed first or included)
 * @param passkeys - User's current passkeys (including seeded Demo passkeys)
 */
export async function ensureDemoE2ee(
  env: Env,
  profiles: Profile[],
  passkeys: Passkey[]
): Promise<void> {
  if (profiles.length === 0) {
    return;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const primaryProfile = profiles[0];
  const profileIds = profiles.map((p) => p.id);
  const placeholders = profileIds.map(() => "?").join(", ");

  const existingKeysResult = await env.DB.prepare(
    `SELECT profile_id, public_key FROM user_log_keys WHERE profile_id IN (${placeholders})`
  )
    .bind(...profileIds)
    .all<{ profile_id: string; public_key: string }>();

  const existingKeyProfiles = new Set(
    (existingKeysResult.results || []).map((r) => r.profile_id)
  );

  // Only generate a fresh PQC keypair and enable E2EE if this user has no E2EE keys yet
  if (existingKeyProfiles.size === 0) {
    const pqcPair = generatePqcLogKeyPair();
    const publicKeyJson = JSON.stringify({
      alg: "P256-MLKEM768",
      pqc_pk: pqcPair.publicKeyBase64,
    });
    const keyCreatedAt = Math.max(1, nowSec - 18 * 86400);

    const statements: D1PreparedStatement[] = [];
    for (const profile of profiles) {
      statements.push(
        env.DB.prepare(
          "INSERT INTO user_log_keys (profile_id, public_key, created_at, is_active) VALUES (?, ?, ?, 1) ON CONFLICT(profile_id) DO NOTHING"
        ).bind(profile.id, publicKeyJson, keyCreatedAt)
      );
      statements.push(
        env.DB.prepare(
          "INSERT INTO user_recovery_wrapped_keys (profile_id, encrypted_sk, iv, salt, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(profile_id) DO NOTHING"
        ).bind(
          profile.id,
          buildSyntheticBase64(`demo-rec-sk-${profile.id}`, 64),
          buildSyntheticBase64(`demo-rec-iv-${profile.id}`, 12),
          buildSyntheticBase64(`demo-rec-salt-${profile.id}`, 16),
          keyCreatedAt
        )
      );
    }

    if (statements.length > 0) {
      await env.DB.batch(statements);
    }
  } else if (existingKeysResult.results && existingKeysResult.results.length > 0) {
    // Replicate active public_key to any profile missing a row, matching core profile creation semantics
    const referencePublicKey = existingKeysResult.results[0].public_key;
    const missingStatements: D1PreparedStatement[] = [];
    for (const profile of profiles) {
      if (!existingKeyProfiles.has(profile.id)) {
        missingStatements.push(
          env.DB.prepare(
            "INSERT INTO user_log_keys (profile_id, public_key, created_at, is_active) VALUES (?, ?, ?, 1) ON CONFLICT(profile_id) DO NOTHING"
          ).bind(profile.id, referencePublicKey, nowSec)
        );
      }
    }
    if (missingStatements.length > 0) {
      await env.DB.batch(missingStatements);
    }
  }

  // Ensure every Demo passkey has a wrapped key entry bound to the primary profile
  const demoPasskeys = passkeys.filter((pk) => isDemoPasskeyCredentialId(pk.credential_id));
  if (demoPasskeys.length === 0) {
    return;
  }

  const wrappedResult = await env.DB.prepare(
    `SELECT passkey_id FROM user_passkey_wrapped_keys WHERE profile_id IN (${placeholders})`
  )
    .bind(...profileIds)
    .all<{ passkey_id: string }>();
  const alreadyWrapped = new Set((wrappedResult.results || []).map((r) => r.passkey_id));

  const wrapStatements: D1PreparedStatement[] = [];
  for (const pk of demoPasskeys) {
    if (alreadyWrapped.has(pk.id)) {
      continue;
    }
    wrapStatements.push(
      env.DB.prepare(
        "INSERT INTO user_passkey_wrapped_keys (passkey_id, profile_id, encrypted_sk, iv, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(passkey_id) DO NOTHING"
      ).bind(
        pk.id,
        primaryProfile.id,
        buildSyntheticBase64(`demo-pk-wrap-${pk.id}`, 64),
        buildSyntheticBase64(`demo-pk-iv-${pk.id}`, 12),
        pk.created_at || nowSec
      )
    );
  }

  if (wrapStatements.length > 0) {
    await env.DB.batch(wrapStatements);
  }
}

/**
 * Seeds Demo Passkeys and Post-Quantum E2EE keys together in sequence
 * (Passkeys must exist first so E2EE can link wrapped key rows to them).
 */
export async function ensureDemoPasskeysAndE2ee(
  env: Env,
  userId: string,
  profiles: Profile[]
): Promise<void> {
  const passkeys = await ensureDemoPasskeys(env, userId);
  await ensureDemoE2ee(env, profiles, passkeys);
}

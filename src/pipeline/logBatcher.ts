import { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { Env, ExecutionContext, ProfileSettings, ResolutionLog } from "../types";
import { LogModel, generateLogId } from "../models/log";
import { cacheUtils } from "../utils/cache";
import {
  encryptSensitiveLogData,
  encryptSensitiveLogDataWithDek,
  PqcProfilePublicKey,
} from "../lib/crypto/e2ee";
import {
  ensureActiveDek,
  invalidateActiveDek,
  ActiveDek,
} from "../lib/crypto/dekManager";

export type ProfileLogPublicKey = JsonWebKey | PqcProfilePublicKey;

/** In-memory cache for profile E2EE public keys with 5-minute TTL */
const profileKeyCache = new Map<string, { key: ProfileLogPublicKey | null; expiresAt: number }>();

/**
 * Retrieves the E2EE public key for a profile, using an in-memory cache to avoid repeated D1 reads.
 */
export async function getProfileLogPublicKey(
  db: D1Database,
  profileId: string
): Promise<ProfileLogPublicKey | null> {
  const now = Date.now();
  const cached = profileKeyCache.get(profileId);
  if (cached && cached.expiresAt > now) {
    return cached.key;
  }

  try {
    let row: { public_key: string } | null = null;
    try {
      row = await db
        .prepare("SELECT public_key FROM user_log_keys WHERE profile_id = ? AND (is_active IS NULL OR is_active = 1)")
        .bind(profileId)
        .first<{ public_key: string }>();
    } catch (columnErr: any) {
      if (String(columnErr?.message || columnErr).includes("no such column: is_active")) {
        row = await db
          .prepare("SELECT public_key FROM user_log_keys WHERE profile_id = ?")
          .bind(profileId)
          .first<{ public_key: string }>();
      } else {
        throw columnErr;
      }
    }

    const key = row?.public_key ? (JSON.parse(row.public_key) as ProfileLogPublicKey) : null;
    // Cache active key for 5 minutes; if null (E2EE not enabled), cache for 5 minutes as well
    // Rapid invalidation is handled by invalidateProfileLogKeyCache() when user configures E2EE
    const ttlMs = 5 * 60 * 1000;
    profileKeyCache.set(profileId, { key, expiresAt: now + ttlMs });
    return key;
  } catch (err) {
    console.error(`[E2EE] Failed to fetch log public key for profile ${profileId}:`, err);
    throw err;
  }
}

/**
 * Checks quickly whether a profile has an active E2EE public key configured.
 * Uses the short-lived in-memory profile key cache when warm.
 *
 * @param db - D1 Database instance.
 * @param profileId - Profile identifier.
 * @returns True when E2EE log encryption is enabled for the profile.
 */
export async function hasProfileE2eeConfigured(
  db: D1Database,
  profileId: string
): Promise<boolean> {
  try {
    return (await getProfileLogPublicKey(db, profileId)) !== null;
  } catch {
    return false;
  }
}

/**
 * Invalidates the in-memory E2EE public key and active DEK cache for a profile.
 */
export function invalidateProfileLogKeyCache(profileId: string): void {
  profileKeyCache.delete(profileId);
  invalidateActiveDek(profileId);
}

/** In-memory batch queue of logs waiting to be flushed to D1 */
const logBatchQueue: ResolutionLog[] = [];

/** Active in-flight ingress log encryption/queueing tasks */
const inFlightLogSeals = new Set<Promise<void>>();

/** Maximum number of statements in a single db.batch() transaction */
const MAX_BATCH_SIZE = 40;

/** Debounce time window for micro-batch flushing (10 seconds to minimize plaintext RAM residency) */
const FLUSH_INTERVAL_MS = 10_000;

const redactSensitiveLogFields = (target: ResolutionLog, redactedDomain: string): void => {
  target.domain = redactedDomain;
  target.client_ip = "";
  target.geo_country = "";
  target.answer = undefined;
  target.dest_geoip = undefined;
  target.dest_country_code = null;
  target.dest_country = null;
  target.dest_isp = null;
  target.ecs = undefined;
  target.upstream = undefined;
  target.reason = undefined;
};

/**
 * Encrypts sensitive DNS log fields for E2EE-enabled profiles and scrubs plaintext properties
 * immediately before entering the batch queue.
 */
async function sealSingleLogEntry(
  log: ResolutionLog,
  pubKey: ProfileLogPublicKey | null,
  activeDek: ActiveDek | null
): Promise<void> {
  if (!pubKey) {
    log.encrypt_version = 0;
    log.kem_key_id = null;
    return;
  }

  let encryptedOk = false;
  try {
    const sensitiveData = {
      domain: log.domain,
      client_ip: log.client_ip,
      geo_country: log.geo_country,
      answer: log.answer,
      dest_geoip: log.dest_geoip,
      dest_country_code: log.dest_country_code,
      dest_country: log.dest_country,
      dest_isp: log.dest_isp,
      ecs: log.ecs,
      upstream: log.upstream,
      reason: log.reason,
    };

    if ("pqc_pk" in pubKey) {
      if (activeDek) {
        const encrypted = await encryptSensitiveLogDataWithDek(activeDek.dek, sensitiveData);
        log.encrypt_version = 2;
        log.kem_key_id = activeDek.kemKeyId;
        log.encrypted_payload = encrypted;
        encryptedOk = true;
      }
    } else if ("kty" in pubKey) {
      const encrypted = await encryptSensitiveLogData(pubKey, sensitiveData);
      log.encrypt_version = 1;
      log.kem_key_id = null;
      log.encrypted_payload = encrypted;
      encryptedOk = true;
    }

    sensitiveData.domain = "";
    sensitiveData.client_ip = "";
    sensitiveData.geo_country = "";
    sensitiveData.answer = undefined;
    sensitiveData.dest_geoip = undefined;
    sensitiveData.dest_country_code = null;
    sensitiveData.dest_country = null;
    sensitiveData.dest_isp = null;
    sensitiveData.ecs = undefined;
    sensitiveData.upstream = undefined;
    sensitiveData.reason = undefined;
  } catch (encErr) {
    console.error(`[LogBatcher] Encryption failed for profile ${log.profile_id}:`, encErr);
  }

  if (encryptedOk && log.encrypt_version && log.encrypt_version > 0) {
    redactSensitiveLogFields(log, "");
  } else {
    // Fail closed: never retain plaintext when E2EE is enabled and encryption failed
    log.encrypt_version = 0;
    log.kem_key_id = null;
    redactSensitiveLogFields(log, "[Encrypted]");
  }
}

/** Circuit breaker cooldown duration when D1 write quota is exceeded (1 hour) */
const CIRCUIT_BREAKER_COOLDOWN_SEC = 3600;

/** In-memory timestamp until which write operations are silenced */
let memoryCircuitBreakerUntil = 0;

/** Whether a deferred flush timer has already been scheduled */
let isFlushScheduled = false;

/** Timestamp of the last batch flush (0 so first cold-start query persists immediately without waiting 10s) */
let lastFlushTime = 0;

/**
 * Checks if the D1 write quota circuit breaker is currently active.
 *
 * @param cache Cloudflare Cache API instance
 * @returns boolean True if write operations are currently silenced
 */
export async function isWriteQuotaTripped(cache?: any): Promise<boolean> {
  const now = Date.now();
  if (memoryCircuitBreakerUntil > now) {
    return true;
  }

  if (cache) {
    try {
      const trippedUntil = await cacheUtils.get<number>(cache, "d1:write_quota_tripped");
      if (trippedUntil && trippedUntil > Math.floor(now / 1000)) {
        memoryCircuitBreakerUntil = trippedUntil * 1000;
        return true;
      }
    } catch {
      // Non-critical cache read error
    }
  }

  return false;
}

/**
 * Activates the write circuit breaker when a D1 write quota limit error occurs.
 *
 * @param cache Cloudflare Cache API instance
 */
export async function tripWriteCircuitBreaker(cache?: any): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const trippedUntilSec = nowSec + CIRCUIT_BREAKER_COOLDOWN_SEC;
  memoryCircuitBreakerUntil = trippedUntilSec * 1000;

  // Clear pending queue to prevent memory leaks while writes are blocked
  logBatchQueue.length = 0;
  isFlushScheduled = false;

  console.warn(
    `[LogBatcher] D1 write quota limit reached! Silencing log writes for ${CIRCUIT_BREAKER_COOLDOWN_SEC}s.`
  );

  if (cache) {
    try {
      await cacheUtils.set(cache, "d1:write_quota_tripped", trippedUntilSec, CIRCUIT_BREAKER_COOLDOWN_SEC);
    } catch {
      // Non-critical cache write error
    }
  }
}

/**
 * Flushes a batch of logs to D1 via db.batch().
 *
 * @param env Cloudflare Worker environment bindings
 * @param ctx ExecutionContext to extend background lifetime
 */
export async function flushLogBatch(env: Env, ctx?: ExecutionContext): Promise<void> {
  isFlushScheduled = false;

  if (inFlightLogSeals.size === 0 && logBatchQueue.length === 0) {
    return;
  }

  lastFlushTime = Date.now();

  if (inFlightLogSeals.size > 0) {
    // Only wait on active ingress sealing tasks; never let flushLogBatch wait on a task that itself awaits flushLogBatch
    await Promise.allSettled(Array.from(inFlightLogSeals));
  }

  if (logBatchQueue.length === 0) {
    return;
  }

  const cache = typeof caches !== "undefined" ? (caches as any).default : null;
  if (await isWriteQuotaTripped(cache)) {
    logBatchQueue.length = 0;
    return;
  }

  // Atomically extract up to MAX_BATCH_SIZE logs from the front of the queue
  const logsToFlush = logBatchQueue.splice(0, MAX_BATCH_SIZE);

  if (logsToFlush.length === 0) {
    return;
  }

  const logModel = new LogModel(env.DB);
  const statements: D1PreparedStatement[] = [];

  // Only resolve E2EE keys for logs that were not already sealed at enqueue time
  const unsealedLogs = logsToFlush.filter(
    (l) => !((l.encrypt_version ?? 0) > 0 || l.domain === "[Encrypted]")
  );
  const profileIds = Array.from(new Set(unsealedLogs.map((l) => l.profile_id)));
  const keyMap = new Map<string, ProfileLogPublicKey | null>();
  const dekMap = new Map<string, ActiveDek | null>();
  const failedKeyProfiles = new Set<string>();

  if (profileIds.length > 0) {
    await Promise.all(
      profileIds.map(async (pid) => {
        try {
          const pubKey = await getProfileLogPublicKey(env.DB, pid);
          keyMap.set(pid, pubKey);
          if (pubKey && "pqc_pk" in pubKey) {
            const activeDek = await ensureActiveDek(env.DB, pid, pubKey.pqc_pk);
            if (activeDek) {
              dekMap.set(pid, activeDek);
            } else {
              failedKeyProfiles.add(pid);
            }
          }
        } catch (keyErr) {
          console.error(`[LogBatcher] E2EE key/DEK resolution failed for profile ${pid}; failing closed:`, keyErr);
          failedKeyProfiles.add(pid);
        }
      })
    );
  }

  for (const log of logsToFlush) {
    const alreadySealed = (log.encrypt_version ?? 0) > 0 || log.domain === "[Encrypted]";
    if (!alreadySealed) {
      if (failedKeyProfiles.has(log.profile_id)) {
        log.encrypt_version = 0;
        log.kem_key_id = null;
        redactSensitiveLogFields(log, "[Encrypted]");
      } else {
        const pubKey = keyMap.get(log.profile_id) ?? null;
        const activeDek = dekMap.get(log.profile_id) ?? null;
        await sealSingleLogEntry(log, pubKey, activeDek);
      }
    }
    statements.push(logModel.createInsertStatement(log));
  }

  try {
    await env.DB.batch(statements);
  } catch (err: any) {
    const errorMsg = String(err?.message || err);

    // Detect Cloudflare D1 row write quota exhaustion
    if (
      errorMsg.includes("exceeded D1's free tier daily row write limit") ||
      errorMsg.includes("row write limit") ||
      errorMsg.includes("daily write limit")
    ) {
      await tripWriteCircuitBreaker(cache);
    } else {
      console.warn(`[LogBatcher] Batch write failed (${statements.length} stmts):`, errorMsg);
    }
  } finally {
    // Scrub flushed log references so plaintext strings do not linger in Worker heap
    for (const log of logsToFlush) {
      redactSensitiveLogFields(log, "");
      log.encrypted_payload = undefined;
    }
    logsToFlush.length = 0;
  }

  // If there are still items remaining in queue, schedule the next batch
  if (logBatchQueue.length > 0) {
    scheduleDeferredFlush(env, ctx);
  }
}

/**
 * Schedules a background deferred flush after FLUSH_INTERVAL_MS if one is not already pending.
 *
 * @param env Cloudflare Worker environment bindings
 * @param ctx ExecutionContext to extend background lifetime
 */
function scheduleDeferredFlush(env: Env, ctx?: ExecutionContext): void {
  if (isFlushScheduled) {
    return;
  }
  isFlushScheduled = true;

  // Use a promise timer resolved in background execution context
  const flushPromise = new Promise((resolve) => setTimeout(resolve, FLUSH_INTERVAL_MS))
    .then(() => flushLogBatch(env, ctx))
    .catch((e) => {
      isFlushScheduled = false;
      console.error("[LogBatcher] Deferred flush error:", e);
    });

  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(flushPromise);
  }
}

/**
 * Enqueues a DNS resolution log for 15-second micro-batching and quota protection.
 *
 * @param log ResolutionLog object to insert
 * @param settings Current profile settings
 * @param env Cloudflare Worker environment bindings
 * @param ctx ExecutionContext to extend background lifetime
 */
export function enqueueLog(
  log: ResolutionLog,
  settings: ProfileSettings | undefined,
  env: Env,
  ctx: ExecutionContext
): void {
  // 1. Zero-retention policy check: if log_retention_days is 0, completely skip logging
  if (settings && Number(settings.log_retention_days) === 0) {
    redactSensitiveLogFields(log, "");
    return;
  }

  // 2. Skip logging for PASS queries when skip_log_on_pass is enabled
  const action = (log.action || "PASS").toUpperCase();
  if (settings?.skip_log_on_pass && action === "PASS") {
    redactSensitiveLogFields(log, "");
    return;
  }

  // 3. Fast memory circuit-breaker check
  if (memoryCircuitBreakerUntil > Date.now()) {
    redactSensitiveLogFields(log, "");
    return;
  }

  // 4. Ensure unique id is assigned before sealing/queueing log
  if (!log.id) {
    log.id = generateLogId();
  }

  // 5. Immediately seal E2EE logs at ingress so plaintext DNS data does not sit in logBatchQueue.
  // Track only sealTask in inFlightLogSeals and remove it before triggering flushLogBatch to prevent circular deadlock.
  const sealTask = (async () => {
    try {
      const pubKey = await getProfileLogPublicKey(env.DB, log.profile_id);
      if (pubKey) {
        let activeDek: ActiveDek | null = null;
        if ("pqc_pk" in pubKey) {
          activeDek = await ensureActiveDek(env.DB, log.profile_id, pubKey.pqc_pk);
        }
        await sealSingleLogEntry(log, pubKey, activeDek);
      }
    } catch (keyErr) {
      console.error(`[LogBatcher] Ingress E2EE sealing failed for profile ${log.profile_id}; failing closed:`, keyErr);
      log.encrypt_version = 0;
      log.kem_key_id = null;
      redactSensitiveLogFields(log, "[Encrypted]");
    }

    logBatchQueue.push(log);
  })();

  inFlightLogSeals.add(sealTask);
  const enqueueLifecycle = sealTask
    .finally(() => {
      inFlightLogSeals.delete(sealTask);
    })
    .then(async () => {
      const now = Date.now();
      if (
        logBatchQueue.length >= MAX_BATCH_SIZE ||
        now - lastFlushTime >= FLUSH_INTERVAL_MS
      ) {
        await flushLogBatch(env, ctx);
      } else {
        scheduleDeferredFlush(env, ctx);
      }
    });

  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(enqueueLifecycle);
  }
}

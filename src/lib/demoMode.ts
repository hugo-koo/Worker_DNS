import { D1PreparedStatement } from "@cloudflare/workers-types";
import { Env, Profile, ProfileSettings, ResolutionLog } from "../types";
import { AccessPointModel } from "../models/accessPoint";
import { ListModel } from "../models/list";
import { LogModel, generateLogId } from "../models/log";
import { ProfileModel } from "../models/profile";
import { RuleModel } from "../models/rule";
import { generateId } from "./auth";
import { syncProfileKeysToDo, upsertAccessKeysInDo } from "./accessKeyRegistry";
import { getDefaultUpstreamUrl } from "../constants/presets";
import {
  DEFAULT_DEMO_DOMAIN,
  DEMO_ACCESS_POINT_SPECS,
  DEMO_CLIENT_POOL,
  DEMO_EXTERNAL_LISTS,
  DEMO_KIDS_RULES,
  DEMO_PRIMARY_RULES,
  DEMO_TRAFFIC_TEMPLATES,
  DemoRuleSpec,
  getDemoDomain,
  isDemoMode,
} from "./demoConfig";
import { ensureDemoPasskeysAndE2ee } from "./demoSecuritySeed";

export { DEFAULT_DEMO_DOMAIN, isDemoMode, getDemoDomain };

/** In-memory per-isolate guard preventing redundant demo-seeding queries across requests. */
const seededUsersInIsolate = new Set<string>();
const pendingSeedsInIsolate = new Map<string, Promise<void>>();

/**
 * Resolves or creates the companion secondary demo Profiles ("Office Network" & "Kids Safe")
 * alongside the primary Profile.
 */
async function ensureDemoProfiles(
  env: Env,
  userId: string,
  profileModel: ProfileModel
): Promise<{ primary: Profile; office: Profile; kids: Profile }> {
  let profiles = await profileModel.listByOwner(userId);
  const defaultUpstream = getDefaultUpstreamUrl(env);
  const baseSettings: ProfileSettings = {
    upstream: [defaultUpstream],
    ecs: { enabled: true, use_client_ip: true },
    log_retention_days: 7,
    skip_log_on_pass: false,
    default_policy: "ALLOW",
    best_effort_ech: { enabled: false, fronting_domain: "cloudflare-ech.com" },
  };

  if (profiles.length === 0) {
    const newId = generateId(6);
    await profileModel.create({
      id: newId,
      owner_id: userId,
      name: "Default",
      settings: baseSettings,
    });
    await syncProfileKeysToDo(env.DB, env, newId);
    profiles = await profileModel.listByOwner(userId);
  }

  const maxProfiles = Math.max(1, Number(env.MAX_PROFILES_PER_USER) || 10);
  const primary = profiles.find((p) => p.name === "Default") || profiles[0];
  let office = profiles.find((p) => p.name === "Office Network");
  let kids = profiles.find((p) => p.name === "Kids Safe");

  if (!office && profiles.length < maxProfiles) {
    const officeId = generateId(6);
    await profileModel.create({
      id: officeId,
      owner_id: userId,
      name: "Office Network",
      settings: { ...baseSettings, upstream: ["https://cloudflare-dns.com/dns-query"] },
    });
    await env.DB.prepare("UPDATE profiles SET created_at = ? WHERE id = ?")
      .bind(Math.max(1, primary.created_at - 120), officeId)
      .run();
    await syncProfileKeysToDo(env.DB, env, officeId);
    office = (await profileModel.getById(officeId)) || undefined;
    profiles = await profileModel.listByOwner(userId);
  }

  if (!kids && profiles.length < maxProfiles) {
    const kidsId = generateId(6);
    await profileModel.create({
      id: kidsId,
      owner_id: userId,
      name: "Kids Safe",
      settings: { ...baseSettings, upstream: ["https://family.cloudflare-dns.com/dns-query"] },
    });
    await env.DB.prepare("UPDATE profiles SET created_at = ? WHERE id = ?")
      .bind(Math.max(1, primary.created_at - 240), kidsId)
      .run();
    await syncProfileKeysToDo(env.DB, env, kidsId);
    kids = (await profileModel.getById(kidsId)) || undefined;
  }

  return {
    primary,
    office: office || primary,
    kids: kids || primary,
  };
}

/**
 * Seeds diverse device-type Access Points across user Profiles (plus an unbound Smart TV AP).
 */
async function ensureDemoAccessPoints(
  env: Env,
  userId: string,
  profiles: { primary: Profile; office: Profile; kids: Profile },
  apModel: AccessPointModel
) {
  let currentAps = await apModel.getAccessPointsByOwner(userId);
  const maxAps = Math.max(1, Number(env.MAX_ACCESS_POINTS_PER_PROFILE) || 100);
  const existingNames = new Set(currentAps.map((ap) => ap.name.toLowerCase()));
  const missingSpecs = DEMO_ACCESS_POINT_SPECS.filter(
    (spec) => !existingNames.has(spec.name.toLowerCase())
  );

  if (missingSpecs.length > 0 && currentAps.length < maxAps) {
    const availableSlots = maxAps - currentAps.length;
    const specsToCreate = missingSpecs.slice(0, availableSlots);
    const createdForDo: {
      accessKey: string;
      profileId: string;
      ownerId: string;
      accessPointId: string;
      accessPointName: string;
      updatedAt: number;
    }[] = [];

    for (const spec of specsToCreate) {
      let targetProfileId: string | null = profiles.primary.id;
      if (spec.targetProfileRole === "office") targetProfileId = profiles.office.id;
      else if (spec.targetProfileRole === "kids") targetProfileId = profiles.kids.id;
      else if (spec.targetProfileRole === "unbound") targetProfileId = null;

      const created = await apModel.addAccessPointForOwner(
        userId,
        spec.name,
        targetProfileId,
        spec.deviceType
      );
      createdForDo.push({
        accessKey: created.token,
        profileId: targetProfileId || "default",
        ownerId: userId,
        accessPointId: created.id,
        accessPointName: created.name,
        updatedAt: created.updated_at,
      });
    }

    if (createdForDo.length > 0) {
      await upsertAccessKeysInDo(env, createdForDo);
    }
    currentAps = await apModel.getAccessPointsByOwner(userId);
  }
  // Backfill device_type on previously seeded Demo APs upgraded across migration 0075
  const specByName = new Map(DEMO_ACCESS_POINT_SPECS.map((s) => [s.name.toLowerCase(), s]));
  let updatedExistingDeviceType = false;
  for (const ap of currentAps) {
    const matched = specByName.get(ap.name.toLowerCase());
    if (matched && (!ap.device_type || ap.device_type === "other_device") && matched.deviceType !== "other_device") {
      await apModel.updateAccessPointByOwner(ap.id, userId, { device_type: matched.deviceType });
      updatedExistingDeviceType = true;
    }
  }
  if (updatedExistingDeviceType) {
    currentAps = await apModel.getAccessPointsByOwner(userId);
  }

  return currentAps;
}

/**
 * Seeds representative Custom Rules if the target Profile has no rules yet.
 */
async function ensureDemoRules(
  ruleModel: RuleModel,
  profileId: string,
  specs: readonly DemoRuleSpec[],
  demoDomain: string
): Promise<void> {
  const existing = await ruleModel.getRules(profileId);
  if (existing.length > 0) return;

  const baseTs = Math.floor(Date.now() / 1000) - 3600;
  await ruleModel.addRulesBulk(
    profileId,
    specs.map((spec, idx) => ({
      type: spec.type,
      pattern: spec.pattern.replace(DEFAULT_DEMO_DOMAIN, demoDomain),
      include_subdomains: spec.include_subdomains,
      v_a: spec.v_a ?? undefined,
      v_aaaa: spec.v_aaaa ?? undefined,
      v_cname: spec.v_cname ? spec.v_cname.replace(DEFAULT_DEMO_DOMAIN, demoDomain) : undefined,
      v_txt: spec.v_txt ?? undefined,
      created_at: baseTs + idx * 60,
    }))
  );
}

/**
 * Seeds External Blocklist subscriptions and pre-populated metadata counts for FilteringView.
 */
async function ensureDemoLists(
  env: Env,
  listModel: ListModel,
  primaryProfileId: string
): Promise<void> {
  const existing = await listModel.getLists(primaryProfileId);
  const existingProfileLists = existing.filter((l) => l.scope === "profile");
  if (existingProfileLists.length > 0) return;

  const nowSec = Math.floor(Date.now() / 1000);
  const syncedAt = nowSec - 1800;

  for (const spec of DEMO_EXTERNAL_LISTS) {
    const added = await listModel.addList(primaryProfileId, spec.url, false);
    if (added.id && !spec.enabled) {
      await env.DB.prepare("UPDATE lists SET enabled = 0 WHERE id = ?").bind(added.id).run();
    }
    await listModel.metadata.updateGlobalListMetadata(
      spec.url,
      syncedAt,
      `"demo-etag"`,
      syncedAt - 3600,
      null,
      spec.stats
    );
  }
}

/** Per-isolate throttle for rolling Demo 1h log window checks (profileId -> last checked unix sec). */
const lastRecentLogCheckInIsolate = new Map<string, number>();
const pendingRecentLogSeedInIsolate = new Map<string, Promise<void>>();

const DEMO_LOG_PRUNE_AGE_SEC = 25 * 3600;
const DEMO_LOG_RECENT_REFRESH_SEC = 300;
const DEMO_LOG_MIN_1H_COUNT = 45;

/**
 * Generates deterministic Demo DNS resolution `INSERT` statements for a given list of lookback offsets.
 */
function buildDemoLogStatements(
  logModel: LogModel,
  profileId: string,
  accessPoints: { id: string; name: string }[],
  offsetsSec: number[],
  demoDomain: string,
  nowSec: number,
  seedOffset: number = 0
): D1PreparedStatement[] {
  const apByName = new Map(accessPoints.map((ap) => [ap.name, ap.id]));
  const fallbackApId = accessPoints[0]?.id;
  const statements: D1PreparedStatement[] = [];

  for (let i = 0; i < offsetsSec.length; i++) {
    const idx = i + seedOffset;
    const tpl = DEMO_TRAFFIC_TEMPLATES[(idx * 7 + 3) % DEMO_TRAFFIC_TEMPLATES.length];
    const client = DEMO_CLIENT_POOL[(idx * 3 + 1) % DEMO_CLIENT_POOL.length];
    const apId = apByName.get(client.apName) || fallbackApId;
    const ts = nowSec - offsetsSec[i];

    const destGeoJson = tpl.destCode
      ? JSON.stringify({
          country_code: tpl.destCode,
          country: tpl.destCountry,
          city: tpl.destCity,
          region: tpl.destRegion,
          isp: tpl.destIsp,
          as: tpl.destAsn,
        })
      : undefined;

    const logEntry: ResolutionLog = {
      id: generateLogId(),
      profile_id: profileId,
      access_point_id: apId,
      timestamp: ts,
      client_ip: client.clientIp,
      geo_country: client.geoCountry,
      domain: tpl.domain,
      record_type: tpl.recordType,
      action: tpl.action,
      reason: tpl.reason,
      answer: tpl.answer.replace(DEFAULT_DEMO_DOMAIN, demoDomain),
      dest_geoip: destGeoJson,
      dest_country_code: tpl.destCode || null,
      dest_country: tpl.destCountry || null,
      dest_isp: tpl.destIsp || null,
      latency: tpl.latencyMs + (idx % 5),
      upstream: tpl.action === "PASS" ? `https://${demoDomain}/upstream` : undefined,
      encrypt_version: 0,
    };

    statements.push(logModel.createInsertStatement(logEntry));
  }

  return statements;
}

/**
 * Seeds ~210 realistic DNS resolution logs over the last 23 hours so `/stats` (Analytics)
 * and `/logs` (Logs + DestinationMap + Country/ISP filters) immediately present rich data.
 */
async function ensureDemoLogs(
  env: Env,
  logModel: LogModel,
  primaryProfileId: string,
  accessPoints: { id: string; name: string }[]
): Promise<void> {
  const hasAnyLog = await env.DB.prepare("SELECT 1 FROM logs WHERE profile_id = ? LIMIT 1")
    .bind(primaryProfileId)
    .first();
  if (hasAnyLog) return;

  const nowSec = Math.floor(Date.now() / 1000);

  // Distribute logs across last 10m (35), 10m-1h (65), and 1h-23h (110) = 210 logs total
  const offsetsSec: number[] = [];
  for (let i = 0; i < 35; i++) {
    offsetsSec.push(8 + i * 16);
  }
  for (let i = 0; i < 65; i++) {
    offsetsSec.push(620 + i * 45);
  }
  for (let i = 0; i < 110; i++) {
    offsetsSec.push(3800 + i * 720);
  }

  const demoDomain = getDemoDomain(env);
  const statements = buildDemoLogStatements(logModel, primaryProfileId, accessPoints, offsetsSec, demoDomain, nowSec);

  for (let i = 0; i < statements.length; i += 50) {
    await env.DB.batch(statements.slice(i, i + 50));
  }
  lastRecentLogCheckInIsolate.set(primaryProfileId, nowSec);
}

/**
 * Ensures the target Demo Mode profile always contains fresh resolution logs within the last
 * 1 hour (and 10 minutes), topping up the rolling window and pruning aged Demo rows (>25h)
 * so entering `/logs` in the 1h view always displays live-feeling entries without DB bloat.
 *
 * @param env - Worker or Serverfull environment bindings.
 * @param userId - Authenticated user ID.
 * @param profileId - Profile ID being queried on `/logs`.
 */
export async function ensureDemoLogsForWindow(
  env: Env,
  userId: string,
  profileId: string
): Promise<void> {
  if (!isDemoMode(env) || !env.DB || !userId || !profileId) return;

  const nowSec = Math.floor(Date.now() / 1000);
  const lastChecked = lastRecentLogCheckInIsolate.get(profileId) || 0;
  if (nowSec - lastChecked < 60) return;

  const existingPromise = pendingRecentLogSeedInIsolate.get(profileId);
  if (existingPromise) {
    await existingPromise;
    return;
  }

  const runRefresh = (async () => {
    try {
      const since1h = nowSec - 3600;
      const statsRow = await env.DB.prepare(
        "SELECT COUNT(1) AS cnt, MAX(timestamp) AS latest_ts FROM logs WHERE profile_id = ? AND timestamp >= ?"
      )
        .bind(profileId, since1h)
        .first<{ cnt: number; latest_ts: number | null }>();

      const recentCount = Number(statsRow?.cnt) || 0;
      const latestTs = statsRow?.latest_ts ? Number(statsRow.latest_ts) : null;

      if (
        recentCount >= DEMO_LOG_MIN_1H_COUNT &&
        latestTs !== null &&
        nowSec - latestTs <= DEMO_LOG_RECENT_REFRESH_SEC
      ) {
        lastRecentLogCheckInIsolate.set(profileId, nowSec);
        return;
      }

      const apModel = new AccessPointModel(env.DB);
      const logModel = new LogModel(env.DB);
      const accessPoints = await apModel.getAccessPointsByOwner(userId);
      const demoDomain = getDemoDomain(env);

      // Prune stale Demo logs older than 25 hours so the table remains bounded
      await env.DB.prepare("DELETE FROM logs WHERE profile_id = ? AND timestamp < ?")
        .bind(profileId, nowSec - DEMO_LOG_PRUNE_AGE_SEC)
        .run();

      const offsetsSec: number[] = [];
      let seedOffset = nowSec % 23;

      if (recentCount === 0 || latestTs === null) {
        // Populate full 1h density (35 in last 10m + 65 in 10m..1h) and 1h..23h if empty
        for (let i = 0; i < 35; i++) {
          offsetsSec.push(8 + i * 16);
        }
        for (let i = 0; i < 65; i++) {
          offsetsSec.push(620 + i * 45);
        }

        const hasHistorical = await env.DB.prepare("SELECT 1 FROM logs WHERE profile_id = ? LIMIT 1")
          .bind(profileId)
          .first();
        if (!hasHistorical) {
          for (let i = 0; i < 110; i++) {
            offsetsSec.push(3800 + i * 720);
          }
        }
      } else {
        // Bridge elapsed gap from latestTs up to nowSec (plus ensure at least 45 total in 1h)
        const gapSec = Math.max(300, nowSec - latestTs);
        const missingForDensity = Math.max(0, DEMO_LOG_MIN_1H_COUNT - recentCount);
        const batchCount = Math.min(60, Math.max(20, missingForDensity + Math.ceil(gapSec / 45)));
        const span = recentCount < DEMO_LOG_MIN_1H_COUNT ? 3500 : Math.min(3500, gapSec);
        const step = Math.max(12, Math.floor((span - 8) / batchCount));
        for (let i = 0; i < batchCount; i++) {
          offsetsSec.push(8 + i * step);
        }
        seedOffset = (nowSec + recentCount) % 29;
      }

      const statements = buildDemoLogStatements(
        logModel,
        profileId,
        accessPoints,
        offsetsSec,
        demoDomain,
        nowSec,
        seedOffset
      );
      for (let i = 0; i < statements.length; i += 50) {
        await env.DB.batch(statements.slice(i, i + 50));
      }

      lastRecentLogCheckInIsolate.set(profileId, nowSec);
    } catch (err) {
      console.error("[DemoMode] Failed to refresh Demo 1h logs window:", err);
    } finally {
      pendingRecentLogSeedInIsolate.delete(profileId);
    }
  })();

  pendingRecentLogSeedInIsolate.set(profileId, runRefresh);
  await runRefresh;
}

/**
 * Idempotently populates realistic demo data (Profiles, device Access Points, Custom Rules,
 * External Lists, and 24h DNS logs for `/stats` & `/logs`) when `DEMO_MODE` is enabled.
 *
 * @param env - Worker or Serverfull environment bindings.
 * @param userId - Authenticated user ID.
 */
export async function ensureDemoDataSeeded(env: Env, userId: string): Promise<void> {
  if (!isDemoMode(env) || !env.DB || !userId) return;
  if (seededUsersInIsolate.has(userId)) return;

  const existingPromise = pendingSeedsInIsolate.get(userId);
  if (existingPromise) {
    await existingPromise;
    return;
  }

  const runSeed = (async () => {
    try {
      const profileModel = new ProfileModel(env.DB);
      const apModel = new AccessPointModel(env.DB);
      const ruleModel = new RuleModel(env.DB);
      const listModel = new ListModel(env.DB);
      const logModel = new LogModel(env.DB);

      const profiles = await ensureDemoProfiles(env, userId, profileModel);
      const accessPoints = await ensureDemoAccessPoints(env, userId, profiles, apModel);
      const demoDomain = getDemoDomain(env);

      const uniqueProfiles = [profiles.primary, profiles.office, profiles.kids].filter(
        (p, idx, arr) => arr.findIndex((x) => x.id === p.id) === idx
      );

      await Promise.all([
        ensureDemoRules(ruleModel, profiles.primary.id, DEMO_PRIMARY_RULES, demoDomain),
        profiles.kids.id !== profiles.primary.id
          ? ensureDemoRules(ruleModel, profiles.kids.id, DEMO_KIDS_RULES, demoDomain)
          : Promise.resolve(),
        ensureDemoLists(env, listModel, profiles.primary.id),
        ensureDemoLogs(env, logModel, profiles.primary.id, accessPoints),
        ensureDemoPasskeysAndE2ee(env, userId, uniqueProfiles),
      ]);

      seededUsersInIsolate.add(userId);
    } catch (err) {
      console.warn(
        `[DemoMode] Failed seeding demo data for user ${userId}:`,
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      pendingSeedsInIsolate.delete(userId);
    }
  })();

  pendingSeedsInIsolate.set(userId, runSeed);
  await runSeed;
}

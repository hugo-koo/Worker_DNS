import { Env, User, ExecutionContext, ServerfullRuntimeStatus } from "../../types";
import { hashPassword } from "../../utils/crypto";
import { UserModel } from "../../models/user";
import { ProfileModel } from "../../models/profile";
import { ListModel } from "../../models/list";
import { ListBloomModel } from "../../models/listBloom";
import { SystemSettingsModel } from "../../models/systemSettings";
import { InviteCodeModel } from "../../models/inviteCode";
import { PASSWORD_REGEX, USERNAME_REGEX, isSafeUrlWithDnsCheck } from "../../utils/validator";
import { syncGlobalList } from "../../utils/sync/singleListSync";
import { rebuildProfileBloom } from "../../utils/sync";
import { pipeline } from "../../pipeline";
import {
  getDatabaseService,
  isTursoConfigured,
  getTursoMigrationStats,
  runTursoMigrations
} from "../../lib/turso";
import { detectServerfullMode } from "../../router/runtimeConfig";
import { buildDemoSnapshotOverview, isDemoMode } from "../../lib/demoConfig";
import { ensureDemoDataSeeded } from "../../lib/demoMode";
import { getOrCreateJwtSecret } from "../../lib/auth";
import { importJwtSecret, signJWT } from "../../lib/jwt";

/**
 * Allowlist of system setting keys that can be updated via administrative REST APIs.
 * Prevents key namespace pollution and blocks attempts to overwrite internal timestamps or runtime secrets.
 */
const ALLOWED_ADMIN_SETTINGS_KEYS = new Set<string>([
  'turnstile_site_key',
  'turnstile_secret_key',
  'turnstile_enabled_signup',
  'turnstile_enabled_login',
  'registration_enabled',
  'invite_code_enabled',
  'max_users'
]);

/**
 * Safely decodes a URL path segment, returning `null` if percent-encoding is malformed.
 */
function decodePathSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/**
 * Handle admin requests to /api/admin/...
 */
export async function handleAdminRequest(
  request: Request,
  env: Env,
  user: User,
  pathParts: string[],
  ctx: ExecutionContext
): Promise<Response> {
  const userModel = new UserModel(env.DB, env);
  const profileModel = new ProfileModel(env.DB);

  if (pathParts[2] === 'users') {
    if (request.method === 'GET') {
      await ensureDemoDataSeeded(env, user.id);
      const users = await userModel.listAll();
      return new Response(JSON.stringify(users), { headers: { 'Content-Type': 'application/json' } });
    }

    if (request.method === 'POST') {
      const { username, password, role } = await request.json() as any;
      const trimmedUsername = typeof username === "string" ? username.trim() : "";
      if (!trimmedUsername || !USERNAME_REGEX.test(trimmedUsername)) {
        return new Response("Invalid username format", { status: 400 });
      }
      if (!password || !PASSWORD_REGEX.test(password)) {
        return new Response("Password format error", { status: 400 });
      }

      if (await userModel.isUsernameConflict(trimmedUsername)) {
        return new Response("username_exists", { status: 400 });
      }

      const systemSettings = new SystemSettingsModel(env.DB);
      const maxUsersSetting = await systemSettings.get('max_users');
      const rawMaxUsers = maxUsersSetting !== null ? maxUsersSetting : env.MAX_USERS;
      const maxUsers = rawMaxUsers !== undefined && rawMaxUsers !== null && rawMaxUsers !== "" ? parseInt(String(rawMaxUsers), 10) : 0;
      if (maxUsers > 0) {
        const currentCount = await userModel.count();
        if (currentCount >= maxUsers) {
          return new Response("max_users_reached", { status: 400 });
        }
      }

      const hashedPassword = await hashPassword(password, 2);
      const userId = await userModel.generateUniqueUserId(trimmedUsername);
      try {
        await userModel.create({ id: userId, username: trimmedUsername, passwordHash: hashedPassword, role: role || 'user', passwordVersion: 2 });
        return new Response(JSON.stringify({ id: userId }), { status: 201 });
      } catch (e: any) {
        console.error("[Admin API] Create user failed:", e?.message || e);
        return new Response("Failed to create user", { status: 400 });
      }
    }

    if (request.method === 'DELETE' && pathParts[3]) {
      const targetId = pathParts[3];
      if (targetId === user.id) return new Response("Cannot delete yourself", { status: 400 });
      const { invalidateAuthUserCacheByUserId } = await import("../../lib/middleware");
      const { collectOwnerAccessKeys, deleteAccessKeysInDo } = await import("../../lib/accessKeyRegistry");
      invalidateAuthUserCacheByUserId(targetId);
      const keysToRevoke = await collectOwnerAccessKeys(env.DB, targetId);
      await profileModel.deleteByOwner(targetId);
      await userModel.delete(targetId);
      if (keysToRevoke.length > 0) {
        ctx.waitUntil(deleteAccessKeysInDo(env, keysToRevoke));
      }
      return new Response(null, { status: 204 });
    }
  }

  // 邀请码管理接口: /api/admin/invite-codes
  if (pathParts[2] === 'invite-codes') {
    const inviteCodeModel = new InviteCodeModel(env.DB);
    if (request.method === 'GET') {
      const codes = await inviteCodeModel.listAll();
      return new Response(JSON.stringify(codes), { headers: { 'Content-Type': 'application/json' } });
    }

    if (request.method === 'POST') {
      let body: { code?: string; max_uses?: number; expires_at?: number | null } = {};
      try {
        body = (await request.json()) as { code?: string; max_uses?: number; expires_at?: number | null };
      } catch {
        return new Response("Invalid JSON payload", { status: 400 });
      }

      const maxUsesRaw = body.max_uses ?? 1;
      const maxUses = typeof maxUsesRaw === 'number' ? Math.floor(maxUsesRaw) : parseInt(String(maxUsesRaw), 10);
      if (!Number.isFinite(maxUses) || maxUses < 1) {
        return new Response("invalid_max_uses", { status: 400 });
      }

      let expiresAt: number | null = null;
      if (body.expires_at !== undefined && body.expires_at !== null) {
        const parsedExp = Number(body.expires_at);
        const now = Math.floor(Date.now() / 1000);
        if (!Number.isFinite(parsedExp) || parsedExp <= now) {
          return new Response("invalid_expires_at", { status: 400 });
        }
        expiresAt = Math.floor(parsedExp);
      }

      try {
        const created = await inviteCodeModel.create({
          code: typeof body.code === 'string' ? body.code : undefined,
          maxUses,
          expiresAt,
          createdBy: user.id
        });
        return new Response(JSON.stringify(created), {
          status: 201,
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg === 'invite_code_exists') {
          return new Response("invite_code_exists", { status: 409 });
        }
        if (msg === 'invalid_invite_code_format' || msg === 'invalid_max_uses' || msg === 'invalid_expires_at') {
          return new Response(msg, { status: 400 });
        }
        console.error("[Admin API] Create invite code failed:", msg);
        return new Response("Failed to create invite code", { status: 400 });
      }
    }

    if (request.method === 'DELETE' && pathParts[3]) {
      const targetCode = decodePathSegment(pathParts[3]);
      if (!targetCode) return new Response("Invalid invite code", { status: 400 });
      const deleted = await inviteCodeModel.delete(targetCode);
      if (!deleted) return new Response("Not Found", { status: 404 });
      return new Response(null, { status: 204 });
    }
  }

  // 系统设置接口: /api/admin/settings
  if (pathParts[2] === 'settings') {
    const systemSettings = new SystemSettingsModel(env.DB);
    if (request.method === 'GET') {
      const settings = await systemSettings.getAll();
      // 敏感配置脱敏，jwt_secret 绝不能暴露给外部/客户端
      delete settings.jwt_secret;
      return new Response(JSON.stringify(settings), { headers: { 'Content-Type': 'application/json' } });
    }
    if (request.method === 'PATCH') {
      let body: Record<string, unknown> = {};
      try {
        body = await request.json() as Record<string, unknown>;
      } catch {
        return new Response("Invalid JSON payload", { status: 400 });
      }

      const filteredSettings: Record<string, string> = {};
      for (const [key, value] of Object.entries(body)) {
        if (ALLOWED_ADMIN_SETTINGS_KEYS.has(key)) {
          if (typeof value === 'string') {
            filteredSettings[key] = value.slice(0, 1024);
          } else if (typeof value === 'number') {
            filteredSettings[key] = String(value);
          }
        }
      }

      if (filteredSettings.max_users !== undefined) {
        const parsed = parseInt(filteredSettings.max_users, 10);
        if (isNaN(parsed) || parsed < 0) {
          filteredSettings.max_users = "0";
        } else {
          filteredSettings.max_users = String(parsed);
        }
      }

      if (Object.keys(filteredSettings).length > 0) {
        await systemSettings.setMany(filteredSettings);
      }
      return new Response(JSON.stringify({ success: true }));
    }
  }

  // 数据库管理与迁移接口: /api/admin/database
  if (pathParts[2] === 'database') {
    const isServerfull = detectServerfullMode(env);
    const dbService = getDatabaseService(env, isServerfull);
    const isTurso = dbService === 'Turso' && isTursoConfigured(env);
    const demoMode = isDemoMode(env);
    const snapshotBridge = isServerfull && dbService === 'File' && !demoMode
      ? env.SERVERFULL_SNAPSHOT_BRIDGE
      : undefined;

    if (pathParts[3] === 'snapshots') {
      if (demoMode) {
        if (request.method === 'GET' && !pathParts[4]) {
          return new Response(JSON.stringify(buildDemoSnapshotOverview(env)), {
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
          });
        }
        return new Response(JSON.stringify({ error: "Database snapshot operations are disabled in Demo Mode" }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (!snapshotBridge) {
        return new Response(JSON.stringify({ error: "Database snapshots are only supported in Serverfull File mode" }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // GET /api/admin/database/snapshots -> lightweight status & storage overview
      if (request.method === 'GET' && !pathParts[4]) {
        const overview = await snapshotBridge.getOverview();
        return new Response(JSON.stringify(overview), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
        });
      }

      // POST /api/admin/database/snapshots/:filename/ticket -> short-lived signed download URL for native streaming
      if (request.method === 'POST' && pathParts[4] && pathParts[5] === 'ticket') {
        const decodedName = decodePathSegment(pathParts[4]);
        if (decodedName === null) {
          return new Response("Invalid filename encoding", { status: 400 });
        }

        const overview = await snapshotBridge.getOverview();
        const exists = overview.snapshots.some((snap) => snap.filename === decodedName);
        if (!exists) {
          return new Response("Snapshot not found", { status: 404 });
        }
        if (!user.sessionId) {
          return new Response("Active session required", { status: 401 });
        }

        const secret = await getOrCreateJwtSecret(env);
        const jwtKey = await importJwtSecret(secret);
        // 4-hour download ticket so large snapshots can be retried/resumed cleanly while
        // every download request still performs real-time DB session & admin role checks.
        const expiresIn = 14400;
        const ticket = await signJWT(
          {
            purpose: "snapshot_download",
            filename: decodedName,
            userId: user.id,
            sessionId: user.sessionId,
            exp: Math.floor(Date.now() / 1000) + expiresIn,
          },
          jwtKey
        );

        const downloadUrl = `/api/admin/database/snapshots/${encodeURIComponent(decodedName)}/download?ticket=${encodeURIComponent(ticket)}`;
        return new Response(JSON.stringify({ ticket, downloadUrl, expiresIn }), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
        });
      }

      // GET /api/admin/database/snapshots/:filename/download
      if (request.method === 'GET' && pathParts[4] && pathParts[5] === 'download') {
        const decodedName = decodePathSegment(pathParts[4]);
        if (decodedName === null) {
          return new Response("Invalid filename encoding", { status: 400 });
        }
        const download = await snapshotBridge.openSnapshotDownload(decodedName, request.headers.get('Range'));
        if (!download) {
          return new Response("Snapshot not found", { status: 404 });
        }
        if (download.status === 416) {
          return new Response(null, {
            status: 416,
            headers: {
              'Content-Range': download.contentRange || `bytes */${download.sizeBytes}`,
              'Accept-Ranges': 'bytes',
              'Cache-Control': 'private, no-store, no-transform'
            }
          });
        }

        const headers: Record<string, string> = {
          'Content-Type': 'application/zstd',
          'Content-Disposition': `attachment; filename="${download.filename}"`,
          'Content-Length': String(download.contentLength),
          'Accept-Ranges': 'bytes',
          'ETag': download.etag,
          'Cache-Control': 'private, no-store, no-transform',
          'Vary': 'Authorization',
          'X-Accel-Buffering': 'no'
        };
        if (download.status === 206 && download.contentRange) {
          headers['Content-Range'] = download.contentRange;
        }

        return new Response(download.stream, {
          status: download.status,
          headers
        });
      }

      // POST /api/admin/database/snapshots -> start capture
      if (request.method === 'POST' && !pathParts[4]) {
        try {
          const activeCapture = await snapshotBridge.startCapture();
          return new Response(JSON.stringify({ success: true, activeCapture }), {
            status: 202,
            headers: { 'Content-Type': 'application/json' }
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : '';
          if (msg === 'SNAPSHOT_IN_PROGRESS') {
            return new Response(JSON.stringify({ error: 'Snapshot capture is already in progress' }), {
              status: 409,
              headers: { 'Content-Type': 'application/json' }
            });
          }
          if (msg.startsWith('ZSTD_UNSUPPORTED')) {
            return new Response(JSON.stringify({ error: 'Zstd compression is not supported in the current Node.js runtime (requires Node.js >= 22.15).' }), {
              status: 501,
              headers: { 'Content-Type': 'application/json' }
            });
          }
          console.error('[Admin Snapshot] Failed to start capture:', err);
          return new Response(JSON.stringify({ error: 'Failed to start snapshot capture' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }

      // POST /api/admin/database/snapshots/abort -> stop and discard active capture
      if (request.method === 'POST' && pathParts[4] === 'abort') {
        const result = await snapshotBridge.abortCapture();
        return new Response(JSON.stringify({ success: true, ...result }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // DELETE /api/admin/database/snapshots/:filename or bulk DELETE /api/admin/database/snapshots
      if (request.method === 'DELETE') {
        if (pathParts[4]) {
          const decodedName = decodePathSegment(pathParts[4]);
          if (decodedName === null) {
            return new Response("Invalid filename encoding", { status: 400 });
          }
          const result = await snapshotBridge.deleteSnapshots([decodedName]);
          return new Response(JSON.stringify({ success: true, ...result }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }

        let body: { filenames?: unknown };
        try {
          body = (await request.json()) as { filenames?: unknown };
        } catch {
          return new Response("Invalid JSON payload", { status: 400 });
        }
        const rawList = Array.isArray(body?.filenames) ? body.filenames : [];
        const filenames = rawList.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
        if (filenames.length === 0) {
          return new Response("Missing snapshot filenames", { status: 400 });
        }
        const result = await snapshotBridge.deleteSnapshots(filenames);
        return new Response(JSON.stringify({ success: true, ...result }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      return new Response("Method Not Allowed", { status: 405 });
    }

    if (request.method === 'GET' && !pathParts[3]) {
      const [stats, snapshotOverview] = await Promise.all([
        env.DB ? getTursoMigrationStats(env.DB as any) : Promise.resolve(null),
        demoMode
          ? Promise.resolve(buildDemoSnapshotOverview(env))
          : snapshotBridge
            ? snapshotBridge.getOverview()
            : Promise.resolve(null)
      ]);
      return new Response(JSON.stringify({
        databaseService: dbService,
        isTurso,
        configured: Boolean(env.DB),
        migrations: stats,
        snapshotOverview
      }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }

    if (request.method === 'POST') {
      const action = pathParts[3];
      if (action === 'migrate') {
        if (!env.DB) {
          return new Response(JSON.stringify({ error: "Database is not configured" }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        try {
          // Cap per-request migrations to stay safely within Cloudflare Workers Free Plan 50-subrequest limit.
          const appliedCount = await runTursoMigrations(env.DB as any, undefined, { maxMigrations: 15 });
          const stats = await getTursoMigrationStats(env.DB as any);
          return new Response(JSON.stringify({
            success: true,
            appliedCount,
            hasMore: !stats.completed,
            stats
          }), { headers: { 'Content-Type': 'application/json' } });
        } catch (err: any) {
          const errMsg = err instanceof Error ? err.message : String(err || '');
          console.error('[Admin Database Migrate] Migration execution failed:', err);
          return new Response(JSON.stringify({
            success: false,
            error: errMsg ? `Database migration failed: ${errMsg}` : 'Database migration failed'
          }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
    }
  }

  // 下发与撤回过滤器接口: /api/admin/distribute-filter
  if (pathParts[2] === 'distribute-filter') {
    const listModel = new ListModel(env.DB);

    // 查询当前系统中所有处于下发状态（is_system = 1）的规则列表
    if (request.method === 'GET') {
      const distributed = await listModel.getDistributedSystemLists();
      return new Response(JSON.stringify(distributed), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 撤回系统下发的过滤器（仅移除带有 is_system = 1 的记录，保留用户级列表）
    if (request.method === 'DELETE' || (request.method === 'POST' && pathParts[3] === 'revoke')) {
      let rawUrl = '';
      try {
        const body = await request.json() as { url?: unknown };
        if (typeof body?.url === 'string') rawUrl = body.url.trim();
      } catch {
        const searchUrl = new URL(request.url).searchParams.get('url');
        if (searchUrl) rawUrl = searchUrl.trim();
      }

      if (!rawUrl) {
        return new Response("Missing list URL to revoke", { status: 400 });
      }

      const canonicalUrl = ListModel.normalizeUrl(rawUrl);
      const revokeResult = await listModel.revokeSystemList(canonicalUrl);

      // 异步触发所有受影响 Profile 的本地内存快速合并
      for (const profileId of revokeResult.affectedProfileIds) {
        ctx.waitUntil(
          rebuildProfileBloom(profileId, env, ctx)
            .then(() => pipeline.clearCache(profileId, true, env))
            .catch((e) => console.error(`[Admin] Failed to rebuild bloom for profile ${profileId} after revoke:`, e))
        );
      }

      return new Response(JSON.stringify({
        success: true,
        url: canonicalUrl,
        revokedCount: revokeResult.revokedProfilesCount,
        affectedProfilesCount: revokeResult.affectedProfileIds.length,
        affectedUserCount: revokeResult.affectedUsernames.length,
        affectedUsernames: revokeResult.affectedUsernames
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (request.method !== 'POST') {
      return new Response("Method Not Allowed", { status: 405 });
    }

    let body: { url?: unknown };
    try {
      body = await request.json() as { url?: unknown };
    } catch {
      return new Response("Invalid JSON payload", { status: 400 });
    }

    const rawUrl = typeof body?.url === 'string' ? body.url.trim() : '';
    if (!rawUrl) {
      return new Response("Missing list URL", { status: 400 });
    }

    if (!(await isSafeUrlWithDnsCheck(rawUrl))) {
      return new Response("Invalid list URL. Private networks, localhosts, and internal domains are not allowed.", { status: 400 });
    }

    const canonicalUrl = ListModel.normalizeUrl(rawUrl);
    const listBloomModel = new ListBloomModel(env.DB);
    const now = Math.floor(Date.now() / 1000);

    // 1. 确保全局布隆过滤器与扩展规则已编译（方案 B）
    const hasBloom = await listBloomModel.hasListBloom(canonicalUrl);
    if (!hasBloom) {
      const syncRes = await syncGlobalList(canonicalUrl, env, listModel, listBloomModel, now);
      if (syncRes.syncError) {
        return new Response(JSON.stringify({ error: syncRes.syncError }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // 2. 下发至所有未订阅此 URL 的用户
    const result = await listModel.distributeListToAllUsers(canonicalUrl);

    // 3. 异步触发所有受影响 Profile 的本地内存快速合并
    for (const profileId of result.affectedProfileIds) {
      ctx.waitUntil(
        rebuildProfileBloom(profileId, env, ctx)
          .then(() => pipeline.clearCache(profileId, true, env))
          .catch((e) => console.error(`[Admin] Failed to rebuild bloom for profile ${profileId}:`, e))
      );
    }

    return new Response(JSON.stringify({
      success: true,
      url: canonicalUrl,
      totalUsers: result.totalUsers,
      addedCount: result.addedCount,
      skippedCount: result.skippedCount,
      failedCount: result.failedCount,
      addedUsernames: result.addedUsernames,
      skippedUsernames: result.skippedUsernames,
      failedUsernames: result.failedUsernames,
      affectedProfilesCount: result.affectedProfileIds.length
    }), { headers: { 'Content-Type': 'application/json' } });
  }

  // Serverfull 运行时版本检查与优雅重启接口: /api/admin/runtime
  if (pathParts[2] === 'runtime') {
    const isServerfull = detectServerfullMode(env);
    const demoMode = isDemoMode(env);
    const jsonHeaders = {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    };

    if (request.method === 'POST' && pathParts[3] === 'restart') {
      if (demoMode) {
        return new Response(JSON.stringify({ error: "Service restart is disabled in Demo Mode" }), {
          status: 403,
          headers: jsonHeaders
        });
      }
      if (!isServerfull || !env.SERVERFULL_LIFECYCLE_BRIDGE) {
        return new Response(JSON.stringify({ error: "Not supported outside Serverfull mode" }), {
          status: 404,
          headers: jsonHeaders
        });
      }
      try {
        const restartResult = await env.SERVERFULL_LIFECYCLE_BRIDGE.requestRestart();
        return new Response(JSON.stringify(restartResult), {
          status: 202,
          headers: jsonHeaders
        });
      } catch (e: unknown) {
        if (e instanceof Error && e.message === 'restart_unsupported') {
          return new Response(JSON.stringify({ error: "restart_unsupported" }), {
            status: 400,
            headers: jsonHeaders
          });
        }
        console.error("[Admin API] Failed to schedule service restart:", e);
        return new Response(JSON.stringify({ error: "Failed to schedule restart" }), {
          status: 500,
          headers: jsonHeaders
        });
      }
    }

    if (request.method === 'GET' && !pathParts[3]) {
      if (demoMode) {
        const nowSec = Math.floor(Date.now() / 1000);
        const demoStatus: ServerfullRuntimeStatus = {
          supported: true,
          currentVersion: '1.3.5',
          currentChannel: 'latest',
          startedAt: nowSec - 3600,
          runtime: 'Demo Runtime',
          platform: 'linux',
          installMethod: 'docker',
          serviceManager: 'docker',
          workersCount: 1,
          canRestart: false,
          restartReason: 'demo_mode',
          checkedAt: nowSec,
          checkError: null,
          channels: {
            latest: {
              channel: 'latest',
              version: '1.3.5',
              updateAvailable: false,
              updateCommand: 'docker pull hugokoo/dns-worker:latest'
            },
            alpha: {
              channel: 'alpha',
              version: '1.3.5-alpha.demo001',
              updateAvailable: false,
              updateCommand: 'docker pull hugokoo/dns-worker:alpha'
            },
            canary: {
              channel: 'canary',
              version: '1.3.5-canary.demo002',
              updateAvailable: false,
              updateCommand: 'docker pull hugokoo/dns-worker:canary'
            }
          }
        };
        return new Response(JSON.stringify(demoStatus), { headers: jsonHeaders });
      }

      if (!isServerfull || !env.SERVERFULL_LIFECYCLE_BRIDGE) {
        return new Response(JSON.stringify({ supported: false }), { headers: jsonHeaders });
      }

      const forceRefresh = new URL(request.url).searchParams.get('refresh') === '1';
      const runtimeStatus = await env.SERVERFULL_LIFECYCLE_BRIDGE.getStatus({ forceRefresh });
      return new Response(JSON.stringify(runtimeStatus), { headers: jsonHeaders });
    }

    return new Response("Method Not Allowed", { status: 405 });
  }

  return new Response("Not Found", { status: 404 });
}

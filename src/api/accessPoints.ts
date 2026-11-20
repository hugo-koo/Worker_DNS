import { Env, User, ExecutionContext } from "../types";
import { AccessPointModel } from "../models/accessPoint";
import { ProfileModel } from "../models/profile";
import { RBAC } from "../lib/rbac";
import { AP_NAME_REGEX } from "../utils/validator";
import { syncSingleKeyFromDbToDo, upsertAccessKeysInDo } from "../lib/accessKeyRegistry";
import { invalidateProfileKeyCache } from "../pipeline/cache";
import { cacheUtils } from "../utils/cache";
import { ensureDemoDataSeeded } from "../lib/demoMode";

/**
 * Evicts a token from local/cluster L1 memory and L2 Web Cache API.
 */
function evictTokenCaches(token: string, ctx: ExecutionContext): void {
  if (!token) return;
  invalidateProfileKeyCache(token);
  const cache = typeof caches !== "undefined" ? (caches as { default?: Cache }).default : null;
  if (cache) {
    ctx.waitUntil(cacheUtils.delete(cache, `doh_key_v1:${token}`));
  }
}

/**
 * Handles user-scoped Access Point requests under `/api/access_points`.
 */
export async function handleAccessPointsRequest(
  request: Request,
  env: Env,
  user: User,
  ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);
  const pathParts = url.pathname.split("/").filter(Boolean); // ['api', 'access_points', apId?, action?]
  const apModel = new AccessPointModel(env.DB);
  const profileModel = new ProfileModel(env.DB);

  // GET /api/access_points or POST /api/access_points
  if (pathParts.length === 2) {
    if (request.method === "GET") {
      await ensureDemoDataSeeded(env, user.id);
      const results = await apModel.getAccessPointsByOwner(user.id);
      return new Response(JSON.stringify(results), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (request.method === "POST") {
      let body: { name?: unknown; profile_id?: unknown };
      try {
        body = (await request.json()) as { name?: unknown; profile_id?: unknown };
      } catch {
        return new Response("Invalid JSON payload", { status: 400 });
      }

      const name = typeof body?.name === "string" ? body.name.trim() : "";
      if (!name) return new Response("Name is required", { status: 400 });
      if (!AP_NAME_REGEX.test(name)) {
        return new Response("Invalid Access Point name format", { status: 400 });
      }

      let boundProfileId: string | null = null;
      if (typeof body.profile_id === "string" && body.profile_id.trim()) {
        const targetProfile = await profileModel.getById(body.profile_id.trim());
        if (!targetProfile || !RBAC.canAccessProfile(user, targetProfile)) {
          return new Response("Profile Not Found", { status: 404 });
        }
        boundProfileId = targetProfile.id;
      }

      const currentAps = await apModel.getAccessPointsByOwner(user.id);
      if (currentAps.some((ap) => ap.name.toLowerCase() === name.toLowerCase())) {
        return new Response("Access Point name already exists", { status: 400 });
      }

      const maxAps = Number(env.MAX_ACCESS_POINTS_PER_PROFILE) || 100;
      if (currentAps.length >= maxAps) {
        return new Response(`Access point limit exceeded (max ${maxAps})`, { status: 400 });
      }

      const created = await apModel.addAccessPointForOwner(user.id, name, boundProfileId);
      ctx.waitUntil(
        upsertAccessKeysInDo(env, [
          {
            accessKey: created.token,
            profileId: boundProfileId || "default",
            ownerId: user.id,
            accessPointId: created.id,
            accessPointName: created.name,
            updatedAt: created.updated_at,
          },
        ])
      );

      return new Response(JSON.stringify(created), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Method Not Allowed", { status: 405 });
  }

  // /api/access_points/:apId/rotate_token
  if (pathParts.length === 4 && pathParts[3] === "rotate_token" && request.method === "POST") {
    const apId = pathParts[2];
    const existing = await apModel.getByIdAndOwner(apId, user.id);
    if (!existing) {
      return new Response("Access Point Not Found", { status: 404 });
    }

    const newToken = await apModel.rotateAccessPointTokenByOwner(apId, user.id);
    evictTokenCaches(existing.token, ctx);
    ctx.waitUntil(syncSingleKeyFromDbToDo(env.DB, env, existing.token));
    ctx.waitUntil(syncSingleKeyFromDbToDo(env.DB, env, newToken));

    return new Response(JSON.stringify({ token: newToken }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // /api/access_points/:apId
  if (pathParts.length === 3) {
    const apId = pathParts[2];
    const existing = await apModel.getByIdAndOwner(apId, user.id);
    if (!existing) {
      return new Response("Access Point Not Found", { status: 404 });
    }

    if (request.method === "PATCH") {
      let body: { name?: unknown; profile_id?: unknown };
      try {
        body = (await request.json()) as { name?: unknown; profile_id?: unknown };
      } catch {
        return new Response("Invalid JSON payload", { status: 400 });
      }

      const updates: { name?: string; profile_id?: string | null } = {};

      if (body.name !== undefined) {
        const trimmedName = typeof body.name === "string" ? body.name.trim() : "";
        if (!trimmedName) return new Response("Name is required", { status: 400 });
        if (!AP_NAME_REGEX.test(trimmedName)) {
          return new Response("Invalid Access Point name format", { status: 400 });
        }
        const currentAps = await apModel.getAccessPointsByOwner(user.id);
        if (
          currentAps.some(
            (ap) => ap.id !== apId && ap.name.toLowerCase() === trimmedName.toLowerCase()
          )
        ) {
          return new Response("Access Point name already exists", { status: 400 });
        }
        updates.name = trimmedName;
      }

      if (body.profile_id !== undefined) {
        if (body.profile_id === null || body.profile_id === "") {
          updates.profile_id = null;
        } else if (typeof body.profile_id === "string") {
          const targetProfile = await profileModel.getById(body.profile_id.trim());
          if (!targetProfile || !RBAC.canAccessProfile(user, targetProfile)) {
            return new Response("Profile Not Found", { status: 404 });
          }
          updates.profile_id = targetProfile.id;
        } else {
          return new Response("Invalid profile_id parameter", { status: 400 });
        }
      }

      if (updates.name === undefined && updates.profile_id === undefined) {
        return new Response("No fields to update", { status: 400 });
      }

      await apModel.updateAccessPointByOwner(apId, user.id, updates);
      evictTokenCaches(existing.token, ctx);
      ctx.waitUntil(syncSingleKeyFromDbToDo(env.DB, env, existing.token));

      const updated = await apModel.getByIdAndOwner(apId, user.id);
      return new Response(JSON.stringify(updated ?? { success: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (request.method === "DELETE") {
      await apModel.deleteAccessPointByOwner(apId, user.id);
      evictTokenCaches(existing.token, ctx);
      ctx.waitUntil(syncSingleKeyFromDbToDo(env.DB, env, existing.token));
      return new Response(null, { status: 204 });
    }

    return new Response("Method Not Allowed", { status: 405 });
  }

  return new Response("Not Found", { status: 404 });
}

import { Env, User, ExecutionContext } from "../../types";
import { AccessPointModel } from "../../models/accessPoint";
import { AP_NAME_REGEX } from "../../utils/validator";
import { syncProfileKeysToDo, syncSingleKeyFromDbToDo, upsertAccessKeysInDo } from "../../lib/accessKeyRegistry";
import { profileKeyMemoryMap } from "../../pipeline/cache";
import { cacheUtils } from "../../utils/cache";

/**
 * Handle access points requests to /api/profiles/:id/access_points
 */
export async function handleProfileAccessPointsRequest(
  request: Request,
  env: Env,
  user: User,
  profileId: string,
  pathParts: string[],
  ctx: ExecutionContext
): Promise<Response> {
  const apModel = new AccessPointModel(env.DB);

  if (request.method === 'GET') {
    const results = await apModel.getAccessPoints(profileId);
    return new Response(JSON.stringify(results), { headers: { 'Content-Type': 'application/json' } });
  }

  if (request.method === 'POST') {
    if (pathParts.length === 6 && pathParts[5] === 'rotate_token') {
      const apId = pathParts[4];
      const existingAps = await apModel.getAccessPoints(profileId);
      const oldAp = existingAps.find(ap => ap.id === apId);
      const newToken = await apModel.rotateAccessPointToken(apId, profileId);
      if (oldAp?.token) {
        profileKeyMemoryMap.delete(oldAp.token);
        const cache = typeof caches !== 'undefined' ? (caches as any).default : null;
        if (cache) {
          ctx.waitUntil(cacheUtils.delete(cache, `doh_key_v1:${oldAp.token}`));
        }
        ctx.waitUntil(syncSingleKeyFromDbToDo(env.DB, env, oldAp.token));
      }
      ctx.waitUntil(syncProfileKeysToDo(env.DB, env, profileId));
      return new Response(JSON.stringify({ token: newToken }), { headers: { 'Content-Type': 'application/json' } });
    }

    const body = await request.json() as { name: string };
    if (!body.name) return new Response("Name is required", { status: 400 });
    if (!AP_NAME_REGEX.test(body.name)) return new Response("Invalid Access Point name format", { status: 400 });
    
    const currentAps = await apModel.getAccessPoints(profileId);
    if (currentAps.some(ap => ap.name.toLowerCase() === body.name.toLowerCase())) {
      return new Response("Access Point name already exists", { status: 400 });
    }
    const maxAps = Number(env.MAX_ACCESS_POINTS_PER_PROFILE) || 100;
    if (currentAps.length >= maxAps) return new Response(`Access point limit exceeded (max ${maxAps})`, { status: 400 });
    
    const result = await apModel.addAccessPoint(profileId, body.name);
    ctx.waitUntil(
      upsertAccessKeysInDo(env, [
        {
          accessKey: result.token,
          profileId,
          ownerId: user.id,
          accessPointId: result.id,
          accessPointName: result.name,
          updatedAt: result.updated_at || Math.floor(Date.now() / 1000)
        }
      ])
    );
    return new Response(JSON.stringify(result), { status: 201, headers: { 'Content-Type': 'application/json' } });
  }

  if (request.method === 'PATCH' && pathParts.length === 5) {
    const apId = pathParts[4];
    const body = await request.json() as { name: string };
    if (!body.name) return new Response("Name is required", { status: 400 });
    if (!AP_NAME_REGEX.test(body.name)) return new Response("Invalid Access Point name format", { status: 400 });

    const currentAps = await apModel.getAccessPoints(profileId);
    if (currentAps.some(ap => ap.id !== apId && ap.name.toLowerCase() === body.name.toLowerCase())) {
      return new Response("Access Point name already exists", { status: 400 });
    }

    await apModel.updateAccessPointName(apId, profileId, body.name);
    const updatedAp = currentAps.find(ap => ap.id === apId);
    if (updatedAp?.token) {
      profileKeyMemoryMap.delete(updatedAp.token);
      ctx.waitUntil(syncSingleKeyFromDbToDo(env.DB, env, updatedAp.token));
    }
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (request.method === 'DELETE' && pathParts.length === 5) {
    const apId = pathParts[4];
    const currentAps = await apModel.getAccessPoints(profileId);
    const targetAp = currentAps.find(ap => ap.id === apId);
    await apModel.deleteAccessPoint(apId, profileId);
    if (targetAp?.token) {
      profileKeyMemoryMap.delete(targetAp.token);
      const cache = typeof caches !== 'undefined' ? (caches as any).default : null;
      if (cache) {
        ctx.waitUntil(cacheUtils.delete(cache, `doh_key_v1:${targetAp.token}`));
      }
      ctx.waitUntil(syncSingleKeyFromDbToDo(env.DB, env, targetAp.token));
    }
    return new Response(null, { status: 204 });
  }

  return new Response("Method Not Allowed", { status: 405 });
}

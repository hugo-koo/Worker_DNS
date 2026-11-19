import { Env, User, ExecutionContext } from './types';
import { ScheduledEvent } from '@cloudflare/workers-types';
import { handleScheduled } from './cron';
import { isTursoConfigured, getTursoDatabase, getDatabaseService, ensureTursoMigrations } from './lib/turso';
import { cacheUtils } from './utils/cache';
import { detectServerfullMode, finalizeResponse, routeRequest } from './router';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    cacheUtils.setOrigin(new URL(request.url).origin);
    const isServerfull = detectServerfullMode(env);
    const dbService = getDatabaseService(env, isServerfull);
    if (dbService === 'Turso' && isTursoConfigured(env)) {
      env.DB = getTursoDatabase(env);
    }

    const nonceBytes = new Uint8Array(16);
    crypto.getRandomValues(nonceBytes);
    const nonce = Array.from(nonceBytes).map((b) => b.toString(16).padStart(2, '0')).join('');

    let currentUser: User | null = null;
    let response: Response;

    try {
      const routed = await routeRequest(request, env, ctx, { isServerfull, dbService, nonce });
      response = routed.response;
      currentUser = routed.currentUser;
    } catch (fatalErr: unknown) {
      console.error('[Worker Fatal Error]:', fatalErr);
      const isApi = new URL(request.url).pathname.startsWith('/api/');
      if (isApi) {
        return new Response(JSON.stringify({
          error: 'internal_server_error',
          message: 'An unexpected worker error occurred.'
        }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
      return new Response('Internal Server Error', { status: 500 });
    }

    return finalizeResponse(request, response, env, currentUser, nonce);
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (env.SUBSTITUTE_DOMAIN) {
      cacheUtils.setOrigin(`https://${env.SUBSTITUTE_DOMAIN}`);
    }
    const dbService = getDatabaseService(env, false);
    if (dbService === 'Turso' && isTursoConfigured(env)) {
      env.DB = getTursoDatabase(env);
      const cache = typeof caches !== 'undefined' ? (caches as any).default : null;
      const migCacheKey = 'cron:turso_migrations_checked_v1';
      const checkedRecently = cache ? await cacheUtils.get<number>(cache, migCacheKey).catch(() => null) : null;
      if (!checkedRecently) {
        try {
          await ensureTursoMigrations(env.DB as any);
          if (cache) {
            await cacheUtils.set(cache, migCacheKey, Math.floor(Date.now() / 1000), 3600).catch(() => {});
          }
        } catch (err: any) {
          console.warn('[Turso] Scheduled migration check notice:', err.message || err);
        }
      }
    }
    await handleScheduled(event, env, ctx);
  }
};

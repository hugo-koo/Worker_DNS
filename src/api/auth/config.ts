import { Env } from "../../types";
import { UserModel } from "../../models/user";
import { SystemSettingsModel } from "../../models/systemSettings";
import { InviteCodeModel } from "../../models/inviteCode";
import { cacheUtils } from "../../utils/cache";
import { USERNAME_REGEX, normalizeInviteCode } from "../../utils/validator";

/**
 * Handle public authentication configuration and pre-signup validation endpoints.
 */
export async function handleAuthConfigRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const userModel = new UserModel(env.DB, env);

  // 公开配置接口
  if (url.pathname === '/api/auth/config' && request.method === 'GET') {
    const settingsModel = new SystemSettingsModel(env.DB);
    const [
      siteKey,
      signupEnabled,
      loginEnabled,
      userCount,
      registrationEnabled,
      inviteCodeEnabled,
      maxUsersSetting
    ] = await Promise.all([
      settingsModel.get('turnstile_site_key'),
      settingsModel.get('turnstile_enabled_signup'),
      settingsModel.get('turnstile_enabled_login'),
      userModel.count().catch(() => 0),
      settingsModel.get('registration_enabled'),
      settingsModel.get('invite_code_enabled'),
      settingsModel.get('max_users')
    ]);
    const hasUsers = userCount > 0;
    const rawMaxUsers = maxUsersSetting !== null ? maxUsersSetting : env.MAX_USERS;
    const maxUsers = rawMaxUsers !== undefined && rawMaxUsers !== null && rawMaxUsers !== "" ? parseInt(String(rawMaxUsers), 10) : 0;
    const isMaxUsersReached = hasUsers && maxUsers > 0 && userCount >= maxUsers;

    return new Response(JSON.stringify({
      turnstile_site_key: siteKey,
      turnstile_enabled_signup: signupEnabled === 'true',
      turnstile_enabled_login: loginEnabled === 'true',
      optional_session_expiration_days: Number(env.OPTIONAL_SESSION_EXPIRATION_DAYS) || 7,
      has_users: hasUsers,
      registration_enabled: registrationEnabled !== 'false' && !isMaxUsersReached,
      invite_code_enabled: hasUsers && inviteCodeEnabled === 'true',
      max_users: maxUsers > 0 ? maxUsers : null,
      max_users_reached: isMaxUsersReached
    }), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, no-cache'
      }
    });
  }

  // 检查用户名是否存在接口
  if (url.pathname === '/api/auth/check-username' && request.method === 'GET') {
    const username = (url.searchParams.get('username') || '').trim();
    if (!USERNAME_REGEX.test(username)) {
      return new Response(JSON.stringify({ error: "Invalid username" }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    const exists = await userModel.isUsernameConflict(username);
    return new Response(JSON.stringify({ exists }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // 注册阶段邀请码预校验接口（每分钟每 IP 限流 5 次，防止暴力枚举 6 位邀请码）
  if (url.pathname === '/api/auth/check-invite-code' && request.method === 'POST') {
    const cache = typeof caches !== "undefined" ? (caches as any).default : null;
    const clientIp = request.headers.get("CF-Connecting-IP") || "127.0.0.1";
    if (await cacheUtils.isRateLimited(cache, `signup_invite:${clientIp}`, 5, 60)) {
      return new Response("Too many attempts", { status: 429 });
    }

    let body: { inviteCode?: unknown } = {};
    try {
      body = (await request.json()) as { inviteCode?: unknown };
    } catch {
      return new Response("invite_code_invalid", { status: 400 });
    }

    const code = normalizeInviteCode(body.inviteCode);
    if (!code) {
      return new Response("invite_code_required", { status: 400 });
    }

    const inviteModel = new InviteCodeModel(env.DB);
    const check = await inviteModel.validateForSignup(code);
    if (!check.valid) {
      return new Response(check.reason, { status: 400 });
    }

    return new Response(JSON.stringify({ valid: true }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  }

  return new Response("Not Found", { status: 404 });
}

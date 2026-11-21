import { Env, User, ExecutionContext, Rule } from "../../types";
import { RuleModel } from "../../models/rule";
import { pipeline } from "../../pipeline";

/**
 * Normalizes a rule enabled payload value to a strict boolean (defaults to true when omitted).
 */
function normalizeRuleEnabled(value: unknown): boolean {
  return value !== false && value !== 0;
}

/**
 * Handle custom rules requests to /api/profiles/:id/rules
 */
export async function handleProfileRulesRequest(
  request: Request,
  env: Env,
  user: User,
  profileId: string,
  pathParts: string[],
  ctx: ExecutionContext
): Promise<Response> {
  const ruleModel = new RuleModel(env.DB);

  if (request.method === 'GET') {
    const results = await ruleModel.getRules(profileId);
    return new Response(JSON.stringify(results), { headers: { 'Content-Type': 'application/json' } });
  }

  if (request.method === 'POST') {
    const MAX_PROFILE_RULES = 5000;
    const MAX_BULK_RULES = 2000;
    const body = await request.json() as any;

    // Support bulk insertion when body is an array or contains rules array
    const isBulk = Array.isArray(body) || (body && Array.isArray(body.rules));
    if (isBulk) {
      const rawList: any[] = Array.isArray(body) ? body : body.rules;
      if (rawList.length > MAX_BULK_RULES) {
        return new Response(`Bulk request exceeds maximum of ${MAX_BULK_RULES} rules`, { status: 400 });
      }
      const seen = new Set<string>();
      const validRules: Partial<Rule>[] = [];

      for (const r of rawList) {
        if (!r || typeof r.pattern !== 'string') continue;
        const pattern = r.pattern.trim().toLowerCase();
        if (!pattern || pattern.length > 253 || seen.has(pattern)) continue;
        seen.add(pattern);

        const type = String(r.type || 'BLOCK').toUpperCase();
        if (type !== 'ALLOW' && type !== 'BLOCK' && type !== 'REDIRECT') continue;

        validRules.push({
          type: type as 'ALLOW' | 'BLOCK' | 'REDIRECT',
          pattern,
          v_a: r.v_a || null,
          v_aaaa: r.v_aaaa || null,
          v_txt: r.v_txt || null,
          v_cname: r.v_cname || null,
          created_at: typeof r.created_at === 'number' ? r.created_at : undefined,
          include_subdomains: Boolean(r.include_subdomains),
          enabled: normalizeRuleEnabled(r.enabled),
        });
      }

      if (validRules.length === 0) {
        return new Response(JSON.stringify({ count: 0, message: "No valid rules provided" }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const existingRules = await ruleModel.getRules(profileId);
      const existingPatterns = new Set(existingRules.map(r => r.pattern.trim().toLowerCase()));
      const rulesToInsert = validRules.filter(r => !existingPatterns.has(r.pattern!));

      if (existingRules.length + rulesToInsert.length > MAX_PROFILE_RULES) {
        return new Response(`Profile rule limit (${MAX_PROFILE_RULES}) exceeded`, { status: 400 });
      }

      let insertedCount = 0;
      if (rulesToInsert.length > 0) {
        insertedCount = await ruleModel.addRulesBulk(profileId, rulesToInsert);
        ctx.waitUntil(pipeline.clearCache(profileId, false, env));
      }

      return new Response(JSON.stringify({ success: true, count: insertedCount }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const rule = body;
    const pattern = rule.pattern ? String(rule.pattern).trim() : "";
    if (!pattern || pattern.length > 253) {
      return new Response("Domain pattern is invalid or empty", { status: 400 });
    }
    const existingRules = await ruleModel.getRules(profileId);
    if (existingRules.length >= MAX_PROFILE_RULES) {
      return new Response(`Profile rule limit (${MAX_PROFILE_RULES}) exceeded`, { status: 400 });
    }
    const existing = await ruleModel.getRuleByPattern(profileId, pattern);
    if (existing) {
      return new Response("Rule for this domain already exists", { status: 400 });
    }
    rule.include_subdomains = Boolean(rule.include_subdomains);
    rule.enabled = normalizeRuleEnabled(rule.enabled);
    await ruleModel.addRule(profileId, rule);
    ctx.waitUntil(pipeline.clearCache(profileId, false, env));
    return new Response(null, { status: 201 });
  }

  if (request.method === 'PUT') {
    const rule = await request.json() as Partial<Rule> & { id?: number };
    const ruleId = Number(rule.id);
    if (!Number.isInteger(ruleId) || ruleId <= 0) {
      return new Response("Invalid rule id", { status: 400 });
    }
    const pattern = rule.pattern ? rule.pattern.trim() : "";
    if (!pattern) {
      return new Response("Domain pattern cannot be empty", { status: 400 });
    }
    const existing = await ruleModel.getRuleByPatternExcludeId(profileId, pattern, ruleId);
    if (existing) {
      return new Response("Rule for this domain already exists", { status: 400 });
    }
    rule.include_subdomains = Boolean(rule.include_subdomains);
    rule.enabled = normalizeRuleEnabled(rule.enabled);
    await ruleModel.updateRule(ruleId, profileId, rule);
    ctx.waitUntil(pipeline.clearCache(profileId, false, env));
    return new Response(null, { status: 200 });
  }

  if (request.method === 'PATCH') {
    let body: { id?: unknown; ids?: unknown; enabled?: unknown };
    try {
      body = (await request.json()) as { id?: unknown; ids?: unknown; enabled?: unknown };
    } catch {
      return new Response("Invalid JSON payload", { status: 400 });
    }

    if (typeof body?.enabled !== 'boolean' && body?.enabled !== 0 && body?.enabled !== 1) {
      return new Response("Missing or invalid 'enabled' boolean", { status: 400 });
    }
    const enabled = Boolean(body.enabled);

    const MAX_BULK_TOGGLE = 2000;
    let rawIds: unknown[] = [];
    if (Array.isArray(body.ids)) {
      if (body.ids.length === 0) {
        return new Response("Rule ids cannot be empty", { status: 400 });
      }
      if (body.ids.length > MAX_BULK_TOGGLE) {
        return new Response(`Bulk update exceeds maximum of ${MAX_BULK_TOGGLE} rules`, { status: 400 });
      }
      rawIds = body.ids;
    } else if (body.id !== undefined) {
      rawIds = [body.id];
    } else {
      return new Response("Rule id or ids required", { status: 400 });
    }

    const validIds = rawIds
      .map((val) => Number(val))
      .filter((val) => Number.isInteger(val) && val > 0);
    if (validIds.length === 0) {
      return new Response("No valid rule ids provided", { status: 400 });
    }

    const updatedCount = await ruleModel.setRulesEnabledBulk(validIds, profileId, enabled);
    ctx.waitUntil(pipeline.clearCache(profileId, false, env));
    return new Response(JSON.stringify({ success: true, count: updatedCount, enabled }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (request.method === 'DELETE') {
    let body: { id?: unknown; ids?: unknown };
    try {
      body = (await request.json()) as { id?: unknown; ids?: unknown };
    } catch {
      return new Response("Invalid JSON payload", { status: 400 });
    }

    if (Array.isArray(body?.ids)) {
      const MAX_BULK_DELETE = 2000;
      if (body.ids.length === 0) {
        return new Response("Rule ids cannot be empty", { status: 400 });
      }
      if (body.ids.length > MAX_BULK_DELETE) {
        return new Response(`Bulk delete exceeds maximum of ${MAX_BULK_DELETE} rules`, { status: 400 });
      }
      const validIds = body.ids
        .map((val) => Number(val))
        .filter((val) => Number.isInteger(val) && val > 0);
      if (validIds.length === 0) {
        return new Response("No valid rule ids provided", { status: 400 });
      }
      const deletedCount = await ruleModel.deleteRulesBulk(validIds, profileId);
      ctx.waitUntil(pipeline.clearCache(profileId, false, env));
      return new Response(JSON.stringify({ success: true, count: deletedCount }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const ruleId = Number(body?.id);
    if (!Number.isInteger(ruleId) || ruleId <= 0) {
      return new Response("Invalid rule id", { status: 400 });
    }
    await ruleModel.deleteRule(ruleId, profileId);
    ctx.waitUntil(pipeline.clearCache(profileId, false, env));
    return new Response(null, { status: 204 });
  }

  return new Response("Method Not Allowed", { status: 405 });
}

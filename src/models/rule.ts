import { D1Database } from "@cloudflare/workers-types";
import { Rule } from "../types";

export class RuleModel {
  constructor(private db: D1Database) {}

  async getRules(profileId: string): Promise<Rule[]> {
    const { results } = await this.db.prepare("SELECT * FROM rules WHERE profile_id = ? ORDER BY id DESC")
      .bind(profileId)
      .all<Rule>();
    return results;
  }

  async addRule(profileId: string, rule: Partial<Rule>): Promise<boolean> {
    const normalizedPattern = rule.pattern ? rule.pattern.trim().toLowerCase() : "";
    const createdAt = rule.created_at ?? Math.floor(Date.now() / 1000);
    const includeSubdomains = rule.include_subdomains ? 1 : 0;
    const enabled = rule.enabled === false || rule.enabled === 0 ? 0 : 1;
    const result = await this.db.prepare(
      "INSERT INTO rules (profile_id, type, pattern, v_a, v_aaaa, v_txt, v_cname, created_at, include_subdomains, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(profileId, rule.type, normalizedPattern, rule.v_a || null, rule.v_aaaa || null, rule.v_txt || null, rule.v_cname || null, createdAt, includeSubdomains, enabled)
      .run();
    return result.success;
  }

  /**
   * Batch inserts multiple rules for a profile using D1 batch operations.
   * Chunks execution into batches of up to 100 statements to respect D1 limits.
   *
   * @param profileId - Profile identifier.
   * @param rules - Array of partial rules to insert.
   * @returns Total number of rules successfully inserted.
   */
  async addRulesBulk(profileId: string, rules: Partial<Rule>[]): Promise<number> {
    if (!rules || rules.length === 0) return 0;
    const now = Math.floor(Date.now() / 1000);
    const statements = rules.map(rule => {
      const normalizedPattern = rule.pattern ? rule.pattern.trim().toLowerCase() : "";
      const createdAt = rule.created_at ?? now;
      const includeSubdomains = rule.include_subdomains ? 1 : 0;
      const enabled = rule.enabled === false || rule.enabled === 0 ? 0 : 1;
      return this.db.prepare(
        "INSERT INTO rules (profile_id, type, pattern, v_a, v_aaaa, v_txt, v_cname, created_at, include_subdomains, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(
        profileId,
        rule.type,
        normalizedPattern,
        rule.v_a || null,
        rule.v_aaaa || null,
        rule.v_txt || null,
        rule.v_cname || null,
        createdAt,
        includeSubdomains,
        enabled
      );
    });

    let inserted = 0;
    for (let i = 0; i < statements.length; i += 100) {
      const chunk = statements.slice(i, i + 100);
      const results = await this.db.batch(chunk);
      for (const res of results) {
        if (res.success) inserted += res.meta.changes || 1;
      }
    }
    return inserted;
  }

  async updateRule(id: number, profileId: string, rule: Partial<Rule>): Promise<boolean> {
    const normalizedPattern = rule.pattern ? rule.pattern.trim().toLowerCase() : "";
    const includeSubdomains = rule.include_subdomains ? 1 : 0;
    const enabled = rule.enabled === false || rule.enabled === 0 ? 0 : 1;
    const result = await this.db.prepare(
      "UPDATE rules SET type = ?, pattern = ?, v_a = ?, v_aaaa = ?, v_txt = ?, v_cname = ?, include_subdomains = ?, enabled = ? WHERE id = ? AND profile_id = ?"
    )
      .bind(rule.type, normalizedPattern, rule.v_a || null, rule.v_aaaa || null, rule.v_txt || null, rule.v_cname || null, includeSubdomains, enabled, id, profileId)
      .run();
    return result.success;
  }

  /**
   * Enables or disables multiple rules belonging to a profile inside D1 batch chunks (max 100 per batch).
   *
   * @param ids - Rule IDs to toggle.
   * @param profileId - Owner profile identifier.
   * @param enabled - Target active state.
   * @returns Total number of rows updated.
   */
  async setRulesEnabledBulk(ids: number[], profileId: string, enabled: boolean): Promise<number> {
    const uniqueIds = Array.from(new Set(ids.filter((id) => Number.isInteger(id) && id > 0)));
    if (uniqueIds.length === 0) return 0;

    const enabledInt = enabled ? 1 : 0;
    const statements = uniqueIds.map((id) =>
      this.db.prepare("UPDATE rules SET enabled = ? WHERE id = ? AND profile_id = ?").bind(enabledInt, id, profileId)
    );

    let updated = 0;
    for (let i = 0; i < statements.length; i += 100) {
      const chunk = statements.slice(i, i + 100);
      const results = await this.db.batch(chunk);
      for (const res of results) {
        if (res.success) {
          updated += res.meta.changes ?? 0;
        }
      }
    }
    return updated;
  }

  async getRuleByPattern(profileId: string, pattern: string): Promise<Rule | null> {
    return await this.db.prepare("SELECT * FROM rules WHERE profile_id = ? AND LOWER(pattern) = ?")
      .bind(profileId, pattern.trim().toLowerCase())
      .first<Rule | null>();
  }

  async getRuleByPatternExcludeId(profileId: string, pattern: string, id: number): Promise<Rule | null> {
    return await this.db.prepare("SELECT * FROM rules WHERE profile_id = ? AND LOWER(pattern) = ? AND id != ?")
      .bind(profileId, pattern.trim().toLowerCase(), id)
      .first<Rule | null>();
  }

  async deleteRule(id: number, profileId: string): Promise<boolean> {
    const result = await this.db.prepare("DELETE FROM rules WHERE id = ? AND profile_id = ?").bind(id, profileId).run();
    return result.success;
  }

  /**
   * Batch deletes multiple rules belonging to a profile inside D1 batch chunks (max 100 per batch).
   *
   * @param ids - Rule IDs to delete.
   * @param profileId - Owner profile identifier.
   * @returns Total number of rows deleted.
   */
  async deleteRulesBulk(ids: number[], profileId: string): Promise<number> {
    const uniqueIds = Array.from(new Set(ids.filter((id) => Number.isInteger(id) && id > 0)));
    if (uniqueIds.length === 0) return 0;

    const statements = uniqueIds.map((id) =>
      this.db.prepare("DELETE FROM rules WHERE id = ? AND profile_id = ?").bind(id, profileId)
    );

    let deleted = 0;
    for (let i = 0; i < statements.length; i += 100) {
      const chunk = statements.slice(i, i + 100);
      const results = await this.db.batch(chunk);
      for (const res of results) {
        if (res.success) {
          deleted += res.meta.changes ?? 0;
        }
      }
    }
    return deleted;
  }
}

import type { ListMetadataStats } from "../../types";

/**
 * Normalizes a blocklist URL for canonical indexing by trimming
 * whitespace and removing trailing slashes.
 *
 * @param url - Raw blocklist URL string.
 * @returns Canonicalized URL.
 */
export function normalizeListUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * Normalizes an arbitrary timestamp representation into an integer Unix timestamp in seconds.
 * Adheres strictly to the project-wide Timestamp Standardization rule in GEMINI.md.
 *
 * @param val - Timestamp as number, date string, or null/undefined.
 * @returns Integer Unix timestamp in seconds, or null if missing or unparseable.
 */
export function parseUnixTimestamp(val: unknown): number | null {
  if (val === null || val === undefined) return null;
  if (typeof val === "number") {
    return Number.isFinite(val) ? Math.floor(val) : null;
  }
  if (typeof val === "string") {
    const parsed = Date.parse(val);
    return isNaN(parsed) ? null : Math.floor(parsed / 1000);
  }
  return null;
}

/**
 * Safely parses compiled list metadata statistics JSON from `global_list_metadata.stats`.
 *
 * @param val - Raw JSON string or already-parsed object.
 * @returns Validated ListMetadataStats object or null.
 */
export function parseListStats(val: unknown): ListMetadataStats | null {
  if (!val) return null;
  try {
    const obj = typeof val === "string" ? JSON.parse(val) : val;
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    const rec = obj as Record<string, unknown>;
    return {
      total_rules: Number(rec.total_rules) || 0,
      exact_rules: Number(rec.exact_rules) || 0,
      subdomain_rules: Number(rec.subdomain_rules) || 0,
      wildcard_rules: Number(rec.wildcard_rules) || 0,
      regex_rules: Number(rec.regex_rules) || 0,
      exception_rules: Number(rec.exception_rules) || 0,
      rewrite_rules: Number(rec.rewrite_rules) || 0,
      comment_lines: Number(rec.comment_lines) || 0,
      unsupported_lines: Number(rec.unsupported_lines) || 0,
      total_bytes: typeof rec.total_bytes === "number" ? rec.total_bytes : undefined,
      truncated: Boolean(rec.truncated),
    };
  } catch {
    return null;
  }
}

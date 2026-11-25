/**
 * @file sql.ts
 * @description Shared SQL query hardening helpers for parameterized pagination limits and LIKE wildcard escaping.
 */

/**
 * Clamps an untrusted pagination/row limit into `[1, max]`, falling back cleanly on
 * non-finite, NaN, zero, or negative inputs (preventing SQLite `LIMIT -1` unbounded scans).
 *
 * @param limit - Raw limit value from API or caller.
 * @param fallback - Default limit applied when input is missing or `<= 0`.
 * @param max - Upper inclusive bound (default 1000).
 * @returns Sanitized positive integer limit.
 */
export function normalizeBoundedLimit(
  limit: unknown,
  fallback: number = 50,
  max: number = 1000
): number {
  const num = typeof limit === "number" ? limit : Number(limit);
  if (!Number.isFinite(num) || num <= 0) {
    return fallback;
  }
  const intVal = Math.trunc(num);
  if (intVal <= 0) {
    return fallback;
  }
  return Math.min(intVal, max);
}

/**
 * Escapes SQL `LIKE` pattern metacharacters (`\`, `%`, `_`) so user search terms match
 * literally when paired with `ESCAPE '\'`.
 *
 * @param value - Raw substring entered by the caller.
 * @returns Escaped literal substring safe for wrapping in `%...%`.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

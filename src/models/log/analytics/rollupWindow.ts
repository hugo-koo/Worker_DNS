import { D1Database } from "@cloudflare/workers-types";

/**
 * Exact, non-overlapping time window split between raw `logs` and 1-hour `hourly_rollups`.
 */
export interface RollupWindow {
  /** True when at least one complete 1-hour rollup bucket fits strictly within [since, until] and < cutoff. */
  useRollups: boolean;
  /** Inclusive start timestamp (hour-aligned) for `hourly_rollups`. */
  rollupStart: number;
  /** Exclusive end timestamp (hour-aligned) for `hourly_rollups`. */
  rollupEnd: number;
  /** True when a partial leading interval [since, rollupStart - 1] must be read from raw `logs`. */
  hasHeadLogs: boolean;
  /** True when a partial or unaggregated trailing interval [rollupEnd, until] must be read from raw `logs`. */
  hasTailLogs: boolean;
}

export interface SqlPart {
  sql: string;
  params: (string | number)[];
}

/**
 * Computes exact, non-overlapping sub-ranges for combining raw `logs` and
 * 1-hour `hourly_rollups` buckets without counting pre-`since` or post-`until`
 * records inside partial boundary hours.
 *
 * @param since - Inclusive query start timestamp in seconds.
 * @param until - Inclusive query end timestamp in seconds.
 * @param latestRollupHour - Latest `hour_timestamp` present in `hourly_rollups`, or null.
 * @returns RollupWindow describing whether and how to combine rollups with raw logs.
 */
export function computeRollupWindow(
  since: number,
  until: number,
  latestRollupHour: number | null
): RollupWindow {
  const cutoff = latestRollupHour !== null ? latestRollupHour + 3600 : since;
  const rollupStart = Math.ceil(since / 3600) * 3600;
  const untilFullHourEnd = Math.floor((until + 1) / 3600) * 3600;
  const rollupEnd = Math.min(cutoff, untilFullHourEnd);

  if (rollupStart >= rollupEnd) {
    return {
      useRollups: false,
      rollupStart,
      rollupEnd,
      hasHeadLogs: false,
      hasTailLogs: false,
    };
  }

  return {
    useRollups: true,
    rollupStart,
    rollupEnd,
    hasHeadLogs: since < rollupStart,
    hasTailLogs: rollupEnd <= until,
  };
}

/**
 * Assembles the UNION ALL subquery parts and bound parameters for a RollupWindow.
 *
 * @param since - Inclusive query start timestamp in seconds.
 * @param until - Inclusive query end timestamp in seconds.
 * @param window - Computed RollupWindow.
 * @param buildRollupPart - Builder for the interior `hourly_rollups` query [startHour, endHour).
 * @param buildLogPart - Builder for a raw `logs` query [fromTs, toTs].
 * @returns Combined UNION ALL SQL string and ordered bind parameters.
 */
export function buildRollupUnionParts(
  since: number,
  until: number,
  window: RollupWindow,
  buildRollupPart: (startHour: number, endHourExclusive: number) => SqlPart,
  buildLogPart: (fromTs: number, toTsInclusive: number) => SqlPart,
  options?: { skipTailLogs?: boolean }
): SqlPart {
  const parts: SqlPart[] = [];

  if (window.hasHeadLogs) {
    parts.push(buildLogPart(since, window.rollupStart - 1));
  }

  parts.push(buildRollupPart(window.rollupStart, window.rollupEnd));

  if (window.hasTailLogs && !options?.skipTailLogs) {
    parts.push(buildLogPart(window.rollupEnd, until));
  }

  return {
    sql: parts.map((p) => p.sql).join("\nUNION ALL\n"),
    params: parts.flatMap((p) => p.params),
  };
}

/**
 * Performs a 1-row indexed check to determine whether E2EE log encryption is currently active
 * for a profile. Used to short-circuit raw `logs` full-table scans on plaintext-only analytics
 * (domains, clients, destinations, ISPs) when logs are end-to-end encrypted.
 *
 * @param db - D1Database instance.
 * @param profileId - Profile identifier.
 * @returns True if the profile currently has an active E2EE public key.
 */
export async function hasActiveE2eeKey(
  db: D1Database,
  profileId: string
): Promise<boolean> {
  try {
    const row = await db
      .prepare("SELECT 1 FROM user_log_keys WHERE profile_id = ? AND (is_active IS NULL OR is_active = 1) LIMIT 1")
      .bind(profileId)
      .first();
    return row !== null;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("no such column: is_active")) {
      try {
        const row = await db
          .prepare("SELECT 1 FROM user_log_keys WHERE profile_id = ? LIMIT 1")
          .bind(profileId)
          .first();
        return row !== null;
      } catch {
        return false;
      }
    }
    return false;
  }
}

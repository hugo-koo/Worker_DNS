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
  buildLogPart: (fromTs: number, toTsInclusive: number) => SqlPart
): SqlPart {
  const parts: SqlPart[] = [];

  if (window.hasHeadLogs) {
    parts.push(buildLogPart(since, window.rollupStart - 1));
  }

  parts.push(buildRollupPart(window.rollupStart, window.rollupEnd));

  if (window.hasTailLogs) {
    parts.push(buildLogPart(window.rollupEnd, until));
  }

  return {
    sql: parts.map((p) => p.sql).join("\nUNION ALL\n"),
    params: parts.flatMap((p) => p.params),
  };
}

import type { PresetTimeRange, TimeRange } from "../../types";

export interface TimeBoundaries {
  since: number;
  until: number;
}

const PRESET_DURATION_SECONDS: Record<PresetTimeRange, number> = {
  "10m": 600,
  "1h": 3600,
  "24h": 86400,
  "7d": 604800,
  "30d": 2592000,
};

/**
 * Returns the duration in seconds represented by a preset log time range.
 *
 * @param range - Preset time range (`10m`, `1h`, `24h`, `7d`, or `30d`).
 * @returns Window duration in seconds.
 */
export function getRangeDurationSeconds(range: PresetTimeRange): number {
  return PRESET_DURATION_SECONDS[range] ?? 3600;
}

/**
 * Formats a millisecond timestamp as a local `datetime-local` input string (`YYYY-MM-DDTHH:mm`).
 *
 * @param ms - Timestamp in milliseconds.
 * @returns Formatted local date-time string.
 */
export function formatDateTimeLocal(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Computes `{ start, end }` `datetime-local` strings from a cutoff end time
 * and the selected preset window duration (`start = end - duration(baseRange)`).
 *
 * @param endInput - Cutoff time string parseable by `Date`.
 * @param baseRange - Active preset window duration.
 * @returns Computed `{ start, end }` strings, or `null` if `endInput` is invalid.
 */
export function buildCustomRangeFromEnd(
  endInput: string,
  baseRange: PresetTimeRange
): { start: string; end: string } | null {
  if (!endInput) return null;
  const endMs = new Date(endInput).getTime();
  if (Number.isNaN(endMs)) return null;

  const durationMs = getRangeDurationSeconds(baseRange) * 1000;
  const startMs = endMs - durationMs;
  return {
    start: formatDateTimeLocal(startMs),
    end: formatDateTimeLocal(endMs),
  };
}

/**
 * Calculates Unix timestamp boundaries (in seconds) for a given time range or custom date range.
 */
export function calculateTimeBoundaries(
  range: TimeRange,
  customRange: { start: string; end: string }
): TimeBoundaries {
  const now = Math.floor(Date.now() / 1000);

  if (range === "custom" && customRange.start && customRange.end) {
    const since = Math.floor(new Date(customRange.start).getTime() / 1000);
    const until = Math.floor(new Date(customRange.end).getTime() / 1000);
    return { since, until };
  }

  const duration = range === "custom" ? 3600 : getRangeDurationSeconds(range);
  return { since: now - duration, until: now };
}

import React, { useState } from "react";
import { ButtonGroup, Button, PopoverNext, H5, FormGroup, InputGroup, Intent } from "@blueprintjs/core";
import { Calendar } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PresetTimeRange, TimeRange } from "../types";
import { buildCustomRangeFromEnd } from "../hooks/logData/timeBoundaries";

/**
 * Properties for the TimeRangeSelector component.
 */
export interface TimeRangeSelectorProps {
  /** Active query range (`10m`..`30d` or `custom`). */
  range: TimeRange;
  /** Last selected preset range duration used to compute custom `start` from `end`. */
  baseRange: PresetTimeRange;
  /** Callback to update the active range. */
  setRange: (r: TimeRange) => void;
  /** Custom range `{ start, end }` in `datetime-local` format. */
  customRange: { start: string; end: string };
  /** Callback to update `customRange`. */
  setCustomRange: (cr: { start: string; end: string }) => void;
  /** Current timestamp formatted as `YYYY-MM-DDTHH:mm` for max bound & default input. */
  nowStr: string;
  /** Callback to re-fetch logs when re-applying unchanged custom bounds. */
  fetchLogs: (range: TimeRange, initial: boolean) => void;
  /** Whether the viewport is mobile. */
  isMobile: boolean;
  /** Maximum configured log retention days for the profile. */
  logRetentionDays: number;
}

const RANGE_PRESETS: ReadonlyArray<{ key: PresetTimeRange; days: number }> = [
  { key: "10m", days: 0.007 },
  { key: "1h", days: 0.0416 },
  { key: "24h", days: 1 },
  { key: "7d", days: 7 },
  { key: "30d", days: 30 },
];

function formatDisplayWindow(range: { start: string; end: string }): string {
  return `${range.start.replace("T", " ")} ~ ${range.end.replace("T", " ")}`;
}

/**
 * TimeRangeSelector renders preset time window buttons and a single-input
 * custom cutoff time popover whose start time is derived from the active preset duration.
 */
export const TimeRangeSelector: React.FC<TimeRangeSelectorProps> = ({
  range,
  baseRange,
  setRange,
  customRange,
  setCustomRange,
  nowStr,
  fetchLogs,
  isMobile,
  logRetentionDays,
}) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [endDraft, setEndDraft] = useState<string>(customRange.end || nowStr);

  const visibleRanges = RANGE_PRESETS
    .filter((r) => r.days <= logRetentionDays)
    .map((r) => r.key);

  const effectiveEnd = endDraft || nowStr;
  const previewRange = buildCustomRangeFromEnd(effectiveEnd, baseRange);

  const handlePopoverInteraction = (nextOpen: boolean): void => {
    if (nextOpen) {
      setEndDraft(customRange.end || nowStr);
    }
    setIsOpen(nextOpen);
  };

  const handleApply = (e: React.FormEvent): void => {
    e.preventDefault();
    const computed = buildCustomRangeFromEnd(effectiveEnd, baseRange);
    if (!computed) return;

    const isUnchanged =
      range === "custom" &&
      customRange.start === computed.start &&
      customRange.end === computed.end;

    setCustomRange(computed);
    setRange("custom");
    setIsOpen(false);

    if (isUnchanged) {
      fetchLogs("custom", true);
    }
  };

  const handleResetToPreset = (): void => {
    setRange(baseRange);
    setIsOpen(false);
  };

  return (
    <div className="overflow-x-auto pb-1 -mx-4 px-4 md:mx-0 md:px-0">
      <ButtonGroup minimal={isMobile} variant={isMobile ? undefined : "minimal"}>
        {visibleRanges.map((r) => (
          <Button
            key={r}
            active={range === r || (range === "custom" && baseRange === r)}
            onClick={() => setRange(r)}
            text={r.toUpperCase()}
            small={isMobile}
          />
        ))}
        <PopoverNext
          isOpen={isOpen}
          onInteraction={handlePopoverInteraction}
          content={
            <form className="p-4 space-y-3 w-72" onSubmit={handleApply}>
              <H5 className="m-0">{t("analytics.customRange")}</H5>
              <FormGroup
                label={t("analytics.endTime")}
                helperText={t("logs.customEndHint", {
                  range: baseRange.toUpperCase(),
                  defaultValue: "Start time is set to {{range}} before the end time.",
                })}
                className="mb-0!"
              >
                <InputGroup
                  type="datetime-local"
                  max={nowStr}
                  value={endDraft}
                  onChange={(e) => setEndDraft(e.target.value)}
                />
              </FormGroup>
              {previewRange && (
                <div className="rounded-md bg-gray-100/80 dark:bg-gray-800/80 border border-gray-200/70 dark:border-gray-700/70 px-2.5 py-1.5 text-[11px] font-mono text-gray-600 dark:text-gray-300 text-center">
                  {formatDisplayWindow(previewRange)}
                </div>
              )}
              <div className="flex items-center gap-2 pt-1">
                {range === "custom" && (
                  <Button
                    type="button"
                    text={t("logs.resetCustomRange", "Reset")}
                    onClick={handleResetToPreset}
                  />
                )}
                <Button
                  type="submit"
                  fill
                  intent={Intent.PRIMARY}
                  disabled={!previewRange}
                  text={t("analytics.apply")}
                />
              </div>
            </form>
          }
        >
          <Button
            active={range === "custom"}
            icon={<Calendar size={14} />}
            text={isMobile ? "" : t("analytics.custom")}
            small={isMobile}
          />
        </PopoverNext>
      </ButtonGroup>
    </div>
  );
};

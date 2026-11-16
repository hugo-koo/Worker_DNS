import React, { useEffect, useState } from "react";
import {
  Card,
  Elevation,
  H5,
  Switch,
  Button,
  InputGroup,
  Tag,
  Intent,
  Callout,
} from "@blueprintjs/core";
import { PauseCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PauseFilteringSettings, ProfileSettings } from "../types";

export interface PauseFilteringCardProps {
  settings: ProfileSettings;
  setSettings: (settings: ProfileSettings) => void;
}

const DEFAULT_DURATION_SECONDS = 5 * 60;
const MAX_HOURS = 99;
const MAX_MINUTES = 59;

function formatRemainingTime(remainingSec: number): string {
  const safe = Math.max(0, Math.floor(remainingSec));
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hrs > 0 ? `${pad(hrs)}:${pad(mins)}:${pad(secs)}` : `${pad(mins)}:${pad(secs)}`;
}

/**
 * Renders the "Pause Filtering" settings card allowing users to temporarily bypass
 * filter lists, custom rules, and block policies with an hour/minute time limit.
 */
export const PauseFilteringCard: React.FC<PauseFilteringCardProps> = ({
  settings,
  setSettings,
}) => {
  const { t } = useTranslation();
  const [nowSec, setNowSec] = useState<number>(() => Math.floor(Date.now() / 1000));

  const stored = settings.pause_filtering;
  const durationSeconds =
    typeof stored?.duration_seconds === "number" &&
    Number.isFinite(stored.duration_seconds) &&
    stored.duration_seconds >= 0
      ? Math.floor(stored.duration_seconds)
      : DEFAULT_DURATION_SECONDS;

  const hours = Math.min(MAX_HOURS, Math.floor(durationSeconds / 3600));
  const minutes = Math.min(MAX_MINUTES, Math.floor((durationSeconds % 3600) / 60));

  const rawEnabled = Boolean(stored?.enabled);
  const expiresAt = typeof stored?.expires_at === "number" ? stored.expires_at : 0;
  const isExpired = rawEnabled && expiresAt > 0 && nowSec >= expiresAt;
  const isActivelyPaused = rawEnabled && !isExpired;
  const remainingSec = isActivelyPaused && expiresAt > 0 ? Math.max(0, expiresAt - nowSec) : 0;

  useEffect(() => {
    if (!rawEnabled || expiresAt <= 0) return;
    const timer = setInterval(() => {
      setNowSec(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [rawEnabled, expiresAt]);

  const applyPauseSettings = (next: PauseFilteringSettings) => {
    setSettings({
      ...settings,
      pause_filtering: next,
    });
  };

  const handleToggle = (checked: boolean) => {
    const currentNow = Math.floor(Date.now() / 1000);
    setNowSec(currentNow);
    applyPauseSettings({
      enabled: checked,
      duration_seconds: durationSeconds,
      expires_at: checked && durationSeconds > 0 ? currentNow + durationSeconds : 0,
    });
  };

  const updateDuration = (nextHours: number, nextMinutes: number) => {
    const clampedH = Math.max(0, Math.min(MAX_HOURS, Math.floor(nextHours)));
    const clampedM = Math.max(0, Math.min(MAX_MINUTES, Math.floor(nextMinutes)));
    const nextDuration = clampedH * 3600 + clampedM * 60;
    const currentNow = Math.floor(Date.now() / 1000);
    setNowSec(currentNow);

    applyPauseSettings({
      enabled: isActivelyPaused,
      duration_seconds: nextDuration,
      expires_at: isActivelyPaused && nextDuration > 0 ? currentNow + nextDuration : 0,
    });
  };

  return (
    <Card elevation={Elevation.ONE} className="dark:bg-gray-900 dark:border-gray-800">
      <div className="flex items-center justify-between gap-3 mb-2">
        <H5 className="flex items-center gap-2 m-0 font-bold text-orange-600 dark:text-orange-400">
          <PauseCircle size={18} /> {t("settings.pauseFilteringTitle", "停用过滤")}
        </H5>
        <div className="flex items-center gap-2 shrink-0">
          {isActivelyPaused && (
            <Tag minimal intent={Intent.WARNING} className="font-mono text-xs">
              {expiresAt > 0
                ? formatRemainingTime(remainingSec)
                : t("settings.pauseIndefiniteBadge", "持续停用")}
            </Tag>
          )}
          <Switch
            className="m-0"
            checked={isActivelyPaused}
            onChange={(e) => handleToggle((e.target as HTMLInputElement).checked)}
          />
        </div>
      </div>

      <p className="text-xs opacity-70 mb-4">
        {t(
          "settings.pauseFilteringDesc",
          "启用后将停用所有过滤列表、自定义规则与默认拦截策略，DNS 请求直接流向上游服务器。"
        )}
      </p>

      <div className="space-y-3">
        <div className="text-xs font-medium opacity-80">
          {t("settings.pauseTimeLimitLabel", "时间限制（默认 5 分钟）")}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="p-2.5 rounded-lg bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-800 space-y-1.5">
            <div className="text-xs opacity-70">{t("settings.hoursUnit", "小时")}</div>
            <div className="flex items-center gap-1">
              <Button
                icon="minus"
                minimal
                small
                disabled={hours <= 0}
                onClick={() => updateDuration(hours - 1, minutes)}
              />
              <InputGroup
                type="number"
                min={0}
                max={MAX_HOURS}
                step={1}
                small
                className="flex-1 text-center font-mono"
                value={String(hours)}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  if (Number.isFinite(val)) updateDuration(val, minutes);
                }}
              />
              <Button
                icon="plus"
                minimal
                small
                disabled={hours >= MAX_HOURS}
                onClick={() => updateDuration(hours + 1, minutes)}
              />
            </div>
          </div>

          <div className="p-2.5 rounded-lg bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-800 space-y-1.5">
            <div className="text-xs opacity-70">{t("settings.minutesUnit", "分钟")}</div>
            <div className="flex items-center gap-1">
              <Button
                icon="minus"
                minimal
                small
                disabled={minutes <= 0}
                onClick={() => updateDuration(hours, minutes - 1)}
              />
              <InputGroup
                type="number"
                min={0}
                max={MAX_MINUTES}
                step={1}
                small
                className="flex-1 text-center font-mono"
                value={String(minutes)}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  if (Number.isFinite(val)) updateDuration(hours, val);
                }}
              />
              <Button
                icon="plus"
                minimal
                small
                disabled={minutes >= MAX_MINUTES}
                onClick={() => updateDuration(hours, minutes + 1)}
              />
            </div>
          </div>
        </div>

        {isActivelyPaused && (
          <Callout intent={Intent.WARNING} className="text-xs py-2">
            {expiresAt > 0
              ? t(
                  "settings.pauseActiveCountdown",
                  "当前已停用所有过滤规则，将在 {{time}} 后自动恢复。",
                  { time: formatRemainingTime(remainingSec) }
                )
              : t(
                  "settings.pauseActiveIndefinite",
                  "当前已停用所有过滤规则（无时间限制，需手动关闭开关恢复）。"
                )}
          </Callout>
        )}

        {!isActivelyPaused && durationSeconds === 0 && (
          <div className="text-xs opacity-60">
            {t(
              "settings.pauseZeroDurationHint",
              "提示：0 小时 0 分钟表示持续停用，直到手动关闭开关。"
            )}
          </div>
        )}
      </div>
    </Card>
  );
};

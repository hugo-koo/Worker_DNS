import React, { useState } from "react";
import { Card, Elevation, H5, Switch, InputGroup, Tag, Intent } from "@blueprintjs/core";
import { Clock } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ProfileSettings, TtlOverrideRule, TtlOverrideSettings } from "../types";

export interface TtlOverrideCardProps {
  settings: ProfileSettings;
  setSettings: (settings: ProfileSettings) => void;
}

type TtlActionKey = keyof TtlOverrideSettings;

interface TtlRowConfig {
  key: TtlActionKey;
  code: "PASS" | "REDIRECT" | "BLOCK";
  intent: Intent;
  defaultTtl: number;
  labelKey: string;
  defaultLabel: string;
}

const TTL_ROWS: TtlRowConfig[] = [
  {
    key: "pass",
    code: "PASS",
    intent: Intent.SUCCESS,
    defaultTtl: 5,
    labelKey: "settings.ttlPassLabel",
    defaultLabel: "PASS",
  },
  {
    key: "redirect",
    code: "REDIRECT",
    intent: Intent.PRIMARY,
    defaultTtl: 5,
    labelKey: "settings.ttlRedirectLabel",
    defaultLabel: "REDIRECT",
  },
  {
    key: "block",
    code: "BLOCK",
    intent: Intent.DANGER,
    defaultTtl: 5,
    labelKey: "settings.ttlBlockLabel",
    defaultLabel: "BLOCK",
  },
];

const MAX_DNS_TTL = 86400;

/**
 * Renders the TTL Override settings card allowing per-action (PASS / REDIRECT / BLOCK)
 * DNS response TTL overrides in seconds.
 */
export const TtlOverrideCard: React.FC<TtlOverrideCardProps> = ({ settings, setSettings }) => {
  const { t } = useTranslation();

  const getRule = (key: TtlActionKey, defaultTtl: number): TtlOverrideRule => {
    const existing = settings.ttl_override?.[key];
    return {
      enabled: Boolean(existing?.enabled),
      ttl:
        typeof existing?.ttl === "number" && Number.isFinite(existing.ttl) && existing.ttl >= 0
          ? Math.min(MAX_DNS_TTL, Math.floor(existing.ttl))
          : defaultTtl,
    };
  };

  const [focusedKey, setFocusedKey] = useState<TtlActionKey | null>(null);
  const [draftValue, setDraftValue] = useState<string>("");

  const updateRule = (key: TtlActionKey, nextRule: TtlOverrideRule) => {
    setSettings({
      ...settings,
      ttl_override: {
        ...settings.ttl_override,
        [key]: nextRule,
      },
    });
  };

  const handleToggle = (row: TtlRowConfig, checked: boolean) => {
    const current = getRule(row.key, row.defaultTtl);
    updateRule(row.key, {
      enabled: checked,
      ttl: current.ttl,
    });
  };

  const handleInputFocus = (row: TtlRowConfig) => {
    const current = getRule(row.key, row.defaultTtl);
    setFocusedKey(row.key);
    setDraftValue(String(current.ttl));
  };

  const handleInputChange = (row: TtlRowConfig, rawValue: string) => {
    setDraftValue(rawValue);

    if (rawValue.trim() === "") return;
    const parsed = Number(rawValue);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_DNS_TTL) return;

    const current = getRule(row.key, row.defaultTtl);
    updateRule(row.key, {
      enabled: current.enabled,
      ttl: parsed,
    });
  };

  const handleInputBlur = (row: TtlRowConfig) => {
    const raw = draftValue.trim();
    const parsed = Number(raw);
    const current = getRule(row.key, row.defaultTtl);

    if (raw !== "" && Number.isFinite(parsed)) {
      const clamped = Math.max(0, Math.min(MAX_DNS_TTL, Math.floor(parsed)));
      if (clamped !== current.ttl) {
        updateRule(row.key, {
          enabled: current.enabled,
          ttl: clamped,
        });
      }
    }
    setFocusedKey(null);
  };

  return (
    <Card elevation={Elevation.ONE} className="dark:bg-gray-900 dark:border-gray-800">
      <H5 className="flex items-center gap-2 mb-2 font-bold text-amber-600 dark:text-amber-400">
        <Clock size={18} /> {t("settings.ttlOverrideTitle", "TTL 重写")}
      </H5>
      <p className="text-xs opacity-70 mb-4">
        {t(
          "settings.ttlOverrideDesc",
          "按解析结果类型重写返回的 DNS 记录 TTL（支持 0 - {{max}} 秒，0 表示不缓存）。",
          { max: MAX_DNS_TTL }
        )}
      </p>

      <div className="space-y-3">
        {TTL_ROWS.map((row) => {
          const rule = getRule(row.key, row.defaultTtl);
          return (
            <div
              key={row.key}
              className="p-3 rounded-lg bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-800 space-y-2.5"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Tag minimal intent={row.intent} className="font-mono text-[11px] font-semibold">
                    {row.code}
                  </Tag>
                  <span className="text-sm font-medium truncate">
                    {t(row.labelKey, row.defaultLabel)}
                  </span>
                </div>
                <Switch
                  className="m-0 shrink-0"
                  checked={rule.enabled}
                  onChange={(e) => handleToggle(row, (e.target as HTMLInputElement).checked)}
                />
              </div>

              <InputGroup
                type="number"
                min={0}
                max={MAX_DNS_TTL}
                step={1}
                disabled={!rule.enabled}
                value={focusedKey === row.key ? draftValue : String(rule.ttl)}
                onFocus={() => handleInputFocus(row)}
                onChange={(e) => handleInputChange(row, e.target.value)}
                onBlur={() => handleInputBlur(row)}
                placeholder={String(row.defaultTtl)}
                rightElement={
                  <Tag minimal className="mr-1 font-mono text-xs">
                    {t("settings.secondsUnit", "秒")}
                  </Tag>
                }
              />
            </div>
          );
        })}
      </div>
    </Card>
  );
};

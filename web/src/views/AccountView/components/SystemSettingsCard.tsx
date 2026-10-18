import React, { useState, useEffect, useCallback } from "react";
import { Card, Elevation, H4, FormGroup, InputGroup, Switch, Divider, Button, Intent, Tag, Spinner } from "@blueprintjs/core";
import { Settings, Database } from "lucide-react";
import { useTranslation } from "react-i18next";

import { updateSystemSettings, getDatabaseSize, type DatabaseSizeInfo } from "../../../services";

export interface SystemSettingsCardProps {
  initialSettings: Record<string, string>;
  onRefresh: () => void;
  refreshDbSizeTrigger?: number;
}

export const SystemSettingsCard: React.FC<SystemSettingsCardProps> = ({
  initialSettings,
  onRefresh,
  refreshDbSizeTrigger
}) => {
  const { t } = useTranslation();
  const [sysSettings, setSysSettings] = useState<Record<string, string>>(initialSettings);
  const [sysLoading, setSysLoading] = useState(false);
  const [showTurnstileSecretKey, setShowTurnstileSecretKey] = useState(false);
  const [dbSize, setDbSize] = useState<DatabaseSizeInfo | null>(null);
  const [loadingSize, setLoadingSize] = useState<boolean>(true);

  const fetchDbSize = useCallback(async () => {
    setLoadingSize(true);
    try {
      const data = await getDatabaseSize();
      setDbSize(data);
    } catch (e) {
      console.error("Failed to fetch database size:", e);
    } finally {
      setLoadingSize(false);
    }
  }, []);

  useEffect(() => {
    fetchDbSize();
  }, [fetchDbSize, refreshDbSizeTrigger]);

  useEffect(() => {
    setSysSettings(initialSettings);
  }, [initialSettings]);

  const handleSaveSysSettings = async () => {
    setSysLoading(true);
    try {
      await updateSystemSettings({
        turnstile_site_key: sysSettings.turnstile_site_key || "",
        turnstile_secret_key: sysSettings.turnstile_secret_key || "",
        turnstile_enabled_signup: sysSettings.turnstile_enabled_signup || "false",
        turnstile_enabled_login: sysSettings.turnstile_enabled_login || "false",
      });
      alert(t("common.saveSuccess", "Settings saved"));
      onRefresh();
    } catch (e) {
      console.error(e);
    } finally {
      setSysLoading(false);
    }
  };

  return (
    <>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Settings size={20} className="text-gray-500" />
          <H4 style={{ margin: 0 }}>{t("account.systemSettings", "System Settings")}</H4>
        </div>
        <div className="flex items-center gap-2 bg-gray-50 dark:bg-gray-800 px-2.5 py-1 rounded border border-gray-200 dark:border-gray-700 text-xs">
          <Database size={14} className="text-gray-500 flex-shrink-0" />
          <span className="text-gray-700 dark:text-gray-300 font-medium">
            {t("account.currentDbSize")}:
          </span>
          {loadingSize ? (
            <Spinner size={12} />
          ) : (
            <Tag
              minimal
              round
              intent={Intent.PRIMARY}
              className="font-mono font-semibold"
            >
              {dbSize?.formatted || "0 B"}
            </Tag>
          )}
          <Button
            minimal
            small
            icon="refresh"
            loading={loadingSize}
            onClick={fetchDbSize}
            title={t("common.refresh") || "Refresh"}
          />
        </div>
      </div>
      <Card elevation={Elevation.ONE}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
          <div className="space-y-4">
            <H4 className="text-sm font-bold opacity-70 text-blue-500">Cloudflare Turnstile</H4>
            <FormGroup label="Site Key">
              <InputGroup
                value={sysSettings.turnstile_site_key || ""}
                onChange={(e) => setSysSettings({ ...sysSettings, turnstile_site_key: e.target.value })}
                placeholder="0x000..."
              />
            </FormGroup>
            <FormGroup label="Secret Key">
              <InputGroup
                type={showTurnstileSecretKey ? "text" : "password"}
                value={sysSettings.turnstile_secret_key || ""}
                onChange={(e) => setSysSettings({ ...sysSettings, turnstile_secret_key: e.target.value })}
                placeholder="0x000..."
                rightElement={
                  <Button
                    minimal={true}
                    icon={showTurnstileSecretKey ? "eye-open" : "eye-off"}
                    onClick={() => setShowTurnstileSecretKey(!showTurnstileSecretKey)}
                    title={showTurnstileSecretKey ? t("auth.hidePassword", "Hide password") : t("auth.showPassword", "Show password")}
                  />
                }
              />
            </FormGroup>
          </div>
          <div className="space-y-4">
            <H4 className="text-sm font-bold opacity-70 text-green-500">
              {t("account.featureToggle", "Feature Toggle")}
            </H4>
            <Switch
              label={t("account.enableTurnstileSignup", "Enable verification on Signup")}
              checked={sysSettings.turnstile_enabled_signup === "true"}
              onChange={(e) =>
                setSysSettings({ ...sysSettings, turnstile_enabled_signup: String(e.currentTarget.checked) })
              }
            />
            <Switch
              label={t("account.enableTurnstileLogin", "Enable verification on Login")}
              checked={sysSettings.turnstile_enabled_login === "true"}
              onChange={(e) =>
                setSysSettings({ ...sysSettings, turnstile_enabled_login: String(e.currentTarget.checked) })
              }
            />
          </div>
        </div>
        <Divider className="my-4" />
        <div className="flex justify-end">
          <Button
            intent={Intent.PRIMARY}
            icon="floppy-disk"
            text={t("common.save", "Save")}
            loading={sysLoading}
            onClick={handleSaveSysSettings}
          />
        </div>
      </Card>
    </>
  );
};

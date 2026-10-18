import React, { useState } from "react";
import { Card, Elevation, H4, Button, Intent, Callout } from "@blueprintjs/core";
import { Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { clearLogs, deleteMe } from "../../../services";

export interface DangerZoneCardProps {
  isAdmin: boolean;
  onLogsCleared?: () => void;
}

export const DangerZoneCard: React.FC<DangerZoneCardProps> = ({ isAdmin, onLogsCleared }) => {
  const { t } = useTranslation();
  const [clearingLogs, setClearingLogs] = useState<boolean>(false);

  const handleClearAllLogs = async () => {
    if (!confirm(t("account.confirmClearLogs"))) return;
    setClearingLogs(true);
    try {
      await clearLogs();
      alert(t("account.clearLogsSuccess"));
      onLogsCleared?.();
    } catch (e) {
      console.error(e);
    } finally {
      setClearingLogs(false);
    }
  };

  const handleDeleteMyAccount = async () => {
    if (!confirm(t("account.confirmDeleteAccount"))) return;
    try {
      await deleteMe();
      window.location.href = "/";
    } catch (e: any) {
      console.error(e);
      alert(e.message || t("common.errorNetwork"));
    }
  };

  return (
    <>
      <H4 className="text-red-500 flex items-center gap-2">
        <Trash2 size={20} /> {t("account.dangerZone")}
      </H4>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card elevation={Elevation.ONE} className="flex flex-col justify-between">
          <div>
            <H4>{t("account.clearLogs")}</H4>
            <p className="text-xs opacity-60 mb-3">{t("account.clearLogsDesc")}</p>
          </div>
          <Button
            fill
            intent={Intent.DANGER}
            text={t("account.clearLogsBtn")}
            icon="trash"
            loading={clearingLogs}
            onClick={handleClearAllLogs}
          />
        </Card>
        {!isAdmin && (
          <Card elevation={Elevation.ONE} className="flex flex-col justify-between">
            <div>
              <H4>{t("account.deleteAccount")}</H4>
              <p className="text-xs opacity-60 mb-4">{t("account.deleteAccountDesc")}</p>
            </div>
            <Button
              fill
              intent={Intent.DANGER}
              text={t("account.deleteAccountBtn")}
              icon="delete"
              onClick={handleDeleteMyAccount}
            />
          </Card>
        )}
      </div>
      <Callout intent={Intent.WARNING} icon="info-sign" title={t("account.inactivityPolicy")}>
        <p className="text-sm">{t("account.inactivityDesc")}</p>
      </Callout>
    </>
  );
};

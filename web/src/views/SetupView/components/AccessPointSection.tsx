import React from "react";
import { Section, SectionCard, Button, Intent, PopoverNext } from "@blueprintjs/core";
import { Trash2, Edit2, RefreshCw, Copy, Download } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AccessPoint, Profile } from "../../../types/auth";
import { formatDateTime } from "../../../utils/date";
import { useDeploymentMode, getDisplayOrigin } from "../../../hooks/useDeploymentMode";
import { MinimalSelect } from "../../../components/MinimalSelect";
import { DeviceTypeSelect } from "../../../components/DeviceTypeSelect";
import { DeviceTypeEmblem } from "../../../components/DeviceTypeEmblem";
import { DeviceTypeStamp } from "../../../components/DeviceTypeStamp";
import { DEFAULT_ACCESS_POINT_DEVICE_TYPE } from "../../../constants/deviceTypes";

export interface AccessPointSectionProps {
  ap: AccessPoint;
  totalApCount: number;
  profiles: Profile[];
  updatingBindingApId: string | null;
  onChangeBinding: (apId: string, profileId: string | null) => void;
  updatingDeviceTypeApId?: string | null;
  onChangeDeviceType?: (apId: string, deviceType: string) => void;
  onGoToSetup?: (apId: string) => void;
  toasterRef: React.MutableRefObject<any>;
  onRenameTrigger: (apId: string, apName: string) => void;
  rotateConfirmApId: string | null;
  setRotateConfirmApId: (apId: string | null) => void;
  rotatingApId: string | null;
  handleRotate: (apId: string) => void;
  deletingApId: string | null;
  handleDelete: (apId: string) => void;
}

export const AccessPointSection: React.FC<AccessPointSectionProps> = ({
  ap,
  totalApCount,
  profiles,
  updatingBindingApId,
  onChangeBinding,
  updatingDeviceTypeApId,
  onChangeDeviceType,
  onGoToSetup,
  toasterRef,
  onRenameTrigger,
  rotateConfirmApId,
  setRotateConfirmApId,
  rotatingApId,
  handleRotate,
  deletingApId,
  handleDelete,
}) => {
  const { t } = useTranslation();
  const { isDemoMode, demoDomain } = useDeploymentMode();
  const displayOrigin = getDisplayOrigin(isDemoMode, demoDomain);
  const currentDeviceType = ap.device_type || DEFAULT_ACCESS_POINT_DEVICE_TYPE;

  return (
    <Section
      title={
        <div className="flex items-center gap-2 min-w-0">
          <DeviceTypeEmblem deviceType={currentDeviceType} size={16} className="shrink-0 opacity-85" />
          <span className="truncate">{ap.name}</span>
        </div>
      }
      className="group relative overflow-hidden rounded-lg! [&_.bp6-section-header]:relative [&_.bp6-section-header]:z-10 [&_.bp6-section-card]:relative [&_.bp6-section-card]:z-10"
    >
      <DeviceTypeStamp deviceType={currentDeviceType} />
      <SectionCard>
        <div className="space-y-3">
          {onChangeDeviceType && (
            <div className="flex justify-between items-center gap-4">
              <span className="text-xs opacity-65 shrink-0">
                {t("setup.deviceType", "Device Type")}
              </span>
              <DeviceTypeSelect
                value={currentDeviceType}
                disabled={updatingDeviceTypeApId === ap.id}
                onChange={(deviceType) => onChangeDeviceType(ap.id, deviceType)}
                alignRight
              />
            </div>
          )}
          <div className="flex justify-between items-center gap-4">
            <span className="text-xs opacity-65 shrink-0">
              {t("setup.boundProfile", "Bound Profile")}
            </span>
            <MinimalSelect
              value={ap.profile_id || ""}
              disabled={updatingBindingApId === ap.id}
              onChange={(val) => onChangeBinding(ap.id, val || null)}
              options={[
                { label: t("setup.unboundProfile", "Unbound"), value: "" },
                ...profiles.map((p) => ({ label: p.name, value: p.id })),
              ]}
              alignRight
            />
          </div>
          <div className="flex justify-between items-start gap-4">
            <span className="text-xs opacity-65 mt-1 shrink-0">DoH URL</span>
            <div
              className="flex items-center gap-2 text-sm font-mono bg-blue-50 text-blue-600 dark:bg-blue-900/20 dark:text-blue-400 px-2 py-1 rounded cursor-pointer hover:bg-blue-100 dark:hover:bg-blue-900/40 transition-colors break-all"
              onClick={() => {
                navigator.clipboard.writeText(`${displayOrigin}/${ap.token}`);
                toasterRef.current?.show({ message: t("setup.copied"), intent: Intent.SUCCESS });
              }}
              title={t("setup.copyUrl")}
            >
              <span className="select-all">{`${displayOrigin}/${ap.token}`}</span>
              <Copy size={14} className="shrink-0" />
            </div>
          </div>
          <div className="flex justify-between items-start gap-4">
            <span className="text-xs opacity-65 mt-1">{t("setup.accessPointToken")}</span>
            <span className="text-sm font-mono bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded select-all break-all">
              {ap.token}
            </span>
          </div>
          <div className="flex justify-between items-start gap-4">
            <span className="text-xs opacity-65 mt-1">{t("common.created", "Created")}</span>
            <span className="text-sm">{formatDateTime(new Date(ap.created_at * 1000))}</span>
          </div>
        </div>

        <div className="mt-4 flex gap-2 flex-wrap">
          {onGoToSetup && (
            <Button
              size="small"
              intent={Intent.PRIMARY}
              variant="outlined"
              icon={<Download size={14} />}
              text={t("nav.setup")}
              onClick={() => onGoToSetup(ap.id)}
            />
          )}
          <Button
            size="small"
            icon={<Edit2 size={14} />}
            text={t("setup.renameAccessPoint")}
            onClick={() => onRenameTrigger(ap.id, ap.name)}
          />
          <PopoverNext
            isOpen={rotateConfirmApId === ap.id}
            onInteraction={(nextOpenState) => {
              if (!nextOpenState) {
                setRotateConfirmApId(null);
              }
            }}
            content={
              <div className="p-4 space-y-3 dark:bg-gray-800 dark:text-white max-w-xs">
                <p className="text-xs font-semibold leading-relaxed">
                  {t(
                    "setup.rotateTokenConfirmDesc",
                    "Rotating the key will immediately disconnect devices using the old key. Are you sure you want to continue?"
                  )}
                </p>
                <div className="flex justify-end gap-2">
                  <Button
                    size="small"
                    variant="minimal"
                    text={t("common.cancel", "Cancel")}
                    onClick={() => setRotateConfirmApId(null)}
                  />
                  <Button
                    size="small"
                    intent={Intent.DANGER}
                    text={t("common.confirm", "Confirm")}
                    onClick={() => {
                      setRotateConfirmApId(null);
                      handleRotate(ap.id);
                    }}
                  />
                </div>
              </div>
            }
            placement="top"
          >
            <Button
              size="small"
              icon={<RefreshCw size={14} />}
              text={t("setup.rotateToken")}
              loading={rotatingApId === ap.id}
              onClick={() => setRotateConfirmApId(ap.id)}
            />
          </PopoverNext>
          <Button
            size="small"
            intent={Intent.DANGER}
            icon={<Trash2 size={14} />}
            text={t("setup.deleteAccessPoint")}
            loading={deletingApId === ap.id}
            onClick={() => handleDelete(ap.id)}
            disabled={totalApCount <= 1}
            title={totalApCount <= 1 ? "Cannot delete the only access point" : undefined}
          />
        </div>
      </SectionCard>
    </Section>
  );
};

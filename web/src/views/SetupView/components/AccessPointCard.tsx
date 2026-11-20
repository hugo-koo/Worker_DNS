import React from "react";
import { Section, SectionCard, Button, PopoverNext, Menu, MenuItem, Intent, Tag } from "@blueprintjs/core";
import { MonitorSmartphone, ChevronDown, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AccessPoint, Profile } from "../../../types/auth";
import { StepStampWatermark } from "./StepStampWatermark";
import { DeviceTypeEmblem } from "../../../components/DeviceTypeEmblem";

export interface AccessPointCardProps {
  accessPoints: AccessPoint[];
  selectedAp: AccessPoint | null;
  onSelectAp: (id: string) => void;
  profiles?: Profile[];
}

export const AccessPointCard: React.FC<AccessPointCardProps> = ({
  accessPoints,
  selectedAp,
  onSelectAp,
  profiles = [],
}) => {
  const { t } = useTranslation();
  const profileMap = React.useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles]);
  const selectedBoundProfile = selectedAp?.profile_id ? profileMap.get(selectedAp.profile_id) || null : null;

  return (
    <Section
      title={t("setup.accessPointsCardTitle", "接入点")}
      icon={<MonitorSmartphone size={16} />}
      className="h-full flex flex-col group relative overflow-hidden [&_.bp6-section-header]:relative [&_.bp6-section-header]:z-10 [&_.bp6-section-card]:relative [&_.bp6-section-card]:z-10 [&_.bp6-section-card]:flex-1 [&_.bp6-section-card]:flex [&_.bp6-section-card]:flex-col [&_.bp6-section-card]:justify-center"
    >
      <StepStampWatermark step={1} />
      <SectionCard>
        <div className="flex flex-col gap-2 w-full sm:w-auto">
          <span className="text-xs opacity-65 font-medium">
            {t("setup.selectAccessPointToConfigure")}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {accessPoints.length > 0 && selectedAp ? (
              <PopoverNext
                placement="bottom-start"
                animation="minimal"
                arrow={false}
                usePortal={true}
                portalClassName="z-20000"
                content={
                  <Menu className="max-h-72 overflow-y-auto min-w-64">
                    {accessPoints.map((ap) => {
                      const isCurrent = ap.id === selectedAp.id;
                      const apProfile = ap.profile_id ? profileMap.get(ap.profile_id) || null : null;
                      const bindingText = apProfile ? apProfile.name : t("setup.unboundProfile", "Unbound");
                      return (
                        <MenuItem
                          key={ap.id}
                          text={ap.name}
                          labelElement={
                            <span className="text-xs opacity-65 font-mono">
                              {bindingText} · {ap.token}
                            </span>
                          }
                          active={isCurrent}
                          icon={
                            isCurrent ? (
                              <Check size={14} />
                            ) : (
                              <DeviceTypeEmblem deviceType={ap.device_type} size={14} className="opacity-70" />
                            )
                          }
                          onClick={() => onSelectAp(ap.id)}
                        />
                      );
                    })}
                  </Menu>
                }
              >
                <Button
                  variant="minimal"
                  className="font-bold! text-blue-600! dark:text-blue-400! px-2!"
                  icon={<DeviceTypeEmblem deviceType={selectedAp.device_type} size={14} className="opacity-85" />}
                  endIcon={<ChevronDown size={14} />}
                >
                  <span className="truncate max-w-44 md:max-w-xs inline-block align-middle">
                    {selectedAp.name}
                  </span>
                </Button>
              </PopoverNext>
            ) : (
              <div className="font-semibold text-gray-500 dark:text-gray-400">
                {t("setup.noAccessPoints", "No access points found")}
              </div>
            )}
            {accessPoints.length > 0 && (
              <Tag minimal round intent={Intent.PRIMARY} className="text-xs shrink-0">
                {accessPoints.length}
              </Tag>
            )}
            {selectedAp && (
              <Tag
                minimal
                intent={selectedBoundProfile ? Intent.SUCCESS : Intent.WARNING}
                className="text-xs shrink-0 font-normal"
              >
                {selectedBoundProfile
                  ? t("setup.boundToProfile", {
                      profile: selectedBoundProfile.name,
                      defaultValue: `Bound: ${selectedBoundProfile.name}`,
                    })
                  : t("setup.unboundProfile", "Unbound")}
              </Tag>
            )}
          </div>
        </div>
      </SectionCard>
    </Section>
  );
};

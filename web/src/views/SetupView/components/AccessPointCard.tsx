import React from "react";
import { Section, SectionCard, Button, PopoverNext, Menu, MenuItem, Intent, Tag } from "@blueprintjs/core";
import { MonitorSmartphone, ChevronDown, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AccessPoint } from "../../../types/auth";
import { StepStampWatermark } from "./StepStampWatermark";

export interface AccessPointCardProps {
  accessPoints: AccessPoint[];
  selectedAp: AccessPoint | null;
  onSelectAp: (id: string) => void;
}

export const AccessPointCard: React.FC<AccessPointCardProps> = ({
  accessPoints,
  selectedAp,
  onSelectAp,
}) => {
  const { t } = useTranslation();

  return (
    <Section
      title={t("setup.accessPointsCardTitle", "接入点")}
      icon={<MonitorSmartphone size={16} />}
      className="h-full flex flex-col group relative overflow-hidden [&_.bp6-section-header]:relative [&_.bp6-section-header]:z-10 [&_.bp6-section-card]:relative [&_.bp6-section-card]:z-10 [&_.bp6-section-card]:flex-1 [&_.bp6-section-card]:flex [&_.bp6-section-card]:flex-col [&_.bp6-section-card]:justify-center"
    >
      <StepStampWatermark step={1} />
      <SectionCard>
        <div className="flex flex-col gap-1.5 w-full sm:w-auto">
          <span className="text-xs opacity-50 font-medium">
            {t("setup.selectAccessPointToConfigure")}
          </span>
          <div className="flex items-center gap-2">
            {accessPoints.length > 0 && selectedAp ? (
              <PopoverNext
                placement="bottom-start"
                animation="minimal"
                arrow={false}
                content={
                  <Menu className="max-h-72 overflow-y-auto">
                    {accessPoints.map((ap) => {
                      const isCurrent = ap.id === selectedAp.id;
                      return (
                        <MenuItem
                          key={ap.id}
                          text={ap.name}
                          label={ap.token}
                          active={isCurrent}
                          icon={isCurrent ? <Check size={14} /> : <span className="inline-block w-3.5" />}
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
                  endIcon={<ChevronDown size={14} />}
                >
                  <span className="truncate max-w-48 md:max-w-xs inline-block align-middle">
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
          </div>
        </div>
      </SectionCard>
    </Section>
  );
};

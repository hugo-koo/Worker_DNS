import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  DEVICE_CATEGORY_META,
  DEVICE_TYPE_LIST,
  getDeviceTypeMeta,
  type DeviceTypeCategory,
} from "../../constants/deviceTypes";
import { DeviceTypeEmblem } from "../DeviceTypeEmblem";
import { MinimalSelect, type MinimalSelectGroup } from "../MinimalSelect";

export interface DeviceTypeSelectProps {
  value?: string | null;
  onChange: (deviceType: string) => void;
  disabled?: boolean;
  fill?: boolean;
  alignRight?: boolean;
  buttonClassName?: string;
}

const CATEGORY_ORDER: readonly DeviceTypeCategory[] = ["browser", "os", "router", "other"];

/**
 * Categorized Device Type selector shared across Access Point creation and management cards.
 */
export const DeviceTypeSelect: React.FC<DeviceTypeSelectProps> = ({
  value,
  onChange,
  disabled = false,
  fill = false,
  alignRight = false,
  buttonClassName,
}) => {
  const { t } = useTranslation();
  const normalizedValue = getDeviceTypeMeta(value).value;

  const groups: MinimalSelectGroup[] = useMemo(
    () =>
      CATEGORY_ORDER.map((category) => ({
        label: t(DEVICE_CATEGORY_META[category].labelKey, DEVICE_CATEGORY_META[category].defaultLabel),
        options: DEVICE_TYPE_LIST.filter((item) => item.category === category).map((item) => ({
          value: item.value,
          label: t(item.labelKey, item.defaultLabel),
          icon: <DeviceTypeEmblem deviceType={item.value} size={14} />,
        })),
      })),
    [t]
  );

  return (
    <MinimalSelect
      value={normalizedValue}
      onChange={onChange}
      groups={groups}
      disabled={disabled}
      fill={fill}
      alignRight={alignRight}
      buttonClassName={buttonClassName}
    />
  );
};

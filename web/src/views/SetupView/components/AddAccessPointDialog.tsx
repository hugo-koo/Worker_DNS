import React from "react";
import {
  Dialog,
  Classes,
  Tooltip,
  InputGroup,
  Button,
  Intent,
  Position,
  FormGroup,
} from "@blueprintjs/core";
import { useTranslation } from "react-i18next";
import type { Profile } from "../../../types/auth";
import { MinimalSelect } from "../../../components/MinimalSelect";
import { DeviceTypeSelect } from "../../../components/DeviceTypeSelect";
import { DEFAULT_ACCESS_POINT_DEVICE_TYPE } from "../../../constants/deviceTypes";

export interface AddAccessPointDialogProps {
  isOpen: boolean;
  onClose: () => void;
  newApName: string;
  setNewApName: (val: string) => void;
  newApNameFocused: boolean;
  setNewApNameFocused: (val: boolean) => void;
  handleAdd: () => void;
  isAdding: boolean;
  isValidApName: (name: string) => boolean;
  profiles?: Profile[];
  selectedProfileId?: string;
  onSelectProfileId?: (id: string) => void;
  deviceType?: string;
  onSelectDeviceType?: (deviceType: string) => void;
}

export const AddAccessPointDialog: React.FC<AddAccessPointDialogProps> = ({
  isOpen,
  onClose,
  newApName,
  setNewApName,
  newApNameFocused,
  setNewApNameFocused,
  handleAdd,
  isAdding,
  isValidApName,
  profiles = [],
  selectedProfileId = "",
  onSelectProfileId,
  deviceType = DEFAULT_ACCESS_POINT_DEVICE_TYPE,
  onSelectDeviceType,
}) => {
  const { t } = useTranslation();

  return (
    <Dialog isOpen={isOpen} onClose={onClose} title={t("setup.addAccessPoint")}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!isAdding && isValidApName(newApName)) {
            handleAdd();
          }
        }}
      >
        <div className={`${Classes.DIALOG_BODY} space-y-4`}>
          <FormGroup label={t("setup.accessPointName")} className="mb-0">
            <Tooltip
              content={t(
                "setup.accessPointNameFormatTip",
                "1-30 characters, letters, numbers, hyphens and underscores allowed"
              )}
              isOpen={newApNameFocused}
              position={Position.TOP}
              intent={Intent.PRIMARY}
              className="w-full"
            >
              <div className="w-full block">
                <InputGroup
                  autoFocus
                  large
                  placeholder={t("setup.accessPointName")}
                  value={newApName}
                  onChange={(e) => setNewApName(e.target.value)}
                  onFocus={() => setNewApNameFocused(true)}
                  onBlur={() => setNewApNameFocused(false)}
                />
              </div>
            </Tooltip>
          </FormGroup>

          {onSelectDeviceType && (
            <FormGroup label={t("setup.deviceType", "Device Type")} className="mb-0">
              <DeviceTypeSelect
                fill
                value={deviceType}
                onChange={onSelectDeviceType}
              />
            </FormGroup>
          )}

          {onSelectProfileId && (
            <FormGroup label={t("setup.boundProfile", "Bound Profile")} className="mb-0">
              <MinimalSelect
                fill
                value={selectedProfileId}
                onChange={onSelectProfileId}
                options={[
                  { label: t("setup.unboundProfile", "Unbound"), value: "" },
                  ...profiles.map((p) => ({ label: `${p.name} (${p.id})`, value: p.id })),
                ]}
              />
            </FormGroup>
          )}
        </div>
        <div className={Classes.DIALOG_FOOTER}>
          <div className={Classes.DIALOG_FOOTER_ACTIONS}>
            <Button type="button" onClick={onClose}>
              {t("common.cancel", "Cancel")}
            </Button>
            <Button
              type="submit"
              intent={Intent.PRIMARY}
              loading={isAdding}
              disabled={!isValidApName(newApName)}
            >
              {t("common.create")}
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
};

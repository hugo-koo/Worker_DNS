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
  HTMLSelect,
} from "@blueprintjs/core";
import { useTranslation } from "react-i18next";
import type { Profile } from "../../../types/auth";

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

          {onSelectProfileId && (
            <FormGroup label={t("setup.boundProfile", "Bound Profile")} className="mb-0">
              <HTMLSelect
                fill
                large
                value={selectedProfileId}
                onChange={(e) => onSelectProfileId(e.target.value)}
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

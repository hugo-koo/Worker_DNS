import React, { useState } from "react";
import { Dialog, Classes, Tooltip, InputGroup, Button, Intent, Position } from "@blueprintjs/core";
import { useTranslation } from "react-i18next";
import { PROFILE_NAME_REGEX } from "../../../utils/auth";

export interface RenameProfileDialogProps {
  /** Whether the rename dialog is open. */
  isOpen: boolean;
  /** Callback invoked when closing the dialog. */
  onClose: () => void;
  /** Current input value for the new profile name. */
  renameValue: string;
  /** Setter for the profile name input. */
  setRenameValue: (val: string) => void;
  /** Async submit handler performing the rename operation. */
  onSubmit: () => void;
  /** True while rename API request is in flight. */
  isRenaming: boolean;
  /** Optional localized error message returned by the API. */
  error: string;
}

/**
 * Dialog modal allowing users to rename an existing DNS Profile from Collections.
 */
export const RenameProfileDialog: React.FC<RenameProfileDialogProps> = ({
  isOpen,
  onClose,
  renameValue,
  setRenameValue,
  onSubmit,
  isRenaming,
  error,
}) => {
  const { t } = useTranslation();
  const [nameFocused, setNameFocused] = useState(false);
  const trimmedName = renameValue.trim();
  const isValid = PROFILE_NAME_REGEX.test(trimmedName);

  const getErrorMessage = (err: string): string => {
    if (!err) return "";
    if (err === "The profile name already exists") {
      return t("common.profileNameExists", "The profile name already exists");
    }
    if (err === "Invalid Profile Name format") {
      return t("common.profileNameFormatError", "Invalid Profile Name format");
    }
    return err;
  };

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={t("common.renameProfile", "Rename Profile")}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!isRenaming && isValid) {
            onSubmit();
          }
        }}
      >
        <div className={Classes.DIALOG_BODY}>
          <Tooltip
            content={t(
              "common.profileNameFormatTip",
              "Profile Name tip: 1-30 characters, duplicates not allowed"
            )}
            isOpen={nameFocused}
            position={Position.TOP}
            intent={Intent.PRIMARY}
            className="w-full"
          >
            <div className="w-full block">
              <InputGroup
                autoFocus
                large
                placeholder={t("common.newProfileName")}
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onFocus={() => setNameFocused(true)}
                onBlur={() => setNameFocused(false)}
              />
            </div>
          </Tooltip>
          {error && <div className="mt-2 text-red-500 text-xs">{getErrorMessage(error)}</div>}
        </div>
        <div className={Classes.DIALOG_FOOTER}>
          <div className={Classes.DIALOG_FOOTER_ACTIONS}>
            <Button type="button" onClick={onClose}>
              {t("common.cancel", "Cancel")}
            </Button>
            <Button
              type="submit"
              intent={Intent.PRIMARY}
              loading={isRenaming}
              disabled={!isValid}
            >
              {t("common.save")}
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
};

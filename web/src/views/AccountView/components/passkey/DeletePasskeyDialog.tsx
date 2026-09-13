import React from "react";
import { Dialog, Classes, Button, Intent } from "@blueprintjs/core";
import { useTranslation } from "react-i18next";
import type { Passkey } from "../../../../services";

/**
 * Props for the DeletePasskeyDialog component.
 */
export interface DeletePasskeyDialogProps {
  /** Whether the modal dialog is open. */
  isOpen: boolean;
  /** Callback to close the dialog. */
  onClose: () => void;
  /** The target passkey selected for deletion. */
  targetToDelete: Passkey | null;
  /** Whether deletion is currently loading. */
  deleting: boolean;
  /** Confirmation handler to execute deletion. */
  onConfirm: () => void;
}

/**
 * DeletePasskeyDialog renders the modal dialog to confirm deletion of a passkey.
 *
 * @param props - Component props.
 * @returns React modal dialog element.
 */
export const DeletePasskeyDialog: React.FC<DeletePasskeyDialogProps> = ({
  isOpen,
  onClose,
  targetToDelete,
  deleting,
  onConfirm
}) => {
  const { t } = useTranslation();

  return (
    <Dialog
      isOpen={isOpen}
      onClose={() => !deleting && onClose()}
      title={t("account.passkey.deleteTitle", "Delete Passkey")}
      className="max-w-md"
    >
      <div className={Classes.DIALOG_BODY}>
        <p>
          {t(
            "account.passkey.deleteConfirm",
            'Are you sure you want to delete passkey "{{name}}"? You will no longer be able to use this passkey for MFA.',
            { name: targetToDelete?.name }
          )}
        </p>
      </div>
      <div className={Classes.DIALOG_FOOTER}>
        <div className={Classes.DIALOG_FOOTER_ACTIONS}>
          <Button
            text={t("common.cancel", "Cancel")}
            onClick={onClose}
            disabled={deleting}
          />
          <Button
            intent={Intent.DANGER}
            text={t("common.delete", "Delete")}
            onClick={onConfirm}
            loading={deleting}
          />
        </div>
      </div>
    </Dialog>
  );
};

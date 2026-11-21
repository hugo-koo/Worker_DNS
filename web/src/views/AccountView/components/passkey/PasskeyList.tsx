import React from "react";
import { Button, Intent, Spinner } from "@blueprintjs/core";
import { KeyRound, Edit2, Trash2, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatDateTime } from "../../../../utils/date";
import type { Passkey } from "../../../../services";

/**
 * Props for the PasskeyList component.
 */
export interface PasskeyListProps {
  /** Configured passkeys. */
  passkeys: Passkey[];
  /** Whether passkeys are currently being fetched. */
  loading: boolean;
  /** Passkey ID currently being deleted (if any). */
  deletingId: string | null;
  /** Passkey ID currently being tested (if any). */
  testingId?: string | null;
  /** Callback to test a specific passkey. */
  onTestPasskey?: (pk: Passkey) => void;
  /** Callback to trigger rename modal. */
  onOpenRename: (pk: Passkey) => void;
  /** Callback to trigger delete modal. */
  onOpenDelete: (pk: Passkey) => void;
}

/**
 * PasskeyList renders the list of passkeys registered on the user's account.
 * Displays empty state, loading spinner, and action buttons for rename and delete.
 *
 * @param props - Component props.
 * @returns React component representing passkey list.
 */
export const PasskeyList: React.FC<PasskeyListProps> = ({
  passkeys,
  loading,
  deletingId,
  testingId,
  onTestPasskey,
  onOpenRename,
  onOpenDelete
}) => {
  const { t } = useTranslation();

  if (loading) {
    return (
      <div className="py-6 text-center">
        <Spinner size={24} />
      </div>
    );
  }

  if (passkeys.length === 0) {
    return (
      <div className="py-6 text-center text-sm text-gray-500 dark:text-gray-400 border border-dashed border-gray-200 dark:border-gray-800 rounded-lg">
        <KeyRound size={28} className="mx-auto mb-2 opacity-40" />
        <p>{t("account.passkey.empty", "No passkeys added yet.")}</p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-gray-100 dark:divide-gray-800 border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden">
      {passkeys.map((pk) => (
        <div
          key={pk.id}
          className="p-3 sm:p-4 flex items-center justify-between gap-3 hover:bg-gray-50 dark:hover:bg-gray-900/40 transition-colors"
        >
          <div className="flex items-center gap-3 min-w-0">
            <div className="p-2 bg-purple-50 dark:bg-purple-950/40 text-purple-600 dark:text-purple-400 rounded-lg shrink-0">
              <KeyRound size={18} />
            </div>
            <div className="min-w-0">
              <div className="flex items-center min-w-0">
                <button
                  type="button"
                  onClick={() => onOpenRename(pk)}
                  aria-label={t("common.rename", "Rename")}
                  title={t("common.rename", "Rename")}
                  className="group/rename inline-flex items-center gap-1.5 max-w-full min-w-0 bg-transparent border-0 p-0 text-left font-semibold text-sm text-gray-900 dark:text-gray-100 cursor-pointer"
                >
                  <span className="truncate">{pk.name}</span>
                  <Edit2
                    size={13}
                    className="shrink-0 opacity-30 group-hover/rename:opacity-100 transition-opacity"
                  />
                </button>
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400 flex flex-wrap gap-x-3 gap-y-1 mt-0.5">
                <span>
                  {t("account.passkey.created", "Added")}:{" "}
                  {formatDateTime(new Date(pk.created_at * 1000))}
                </span>
                {pk.last_used_at ? (
                  <span>
                    {t("account.passkey.lastUsed", "Last used")}:{" "}
                    {formatDateTime(new Date(pk.last_used_at * 1000))}
                  </span>
                ) : (
                  <span>{t("account.passkey.neverUsed", "Never used")}</span>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <Button
              minimal
              small
              intent={Intent.PRIMARY}
              icon={<ShieldCheck size={14} />}
              title={t("account.passkey.testThis", "Test this passkey")}
              loading={testingId === pk.id}
              onClick={() => onTestPasskey?.(pk)}
            />
            <Button
              minimal
              small
              intent={Intent.DANGER}
              icon={<Trash2 size={14} />}
              title={t("common.delete", "Delete")}
              loading={deletingId === pk.id}
              onClick={() => onOpenDelete(pk)}
            />
          </div>
        </div>
      ))}
    </div>
  );
};

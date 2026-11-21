import React, { useState, useRef, useEffect } from "react";
import {
  Card,
  Elevation,
  FormGroup,
  InputGroup,
  ButtonGroup,
  Button,
  Tooltip,
  Position,
  Intent,
  H4,
  HTMLSelect,
  type OverlayToaster,
} from "@blueprintjs/core";
import { User, Edit2, Check, X, Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { UserInfo } from "../types";
import { timezoneOptions } from "../../../config/timezones";

/**
 * Properties for the PersonalInfoCard component.
 */
export interface PersonalInfoCardProps {
  /** The current user information object. */
  me: UserInfo | null;
  /** State indicating if username editing mode is active. */
  isEditingUsername: boolean;
  /** Callback to set or exit username editing mode. */
  setIsEditingUsername: (editing: boolean) => void;
  /** The temporary input value for the username editor. */
  editUsername: string;
  /** Callback to update the temporary username input value. */
  setEditUsername: (username: string) => void;
  /** Indicates if update username request is loading. */
  usernameLoading: boolean;
  /** State indicating if username editor input has focus. */
  usernameFocused: boolean;
  /** Callback to update username input focus state. */
  setUsernameFocused: (focused: boolean) => void;
  /** Callback to submit username change. */
  onUpdateUsername: () => void;
  /** Callback to submit timezone change. */
  onUpdateTimezone?: (tz: string | null) => void;
  /** Optional shared OverlayToaster ref for copy confirmation feedback. */
  toasterRef?: React.RefObject<OverlayToaster | null>;
}

/**
 * PersonalInfoCard component renders the user profile information (Username, ID).
 *
 * @param props - Component props.
 * @returns React element representing personal info card.
 */
export const PersonalInfoCard: React.FC<PersonalInfoCardProps> = ({
  me,
  isEditingUsername,
  setIsEditingUsername,
  editUsername,
  setEditUsername,
  usernameLoading,
  usernameFocused,
  setUsernameFocused,
  onUpdateUsername,
  onUpdateTimezone,
  toasterRef,
}) => {
  const { t } = useTranslation();
  const [copiedField, setCopiedField] = useState<"username" | "id" | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const handleCopy = async (field: "username" | "id", value?: string): Promise<void> => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(field);
      toasterRef?.current?.show({
        message: t("common.copied", "已复制"),
        intent: Intent.SUCCESS,
      });
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => {
        setCopiedField(null);
        copyTimerRef.current = null;
      }, 2000);
    } catch {
      // Clipboard write unavailable
    }
  };

  return (
    <Card elevation={Elevation.ONE}>
      <div className="flex items-center gap-2 mb-4">
        <User size={20} className="text-blue-500" />
        <H4 style={{ margin: 0 }}>{t("account.personalInfo")}</H4>
      </div>
      <div className="space-y-4">
        <FormGroup label={t("account.username")}>
          {isEditingUsername ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!usernameLoading) {
                  onUpdateUsername();
                }
              }}
            >
              <div className="flex gap-2">
                <Tooltip
                  content={t("account.formatTipUsername")}
                  isOpen={usernameFocused}
                  position={Position.TOP}
                  intent={Intent.PRIMARY}
                  className="w-full"
                >
                  <div className="w-full block">
                    <InputGroup
                      fill
                      value={editUsername}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                        setEditUsername(e.target.value)
                      }
                      onFocus={() => setUsernameFocused(true)}
                      onBlur={() => setUsernameFocused(false)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          setIsEditingUsername(false);
                          setEditUsername(me?.username || "");
                        }
                      }}
                      autoFocus
                    />
                  </div>
                </Tooltip>
                <ButtonGroup>
                  <Button
                    type="submit"
                    icon={<Check size={16} />}
                    intent={Intent.SUCCESS}
                    loading={usernameLoading}
                  />
                  <Button
                    type="button"
                    icon={<X size={16} />}
                    onClick={() => {
                      setIsEditingUsername(false);
                      setEditUsername(me?.username || "");
                    }}
                  />
                </ButtonGroup>
              </div>
            </form>
          ) : (
            <div className="flex items-center justify-between gap-2 min-h-8">
              <button
                type="button"
                onClick={() => setIsEditingUsername(true)}
                aria-label={t("common.rename", "Rename")}
                title={t("common.rename", "Rename")}
                className="group/rename inline-flex items-center gap-1.5 min-w-0 bg-transparent border-0 p-0 text-left text-base font-semibold text-gray-900 dark:text-gray-100 cursor-pointer"
              >
                <span className="truncate">{me?.username}</span>
                <Edit2
                  size={14}
                  className="shrink-0 opacity-30 group-hover/rename:opacity-100 transition-opacity"
                />
              </button>
              <Button
                minimal
                small
                icon={
                  copiedField === "username" ? (
                    <Check size={14} className="text-green-500" />
                  ) : (
                    <Copy size={14} />
                  )
                }
                onClick={() => void handleCopy("username", me?.username)}
                disabled={!me?.username}
                title={t("common.copy", "Copy")}
                aria-label={t("common.copy", "Copy")}
              />
            </div>
          )}
        </FormGroup>
        <FormGroup label={t("account.userId")}>
          <div className="flex items-center justify-between gap-2 min-h-8">
            <span className="font-mono text-sm text-gray-900 dark:text-gray-100 select-all truncate">
              {me?.id}
            </span>
            <Button
              minimal
              small
              icon={
                copiedField === "id" ? (
                  <Check size={14} className="text-green-500" />
                ) : (
                  <Copy size={14} />
                )
              }
              onClick={() => void handleCopy("id", me?.id)}
              disabled={!me?.id}
              title={t("common.copy", "Copy")}
              aria-label={t("common.copy", "Copy")}
            />
          </div>
        </FormGroup>
        <FormGroup label={t("account.timezone", "Timezone")}>
          <HTMLSelect
            fill
            value={me?.timezone || ""}
            onChange={(e) => onUpdateTimezone?.(e.target.value || null)}
            options={timezoneOptions}
          />
        </FormGroup>
      </div>
    </Card>
  );
};

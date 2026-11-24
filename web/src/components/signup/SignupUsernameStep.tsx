import React from "react";
import {
  Button,
  FormGroup,
  InputGroup,
  Tooltip,
  Position,
  Intent
} from "@blueprintjs/core";
import { useTranslation } from "react-i18next";

/**
 * Properties for the SignupUsernameStep component.
 */
export interface SignupUsernameStepProps {
  /** The current username value. */
  username: string;
  /** Callback to update the username value. */
  setUsername: (val: string) => void;
  /** State indicating if username input field has focus. */
  usernameFocused: boolean;
  /** Callback to set focus state of username input. */
  setUsernameFocused: (focused: boolean) => void;
  /** Callback to check username availability on backend. */
  checkUsernameDuplicate: (uname: string) => void;
  /** Whether a 6-character invite code is required for registration. */
  requiresInviteCode?: boolean;
  /** Current invite code value. */
  inviteCode?: string;
  /** Callback to update the invite code value. */
  setInviteCode?: (val: string) => void;
  /** Indicates if signup username submission is loading. */
  loading: boolean;
  /** Callback to handle form submission. */
  onSubmit: (e: React.FormEvent) => void;
  /** Callback to reset or clear username/invite errors. */
  onClearError: () => void;
}

/**
 * SignupUsernameStep is the first step of the signup wizard.
 * It handles username input, optional invite code entry, and real-time availability checks.
 *
 * @param props - Component props.
 * @returns React element representing username step.
 */
export const SignupUsernameStep: React.FC<SignupUsernameStepProps> = ({
  username,
  setUsername,
  usernameFocused,
  setUsernameFocused,
  checkUsernameDuplicate,
  requiresInviteCode = false,
  inviteCode = "",
  setInviteCode,
  loading,
  onSubmit,
  onClearError
}) => {
  const { t } = useTranslation();

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <FormGroup label={t("auth.username")} labelFor="username">
        <Tooltip
          content={t("auth.formatTipUsername")}
          isOpen={usernameFocused}
          position={Position.TOP}
          intent={Intent.PRIMARY}
          className="w-full"
        >
          <div className="w-full block">
            <InputGroup
              id="username"
              leftIcon="user"
              placeholder={t("auth.usernamePlaceholder")}
              size="large"
              className="rounded-xl w-full"
              value={username}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                setUsername(e.target.value);
                onClearError();
              }}
              onFocus={() => setUsernameFocused(true)}
              onBlur={() => {
                setUsernameFocused(false);
                checkUsernameDuplicate(username);
              }}
              autoFocus
              required
            />
          </div>
        </Tooltip>
      </FormGroup>

      {requiresInviteCode && setInviteCode && (
        <FormGroup
          label={t("auth.inviteCode", "邀请码")}
          labelFor="invite-code"
          helperText={t("auth.inviteCodeFormatTip", "请输入 6 位大写英文字母或数字组成的邀请码")}
        >
          <InputGroup
            id="invite-code"
            leftIcon="key"
            placeholder={t("auth.inviteCodePlaceholder", "例如 A1B2C3")}
            size="large"
            maxLength={6}
            className="rounded-xl w-full font-mono uppercase tracking-widest"
            value={inviteCode}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
              const sanitized = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
              setInviteCode(sanitized);
              onClearError();
            }}
            required
          />
        </FormGroup>
      )}

      <Button
        fill
        size="large"
        intent={Intent.PRIMARY}
        type="submit"
        loading={loading}
        className="mt-6 font-bold py-6 rounded-xl shadow-lg shadow-blue-500/20"
      >
        {t("auth.next", "Next")}
      </Button>
    </form>
  );
};

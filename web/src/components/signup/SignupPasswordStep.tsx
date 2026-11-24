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
 * Properties for the SignupPasswordStep component.
 */
export interface SignupPasswordStepProps {
  /** The current password value. */
  password: string;
  /** Callback to update the password value. */
  setPassword: (val: string) => void;
  /** State indicating if password input field has focus. */
  passwordFocused: boolean;
  /** Callback to set focus state of password input. */
  setPasswordFocused: (focused: boolean) => void;
  /** Indicates if signup submission is loading. */
  loading: boolean;
  /** Callback to handle form submission. */
  onSubmit: (e: React.FormEvent) => void;
  /** Optional callback to create a passwordless account by skipping password input. */
  onSkipPassword?: () => void;
  /** Flag showing if Turnstile verification is enabled. */
  isTurnstileEnabled: boolean | undefined;
  /** Ref pointing to the Turnstile container div. */
  turnstileRef: React.RefObject<HTMLDivElement | null>;
  /** The current state of Turnstile verification. */
  turnstileStatus: "idle" | "verifying" | "success" | "error";
}

/**
 * SignupPasswordStep is the second step of the signup wizard.
 * It handles password complexity validation and registration submission.
 *
 * @param props - Component props.
 * @returns React element representing password step.
 */
export const SignupPasswordStep: React.FC<SignupPasswordStepProps> = ({
  password,
  setPassword,
  passwordFocused,
  setPasswordFocused,
  loading,
  onSubmit,
  onSkipPassword,
  isTurnstileEnabled,
  turnstileRef,
  turnstileStatus
}) => {
  const [showPassword, setShowPassword] = React.useState(false);
  const { t } = useTranslation();

  /**
   * Renders the right elements (clear and/or show/hide password buttons) inside the password input group.
   *
   * @returns React element.
   */
  const renderPasswordRightElement = (): React.JSX.Element => {
    return (
      <div className="flex items-center">
        {password && (
          <Button
            minimal={true}
            icon="cross"
            onClick={() => setPassword("")}
          />
        )}
        <Button
          minimal={true}
          icon={showPassword ? "eye-open" : "eye-off"}
          onClick={() => setShowPassword(!showPassword)}
          title={showPassword ? t("auth.hidePassword", "Hide password") : t("auth.showPassword", "Show password")}
        />
      </div>
    );
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <FormGroup label={t("auth.password")} labelFor="password">
        <Tooltip
          content={t("auth.formatTipPassword")}
          isOpen={passwordFocused}
          position={Position.TOP}
          intent={Intent.PRIMARY}
          className="w-full"
        >
          <div className="w-full block">
            <InputGroup
              id="password"
              leftIcon="lock"
              placeholder={t("auth.passwordPlaceholder")}
              type={showPassword ? "text" : "password"}
              size="large"
              className="rounded-xl w-full"
              value={password}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setPassword(e.target.value)
              }
              onFocus={() => setPasswordFocused(true)}
              onBlur={() => setPasswordFocused(false)}
              rightElement={renderPasswordRightElement()}
              required
              autoFocus
            />
          </div>
        </Tooltip>
      </FormGroup>

      {isTurnstileEnabled && (
        <div className="py-2 flex justify-center min-h-16.25">
          <div ref={turnstileRef} />
        </div>
      )}

      <Button
        fill
        size="large"
        intent={Intent.PRIMARY}
        type="submit"
        loading={loading || turnstileStatus === "verifying"}
        disabled={
          !!isTurnstileEnabled && turnstileStatus !== "success"
        }
        className="mt-6 font-bold py-6 rounded-xl shadow-lg shadow-blue-500/20"
      >
        {turnstileStatus === "verifying"
          ? t("auth.verifying")
          : t("auth.signupBtn")}
      </Button>

      {onSkipPassword && (
        <div className="pt-2 text-center">
          <Button
            type="button"
            minimal
            fill
            disabled={loading || turnstileStatus === "verifying" || (!!isTurnstileEnabled && turnstileStatus !== "success")}
            onClick={onSkipPassword}
            text={t("auth.skipPasswordSignup", "跳过密码设置，注册无密码账号")}
            className="text-xs text-gray-500 hover:text-blue-600 dark:text-gray-400 dark:hover:text-blue-400"
          />
        </div>
      )}
    </form>
  );
};

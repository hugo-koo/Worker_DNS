import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  validateUsername,
  validatePassword,
  validateInviteCode,
  checkPasswordBreached,
  isPasswordLeaked,
  hashTotpToken,
  hashPasswordClient,
  formatApiErrorMessage
} from "../../utils/auth";
import {
  checkUsernameDuplicate as checkUsernameDuplicateService,
  checkInviteCode as checkInviteCodeService,
  signup,
  setupTotp,
  confirmTotp,
  getPasskeyRegistrationOptions,
  verifyPasskeyRegistration,
  ApiError,
  e2ee
} from "../../services";
import { setAccessToken } from "../../utils/token";
import { startPasskeyRegistration } from "../../utils/webauthn";
import { useTurnstile } from "../../hooks/useTurnstile";

interface AuthConfig {
  turnstile_site_key: string;
  turnstile_enabled_signup: boolean;
  turnstile_enabled_login: boolean;
  has_users?: boolean;
  invite_code_enabled?: boolean;
}

export interface UseSignupWizardProps {
  authConfig: AuthConfig | null;
  turnstileReady: boolean;
  onSuccess: () => void;
}

/**
 * Custom hook to manage SignupWizard's state and workflow submissions.
 *
 * @param props - Hook props.
 * @returns State and event handlers for SignupWizard.
 */
export const useSignupWizard = ({
  authConfig,
  turnstileReady,
  onSuccess
}: UseSignupWizardProps) => {
  const [signupStep, setSignupStep] = useState<
    "username" | "password" | "totp" | "recovery"
  >("username");

  // Input states
  const [username, setUsername] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [password, setPassword] = useState("");
  const [totpSetupToken, setTotpSetupToken] = useState("");
  const requiresInviteCode = Boolean(authConfig?.has_users !== false && authConfig?.invite_code_enabled);

  // TOTP response states
  const [totpSetupData, setTotpSetupData] = useState<{
    secret: string;
    uri: string;
  } | null>(null);
  const [totpRecoveryKeys, setTotpRecoveryKeys] = useState<string[] | null>(
    null
  );

  // Status indicators
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [usernameFocused, setUsernameFocused] = useState(false);
  const [passwordFocused, setPasswordFocused] = useState(false);
  const [copiedRecovery, setCopiedRecovery] = useState(false);

  // Setup/verification loading indicators
  const [totpSetupLoading, setTotpSetupLoading] = useState(false);
  const [totpSetupError, setTotpSetupError] = useState("");

  // MFA selection & passkey states
  const [mfaChoice, setMfaChoice] = useState<"choose" | "totp">("choose");
  const [passkeyRegLoading, setPasskeyRegLoading] = useState(false);
  const [passkeyRegError, setPasskeyRegError] = useState("");
  const [isPasswordlessSignup, setIsPasswordlessSignup] = useState(false);

  const { t } = useTranslation();

  const isTurnstileEnabled = authConfig?.turnstile_enabled_signup;

  const handleClearError = React.useCallback(() => {
    setError("");
  }, []);

  const {
    turnstileToken,
    turnstileStatus,
    turnstileRef,
    resetTurnstile
  } = useTurnstile({
    siteKey: authConfig?.turnstile_site_key,
    enabled: isTurnstileEnabled,
    turnstileReady,
    isActive: signupStep === "password",
    onError: setError,
    onClearError: handleClearError
  });

  const checkUsernameDuplicate = async (uname: string) => {
    if (!uname || !validateUsername(uname)) return;
    try {
      const exists = await checkUsernameDuplicateService(uname);
      if (exists) {
        setError(t("auth.usernameExists"));
      } else {
        setError((prev) => (prev === t("auth.usernameExists") ? "" : prev));
      }
    } catch (e) {
      console.error("Failed to check username duplicate", e);
    }
  };

  const handleSignupUsernameSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validateUsername(username)) {
      setError(t("auth.formatTipUsername"));
      return;
    }

    const normalizedCode = inviteCode.trim().toUpperCase();
    if (requiresInviteCode) {
      if (!normalizedCode) {
        setError(t("auth.inviteCodeRequired", "请输入 6 位邀请码。"));
        return;
      }
      if (!validateInviteCode(normalizedCode)) {
        setError(t("auth.inviteCodeInvalid", "邀请码无效，请检查是否为正确的 6 位大写字母或数字。"));
        return;
      }
    }

    setLoading(true);
    setError("");
    try {
      const exists = await checkUsernameDuplicateService(username);
      if (exists) {
        setError(t("auth.usernameExists"));
        return;
      }
      if (requiresInviteCode) {
        await checkInviteCodeService(normalizedCode);
      }
      setSignupStep("password");
    } catch (err: any) {
      setError(formatApiErrorMessage(err, t));
    } finally {
      setLoading(false);
    }
  };

  const startSignupTotpSetup = async () => {
    setTotpSetupLoading(true);
    setTotpSetupError("");
    try {
      const data = await setupTotp();
      setTotpSetupData(data);
      setSignupStep("totp");
    } catch (e) {
      console.error("Network error during signup TOTP setup:", e);
      if (isPasswordlessSignup) {
        setTotpSetupError(t("common.errorNetwork", "Network error"));
        setMfaChoice("choose");
      } else {
        onSuccess();
      }
    } finally {
      setTotpSetupLoading(false);
    }
  };

  const handleChooseTotp = async () => {
    setMfaChoice("totp");
    await startSignupTotpSetup();
  };

  const handleRegisterPasskey = async () => {
    setPasskeyRegLoading(true);
    setPasskeyRegError("");
    try {
      const options = await getPasskeyRegistrationOptions();
      const credential = await startPasskeyRegistration(options);
      const res = await verifyPasskeyRegistration({ name: "primary_passkey", credential });

      const passkeyId = (res as any)?.passkey?.id || (res as any)?.id;
      if (passkeyId && e2ee.isUnlocked()) {
        try {
          await e2ee.wrapCurrentKeyForPasskey(passkeyId);
        } catch (wrapErr) {
          console.warn("Failed to wrap key for new passkey:", wrapErr);
        }
      }

      if (res.recovery_keys && res.recovery_keys.length > 0) {
        setTotpRecoveryKeys(res.recovery_keys);
      }
      setSignupStep("recovery");
    } catch (err: any) {
      console.error("Passkey registration failed:", err);
      setPasskeyRegError(formatApiErrorMessage(err, t));
    } finally {
      setPasskeyRegLoading(false);
    }
  };

  const handleSignupTotpConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!totpSetupData) return;
    setTotpSetupLoading(true);
    setTotpSetupError("");
    try {
      const rawToken = totpSetupToken.replace(/\s/g, "");
      const salt = crypto.randomUUID();
      const hashHex = await hashTotpToken(rawToken, salt);

      const data = await confirmTotp({
        secret: totpSetupData.secret,
        totpTokenHash: hashHex,
        salt
      });
      if (data.recovery_keys && data.recovery_keys.length > 0) {
        setTotpRecoveryKeys(data.recovery_keys);
      }
      setSignupStep("recovery");
    } catch (err: any) {
      setTotpSetupError(err.message || t("common.errorNetwork"));
    } finally {
      setTotpSetupLoading(false);
    }
  };

  const handleCopySignupRecoveryKeys = () => {
    if (!totpRecoveryKeys) return;
    navigator.clipboard.writeText(totpRecoveryKeys.join("\n")).then(() => {
      setCopiedRecovery(true);
      setTimeout(() => setCopiedRecovery(false), 2000);
    });
  };

  const handleSignupSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validateUsername(username)) {
      setError(t("auth.formatTipUsername"));
      return;
    }
    if (!validatePassword(password)) {
      setError(t("auth.formatTipPassword"));
      return;
    }
    if (isTurnstileEnabled && authConfig?.turnstile_site_key && !turnstileToken) {
      setError(t("auth.turnstileRequired"));
      return;
    }

    setLoading(true);
    setError("");
    try {
      const breachCheck = await checkPasswordBreached(password, username);
      if (breachCheck.breached) {
        setError(t("auth.passwordLeaked", "This password has been exposed in a data breach or is too predictable. Please choose a different password."));
        setLoading(false);
        return;
      }
      const clientHash = await hashPasswordClient(password, username);
      const data = await signup({
        username,
        password: clientHash,
        turnstileToken,
        ...(requiresInviteCode ? { inviteCode: inviteCode.trim().toUpperCase() } : {})
      });

      if (data.accessToken) {
        setAccessToken(data.accessToken);
      }

      if (data.recoveryKey) {
        setTotpRecoveryKeys([data.recoveryKey]);
      }

      setIsPasswordlessSignup(false);
      setMfaChoice("choose");
      setSignupStep("totp");
    } catch (err: any) {
      if (err instanceof ApiError) {
        const fakeRes = { status: err.status } as Response;
        if (isPasswordLeaked(fakeRes, err.bodyText)) {
          setError(t("auth.passwordLeaked"));
        } else {
          setError(formatApiErrorMessage(err, t));
        }
      } else {
        setError(formatApiErrorMessage(err, t));
      }
      resetTurnstile();
    } finally {
      setLoading(false);
    }
  };

  const handleSkipPasswordSignup = async () => {
    if (!validateUsername(username)) {
      setError(t("auth.formatTipUsername"));
      return;
    }
    if (isTurnstileEnabled && authConfig?.turnstile_site_key && !turnstileToken) {
      setError(t("auth.turnstileRequired"));
      return;
    }

    setLoading(true);
    setError("");
    try {
      const data = await signup({
        username,
        skipPassword: true,
        turnstileToken,
        ...(requiresInviteCode ? { inviteCode: inviteCode.trim().toUpperCase() } : {})
      });

      if (data.accessToken) {
        setAccessToken(data.accessToken);
      }

      if (data.recoveryKey) {
        setTotpRecoveryKeys([data.recoveryKey]);
      }

      setIsPasswordlessSignup(true);
      setMfaChoice("choose");
      setSignupStep("totp");
    } catch (err: any) {
      setError(formatApiErrorMessage(err, t));
      resetTurnstile();
    } finally {
      setLoading(false);
    }
  };

  return {
    signupStep,
    setSignupStep,
    username,
    setUsername,
    inviteCode,
    setInviteCode,
    requiresInviteCode,
    password,
    setPassword,
    isPasswordlessSignup,
    mfaChoice,
    setMfaChoice,
    passkeyRegLoading,
    passkeyRegError,
    handleRegisterPasskey,
    handleChooseTotp,
    totpSetupToken,
    setTotpSetupToken,
    totpSetupData,
    setTotpSetupData,
    totpRecoveryKeys,
    setTotpRecoveryKeys,
    loading,
    error,
    setError,
    usernameFocused,
    setUsernameFocused,
    passwordFocused,
    setPasswordFocused,
    copiedRecovery,
    totpSetupLoading,
    totpSetupError,
    turnstileStatus,
    turnstileRef,
    isTurnstileEnabled,
    checkUsernameDuplicate,
    handleSignupUsernameSubmit,
    handleSignupTotpConfirm,
    handleCopySignupRecoveryKeys,
    handleSignupSubmit,
    handleSkipPasswordSignup
  };
};

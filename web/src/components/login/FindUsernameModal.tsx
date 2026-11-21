import React, { useState, useCallback } from "react";
import { Dialog, Button, Callout, Intent, Classes, Tag } from "@blueprintjs/core";
import { useTranslation } from "react-i18next";
import { Key, Copy, Check, UserCheck, RotateCcw } from "lucide-react";
import {
  getFindUsernameOptions,
  verifyFindUsernamePasskey,
  type FoundUsernameAccount
} from "../../services";
import { useTurnstile } from "../../hooks/useTurnstile";
import { isPasskeySupported, startPasskeyAuthentication } from "../../utils/webauthn";
import { formatApiErrorMessage } from "../../utils/auth";

export interface FindUsernameAuthConfig {
  turnstile_site_key: string;
  turnstile_enabled_login: boolean;
}

export interface FindUsernameModalProps {
  /** Whether the modal is open. */
  isOpen: boolean;
  /** Callback to close the modal. */
  onClose: () => void;
  /** Authentication config containing Turnstile toggles and site key. */
  authConfig: FindUsernameAuthConfig | null;
  /** Whether the global Turnstile script has finished loading. */
  turnstileReady: boolean;
  /** Callback invoked when the user chooses a recovered username to fill into login. */
  onSelectAccount: (username: string) => void;
}

type FindUsernameStep = "verify" | "result";

/**
 * Modal workflow for discovering forgotten usernames via WebAuthn Passkey assertion.
 * Supports many-to-many bindings where one Passkey credential ID may be linked to multiple accounts.
 */
export const FindUsernameModal: React.FC<FindUsernameModalProps> = ({
  isOpen,
  onClose,
  authConfig,
  turnstileReady,
  onSelectAccount
}) => {
  const { t } = useTranslation();
  const [step, setStep] = useState<FindUsernameStep>("verify");
  const [dialogOpened, setDialogOpened] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [accounts, setAccounts] = useState<FoundUsernameAccount[]>([]);
  const [copiedUserId, setCopiedUserId] = useState<string | null>(null);

  const passkeySupported = isPasskeySupported();
  const isTurnstileEnabled = Boolean(authConfig?.turnstile_enabled_login);

  const handleClearError = useCallback(() => {
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
    isActive: isOpen && dialogOpened && step === "verify",
    onError: setError,
    onClearError: handleClearError
  });

  const handleDialogClosed = useCallback((): void => {
    setStep("verify");
    setDialogOpened(false);
    setLoading(false);
    setError("");
    setAccounts([]);
    setCopiedUserId(null);
  }, []);

  const handleStartLookup = async (): Promise<void> => {
    if (!passkeySupported) {
      setError(t("auth.passkeyUnsupported", "Your browser does not support Passkeys."));
      return;
    }
    if (isTurnstileEnabled && !turnstileToken) {
      setError(t("auth.turnstileRequired", "Please complete the Turnstile security check first."));
      return;
    }

    setLoading(true);
    setError("");

    try {
      const options = await getFindUsernameOptions(turnstileToken);
      const assertion = (await startPasskeyAuthentication({
        challenge: options.challenge,
        rpId: options.rpId,
        timeout: options.timeout,
        userVerification: options.userVerification || "preferred"
      })) as Record<string, unknown>;

      const verifyRes = await verifyFindUsernamePasskey(options.challengeToken, assertion);
      if (!verifyRes.accounts || verifyRes.accounts.length === 0) {
        setError(t("auth.findUsernameNotFound", "No account found for this Passkey."));
        if (isTurnstileEnabled) resetTurnstile();
        return;
      }

      setAccounts(verifyRes.accounts);
      setStep("result");
    } catch (err: unknown) {
      const domErrorName = err && typeof err === "object" && "name" in err ? String((err as { name: unknown }).name) : "";
      if (domErrorName === "NotAllowedError" || domErrorName === "AbortError") {
        setError(t("auth.passkeyAuthFailed", "Passkey verification failed or was cancelled"));
      } else {
        setError(formatApiErrorMessage(err, t));
      }
      if (isTurnstileEnabled) {
        resetTurnstile();
      }
    } finally {
      setLoading(false);
    }
  };

  const handleResetToVerify = (): void => {
    setAccounts([]);
    setError("");
    setStep("verify");
  };

  const handleCopyUsername = async (account: FoundUsernameAccount): Promise<void> => {
    try {
      await navigator.clipboard.writeText(account.username);
      setCopiedUserId(account.userId);
      setTimeout(() => setCopiedUserId(null), 2000);
    } catch {
      // Fallback ignored if clipboard permission is unavailable
    }
  };

  const handleUseAccount = (username: string): void => {
    onSelectAccount(username);
    onClose();
  };

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      onOpened={() => setDialogOpened(true)}
      onClosed={handleDialogClosed}
      title={t("auth.findUsernameTitle", "Find Username with Passkey")}
      icon="key"
      className="max-w-md w-full rounded-2xl dark:bg-gray-900"
    >
      <div className={`${Classes.DIALOG_BODY} space-y-4`}>
        {error && (
          <Callout intent={Intent.DANGER} className="rounded-xl">
            {error}
          </Callout>
        )}

        {step === "verify" && (
          <div className="space-y-4">
            <div className="flex flex-col items-center text-center space-y-3 py-2">
              <div className="w-14 h-14 rounded-2xl bg-blue-50 dark:bg-blue-950/40 flex items-center justify-center text-blue-600 dark:text-blue-400">
                <Key size={28} />
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed m-0">
                {t(
                  "auth.findUsernameDesc",
                  "Verify with your registered Passkey to view all usernames associated with this credential."
                )}
              </p>
            </div>

            {!passkeySupported && (
              <Callout intent={Intent.WARNING} className="rounded-xl text-xs">
                {t("auth.passkeyUnsupported", "Your browser does not support Passkeys.")}
              </Callout>
            )}

            {isTurnstileEnabled && (
              <div className="py-1 flex justify-center min-h-16.25">
                <div ref={turnstileRef} />
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button minimal text={t("common.cancel", "Cancel")} onClick={onClose} disabled={loading} />
              <Button
                intent={Intent.PRIMARY}
                loading={loading || turnstileStatus === "verifying"}
                disabled={!passkeySupported || (isTurnstileEnabled && turnstileStatus !== "success")}
                onClick={handleStartLookup}
                icon={<Key size={14} />}
                text={t("auth.verifyWithPasskey", "Verify with Passkey")}
              />
            </div>
          </div>
        )}

        {step === "result" && (
          <div className="space-y-4">
            <Callout intent={Intent.SUCCESS} icon={null} className="rounded-xl text-xs">
              <div className="flex items-start gap-2">
                <UserCheck className="w-4 h-4 shrink-0 mt-0.5" />
                <span>
                  {accounts.length > 1
                    ? t(
                        "auth.findUsernameMultipleFound",
                        "Found {{count}} accounts bound to this Passkey. Choose one to fill into login:",
                        { count: accounts.length }
                      )
                    : t("auth.findUsernameSingleFound", "Found the account bound to this Passkey:")}
                </span>
              </div>
            </Callout>

            <div className="space-y-2.5 max-h-64 overflow-y-auto pr-1">
              {accounts.map((acc) => (
                <div
                  key={acc.userId}
                  className="p-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50/70 dark:bg-gray-800/60 flex items-center justify-between gap-3"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono font-semibold text-sm text-gray-900 dark:text-gray-100 break-all">
                        {acc.username}
                      </span>
                      {acc.passkeyName && (
                        <Tag minimal intent={Intent.PRIMARY} className="text-[11px]">
                          {acc.passkeyName}
                        </Tag>
                      )}
                    </div>
                    <div className="text-[11px] font-mono text-gray-500 dark:text-gray-400">
                      {t("account.userId", "User ID")}: {acc.userId}
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <Button
                      minimal
                      small
                      icon={copiedUserId === acc.userId ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
                      onClick={() => void handleCopyUsername(acc)}
                      title={t("common.copy", "Copy")}
                    />
                    <Button
                      small
                      intent={Intent.PRIMARY}
                      text={t("auth.useThisUsername", "Use")}
                      onClick={() => handleUseAccount(acc.username)}
                    />
                  </div>
                </div>
              ))}
            </div>

            <div className="flex justify-between items-center pt-2">
              <Button
                minimal
                icon={<RotateCcw size={14} />}
                text={t("auth.tryAnotherPasskey", "Try another Passkey")}
                onClick={handleResetToVerify}
              />
              <Button minimal text={t("common.close", "Close")} onClick={onClose} />
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
};

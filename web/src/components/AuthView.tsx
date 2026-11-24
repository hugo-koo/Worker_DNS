import React, { useState, useEffect } from "react";
import { Card, Elevation, Button } from "@blueprintjs/core";
import { useTranslation } from "react-i18next";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { ThemeSwitcher } from "./ThemeSwitcher";
import { GitHubLinkButton } from "./GitHubLinkButton";
import type { ThemeMode } from "../hooks/useTheme";
import { clsx } from "clsx";
import { ScrollingIntro } from "./ScrollingIntro";
import { LoginForm } from "./LoginForm";
import { SignupWizard } from "./SignupWizard";
import { LockScreenForm } from "./LockScreenForm";
import { loadTurnstileScript } from "../utils/auth";
import { getAuthConfig } from "../services";
import type { UserInfo } from "../services";

/**
 * Authentication configuration settings fetched from server.
 */
export interface AuthConfig {
  turnstile_site_key: string;
  turnstile_enabled_signup: boolean;
  turnstile_enabled_login: boolean;
  optional_session_expiration_days?: number;
  has_users?: boolean;
  registration_enabled?: boolean;
  invite_code_enabled?: boolean;
  max_users?: number | null;
  max_users_reached?: boolean;
}

/**
 * Properties for the AuthView component.
 */
export interface AuthViewProps {
  /** Callback triggered on successful login or complete signup. */
  onSuccess?: () => void;
  /** Whether the view is rendered in session lock mode. */
  isLocked?: boolean;
  /** Current logged in user info for the lock screen. */
  currentUser?: UserInfo | null;
  /** Callback triggered when user unlocks their session with PIN. */
  onUnlock?: () => void;
  /** Callback triggered to log out and terminate the locked session. */
  handleLogout?: () => Promise<void>;
  /** Active UI theme mode. */
  theme?: ThemeMode;
  /** Callback to update the active UI theme mode. */
  setTheme?: (theme: ThemeMode) => void;
}

/**
 * AuthView component orchestrates the user login, signup, and lock screen shells.
 * It displays the ScrollingIntro sidebar along with the active authentication card
 * (Login, Signup, or LockScreen PIN unlock).
 *
 * @param props - Component props containing authentication and lock screen state.
 * @returns React elements representing the full login/registration/lock screen view.
 */
export const AuthView: React.FC<AuthViewProps> = ({
  onSuccess,
  isLocked = false,
  currentUser,
  onUnlock,
  handleLogout,
  theme,
  setTheme,
}): React.ReactElement => {
  const [isLogin, setIsLogin] = useState<boolean>(true);
  const [isPanelVisible, setIsPanelVisible] = useState<boolean>(true);
  const [isBlurring, setIsBlurring] = useState<boolean>(false);
  const { t } = useTranslation();

  const handleToggleMode = (): void => {
    setIsBlurring(true);
    setTimeout(() => {
      setIsLogin((prev) => !prev);
      setIsBlurring(false);
    }, 300);
  };

  // Dynamic system configuration state
  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null);

  // Turnstile loading state
  const [turnstileReady, setTurnstileReady] = useState<boolean>(false);

  useEffect(() => {
    if (isLocked) return;
    const fetchConfig = async (): Promise<void> => {
      try {
        const configData = (await getAuthConfig()) as AuthConfig;
        setAuthConfig(configData);
        if (configData && configData.has_users === false) {
          setIsLogin(false);
        }
      } catch (e) {
        console.error("Failed to load auth config", e);
      }
    };
    fetchConfig();
  }, [isLocked]);

  const isTurnstileEnabled =
    !isLocked &&
    (isLogin
      ? authConfig?.turnstile_enabled_login
      : authConfig?.turnstile_enabled_signup);

  // Display exact host (including non-standard port) above the auth panel as an anti-phishing visual cue.
  const currentHost: string =
    typeof window !== "undefined"
      ? window.location.host || window.location.hostname
      : "";

  useEffect(() => {
    if (isTurnstileEnabled && authConfig?.turnstile_site_key) {
      loadTurnstileScript(() => {
        setTurnstileReady(true);
      });
    }
  }, [isTurnstileEnabled, authConfig]);

  return (
    <div className="flex flex-row min-h-screen bg-white dark:bg-gray-950 overflow-hidden relative">
      {/* Scroll Intro Sidebar (Left Panel) */}
      <div className="hidden lg:block w-1/2 h-screen overflow-hidden border-r border-gray-100 dark:border-gray-900">
        <ScrollingIntro />
      </div>

      {/* Floating Scroll Intro Sidebar for Mobile view */}
      <div
        className={`lg:hidden absolute inset-0 z-0 transition-opacity duration-500 cursor-pointer ${
          isPanelVisible ? "opacity-25" : "opacity-70"
        }`}
        onClick={() => setIsPanelVisible(true)}
      >
        <ScrollingIntro />
      </div>

      {!isPanelVisible && (
        <div className="lg:hidden fixed bottom-12 left-1/2 -translate-x-1/2 z-50 animate-bounce">
          <Button
            large
            intent="primary"
            icon={isLocked ? "lock" : "log-in"}
            text={isLocked ? t("auth.unlockSession", "解锁屏幕") : t("auth.loginBtn")}
            onClick={() => setIsPanelVisible(true)}
            className="shadow-2xl px-8 py-4 rounded-full"
          />
        </div>
      )}

      {/* Form Container Card (Right Panel) */}
      <div
        className={`flex-1 flex items-center justify-center p-4 max-sm:pt-14 relative z-10 bg-gray-50/50 dark:bg-gray-900/30 lg:bg-gray-50 lg:dark:bg-gray-900/50 transition-all duration-500 ease-in-out ${
          !isPanelVisible
            ? "max-lg:translate-x-full max-lg:opacity-0 max-lg:pointer-events-none"
            : "translate-x-0 opacity-100"
        }`}
        onClick={(e: React.MouseEvent<HTMLDivElement>) => {
          if (window.innerWidth < 1024 && e.target === e.currentTarget) {
            setIsPanelVisible(false);
          }
        }}
      >
        <div
          className="absolute top-4 right-4 z-50 flex items-center gap-2"
          onClick={(e: React.MouseEvent) => e.stopPropagation()}
        >
          <LanguageSwitcher />
          {theme !== undefined && setTheme !== undefined && (
            <ThemeSwitcher theme={theme} setTheme={setTheme} />
          )}
          <GitHubLinkButton />
        </div>

        <div
          className={clsx(
            "w-full max-w-md transition-all duration-200 ease-in-out transform-gpu",
            isBlurring ? "blur-lg opacity-20 scale-95" : "blur-0 opacity-100 scale-100"
          )}
        >
          {currentHost && (
            <div
              className="mb-3 text-center px-2"
              onClick={(e: React.MouseEvent) => e.stopPropagation()}
            >
              {/* Never truncate host with ellipsis so attackers cannot hide a trailing phishing domain */}
              <span className="font-mono text-xs opacity-50 break-all select-all">
                {currentHost}
              </span>
            </div>
          )}

          <Card
            elevation={Elevation.FOUR}
            className="w-full p-8 rounded-2xl shadow-none! z-10 dark:bg-gray-900 border border-gray-100 dark:border-gray-800"
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
          >
            {isLocked ? (
              <LockScreenForm
                currentUser={currentUser}
                onUnlock={onUnlock}
                handleLogout={handleLogout}
              />
            ) : isLogin ? (
              <LoginForm
                authConfig={authConfig}
                turnstileReady={turnstileReady}
                onSuccess={onSuccess || (() => {})}
                onToggleMode={handleToggleMode}
              />
            ) : (
              <SignupWizard
                authConfig={authConfig}
                turnstileReady={turnstileReady}
                onSuccess={onSuccess || (() => {})}
                onToggleMode={handleToggleMode}
              />
            )}
          </Card>
        </div>
      </div>
    </div>
  );
};

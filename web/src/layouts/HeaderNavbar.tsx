import React from "react";
import { Button, Navbar, Alignment, Spinner, PopoverNext, Menu, MenuItem } from "@blueprintjs/core";
import { useTranslation } from "react-i18next";
import { Sun, Moon, Monitor, Menu as MenuIcon, ChevronDown, Check } from "lucide-react";
import { LanguageSwitcher } from "../components/LanguageSwitcher";
import { SessionLockButton } from "../components/SessionLockButton";
import { MigrationStatusBadge } from "../components/MigrationStatusBadge";
import type { Profile, UserInfo } from "../types/auth";
import { useIsMobile } from "../hooks/useIsMobile";
import { ALLOWED_PROFILE_SECTIONS } from "../utils/navigation";
import { useHeaderTitleState } from "./HeaderTitleContext";

/**
 * Properties for the HeaderNavbar component.
 */
interface HeaderNavbarProps {
  /** Active UI theme. */
  theme: "light" | "dark" | "system";
  /** Callback to set active UI theme. */
  setTheme: (theme: "light" | "dark" | "system") => void;
  /** Currently selected Profile object. */
  selectedProfile: Profile | null;
  /** Available profiles list for dropdown switching. */
  profiles: Profile[];
  /** Callback to switch active profile. */
  setSelectedProfile: (p: Profile) => void;
  /** True if there is a selected/active profile. */
  isProfileActive: boolean;
  /** Router location object. */
  location: { pathname: string };
  /** Router navigation function. */
  navigate: (path: string) => void;
  /** True if a background saving operation is active. */
  isSaving?: boolean;
  /** Current logged in user info. */
  currentUser?: UserInfo | null;
  /** True if viewport is mobile. */
  isMobile?: boolean;
  /** True if sidebar is open. */
  isSidebarOpen?: boolean;
  /** Callback to toggle mobile sidebar. */
  onToggleSidebar?: () => void;
}

interface StickyTitleTextProps {
  title: string;
  isVisible: boolean;
}

/**
 * Renders the animated page title with smooth upward fade-in and downward fade-out transitions.
 */
const StickyTitleText: React.FC<StickyTitleTextProps> = ({ title, isVisible }) => (
  <span
    aria-hidden={!isVisible}
    style={{
      transform: isVisible ? "translate3d(0, 0, 0)" : "translate3d(0, 14px, 0)",
      opacity: isVisible ? 1 : 0,
      transition: isVisible
        ? "transform 280ms cubic-bezier(0.22, 1, 0.36, 1), opacity 260ms ease-out"
        : "transform 240ms cubic-bezier(0.4, 0, 1, 1), opacity 180ms ease-out"
    }}
    className="block truncate text-sm sm:text-base font-bold tracking-tight text-gray-900 dark:text-gray-100 will-change-[transform,opacity]"
  >
    {title}
  </span>
);

/**
 * HeaderNavbar component renders the top sticky/blurred toolbar.
 * Shows the active profile name with a switcher dropdown on `/dash` routes when a Profile is selected;
 * hides profile selection on non-`/dash` routes or when no Profile is selected.
 */
export const HeaderNavbar: React.FC<HeaderNavbarProps> = ({
  theme,
  setTheme,
  selectedProfile,
  profiles,
  setSelectedProfile,
  isProfileActive,
  location,
  navigate,
  isSaving,
  currentUser,
  isMobile,
  isSidebarOpen,
  onToggleSidebar,
}) => {
  const { t } = useTranslation();
  const isMobileHook = useIsMobile();
  const mobile = isMobile ?? isMobileHook;
  const isDashRoute = location.pathname === "/dash" || location.pathname.startsWith("/dash/");
  const hasProfileSelector = Boolean(isDashRoute && isProfileActive && selectedProfile);
  const headerTitle = useHeaderTitleState();

  const handleSelectProfileFromHeader = (target: Profile) => {
    setSelectedProfile(target);
    const parts = location.pathname.split("/").filter(Boolean); // ['dash', profileId, section]
    if (parts[0] === "dash" && parts.length >= 3 && ALLOWED_PROFILE_SECTIONS.has(parts[2])) {
      navigate(`/dash/${target.id}/${parts[2]}`);
    }
  };

  return (
    <Navbar
      className="absolute! top-0 left-0 right-0 border-b! border-gray-200/50 dark:border-gray-800/50 shadow-none! bg-white/70! dark:bg-gray-900/70! backdrop-blur-lg! h-14 items-center px-4 shrink-0"
      style={{ zIndex: 10, transform: "translateZ(0)", willChange: "transform" }}
    >
      <Navbar.Group align={Alignment.LEFT}>
        {mobile && (
          <Button
            variant="minimal"
            icon={<MenuIcon size={18} />}
            className="md:hidden! mr-2 text-gray-700 dark:text-gray-200"
            onClick={onToggleSidebar}
            aria-label={isSidebarOpen ? t("common.close", "关闭") : t("common.menu", "菜单")}
          />
        )}
        {hasProfileSelector && selectedProfile && (
          <PopoverNext
            placement="bottom-start"
            animation="minimal"
            arrow={false}
            content={
              <Menu>
                {profiles.map((p) => {
                  const isCurrent = p.id === selectedProfile.id;
                  return (
                    <MenuItem
                      key={p.id}
                      text={p.name}
                      label={p.id}
                      active={isCurrent}
                      icon={isCurrent ? <Check size={14} /> : <span className="inline-block w-3.5" />}
                      onClick={() => handleSelectProfileFromHeader(p)}
                    />
                  );
                })}
              </Menu>
            }
          >
            <Button
              variant="minimal"
              className="font-bold! text-blue-600! dark:text-blue-400! px-2!"
              endIcon={<ChevronDown size={14} />}
            >
              <span className="truncate max-w-36 md:max-w-xs inline-block align-middle">
                {selectedProfile.name}
              </span>
            </Button>
          </PopoverNext>
        )}
        {mobile && !hasProfileSelector && headerTitle.title && (
          <div
            key={location.pathname}
            className="pointer-events-none flex items-center min-w-0 max-w-[calc(100vw-13.5rem)] sm:max-w-xs"
          >
            <StickyTitleText title={headerTitle.title} isVisible={headerTitle.isVisible} />
          </div>
        )}
      </Navbar.Group>

      {!mobile && headerTitle.title && (
        <div
          key={location.pathname}
          className="pointer-events-none absolute inset-0 flex items-center justify-center px-4"
        >
          <div className="flex items-center justify-center max-w-xs md:max-w-md">
            <StickyTitleText title={headerTitle.title} isVisible={headerTitle.isVisible} />
          </div>
        </div>
      )}

      <Navbar.Group align={Alignment.RIGHT}>
        <div className="flex items-center gap-2">
          {isSaving && (
            <div className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-blue-600 dark:text-blue-400 bg-blue-50/80 dark:bg-blue-950/50 border border-blue-200/50 dark:border-blue-800/50 rounded-full animate-pulse mr-1">
              <Spinner size={12} />
              <span>{t("settings.saving")}</span>
            </div>
          )}
          <SessionLockButton currentUser={currentUser} />
          <MigrationStatusBadge currentUser={currentUser} onNavigate={navigate} />
          <LanguageSwitcher />
          <div className="flex items-center gap-1 bg-gray-100/50 dark:bg-gray-800/50 p-1 rounded-lg">
            <Button
              variant="minimal"
              icon={<Sun size={14} />}
              size="small"
              active={theme === "light"}
              onClick={() => setTheme("light")}
            />
            <Button
              variant="minimal"
              icon={<Moon size={14} />}
              size="small"
              active={theme === "dark"}
              onClick={() => setTheme("dark")}
            />
            <Button
              variant="minimal"
              icon={<Monitor size={14} />}
              size="small"
              active={theme === "system"}
              onClick={() => setTheme("system")}
            />
          </div>
          <a
            href="https://github.com/Oppidi/DNS-Worker"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="View source on GitHub"
            title="GitHub"
            className="hidden sm:inline-flex items-center justify-center w-7 h-7 rounded-md text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current" aria-hidden="true">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
            </svg>
          </a>
        </div>
      </Navbar.Group>
    </Navbar>
  );
};

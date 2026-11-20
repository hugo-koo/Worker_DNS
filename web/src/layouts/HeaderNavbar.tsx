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
        {isDashRoute && isProfileActive && selectedProfile && (
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
      </Navbar.Group>
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
        </div>
      </Navbar.Group>
    </Navbar>
  );
};

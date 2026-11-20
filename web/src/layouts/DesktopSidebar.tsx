import React, { useEffect } from "react";
import {
  Button,
  Menu,
  MenuItem,
  PopoverNext,
  Intent,
  Tag,
} from "@blueprintjs/core";
import { useTranslation } from "react-i18next";
import {
  Edit3,
  BarChart3,
  Clock,
  Download,
  MonitorSmartphone,
  LayoutGrid,
  ListFilter,
  Settings,
  User as UserIcon,
  LogOut,
  Menu as MenuIcon,
  Server,
  X,
} from "lucide-react";
import { clsx } from "clsx";
import LogoIcon from "../assets/obex_cat_eye_logo-256.webp";
import type { Profile, UserInfo } from "../types/auth";
import { useUpstreamUpdate } from "../hooks/useUpstreamUpdate";
import { createSpaLinkClickHandler } from "../utils/navigation";

/**
 * Properties for the DesktopSidebar component.
 */
interface DesktopSidebarProps {
  /** True if sidebar is expanded. */
  isSidebarOpen: boolean;
  /** Callback to set expanded/collapsed state. */
  setIsSidebarOpen: (open: boolean) => void;
  /** True if active screen viewport is mobile. */
  isMobile?: boolean;
  /** True if there is a selected/active profile. */
  isProfileActive: boolean;
  /** Active profile ID, if any. */
  activeId: string | undefined;
  /** Available profiles list for single-profile auto-selection. */
  profiles: Profile[];
  /** Callback to select a profile directly. */
  setSelectedProfile: (p: Profile) => void;
  /** Router location object. */
  location: { pathname: string };
  /** Router navigation function. */
  navigate: (path: string) => void;
  /** Callback to handle user logout action. */
  handleLogout: () => void;
  /** Current logged in user info. */
  currentUser: UserInfo | null;
}

/**
 * Renders the 3-section sidebar navigation (`Access Points`, `Profiles`, `Preferences`)
 * on desktop and mobile screens.
 */
export const DesktopSidebar: React.FC<DesktopSidebarProps> = ({
  isSidebarOpen,
  setIsSidebarOpen,
  isMobile = false,
  isProfileActive,
  activeId,
  profiles,
  setSelectedProfile,
  location,
  navigate,
  handleLogout,
  currentUser,
}) => {
  const { t } = useTranslation();
  const { hasUpdate, latestTag, appVersion, gitTag, gitCommit } = useUpstreamUpdate();

  const touchStartRef = React.useRef<{ x: number; y: number; time: number } | null>(null);
  const [dragOffset, setDragOffset] = React.useState<number | null>(null);
  const [dragOpenOffset, setDragOpenOffset] = React.useState<number | null>(null);

  useEffect(() => {
    if (!isSidebarOpen) {
      setDragOffset(null);
      touchStartRef.current = null;
    }
  }, [isSidebarOpen]);

  const handleTouchStart = (e: React.TouchEvent) => {
    if (!isMobile || !isSidebarOpen) return;
    const touch = e.touches[0];
    touchStartRef.current = { x: touch.clientX, y: touch.clientY, time: Date.now() };
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!isMobile || !isSidebarOpen || !touchStartRef.current) return;
    const touch = e.touches[0];
    const diffX = touch.clientX - touchStartRef.current.x;
    const diffY = touch.clientY - touchStartRef.current.y;

    if (diffX < 0 && Math.abs(diffX) > Math.abs(diffY)) {
      setDragOffset(Math.min(0, diffX));
    }
  };

  const handleTouchEnd = () => {
    if (!touchStartRef.current) return;
    const duration = Date.now() - touchStartRef.current.time;
    const offset = dragOffset ?? 0;

    if (offset < -50 || (duration < 300 && offset < -20)) {
      setIsSidebarOpen(false);
    }
    setDragOffset(null);
    touchStartRef.current = null;
  };

  const handleTouchCancel = () => {
    setDragOffset(null);
    touchStartRef.current = null;
  };

  useEffect(() => {
    if (!isMobile || isSidebarOpen) {
      setDragOpenOffset(null);
      return;
    }

    let startTouch: { x: number; y: number; time: number } | null = null;
    let isSwiping = false;

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      if (touch.clientX <= 35) {
        startTouch = { x: touch.clientX, y: touch.clientY, time: Date.now() };
        isSwiping = false;
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!startTouch) return;
      const touch = e.touches[0];
      const diffX = touch.clientX - startTouch.x;
      const diffY = touch.clientY - startTouch.y;

      if (!isSwiping) {
        if (diffX > 8 && Math.abs(diffX) > Math.abs(diffY) * 1.2) {
          isSwiping = true;
        } else if (Math.abs(diffY) > 10) {
          startTouch = null;
          return;
        }
      }

      if (isSwiping && diffX > 0) {
        setDragOpenOffset(Math.min(0, -256 + diffX));
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (!startTouch) return;
      if (isSwiping) {
        const touch = e.changedTouches[0];
        const diffX = touch.clientX - startTouch.x;
        const duration = Date.now() - startTouch.time;
        if (diffX > 70 || (duration < 300 && diffX > 25)) {
          setIsSidebarOpen(true);
        }
      }
      startTouch = null;
      isSwiping = false;
      setDragOpenOffset(null);
    };

    const onTouchCancel = () => {
      startTouch = null;
      isSwiping = false;
      setDragOpenOffset(null);
    };

    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    window.addEventListener("touchcancel", onTouchCancel, { passive: true });

    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onTouchCancel);
    };
  }, [isMobile, isSidebarOpen, setIsSidebarOpen]);

  useEffect(() => {
    if (!isMobile || !isSidebarOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsSidebarOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isMobile, isSidebarOpen, setIsSidebarOpen]);

  const showText = isMobile ? true : isSidebarOpen;
  const closeMobileSidebar = isMobile ? () => setIsSidebarOpen(false) : undefined;

  /**
   * Resolves target href and click handler for Profile-scoped sections (`Analytics`..`Settings`).
   * Auto-selects the sole Profile when only 1 exists; otherwise directs to Collections (`/dash?next=section`).
   */
  const resolveProfileSectionHref = (section: string): string => {
    if (isProfileActive && activeId) {
      return `/dash/${activeId}/${section}`;
    }
    if (profiles.length === 1) {
      return `/dash/${profiles[0].id}/${section}`;
    }
    return `/dash?next=${encodeURIComponent(section)}`;
  };

  const handleProfileSectionClick = (section: string) => (e: React.MouseEvent<HTMLElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) {
      return;
    }
    e.preventDefault();
    if (isProfileActive && activeId) {
      navigate(`/dash/${activeId}/${section}`);
    } else if (profiles.length === 1) {
      setSelectedProfile(profiles[0]);
      navigate(`/dash/${profiles[0].id}/${section}`);
    } else {
      navigate(`/dash?next=${encodeURIComponent(section)}`);
    }
    closeMobileSidebar?.();
  };

  const profileMenuItems = [
    { id: "stats", label: t("nav.stats"), icon: <BarChart3 size={18} /> },
    { id: "logs", label: t("nav.logs"), icon: <Clock size={18} /> },
    { id: "rules", label: t("nav.rules"), icon: <Edit3 size={18} /> },
    { id: "filter", label: t("nav.filter"), icon: <ListFilter size={18} /> },
    { id: "settings", label: t("nav.settings"), icon: <Settings size={18} /> },
  ];

  const renderGroupHeader = (label: string, isFirst = false) =>
    showText ? (
      <li
        className={clsx(
          "px-3 pb-1 text-[10px] font-bold uppercase tracking-wider text-gray-400 dark:text-gray-500 select-none",
          isFirst ? "pt-1" : "pt-4"
        )}
      >
        {label}
      </li>
    ) : !isFirst ? (
      <li className="my-2 border-t border-gray-100 dark:border-gray-800" />
    ) : null;

  return (
    <>
      {isMobile && (isSidebarOpen || dragOpenOffset !== null) && (
        <div
          className="fixed inset-0 bg-black/40 backdrop-blur-xs z-40 transition-opacity md:hidden!"
          onClick={() => setIsSidebarOpen(false)}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={handleTouchCancel}
          style={
            dragOffset !== null
              ? {
                  opacity: Math.max(0, 1 - Math.abs(dragOffset) / 256),
                  transition: "none",
                }
              : dragOpenOffset !== null
              ? {
                  opacity: Math.max(0, Math.min(1, (256 + dragOpenOffset) / 256)),
                  transition: "none",
                }
              : undefined
          }
          aria-hidden="true"
        />
      )}

      <aside
        className={clsx(
          "flex flex-col border-r border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900",
          isMobile
            ? clsx(
                "fixed inset-y-0 left-0 z-50 w-64 shadow-2xl transform select-none",
                isSidebarOpen || dragOpenOffset !== null
                  ? "translate-x-0"
                  : "-translate-x-full pointer-events-none"
              )
            : clsx(
                "relative z-20 shrink-0",
                isSidebarOpen ? "w-64" : "w-16"
              ),
          dragOffset === null && dragOpenOffset === null && "transition-all duration-300"
        )}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchCancel}
        style={
          isMobile && isSidebarOpen && dragOffset !== null
            ? {
                transform: `translateX(${dragOffset}px)`,
                transition: "none",
              }
            : isMobile && dragOpenOffset !== null
            ? {
                transform: `translateX(${dragOpenOffset}px)`,
                transition: "none",
              }
            : undefined
        }
      >
        <div className="h-14 flex items-center pl-3.5 pr-2 shrink-0 justify-between">
          <div className="flex items-center min-w-0">
            <img
              src={LogoIcon}
              alt="DNS Worker"
              className="w-8 h-8 object-contain shrink-0"
            />
            {showText && (
              <div className="ml-2.5 flex flex-col justify-center min-w-0 flex-1">
                <div className="flex items-baseline gap-1.5 min-w-0">
                  <span className="font-bold text-base leading-tight dark:text-white shrink-0">
                    DNS Worker
                  </span>
                  <span
                    className="text-xs text-gray-500 dark:text-gray-400 font-mono leading-tight truncate shrink-0 inline-flex items-center"
                    title={hasUpdate ? (latestTag ? `New version available: ${latestTag}` : "Update available") : appVersion}
                  >
                    {hasUpdate ? (
                      <a
                        href="https://github.com/Oppidi/DNS-Worker/releases"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-amber-500 dark:text-amber-400 hover:underline transition-colors"
                      >
                        {gitTag}
                      </a>
                    ) : (
                      <span>{gitTag}</span>
                    )}
                    {gitCommit ? `-${gitCommit}` : ""}
                  </span>
                </div>
                <span
                  className="text-xs text-gray-500 dark:text-gray-400 font-mono leading-tight mt-0.5 truncate select-all"
                  title={typeof window !== "undefined" ? window.location.host || window.location.hostname : ""}
                >
                  {typeof window !== "undefined" ? window.location.host || window.location.hostname : ""}
                </span>
              </div>
            )}
          </div>
          {isMobile && (
            <Button
              variant="minimal"
              icon={<X size={18} />}
              onClick={() => setIsSidebarOpen(false)}
              className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-200"
              aria-label={t("common.close", "关闭")}
            />
          )}
        </div>

        <div className="flex-1 py-3 px-2 overflow-y-auto overflow-x-hidden">
          <Menu className="bg-transparent p-0">
            {/* Group 1: Access Points */}
            {renderGroupHeader(t("nav.groupAccessPoints", "Access Points"), true)}
            <MenuItem
              href="/access-points/manage"
              icon={<MonitorSmartphone size={18} />}
              text={showText ? t("nav.manage", "Manage") : ""}
              active={location.pathname.startsWith("/access-points/manage")}
              onClick={createSpaLinkClickHandler("/access-points/manage", navigate, closeMobileSidebar)}
            />
            <MenuItem
              href="/access-points/setup"
              icon={<Download size={18} />}
              text={showText ? t("nav.setup") : ""}
              active={location.pathname.startsWith("/access-points/setup")}
              onClick={createSpaLinkClickHandler("/access-points/setup", navigate, closeMobileSidebar)}
            />

            {/* Group 2: Profiles */}
            {renderGroupHeader(t("nav.groupProfiles", "Profiles"))}
            <MenuItem
              href="/dash"
              icon={<LayoutGrid size={18} />}
              text={showText ? t("nav.collections", "Collections") : ""}
              active={location.pathname === "/dash"}
              onClick={createSpaLinkClickHandler("/dash", navigate, closeMobileSidebar)}
            />
            {profileMenuItems.map((item) => {
              const targetHref = resolveProfileSectionHref(item.id);
              const isSectionActive = isProfileActive && location.pathname.endsWith(`/${item.id}`);
              return (
                <MenuItem
                  key={item.id}
                  href={targetHref}
                  icon={item.icon as any}
                  text={showText ? item.label : ""}
                  className={clsx(
                    !isProfileActive && profiles.length !== 1 && "opacity-60 hover:opacity-90 transition-opacity cursor-pointer"
                  )}
                  title={
                    !isProfileActive && profiles.length !== 1
                      ? t("nav.noActiveProfileHint", "未选择配置，点击前往配置列表")
                      : undefined
                  }
                  active={isSectionActive}
                  onClick={handleProfileSectionClick(item.id)}
                />
              );
            })}

            {/* Group 3: Preferences */}
            {renderGroupHeader(t("nav.groupPreferences", "Preferences"))}
            <MenuItem
              href="/account"
              icon={<UserIcon size={18} />}
              text={showText ? t("common.account") : ""}
              active={location.pathname === "/account"}
              onClick={createSpaLinkClickHandler("/account", navigate, closeMobileSidebar)}
            />
            {currentUser?.role === "admin" && (
              <MenuItem
                href="/system"
                icon={<Server size={18} />}
                text={showText ? t("common.system") : ""}
                active={location.pathname === "/system"}
                onClick={createSpaLinkClickHandler("/system", navigate, closeMobileSidebar)}
              />
            )}
            <PopoverNext
              className="w-full"
              placement="right-end"
              content={
                <div className="p-4 space-y-3">
                  <div className="font-bold text-sm">
                    {t("common.confirmLogout")}
                  </div>
                  <Button
                    fill
                    intent={Intent.DANGER}
                    text={t("common.logout")}
                    onClick={() => {
                      if (isMobile) setIsSidebarOpen(false);
                      handleLogout();
                    }}
                  />
                </div>
              }
            >
              <MenuItem
                icon={<LogOut size={18} />}
                text={showText ? t("common.logout") : ""}
                intent={Intent.DANGER}
                shouldDismissPopover={false}
              />
            </PopoverNext>
          </Menu>
        </div>

        <div className="p-4 border-t border-gray-100 dark:border-gray-800 flex items-center justify-between">
          {!isMobile && (
            <Button
              variant="minimal"
              icon={<MenuIcon size={18} />}
              onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            />
          )}
          {showText && (
            <Tag minimal round>
              {currentUser?.username.toUpperCase() || "USER"}
            </Tag>
          )}
        </div>
      </aside>
    </>
  );
};

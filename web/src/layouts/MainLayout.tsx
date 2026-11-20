import { useEffect } from "react";
import { useParams } from "react-router-dom";
import { useIsMobile } from "../hooks/useIsMobile";
import type { Profile, UserInfo } from "../types/auth";
import { DesktopSidebar } from "./DesktopSidebar";
import { HeaderNavbar } from "./HeaderNavbar";

/**
 * Properties for the MainLayout component.
 */
interface MainLayoutProps {
  /** The child route views to render. */
  children: React.ReactNode;
  /** True if desktop sidebar is expanded. */
  isSidebarOpen: boolean;
  /** Callback to set desktop sidebar expand/collapse state. */
  setIsSidebarOpen: (open: boolean) => void;
  /** Current active UI theme. */
  theme: "light" | "dark" | "system";
  /** Callback to set UI theme. */
  setTheme: (theme: "light" | "dark" | "system") => void;
  /** Selected Profile object. */
  selectedProfile: Profile | null;
  /** Available profiles list. */
  profiles: Profile[];
  /** Callback to set selected Profile. */
  setSelectedProfile: (p: Profile) => void;
  /** Router location object. */
  location: { pathname: string };
  /** Router navigation function. */
  navigate: (path: string) => void;
  /** Callback to handle logouts. */
  handleLogout: () => void;
  /** Current logged in user info. */
  currentUser: UserInfo | null;
  /** True if a background saving operation is active. */
  isSaving?: boolean;
}

/**
 * MainLayout establishes the responsive sidebar + top header template framing
 * for all authenticated routes.
 */
export const MainLayout = ({
  children,
  isSidebarOpen,
  setIsSidebarOpen,
  theme,
  setTheme,
  selectedProfile,
  profiles,
  setSelectedProfile,
  location,
  navigate,
  handleLogout,
  currentUser,
  isSaving,
}: MainLayoutProps) => {
  const { profileId: urlProfileId } = useParams();
  const isMobile = useIsMobile();
  const activeId = urlProfileId || selectedProfile?.id;
  const isProfileActive = Boolean(activeId && selectedProfile);

  useEffect(() => {
    if (
      urlProfileId &&
      profiles.length > 0 &&
      selectedProfile?.id !== urlProfileId
    ) {
      const found = profiles.find((p: Profile) => p.id === urlProfileId);
      if (found) setSelectedProfile(found);
    }
  }, [urlProfileId, profiles, selectedProfile, setSelectedProfile]);

  return (
    <div className="flex h-screen w-full bg-white dark:bg-gray-950 overflow-hidden flex-col md:flex-row">
      <DesktopSidebar
        isSidebarOpen={isSidebarOpen}
        setIsSidebarOpen={setIsSidebarOpen}
        isMobile={isMobile}
        isProfileActive={Boolean(activeId)}
        activeId={activeId}
        profiles={profiles}
        setSelectedProfile={setSelectedProfile}
        location={location}
        navigate={navigate}
        handleLogout={handleLogout}
        currentUser={currentUser}
      />

      <main className="flex-1 min-w-0 h-full relative bg-gray-50/20 dark:bg-gray-950/20 flex flex-col overflow-hidden">
        <HeaderNavbar
          theme={theme}
          setTheme={setTheme}
          selectedProfile={selectedProfile}
          profiles={profiles}
          setSelectedProfile={setSelectedProfile}
          isProfileActive={isProfileActive}
          location={location}
          navigate={navigate}
          isSaving={isSaving}
          currentUser={currentUser}
          isMobile={isMobile}
          isSidebarOpen={isSidebarOpen}
          onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)}
        />

        <div className="flex-1 min-h-0 flex flex-col relative z-0 isolate" style={{ isolation: "isolate" }}>
          {location.pathname.endsWith("/logs") ? (
            <div className="flex-1 overflow-y-auto">{children}</div>
          ) : (
            <div className="flex-1 overflow-y-auto pt-14">
              <div className="p-2 md:p-4 pb-6 md:pb-8">{children}</div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
};

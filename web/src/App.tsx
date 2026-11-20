import { useState, useEffect, useRef, Suspense } from "react";
import type React from "react";
import { Spinner, OverlayToaster } from "@blueprintjs/core";
import { useTranslation } from "react-i18next";
import { Helmet } from "react-helmet-async";
import { Routes, Route, useNavigate, useLocation, Navigate } from "react-router-dom";
import { GitHubCorner } from "./components/GithubCorner";
import { lazyWithPreload } from "./utils/lazyWithPreload";
import { DashboardHomeView } from "./views/DashboardHomeView";
import { MainLayout } from "./layouts/MainLayout";
import { NotFoundView } from "./views/NotFoundView";
import { ProfileRoutes } from "./routes/ProfileRoutes";
import type { Profile } from "./services";
import { useTheme } from "./hooks/useTheme";
import { usePageMeta } from "./hooks/usePageMeta";
import { useAuth } from "./hooks/useAuth";
import { useProfiles } from "./hooks/useProfiles";
import { IdleSessionLock } from "./components/IdleSessionLock";
import { DeploymentGuideView } from "./views/DeploymentGuideView";
import { loadLocale } from "./i18n/config";

import { AuthView } from "./components/AuthView";
import { resolveTargetProfileSection } from "./utils/navigation";

const AccountView = lazyWithPreload(() =>
  import("./views/AccountView").then((m) => ({ default: m.AccountView })),
);

const SystemView = lazyWithPreload(() =>
  import("./views/SystemView").then((m) => ({ default: m.SystemView })),
);

const AccessPointsManageView = lazyWithPreload(() =>
  import("./views/AccessPointsManageView").then((m) => ({ default: m.AccessPointsManageView })),
);

const SetupView = lazyWithPreload(() =>
  import("./views/SetupView").then((m) => ({ default: m.SetupView })),
);

function App() {
  const [isSidebarOpen, setIsSidebarOpen] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth >= 768 : true
  );
  const navigate = useNavigate();
  const location = useLocation();
  const toasterRef = useRef<OverlayToaster | null>(null);
  const { i18n } = useTranslation();

  const { theme, setTheme } = useTheme();
  const pageMeta = usePageMeta();
  const { isLoggedIn, currentUser, checkAuth, handleLogout } = useAuth(toasterRef);

  const {
    profiles,
    selectedProfile,
    setSelectedProfile,
    showCreateDialog,
    setShowCreateDialog,
    newProfileName,
    setNewProfileName,
    createError,
    prefilledRule,
    setPrefilledRule,
    fetchProfiles,
    handleCreateProfile,
    handleRenameProfile,
    handleDeleteProfile,
    handleQuickAction,
  } = useProfiles(isLoggedIn);

  const [isSaving, setIsSaving] = useState(false);
  const [localeReady, setLocaleReady] = useState(false);

  useEffect(() => {
    loadLocale(i18n.language).finally(() => {
      setLocaleReady(true);
    });
  }, [i18n.language]);

  if (!localeReady) {
    return (
      <div className="h-screen flex items-center justify-center">
        <Spinner size={50} />
      </div>
    );
  }

  const isDbMissing = (window as any).DNS_WORKER_CONFIG?.isDbMissing;
  const isDbQuotaExceeded = (window as any).DNS_WORKER_CONFIG?.isDbQuotaExceeded;
  const isJwtSecretMissing = (window as any).DNS_WORKER_CONFIG?.isJwtSecretMissing;
  if (isDbMissing || isJwtSecretMissing || isDbQuotaExceeded) {
    return <DeploymentGuideView />;
  }

  if (isLoggedIn === null) {
    return (
      <div className="h-screen flex items-center justify-center">
        <GitHubCorner />
        <Spinner size={50} />
      </div>
    );
  }

  if (!isLoggedIn) {
    return (
      <Suspense
        fallback={
          <div className="h-screen flex items-center justify-center">
            <Spinner size={50} />
          </div>
        }
      >
        <Helmet>
          <title>{pageMeta.title}</title>
          <meta name="description" content={pageMeta.description} />
          <html lang={i18n.language} />
        </Helmet>
        <GitHubCorner />
        <OverlayToaster position="bottom" ref={toasterRef} />
        <AuthView onSuccess={checkAuth} />
      </Suspense>
    );
  }

  const wrapMainLayout = (content: React.ReactNode): React.ReactNode => (
    <MainLayout
      isSidebarOpen={isSidebarOpen}
      setIsSidebarOpen={setIsSidebarOpen}
      theme={theme}
      setTheme={setTheme}
      selectedProfile={selectedProfile}
      profiles={profiles}
      setSelectedProfile={setSelectedProfile}
      location={location}
      navigate={navigate}
      handleLogout={handleLogout}
      currentUser={currentUser}
      isSaving={isSaving}
    >
      {content}
    </MainLayout>
  );

  return (
    <Suspense
      fallback={
        <div className="h-screen flex items-center justify-center">
          <Spinner size={50} />
        </div>
      }
    >
      <Helmet>
        <title>{pageMeta.title}</title>
        <meta name="description" content={pageMeta.description} />
        <html lang={i18n.language} />
      </Helmet>
      <GitHubCorner />
      <OverlayToaster position="bottom" ref={toasterRef} />
      <IdleSessionLock currentUser={currentUser} handleLogout={handleLogout} onUnlock={fetchProfiles}>
        <Routes>
          <Route path="/" element={<Navigate to="/access-points/setup" replace />} />
          <Route path="/access-points" element={<Navigate to="/access-points/manage" replace />} />
          <Route
            path="/access-points/manage"
            element={wrapMainLayout(
              <AccessPointsManageView
                profiles={profiles}
                selectedProfile={selectedProfile}
                toasterRef={toasterRef}
              />
            )}
          />
          <Route
            path="/access-points/setup"
            element={wrapMainLayout(<SetupView profiles={profiles} toasterRef={toasterRef} />)}
          />
          <Route
            path="/dash"
            element={(() => {
              const targetSection = resolveTargetProfileSection(location.search);
              return wrapMainLayout(
                <DashboardHomeView
                  profiles={profiles}
                  selectedProfileId={selectedProfile?.id}
                  targetSection={targetSection}
                  onSelect={(p: Profile) => {
                    setSelectedProfile(p);
                    navigate(`/dash/${p.id}/${targetSection}`);
                  }}
                  onCreate={handleCreateProfile}
                  onRename={handleRenameProfile}
                  showCreate={showCreateDialog}
                  setShowCreate={setShowCreateDialog}
                  newName={newProfileName}
                  setNewName={setNewProfileName}
                  error={createError}
                  onDelete={handleDeleteProfile}
                  onRefresh={fetchProfiles}
                  toasterRef={toasterRef}
                />
              );
            })()}
          />
          <Route
            path="/dash/:profileId/*"
            element={wrapMainLayout(
              <ProfileRoutes
                selectedProfile={selectedProfile}
                prefilledRule={prefilledRule}
                setPrefilledRule={setPrefilledRule}
                handleQuickAction={handleQuickAction}
                toasterRef={toasterRef}
                currentUser={currentUser}
                onSavingChange={setIsSaving}
              />
            )}
          />
          <Route
            path="/account"
            element={wrapMainLayout(<AccountView onSavingChange={setIsSaving} toasterRef={toasterRef} />)}
          />
          <Route
            path="/system"
            element={wrapMainLayout(<SystemView onSavingChange={setIsSaving} toasterRef={toasterRef} />)}
          />
          <Route path="*" element={<NotFoundView />} />
        </Routes>
      </IdleSessionLock>
    </Suspense>
  );
}

export default App;

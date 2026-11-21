import React, { useEffect, useState, useCallback } from "react";
import { Button, Intent, InputGroup, Spinner, NonIdealState, OverlayToaster } from "@blueprintjs/core";
import { Plus, MonitorSmartphone, Filter } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { clsx } from "clsx";
import type { AccessPoint, Profile } from "../../types/auth";
import { getAccessPoints } from "../../services";
import { useIsMobile } from "../../hooks/useIsMobile";
import { useAccessPoints } from "../SetupView/hooks/useAccessPoints";
import { AddAccessPointDialog } from "../SetupView/components/AddAccessPointDialog";
import { RenameAccessPointDialog } from "../SetupView/components/RenameAccessPointDialog";
import { AccessPointSection } from "../SetupView/components/AccessPointSection";
import { MinimalSelect } from "../../components/MinimalSelect";
import { PAGE_CONTAINER_WIDE } from "../../constants/layout";
import { useStickyHeaderTitle } from "../../layouts/HeaderTitleContext";

export interface AccessPointsManageViewProps {
  profiles: Profile[];
  selectedProfile: Profile | null;
  toasterRef?: React.RefObject<OverlayToaster | null>;
}

/**
 * Top-level Access Points Management view (`/access-points/manage`).
 * Migrated from the former per-profile drawer so Access Points are user-owned
 * and can be bound or switched across any Profile.
 */
export const AccessPointsManageView: React.FC<AccessPointsManageViewProps> = ({
  profiles,
  selectedProfile,
  toasterRef,
}) => {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const headerTitleRef = useStickyHeaderTitle<HTMLHeadingElement>(
    t("setup.manageAccessPoints", "Manage Access Points")
  );
  const navigate = useNavigate();
  const [accessPoints, setAccessPoints] = useState<AccessPoint[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchAccessPoints = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getAccessPoints();
      setAccessPoints(data);
    } catch (e) {
      console.error("Failed to fetch access points:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAccessPoints();
  }, [fetchAccessPoints]);

  const fallbackToasterRef = React.useRef<OverlayToaster | null>(null);
  const effectiveToasterRef = (toasterRef || fallbackToasterRef) as React.MutableRefObject<any>;

  const {
    isAddDialogOpen,
    setIsAddDialogOpen,
    openAddDialog,
    newApName,
    setNewApName,
    newApProfileId,
    setNewApProfileId,
    newApDeviceType,
    setNewApDeviceType,
    isAdding,
    renameApId,
    setRenameApId,
    renameApName,
    setRenameApName,
    isRenaming,
    updatingBindingApId,
    updatingDeviceTypeApId,
    rotatingApId,
    deletingApId,
    newApNameFocused,
    setNewApNameFocused,
    renameApNameFocused,
    setRenameApNameFocused,
    rotateConfirmApId,
    setRotateConfirmApId,
    searchQuery,
    setSearchQuery,
    profileFilterId,
    setProfileFilterId,
    filteredAccessPoints,
    isValidApName,
    handleAdd,
    handleRename,
    handleChangeBinding,
    handleChangeDeviceType,
    handleRotate,
    handleDelete,
  } = useAccessPoints({
    accessPoints,
    onRefresh: () => {
      void fetchAccessPoints();
    },
    toasterRef: effectiveToasterRef,
    defaultProfileId: selectedProfile?.id || profiles[0]?.id || "",
  });

  return (
    <div className={clsx("md:px-8 w-full min-w-0 mx-auto pb-24", PAGE_CONTAINER_WIDE, isMobile ? "p-1" : "px-8")}>
      <div className="mb-6 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 ref={headerTitleRef} className="bp6-heading m-0">{t("setup.manageAccessPoints", "Manage Access Points")}</h1>
          <p className="bp6-text-muted mt-2!">
            {t(
              "setup.manageAccessPointsSubtitle",
              "Manage your endpoint tokens and switch their bound DNS Profiles."
            )}
          </p>
        </div>
        <div className="flex items-center gap-3 self-start sm:self-auto">
          <Button
            intent={Intent.PRIMARY}
            icon={<Plus size={16} />}
            text={t("setup.addAccessPoint")}
            onClick={() => openAddDialog(selectedProfile?.id || profiles[0]?.id || "")}
          />
        </div>
      </div>

      {accessPoints.length > 0 && (
        <div className="mb-6 flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="w-full sm:max-w-sm 2xl:max-w-md">
            <InputGroup
              leftIcon="search"
              placeholder={t("setup.searchAccessPoints", "Search...")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              rightElement={
                searchQuery ? (
                  <Button icon="cross" variant="minimal" onClick={() => setSearchQuery("")} />
                ) : undefined
              }
            />
          </div>
          <MinimalSelect
            value={profileFilterId}
            onChange={setProfileFilterId}
            leadingIcon={<Filter size={14} />}
            options={[
              { label: t("setup.allProfiles", "All Profiles"), value: "__all__" },
              { label: t("setup.unboundProfile", "Unbound"), value: "__unbound__" },
              ...profiles.map((p) => ({ label: p.name, value: p.id })),
            ]}
            placeholder={t("setup.filterByProfile", "Filter by Profile")}
          />
        </div>
      )}

      {loading ? (
        <div className="flex justify-center p-16">
          <Spinner size={36} />
        </div>
      ) : filteredAccessPoints.length === 0 ? (
        <div className="py-16">
          <NonIdealState
            icon={<MonitorSmartphone size={44} className="text-gray-300" />}
            title={
              searchQuery || profileFilterId !== "__all__"
                ? t("setup.noMatchingAccessPoints", "No matching access points")
                : t("setup.noAccessPoints", "No access points found")
            }
            action={
              !searchQuery && profileFilterId === "__all__" ? (
                <Button
                  intent={Intent.PRIMARY}
                  icon={<Plus size={16} />}
                  text={t("setup.addAccessPoint")}
                  onClick={() => openAddDialog(selectedProfile?.id || profiles[0]?.id || "")}
                />
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 min-[2200px]:grid-cols-4 gap-4 2xl:gap-5">
          {filteredAccessPoints.map((ap) => (
            <AccessPointSection
              key={ap.id}
              ap={ap}
              totalApCount={accessPoints.length}
              profiles={profiles}
              updatingBindingApId={updatingBindingApId}
              onChangeBinding={(apId, profileId) => {
                void handleChangeBinding(apId, profileId);
              }}
              updatingDeviceTypeApId={updatingDeviceTypeApId}
              onChangeDeviceType={(apId, deviceType) => {
                void handleChangeDeviceType(apId, deviceType);
              }}
              onGoToSetup={(apId) => navigate(`/access-points/setup?ap=${encodeURIComponent(apId)}`)}
              toasterRef={effectiveToasterRef}
              onRenameTrigger={(id, name) => {
                setRenameApId(id);
                setRenameApName(name);
              }}
              rotateConfirmApId={rotateConfirmApId}
              setRotateConfirmApId={setRotateConfirmApId}
              rotatingApId={rotatingApId}
              handleRotate={handleRotate}
              deletingApId={deletingApId}
              handleDelete={handleDelete}
            />
          ))}
        </div>
      )}

      <AddAccessPointDialog
        isOpen={isAddDialogOpen}
        onClose={() => setIsAddDialogOpen(false)}
        newApName={newApName}
        setNewApName={setNewApName}
        newApNameFocused={newApNameFocused}
        setNewApNameFocused={setNewApNameFocused}
        handleAdd={handleAdd}
        isAdding={isAdding}
        isValidApName={isValidApName}
        profiles={profiles}
        selectedProfileId={newApProfileId}
        onSelectProfileId={setNewApProfileId}
        deviceType={newApDeviceType}
        onSelectDeviceType={setNewApDeviceType}
      />

      <RenameAccessPointDialog
        isOpen={!!renameApId}
        onClose={() => setRenameApId(null)}
        renameApName={renameApName}
        setRenameApName={setRenameApName}
        renameApNameFocused={renameApNameFocused}
        setRenameApNameFocused={setRenameApNameFocused}
        handleRename={handleRename}
        isRenaming={isRenaming}
        isValidApName={isValidApName}
      />
    </div>
  );
};

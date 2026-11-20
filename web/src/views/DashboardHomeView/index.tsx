import { useEffect, useState } from "react";
import { Button, Intent, H3, OverlayToaster } from "@blueprintjs/core";
import { Plus, Download } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useIsMobile } from "../../hooks/useIsMobile";
import { preloadHeavyViews, preloadMainViews } from "../../routes/ProfileRoutes";
import type { Profile } from "../../types/auth";
import { useImportProfile } from "./hooks";
import { CreateProfileCard } from "./components/CreateProfileCard";
import { RenameProfileDialog } from "./components/RenameProfileDialog";
import { ProfileList } from "./components/ProfileList";
import { PAGE_CONTAINER_COLLECTIONS } from "../../constants/layout";

interface DashboardHomeProps {
  profiles: Profile[];
  selectedProfileId?: string | null;
  targetSection?: string;
  onSelect: (p: Profile) => void;
  onCreate: () => void;
  onRename: (id: string, name: string) => Promise<void>;
  showCreate: boolean;
  setShowCreate: (show: boolean) => void;
  newName: string;
  setNewName: (name: string) => void;
  error: string;
  onDelete: (e: React.MouseEvent, id: string) => void;
  onRefresh?: () => void;
  toasterRef?: React.RefObject<OverlayToaster | null>;
}

export const DashboardHomeView = ({
  profiles,
  selectedProfileId,
  targetSection = "stats",
  onSelect,
  onCreate,
  onRename,
  showCreate,
  setShowCreate,
  newName,
  setNewName,
  error,
  onDelete,
  onRefresh,
  toasterRef,
}: DashboardHomeProps) => {
  const isMobile = useIsMobile();
  const { t } = useTranslation();

  const [renameTarget, setRenameTarget] = useState<Profile | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameError, setRenameError] = useState("");

  const {
    fileInputRef,
    importing,
    handleImportClick,
    handleFileChange,
  } = useImportProfile(onRefresh);

  useEffect(() => {
    preloadMainViews();
    const timer = setTimeout(preloadHeavyViews, 2000);
    return () => clearTimeout(timer);
  }, []);

  const openRenameDialog = (p: Profile) => {
    setRenameTarget(p);
    setRenameValue(p.name);
    setRenameError("");
  };

  const closeRenameDialog = () => {
    setRenameTarget(null);
    setRenameValue("");
    setRenameError("");
  };

  const handleConfirmRename = async () => {
    if (!renameTarget) return;
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === renameTarget.name) {
      closeRenameDialog();
      return;
    }

    setIsRenaming(true);
    setRenameError("");
    try {
      await onRename(renameTarget.id, trimmed);
      closeRenameDialog();
      toasterRef?.current?.show({
        message: t("common.saveSuccess", "Saved successfully"),
        intent: Intent.SUCCESS,
        icon: "tick",
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : t("common.saveFailed", "Save failed");
      setRenameError(msg);
    } finally {
      setIsRenaming(false);
    }
  };

  return (
    <div className={`w-full ${PAGE_CONTAINER_COLLECTIONS} mx-auto p-2 md:px-6 pb-24`}>
      <input
        type="file"
        ref={fileInputRef}
        className="hidden"
        accept=".json"
        onChange={handleFileChange}
      />

      <div className="flex justify-between items-center mb-6">
        <div>
          <H3 className="dark:text-white font-bold" style={{ marginBottom: 0 }}>
            {t("nav.collections", "Collections")}
          </H3>
          <p className="bp6-text-muted text-sm m-0 mt-1">
            {t("common.selectProfile")}
          </p>
        </div>
        <div className="flex gap-1">
          <Button
            variant="minimal"
            icon={<Download size={16} />}
            onClick={handleImportClick}
            text={isMobile ? "" : t("common.import", "导入")}
            loading={importing}
          />
          <Button
            variant="minimal"
            intent={Intent.PRIMARY}
            icon={<Plus size={18} />}
            onClick={() => setShowCreate(true)}
            text={t("common.add")}
            disabled={showCreate}
          />
        </div>
      </div>

      {showCreate && (
        <CreateProfileCard
          newName={newName}
          setNewName={setNewName}
          onCreate={onCreate}
          setShowCreate={setShowCreate}
          error={error}
        />
      )}

      <ProfileList
        profiles={profiles}
        selectedProfileId={selectedProfileId}
        targetSection={targetSection}
        onSelect={onSelect}
        onRename={openRenameDialog}
        onDelete={onDelete}
      />

      <RenameProfileDialog
        isOpen={Boolean(renameTarget)}
        onClose={closeRenameDialog}
        renameValue={renameValue}
        setRenameValue={setRenameValue}
        onSubmit={() => {
          void handleConfirmRename();
        }}
        isRenaming={isRenaming}
        error={renameError}
      />
    </div>
  );
};

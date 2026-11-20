import { useState } from "react";
import { Intent } from "@blueprintjs/core";
import { useTranslation } from "react-i18next";
import type { AccessPoint } from "../../../types/auth";
import { AP_NAME_REGEX } from "../../../utils/auth";
import {
  createAccessPoint,
  updateAccessPoint,
  rotateAccessPointToken,
  deleteAccessPoint,
} from "../../../services";

export interface UseAccessPointsProps {
  accessPoints: AccessPoint[];
  onRefresh: () => void;
  toasterRef: React.MutableRefObject<any>;
  defaultProfileId?: string | null;
}

export function useAccessPoints({
  accessPoints,
  onRefresh,
  toasterRef,
  defaultProfileId = null,
}: UseAccessPointsProps) {
  const { t } = useTranslation();

  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [newApName, setNewApName] = useState("");
  const [newApProfileId, setNewApProfileId] = useState<string>(defaultProfileId || "");
  const [isAdding, setIsAdding] = useState(false);

  const [renameApId, setRenameApId] = useState<string | null>(null);
  const [renameApName, setRenameApName] = useState("");
  const [isRenaming, setIsRenaming] = useState(false);

  const [updatingBindingApId, setUpdatingBindingApId] = useState<string | null>(null);
  const [rotatingApId, setRotatingApId] = useState<string | null>(null);
  const [deletingApId, setDeletingApId] = useState<string | null>(null);

  const [newApNameFocused, setNewApNameFocused] = useState(false);
  const [renameApNameFocused, setRenameApNameFocused] = useState(false);
  const [rotateConfirmApId, setRotateConfirmApId] = useState<string | null>(null);

  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const filteredAccessPoints = accessPoints.filter(
    (ap) =>
      ap.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      ap.token.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const isValidApName = (name: string): boolean => AP_NAME_REGEX.test(name);

  const openAddDialog = (preferredProfileId?: string | null) => {
    setNewApName("");
    setNewApProfileId(preferredProfileId ?? defaultProfileId ?? "");
    setIsAddDialogOpen(true);
  };

  const handleAdd = async () => {
    const trimmedName = newApName.trim();
    if (!trimmedName) return;

    if (accessPoints.some((ap) => ap.name.toLowerCase() === trimmedName.toLowerCase())) {
      toasterRef.current?.show({
        message: t("setup.accessPointNameExists", "Access Point name already exists"),
        intent: Intent.DANGER,
      });
      return;
    }

    setIsAdding(true);
    try {
      await createAccessPoint(trimmedName, newApProfileId || null);
      toasterRef.current?.show({ message: t("setup.accessPointCreated"), intent: Intent.SUCCESS });
      setIsAddDialogOpen(false);
      setNewApName("");
      onRefresh();
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : "Failed to create access point";
      let displayMsg = errMsg;
      if (errMsg.startsWith("Access point limit exceeded")) {
        const match = errMsg.match(/\(max (\d+)\)/);
        const maxVal = match ? match[1] : "100";
        displayMsg = t("setup.accessPointLimitExceeded", {
          max: maxVal,
          defaultValue: `Access Point limit exceeded (max ${maxVal})`,
        });
      }
      toasterRef.current?.show({ message: displayMsg, intent: Intent.DANGER });
    } finally {
      setIsAdding(false);
    }
  };

  const handleRename = async () => {
    const trimmedName = renameApName.trim();
    if (!trimmedName || !renameApId) return;

    if (
      accessPoints.some(
        (ap) => ap.id !== renameApId && ap.name.toLowerCase() === trimmedName.toLowerCase()
      )
    ) {
      toasterRef.current?.show({
        message: t("setup.accessPointNameExists", "Access Point name already exists"),
        intent: Intent.DANGER,
      });
      return;
    }

    setIsRenaming(true);
    try {
      await updateAccessPoint(renameApId, { name: trimmedName });
      toasterRef.current?.show({ message: t("setup.accessPointRenamed"), intent: Intent.SUCCESS });
      setRenameApId(null);
      onRefresh();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to rename access point";
      toasterRef.current?.show({ message: msg, intent: Intent.DANGER });
    } finally {
      setIsRenaming(false);
    }
  };

  const handleChangeBinding = async (apId: string, nextProfileId: string | null): Promise<boolean> => {
    setUpdatingBindingApId(apId);
    try {
      await updateAccessPoint(apId, { profile_id: nextProfileId || null });
      toasterRef.current?.show({
        message: t("setup.bindProfileUpdated", "Bound profile updated"),
        intent: Intent.SUCCESS,
      });
      onRefresh();
      return true;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to update bound profile";
      toasterRef.current?.show({ message: msg, intent: Intent.DANGER });
      return false;
    } finally {
      setUpdatingBindingApId(null);
    }
  };

  const handleRotate = async (apId: string) => {
    setRotatingApId(apId);
    try {
      await rotateAccessPointToken(apId);
      toasterRef.current?.show({ message: t("setup.tokenRotated"), intent: Intent.SUCCESS });
      onRefresh();
    } catch (e) {
      console.error(e);
    } finally {
      setRotatingApId(null);
    }
  };

  const handleDelete = async (apId: string) => {
    if (!confirm(t("setup.deleteAccessPointConfirm"))) return;
    setDeletingApId(apId);
    try {
      await deleteAccessPoint(apId);
      toasterRef.current?.show({ message: t("setup.accessPointDeleted"), intent: Intent.SUCCESS });
      onRefresh();
    } catch (e) {
      console.error(e);
    } finally {
      setDeletingApId(null);
    }
  };

  return {
    isAddDialogOpen,
    setIsAddDialogOpen,
    openAddDialog,
    newApName,
    setNewApName,
    newApProfileId,
    setNewApProfileId,
    isAdding,
    renameApId,
    setRenameApId,
    renameApName,
    setRenameApName,
    isRenaming,
    updatingBindingApId,
    rotatingApId,
    deletingApId,
    newApNameFocused,
    setNewApNameFocused,
    renameApNameFocused,
    setRenameApNameFocused,
    rotateConfirmApId,
    setRotateConfirmApId,
    isSearchOpen,
    setIsSearchOpen,
    searchQuery,
    setSearchQuery,
    filteredAccessPoints,
    isValidApName,
    handleAdd,
    handleRename,
    handleChangeBinding,
    handleRotate,
    handleDelete,
  };
}

import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useLocation } from "react-router-dom";
import {
  getProfiles,
  createProfile,
  renameProfile,
  deleteProfile
} from "../services";
import { formatApiErrorMessage } from "../utils/auth";
import type { Profile } from "../services";

interface PrefilledRule {
  domain: string;
  type: "ALLOW" | "BLOCK" | "REDIRECT";
  recordType?: string;
}

/**
 * Custom hook managing profiles list, selected profile,
 * dialog states, prefilled rules, and profile CRUD operations.
 *
 * @param isLoggedIn - Auth status from useAuth hook.
 */
export function useProfiles(isLoggedIn: boolean | null) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selectedProfile, setSelectedProfile] = useState<Profile | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Profile creation states
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newProfileName, setNewProfileName] = useState("");
  const [createError, setCreateError] = useState("");

  // Quick Action / Prefilled Rule states
  const [prefilledRule, setPrefilledRule] = useState<PrefilledRule | null>(null);

  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const inFlightFetchRef = useRef<Promise<void> | null>(null);
  const lastFetchedOnAuthRef = useRef<boolean>(false);
  const prevPathnameRef = useRef<string>(location.pathname);

  const fetchProfiles = useCallback(async () => {
    if (inFlightFetchRef.current) {
      return inFlightFetchRef.current;
    }
    const promise = (async () => {
      try {
        const profilesData = await getProfiles();
        setProfiles(profilesData);
      } catch (err) {
        console.error("Failed to fetch profiles", err);
      } finally {
        setLoaded(true);
        inFlightFetchRef.current = null;
      }
    })();
    inFlightFetchRef.current = promise;
    return promise;
  }, []);

  useEffect(() => {
    if (isLoggedIn === true) {
      lastFetchedOnAuthRef.current = true;
      void fetchProfiles();
    } else {
      lastFetchedOnAuthRef.current = false;
      setProfiles([]);
      setSelectedProfile(null);
      setLoaded(false);
    }
  }, [isLoggedIn, fetchProfiles]);

  // 仅从其他路由切回 /dash 时刷新列表，避免与初次登录挂载重复请求 GET /api/profiles
  useEffect(() => {
    const prevPath = prevPathnameRef.current;
    prevPathnameRef.current = location.pathname;
    if (
      isLoggedIn === true &&
      location.pathname === "/dash" &&
      prevPath !== "/dash" &&
      !lastFetchedOnAuthRef.current
    ) {
      void fetchProfiles();
    }
    if (lastFetchedOnAuthRef.current) {
      lastFetchedOnAuthRef.current = false;
    }
  }, [isLoggedIn, location.pathname, fetchProfiles]);

  const handleCreateProfile = async () => {
    const trimmed = newProfileName.trim();
    if (!trimmed) return;
    try {
      await createProfile(trimmed);
      setNewProfileName("");
      setShowCreateDialog(false);
      await fetchProfiles();
    } catch (err: any) {
      setCreateError(formatApiErrorMessage(err, t));
    }
  };

  const handleRenameProfile = async (id: string, name: string): Promise<void> => {
    const trimmed = name.trim();
    await renameProfile(id, trimmed);
    setProfiles((prev) => prev.map((p) => (p.id === id ? { ...p, name: trimmed } : p)));
    if (selectedProfile?.id === id) {
      setSelectedProfile({ ...selectedProfile, name: trimmed });
    }
  };

  const handleDeleteProfile = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!confirm(t("common.confirmDelete"))) return;
    try {
      await deleteProfile(id);
      await fetchProfiles();
      if (selectedProfile?.id === id) {
        setSelectedProfile(null);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleQuickAction = (
    domain: string,
    type: "ALLOW" | "BLOCK" | "REDIRECT",
    recordType?: string
  ) => {
    setPrefilledRule({ domain, type, recordType });
    const profileId = selectedProfile?.id || location.pathname.split("/")[2];
    if (profileId) {
      navigate(`/dash/${profileId}/rules`);
    }
  };

  return {
    profiles,
    selectedProfile,
    setSelectedProfile,
    showCreateDialog,
    setShowCreateDialog,
    newProfileName,
    setNewProfileName,
    createError,
    setCreateError,
    prefilledRule,
    setPrefilledRule,
    fetchProfiles,
    handleCreateProfile,
    handleRenameProfile,
    handleDeleteProfile,
    handleQuickAction,
    loaded,
  };
}

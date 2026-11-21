import React, { useState, useEffect, useMemo } from "react";
import { Intent, Callout } from "@blueprintjs/core";
import { useTranslation } from "react-i18next";
import { useIsMobile } from "../../hooks/useIsMobile";
import { clsx } from "clsx";

import type {  FilteringViewProps, FilterList  } from "./types";
import { AddListCard } from "./components/AddListCard";
import { ListsTable } from "./components/ListsTable";
import { ListDetailsDialog } from "./components/ListDetailsDialog";
import { SyncProgressButton } from "./components/SyncProgressButton";
import { PAGE_CONTAINER_STANDARD } from "../../constants/layout";
import { useStickyHeaderTitle } from "../../layouts/HeaderTitleContext";
import { getProfileLists, addCustomProfileList, deleteCustomProfileList, syncProfileLists, syncSingleProfileList, getProfileSyncStatus, toggleProfileList, addProfileRule } from "../../services";

/**
 * Merges duplicate user-level and system-level filter list entries sharing the same URL
 * into a single row annotated with combined scopes (e.g. ["user", "system"]).
 */
function mergeUserAndSystemLists(rawLists: FilterList[]): FilterList[] {
  const byUrl = new Map<string, FilterList>();
  for (const item of rawLists) {
    if (item.scope === "profile") continue;
    const itemScope: "user" | "system" = item.scope === "system" || item.is_system ? "system" : "user";
    const existing = byUrl.get(item.url);
    if (!existing) {
      byUrl.set(item.url, {
        ...item,
        scope: itemScope,
        scopes: [itemScope],
      });
    } else {
      const mergedScopes = new Set<"profile" | "user" | "system">([
        ...(existing.scopes || []),
        itemScope,
      ]);
      const orderedScopes: Array<"user" | "system"> = [];
      if (mergedScopes.has("user")) orderedScopes.push("user");
      if (mergedScopes.has("system")) orderedScopes.push("system");
      byUrl.set(item.url, {
        ...existing,
        enabled: existing.enabled || item.enabled,
        last_synced_at: existing.last_synced_at ?? item.last_synced_at,
        sync_error: existing.sync_error ?? item.sync_error,
        metadata: existing.metadata ?? item.metadata,
        scopes: orderedScopes,
      });
    }
  }
  return Array.from(byUrl.values());
}

export const FilteringView: React.FC<FilteringViewProps> = ({ profileId, toasterRef }) => {
  const isMobile = useIsMobile();
  const [lists, setLists] = useState<FilterList[]>([]);
  const [newUrl, setNewUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncAllProgress, setSyncAllProgress] = useState(0);
  const [syncAllDetail, setSyncAllDetail] = useState<string | undefined>(undefined);
  const [syncingSingleId, setSyncingSingleId] = useState<number | null>(null);
  const [syncSingleProgress, setSyncSingleProgress] = useState(0);
  const { t } = useTranslation();
  const headerTitleRef = useStickyHeaderTitle<HTMLDivElement>(t("filtering.title"));

  const [selectedList, setSelectedList] = useState<FilterList | null>(null);
  const profileLists = useMemo(() => lists.filter((l) => l.scope === "profile"), [lists]);
  const userAndSystemLists = useMemo(() => mergeUserAndSystemLists(lists), [lists]);

  const fetchData = async () => {
    setLoading(true);
    try {
      const data = await getProfileLists(profileId);
      setLists(data);
    } catch (e) {
      console.error("Failed to fetch filters", e);
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toasterRef?.current?.show({
      message: t("setup.copied", "已复制到剪贴板"),
      intent: Intent.SUCCESS,
      icon: "duplicate",
    });
  };

  const waitForSyncCompletion = async (oldLists: FilterList[]) => {
    const oldSyncTimes = new Map(oldLists.map(l => [l.id, l.last_synced_at]));
    let attempts = 0;
    const maxAttempts = 60; // 60 seconds max
    let currentProgress = 8;
    setSyncAllProgress(currentProgress);
    setSyncAllDetail(undefined);

    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      try {
        const [data, status] = await Promise.all([
          getProfileLists(profileId),
          getProfileSyncStatus(profileId).catch(() => null),
        ]);
        const newLists = data as FilterList[];

        let updatedCount = 0;
        for (const list of newLists) {
          const prevSync = oldSyncTimes.get(list.id);
          if (prevSync !== undefined ? list.last_synced_at !== prevSync : Boolean(list.last_synced_at)) {
            updatedCount++;
          }
        }

        const totalLists = Math.max(1, newLists.length);
        const dbPercent = Math.round((updatedCount / totalLists) * 95);
        const serverPercent = status?.syncing && status.type === "all" ? status.percent : 0;

        if (status?.syncing && status.type === "all" && status.total > 0) {
          setSyncAllDetail(`${status.current}/${status.total}`);
        } else if (newLists.length > 0) {
          setSyncAllDetail(`${updatedCount}/${newLists.length}`);
        }

        const allUpdated = updatedCount >= newLists.length && newLists.length > 0;
        if (allUpdated || (status && !status.syncing && attempts >= 1 && updatedCount > 0)) {
          setSyncAllProgress(100);
          setLists(newLists);
          await new Promise(resolve => setTimeout(resolve, 300));
          return true;
        }

        currentProgress = Math.min(94, Math.max(currentProgress + 4, dbPercent, serverPercent));
        setSyncAllProgress(currentProgress);
      } catch {
        // Ignore fetch errors during polling
      }
      attempts++;
    }

    await fetchData();
    return false;
  };

  const waitForSingleSyncCompletion = async (listId: number, oldSyncTime?: number | null) => {
    let attempts = 0;
    const maxAttempts = 60; // 60 seconds max
    let currentProgress = 12;
    setSyncSingleProgress(currentProgress);

    while (attempts < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      try {
        const [data, status] = await Promise.all([
          getProfileLists(profileId),
          getProfileSyncStatus(profileId).catch(() => null),
        ]);
        const newLists = data as FilterList[];
        const current = newLists.find((l) => l.id === listId);
        const timestampUpdated = current && (current.last_synced_at ?? 0) !== (oldSyncTime ?? 0);
        const serverDone = status && !status.syncing && attempts >= 1;

        if (timestampUpdated || (serverDone && current?.last_synced_at)) {
          setSyncSingleProgress(100);
          setLists(newLists);
          if (current) {
            const refreshed =
              current.scope === "profile"
                ? current
                : mergeUserAndSystemLists(newLists).find((l) => l.url === current.url) || current;
            setSelectedList(refreshed);
          }
          await new Promise((resolve) => setTimeout(resolve, 300));
          return true;
        }

        const serverPercent =
          status?.syncing && status.type === "single" && status.listId === listId
            ? status.percent
            : 0;
        currentProgress = Math.min(94, Math.max(currentProgress + 6, serverPercent));
        setSyncSingleProgress(currentProgress);
      } catch {
        // Ignore fetch errors during polling
      }
      attempts++;
    }
    await fetchData();
    return false;
  };

  const handleSyncSingleList = async (listId: number) => {
    setSyncingSingleId(listId);
    setSyncSingleProgress(8);
    try {
      const oldList = lists.find((l) => l.id === listId);
      const oldSyncTime = oldList?.last_synced_at;
      await syncSingleProfileList(profileId, listId);
      toasterRef?.current?.show({
        message: t("filtering.singleSyncStarted", "列表同步任务已开始"),
        intent: Intent.PRIMARY,
        icon: "cloud-download",
      });
      const completed = await waitForSingleSyncCompletion(listId, oldSyncTime);
      if (completed) {
        toasterRef?.current?.show({
          message: t("filtering.syncCheckComplete"),
          intent: Intent.SUCCESS,
          icon: "tick",
        });
      }
    } catch (e) {
      console.error(e);
      toasterRef?.current?.show({
        message: e instanceof Error ? e.message : String(e),
        intent: Intent.DANGER,
        icon: "error",
      });
    } finally {
      setSyncingSingleId(null);
      setSyncSingleProgress(0);
    }
  };

  const addList = async (urlToAdd?: string) => {
    const url = urlToAdd || newUrl;
    if (!url) return;
    setSyncing(true);
    try {
      const result = await addCustomProfileList(profileId, url);
      toasterRef?.current?.show({
        message: t("filtering.addSuccess"),
        intent: Intent.SUCCESS,
        icon: "tick",
      });
      setNewUrl("");

      toasterRef?.current?.show({
        message: t("filtering.singleSyncStarted", "列表同步任务已开始"),
        intent: Intent.PRIMARY,
        icon: "cloud-download",
      });

      let targetId = result?.id;
      if (!targetId) {
        const fresh = await getProfileLists(profileId);
        const created = fresh.find((l) => l.url.trim().toLowerCase() === url.trim().toLowerCase());
        targetId = created?.id;
        setLists(fresh);
      }

      if (targetId) {
        const completed = await waitForSingleSyncCompletion(targetId, 0);
        if (completed) {
          toasterRef?.current?.show({
            message: t("filtering.syncCheckComplete"),
            intent: Intent.SUCCESS,
            icon: "tick",
          });
        }
      } else {
        await fetchData();
      }
    } catch (e) {
      console.error(e);
      toasterRef?.current?.show({
        message: e instanceof Error ? e.message : String(e),
        intent: Intent.DANGER,
        icon: "error",
      });
    } finally {
      setSyncing(false);
    }
  };

  /**
   * Enables or disables a list. The worker rebuilds the merged profile bloom
   * from the lists still active, so filtering reflects the change without a
   * re-download.
   */
  const setListEnabled = async (id: number, enabled: boolean) => {
    try {
      await toggleProfileList(profileId, id, enabled);
      toasterRef?.current?.show({
        message: enabled
          ? t("filtering.listEnabledToast", "List enabled - rebuilding filter")
          : t("filtering.listDisabledToast", "List disabled - rebuilding filter"),
        intent: Intent.PRIMARY,
        icon: enabled ? "tick" : "disable",
      });
      const fresh = await getProfileLists(profileId);
      setLists(fresh);
      if (selectedList) {
        const pool = selectedList.scope === "profile"
          ? fresh.filter((l) => l.scope === "profile")
          : mergeUserAndSystemLists(fresh);
        const updatedCurrent = pool.find((l) => l.id === id || l.url === selectedList.url);
        if (updatedCurrent) setSelectedList(updatedCurrent);
      }
    } catch (e) {
      console.error(e);
      toasterRef?.current?.show({
        message: e instanceof Error ? e.message : String(e),
        intent: Intent.DANGER,
        icon: "error",
      });
    }
  };

  /**
   * Adds an ALLOW rule for a domain an external list blocks. The resolver
   * checks the allow list before consulting the bloom filter, so the exception
   * wins - and because rules live outside lists, it survives the next sync.
   */
  const allowDomain = async (domain: string) => {
    await addProfileRule(profileId, { type: "ALLOW", pattern: domain });
    toasterRef?.current?.show({
      message: t("filtering.allowRuleAdded", "Exception added for {{domain}}", { domain }),
      intent: Intent.SUCCESS,
      icon: "tick",
    });
  };

  const deleteList = async (id: number) => {
    try {
      await deleteCustomProfileList(profileId, id);
      toasterRef?.current?.show({
        message: t("filtering.deleteSuccess"),
        intent: Intent.PRIMARY,
        icon: "trash",
      });
      setSelectedList(null);
      await fetchData();
    } catch (e) {
      console.error(e);
    }
  };

  const syncLists = async () => {
    setSyncing(true);
    setSyncAllProgress(5);
    setSyncAllDetail(undefined);
    try {
      await syncProfileLists(profileId);
      toasterRef?.current?.show({
        message: t("filtering.syncTaskStarted"),
        intent: Intent.PRIMARY,
        icon: "cloud-download",
      });
      
      const completed = await waitForSyncCompletion(lists);
      if (completed) {
        toasterRef?.current?.show({
          message: t("filtering.syncCheckComplete"),
          intent: Intent.SUCCESS,
          icon: "tick",
        });
      }
    } catch (e) {
      console.error(e);
    } finally {
      setSyncing(false);
      setSyncAllProgress(0);
      setSyncAllDetail(undefined);
    }
  };

  useEffect(() => {
    fetchData();
  }, [profileId]);

  return (
    <div className={clsx("md:px-8 w-full min-w-0 mx-auto", PAGE_CONTAINER_STANDARD, isMobile ? "p-1" : "px-8")}>
      <div className="mb-8 flex flex-col md:flex-row justify-between items-start md:items-end gap-4">
        <div className="w-full md:w-auto flex-1">
          <h1 ref={headerTitleRef} className="bp6-heading">{t("filtering.title")}</h1>
          <p className="bp6-text-muted mt-2!">{t("filtering.subtitle")}</p>
        </div>
        <SyncProgressButton
          syncing={syncing}
          progress={syncAllProgress}
          detailText={syncAllDetail}
          iconSize={16}
          label={t("filtering.syncAll")}
          syncingLabel={t("filtering.syncing", "同步中...")}
          loading={loading}
          disabled={loading || lists.length === 0}
          className={isMobile ? "w-full" : ""}
          onClick={syncLists}
        />
      </div>

      <Callout intent={Intent.WARNING} icon="info-sign" className="mb-6">
        <p className="m-0">
          {t("filtering.formatDisclaimer")}
        </p>
        <p className="mt-1.5 mb-0">
          {t(
            "filtering.priorityDisclaimer",
            "外部列表之间不分先后（合并生效），其条目优先级统一遵循：「放行 (@@)」>「重写 ($dnsrewrite)」>「拦截」；本地自定义规则始终优先于外部列表。"
          )}
        </p>
      </Callout>

      {/* ── Profile 级列表 (上方) ── */}
      <AddListCard
        newUrl={newUrl}
        setNewUrl={setNewUrl}
        onAddList={addList}
        syncing={syncing}
        loading={loading}
        lists={lists}
      />

      <div className="mb-6">
        <ListsTable
          lists={profileLists}
          onSelect={setSelectedList}
          loading={loading}
          emptyTitle={t("filtering.noProfileListsTitle", "尚未添加配置级列表")}
          emptyDesc={t("filtering.noProfileListsDesc", "您可在此为当前配置添加专属的拦截列表。")}
        />
      </div>

      {/* ── 分割线 ── */}
      <div className="border-t border-gray-200 dark:border-gray-800 my-8 pt-6">
        <div className="mb-4">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
            <span>{t("filtering.userAndSystemListsTitle", "用户级与系统级列表")}</span>
            <span className="text-xs font-normal text-gray-400">
              ({userAndSystemLists.length})
            </span>
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            {t(
              "filtering.userAndSystemListsSubtitle",
              "继承自账号设置或由系统下发的全局规则列表，自动应用于所有配置。可在此处针对当前配置停用，但不可在此删除。"
            )}
          </p>
        </div>

        <ListsTable
          lists={userAndSystemLists}
          onSelect={setSelectedList}
          loading={loading}
          emptyTitle={t("filtering.noUserSystemListsTitle", "暂无用户级与系统级列表")}
          emptyDesc={t("filtering.noUserSystemListsDesc", "可在账号设置页面中添加应用于所有配置的用户级规则。")}
        />
      </div>

      <ListDetailsDialog
        profileId={profileId}
        selectedList={selectedList}
        onClose={() => setSelectedList(null)}
        onCopy={copyToClipboard}
        onDelete={deleteList}
        onToggleEnabled={setListEnabled}
        onAllowDomain={allowDomain}
        onSyncSingle={handleSyncSingleList}
        syncingSingle={selectedList !== null && syncingSingleId === selectedList.id}
        syncSingleProgress={syncSingleProgress}
      />
    </div>
  );
};

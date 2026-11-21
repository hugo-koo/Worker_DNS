import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  Alert,
  Button,
  Callout,
  Checkbox,
  HTMLTable,
  Intent,
  Spinner,
  Tag,
  type OverlayToaster,
} from "@blueprintjs/core";
import { Archive, Download, HardDrive, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { clsx } from "clsx";

import type { DatabaseSnapshotItem, DatabaseSnapshotOverview } from "../../../services";
import {
  abortDatabaseSnapshot,
  deleteDatabaseSnapshots,
  getDatabaseSnapshots,
  getSnapshotDownloadUrl,
  startDatabaseSnapshot,
} from "../../../services";
import { useDeploymentMode } from "../../../hooks/useDeploymentMode";
import { formatBytes } from "../../../utils/formatBytes";
import { formatDateTime } from "../../../utils/date";

export interface DatabaseStorageAndSnapshotsProps {
  overview: DatabaseSnapshotOverview;
  onOverviewUpdated: (next: DatabaseSnapshotOverview) => void;
  toasterRef?: React.RefObject<OverlayToaster | null>;
}

/**
 * Formats a share of a disk/total capacity into a compact percentage label.
 */
function formatPercent(part: number, total: number): string {
  if (!Number.isFinite(total) || total <= 0 || part <= 0) return "0%";
  const pct = (part / total) * 100;
  if (pct < 0.01) return "<0.01%";
  if (pct < 1) return `${pct.toFixed(2)}%`;
  return `${pct.toFixed(1)}%`;
}

/**
 * Displays Serverfull File-mode storage breakdown bar charts and manages
 * abortable `.sqlite.zst` database snapshots (capture, download, single & bulk delete).
 */
export const DatabaseStorageAndSnapshots: React.FC<DatabaseStorageAndSnapshotsProps> = ({
  overview,
  onOverviewUpdated,
  toasterRef,
}) => {
  const { t } = useTranslation();
  const { isDemoMode } = useDeploymentMode();
  const [startingCapture, setStartingCapture] = useState(false);
  const [abortingCapture, setAbortingCapture] = useState(false);
  const [selectedFilenames, setSelectedFilenames] = useState<string[]>([]);
  const [deleteTargetFilenames, setDeleteTargetFilenames] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState(false);

  const wasCapturingRef = useRef<boolean>(Boolean(overview.activeCapture));
  const abortedByUserRef = useRef<boolean>(false);
  const demoTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearDemoTimers = () => {
    for (const timer of demoTimersRef.current) {
      clearTimeout(timer);
    }
    demoTimersRef.current = [];
  };

  useEffect(() => clearDemoTimers, []);

  const storage = overview.storage;
  const snapshots = overview.snapshots;
  const activeCapture = overview.activeCapture;
  const isCapturing = Boolean(activeCapture);

  // Poll snapshot status while a capture subprocess is active (real Serverfull only)
  useEffect(() => {
    if (!isCapturing || isDemoMode) {
      return;
    }

    const timer = setInterval(async () => {
      try {
        const next = await getDatabaseSnapshots();
        onOverviewUpdated(next);

        if (!next.activeCapture && wasCapturingRef.current) {
          wasCapturingRef.current = false;
          if (abortedByUserRef.current) {
            abortedByUserRef.current = false;
          } else {
            toasterRef?.current?.show({
              message: t("account.snapshotCaptureSuccess", "数据库快照撷取完成"),
              intent: Intent.SUCCESS,
              icon: "tick",
            });
          }
        }
      } catch (err) {
        console.error("Failed to poll snapshot status:", err);
      }
    }, 400);

    return () => clearInterval(timer);
  }, [isCapturing, isDemoMode, onOverviewUpdated, toasterRef, t]);

  // Prune stale selections when snapshot list changes
  const validSelected = useMemo(() => {
    const existingSet = new Set(snapshots.map((s) => s.filename));
    return selectedFilenames.filter((name) => existingSet.has(name));
  }, [snapshots, selectedFilenames]);

  const selectedSet = useMemo(() => new Set(validSelected), [validSelected]);
  const allSelected = snapshots.length > 0 && validSelected.length === snapshots.length;
  const partiallySelected = validSelected.length > 0 && validSelected.length < snapshots.length;

  const handleStartCapture = async () => {
    if (isDemoMode) {
      clearDemoTimers();
      abortedByUserRef.current = false;
      const startedAt = Math.floor(Date.now() / 1000);
      const hex = Math.floor(Math.random() * 0xffffff)
        .toString(16)
        .padStart(6, "0");
      const d = new Date(startedAt * 1000);
      const pad = (n: number) => String(n).padStart(2, "0");
      const id = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z-${hex}`;

      onOverviewUpdated({
        ...overview,
        activeCapture: { id, startedAt, stage: "vacuumming", progress: 8 },
      });

      const demoSteps: Array<{ delayMs: number; stage: "vacuumming" | "compressing"; progress: number }> = [
        { delayMs: 350, stage: "vacuumming", progress: 26 },
        { delayMs: 700, stage: "vacuumming", progress: 48 },
        { delayMs: 1050, stage: "compressing", progress: 64 },
        { delayMs: 1400, stage: "compressing", progress: 85 },
        { delayMs: 1750, stage: "compressing", progress: 97 },
      ];

      const stepTimers = demoSteps.map((step) =>
        setTimeout(() => {
          if (abortedByUserRef.current) return;
          onOverviewUpdated({
            ...overview,
            activeCapture: { id, startedAt, stage: step.stage, progress: step.progress },
          });
        }, step.delayMs)
      );

      const finishTimer = setTimeout(() => {
        if (abortedByUserRef.current) return;
        const retentionSec = overview.config.retentionDays > 0 ? overview.config.retentionDays * 86400 : 0;
        const newItem: DatabaseSnapshotItem = {
          filename: `dns-worker-snapshot-${id}.sqlite.zst`,
          sizeBytes: 14_680_064,
          createdAt: startedAt,
          expiresAt: retentionSec > 0 ? startedAt + retentionSec : 0,
        };
        const nextSnapshots = [newItem, ...overview.snapshots].slice(0, overview.config.maxCount);
        const nextSnapsBytes = nextSnapshots.reduce((sum, s) => sum + s.sizeBytes, 0);
        const prevSnapsBytes = overview.storage?.snapshotsTotalBytes ?? 0;
        const delta = nextSnapsBytes - prevSnapsBytes;
        onOverviewUpdated({
          ...overview,
          snapshots: nextSnapshots,
          activeCapture: null,
          storage: overview.storage
            ? {
                ...overview.storage,
                snapshotsTotalBytes: nextSnapsBytes,
                diskUsedBytes: Math.max(0, overview.storage.diskUsedBytes + delta),
                diskFreeBytes: Math.max(0, overview.storage.diskFreeBytes - delta),
              }
            : null,
        });
        toasterRef?.current?.show({
          message: t("account.snapshotCaptureSuccess", "数据库快照撷取完成"),
          intent: Intent.SUCCESS,
          icon: "tick",
        });
      }, 2100);

      demoTimersRef.current = [...stepTimers, finishTimer];
      return;
    }

    setStartingCapture(true);
    abortedByUserRef.current = false;
    try {
      const res = await startDatabaseSnapshot();
      wasCapturingRef.current = true;
      onOverviewUpdated({
        ...overview,
        activeCapture: res.activeCapture,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "";
      toasterRef?.current?.show({
        message: msg || t("account.snapshotCaptureFailed", "启动快照撷取失败"),
        intent: Intent.DANGER,
        icon: "error",
      });
    } finally {
      setStartingCapture(false);
    }
  };

  const handleAbortCapture = async () => {
    if (isDemoMode) {
      abortedByUserRef.current = true;
      clearDemoTimers();
      onOverviewUpdated({
        ...overview,
        activeCapture: null,
      });
      toasterRef?.current?.show({
        message: t("account.snapshotAbortedToast", "已停止并放弃当前快照撷取"),
        intent: Intent.WARNING,
        icon: "cross",
      });
      return;
    }

    setAbortingCapture(true);
    abortedByUserRef.current = true;
    try {
      await abortDatabaseSnapshot();
      const next = await getDatabaseSnapshots();
      wasCapturingRef.current = Boolean(next.activeCapture);
      onOverviewUpdated(next);
      toasterRef?.current?.show({
        message: t("account.snapshotAbortedToast", "已停止并放弃当前快照撷取"),
        intent: Intent.WARNING,
        icon: "cross",
      });
    } catch (e: unknown) {
      abortedByUserRef.current = false;
      const msg = e instanceof Error ? e.message : "";
      toasterRef?.current?.show({
        message: msg || t("account.snapshotAbortFailed", "放弃快照失败"),
        intent: Intent.DANGER,
        icon: "error",
      });
    } finally {
      setAbortingCapture(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTargetFilenames || deleteTargetFilenames.length === 0) return;
    if (isDemoMode) {
      const deletedSet = new Set(deleteTargetFilenames);
      const nextSnapshots = overview.snapshots.filter((s) => !deletedSet.has(s.filename));
      const nextSnapsBytes = nextSnapshots.reduce((sum, s) => sum + s.sizeBytes, 0);
      const prevSnapsBytes = overview.storage?.snapshotsTotalBytes ?? 0;
      const delta = prevSnapsBytes - nextSnapsBytes;
      setSelectedFilenames((prev) => prev.filter((name) => !deletedSet.has(name)));
      setDeleteTargetFilenames(null);
      onOverviewUpdated({
        ...overview,
        snapshots: nextSnapshots,
        storage: overview.storage
          ? {
              ...overview.storage,
              snapshotsTotalBytes: nextSnapsBytes,
              diskUsedBytes: Math.max(0, overview.storage.diskUsedBytes - delta),
              diskFreeBytes: overview.storage.diskFreeBytes + delta,
            }
          : null,
      });
      toasterRef?.current?.show({
        message: t("account.snapshotDeleteSuccess", {
          count: deletedSet.size,
          defaultValue: `已删除 ${deletedSet.size} 个快照`,
        }),
        intent: Intent.SUCCESS,
        icon: "tick",
      });
      return;
    }

    setDeleting(true);
    try {
      const res = await deleteDatabaseSnapshots(deleteTargetFilenames);
      const deletedSet = new Set(deleteTargetFilenames);
      setSelectedFilenames((prev) => prev.filter((name) => !deletedSet.has(name)));
      setDeleteTargetFilenames(null);
      const next = await getDatabaseSnapshots();
      onOverviewUpdated(next);
      toasterRef?.current?.show({
        message: t("account.snapshotDeleteSuccess", {
          count: res.deletedCount,
          defaultValue: `已删除 ${res.deletedCount} 个快照`,
        }),
        intent: Intent.SUCCESS,
        icon: "tick",
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "";
      toasterRef?.current?.show({
        message: msg || t("account.snapshotDeleteFailed", "删除快照失败"),
        intent: Intent.DANGER,
        icon: "error",
      });
    } finally {
      setDeleting(false);
    }
  };

  const handleToggleSelectAll = (checked: boolean) => {
    setSelectedFilenames(checked ? snapshots.map((s) => s.filename) : []);
  };

  const handleToggleSelectRow = (filename: string) => {
    setSelectedFilenames((prev) =>
      prev.includes(filename) ? prev.filter((item) => item !== filename) : [...prev, filename]
    );
  };

  const captureStageLabel = useMemo(() => {
    if (!activeCapture) return "";
    if (activeCapture.stage === "cancelling") {
      return t("account.snapshotStageCancelling", "正在停止并清理临时文件...");
    }
    if (activeCapture.stage === "compressing") {
      return t("account.snapshotStageCompressing", "正在进行 Zstd (.sqlite.zst) 压缩...");
    }
    return t("account.snapshotStageVacuum", "正在导出一致性数据库副本...");
  }, [activeCapture, t]);

  // Disk bar math
  const diskTotal = storage?.diskTotalBytes ?? 0;
  const diskFree = storage?.diskFreeBytes ?? 0;
  const dbTotal = storage?.dbTotalBytes ?? 0;
  const snapTotal = storage?.snapshotsTotalBytes ?? 0;
  const sameFs = storage?.sameFilesystem ?? true;
  const snapOnSameDisk = sameFs ? snapTotal : 0;
  const otherUsed = Math.max(0, (storage?.diskUsedBytes ?? 0) - dbTotal - snapOnSameDisk);

  const dbPct = diskTotal > 0 ? (dbTotal / diskTotal) * 100 : 0;
  const snapSamePct = diskTotal > 0 ? (snapOnSameDisk / diskTotal) * 100 : 0;
  const otherPct = diskTotal > 0 ? (otherUsed / diskTotal) * 100 : 0;

  // Relative DB vs Snapshot breakdown bar math
  const dataCombined = dbTotal + snapTotal;
  const dbMainRelPct = dataCombined > 0 ? ((storage?.dbMainBytes ?? 0) / dataCombined) * 100 : 0;
  const dbWalRelPct = dataCombined > 0 ? (((storage?.dbWalBytes ?? 0) + (storage?.dbShmBytes ?? 0)) / dataCombined) * 100 : 0;
  const snapRelPct = dataCombined > 0 ? (snapTotal / dataCombined) * 100 : 0;

  return (
    <>
      {storage && (
        <div className="pt-4 border-t border-gray-100 dark:border-gray-800 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <HardDrive size={16} className="text-blue-500 shrink-0" />
              <span className="text-sm font-semibold">
                {t("account.storageUsageTitle", "存储空间占用 (Serverfull)")}
              </span>
            </div>
            <div className="text-xs font-mono text-gray-500 dark:text-gray-400 truncate max-w-full" title={storage.dbPath}>
              {storage.dbPath}
            </div>
          </div>

          {/* Stacked Disk Bar Chart */}
          {diskTotal > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
                <span>{t("account.storageDiskBarLabel", "磁盘空间分布")}</span>
                <span className="font-mono">
                  {t("account.storageUsedSummary", {
                    used: formatBytes(storage.diskUsedBytes),
                    total: formatBytes(diskTotal),
                    defaultValue: `已用 ${formatBytes(storage.diskUsedBytes)} / ${formatBytes(diskTotal)}`,
                  })}
                </span>
              </div>
              <div className="w-full h-3.5 rounded-full overflow-hidden bg-emerald-500/15 dark:bg-emerald-950/40 border border-gray-200 dark:border-gray-700 flex">
                {dbTotal > 0 && (
                  <div
                    className="h-full bg-blue-500 transition-all duration-300"
                    style={{ width: `${dbPct}%`, minWidth: "4px" }}
                    title={`${t("account.storageDbSize", "数据库占用")}: ${formatBytes(dbTotal)} (${formatPercent(dbTotal, diskTotal)})`}
                  />
                )}
                {snapOnSameDisk > 0 && (
                  <div
                    className="h-full bg-violet-500 transition-all duration-300"
                    style={{ width: `${snapSamePct}%`, minWidth: "4px" }}
                    title={`${t("account.storageSnapshotsSize", "快照占用")}: ${formatBytes(snapOnSameDisk)} (${formatPercent(snapOnSameDisk, diskTotal)})`}
                  />
                )}
                {otherUsed > 0 && (
                  <div
                    className="h-full bg-gray-400/70 dark:bg-gray-600 transition-all duration-300"
                    style={{ width: `${otherPct}%`, minWidth: "2px" }}
                    title={`${t("account.storageOtherUsed", "其他已用")}: ${formatBytes(otherUsed)} (${formatPercent(otherUsed, diskTotal)})`}
                  />
                )}
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-gray-600 dark:text-gray-300">
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-xs bg-blue-500 shrink-0" />
                  <span>{t("account.storageDbSize", "数据库占用")}:</span>
                  <span className="font-mono font-medium">{formatBytes(dbTotal)}</span>
                  <span className="opacity-60">({formatPercent(dbTotal, diskTotal)})</span>
                </span>
                {sameFs && (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-xs bg-violet-500 shrink-0" />
                    <span>{t("account.storageSnapshotsSize", "快照占用")}:</span>
                    <span className="font-mono font-medium">{formatBytes(snapTotal)}</span>
                    <span className="opacity-60">({formatPercent(snapTotal, diskTotal)})</span>
                  </span>
                )}
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-xs bg-gray-400/70 dark:bg-gray-600 shrink-0" />
                  <span>{t("account.storageOtherUsed", "其他已用")}:</span>
                  <span className="font-mono font-medium">{formatBytes(otherUsed)}</span>
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-xs bg-emerald-500/40 border border-emerald-500/50 shrink-0" />
                  <span>{t("account.storageDiskFree", "剩余可用")}:</span>
                  <span className="font-mono font-medium">{formatBytes(diskFree)}</span>
                  <span className="opacity-60">({formatPercent(diskFree, diskTotal)})</span>
                </span>
              </div>
            </div>
          )}

          {/* Database vs Snapshots Relative Bar Chart */}
          {dataCombined > 0 && (
            <div className="space-y-2 pt-1">
              <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
                <span>{t("account.storageDbVsSnapshotsLabel", "数据库与快照空间对比")}</span>
                <span className="font-mono">{formatBytes(dataCombined)}</span>
              </div>
              <div className="w-full h-2.5 rounded-full overflow-hidden bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 flex">
                {(storage.dbMainBytes ?? 0) > 0 && (
                  <div
                    className="h-full bg-blue-500 transition-all duration-300"
                    style={{ width: `${dbMainRelPct}%`, minWidth: "3px" }}
                    title={`${t("account.storageDbMain", "主库文件")}: ${formatBytes(storage.dbMainBytes)}`}
                  />
                )}
                {((storage.dbWalBytes ?? 0) + (storage.dbShmBytes ?? 0)) > 0 && (
                  <div
                    className="h-full bg-sky-400 transition-all duration-300"
                    style={{ width: `${dbWalRelPct}%`, minWidth: "3px" }}
                    title={`WAL / SHM: ${formatBytes(storage.dbWalBytes + storage.dbShmBytes)}`}
                  />
                )}
                {snapTotal > 0 && (
                  <div
                    className="h-full bg-violet-500 transition-all duration-300"
                    style={{ width: `${snapRelPct}%`, minWidth: "3px" }}
                    title={`${t("account.storageSnapshotsSize", "快照占用")}: ${formatBytes(snapTotal)}`}
                  />
                )}
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-xs bg-blue-500 shrink-0" />
                  <span>{t("account.storageDbMain", "主库文件")}: {formatBytes(storage.dbMainBytes)}</span>
                </span>
                {(storage.dbWalBytes + storage.dbShmBytes) > 0 && (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-xs bg-sky-400 shrink-0" />
                    <span>WAL/SHM: {formatBytes(storage.dbWalBytes + storage.dbShmBytes)}</span>
                  </span>
                )}
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-xs bg-violet-500 shrink-0" />
                  <span>{t("account.storageSnapshotsSize", "快照占用")}: {formatBytes(snapTotal)}</span>
                </span>
              </div>
            </div>
          )}

          {!sameFs && storage.snapshotDiskTotalBytes !== undefined && storage.snapshotDiskTotalBytes > 0 && (
            <div className="text-xs text-gray-500 dark:text-gray-400 font-mono">
              {t("account.storageSeparateSnapshotDisk", {
                dir: storage.snapshotDir,
                free: formatBytes(storage.snapshotDiskFreeBytes ?? 0),
                total: formatBytes(storage.snapshotDiskTotalBytes),
                defaultValue: `快照卷 (${storage.snapshotDir}): 可用 ${formatBytes(storage.snapshotDiskFreeBytes ?? 0)} / 总计 ${formatBytes(storage.snapshotDiskTotalBytes)}`,
              })}
            </div>
          )}
        </div>
      )}

      {/* Database Snapshots Section */}
      <div className="pt-4 border-t border-gray-100 dark:border-gray-800 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <Archive size={16} className="text-violet-500 shrink-0" />
              <span className="text-sm font-semibold">
                {t("account.snapshotsTitle", "数据库快照 (.sqlite.zst)")}
              </span>
              <Tag minimal intent={Intent.NONE} className="font-mono text-xs">
                {snapshots.length} / {overview.config.maxCount}
              </Tag>
              <Tag minimal intent={Intent.PRIMARY} className="text-xs">
                {overview.config.retentionDays > 0
                  ? t("account.snapshotRetentionDays", {
                      days: overview.config.retentionDays,
                      defaultValue: `有效期 ${overview.config.retentionDays} 天`,
                    })
                  : t("account.snapshotNeverExpires", "永不过期")}
              </Tag>
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400 font-mono break-all">
              {t("account.snapshotStorageDirLabel", "存储目录")}: {overview.config.snapshotDir}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {isCapturing ? (
              <Button
                intent={Intent.DANGER}
                icon={<X size={14} />}
                text={t("account.snapshotAbort", "放弃")}
                loading={abortingCapture}
                disabled={abortingCapture || activeCapture?.stage === "cancelling"}
                onClick={handleAbortCapture}
              />
            ) : (
              <Button
                intent={Intent.PRIMARY}
                text={t("account.snapshotCapture", "撷取")}
                loading={startingCapture}
                disabled={startingCapture}
                onClick={handleStartCapture}
              />
            )}
          </div>
        </div>

        {isCapturing && activeCapture && (
          <Callout intent={activeCapture.stage === "cancelling" ? Intent.WARNING : Intent.PRIMARY} icon={null} className="py-2.5 space-y-2">
            <div className="flex items-center justify-between gap-3 text-xs">
              <div className="flex items-center gap-2.5 min-w-0">
                <Spinner size={15} />
                <span className="truncate">{captureStageLabel}</span>
              </div>
              <span className="font-mono font-semibold tabular-nums shrink-0">
                {Math.max(0, Math.min(100, Math.round(activeCapture.progress ?? 0)))}%
              </span>
            </div>
            <div className="w-full h-1.5 rounded-full overflow-hidden bg-gray-200/80 dark:bg-gray-700/80">
              <div
                className={clsx(
                  "h-full rounded-full transition-all duration-300",
                  activeCapture.stage === "cancelling" ? "bg-amber-500" : "bg-blue-500"
                )}
                style={{ width: `${Math.max(0, Math.min(100, activeCapture.progress ?? 0))}%` }}
              />
            </div>
          </Callout>
        )}

        {validSelected.length > 0 && (
          <div className="px-3.5 py-2 rounded-lg border border-blue-200 dark:border-blue-800/70 bg-blue-50/70 dark:bg-blue-950/30 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-blue-700 dark:text-blue-300">
                {t("account.snapshotSelectedCount", {
                  count: validSelected.length,
                  defaultValue: `已选择 ${validSelected.length} 项`,
                })}
              </span>
              <Button
                size="small"
                variant="minimal"
                text={t("account.snapshotClearSelection", "取消选择")}
                onClick={() => setSelectedFilenames([])}
                disabled={deleting}
              />
            </div>
            <Button
              size="small"
              intent={Intent.DANGER}
              icon={<Trash2 size={13} />}
              text={t("account.snapshotDeleteSelected", {
                count: validSelected.length,
                defaultValue: `删除 (${validSelected.length})`,
              })}
              loading={deleting}
              onClick={() => setDeleteTargetFilenames(validSelected)}
            />
          </div>
        )}

        {snapshots.length === 0 ? (
          <div className="text-xs text-gray-500 dark:text-gray-400 border border-dashed border-gray-200 dark:border-gray-700 rounded-lg py-6 text-center select-none">
            {t("account.snapshotEmpty", "暂无已完成快照。点击右上角“撷取”可生成紧凑的 .sqlite.zst 数据库备份。")}
          </div>
        ) : (
          <div className="w-full max-w-full overflow-x-auto">
            <HTMLTable striped className="w-full min-w-max whitespace-nowrap">
              <thead>
                <tr>
                  <th className="w-10 align-middle">
                    <div className="flex items-center justify-center">
                      <Checkbox
                        checked={allSelected}
                        indeterminate={partiallySelected}
                        aria-label={t("account.snapshotSelectAll", "全选快照")}
                        className="mb-0!"
                        onChange={(e) => handleToggleSelectAll(e.currentTarget.checked)}
                      />
                    </div>
                  </th>
                  <th>{t("account.snapshotColFilename", "快照文件")}</th>
                  <th className="w-28">{t("account.snapshotColSize", "大小")}</th>
                  <th className="w-44">{t("account.snapshotColCreatedAt", "创建时间")}</th>
                  <th className="w-44">{t("account.snapshotColExpiresAt", "有效期至")}</th>
                  <th className="w-28 text-right">{t("account.snapshotColActions", "操作")}</th>
                </tr>
              </thead>
              <tbody>
                {snapshots.map((snap) => {
                  const isSelected = selectedSet.has(snap.filename);
                  return (
                    <tr
                      key={snap.filename}
                      className={clsx(isSelected && "bg-blue-50/70! dark:bg-blue-950/35!")}
                    >
                      <td className="w-10 align-middle">
                        <div className="flex items-center justify-center">
                          <Checkbox
                            checked={isSelected}
                            aria-label={`${t("account.snapshotSelectRow", "选择快照")} ${snap.filename}`}
                            className="mb-0!"
                            onChange={() => handleToggleSelectRow(snap.filename)}
                          />
                        </div>
                      </td>
                      <td className="font-mono text-xs align-middle">{snap.filename}</td>
                      <td className="font-mono text-xs align-middle">{formatBytes(snap.sizeBytes)}</td>
                      <td className="text-xs text-gray-500 dark:text-gray-400 align-middle">
                        {formatDateTime(new Date(snap.createdAt * 1000))}
                      </td>
                      <td className="text-xs text-gray-500 dark:text-gray-400 align-middle">
                        {snap.expiresAt > 0
                          ? formatDateTime(new Date(snap.expiresAt * 1000))
                          : t("account.snapshotNeverExpires", "永不过期")}
                      </td>
                      <td className="align-middle text-right">
                        <div className="inline-flex items-center justify-end gap-1">
                          {isDemoMode ? (
                            <Button
                              minimal
                              small
                              icon={<Download size={14} />}
                              title={t("account.snapshotDownload", "下载快照")}
                              aria-label={t("account.snapshotDownload", "下载快照")}
                              onClick={() => {
                                toasterRef?.current?.show({
                                  message: t("account.snapshotDemoDownloadBlocked", "演示模式仅提供前端展示，不支持下载真实数据库快照"),
                                  intent: Intent.PRIMARY,
                                  icon: "info-sign",
                                });
                              }}
                            />
                          ) : (
                            <a
                              href={getSnapshotDownloadUrl(snap.filename)}
                              download={snap.filename}
                              className="bp6-button bp6-minimal bp6-small inline-flex items-center justify-center"
                              title={t("account.snapshotDownload", "下载快照")}
                              aria-label={t("account.snapshotDownload", "下载快照")}
                            >
                              <Download size={14} />
                            </a>
                          )}
                          <Button
                            minimal
                            small
                            intent={Intent.DANGER}
                            icon={<Trash2 size={14} />}
                            title={t("account.snapshotDeleteOne", "删除快照")}
                            aria-label={t("account.snapshotDeleteOne", "删除快照")}
                            onClick={() => setDeleteTargetFilenames([snap.filename])}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </HTMLTable>
          </div>
        )}
      </div>

      <Alert
        isOpen={Boolean(deleteTargetFilenames && deleteTargetFilenames.length > 0)}
        cancelButtonText={t("rules.cancel", "取消")}
        confirmButtonText={t("rules.delete", "删除")}
        icon="trash"
        intent={Intent.DANGER}
        loading={deleting}
        onCancel={() => {
          if (!deleting) setDeleteTargetFilenames(null);
        }}
        onConfirm={handleConfirmDelete}
      >
        <p>
          {deleteTargetFilenames && deleteTargetFilenames.length > 1
            ? t("account.snapshotDeleteBulkConfirm", {
                count: deleteTargetFilenames.length,
                defaultValue: `确定要永久删除选中的 ${deleteTargetFilenames.length} 个数据库快照吗？此操作不可撤销。`,
              })
            : t("account.snapshotDeleteSingleConfirm", {
                filename: deleteTargetFilenames?.[0] || "",
                defaultValue: `确定要永久删除数据库快照 "${deleteTargetFilenames?.[0] || ""}" 吗？此操作不可撤销。`,
              })}
        </p>
      </Alert>
    </>
  );
};

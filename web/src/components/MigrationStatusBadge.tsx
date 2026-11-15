import React, { useEffect, useState, useCallback } from "react";
import { Button, Intent, PopoverNext, Spinner } from "@blueprintjs/core";
import { AlertCircle, ArrowRight, RefreshCw, Terminal } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  getDatabaseStatus,
  runDatabaseMigrations,
  type DatabaseStatusResponse,
} from "../services/admin";
import type { UserInfo } from "../types/auth";

export const DB_MIGRATION_UPDATED_EVENT = "db-migration-updated";

export interface MigrationStatusBadgeProps {
  /** Current logged in user info. Only admins query and see migration alerts. */
  currentUser?: UserInfo | null;
  /** Optional router navigation callback to open /system database management. */
  onNavigate?: (path: string) => void;
}

/**
 * Displays a compact red exclamation capsule in the top navbar when an admin
 * has pending database migrations. Clicking it reveals migration details and
 * mitigation actions (one-click migrate, link to /system, and CLI hint).
 */
export const MigrationStatusBadge: React.FC<MigrationStatusBadgeProps> = ({
  currentUser,
  onNavigate,
}) => {
  const { t } = useTranslation();
  const isAdmin = currentUser?.role === "admin";
  const [status, setStatus] = useState<DatabaseStatusResponse | null>(null);
  const [migrating, setMigrating] = useState(false);
  const [migrateError, setMigrateError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const data = await getDatabaseStatus();
      setStatus(data);
    } catch {
      // Silently ignore transient fetch errors in navbar badge
    }
  }, [isAdmin]);

  useEffect(() => {
    if (!isAdmin) {
      return;
    }
    loadStatus();

    const handleUpdated = () => {
      loadStatus();
    };
    window.addEventListener(DB_MIGRATION_UPDATED_EVENT, handleUpdated);
    return () => {
      window.removeEventListener(DB_MIGRATION_UPDATED_EVENT, handleUpdated);
    };
  }, [isAdmin, loadStatus]);

  const migrations = status?.migrations;
  if (!isAdmin || !migrations || migrations.completed) {
    return null;
  }

  const handleRunMigrate = async () => {
    if (migrating) return;
    setMigrating(true);
    setMigrateError(null);
    try {
      const res = await runDatabaseMigrations();
      if (res.stats) {
        setStatus((prev) => (prev ? { ...prev, migrations: res.stats! } : prev));
      } else {
        await loadStatus();
      }
      window.dispatchEvent(new Event(DB_MIGRATION_UPDATED_EVENT));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setMigrateError(message || t("migrationAlert.migrateFailed", "数据库迁移执行失败"));
    } finally {
      setMigrating(false);
    }
  };

  const handleOpenSystem = () => {
    if (onNavigate) {
      onNavigate("/system");
      return;
    }
    window.location.href = "/system";
  };

  const previewFiles = migrations.pendingFiles.slice(0, 4);
  const remainingCount = Math.max(0, migrations.pendingFiles.length - previewFiles.length);

  const popoverContent = (
    <div className="p-3.5 w-80 max-w-[90vw] space-y-3 text-xs">
      <div className="flex items-start gap-2">
        <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
        <div className="space-y-0.5">
          <div className="font-semibold text-sm text-gray-900 dark:text-gray-100">
            {t("migrationAlert.title", "数据库迁移未完成")}
          </div>
          <div className="text-gray-500 dark:text-gray-400">
            {t("migrationAlert.summary", {
              applied: migrations.appliedCount,
              total: migrations.totalAvailable,
              pending: migrations.pendingCount,
              defaultValue: `已应用 ${migrations.appliedCount}/${migrations.totalAvailable}，待执行 ${migrations.pendingCount} 项`,
            })}
          </div>
        </div>
      </div>

      <div className="rounded-md bg-gray-50 dark:bg-gray-800/70 border border-gray-200/70 dark:border-gray-700/70 p-2.5 space-y-1.5">
        <div className="flex justify-between text-gray-600 dark:text-gray-300">
          <span>{t("migrationAlert.engine", "数据库引擎")}:</span>
          <span className="font-mono font-medium">{status?.databaseService || "-"}</span>
        </div>
        <div className="flex justify-between text-gray-600 dark:text-gray-300 gap-2">
          <span className="shrink-0">{t("migrationAlert.lastApplied", "最后已应用")}:</span>
          <span className="font-mono truncate" title={migrations.lastApplied || undefined}>
            {migrations.lastApplied || "-"}
          </span>
        </div>
        {previewFiles.length > 0 && (
          <div className="pt-1 border-t border-gray-200/70 dark:border-gray-700/70">
            <div className="text-gray-500 dark:text-gray-400 mb-1">
              {t("migrationAlert.pendingList", "待执行迁移")}:
            </div>
            <ul className="space-y-0.5 font-mono text-[11px] text-red-600 dark:text-red-400">
              {previewFiles.map((file) => (
                <li key={file} className="truncate" title={file}>
                  • {file}
                </li>
              ))}
              {remainingCount > 0 && (
                <li className="text-gray-500 dark:text-gray-400">
                  {t("migrationAlert.moreFiles", {
                    count: remainingCount,
                    defaultValue: `... 另有 ${remainingCount} 个迁移文件`,
                  })}
                </li>
              )}
            </ul>
          </div>
        )}
      </div>

      {migrateError && (
        <div className="rounded-md bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800/70 p-2 text-red-700 dark:text-red-300 break-words">
          {migrateError}
        </div>
      )}

      <div className="rounded-md bg-amber-50/70 dark:bg-amber-950/30 border border-amber-200/70 dark:border-amber-800/50 p-2 text-[11px] text-amber-800 dark:text-amber-300 flex items-start gap-1.5">
        <Terminal className="w-3.5 h-3.5 shrink-0 mt-0.5" />
        <div className="space-y-0.5">
          <div>{t("migrationAlert.cliHint", "若在线迁移受限，可在终端运行：")}</div>
          <code className="block font-mono select-all text-amber-900 dark:text-amber-200">
            npm run db:migrate:prod
          </code>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 pt-1">
        <Button
          size="small"
          intent={Intent.DANGER}
          icon={migrating ? <Spinner size={12} /> : <RefreshCw size={12} />}
          text={
            migrating
              ? t("migrationAlert.migrating", "迁移中...")
              : t("migrationAlert.runNow", "立即执行迁移")
          }
          disabled={migrating}
          onClick={handleRunMigrate}
        />
        <Button
          size="small"
          variant="minimal"
          endIcon={<ArrowRight size={12} />}
          text={t("migrationAlert.openSystem", "前往系统管理")}
          onClick={handleOpenSystem}
        />
      </div>
    </div>
  );

  return (
    <PopoverNext content={popoverContent} placement="bottom-end" interactionKind="click">
      <button
        type="button"
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-500/15 hover:bg-red-500/25 text-red-600 dark:text-red-400 border border-red-300/70 dark:border-red-700/70 transition-colors cursor-pointer"
        title={t("migrationAlert.title", "数据库迁移未完成")}
        aria-label={t("migrationAlert.title", "数据库迁移未完成")}
      >
        <AlertCircle size={13} className="shrink-0" />
        <span>
          {migrations.appliedCount}/{migrations.totalAvailable}
        </span>
      </button>
    </PopoverNext>
  );
};

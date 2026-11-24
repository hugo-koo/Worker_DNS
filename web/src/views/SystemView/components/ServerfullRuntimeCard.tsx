import React, { useState, useEffect, useRef } from "react";
import {
  Card,
  Elevation,
  H4,
  Tag,
  Intent,
  Button,
  Callout,
  Dialog,
  Spinner,
  Switch,
  Tooltip,
  type OverlayToaster,
} from "@blueprintjs/core";
import { Server, RefreshCw, RotateCcw, Copy, Check, AlertCircle, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { ReleaseChannel, ServerfullRuntimeStatus } from "../../../services";
import { getRuntimeStatus, restartServerfullService } from "../../../services";
import { formatDateTime } from "../../../utils/date";

export interface ServerfullRuntimeCardProps {
  status: ServerfullRuntimeStatus | null;
  onRefresh: (forceRefresh?: boolean) => Promise<void>;
  toasterRef?: React.RefObject<OverlayToaster | null>;
}

const RELEASE_CHANNELS: ReleaseChannel[] = ["latest", "alpha", "canary"];
const RESTART_POLL_INTERVAL_MS = 2000;
const MAX_RESTART_POLL_ATTEMPTS = 30;

/**
 * Displays Serverfull runtime details, 3-channel update status (`latest`, `alpha`, `canary`),
 * host CLI update commands, and safe graceful restart controls for administrators.
 */
export const ServerfullRuntimeCard: React.FC<ServerfullRuntimeCardProps> = ({
  status,
  onRefresh,
  toasterRef,
}) => {
  const { t } = useTranslation();
  const [checking, setChecking] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [submittingRestart, setSubmittingRestart] = useState(false);
  const [copiedChannel, setCopiedChannel] = useState<ReleaseChannel | null>(null);
  const [selectedChannel, setSelectedChannel] = useState<ReleaseChannel | null>(null);
  const [sudoOverride, setSudoOverride] = useState<boolean | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (pollTimerRef.current !== null) {
        window.clearInterval(pollTimerRef.current);
      }
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  if (!status || !status.supported) {
    return null;
  }

  const getChannelLabel = (channel: ReleaseChannel): string => {
    if (channel === "latest") return t("system.runtime.channelStable", "正式版 (latest)");
    if (channel === "alpha") return t("system.runtime.channelAlpha", "测试版 (alpha)");
    return t("system.runtime.channelCanary", "金丝雀版 (canary)");
  };

  const getInstallMethodLabel = (method: ServerfullRuntimeStatus["installMethod"]): string => {
    switch (method) {
      case "npm-global":
        return t("system.runtime.installNpmGlobal", "npm 全局安装");
      case "docker":
        return t("system.runtime.installDocker", "Docker 容器");
      case "source":
        return t("system.runtime.installSource", "源码构建");
      case "npx":
        return "npx";
      default:
        return t("system.runtime.installUnknown", "独立运行");
    }
  };

  const getServiceManagerLabel = (mgr: ServerfullRuntimeStatus["serviceManager"]): string => {
    switch (mgr) {
      case "systemd":
        return "systemd";
      case "docker":
        return "Docker";
      case "schtasks":
        return t("system.runtime.supervisorSchtasks", "Windows 计划任务");
      default:
        return t("system.runtime.supervisorNone", "无守护进程");
    }
  };

  const getRestartDisabledReason = (reason: string | null): string => {
    if (reason === "demo_mode") {
      return t("system.runtime.restartDisabledDemo", "演示模式下已禁用服务重启。");
    }
    if (reason === "windows_no_auto_restart") {
      return t(
        "system.runtime.restartDisabledWindows",
        "Windows 计划任务脚本暂未启用退出自动拉起，请在宿主机运行 dns-worker service restart。"
      );
    }
    return t(
      "system.runtime.restartDisabledUnmanaged",
      "当前进程未由 systemd 或 Docker 自动重启策略托管，为避免断网停服已禁用网页端重启。"
    );
  };

  const handleCheckUpdates = async () => {
    setChecking(true);
    try {
      await onRefresh(true);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toasterRef?.current?.show({
        message: msg || t("system.runtime.checkFailed", "检查更新失败"),
        intent: Intent.DANGER,
        icon: "error",
      });
    } finally {
      setChecking(false);
    }
  };

  const handleCopyCommand = (channel: ReleaseChannel, cmd: string) => {
    navigator.clipboard.writeText(cmd).then(() => {
      setCopiedChannel(channel);
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => {
        setCopiedChannel((prev) => (prev === channel ? null : prev));
      }, 2000);
    });
  };

  const startRecoveryPolling = (previousStartedAt: number) => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
    }

    let attempts = 0;
    let sawConnectionDrop = false;

    pollTimerRef.current = window.setInterval(async () => {
      attempts += 1;
      try {
        const nextStatus = await getRuntimeStatus(false);
        const restarted =
          (nextStatus.startedAt && nextStatus.startedAt !== previousStartedAt) ||
          sawConnectionDrop;

        if (restarted) {
          if (pollTimerRef.current !== null) {
            window.clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
          }
          setRestarting(false);
          await onRefresh(false);
          toasterRef?.current?.show({
            message: t("system.runtime.restartSuccess", "服务已完成重启并恢复运行"),
            intent: Intent.SUCCESS,
            icon: "tick",
          });
          return;
        }
      } catch {
        sawConnectionDrop = true;
      }

      if (attempts >= MAX_RESTART_POLL_ATTEMPTS) {
        if (pollTimerRef.current !== null) {
          window.clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
        setRestarting(false);
        toasterRef?.current?.show({
          message: t(
            "system.runtime.restartTimeout",
            "等待服务恢复超时，请检查宿主机服务状态或刷新页面。"
          ),
          intent: Intent.WARNING,
          icon: "warning-sign",
        });
      }
    }, RESTART_POLL_INTERVAL_MS);
  };

  const handleConfirmRestart = async () => {
    setSubmittingRestart(true);
    try {
      const res = await restartServerfullService();
      setConfirmOpen(false);
      setRestarting(true);
      startRecoveryPolling(res.startedAt);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toasterRef?.current?.show({
        message: msg === "restart_unsupported"
          ? getRestartDisabledReason(status.restartReason)
          : msg || t("system.runtime.restartFailed", "触发重启失败"),
        intent: Intent.DANGER,
        icon: "error",
      });
    } finally {
      setSubmittingRestart(false);
    }
  };

  const restartButton = (
    <Button
      intent={Intent.WARNING}
      icon={<RotateCcw size={14} />}
      text={restarting ? t("system.runtime.restarting", "正在重启...") : t("system.runtime.restartButton", "重启服务")}
      disabled={!status.canRestart || restarting}
      loading={restarting}
      onClick={() => setConfirmOpen(true)}
    />
  );

  return (
    <>
      <Card elevation={Elevation.ONE} className="p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            <H4
              className="flex items-center space-x-2 text-base font-semibold m-0"
              style={{ margin: 0 }}
            >
              <Server className="w-5 h-5 text-emerald-500 shrink-0" />
              <span>{t("system.runtime.title", "版本与服务运行状态 (管理员)")}</span>
            </H4>
            <Tag minimal round intent={Intent.PRIMARY} className="font-mono">
              v{status.currentVersion}
            </Tag>
            <Tag minimal round>
              {status.currentChannel}
            </Tag>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <Button
              minimal
              icon={<RefreshCw size={14} className={checking ? "animate-spin" : ""} />}
              text={t("system.runtime.checkUpdates", "检查更新")}
              loading={checking}
              disabled={restarting}
              onClick={handleCheckUpdates}
            />
            {!status.canRestart ? (
              <Tooltip content={getRestartDisabledReason(status.restartReason)} placement="top-end">
                <span>{restartButton}</span>
              </Tooltip>
            ) : (
              restartButton
            )}
          </div>
        </div>

        {restarting && (
          <Callout intent={Intent.WARNING} icon={<Spinner size={18} />}>
            <div className="text-sm font-medium">
              {t("system.runtime.restartingBanner", "正在触发优雅重启并等待服务恢复...")}
            </div>
            <div className="text-xs opacity-80 mt-0.5">
              {t("system.runtime.restartingBannerDesc", "期间 DNS 解析与控制台会短暂断开约 5–10 秒，恢复后将自动刷新状态。")}
            </div>
          </Callout>
        )}

        {status.checkError && (
          <Callout intent={Intent.WARNING} icon={<AlertCircle size={16} />}>
            <div className="text-xs">
              {t("system.runtime.registryErrorPrefix", "检查 npm 仓库版本失败：")}
              <span className="font-mono">{status.checkError}</span>
            </div>
          </Callout>
        )}

        {/* Runtime environment summary */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <span className="text-xs uppercase font-semibold text-gray-500 tracking-wider">
              {t("system.runtime.runtimeEngine", "运行环境")}
            </span>
            <div className="font-medium mt-1 break-all">
              {status.runtime} ({status.workersCount} {status.workersCount > 1 ? "workers" : "worker"})
            </div>
          </div>

          <div>
            <span className="text-xs uppercase font-semibold text-gray-500 tracking-wider">
              {t("system.runtime.installMethod", "部署方式")}
            </span>
            <div className="font-medium mt-1">{getInstallMethodLabel(status.installMethod)}</div>
          </div>

          <div>
            <span className="text-xs uppercase font-semibold text-gray-500 tracking-wider">
              {t("system.runtime.supervisor", "进程托管")}
            </span>
            <div className="font-medium mt-1">{getServiceManagerLabel(status.serviceManager)}</div>
          </div>

          <div>
            <span className="text-xs uppercase font-semibold text-gray-500 tracking-wider">
              {t("system.runtime.startedAt", "启动时间")}
            </span>
            <div className="text-xs text-gray-600 dark:text-gray-300 mt-1">
              {status.startedAt ? formatDateTime(new Date(status.startedAt * 1000)) : "-"}
            </div>
          </div>
        </div>

        {/* Release Channel Selector + Focused Version View (Linux distribution track style) */}
        {(() => {
          const activeChannel: ReleaseChannel = selectedChannel ?? status.currentChannel ?? "latest";
          const activeInfo = status.channels[activeChannel];
          const isCurrentChannel = status.currentChannel === activeChannel;
          const hasRemoteVersion = Boolean(activeInfo?.version);
          const hasUpdate = isCurrentChannel && Boolean(activeInfo?.updateAvailable);
          const supportsSudoToggle = status.platform !== "win32" && status.installMethod !== "source";
          const defaultUseSudo =
            supportsSudoToggle &&
            (status.serviceManager === "systemd" ||
              status.installMethod === "npm-global" ||
              status.installMethod === "npx");
          const useSudo = supportsSudoToggle && (sudoOverride ?? defaultUseSudo);
          const displayCommand = activeInfo?.updateCommand
            ? useSudo
              ? activeInfo.updateCommand
                  .split(" && ")
                  .map((part) => (part.startsWith("sudo ") ? part : `sudo ${part}`))
                  .join(" && ")
              : activeInfo.updateCommand
            : "";

          return (
            <div className="space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <span className="text-xs uppercase font-semibold text-gray-500 tracking-wider">
                  {t("system.runtime.channelsTitle", "发布通道与宿主机更新命令")}
                </span>
                {status.checkedAt && (
                  <span className="text-xs text-gray-500">
                    {t("system.runtime.lastChecked", "上次检查")}: {formatDateTime(new Date(status.checkedAt * 1000))}
                  </span>
                )}
              </div>

              {/* Channel Track Tabs (Select channel first, defaulting to active running channel) */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div
                  className="inline-flex flex-wrap items-center gap-1 bg-gray-100/80 dark:bg-gray-800/70 p-1 rounded-lg self-start"
                  role="tablist"
                  aria-label={t("system.runtime.channelsTitle", "发布通道")}
                >
                  {RELEASE_CHANNELS.map((ch) => {
                    const selected = activeChannel === ch;
                    const isRunningChannel = status.currentChannel === ch;
                    return (
                      <Button
                        key={ch}
                        minimal
                        small
                        active={selected}
                        intent={selected ? Intent.PRIMARY : Intent.NONE}
                        onClick={() => setSelectedChannel(ch)}
                        className="text-xs font-medium"
                      >
                        <span className="inline-flex items-center gap-1.5">
                          <span>{getChannelLabel(ch)}</span>
                          {isRunningChannel && (
                            <Tag minimal round intent={Intent.PRIMARY} className="text-[10px] leading-none">
                              {t("system.runtime.currentChannelBadge", "当前")}
                            </Tag>
                          )}
                        </span>
                      </Button>
                    );
                  })}
                </div>

                {supportsSudoToggle && (
                  <Switch
                    checked={useSudo}
                    label={t("system.runtime.sudoToggle", "使用 sudo")}
                    onChange={(e) => setSudoOverride(e.currentTarget.checked)}
                    className="mb-0 text-xs"
                  />
                )}
              </div>

              {/* Focused Selected Channel Card */}
              <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50/60 dark:bg-gray-900/40 p-4 space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {t("system.runtime.channelLatestVersion", "通道最新版本")}:
                    </span>
                    <code className="text-sm font-mono font-semibold text-gray-900 dark:text-gray-100">
                      {hasRemoteVersion ? `v${activeInfo.version}` : "-"}
                    </code>
                  </div>

                  <div className="flex items-center gap-2">
                    {isCurrentChannel ? (
                      hasRemoteVersion && (
                        <Tag minimal intent={hasUpdate ? Intent.WARNING : Intent.SUCCESS}>
                          {hasUpdate
                            ? t("system.runtime.updateAvailable", "有新版本")
                            : t("system.runtime.upToDate", "已是最新")}
                        </Tag>
                      )
                    ) : (
                      <Tag minimal intent={Intent.NONE}>
                        {t("system.runtime.otherChannelBadge", "非当前运行通道")}
                      </Tag>
                    )}
                  </div>
                </div>

                {!isCurrentChannel && (
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {t("system.runtime.channelSwitchHint", {
                      current: status.currentChannel,
                      target: activeChannel,
                      defaultValue: `当前运行在 ${status.currentChannel} 通道；如需切换至 ${activeChannel} 通道，可在宿主机执行下方命令。`,
                    })}
                  </div>
                )}

                {displayCommand && (
                  <div className="flex items-center justify-between gap-2 rounded bg-gray-100 dark:bg-gray-950/70 px-3 py-2 border border-gray-200/80 dark:border-gray-800">
                    <code
                      className="text-xs font-mono text-gray-800 dark:text-gray-200 overflow-x-auto whitespace-nowrap select-all"
                      title={displayCommand}
                    >
                      {displayCommand}
                    </code>
                    <Button
                      minimal
                      small
                      icon={copiedChannel === activeChannel ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
                      title={t("common.copy", "复制")}
                      onClick={() => handleCopyCommand(activeChannel, displayCommand)}
                    />
                  </div>
                )}
              </div>

              <div className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                <ShieldCheck className="w-3.5 h-3.5 shrink-0 text-emerald-500" />
                <span>
                  {t(
                    "system.runtime.securityHint",
                    "出于宿主机安全边界考量，软件包安装需在宿主机终端或容器编排侧执行；更新完成后可通过右上角安全重启服务。"
                  )}
                </span>
              </div>
            </div>
          );
        })()}
      </Card>

      <Dialog
        isOpen={confirmOpen}
        onClose={() => {
          if (!submittingRestart) setConfirmOpen(false);
        }}
        title={t("system.runtime.restartConfirmTitle", "确认优雅重启服务")}
        icon="refresh"
      >
        <div className="p-6 space-y-4">
          <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed m-0">
            {t(
              "system.runtime.restartConfirmDesc",
              "确认重启 DNS Worker 服务吗？服务会先刷新日志与 SQLite WAL 检查点并优雅退出，随后由 systemd 或 Docker 自动拉起。"
            )}
          </p>
          <Callout intent={Intent.WARNING}>
            <div className="text-xs leading-relaxed">
              {t(
                "system.runtime.restartConfirmWarning",
                "重启期间 UDP / DoT / DoH 解析与 Web 控制台将短暂不可用（约 5–10 秒）。请确认当前使用 systemd 或设置了容器自动重启策略（restart: unless-stopped / always）。"
              )}
            </div>
          </Callout>
          <div className="flex justify-end gap-2 pt-2">
            <Button
              text={t("account.cancel", "取消")}
              disabled={submittingRestart}
              onClick={() => setConfirmOpen(false)}
            />
            <Button
              intent={Intent.WARNING}
              icon={<RotateCcw size={14} />}
              text={t("system.runtime.confirmRestartAction", "立即重启")}
              loading={submittingRestart}
              onClick={handleConfirmRestart}
            />
          </div>
        </div>
      </Dialog>
    </>
  );
};

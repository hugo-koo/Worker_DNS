import React, { useState, useRef } from "react";
import { Dialog, Button, Intent, Callout, Switch, InputGroup, Tag, PopoverNext } from "@blueprintjs/core";
import { Copy, ExternalLink, Trash2, Search, ShieldOff, BarChart3 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatDateTime } from "../../../utils/date";
import { checkDomainAgainstList, type ListCheckResult } from "../../../services";
import type { FilterList } from "../types";
import { SyncProgressButton } from "./SyncProgressButton";

export interface ListDetailsDialogProps {
  profileId: string;
  selectedList: FilterList | null;
  onClose: () => void;
  onCopy: (url: string) => void;
  onDelete: (id: number) => void;
  /** Enables or disables the list; the parent refetches and the filter is rebuilt. */
  onToggleEnabled: (id: number, enabled: boolean) => Promise<void>;
  /** Adds an ALLOW rule so this domain resolves even while the list blocks it. */
  onAllowDomain: (domain: string) => Promise<void>;
  /** Triggers manual sync for this single list */
  onSyncSingle?: (id: number) => Promise<void>;
  /** Whether this list is currently syncing */
  syncingSingle?: boolean;
  /** Progress percentage (0-100) for single list sync */
  syncSingleProgress?: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export const ListDetailsDialog: React.FC<ListDetailsDialogProps> = ({
  profileId,
  selectedList,
  onClose,
  onCopy,
  onDelete,
  onToggleEnabled,
  onAllowDomain,
  onSyncSingle,
  syncingSingle: externalSyncingSingle = false,
  syncSingleProgress = 0,
}) => {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<ListCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [allowing, setAllowing] = useState(false);
  const [allowed, setAllowed] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [localSyncingSingle, setLocalSyncingSingle] = useState(false);
  const syncingSingle = externalSyncingSingle || localSyncingSingle;
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  /** Monotonic id of the newest check, so stale responses can be discarded. */
  const checkToken = useRef(0);

  const reset = () => {
    // Invalidate any in-flight check so its response cannot land after this.
    // Clearing `checking` here is required, not cosmetic: the settled promise's
    // finally block is guarded by the token, so it will decline to clear it and
    // the Check button would stay loading for the life of the component.
    checkToken.current++;
    setChecking(false);
    setQuery("");
    setResult(null);
    setError(null);
    setAllowed(false);
    setDeleteConfirmOpen(false);
  };

  const runCheck = async () => {
    let domain = query.trim().toLowerCase();
    if (!domain || !selectedList) return;

    // Clean user input: strip protocol (http:// or https://), path, port, and trailing dots
    domain = domain.replace(/^https?:\/\//, '').split('/')[0].split(':')[0].replace(/\.+$/, '');
    if (!domain) return;
    setQuery(domain);

    // Tag this request. Closing the dialog mid-flight and reopening it on a
    // different list would otherwise let the late response paint list A's
    // verdict under list B's header.
    const token = ++checkToken.current;
    const listId = selectedList.id;
    setChecking(true);
    setError(null);
    setResult(null);
    setAllowed(false);
    try {
      const res = await checkDomainAgainstList(profileId, listId, domain);
      if (checkToken.current === token) setResult(res);
    } catch (err) {
      if (checkToken.current === token) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (checkToken.current === token) setChecking(false);
    }
  };

  const handleToggle = async (enabled: boolean) => {
    if (!selectedList) return;
    setToggling(true);
    try {
      await onToggleEnabled(selectedList.id, enabled);
    } finally {
      setToggling(false);
    }
  };

  const handleAllow = async () => {
    if (!result?.matchedEntry) return;
    setAllowing(true);
    try {
      // Scope the exception to what was asked about. matchedEntry may be a
      // parent, and an ALLOW rule matches the pattern plus all its subdomains,
      // so allowing it would un-block every sibling too.
      await onAllowDomain(result.domain);
      setAllowed(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAllowing(false);
    }
  };

  const handleSync = async () => {
    if (!selectedList || !onSyncSingle) return;
    setLocalSyncingSingle(true);
    try {
      await onSyncSingle(selectedList.id);
    } finally {
      setLocalSyncingSingle(false);
    }
  };

  return (
    <Dialog
      isOpen={selectedList !== null}
      onClose={() => { reset(); onClose(); }}
      title={t("filtering.listDetails", "List Details")}
      icon="info-sign"
    >
      <div className="p-6 space-y-4">
        {selectedList?.sync_error && (
          <Callout intent={Intent.WARNING} title={t("filtering.syncError")} icon="warning-sign">
            {selectedList.sync_error}
          </Callout>
        )}

        <div className="bg-gray-50 dark:bg-gray-800 px-3.5 py-3 rounded-lg border border-gray-200 dark:border-gray-700 font-mono text-sm flex items-center justify-between gap-2">
          {selectedList?.url && /^https?:\/\//i.test(selectedList.url) ? (
            <a
              href={selectedList.url}
              target="_blank"
              rel="noopener noreferrer"
              title={t("setup.learnMore", "Open link")}
              className="inline-flex items-center gap-1.5 min-w-0 break-all text-blue-600 dark:text-blue-400 hover:underline"
            >
              <span>{selectedList.url}</span>
              <ExternalLink size={13} className="shrink-0 opacity-75" />
            </a>
          ) : (
            <span className="break-all min-w-0">{selectedList?.url}</span>
          )}
          <div className="flex items-center gap-1.5 shrink-0">
            {(selectedList?.scopes?.includes("user") || selectedList?.scope === "user") && (
              <Tag intent={Intent.SUCCESS} minimal className="font-sans">
                {t("filtering.tagUser", "账号")}
              </Tag>
            )}
            {(selectedList?.scopes?.includes("system") || selectedList?.scope === "system") && (
              <Tag intent={Intent.PRIMARY} minimal className="font-sans">
                {t("filtering.tagSystem", "系统")}
              </Tag>
            )}
            <Button
              minimal
              small
              icon={<Copy size={14} />}
              title={t("setup.copyUrl", "Copy link")}
              aria-label={t("setup.copyUrl", "Copy link")}
              onClick={() => { if (selectedList) onCopy(selectedList.url); }}
            />
          </div>
        </div>

        {(selectedList?.scopes?.includes("system") || selectedList?.scope === "system") && (
          <Callout intent={Intent.PRIMARY} icon="info-sign" className="text-xs">
            {t(
              "filtering.systemListNotice",
              "此列表由系统下发并应用于所有配置。可在当前配置中停用，但不可在配置中删除。"
            )}
          </Callout>
        )}

        {(selectedList?.scopes?.includes("user") || selectedList?.scope === "user") && (
          <Callout intent={Intent.SUCCESS} icon="info-sign" className="text-xs">
            {t(
              "filtering.userListNotice",
              "此列表为账号级规则并应用于所有配置。可在当前配置中停用；如需删除，请前往「账号」管理页面。"
            )}
          </Callout>
        )}

        <div className="flex items-center justify-between border border-gray-200 dark:border-gray-700 rounded-lg p-3">
          <div>
            <div className="text-sm font-bold">{t("filtering.listEnabled", "List active")}</div>
            <div className="text-xs opacity-60">
              {t("filtering.listEnabledHint", "Disable to stop filtering with this list without deleting it. Its subscription and sync history are kept.")}
            </div>
          </div>
          <Switch
            large
            checked={!!selectedList?.enabled}
            disabled={toggling}
            onChange={(e) => handleToggle((e.target as HTMLInputElement).checked)}
          />
        </div>

        <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-3 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-sm font-bold">
              <BarChart3 size={15} className="text-blue-500" />
              <span>{t("filtering.listMetadata", "列表元数据")}</span>
            </div>
            <div className="flex items-center gap-1.5 flex-wrap justify-end">
              {selectedList?.metadata && (
                <Tag minimal intent={Intent.PRIMARY} className="font-mono text-xs">
                  {t("filtering.metaTotalRules", "有效规则: {{count}}", {
                    count: selectedList.metadata.total_rules,
                  })}
                </Tag>
              )}
              {selectedList?.metadata?.truncated && (
                <Tag minimal intent={Intent.WARNING} className="text-xs">
                  {t("filtering.metaTruncated", "已截断")}
                </Tag>
              )}
            </div>
          </div>

          {selectedList?.metadata ? (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {[
                  {
                    label: t("filtering.metaExactRules", "全匹配"),
                    value: selectedList.metadata.exact_rules,
                  },
                  {
                    label: t("filtering.metaSubdomainRules", "通配子域名"),
                    value: selectedList.metadata.subdomain_rules,
                  },
                  {
                    label: t("filtering.metaWildcardRules", "通配符"),
                    value: selectedList.metadata.wildcard_rules,
                  },
                  {
                    label: t("filtering.metaRegexRules", "正则表达式"),
                    value: selectedList.metadata.regex_rules,
                  },
                  {
                    label: t("filtering.metaExceptionRules", "放行规则"),
                    value: selectedList.metadata.exception_rules,
                  },
                  {
                    label: t("filtering.metaRewriteRules", "重定向规则"),
                    value: selectedList.metadata.rewrite_rules,
                  },
                ].map((item) => (
                  <div
                    key={item.label}
                    className="bg-gray-50 dark:bg-gray-800/70 rounded px-2.5 py-2 border border-gray-100 dark:border-gray-800"
                  >
                    <div className="text-[11px] opacity-60 truncate">{item.label}</div>
                    <div className="text-sm font-semibold font-mono mt-0.5">
                      {item.value.toLocaleString()}
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] opacity-70 pt-1 border-t border-gray-100 dark:border-gray-800">
                <span>
                  {t("filtering.metaCommentLines", "注释行")}:{" "}
                  <strong className="font-mono">
                    {selectedList.metadata.comment_lines.toLocaleString()}
                  </strong>
                </span>
                <span>
                  {t("filtering.metaUnsupportedLines", "忽略/非 DNS 行")}:{" "}
                  <strong className="font-mono">
                    {selectedList.metadata.unsupported_lines.toLocaleString()}
                  </strong>
                </span>
                {typeof selectedList.metadata.total_bytes === "number" && (
                  <span>
                    {t("filtering.metaFileSize", "体积")}:{" "}
                    <strong className="font-mono">
                      {formatBytes(selectedList.metadata.total_bytes)}
                    </strong>
                  </span>
                )}
                {selectedList.last_modified && (
                  <span>
                    {t("filtering.metaLastModified", "上游更新")}:{" "}
                    <strong className="font-mono">
                      {formatDateTime(new Date(selectedList.last_modified * 1000))}
                    </strong>
                  </span>
                )}
                {selectedList.etag && (
                  <span className="inline-flex items-center gap-1 max-w-full min-w-0" title={selectedList.etag}>
                    <span className="shrink-0">ETag:</span>
                    <strong className="font-mono truncate">{selectedList.etag}</strong>
                  </span>
                )}
              </div>
            </>
          ) : (
            <div className="space-y-1.5 text-xs opacity-65">
              <div>
                {t(
                  "filtering.metaPendingHint",
                  "暂无规则明细统计，点击「立即同步」后将自动生成。"
                )}
              </div>
              {(selectedList?.last_modified || selectedList?.etag) && (
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] pt-1">
                  {selectedList.last_modified && (
                    <span>
                      {t("filtering.metaLastModified", "上游更新")}:{" "}
                      <strong className="font-mono">
                        {formatDateTime(new Date(selectedList.last_modified * 1000))}
                      </strong>
                    </span>
                  )}
                  {selectedList.etag && (
                    <span className="inline-flex items-center gap-1 max-w-full min-w-0" title={selectedList.etag}>
                      <span className="shrink-0">ETag:</span>
                      <strong className="font-mono truncate">{selectedList.etag}</strong>
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-3 space-y-3">
          <div>
            <div className="text-sm font-bold">{t("filtering.checkDomain", "Check a domain")}</div>
            <div className="text-xs opacity-60">
              {t("filtering.checkDomainHint", "Lists are stored as compact filters, so their entries cannot be browsed. You can test any domain against this list instantly.")}
            </div>
          </div>

          <div className="flex gap-2 items-center">
            <InputGroup
              fill
              className="flex-1 min-w-0"
              placeholder="example.com"
              value={query}
              disabled={checking}
              leftIcon="globe-network"
              onChange={(e) => {
                setQuery(e.target.value);
                // Drop the previous verdict so "Allow anyway" can never act on
                // a domain other than the one now in the field.
                setResult(null);
              }}
              onKeyDown={(e) => { if (e.key === "Enter") void runCheck(); }}
            />
            <Button
              className="shrink-0 whitespace-nowrap min-w-fit w-auto"
              icon={<Search size={14} />}
              text={t("filtering.check", "Check")}
              loading={checking}
              disabled={!query.trim()}
              onClick={() => void runCheck()}
            />
          </div>

          {error && <Callout intent={Intent.DANGER} className="text-xs">{error}</Callout>}

          {result && !result.synced && (
            <Callout intent={Intent.WARNING} className="text-xs">
              {t("filtering.checkNotSynced", "This list has not finished syncing yet, so there is nothing to check against.")}
            </Callout>
          )}

          {result?.synced && result.enabled === false && (
            <Callout intent={Intent.NONE} className="text-xs">
              {t("filtering.checkListDisabled", "This list is currently disabled, so it is not filtering anything right now.")}
            </Callout>
          )}

          {result?.synced && (
            <Callout
              intent={result.blocked ? Intent.WARNING : Intent.SUCCESS}
              className="text-xs"
              icon={result.blocked ? "ban-circle" : "tick-circle"}
            >
              {result.blocked ? (
                <div className="space-y-2">
                  <div>
                    {t("filtering.checkBlocked", "Blocked by this list")}
                    {result.matchedEntry && result.matchedEntry !== result.domain && (
                      <>
                        {" "}
                        <Tag minimal className="font-mono">{result.matchedEntry}</Tag>{" "}
                        {result.matchedEntry.includes("*") || result.matchedEntry.startsWith("/")
                          ? t("filtering.checkViaPattern", "(匹配到通配规则)")
                          : t("filtering.checkViaParent", "(matched a parent domain)")}
                      </>
                    )}
                  </div>
                  {allowed ? (
                    <Tag intent={Intent.SUCCESS} minimal>
                      {t("filtering.checkAllowed", "Exception added - this domain now resolves")}
                    </Tag>
                  ) : (
                    <Button
                      small
                      icon={<ShieldOff size={12} />}
                      intent={Intent.PRIMARY}
                      loading={allowing}
                      text={t("filtering.checkAllowAction", "Allow anyway")}
                      onClick={() => void handleAllow()}
                    />
                  )}
                </div>
              ) : result.whitelisted ? (
                <div className="space-y-1">
                  <div className="font-medium text-emerald-700 dark:text-emerald-400">
                    {t("filtering.checkWhitelisted", "被该列表放行")}
                    {result.matchedEntry && (
                      <>
                        {" "}
                        <Tag minimal intent={Intent.SUCCESS} className="font-mono">{result.matchedEntry}</Tag>
                      </>
                    )}
                  </div>
                  <div className="opacity-75">
                    {t("filtering.checkWhitelistedDesc", "命中该订阅列表中的白名单/例外规则 (@@)，即使被其他黑名单规则命中也会优先放行。")}
                  </div>
                </div>
              ) : (
                t("filtering.checkNotBlocked", "Not blocked by this list")
              )}
            </Callout>
          )}
        </div>

        <div className="flex justify-between items-center gap-3">
          <span className="text-xs opacity-50 truncate min-w-0">
            {t("filtering.tableLastSync")}:{" "}
            {selectedList?.last_synced_at
              ? formatDateTime(new Date(selectedList.last_synced_at * 1000))
              : "-"}
          </span>
        </div>
      </div>

      <div className="p-4 border-t border-gray-100 dark:border-gray-800 flex justify-between items-center">
        {selectedList?.scope === "profile" ? (
          <PopoverNext
            isOpen={deleteConfirmOpen}
            onInteraction={setDeleteConfirmOpen}
            placement="top-start"
            portalClassName="z-20000"
            content={
              <div className="p-3 space-y-3 max-w-xs">
                <p className="text-xs font-semibold leading-relaxed m-0 text-gray-800 dark:text-gray-200">
                  {t("filtering.deleteConfirm", "Are you sure you want to delete this list? This action cannot be undone.")}
                </p>
                <div className="flex justify-end gap-2">
                  <Button
                    small
                    variant="minimal"
                    text={t("common.cancel", "Cancel")}
                    onClick={() => setDeleteConfirmOpen(false)}
                  />
                  <Button
                    small
                    intent={Intent.DANGER}
                    text={t("common.confirm", "Confirm")}
                    onClick={() => {
                      if (!selectedList) return;
                      const id = selectedList.id;
                      setDeleteConfirmOpen(false);
                      reset();
                      onDelete(id);
                    }}
                  />
                </div>
              </div>
            }
          >
            <Button
              icon={<Trash2 size={14} />}
              intent={Intent.DANGER}
              text={t("rules.delete", "Delete")}
              onClick={() => setDeleteConfirmOpen(true)}
            />
          </PopoverNext>
        ) : (
          <span className="text-xs text-gray-400 italic">
            {t("filtering.cannotDeleteUserListDesc", "账号级与系统级列表不可在配置中删除")}
          </span>
        )}
        <div className="flex gap-2">
          {onSyncSingle && (
            <SyncProgressButton
              syncing={syncingSingle}
              progress={syncSingleProgress}
              intent={Intent.PRIMARY}
              iconSize={14}
              label={t("filtering.syncSingle", "同步此列表")}
              syncingLabel={t("filtering.syncing", "同步中...")}
              onClick={() => void handleSync()}
            />
          )}
          <Button onClick={() => { reset(); onClose(); }} text={t("rules.close", "Close")} />
        </div>
      </div>
    </Dialog>
  );
};

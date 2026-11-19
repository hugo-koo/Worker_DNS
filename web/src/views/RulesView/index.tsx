import React, { useState, useEffect, useMemo } from "react";
import { Alert, Callout, Intent, ButtonGroup, Button, Tag, PopoverNext, Spinner } from "@blueprintjs/core";
import { Trash2, Download } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { clsx } from "clsx";

import type { Rule, RulesViewProps, ProfileSettings } from "./types";
import { AddRuleCard } from "./components/AddRuleCard";
import { RulesTable } from "./components/RulesTable";
import { EditRuleDialog } from "./components/EditRuleDialog";
import { downloadAdGuardRulesList } from "./utils/adguardExport";
import { useIsMobile } from "../../hooks/useIsMobile";
import {
  getProfileRules,
  getProfileDetails,
  addProfileRule,
  updateProfileRule,
  deleteProfileRule,
  deleteProfileRulesBulk,
  getClientInfo,
} from "../../services";

export const RulesView: React.FC<RulesViewProps> = ({ profileId, prefill, onPrefillUsed, toasterRef }) => {
  const navigate = useNavigate();
  const [rules, setRules] = useState<Rule[]>([]);
  const [settings, setSettings] = useState<ProfileSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [isAdding, setIsAdding] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const [newRule, setNewRule] = useState<{
    type: Rule["type"];
    pattern: string;
    include_subdomains?: boolean;
    v_a: string;
    v_aaaa: string;
    v_txt: string;
    v_cname: string;
  }>({
    type: "BLOCK",
    pattern: "",
    include_subdomains: false,
    v_a: "",
    v_aaaa: "",
    v_txt: "",
    v_cname: "",
  });

  const [editRule, setEditRule] = useState<Rule | null>(null);
  const [selectedRuleIds, setSelectedRuleIds] = useState<number[]>([]);
  const [isBulkDeleteAlertOpen, setIsBulkDeleteAlertOpen] = useState(false);
  const [isDeletingBulk, setIsDeletingBulk] = useState(false);
  const [substituteDomain, setSubstituteDomain] = useState<string>("www.wto.org");
  const [isPromptOpen, setIsPromptOpen] = useState(false);

  useEffect(() => {
    getClientInfo()
      .then((info) => {
        if (info.substituteDomain) {
          setSubstituteDomain(info.substituteDomain);
        }
      })
      .catch((e) => console.warn("Failed to fetch clientInfo for substituteDomain:", e));
  }, []);

  const hasSelfRedirect = useMemo(() => {
    const currentHost = window.location.hostname.trim().toLowerCase();
    if (!currentHost) return false;
    return rules.some((r) => {
      if (r.type !== "REDIRECT") return false;
      const pattern = r.pattern.trim().toLowerCase();
      return pattern === currentHost || pattern === `*.${currentHost}`;
    });
  }, [rules]);

  const handleApplySelfRedirect = () => {
    setIsPromptOpen(false);
    setNewRule({
      type: "REDIRECT",
      pattern: window.location.hostname,
      include_subdomains: false,
      v_a: "",
      v_aaaa: "",
      v_txt: "",
      v_cname: substituteDomain || "www.wto.org",
    });
    setTimeout(() => {
      document.getElementById("rule-pattern")?.focus();
    }, 100);
  };

  useEffect(() => {
    if (prefill) {
      setNewRule({
        type: prefill.type,
        pattern: prefill.domain,
        include_subdomains: false,
        v_a: prefill.recordType === "A" ? "0.0.0.0" : "",
        v_aaaa: prefill.recordType === "AAAA" ? "::" : "",
        v_txt: prefill.recordType === "TXT" ? "Pre-filled" : "",
        v_cname: prefill.recordType === "CNAME" ? "target.com" : "",
      });
      onPrefillUsed?.();
    }
  }, [prefill, onPrefillUsed]);

  const fetchRules = async () => {
    setLoading(true);
    try {
      const [rulesData, profileData] = await Promise.all([
        getProfileRules(profileId),
        getProfileDetails(profileId),
      ]);

      setRules(rulesData);
      const validIds = new Set(rulesData.map((r) => r.id));
      setSelectedRuleIds((prev) => prev.filter((id) => validIds.has(id)));
      setSettings(JSON.parse(profileData.settings || "{}"));
    } catch (e) {
      console.error("Failed to fetch data", e);
    } finally {
      setLoading(false);
    }
  };

  const getBlockDetail = () => {
    if (!settings) return t("rules.detailBlock");
    const mode = settings.block_mode || "NULL_IP";
    switch (mode) {
      case "NXDOMAIN":
        return "NXDOMAIN";
      case "NODATA":
        return "NODATA";
      case "CUSTOM_IP":
        return `${settings.custom_block_ipv4 || "0.0.0.0"} / ${settings.custom_block_ipv6 || "::"}`;
      default:
        return "0.0.0.0 / ::";
    }
  };

  const addRule = async () => {
    const trimmedPattern = newRule.pattern.trim();
    if (!trimmedPattern) {
      toasterRef?.current?.show({
        message: t("rules.patternEmpty", "Domain pattern cannot be empty"),
        intent: Intent.DANGER,
      });
      return;
    }
    const normalizedPattern = trimmedPattern.toLowerCase();
    if (rules.some(r => r.pattern.trim().toLowerCase() === normalizedPattern)) {
      toasterRef?.current?.show({
        message: t("rules.duplicatePattern", "Rule for this domain already exists"),
        intent: Intent.DANGER,
      });
      return;
    }
    setIsAdding(true);
    try {
      await addProfileRule(profileId, {
        ...newRule,
        pattern: trimmedPattern,
        include_subdomains: 0,
      });
      toasterRef?.current?.show({
        message: t("rules.addSuccess", "Rule added successfully"),
        intent: Intent.SUCCESS,
      });
      setNewRule({
        type: "BLOCK",
        pattern: "",
        include_subdomains: false,
        v_a: "",
        v_aaaa: "",
        v_txt: "",
        v_cname: "",
      });
      await fetchRules();
    } catch (e: any) {
      toasterRef?.current?.show({
        message: e.message || t("rules.addFailed", "Failed to add rule"),
        intent: Intent.DANGER,
      });
    } finally {
      setIsAdding(false);
    }
  };

  const saveEditRule = async () => {
    if (!editRule) return;
    const trimmedPattern = editRule.pattern.trim();
    if (!trimmedPattern) {
      toasterRef?.current?.show({
        message: t("rules.patternEmpty", "Domain pattern cannot be empty"),
        intent: Intent.DANGER,
      });
      return;
    }
    const normalizedPattern = trimmedPattern.toLowerCase();
    if (rules.some(r => r.id !== editRule.id && r.pattern.trim().toLowerCase() === normalizedPattern)) {
      toasterRef?.current?.show({
        message: t("rules.duplicatePattern", "Rule for this domain already exists"),
        intent: Intent.DANGER,
      });
      return;
    }
    setIsSaving(true);
    try {
      await updateProfileRule(profileId, {
        ...editRule,
        pattern: trimmedPattern,
        include_subdomains: 0,
      } as Rule);
      toasterRef?.current?.show({
        message: t("rules.updateSuccess", "Rule updated successfully"),
        intent: Intent.SUCCESS,
      });
      setEditRule(null);
      await fetchRules();
    } catch (e: any) {
      toasterRef?.current?.show({
        message: e.message || t("rules.updateFailed", "Failed to update rule"),
        intent: Intent.DANGER,
      });
    } finally {
      setIsSaving(false);
    }
  };

  const cancelEdit = () => {
    setEditRule(null);
  };

  const startEdit = (rule: Rule) => {
    setEditRule({
      ...rule,
      include_subdomains: rule.include_subdomains === 1 || rule.include_subdomains === true,
    });
  };

  const deleteRule = async (id: number) => {
    setIsDeleting(true);
    try {
      await deleteProfileRule(profileId, id);
    } catch (e) {
      console.error(e);
    } finally {
      setIsDeleting(false);
    }
    setEditRule(null);
    await fetchRules();
  };

  const handleToggleSelectRule = (id: number) => {
    setSelectedRuleIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const handleToggleSelectAll = (checked: boolean) => {
    setSelectedRuleIds(checked ? rules.map((r) => r.id) : []);
  };

  const handleConfirmBulkDelete = async () => {
    if (selectedRuleIds.length === 0) return;
    setIsDeletingBulk(true);
    try {
      const targetCount = selectedRuleIds.length;
      const res = await deleteProfileRulesBulk(profileId, selectedRuleIds);
      const deletedCount = typeof res?.count === "number" ? res.count : targetCount;
      setSelectedRuleIds([]);
      setIsBulkDeleteAlertOpen(false);
      toasterRef?.current?.show({
        message: t("rules.deleteBulkSuccess", {
          count: deletedCount,
          defaultValue: `已删除 ${deletedCount} 条规则`,
        }),
        intent: Intent.SUCCESS,
      });
      await fetchRules();
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "";
      toasterRef?.current?.show({
        message: message || t("rules.deleteBulkFailed", "批量删除规则失败"),
        intent: Intent.DANGER,
      });
    } finally {
      setIsDeletingBulk(false);
    }
  };

  const handleExportAdGuardList = (targetRules: Rule[]) => {
    const safeProfileLabel = profileId
      .trim()
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const filename = `dns-worker-rules-${safeProfileLabel || "profile"}.txt`;
    const exportedCount = downloadAdGuardRulesList(targetRules, filename, profileId);
    if (exportedCount === 0) {
      toasterRef?.current?.show({
        message: t("rules.exportEmpty", "没有可导出的规则"),
        intent: Intent.WARNING,
      });
      return;
    }
    toasterRef?.current?.show({
      message: t("rules.exportSuccess", {
        count: exportedCount,
        defaultValue: `已导出 ${exportedCount} 条 AdGuard Home 兼容规则`,
      }),
      intent: Intent.SUCCESS,
    });
  };

  useEffect(() => {
    setSelectedRuleIds([]);
    fetchRules();
  }, [profileId]);

  return (
    <div className={clsx("md:px-8 w-full min-w-0 max-w-5xl mx-auto", isMobile ? "p-1" : "px-8")}>
      <div className="mb-8">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div className="w-full md:w-auto flex-1">
            {isMobile ? (
              <div className="flex items-center gap-2">
                <ButtonGroup minimal fill={isMobile} className="flex-1">
                  <Button
                    active={true}
                    onClick={() => navigate(`/dash/${profileId}/rules`)}
                    text={t("rules.title")}
                    large
                  />
                  <Button
                    active={false}
                    onClick={() => navigate(`/dash/${profileId}/filter`)}
                    text={t("filtering.title")}
                    large
                  />
                </ButtonGroup>
                {loading && <Spinner size={16} />}
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <h1 className="bp6-heading m-0">{t("rules.title")}</h1>
                {loading && <Spinner size={20} />}
              </div>
            )}
            <p className="bp6-text-muted mt-2!">{t("rules.subtitle")}</p>
          </div>

          <div className="flex flex-wrap items-center gap-3 self-start md:self-auto">
            {!loading && !hasSelfRedirect && (
              <PopoverNext
                isOpen={isPromptOpen}
                onInteraction={setIsPromptOpen}
                placement="bottom-end"
                portalClassName="z-20000"
                content={
                  <div className="p-4 w-72 sm:w-80 space-y-3 text-sm">
                    <p className="text-xs text-gray-700 dark:text-gray-300 leading-relaxed m-0">
                      {t("rules.addSelfRedirectPrompt", "是否增加指向本站的 CNAME 规则，用于地区网络优化（中国大陆用户推荐）？")}
                    </p>
                    <div className="flex justify-end gap-2 pt-1">
                      <Button
                        size="small"
                        variant="minimal"
                        text={t("common.no", "否")}
                        onClick={() => setIsPromptOpen(false)}
                      />
                      <Button
                        size="small"
                        intent={Intent.PRIMARY}
                        text={t("common.yes", "是")}
                        onClick={handleApplySelfRedirect}
                      />
                    </div>
                  </div>
                }
              >
                <Tag
                  minimal
                  interactive
                  intent={Intent.PRIMARY}
                  className="cursor-pointer select-none font-medium"
                >
                  {t("rules.addSelfRedirectTag", "增加本站重定向？")}
                </Tag>
              </PopoverNext>
            )}
            <Button
              type="button"
              variant="outlined"
              icon={<Download size={14} />}
              text={t("rules.exportList", "导出列表")}
              disabled={loading || rules.length === 0}
              onClick={() => handleExportAdGuardList(rules)}
            />
          </div>
        </div>
      </div>

      <Callout intent={Intent.PRIMARY} icon="info-sign" className="mb-6">
        <p>
          {t(
            "rules.wildcardDisclaimer",
            "若要匹配子域名，需使用通配符 *.example.com ，example.com 不会匹配子域名。"
          )}
        </p>
      </Callout>

      <AddRuleCard newRule={newRule} setNewRule={setNewRule} addRule={addRule} loading={isAdding} />

      {loading && rules.length === 0 ? (
        <div className="p-16 flex flex-col justify-center items-center gap-3">
          <Spinner size={32} />
          <span className="text-xs text-gray-500 dark:text-gray-400 font-medium">
            {t("common.loading", "加载中...")}
          </span>
        </div>
      ) : rules.length === 0 ? (
        <Callout title={t("rules.noRulesTitle")}>{t("rules.noRulesDesc")}</Callout>
      ) : (
        <div className="relative">
          {selectedRuleIds.length > 0 && (
            <div className="mb-3 px-4 py-2.5 rounded-lg border border-blue-200 dark:border-blue-800/70 bg-blue-50/70 dark:bg-blue-950/30 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium text-blue-700 dark:text-blue-300">
                  {t("rules.selectedCount", {
                    count: selectedRuleIds.length,
                    defaultValue: `已选择 ${selectedRuleIds.length} 项`,
                  })}
                </span>
                <Button
                  size="small"
                  variant="minimal"
                  text={t("rules.clearSelection", "取消选择")}
                  onClick={() => setSelectedRuleIds([])}
                  disabled={isDeletingBulk}
                />
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="small"
                  variant="outlined"
                  icon={<Download size={14} />}
                  text={t("rules.exportSelected", {
                    count: selectedRuleIds.length,
                    defaultValue: `导出 (${selectedRuleIds.length})`,
                  })}
                  disabled={isDeletingBulk}
                  onClick={() =>
                    handleExportAdGuardList(rules.filter((r) => selectedRuleIds.includes(r.id)))
                  }
                />
                <Button
                  type="button"
                  size="small"
                  intent={Intent.DANGER}
                  icon={<Trash2 size={14} />}
                  text={t("rules.deleteSelected", {
                    count: selectedRuleIds.length,
                    defaultValue: `删除 (${selectedRuleIds.length})`,
                  })}
                  loading={isDeletingBulk}
                  onClick={() => setIsBulkDeleteAlertOpen(true)}
                />
              </div>
            </div>
          )}
          <RulesTable
            rules={rules}
            startEdit={startEdit}
            getBlockDetail={getBlockDetail}
            selectedIds={selectedRuleIds}
            onToggleSelect={handleToggleSelectRule}
            onToggleSelectAll={handleToggleSelectAll}
          />
        </div>
      )}

      <EditRuleDialog
        editRule={editRule}
        setEditRule={setEditRule}
        saveEditRule={saveEditRule}
        cancelEdit={cancelEdit}
        deleteRule={deleteRule}
        isSaving={isSaving}
        isDeleting={isDeleting}
      />

      <Alert
        isOpen={isBulkDeleteAlertOpen}
        confirmButtonText={t("rules.delete", "删除")}
        cancelButtonText={t("rules.cancel", "取消")}
        intent={Intent.DANGER}
        icon="trash"
        loading={isDeletingBulk}
        onConfirm={handleConfirmBulkDelete}
        onCancel={() => {
          if (!isDeletingBulk) setIsBulkDeleteAlertOpen(false);
        }}
      >
        <p>
          {t("rules.confirmDeleteBulk", {
            count: selectedRuleIds.length,
            defaultValue: `确定要删除选中的 ${selectedRuleIds.length} 条规则吗？`,
          })}
        </p>
      </Alert>
    </div>
  );
};

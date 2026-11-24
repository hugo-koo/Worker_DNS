import React, { useState, useEffect } from "react";
import {
  Card,
  Elevation,
  H4,
  H5,
  Button,
  Intent,
  HTMLTable,
  Dialog,
  FormGroup,
  InputGroup,
  HTMLSelect,
  Tag,
  Switch,
  type OverlayToaster
} from "@blueprintjs/core";
import { ShieldCheck, UserPlus, Trash2, KeyRound, Plus, Copy, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatDateTime } from "../../../utils/date";
import {
  PASSWORD_REGEX,
  USERNAME_REGEX,
  INVITE_CODE_REGEX,
  checkPasswordBreached,
  hashPasswordClient,
  formatApiErrorMessage
} from "../../../utils/auth";
import type { UserInfo, InviteCodeInfo } from "../../../services";
import {
  createUser,
  deleteUser,
  createInviteCode,
  deleteInviteCode,
  updateSystemSettings
} from "../../../services";
import { executeWithTimeout } from "../../../utils/async";

export interface UserManagementCardProps {
  users: UserInfo[];
  currentUserId: string;
  onRefresh: () => void;
  inviteCodes?: InviteCodeInfo[];
  onRefreshInviteCodes?: () => void;
  registrationEnabled?: boolean;
  inviteCodeEnabled?: boolean;
  maxUsers?: string | number;
  onRefreshSettings?: () => void;
  onSavingChange?: (saving: boolean) => void;
  toasterRef?: React.RefObject<OverlayToaster | null>;
}

type InviteExpiryPreset = "never" | "1d" | "7d" | "30d" | "custom";

export const UserManagementCard: React.FC<UserManagementCardProps> = ({
  users,
  currentUserId,
  onRefresh,
  inviteCodes = [],
  onRefreshInviteCodes,
  registrationEnabled = true,
  inviteCodeEnabled = false,
  maxUsers,
  onRefreshSettings,
  onSavingChange,
  toasterRef,
}) => {
  const { t } = useTranslation();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [newUserPassword, setNewUserPassword] = useState("");
  const [newUserRole, setNewUserRole] = useState<'admin' | 'user'>('user');
  const [createLoading, setCreateLoading] = useState(false);
  const [showNewUserPassword, setShowNewUserPassword] = useState(false);
  const [isRegistrationEnabled, setIsRegistrationEnabled] = useState(registrationEnabled);
  const [isInviteCodeEnabled, setIsInviteCodeEnabled] = useState(inviteCodeEnabled);
  const [toggleLoading, setToggleLoading] = useState(false);
  const [inviteToggleLoading, setInviteToggleLoading] = useState(false);

  // Invite code creation modal & clipboard state
  const [isInviteDialogOpen, setIsInviteDialogOpen] = useState(false);
  const [inviteCodeInput, setInviteCodeInput] = useState("");
  const [inviteMaxUses, setInviteMaxUses] = useState("1");
  const [inviteExpiryPreset, setInviteExpiryPreset] = useState<InviteExpiryPreset>("never");
  const [inviteCustomExpiry, setInviteCustomExpiry] = useState("");
  const [createInviteLoading, setCreateInviteLoading] = useState(false);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));

  const maxUsersLimit = maxUsers !== undefined && maxUsers !== null && maxUsers !== "" ? parseInt(String(maxUsers), 10) : 0;
  const isQuotaReached = maxUsersLimit > 0 && users.length >= maxUsersLimit;

  useEffect(() => {
    setIsRegistrationEnabled(registrationEnabled);
  }, [registrationEnabled]);

  useEffect(() => {
    setIsInviteCodeEnabled(inviteCodeEnabled);
  }, [inviteCodeEnabled]);

  useEffect(() => {
    setNowSec(Math.floor(Date.now() / 1000));
  }, [inviteCodes]);

  const handleToggleRegistration = async (checked: boolean) => {
    const previousState = isRegistrationEnabled;
    setIsRegistrationEnabled(checked);
    setToggleLoading(true);
    onSavingChange?.(true);
    try {
      await executeWithTimeout(
        updateSystemSettings({ registration_enabled: String(checked) }),
        10000
      );
      toasterRef?.current?.show({
        message: t("common.saveSuccess", "保存成功"),
        intent: Intent.SUCCESS,
        icon: "tick",
      });
      onRefreshSettings?.();
    } catch (e: any) {
      console.error(e);
      setIsRegistrationEnabled(previousState);
      toasterRef?.current?.show({
        message: e.message || t("common.saveFailed", "保存失败"),
        intent: Intent.DANGER,
        icon: "error",
      });
    } finally {
      setToggleLoading(false);
      onSavingChange?.(false);
    }
  };

  const handleToggleInviteCode = async (checked: boolean) => {
    const previousState = isInviteCodeEnabled;
    setIsInviteCodeEnabled(checked);
    setInviteToggleLoading(true);
    onSavingChange?.(true);
    try {
      await executeWithTimeout(
        updateSystemSettings({ invite_code_enabled: String(checked) }),
        10000
      );
      toasterRef?.current?.show({
        message: t("common.saveSuccess", "保存成功"),
        intent: Intent.SUCCESS,
        icon: "tick",
      });
      onRefreshSettings?.();
    } catch (e: any) {
      console.error(e);
      setIsInviteCodeEnabled(previousState);
      toasterRef?.current?.show({
        message: e.message || t("common.saveFailed", "保存失败"),
        intent: Intent.DANGER,
        icon: "error",
      });
    } finally {
      setInviteToggleLoading(false);
      onSavingChange?.(false);
    }
  };

  const handleCreateUser = async () => {
    const trimmedUsername = newUsername.trim();
    if (!USERNAME_REGEX.test(trimmedUsername)) { alert(t("account.formatTipUsername")); return; }
    if (!PASSWORD_REGEX.test(newUserPassword)) { alert(t("account.formatTipPassword")); return; }
    setCreateLoading(true);
    try {
      const breachCheck = await checkPasswordBreached(newUserPassword, trimmedUsername);
      if (breachCheck.breached) {
        alert(t("auth.passwordLeaked", "This password has been exposed in a data breach or is too predictable. Please choose a different password."));
        setCreateLoading(false);
        return;
      }
      const clientHash = await hashPasswordClient(newUserPassword, trimmedUsername);
      await createUser({ username: trimmedUsername, password: clientHash, role: newUserRole });
      setIsDialogOpen(false);
      setNewUsername("");
      setNewUserPassword("");
      setShowNewUserPassword(false);
      onRefresh();
    } catch (e: any) {
      console.error(e);
      alert(formatApiErrorMessage(e, t));
    }
    finally { setCreateLoading(false); }
  };

  const handleDeleteUser = async (id: string) => {
    if (!confirm(t("account.confirmDeleteUser"))) return;
    try {
      await deleteUser(id);
      onRefresh();
    } catch (e) { console.error(e); }
  };

  const handleCreateInviteCode = async () => {
    const normalizedCode = inviteCodeInput.trim().toUpperCase();
    if (normalizedCode && !INVITE_CODE_REGEX.test(normalizedCode)) {
      alert(t("account.inviteCodeFormatError", "邀请码必须为 6 位大写英文字母或数字。"));
      return;
    }

    const maxUsesNum = parseInt(inviteMaxUses, 10);
    if (!Number.isFinite(maxUsesNum) || maxUsesNum < 1) {
      alert(t("account.inviteMaxUsesError", "总次数必须为大于等于 1 的整数。"));
      return;
    }

    const currentSec = Math.floor(Date.now() / 1000);
    let expiresAt: number | null = null;
    if (inviteExpiryPreset === "1d") expiresAt = currentSec + 86400;
    else if (inviteExpiryPreset === "7d") expiresAt = currentSec + 7 * 86400;
    else if (inviteExpiryPreset === "30d") expiresAt = currentSec + 30 * 86400;
    else if (inviteExpiryPreset === "custom") {
      const parsedMs = new Date(inviteCustomExpiry).getTime();
      if (!inviteCustomExpiry || Number.isNaN(parsedMs) || Math.floor(parsedMs / 1000) <= currentSec) {
        alert(t("account.inviteExpiryError", "请选择晚于当前时间的有效过期时间。"));
        return;
      }
      expiresAt = Math.floor(parsedMs / 1000);
    }

    setCreateInviteLoading(true);
    try {
      await createInviteCode({
        ...(normalizedCode ? { code: normalizedCode } : {}),
        max_uses: maxUsesNum,
        expires_at: expiresAt,
      });
      setIsInviteDialogOpen(false);
      setInviteCodeInput("");
      setInviteMaxUses("1");
      setInviteExpiryPreset("never");
      setInviteCustomExpiry("");
      onRefreshInviteCodes?.();
      toasterRef?.current?.show({
        message: t("account.inviteCodeCreated", "邀请码已创建"),
        intent: Intent.SUCCESS,
        icon: "tick",
      });
    } catch (e: any) {
      console.error(e);
      alert(formatApiErrorMessage(e, t));
    } finally {
      setCreateInviteLoading(false);
    }
  };

  const handleDeleteInviteCode = async (code: string) => {
    if (!confirm(t("account.confirmDeleteInviteCode", { code, defaultValue: `确定要删除邀请码 ${code} 吗？` }))) return;
    try {
      await deleteInviteCode(code);
      onRefreshInviteCodes?.();
    } catch (e) {
      console.error(e);
    }
  };

  const handleCopyInviteCode = (code: string) => {
    navigator.clipboard.writeText(code).then(() => {
      setCopiedCode(code);
      setTimeout(() => setCopiedCode((prev) => (prev === code ? null : prev)), 2000);
    });
  };

  const minCustomExpiryStr = new Date(Date.now() + 60000).toLocaleString("sv-SE").replace(" ", "T").slice(0, 16);

  return (
    <>
      <Card elevation={Elevation.ONE} className="space-y-4 overflow-hidden">
        <div className="pb-4 border-b border-gray-100 dark:border-gray-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <H4 className="flex items-center space-x-2 text-base font-semibold m-0" style={{ margin: 0 }}>
              <ShieldCheck className="w-5 h-5 text-red-500 shrink-0" />
              <span>{t("account.userManagement")}</span>
            </H4>
            {maxUsersLimit > 0 ? (
              <Tag minimal intent={isQuotaReached ? Intent.DANGER : Intent.PRIMARY} round>
                {users.length} / {maxUsersLimit}
              </Tag>
            ) : (
              <Tag minimal round>
                {users.length}
              </Tag>
            )}
          </div>
          <div className="flex items-center gap-4 flex-wrap">
            <Switch
              label={t("account.enableRegistration", "开放新账号注册")}
              checked={isRegistrationEnabled}
              disabled={toggleLoading}
              onChange={(e) => handleToggleRegistration(e.currentTarget.checked)}
              className="mb-0"
            />
            <Switch
              label={t("account.enableInviteCode", "启用邀请码注册")}
              checked={isInviteCodeEnabled}
              disabled={inviteToggleLoading}
              onChange={(e) => handleToggleInviteCode(e.currentTarget.checked)}
              className="mb-0"
            />
            <Button
              className="whitespace-nowrap"
              icon={<UserPlus size={16} />}
              intent={Intent.SUCCESS}
              text={t("account.createUser")}
              disabled={isQuotaReached}
              title={isQuotaReached ? t("auth.maxUsersReached", "当前系统已达到账号数量上限，无法创建新账号。") : undefined}
              onClick={() => setIsDialogOpen(true)}
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <HTMLTable interactive striped className="w-full whitespace-nowrap">
            <thead>
              <tr>
                <th className="whitespace-nowrap">{t("account.username")}</th>
                <th className="whitespace-nowrap">{t("account.role")}</th>
                <th className="whitespace-nowrap">MFA</th>
                <th className="whitespace-nowrap">ID</th>
                <th className="whitespace-nowrap">{t("account.inviteCode", "邀请码")}</th>
                <th className="whitespace-nowrap">{t("account.createdAt")}</th>
                <th className="whitespace-nowrap">{t("account.lastResolve")}</th>
                <th className="text-right whitespace-nowrap">{t("account.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id}>
                  <td className="font-bold whitespace-nowrap">{u.username}</td>
                  <td className="whitespace-nowrap"><Tag minimal intent={u.role === 'admin' ? Intent.DANGER : Intent.NONE} className="whitespace-nowrap">{u.role === 'admin' ? t("account.roleAdmin") : t("account.roleUser")}</Tag></td>
                  <td className="whitespace-nowrap">
                    <div className="flex flex-wrap gap-1">
                      {Boolean(u.totp_enabled) && <Tag minimal intent={Intent.SUCCESS} className="whitespace-nowrap">TOTP</Tag>}
                      {Boolean(u.passkeys_count && u.passkeys_count > 0) && <Tag minimal intent={Intent.PRIMARY} className="whitespace-nowrap">Passkey</Tag>}
                      {!u.totp_enabled && !(u.passkeys_count && u.passkeys_count > 0) && (
                        <Tag minimal intent={Intent.NONE} style={{ color: "#8a9ba8" }} className="whitespace-nowrap">{t("account.mfaNone", "无")}</Tag>
                      )}
                    </div>
                  </td>
                  <td className="whitespace-nowrap"><code className="text-xs">{u.id}</code></td>
                  <td className="whitespace-nowrap">
                    {u.invite_code ? (
                      <code className="text-xs font-mono">{u.invite_code}</code>
                    ) : (
                      <span className="text-xs text-gray-400">-</span>
                    )}
                  </td>
                  <td className="text-xs text-gray-500 whitespace-nowrap">{u.created_at ? formatDateTime(new Date(u.created_at * 1000)) : '-'}</td>
                  <td className="text-xs text-gray-500 whitespace-nowrap">{u.last_resolve_at ? formatDateTime(new Date(u.last_resolve_at * 1000)) : '-'}</td>
                  <td className="text-right whitespace-nowrap">
                    <div className="inline-flex items-center gap-1">
                      <Button
                        minimal
                        intent={Intent.DANGER}
                        icon={<Trash2 size={14} />}
                        disabled={u.id === currentUserId}
                        onClick={() => handleDeleteUser(u.id)}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </HTMLTable>
        </div>

        {/* Invite Codes Management Section */}
        <div className="pt-4 border-t border-gray-100 dark:border-gray-800 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <H5 className="flex items-center space-x-2 text-sm font-semibold m-0" style={{ margin: 0 }}>
                <KeyRound className="w-4 h-4 text-blue-500 shrink-0" />
                <span>{t("account.inviteCodeList", "邀请码列表")}</span>
              </H5>
              <Tag minimal round>{inviteCodes.length}</Tag>
            </div>
            <Button
              small
              icon={<Plus size={14} />}
              intent={Intent.PRIMARY}
              text={t("account.createInviteCode", "创建邀请码")}
              onClick={() => setIsInviteDialogOpen(true)}
            />
          </div>

          {inviteCodes.length === 0 ? (
            <div className="rounded-lg border border-dashed border-gray-200 dark:border-gray-800 py-5 text-center text-xs text-gray-500 dark:text-gray-400">
              {t("account.noInviteCodes", "暂无邀请码，点击右上角创建邀请码。")}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <HTMLTable interactive striped className="w-full whitespace-nowrap">
                <thead>
                  <tr>
                    <th className="whitespace-nowrap">{t("account.inviteCode", "邀请码")}</th>
                    <th className="whitespace-nowrap">{t("account.inviteTotalUses", "总次数")}</th>
                    <th className="whitespace-nowrap">{t("account.inviteRemainingUses", "剩余可用次数")}</th>
                    <th className="whitespace-nowrap">{t("account.inviteExpiresAt", "有效期")}</th>
                    <th className="whitespace-nowrap">{t("account.inviteLastUsedAt", "上次使用时间")}</th>
                    <th className="text-right whitespace-nowrap">{t("account.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {inviteCodes.map((ic) => {
                    const isExpired = ic.expires_at !== null && ic.expires_at <= nowSec;
                    const isExhausted = ic.remaining_uses <= 0;
                    return (
                      <tr key={ic.code}>
                        <td className="whitespace-nowrap">
                          <div className="inline-flex items-center gap-1.5">
                            <code className="text-xs font-mono font-semibold tracking-wider select-all">{ic.code}</code>
                            <Button
                              minimal
                              small
                              icon={copiedCode === ic.code ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
                              title={t("common.copy", "复制")}
                              onClick={() => handleCopyInviteCode(ic.code)}
                            />
                          </div>
                        </td>
                        <td className="text-xs font-mono whitespace-nowrap">{ic.max_uses}</td>
                        <td className="whitespace-nowrap">
                          <Tag
                            minimal
                            round
                            intent={isExhausted ? Intent.DANGER : Intent.SUCCESS}
                            className="font-mono"
                          >
                            {ic.remaining_uses}
                          </Tag>
                        </td>
                        <td className="text-xs whitespace-nowrap">
                          {ic.expires_at === null ? (
                            <span className="text-gray-500 dark:text-gray-400">
                              {t("account.inviteNeverExpires", "永久有效")}
                            </span>
                          ) : (
                            <div className="inline-flex items-center gap-1.5">
                              <span className={isExpired ? "text-red-500 line-through" : "text-gray-600 dark:text-gray-300"}>
                                {formatDateTime(new Date(ic.expires_at * 1000))}
                              </span>
                              {isExpired && (
                                <Tag minimal intent={Intent.DANGER}>
                                  {t("account.inviteExpiredBadge", "已过期")}
                                </Tag>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="text-xs text-gray-500 whitespace-nowrap">
                          {ic.last_used_at ? formatDateTime(new Date(ic.last_used_at * 1000)) : "-"}
                        </td>
                        <td className="text-right whitespace-nowrap">
                          <Button
                            minimal
                            intent={Intent.DANGER}
                            icon={<Trash2 size={14} />}
                            onClick={() => handleDeleteInviteCode(ic.code)}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </HTMLTable>
            </div>
          )}
        </div>
      </Card>

      <Dialog isOpen={isDialogOpen} onClose={() => { setIsDialogOpen(false); setShowNewUserPassword(false); }} title={t("account.createNewUser")} icon="user">
        <form
          className="p-6 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!createLoading) {
              void handleCreateUser();
            }
          }}
        >
          <FormGroup label={t("account.username")}><InputGroup value={newUsername} onChange={e => setNewUsername(e.target.value)} placeholder={t("auth.usernamePlaceholder")} autoFocus /></FormGroup>
          <FormGroup label={t("account.initialPassword")}>
            <InputGroup
              type={showNewUserPassword ? "text" : "password"}
              value={newUserPassword}
              onChange={e => setNewUserPassword(e.target.value)}
              placeholder={t("auth.passwordPlaceholder")}
              rightElement={
                <Button
                  type="button"
                  minimal={true}
                  icon={showNewUserPassword ? "eye-open" : "eye-off"}
                  onClick={() => setShowNewUserPassword(!showNewUserPassword)}
                  title={showNewUserPassword ? t("auth.hidePassword", "Hide password") : t("auth.showPassword", "Show password")}
                />
              }
            />
          </FormGroup>
          <FormGroup label={t("account.userRole")}>
            <HTMLSelect fill value={newUserRole} onChange={e => setNewUserRole(e.target.value as any)} options={[{ label: t("account.roleUser"), value: "user" }, { label: t("account.roleAdmin"), value: "admin" }]} />
          </FormGroup>
          <div className="flex justify-end gap-2 mt-6">
            <Button type="button" text={t("account.cancel")} onClick={() => setIsDialogOpen(false)} />
            <Button type="submit" intent={Intent.PRIMARY} text={t("account.createNow")} loading={createLoading} />
          </div>
        </form>
      </Dialog>

      <Dialog
        isOpen={isInviteDialogOpen}
        onClose={() => setIsInviteDialogOpen(false)}
        title={t("account.createInviteCode", "创建邀请码")}
        icon="key"
      >
        <form
          className="p-6 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!createInviteLoading) {
              void handleCreateInviteCode();
            }
          }}
        >
          <FormGroup
            label={t("account.inviteCodeOptionalLabel", "邀请码（可选）")}
            helperText={t("account.inviteCodeOptionalHelper", "留空将自动生成 6 位大写英文字母或数字；手动填写需为 6 位大写字母/数字。")}
          >
            <InputGroup
              value={inviteCodeInput}
              maxLength={6}
              className="font-mono uppercase tracking-widest"
              placeholder={t("account.inviteCodeOptionalPlaceholder", "留空自动随机生成")}
              onChange={(e) => {
                const sanitized = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
                setInviteCodeInput(sanitized);
              }}
              autoFocus
            />
          </FormGroup>
          <FormGroup label={t("account.inviteTotalUses", "总次数")}>
            <InputGroup
              type="number"
              min={1}
              value={inviteMaxUses}
              onChange={(e) => setInviteMaxUses(e.target.value)}
            />
          </FormGroup>
          <FormGroup label={t("account.inviteExpiresAt", "有效期")}>
            <HTMLSelect
              fill
              value={inviteExpiryPreset}
              onChange={(e) => setInviteExpiryPreset(e.target.value as InviteExpiryPreset)}
              options={[
                { label: t("account.inviteNeverExpires", "永久有效"), value: "never" },
                { label: t("account.inviteExpiry1d", "24 小时后过期"), value: "1d" },
                { label: t("account.inviteExpiry7d", "7 天后过期"), value: "7d" },
                { label: t("account.inviteExpiry30d", "30 天后过期"), value: "30d" },
                { label: t("account.inviteExpiryCustom", "自定义过期时间"), value: "custom" },
              ]}
            />
          </FormGroup>
          {inviteExpiryPreset === "custom" && (
            <FormGroup label={t("account.inviteCustomExpiryLabel", "截止时间")}>
              <InputGroup
                type="datetime-local"
                min={minCustomExpiryStr}
                value={inviteCustomExpiry}
                onChange={(e) => setInviteCustomExpiry(e.target.value)}
              />
            </FormGroup>
          )}
          <div className="flex justify-end gap-2 mt-6">
            <Button type="button" text={t("account.cancel")} onClick={() => setIsInviteDialogOpen(false)} />
            <Button
              type="submit"
              intent={Intent.PRIMARY}
              text={t("account.createNow")}
              loading={createInviteLoading}
            />
          </div>
        </form>
      </Dialog>
    </>
  );
};

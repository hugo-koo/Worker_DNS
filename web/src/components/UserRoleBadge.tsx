import React from "react";
import { ShieldCheck, User as UserIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import clsx from "clsx";

export interface UserRoleBadgeProps {
  /** User role (`admin` or standard `user`). */
  role: "admin" | "user" | string;
  size?: "small" | "normal";
  showIcon?: boolean;
  className?: string;
}

/**
 * Neutral pill badge displaying the user's account role, matching DeploymentModeBadge styling.
 */
export const UserRoleBadge: React.FC<UserRoleBadgeProps> = ({
  role,
  size = "normal",
  showIcon = true,
  className,
}) => {
  const { t } = useTranslation();
  const isSmall = size === "small";
  const isAdmin = role === "admin";
  const label = isAdmin
    ? t("account.roleAdmin", "管理员")
    : t("account.roleUser", "用户");

  return (
    <div
      className={clsx(
        "inline-flex items-center gap-1.5 font-medium rounded-full transition-colors select-none shrink-0 whitespace-nowrap",
        isSmall ? "px-2 py-0.5 text-[11px]" : "px-3 py-1 text-xs",
        "bg-white text-gray-700 border border-gray-200 dark:bg-gray-800 dark:text-gray-200 dark:border-gray-700",
        className
      )}
    >
      {showIcon &&
        (isAdmin ? (
          <ShieldCheck size={isSmall ? 12 : 14} className="shrink-0 opacity-75" />
        ) : (
          <UserIcon size={isSmall ? 12 : 14} className="shrink-0 opacity-75" />
        ))}
      <span>{label}</span>
    </div>
  );
};

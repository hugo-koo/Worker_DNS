import React from "react";
import { Server, Cloud, FlaskConical } from "lucide-react";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import { useDeploymentMode } from "../../hooks/useDeploymentMode";

export interface DeploymentModeBadgeProps {
  size?: "small" | "normal";
  showIcon?: boolean;
  className?: string;
}

/**
 * Visual badge indicating whether the application is running in Demo Mode,
 * Serverfull (Node.js/VPS) mode, or Cloudflare Workers (Serverless) mode.
 */
export const DeploymentModeBadge: React.FC<DeploymentModeBadgeProps> = ({
  size = "normal",
  showIcon = true,
  className,
}) => {
  const { isServerfull, isDemoMode } = useDeploymentMode();
  const { t } = useTranslation();

  const isSmall = size === "small";
  const badgeStyle =
    "bg-white text-gray-700 border border-gray-200 dark:bg-gray-800 dark:text-gray-200 dark:border-gray-700";

  const badgeTitle = isDemoMode
    ? "Demo Mode (Sample Data)"
    : isServerfull
      ? "Self-Hosted / Node.js Serverfull"
      : "Cloudflare Workers Serverless";

  const badgeLabel = isDemoMode
    ? t("common.modeDemo", "Demo Mode")
    : isServerfull
      ? t("common.modeServerfull")
      : t("common.modeCloudflare");

  return (
    <div
      className={clsx(
        "inline-flex items-center gap-1.5 font-medium rounded-full transition-colors select-none",
        isSmall ? "px-2 py-0.5 text-[11px]" : "px-3 py-1 text-xs",
        badgeStyle,
        className
      )}
      title={badgeTitle}
    >
      {showIcon && (
        isDemoMode ? (
          <FlaskConical size={isSmall ? 12 : 14} className="shrink-0 opacity-75" />
        ) : isServerfull ? (
          <Server size={isSmall ? 12 : 14} className="shrink-0 opacity-75" />
        ) : (
          <Cloud size={isSmall ? 12 : 14} className="shrink-0 opacity-75" />
        )
      )}
      <span>{badgeLabel}</span>
    </div>
  );
};

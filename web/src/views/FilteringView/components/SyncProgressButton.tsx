import React from "react";
import { Button, Intent } from "@blueprintjs/core";
import { RefreshCw } from "lucide-react";
import { clsx } from "clsx";

export interface SyncProgressButtonProps {
  syncing: boolean;
  progress: number;
  label: string;
  syncingLabel?: string;
  detailText?: string;
  intent?: Intent;
  iconSize?: number;
  loading?: boolean;
  disabled?: boolean;
  className?: string;
  onClick: () => void;
}

/**
 * Renders a Blueprint button that transforms into an inline progress-bar button
 * while a filter list synchronization task is running.
 */
export const SyncProgressButton: React.FC<SyncProgressButtonProps> = ({
  syncing,
  progress,
  label,
  syncingLabel,
  detailText,
  intent,
  iconSize = 15,
  loading = false,
  disabled = false,
  className,
  onClick,
}) => {
  const clamped = Math.max(0, Math.min(100, Math.round(progress)));
  const isPrimary = intent === Intent.PRIMARY;

  if (!syncing) {
    return (
      <Button
        icon={<RefreshCw size={iconSize} />}
        text={label}
        intent={intent}
        loading={loading}
        disabled={disabled}
        className={className}
        onClick={onClick}
      />
    );
  }

  return (
    <Button
      intent={intent}
      disabled
      className={clsx("relative overflow-hidden cursor-wait!", className)}
      onClick={onClick}
    >
      <span
        aria-hidden="true"
        className={clsx(
          "absolute inset-y-0 left-0 transition-all duration-300 ease-out pointer-events-none",
          isPrimary ? "bg-white/20" : "bg-blue-500/20 dark:bg-blue-400/25"
        )}
        style={{ width: `${Math.max(4, clamped)}%` }}
      />
      <span
        aria-hidden="true"
        className={clsx(
          "absolute bottom-0 left-0 h-[2.5px] transition-all duration-300 ease-out pointer-events-none",
          isPrimary ? "bg-white/90" : "bg-blue-500 dark:bg-blue-400"
        )}
        style={{ width: `${Math.max(4, clamped)}%` }}
      />
      <span className="relative z-10 inline-flex items-center gap-1.5 font-medium">
        <RefreshCw size={iconSize} className="animate-spin shrink-0" />
        <span>{syncingLabel || label}</span>
        <span className="font-mono text-xs opacity-90">
          {detailText ? `${detailText} · ${clamped}%` : `${clamped}%`}
        </span>
      </span>
    </Button>
  );
};

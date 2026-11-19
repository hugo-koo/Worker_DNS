import { useSyncExternalStore } from "react";
import type { DeploymentMode } from "../types/system";

export interface DeploymentModeResult {
  mode: DeploymentMode;
  isServerfull: boolean;
  isCloudflare: boolean;
}

const listeners = new Set<() => void>();

function readIsServerfullFromWindow(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const config = window.DNS_WORKER_CONFIG;
  return Boolean(config?.isServerfull || config?.mode === "serverfull");
}

function subscribeDeploymentMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const SERVERFULL_RESULT: DeploymentModeResult = {
  mode: "serverfull",
  isServerfull: true,
  isCloudflare: false,
};

const CLOUDFLARE_RESULT: DeploymentModeResult = {
  mode: "cloudflare",
  isServerfull: false,
  isCloudflare: true,
};

function getDeploymentModeSnapshot(): DeploymentModeResult {
  return readIsServerfullFromWindow() ? SERVERFULL_RESULT : CLOUDFLARE_RESULT;
}

/**
 * Syncs deployment mode metadata received from `/api/clientinfo` into `window.DNS_WORKER_CONFIG`
 * as a fallback when inline HTML config injection was unavailable (e.g. local Vite dev or proxy cache).
 *
 * @param isServerfull - Server-reported serverfull flag.
 * @param mode - Server-reported deployment mode string.
 */
export function syncDeploymentModeFromClientInfo(
  isServerfull?: boolean,
  mode?: DeploymentMode
): void {
  if (typeof window === "undefined") {
    return;
  }
  if (typeof isServerfull !== "boolean" && !mode) {
    return;
  }

  const nextIsServerfull = Boolean(isServerfull || mode === "serverfull");
  const nextMode: DeploymentMode = nextIsServerfull ? "serverfull" : "cloudflare";
  const current = window.DNS_WORKER_CONFIG;

  if (
    current &&
    current.isServerfull === nextIsServerfull &&
    current.mode === nextMode
  ) {
    return;
  }

  window.DNS_WORKER_CONFIG = {
    ...current,
    isServerfull: nextIsServerfull,
    mode: nextMode,
  };

  for (const listener of listeners) {
    listener();
  }
}

/**
 * Hook to inspect the active deployment mode (Serverfull vs Cloudflare Workers).
 * Sources status from `window.DNS_WORKER_CONFIG` injected by HTMLRewriter and stays in sync
 * with runtime `/api/clientinfo` fallback detection.
 */
export function useDeploymentMode(): DeploymentModeResult {
  return useSyncExternalStore(
    subscribeDeploymentMode,
    getDeploymentModeSnapshot,
    () => CLOUDFLARE_RESULT
  );
}

import { useSyncExternalStore } from "react";
import type { DeploymentMode } from "../types/system";

const DEFAULT_DEMO_DOMAIN = "dns.worker.domain";

export interface DeploymentModeResult {
  mode: DeploymentMode;
  isServerfull: boolean;
  isCloudflare: boolean;
  isDemoMode: boolean;
  demoDomain: string;
}

const listeners = new Set<() => void>();
const snapshotCache = new Map<string, DeploymentModeResult>();

function readSnapshotParams(): { isServerfull: boolean; isDemoMode: boolean; demoDomain: string } {
  if (typeof window === "undefined") {
    return { isServerfull: false, isDemoMode: false, demoDomain: DEFAULT_DEMO_DOMAIN };
  }
  const config = window.DNS_WORKER_CONFIG;
  const isServerfull = Boolean(config?.isServerfull || config?.mode === "serverfull");
  const isDemoMode = Boolean(config?.isDemoMode);
  const demoDomain = (config?.demoDomain || DEFAULT_DEMO_DOMAIN).trim() || DEFAULT_DEMO_DOMAIN;
  return { isServerfull, isDemoMode, demoDomain };
}

function getCachedSnapshot(
  isServerfull: boolean,
  isDemoMode: boolean,
  demoDomain: string
): DeploymentModeResult {
  const key = `${isServerfull ? 1 : 0}|${isDemoMode ? 1 : 0}|${demoDomain}`;
  let cached = snapshotCache.get(key);
  if (!cached) {
    cached = {
      mode: isServerfull ? "serverfull" : "cloudflare",
      isServerfull,
      isCloudflare: !isServerfull,
      isDemoMode,
      demoDomain,
    };
    snapshotCache.set(key, cached);
  }
  return cached;
}

const SERVER_FALLBACK_SNAPSHOT = getCachedSnapshot(false, false, DEFAULT_DEMO_DOMAIN);

function subscribeDeploymentMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getDeploymentModeSnapshot(): DeploymentModeResult {
  const { isServerfull, isDemoMode, demoDomain } = readSnapshotParams();
  return getCachedSnapshot(isServerfull, isDemoMode, demoDomain);
}

/**
 * Returns the UI display origin (`https://<demoDomain>` in Demo Mode, otherwise `window.location.origin`).
 */
export function getDisplayOrigin(isDemoMode?: boolean, demoDomain?: string): string {
  const demo = isDemoMode ?? Boolean(typeof window !== "undefined" && window.DNS_WORKER_CONFIG?.isDemoMode);
  if (demo) {
    const domain =
      (demoDomain ?? (typeof window !== "undefined" ? window.DNS_WORKER_CONFIG?.demoDomain : undefined) ?? DEFAULT_DEMO_DOMAIN)
        .trim() || DEFAULT_DEMO_DOMAIN;
    return `https://${domain}`;
  }
  return typeof window !== "undefined" ? window.location.origin : "";
}

/**
 * Returns the UI display host (`demoDomain` in Demo Mode, otherwise `window.location.host || window.location.hostname`).
 */
export function getDisplayHost(isDemoMode?: boolean, demoDomain?: string): string {
  const demo = isDemoMode ?? Boolean(typeof window !== "undefined" && window.DNS_WORKER_CONFIG?.isDemoMode);
  if (demo) {
    return (
      (demoDomain ?? (typeof window !== "undefined" ? window.DNS_WORKER_CONFIG?.demoDomain : undefined) ?? DEFAULT_DEMO_DOMAIN)
        .trim() || DEFAULT_DEMO_DOMAIN
    );
  }
  return typeof window !== "undefined" ? window.location.host || window.location.hostname : "";
}

/**
 * Returns the UI display hostname (`demoDomain` in Demo Mode, otherwise `window.location.hostname`).
 */
export function getDisplayHostname(isDemoMode?: boolean, demoDomain?: string): string {
  const demo = isDemoMode ?? Boolean(typeof window !== "undefined" && window.DNS_WORKER_CONFIG?.isDemoMode);
  if (demo) {
    return (
      (demoDomain ?? (typeof window !== "undefined" ? window.DNS_WORKER_CONFIG?.demoDomain : undefined) ?? DEFAULT_DEMO_DOMAIN)
        .trim() || DEFAULT_DEMO_DOMAIN
    );
  }
  return typeof window !== "undefined" ? window.location.hostname : "";
}

/**
 * Syncs deployment and demo mode metadata received from `/api/clientinfo` into `window.DNS_WORKER_CONFIG`
 * as a fallback when inline HTML config injection was unavailable (e.g. local Vite dev or proxy cache).
 */
export function syncDeploymentModeFromClientInfo(
  isServerfull?: boolean,
  mode?: DeploymentMode,
  isDemoMode?: boolean,
  demoDomain?: string
): void {
  if (typeof window === "undefined") {
    return;
  }
  if (typeof isServerfull !== "boolean" && !mode && typeof isDemoMode !== "boolean") {
    return;
  }

  const current = window.DNS_WORKER_CONFIG;
  const nextIsServerfull =
    typeof isServerfull === "boolean" || mode
      ? Boolean(isServerfull || mode === "serverfull")
      : Boolean(current?.isServerfull || current?.mode === "serverfull");
  const nextMode: DeploymentMode = nextIsServerfull ? "serverfull" : "cloudflare";
  const nextDemoMode = typeof isDemoMode === "boolean" ? isDemoMode : Boolean(current?.isDemoMode);
  const nextDemoDomain =
    demoDomain !== undefined ? demoDomain : current?.demoDomain;

  if (
    current &&
    current.isServerfull === nextIsServerfull &&
    current.mode === nextMode &&
    Boolean(current.isDemoMode) === nextDemoMode &&
    current.demoDomain === nextDemoDomain
  ) {
    return;
  }

  window.DNS_WORKER_CONFIG = {
    ...current,
    isServerfull: nextIsServerfull,
    mode: nextMode,
    isDemoMode: nextDemoMode,
    demoDomain: nextDemoDomain,
  };

  for (const listener of listeners) {
    listener();
  }
}

/**
 * Hook to inspect the active deployment mode (Serverfull vs Cloudflare Workers) and Demo Mode state.
 * Sources status from `window.DNS_WORKER_CONFIG` injected by HTMLRewriter and stays in sync
 * with runtime `/api/clientinfo` fallback detection.
 */
export function useDeploymentMode(): DeploymentModeResult {
  return useSyncExternalStore(
    subscribeDeploymentMode,
    getDeploymentModeSnapshot,
    () => SERVER_FALLBACK_SNAPSHOT
  );
}

import type { ProfileSettings } from "../../types";

/**
 * Resolves the configured TTL override (in seconds) for a given DNS action if enabled and valid.
 *
 * @param settings - Current profile settings.
 * @param action - The resolution action ('PASS' | 'REDIRECT' | 'BLOCK').
 * @returns Override TTL in seconds (0..2147483647), or undefined when disabled/unset.
 */
export function resolveTtlOverride(
  settings: ProfileSettings,
  action: "PASS" | "REDIRECT" | "BLOCK"
): number | undefined {
  const rule =
    action === "PASS"
      ? settings.ttl_override?.pass
      : action === "REDIRECT"
        ? settings.ttl_override?.redirect
        : settings.ttl_override?.block;

  if (!rule?.enabled) {
    return undefined;
  }

  const parsed = Number(rule.ttl);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }

  return Math.min(2147483647, Math.floor(parsed));
}

/**
 * Custom error representing an upstream HTTP error response during DoH resolution.
 */
export class UpstreamHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly responseBodySnippet: string,
    public readonly cfRay?: string
  ) {
    super(`Upstream HTTP ${status}${statusText ? ` ${statusText}` : ""}`);
    this.name = "UpstreamHttpError";
  }
}

/**
 * Transport execution outcome returned by fetchFromUpstream.
 */
export interface UpstreamTransportResult {
  /** Raw wire-format DNS answer packet. */
  answer: Uint8Array;
  /** Latency in milliseconds spent communicating with the upstream. */
  latency: number;
  /** Diagnostic string of the transport protocol used (e.g., 'POST', 'DoT', 'TCP'). */
  diagMethod: string;
  /** Diagnostic target string (URL or socket address). */
  diagTarget: string;
}

/**
 * Structured representation of a decoded DNS answer resource record.
 */
export interface ParsedDNSAnswerRecord {
  name: string;
  type: string;
  data: string;
  ttl: number;
}

/**
 * Result of applying EDNS Client Subnet to a query.
 */
export interface EcsApplicationResult {
  /** Wire-format query bytes (with ECS injected if configured). */
  queryRaw: Uint8Array;
  /** Normalized ECS subnet string for logging, if applied. */
  ecs?: string;
}

/**
 * Result of evaluating best-effort Encrypted Client Hello rewrite.
 */
export interface EchProcessResult {
  /** Effective wire-format answer packet (rewritten if ECH injected). */
  answer: Uint8Array;
  /** Parsed answer records reflecting any rewritten records. */
  parsedAnswers: ParsedDNSAnswerRecord[];
  /** Effective resolution reason (e.g. 'ECH Rewritten' or original reason). */
  effectiveReason?: string;
}

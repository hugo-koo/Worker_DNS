import type { Rule } from "../types";

/**
 * Normalizes a rule pattern into an AdGuard Home domain matcher (`|domain^` or `||domain^`).
 * Promotes `*.domain`, `||domain`, or `includeSubdomains` patterns to `||domain^` so wildcard
 * rules serialize as valid AdGuard Home subdomain matchers instead of `|*.domain^`.
 *
 * @param pattern - Domain or wildcard pattern from Custom Rules
 * @param includeSubdomains - Whether apex + subdomains should be matched via `||`
 * @returns AdGuard domain matcher string, or empty string if invalid
 */
export function formatRuleDomainMatcher(
  pattern: string,
  includeSubdomains?: boolean | number
): string {
  let normalized = pattern
    .trim()
    .toLowerCase()
    .replace(/^@@/, "");

  let matchesSubdomains = Boolean(includeSubdomains);

  if (normalized.startsWith("||")) {
    matchesSubdomains = true;
    normalized = normalized.slice(2);
  } else if (normalized.startsWith("|")) {
    normalized = normalized.slice(1);
  }

  if (normalized.startsWith("*.")) {
    matchesSubdomains = true;
    normalized = normalized.slice(2);
  }

  const cleaned = normalized
    .replace(/\^$/, "")
    .replace(/^\.+|\.+$/g, "");

  if (!cleaned) {
    return "";
  }

  const prefix = matchesSubdomains ? "||" : "|";
  return `${prefix}${cleaned}^`;
}

/**
 * Splits a multi-value IP field (comma-separated) into trimmed non-empty targets.
 *
 * @param rawValue - Raw field string such as `"1.1.1.1"` or `"1.1.1.1, 1.0.0.1"`
 * @returns Array of trimmed target values
 */
function splitRecordTargets(rawValue?: string): string[] {
  if (!rawValue) {
    return [];
  }
  return rawValue
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Converts a single Custom Rule into one or more AdGuard Home DNS filtering lines.
 *
 * Syntax mapping:
 * - `BLOCK`: `|domain^` or `||domain^`
 * - `ALLOW`: `@@|domain^` or `@@||domain^`
 * - `REDIRECT`: `<matcher>$dnsrewrite=<target>` for A/AAAA/CNAME, `<matcher>$dnsrewrite=NOERROR;TXT;<text>` for TXT
 *
 * @param rule - Custom rule object
 * @returns Array of AdGuard Home compatible rule lines
 */
export function formatRuleToAdGuardLines(rule: Rule): string[] {
  const matcher = formatRuleDomainMatcher(rule.pattern, rule.include_subdomains);
  if (!matcher) {
    return [];
  }

  if (rule.type === "BLOCK") {
    return [matcher];
  }

  if (rule.type === "ALLOW") {
    return [`@@${matcher}`];
  }

  if (rule.type === "REDIRECT") {
    const lines: string[] = [];

    for (const ipv4 of splitRecordTargets(rule.v_a)) {
      lines.push(`${matcher}$dnsrewrite=${ipv4}`);
    }
    for (const ipv6 of splitRecordTargets(rule.v_aaaa)) {
      lines.push(`${matcher}$dnsrewrite=${ipv6}`);
    }

    const cname = rule.v_cname?.trim().toLowerCase().replace(/\.+$/, "");
    if (cname) {
      lines.push(`${matcher}$dnsrewrite=${cname}`);
    }

    const txt = rule.v_txt?.trim();
    if (txt) {
      lines.push(`${matcher}$dnsrewrite=NOERROR;TXT;${txt}`);
    }

    return lines;
  }

  return [];
}

/**
 * Collects deduplicated AdGuard Home rule lines from a rule list while preserving order.
 *
 * @param rules - Array of Custom Rules
 * @returns Deduplicated AdGuard Home rule lines
 */
function collectAdGuardRuleLines(rules: Rule[]): string[] {
  const seen = new Set<string>();
  const ruleLines: string[] = [];

  for (const rule of rules) {
    if (rule.enabled === 0 || rule.enabled === false) {
      continue;
    }
    for (const line of formatRuleToAdGuardLines(rule)) {
      if (!seen.has(line)) {
        seen.add(line);
        ruleLines.push(line);
      }
    }
  }

  return ruleLines;
}

/**
 * Serializes a list of Custom Rules into a deduplicated, AdGuard Home compatible filter list.
 *
 * @param rules - Array of Custom Rules to serialize
 * @param profileName - Optional profile label included in the header comment
 * @returns Full `.txt` file content ready for AdGuard Home custom filtering rules or DNS blocklist import
 */
export function exportRulesToAdGuardList(rules: Rule[], profileName?: string): string {
  const ruleLines = collectAdGuardRuleLines(rules);
  const title = profileName ? `DNS-Worker Custom Rules (${profileName})` : "DNS-Worker Custom Rules";
  const headerLines = [
    `! Title: ${title}`,
    "! Format: AdGuard Home DNS Filtering Syntax",
    `! Exported: ${new Date().toISOString()}`,
    `! Total rules: ${ruleLines.length}`,
    "!",
  ];

  return `${[...headerLines, ...ruleLines].join("\n")}\n`;
}

/**
 * Triggers a browser download of Custom Rules formatted as an AdGuard Home compatible `.txt` list.
 *
 * @param rules - Custom Rules to export
 * @param filename - Suggested download file name (e.g. `"adguard-rules.txt"`)
 * @param profileName - Optional profile name for the header metadata
 * @returns Number of serialized rule lines written (0 if nothing could be formatted)
 */
export function downloadAdGuardRulesList(
  rules: Rule[],
  filename: string,
  profileName?: string
): number {
  const ruleLines = collectAdGuardRuleLines(rules);
  if (ruleLines.length === 0) {
    return 0;
  }

  const content = exportRulesToAdGuardList(rules, profileName);
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  return ruleLines.length;
}

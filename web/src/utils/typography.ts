/**
 * Locale-aware typography loader for DNS Worker Web UI.
 *
 * Latin, Cyrillic, and Vietnamese Noto variable fonts (Sans, Serif, Sans Mono)
 * are bundled locally via Fontsource. CJK Noto Sans & Noto Serif subsets are
 * fetched lazily per active script so initial asset size remains compact while
 * preserving accurate Han/Kana/Hangul glyph variants across locales.
 */

interface CjkScriptConfig {
  /** Stable identifier used to deduplicate injected <link> tags. */
  scriptId: string;
  /** Google Fonts CSS2 query for the matching Noto Sans + Noto Serif families. */
  familiesQuery: string;
}

const CJK_SCRIPT_MAP: Record<string, CjkScriptConfig> = {
  "zh-cn": {
    scriptId: "sc",
    familiesQuery: "family=Noto+Sans+SC:wght@400..700&family=Noto+Serif+SC:wght@400..700",
  },
  "zh-sg": {
    scriptId: "sc",
    familiesQuery: "family=Noto+Sans+SC:wght@400..700&family=Noto+Serif+SC:wght@400..700",
  },
  "zh-hans": {
    scriptId: "sc",
    familiesQuery: "family=Noto+Sans+SC:wght@400..700&family=Noto+Serif+SC:wght@400..700",
  },
  "zh-tw": {
    scriptId: "tc",
    familiesQuery: "family=Noto+Sans+TC:wght@400..700&family=Noto+Serif+TC:wght@400..700",
  },
  "zh-hant": {
    scriptId: "tc",
    familiesQuery: "family=Noto+Sans+TC:wght@400..700&family=Noto+Serif+TC:wght@400..700",
  },
  "zh-hk": {
    scriptId: "hk",
    familiesQuery:
      "family=Noto+Sans+HK:wght@400..700&family=Noto+Serif+HK:wght@400..700&family=Noto+Sans+TC:wght@400..700&family=Noto+Serif+TC:wght@400..700",
  },
  "zh-mo": {
    scriptId: "hk",
    familiesQuery:
      "family=Noto+Sans+HK:wght@400..700&family=Noto+Serif+HK:wght@400..700&family=Noto+Sans+TC:wght@400..700&family=Noto+Serif+TC:wght@400..700",
  },
  ja: {
    scriptId: "jp",
    familiesQuery: "family=Noto+Sans+JP:wght@400..700&family=Noto+Serif+JP:wght@400..700",
  },
  "ja-jp": {
    scriptId: "jp",
    familiesQuery: "family=Noto+Sans+JP:wght@400..700&family=Noto+Serif+JP:wght@400..700",
  },
  ko: {
    scriptId: "kr",
    familiesQuery: "family=Noto+Sans+KR:wght@400..700&family=Noto+Serif+KR:wght@400..700",
  },
  "ko-kr": {
    scriptId: "kr",
    familiesQuery: "family=Noto+Sans+KR:wght@400..700&family=Noto+Serif+KR:wght@400..700",
  },
};

function ensureGoogleFontsPreconnect(head: HTMLHeadElement): void {
  if (!head.querySelector('link[data-noto-preconnect="googleapis"]')) {
    const preconnectApi = document.createElement("link");
    preconnectApi.rel = "preconnect";
    preconnectApi.href = "https://fonts.googleapis.com";
    preconnectApi.dataset.notoPreconnect = "googleapis";
    head.appendChild(preconnectApi);
  }

  if (!head.querySelector('link[data-noto-preconnect="gstatic"]')) {
    const preconnectStatic = document.createElement("link");
    preconnectStatic.rel = "preconnect";
    preconnectStatic.href = "https://fonts.gstatic.com";
    preconnectStatic.crossOrigin = "anonymous";
    preconnectStatic.dataset.notoPreconnect = "gstatic";
    head.appendChild(preconnectStatic);
  }
}

/**
 * Synchronizes `<html lang>` and lazily attaches the matching CJK Noto webfont
 * stylesheet for the active UI locale.
 *
 * @param locale - Active BCP-47 locale tag (e.g. `zh-CN`, `zh-TW`, `ja-JP`, `en-US`).
 */
export function syncLocaleTypography(locale?: string): void {
  if (typeof document === "undefined") return;

  const resolvedLocale = (locale || "en-US").trim() || "en-US";
  document.documentElement.lang = resolvedLocale;

  const normalized = resolvedLocale.toLowerCase();
  const baseLang = normalized.split("-")[0];
  const config = CJK_SCRIPT_MAP[normalized] || CJK_SCRIPT_MAP[baseLang];
  if (!config) return;

  const head = document.head;
  if (!head) return;

  const selector = `link[data-noto-cjk="${config.scriptId}"]`;
  if (head.querySelector(selector)) return;

  ensureGoogleFontsPreconnect(head);

  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.crossOrigin = "anonymous";
  stylesheet.href = `https://fonts.googleapis.com/css2?${config.familiesQuery}&display=swap`;
  stylesheet.dataset.notoCjk = config.scriptId;
  head.appendChild(stylesheet);
}

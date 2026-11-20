import type React from "react";

/**
 * Allowed profile sub-route sections that can be forwarded via the `?next=` query parameter
 * when navigating to `/dash` before selecting a profile.
 */
export const ALLOWED_PROFILE_SECTIONS = new Set<string>([
  "stats",
  "logs",
  "rules",
  "filter",
  "settings",
]);

/**
 * Extracts and validates the target profile sub-route section from a URL search string.
 * Rejects unknown values to prevent open-redirect or invalid route navigation, defaulting to `"stats"`.
 *
 * @param search - Location query string (e.g., `location.search`).
 * @returns Validated profile section slug.
 */
export function resolveTargetProfileSection(search: string): string {
  const next = new URLSearchParams(search).get("next");
  return next && ALLOWED_PROFILE_SECTIONS.has(next) ? next : "stats";
}

/**
 * Builds an `onClick` handler for semantic `<a href={href}>` navigation links inside the SPA.
 * Normal left-clicks intercept the browser reload and execute client-side navigation, while
 * modifier clicks (Ctrl/Cmd/Shift/Alt or middle-click) preserve native browser tab/window behavior.
 *
 * @param href - Destination path (or URL with query params).
 * @param navigate - Router navigation callback.
 * @param onAfterNavigate - Optional callback invoked after client-side navigation (e.g. closing mobile drawer).
 * @returns React mouse event handler suitable for `<a>`, Blueprint `<MenuItem>`, or `<AnchorButton>`.
 */
export function createSpaLinkClickHandler(
  href: string,
  navigate: (path: string) => void,
  onAfterNavigate?: () => void
): (e: React.MouseEvent<HTMLElement>) => void {
  return (e: React.MouseEvent<HTMLElement>): void => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) {
      return;
    }
    e.preventDefault();
    navigate(href);
    onAfterNavigate?.();
  };
}

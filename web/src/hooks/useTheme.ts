import { useState, useEffect } from "react";

/** Supported UI theme modes. */
export type ThemeMode = "light" | "dark" | "system";

const THEME_STORAGE_KEY = "obex_theme";

function readInitialTheme(): ThemeMode {
  if (typeof window === "undefined") return "dark";
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }
  } catch {
    // Ignore storage read errors in restricted environments
  }
  return "dark";
}

/**
 * Custom hook to manage the application UI theme (light, dark, system).
 * Persists user preference in localStorage and automatically updates document classes.
 */
export function useTheme(): {
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
} {
  const [theme, setTheme] = useState<ThemeMode>(readInitialTheme);

  useEffect(() => {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Ignore storage write errors in restricted environments
    }

    const root = window.document.documentElement;
    const applyTheme = (resolved: "light" | "dark"): void => {
      root.classList.remove("light", "dark", "bp6-dark");
      root.classList.add(resolved);
      if (resolved === "dark") root.classList.add("bp6-dark");
    };

    if (theme === "system") {
      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      applyTheme(mediaQuery.matches ? "dark" : "light");

      const handleMediaChange = (event: MediaQueryListEvent): void => {
        applyTheme(event.matches ? "dark" : "light");
      };
      mediaQuery.addEventListener("change", handleMediaChange);
      return () => {
        mediaQuery.removeEventListener("change", handleMediaChange);
      };
    }

    applyTheme(theme);
    return undefined;
  }, [theme]);

  return { theme, setTheme };
}

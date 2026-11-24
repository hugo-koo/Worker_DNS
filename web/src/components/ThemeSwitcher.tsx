import React from "react";
import { Button } from "@blueprintjs/core";
import { useTranslation } from "react-i18next";
import { Sun, Moon, Monitor } from "lucide-react";
import type { ThemeMode } from "../hooks/useTheme";

/**
 * Properties for the ThemeSwitcher component.
 */
export interface ThemeSwitcherProps {
  /** Active UI theme mode. */
  theme: ThemeMode;
  /** Callback to update the active UI theme mode. */
  setTheme: (theme: ThemeMode) => void;
}

const THEME_OPTIONS: ReadonlyArray<{
  mode: ThemeMode;
  icon: React.ReactElement;
  labelKey: string;
  defaultLabel: string;
}> = [
  { mode: "light", icon: <Sun size={14} />, labelKey: "theme.light", defaultLabel: "Light" },
  { mode: "dark", icon: <Moon size={14} />, labelKey: "theme.dark", defaultLabel: "Dark" },
  { mode: "system", icon: <Monitor size={14} />, labelKey: "theme.system", defaultLabel: "System" },
];

/**
 * ThemeSwitcher renders a compact three-state (Light / Dark / System) segmented button group.
 *
 * @param props - Component props containing active theme state and setter.
 * @returns React element representing the theme toggle button group.
 */
export const ThemeSwitcher: React.FC<ThemeSwitcherProps> = ({
  theme,
  setTheme,
}): React.ReactElement => {
  const { t } = useTranslation();

  return (
    <div
      className="flex items-center gap-1 bg-gray-100/80 dark:bg-gray-800/70 p-1 rounded-lg"
      role="group"
      aria-label={t("theme.system", "Theme")}
    >
      {THEME_OPTIONS.map(({ mode, icon, labelKey, defaultLabel }) => {
        const label = t(labelKey, defaultLabel);
        return (
          <Button
            key={mode}
            variant="minimal"
            icon={icon}
            size="small"
            active={theme === mode}
            title={label}
            aria-label={label}
            aria-pressed={theme === mode}
            onClick={() => setTheme(mode)}
          />
        );
      })}
    </div>
  );
};

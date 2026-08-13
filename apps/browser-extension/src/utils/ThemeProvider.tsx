import { createContext, useContext, useEffect } from "react";

import usePluginSettings from "./settings";

type Theme = "dark" | "light" | "system";

interface ThemeProviderProps {
  children: React.ReactNode;
}

interface ThemeProviderState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

const initialState: ThemeProviderState = {
  theme: "system",
  setTheme: () => null,
};

const ThemeProviderContext = createContext<ThemeProviderState>(initialState);

export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  const { settings, setSettings } = usePluginSettings();
  const theme = settings.theme;

  useEffect(() => {
    const root = window.document.documentElement;

    const updateIcon = (useDarkModeIcons: boolean) => {
      const iconSuffix = useDarkModeIcons ? "-darkmode.png" : ".png";

      const iconPaths = {
        "16": `logo-16${iconSuffix}`,
        "48": `logo-48${iconSuffix}`,
        "128": `logo-128${iconSuffix}`,
      };
      chrome.action.setIcon({ path: iconPaths });
      // Notify background to keep context-menu icons in sync (mirrors toolbar's theme_icons behavior
      // so the right-click menu icon stays visible on dark backgrounds).
      chrome.runtime
        .sendMessage({
          type: "KARAKEEP_THEME_UPDATE",
          isDark: useDarkModeIcons,
        })
        .catch(() => {
          // background may not be listening (e.g. during dev) - ignore
        });
    };

    const applyThemeAndIcon = () => {
      root.classList.remove("light", "dark");

      let currentTheme: "light" | "dark";
      if (theme === "system") {
        currentTheme = window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
      } else {
        currentTheme = theme;
      }

      root.classList.add(currentTheme);
      updateIcon(currentTheme === "dark");
    };

    applyThemeAndIcon();

    // When theme is "system", keep icons in sync if OS preference changes while popup is open.
    if (theme === "system") {
      const mql = window.matchMedia("(prefers-color-scheme: dark)");
      const handler = () => applyThemeAndIcon();
      // `addEventListener` is modern, fallback to `addListener` for older browsers
      if (mql.addEventListener) {
        mql.addEventListener("change", handler);
        return () => mql.removeEventListener("change", handler);
      } else {
        // @ts-expect-error - deprecated but still present in some browsers
        (
          mql as unknown as { addListener: (cb: () => void) => void }
        ).addListener(handler);
        return () => {
          // @ts-expect-error - deprecated but still present in some browsers
          (
            mql as unknown as { removeListener: (cb: () => void) => void }
          ).removeListener(handler);
        };
      }
    }
  }, [theme]);

  const value = {
    theme,
    setTheme: (newTheme: Theme) => {
      setSettings((s) => ({ ...s, theme: newTheme }));
    },
  };

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

export const useTheme = () => {
  const context = useContext(ThemeProviderContext);

  if (context === undefined)
    throw new Error("useTheme must be used within a ThemeProvider");

  return context;
};

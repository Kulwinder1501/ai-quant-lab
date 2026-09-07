"use client";

import { useEffect, type ReactNode } from "react";
import { type AppTheme, useAppStore } from "../../stores/app-store";
import { THEME_STORAGE_KEY } from "./theme-storage";

function isAppTheme(value: string | null): value is AppTheme {
  return value === "light" || value === "dark";
}

export function applyTheme(theme: AppTheme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    let savedTheme: AppTheme = "dark";

    try {
      const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
      if (isAppTheme(storedTheme)) savedTheme = storedTheme;
    } catch {
      // Storage can be unavailable in private or locked-down browser contexts.
      // The app deliberately falls back to its existing dark appearance.
    }

    applyTheme(savedTheme);
    useAppStore.getState().setTheme(savedTheme);

    const unsubscribe = useAppStore.subscribe((state, previousState) => {
      if (state.theme === previousState.theme) return;

      applyTheme(state.theme);
      try {
        window.localStorage.setItem(THEME_STORAGE_KEY, state.theme);
      } catch {
        // Applying the theme must still work when persistence is unavailable.
      }
    });

    const syncThemeAcrossTabs = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) return;
      const nextTheme: AppTheme = isAppTheme(event.newValue) ? event.newValue : "dark";
      applyTheme(nextTheme);
      useAppStore.getState().setTheme(nextTheme);
    };

    window.addEventListener("storage", syncThemeAcrossTabs);

    return () => {
      unsubscribe();
      window.removeEventListener("storage", syncThemeAcrossTabs);
    };
  }, []);

  return children;
}

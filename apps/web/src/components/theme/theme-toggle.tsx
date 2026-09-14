"use client";

import { Moon, Sun } from "lucide-react";
import { useAppStore } from "../../stores/app-store";
import { classNames } from "../ui/class-names";

interface ThemeToggleProps {
  className?: string;
}

export function ThemeToggle({ className }: ThemeToggleProps) {
  const theme = useAppStore((state) => state.theme);
  const setTheme = useAppStore((state) => state.setTheme);
  const isLight = theme === "light";

  return (
    <div className={classNames("flex items-center justify-between gap-4", className)}>
      <div>
        <p className="text-sm font-semibold text-slate-200">Appearance</p>
        <p className="mt-1 text-xs leading-relaxed text-slate-400">
          {isLight ? "CoinDCX-inspired light interface" : "Original AI Quant Lab dark interface"}
        </p>
      </div>

      <button
        type="button"
        role="switch"
        aria-checked={isLight}
        aria-label={isLight ? "Switch to dark theme" : "Switch to light theme"}
        title={isLight ? "Switch to dark theme" : "Switch to light theme"}
        onClick={() => setTheme(isLight ? "dark" : "light")}
        className="group relative inline-flex h-11 w-[5.5rem] shrink-0 items-center rounded-full border border-white/10 bg-slate-900 p-1 shadow-inner transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
      >
        <span className="absolute left-2 text-cyan-300" aria-hidden="true">
          <Moon className="size-4" />
        </span>
        <span className="absolute right-2 text-amber-300" aria-hidden="true">
          <Sun className="size-4" />
        </span>
        <span
          aria-hidden="true"
          className={classNames(
            "relative z-10 flex size-8 items-center justify-center rounded-full bg-static-white text-static-navy shadow-md transition-transform duration-300 motion-reduce:transition-none",
            isLight ? "translate-x-11" : "translate-x-0",
          )}
        >
          {isLight ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </span>
      </button>
    </div>
  );
}

"use client";

import { Menu } from "lucide-react";

interface TopBarProps {
  onOpenMobileSidebar: () => void;
}

export function TopBar({ onOpenMobileSidebar }: TopBarProps) {
  return (
    <div className="md:hidden sticky top-0 z-40 flex items-center gap-x-4 border-b border-white/10 bg-slate-950/45 px-4 h-16 backdrop-blur-xl shadow-sm sm:gap-x-6 sm:px-6 lg:px-8">
      <button
        type="button"
        className="-m-2.5 p-2.5 text-slate-300 hover:text-white transition-colors"
        onClick={onOpenMobileSidebar}
      >
        <span className="sr-only">Open sidebar</span>
        <Menu className="h-6 w-6" aria-hidden="true" />
      </button>
      <div className="flex-1 text-sm font-semibold leading-6 text-white">
        AI Quant Lab
      </div>
    </div>
  );
}

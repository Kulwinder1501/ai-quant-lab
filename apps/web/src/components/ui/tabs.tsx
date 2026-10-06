"use client";

import React, { ReactNode } from 'react';
import { classNames } from './class-names';

interface Tab {
  id: string;
  label: string;
  icon?: ReactNode;
}

interface TabsProps {
  tabs: Tab[];
  activeId: string;
  onChange: (id: string) => void;
  className?: string;
}

export function Tabs({ tabs, activeId, onChange, className }: TabsProps) {
  return (
    <div aria-label="View mode" className={classNames("flex border-b border-slate-800", className)} role="tablist">
      {tabs.map((tab) => (
        <button
          aria-selected={activeId === tab.id}
          key={tab.id}
          onClick={() => onChange(tab.id)}
          role="tab"
          type="button"
          className={classNames(
            "flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors border-b-2 -mb-[1px]",
            activeId === tab.id
              ? "text-white border-cyan-400"
              : "text-slate-400 border-transparent hover:text-slate-200 hover:border-slate-700"
          )}
        >
          {tab.icon && <span className="flex-shrink-0">{tab.icon}</span>}
          {tab.label}
        </button>
      ))}
    </div>
  );
}

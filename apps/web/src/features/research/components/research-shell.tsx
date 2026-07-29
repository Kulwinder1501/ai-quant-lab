"use client";

import type { ReactNode } from "react";
import { AuroraBackdrop, ResearchGrid } from "../../../components/ui/aurora-backdrop";
import { ScrollProgress } from "../../../components/ui/scroll-progress";
import { Reveal } from "../../../components/ui/reveal";
import { classNames } from "../../../components/ui/class-names";
import { ResearchNavigation, type ResearchView } from "./research-navigation";

interface ResearchShellProps {
  activeView: ResearchView;
  eyebrow: string;
  title: string;
  description: string;
  connectionLabel: string;
  unavailable?: boolean;
  children: ReactNode;
}

export function ResearchShell({
  activeView,
  eyebrow,
  title,
  description,
  connectionLabel,
  unavailable = false,
  children,
}: ResearchShellProps) {
  return (
    <div className="relative isolate min-h-screen bg-slate-950 flex flex-col lg:flex-row">
      <ScrollProgress />
      <AuroraBackdrop />
      <ResearchGrid />

      {/* Sidebar Navigation */}
      <aside className="relative z-20 w-full lg:w-72 shrink-0 border-b lg:border-b-0 lg:border-r border-white/10 bg-slate-950/45 backdrop-blur-xl lg:h-screen lg:sticky lg:top-0 px-4 py-6 sm:px-6 lg:px-6 lg:py-8 overflow-y-auto">
        <div className="mb-8 flex items-center gap-3 px-2">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-400 to-blue-600 shadow-lg shadow-cyan-500/20">
            <svg className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <div>
            <h2 className="text-lg font-bold text-white tracking-tight">AI Quant Lab</h2>
            <p className="text-xs text-cyan-400 font-medium tracking-wide">TRADING TERMINAL</p>
          </div>
        </div>
        <ResearchNavigation activeView={activeView} />
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 relative z-10 w-full min-w-0 px-4 py-6 sm:px-6 lg:px-12 lg:py-12 overflow-x-hidden">
        <div className="mx-auto max-w-6xl">
          <Reveal>
            <header className="flex flex-wrap items-start justify-between gap-6">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-cyan-200">{eyebrow}</p>
                <h1 className="mt-2 text-3xl font-extrabold tracking-tight text-white sm:text-4xl lg:text-5xl">{title}</h1>
                <p className="mt-4 max-w-2xl text-base leading-relaxed text-slate-300">{description}</p>
              </div>
              <div
                aria-live="polite"
                className={classNames(
                  "rounded-full border px-4 py-1.5 text-xs font-semibold shadow-lg backdrop-blur-xl transition-colors",
                  unavailable
                    ? "border-rose-300/35 bg-rose-300/10 text-rose-200"
                    : "border-white/10 bg-white/5 text-slate-200",
                )}
              >
                {connectionLabel}
              </div>
            </header>
          </Reveal>

          <Reveal delayMs={90}>
            <div className="mt-10">{children}</div>
          </Reveal>
        </div>
      </main>
    </div>
  );
}

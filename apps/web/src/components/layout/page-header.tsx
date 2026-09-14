"use client";

import { type ReactNode } from "react";
import { classNames } from "../ui/class-names";
import { Reveal } from "../ui/reveal";

interface PageHeaderProps {
  eyebrow: string;
  title: string;
  description: string;
  connectionLabel?: string;
  unavailable?: boolean;
  actions?: ReactNode;
}

export function PageHeader({
  eyebrow,
  title,
  description,
  connectionLabel,
  unavailable = false,
  actions,
}: PageHeaderProps) {
  return (
    <Reveal>
      <header className="flex flex-wrap items-start justify-between gap-6">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-cyan-200">{eyebrow}</p>
          <h1 className="mt-2 text-3xl font-extrabold tracking-tight text-white sm:text-4xl lg:text-5xl">{title}</h1>
          <p className="mt-4 max-w-2xl text-base leading-relaxed text-slate-300">{description}</p>
        </div>
        <div className="flex items-center gap-4">
          {actions && <div>{actions}</div>}
          {connectionLabel && (
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
          )}
        </div>
      </header>
    </Reveal>
  );
}

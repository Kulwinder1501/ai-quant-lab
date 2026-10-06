import type { HTMLAttributes, ReactNode } from "react";
import { classNames } from "./class-names";

interface GlassPanelProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function GlassPanel({ children, className, ...props }: GlassPanelProps) {
  return (
    <div
      className={classNames(
        "rounded-2xl border border-slate-700/70 bg-slate-950/45 shadow-[0_18px_60px_-32px_rgb(var(--panel-shadow)/0.55)] backdrop-blur-xl",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function InteractiveGlassCard({ children, className, ...props }: GlassPanelProps) {
  return (
    <GlassPanel
      className={classNames(
        "transition duration-300 ease-out hover:-translate-y-1 hover:border-cyan-300/30 hover:bg-slate-900/80 hover:shadow-[0_24px_70px_-34px_rgb(var(--panel-shadow)/0.42)] motion-reduce:transform-none motion-reduce:transition-none",
        className,
      )}
      {...props}
    >
      {children}
    </GlassPanel>
  );
}

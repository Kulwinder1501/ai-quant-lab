import React, { memo } from "react";
import { classNames } from "./class-names";

interface AuroraBackdropProps {
  className?: string;
}

/**
 * Source-owned visual primitives. They use only CSS gradients so the app stays
 * dependency-free while retaining a subtle aurora/grid/glass research surface.
 */
export const AuroraBackdrop = memo(function AuroraBackdrop({ className }: AuroraBackdropProps) {
  return (
    <div aria-hidden="true" className={classNames("pointer-events-none absolute inset-0 overflow-hidden transform-gpu", className)}>
      <div className="absolute -left-40 -top-48 h-[34rem] w-[34rem] rounded-full bg-cyan-400/10 blur-3xl opacity-75 will-change-[opacity]" />
      <div className="absolute -right-48 top-20 h-[30rem] w-[30rem] rounded-full bg-indigo-500/10 blur-3xl opacity-75 will-change-[opacity]" />
      <div className="absolute bottom-[-16rem] left-1/3 h-[28rem] w-[28rem] rounded-full bg-emerald-400/10 blur-3xl opacity-75 will-change-[opacity]" />
    </div>
  );
});

export const ResearchGrid = memo(function ResearchGrid({ className }: AuroraBackdropProps) {
  return (
    <div
      aria-hidden="true"
      className={classNames("pointer-events-none absolute inset-0 opacity-40 [mask-image:linear-gradient(to_bottom,black,transparent_72%)] transform-gpu", className)}
      style={{
        backgroundImage: "linear-gradient(rgb(var(--research-grid) / 0.07) 1px, transparent 1px), linear-gradient(90deg, rgb(var(--research-grid) / 0.07) 1px, transparent 1px)",
        backgroundSize: "48px 48px",
      }}
    />
  );
});

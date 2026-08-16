import React from "react";

function cn(...classes: (string | undefined | null | false)[]) {
  return classes.filter(Boolean).join(" ");
}

/**
 * Fixed heights and delays rather than random ones.
 *
 * Randomising during render reshuffles every bar on each re-render, which reads as flicker
 * instead of a loading state — the same reason `SkeletonChart` pins its bars. The alternating
 * tone is what makes the row read as a market rather than as a generic equaliser.
 */
const CANDLES = [
  { height: 38, delay: 0, up: true },
  { height: 64, delay: 120, up: true },
  { height: 30, delay: 240, up: false },
  { height: 82, delay: 360, up: true },
  { height: 46, delay: 480, up: false },
  { height: 70, delay: 600, up: true },
  { height: 34, delay: 720, up: false },
];

export interface MarketLoaderProps extends React.HTMLAttributes<HTMLDivElement> {
  /** What is being waited on. Written as a statement, not "Loading…". */
  label: string;
  /** Optional second line for why it is slow, or what happens next. */
  sublabel?: string;
  /** `sm` suits an inline button or a table cell; `md` a panel that owns its space. */
  size?: "sm" | "md";
}

/**
 * The shared waiting state for anything that reads from the API.
 *
 * All motion is CSS. There is no state and no timer, so nothing can fire after unmount and
 * nothing re-renders while it waits — the defect the price-tick flashes were rewritten to avoid.
 * Every animation is disabled under `prefers-reduced-motion`, leaving a static row of bars that
 * still reads as a placeholder.
 */
export function MarketLoader({
  label,
  sublabel,
  size = "md",
  className,
  ...props
}: MarketLoaderProps) {
  const barWidth = size === "sm" ? "w-1.5" : "w-2.5";
  const trackHeight = size === "sm" ? "h-8" : "h-16";

  return (
    <div
      className={cn("flex flex-col items-center justify-center gap-3 py-6", className)}
      role="status"
      aria-live="polite"
      {...props}
    >
      <div className={cn("relative flex items-end gap-1.5 overflow-hidden", trackHeight)}>
        {CANDLES.map((candle) => (
          <div
            key={candle.delay}
            className={cn(
              barWidth,
              "origin-bottom rounded-sm animate-candle-breathe motion-reduce:animate-none",
              candle.up
                ? "bg-gradient-to-t from-emerald-500/40 to-emerald-300"
                : "bg-gradient-to-t from-rose-500/40 to-rose-300",
            )}
            style={{ height: `${candle.height}%`, animationDelay: `${candle.delay}ms` }}
          />
        ))}
        {/* The tape being read across the book. Purely decorative, so it is hidden from
            assistive technology and stopped when motion is reduced. */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 w-8 bg-gradient-to-r from-transparent via-cyan-300/25 to-transparent animate-tape-sweep motion-reduce:hidden"
        />
      </div>

      <div className="text-center">
        <p className="flex items-center justify-center gap-2 text-xs font-black uppercase tracking-widest text-slate-300">
          <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 animate-pulse motion-reduce:animate-none" />
          {label}
        </p>
        {sublabel && (
          <p className="mt-1 text-[11px] font-normal text-slate-500">{sublabel}</p>
        )}
      </div>
    </div>
  );
}

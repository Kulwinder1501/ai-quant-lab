import React from "react";

function cn(...classes: (string | undefined | null | false)[]) {
  return classes.filter(Boolean).join(" ");
}

export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-slate-800/60", className)}
      {...props}
    />
  );
}

export function SkeletonLine({
  className,
  width = "100%",
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { width?: string | number }) {
  return (
    <Skeleton
      className={cn("h-4", className)}
      style={{ width, ...props.style }}
      {...props}
    />
  );
}

export function SkeletonCard({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-slate-700/40 bg-slate-950/30 p-6 backdrop-blur-sm",
        className
      )}
      {...props}
    >
      <SkeletonLine className="mb-4 w-1/3" />
      <SkeletonLine className="mb-2 w-full" />
      <SkeletonLine className="mb-2 w-5/6" />
      <SkeletonLine className="w-4/6" />
    </div>
  );
}

export function SkeletonTable({
  className,
  rows = 5,
  cols = 4,
  columns,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { rows?: number; cols?: number; columns?: number }) {
  const numCols = columns ?? cols;
  return (
    <div
      className={cn(
        "w-full overflow-hidden rounded-2xl border border-slate-700/40 bg-slate-950/30 backdrop-blur-sm",
        className
      )}
      {...props}
    >
      <div className="border-b border-slate-800/50 bg-slate-900/40 p-4 flex gap-4">
        {Array.from({ length: numCols }).map((_, i) => (
          <Skeleton key={`header-${i}`} className="h-5 flex-1 bg-slate-700/50" />
        ))}
      </div>
      <div className="flex flex-col">
        {Array.from({ length: rows }).map((_, r) => (
          <div
            key={`row-${r}`}
            className="flex gap-4 border-b border-slate-800/30 p-4 last:border-0"
          >
            {Array.from({ length: numCols }).map((_, c) => (
              <Skeleton key={`cell-${r}-${c}`} className="h-4 flex-1" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function SkeletonStatGrid({
  className,
  columns = 4,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { columns?: number }) {
  const gridColsClass =
    columns === 2
      ? "grid-cols-1 sm:grid-cols-2"
      : columns === 3
      ? "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
      : columns === 6
      ? "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6"
      : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4";

  return (
    <div
      className={cn("grid gap-6", gridColsClass, className)}
      {...props}
    >
      {Array.from({ length: columns }).map((_, i) => (
        <div
          key={i}
          className="flex flex-col justify-center rounded-2xl border border-slate-700/40 bg-slate-950/30 p-6 backdrop-blur-sm shadow-[0_4px_20px_-10px_rgba(8,145,178,0.1)]"
        >
          <div className="flex items-center justify-between mb-4">
            <Skeleton className="h-5 w-24 bg-slate-700/50" />
            <Skeleton className="h-8 w-8 rounded-full bg-slate-700/50" />
          </div>
          <Skeleton className="h-8 w-32 mb-2 bg-slate-700/50" />
          <Skeleton className="h-4 w-40" />
        </div>
      ))}
    </div>
  );
}

// Fixed rather than random: randomising during render reshuffles every bar on each
// re-render, which reads as flicker instead of a loading placeholder.
const chartSkeletonBars = [
  { height: 46, opacity: 0.62 }, { height: 78, opacity: 0.85 },
  { height: 34, opacity: 0.55 }, { height: 91, opacity: 0.95 },
  { height: 58, opacity: 0.7 }, { height: 25, opacity: 0.5 },
  { height: 83, opacity: 0.88 }, { height: 67, opacity: 0.76 },
  { height: 40, opacity: 0.58 }, { height: 72, opacity: 0.8 },
  { height: 52, opacity: 0.66 }, { height: 88, opacity: 0.92 },
];

export function SkeletonChart({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex flex-col rounded-2xl border border-slate-700/40 bg-slate-950/30 p-6 backdrop-blur-sm",
        className
      )}
      {...props}
    >
      <div className="mb-6 flex items-center justify-between">
        <Skeleton className="h-6 w-1/4 bg-slate-700/50" />
        <Skeleton className="h-8 w-32 rounded-lg bg-slate-700/50" />
      </div>
      <div className="flex-1 min-h-[300px] flex items-end gap-2">
        {chartSkeletonBars.map((bar, i) => (
          <Skeleton
            key={i}
            className="flex-1 bg-slate-700/40 rounded-t-md"
            style={{ height: `${bar.height}%`, opacity: bar.opacity }}
          />
        ))}
      </div>
    </div>
  );
}

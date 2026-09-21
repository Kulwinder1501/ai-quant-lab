"use client";

import React from "react";
import type { IndicatorPoint } from "../../charts/domain";

interface LegendEntry {
  key: string;
  label: string;
  meaning: string;
  swatchClassName: string;
  /** Present only for count-based entries (FVG/OB); omitted for the always-on line indicators. */
  count?: number;
}

/**
 * Explains what each overlay on the "Indicators" chart mode actually is, since a bare set of
 * colored lines and boxes means nothing without a key -- this is the direct answer to "I can't
 * understand indicators, show it nicely".
 *
 * FVG/OB get a live count from the same payload the chart draws from, so "12 active" tells you
 * whether the zone boxes are worth looking for before you go hunting on the chart itself.
 */
export function ChartLegend({ indicators, timeframe }: { indicators?: Record<string, IndicatorPoint[]>; timeframe: string }) {
  const fvgCount = indicators?.FVG?.length ?? 0;
  const obCount = indicators?.ORDER_BLOCK?.length ?? 0;

  const entries: LegendEntry[] = [
    {
      key: "sma",
      label: "SMA",
      meaning: "Simple moving average of price",
      swatchClassName: "bg-cyan-400",
    },
    {
      key: "bb",
      label: "Bollinger Bands",
      meaning: "Volatility band around the SMA (upper/mid/lower)",
      swatchClassName: "bg-blue-400",
    },
    {
      key: "rsi",
      label: "RSI",
      meaning: "Momentum, 0-100; dashed lines mark 30/70",
      swatchClassName: "bg-amber-400",
    },
    {
      key: "fvg",
      label: "FVG",
      meaning: "Fair Value Gap — a 3-candle price imbalance, still unfilled",
      swatchClassName: "bg-emerald-500/70 ring-1 ring-emerald-400",
      count: fvgCount,
    },
    {
      key: "ob",
      label: "Order Block",
      meaning: "Last opposing candle right before a strong move away from it",
      swatchClassName: "bg-sky-500/70 ring-1 ring-sky-400",
      count: obCount,
    },
  ];

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-slate-700/40 bg-slate-950/40 px-3 py-2 text-[10px] text-slate-400">
      {entries.map((entry) => (
        <div key={entry.key} className="flex items-center gap-1.5" title={entry.meaning}>
          <span className={`h-2.5 w-2.5 rounded-sm ${entry.swatchClassName}`} />
          <span className="font-semibold text-slate-300">{entry.label}</span>
          {entry.count !== undefined && (
            <span className={entry.count > 0 ? "text-slate-400" : "text-slate-600"}>
              · {entry.count} active
            </span>
          )}
          <span className="hidden text-slate-500 lg:inline">— {entry.meaning}</span>
        </div>
      ))}
      {timeframe !== "5m" && timeframe !== "15m" && (
        <span className="text-slate-600">
          FVG/OB are only computed at 5m/15m — switch timeframe to see them.
        </span>
      )}
      {(timeframe === "5m" || timeframe === "15m") && fvgCount === 0 && obCount === 0 && (
        <span className="text-slate-600">No active FVG/OB right now.</span>
      )}
    </div>
  );
}

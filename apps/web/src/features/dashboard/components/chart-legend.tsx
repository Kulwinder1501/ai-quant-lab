"use client";

import React from "react";
import type { IndicatorPoint } from "../../charts/domain";

interface SimpleLegendEntry {
  key: string;
  label: string;
  meaning: string;
  swatchClassName: string;
}

interface DirectionalLegendEntry {
  key: string;
  label: string;
  meaning: string;
  /** Colors must match zone-box-primitive.ts's fillColor/borderColor exactly, or the legend lies. */
  bullishSwatchClassName: string;
  bearishSwatchClassName: string;
  bullishCount: number;
  bearishCount: number;
}

function countByType(points: IndicatorPoint[] | undefined): { bullish: number; bearish: number } {
  let bullish = 0;
  let bearish = 0;
  for (const point of points ?? []) {
    if (point.type === "BULLISH") bullish += 1;
    else if (point.type === "BEARISH") bearish += 1;
  }
  return { bullish, bearish };
}

/**
 * Explains what each overlay on the "Indicators" chart mode actually is, since a bare set of
 * colored lines and boxes means nothing without a key -- this is the direct answer to "I can't
 * understand indicators, show it nicely".
 *
 * FVG and Order Block are drawn in two colors each on the chart (bullish vs bearish -- see
 * `zone-box-primitive.ts`'s fillColor/borderColor), so a legend with one swatch per zone type
 * silently failed to explain half of what's on screen: an orange or rose box had nothing in the
 * key to match it to. Each directional entry now shows both swatches with their own live count.
 */
export function ChartLegend({ indicators, timeframe }: { indicators?: Record<string, IndicatorPoint[]>; timeframe: string }) {
  const fvg = countByType(indicators?.FVG);
  const ob = countByType(indicators?.ORDER_BLOCK);
  const fvgCount = fvg.bullish + fvg.bearish;
  const obCount = ob.bullish + ob.bearish;

  const simpleEntries: SimpleLegendEntry[] = [
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
  ];

  const directionalEntries: DirectionalLegendEntry[] = [
    {
      key: "fvg",
      label: "FVG",
      meaning: "Fair Value Gap — a 3-candle price imbalance, still unfilled",
      bullishSwatchClassName: "bg-emerald-500/70 ring-1 ring-emerald-400",
      bearishSwatchClassName: "bg-rose-500/70 ring-1 ring-rose-400",
      bullishCount: fvg.bullish,
      bearishCount: fvg.bearish,
    },
    {
      key: "ob",
      label: "Order Block",
      meaning: "Last opposing candle right before a strong move away from it",
      bullishSwatchClassName: "bg-sky-500/70 ring-1 ring-sky-400",
      // orange-400 (#fb923c / rgb(251,146,60)), matching zone-box-primitive's fillColor exactly.
      bearishSwatchClassName: "bg-orange-400/70 ring-1 ring-orange-300",
      bullishCount: ob.bullish,
      bearishCount: ob.bearish,
    },
  ];

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-slate-700/40 bg-slate-950/40 px-3 py-2 text-[10px] text-slate-400">
      {simpleEntries.map((entry) => (
        <div key={entry.key} className="flex items-center gap-1.5" title={entry.meaning}>
          <span className={`h-2.5 w-2.5 rounded-sm ${entry.swatchClassName}`} />
          <span className="font-semibold text-slate-300">{entry.label}</span>
          <span className="hidden text-slate-500 lg:inline">— {entry.meaning}</span>
        </div>
      ))}
      {directionalEntries.map((entry) => (
        <div key={entry.key} className="flex items-center gap-1.5" title={entry.meaning}>
          <span className="font-semibold text-slate-300">{entry.label}</span>
          <span className="flex items-center gap-0.5">
            <span className={`h-2.5 w-2.5 rounded-sm ${entry.bullishSwatchClassName}`} />
            <span className="text-slate-400">{entry.bullishCount} bull</span>
          </span>
          <span className="flex items-center gap-0.5">
            <span className={`h-2.5 w-2.5 rounded-sm ${entry.bearishSwatchClassName}`} />
            <span className="text-slate-400">{entry.bearishCount} bear</span>
          </span>
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

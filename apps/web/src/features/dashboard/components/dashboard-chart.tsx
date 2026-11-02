"use client";

import React, { useEffect, useMemo, useState, useCallback, memo } from "react";
import { createPortal } from "react-dom";
import { Maximize2, Minimize2 } from "lucide-react";
import { GlassPanel } from "../../../components/ui/glass-panel";
import { InteractiveChart } from "../../charts/components/interactive-chart";
import { ChartLegend } from "./chart-legend";
import { postResearchJson } from "../../research/api";
import type { ChartPayload } from "../../charts/domain";
import { formatIstDate } from "../../../lib/ist-date";
import { chartLevelsFromZones, formatCalendarDate, sheetFreshness, type ChartLevel } from "../../daily-levels/levels-view";
import { isLevelsUnderlying, useDailyLevels } from "../../daily-levels/use-daily-levels";

const TIMEFRAMES = ["1m", "5m", "15m"] as const;
/**
 * "Levels" is the default: candles and the daily support/resistance lines, nothing else. The other three are the older, busier views and
 * stay one click away.
 */
const MODES = ["Levels", "Clean", "Indicators", "Patterns"] as const;
const NO_LEVELS: ChartLevel[] = [];

type Timeframe = (typeof TIMEFRAMES)[number];
type ChartMode = (typeof MODES)[number];

export const DashboardChart = memo(function DashboardChart({ symbol }: { symbol: string }) {
  const [chartData, setChartData] = useState<ChartPayload | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [timeframe, setTimeframe] = useState<Timeframe>("15m");
  const [mode, setMode] = useState<ChartMode>("Levels");
  const [isExpanded, setIsExpanded] = useState(false);

  /*
   * Same Escape-to-close + scroll-lock pattern as components/ui/modal.tsx, inlined rather than
   * reused: Modal renders a centered, width-capped dialog with its own title bar, which is the
   * wrong shape here -- the whole point of expanding is to give the chart itself the full
   * viewport, not a bigger box around it.
   */
  useEffect(() => {
    if (!isExpanded) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsExpanded(false);
    };
    document.addEventListener("keydown", handleEscape);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleEscape);
      document.body.style.overflow = "unset";
    };
  }, [isExpanded]);

  const loadChartData = useCallback(async (signal?: AbortSignal) => {
    try {
      setLoading(true);
      const res = await postResearchJson("/charts/data", {
        symbol: symbol.trim().toUpperCase(),
        timeframe: timeframe,
        indicators: mode === "Clean" || mode === "Levels" ? [] : ["SMA", "BB", "RSI"],
        includePatterns: mode === "Patterns" || mode === "Indicators", // Include patterns in Indicators and Patterns modes
      }, signal) as { data: ChartPayload };
      setChartData(res.data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [symbol, timeframe, mode]);

  useEffect(() => {
    const controller = new AbortController();
    const initialLoad = setTimeout(() => {
      void loadChartData(controller.signal);
    }, 0);
    
    // Refresh chart data every 60s
    const interval = setInterval(() => {
      void loadChartData(controller.signal);
    }, 60000);
    
    return () => {
      controller.abort();
      clearTimeout(initialLoad);
      clearInterval(interval);
    };
  }, [loadChartData]);

  // The sheet exists for the two indices only; the hook stays idle for any other symbol and outside Levels mode.
  const levelsUnderlying = isLevelsUnderlying(symbol.trim().toUpperCase()) ? (symbol.trim().toUpperCase() as "NIFTY50" | "BANKNIFTY") : null;
  const sheet = useDailyLevels(mode === "Levels" ? levelsUnderlying : null);

  // The lines, and the sentence under the chart saying what they are (or why there are none). A sheet that is not for today or the next
  // session is not drawn: yesterday's lines on today's chart would look current.
  const levelsView = useMemo<{ lines: ChartLevel[]; note: string }>(() => {
    if (mode !== "Levels") return { lines: NO_LEVELS, note: "" };
    if (levelsUnderlying === null) return { lines: NO_LEVELS, note: `No levels for ${symbol}: the sheet is built for NIFTY50 and BANKNIFTY.` };
    if (sheet.status === "loading" || sheet.status === "idle") return { lines: NO_LEVELS, note: "Loading the levels..." };
    if (sheet.status === "error") return { lines: NO_LEVELS, note: `Levels unavailable: ${sheet.message}` };
    if (!sheet.body.available) return { lines: NO_LEVELS, note: sheet.body.reason };
    const freshness = sheetFreshness(sheet.body.sessionDate, formatIstDate(new Date()));
    if (freshness.state === "OLD") return { lines: NO_LEVELS, note: `No levels drawn: the latest sheet is for ${formatCalendarDate(sheet.body.sessionDate)}, not today.` };
    const last = chartData?.candles.at(-1)?.close ?? Number.NaN;
    return {
      lines: chartLevelsFromZones(sheet.body.zones, last),
      note: `Levels for ${formatCalendarDate(sheet.body.sessionDate)}, built from the ${formatCalendarDate(sheet.body.referenceDate)} close. Solid line: two or more kinds of source agree; dashed: one. Context, not a signal.`,
    };
  }, [mode, levelsUnderlying, symbol, sheet, chartData]);

  const panel = (
    /* Colours come from the themed slate/cyan scales, which are wired to the
       --color-* variables and so follow the app's data-theme in both modes. */
    <GlassPanel className="flex w-full h-full min-h-0 flex-col overflow-hidden rounded-xl p-0">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-slate-700/50 px-3 py-2 text-xs font-semibold text-slate-400">
        <div className="flex items-center gap-2 tracking-wide">
          <span className="hidden sm:inline text-[10px] uppercase tracking-widest">Live Chart</span>
          <span className="font-bold text-slate-100">{symbol}</span>
        </div>

        <div className="flex items-center overflow-hidden rounded-md border border-slate-700/60 bg-slate-950/60">
          {TIMEFRAMES.map(tf => (
            <button
              key={tf}
              onClick={() => setTimeframe(tf)}
              className={`px-2.5 py-1 text-[10px] font-bold uppercase transition ${timeframe === tf ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-500 hover:text-slate-300'}`}
            >
              {tf}
            </button>
          ))}
        </div>

        <div className="hidden sm:flex items-center overflow-hidden rounded-md border border-slate-700/60 bg-slate-950/60">
          {MODES.map(m => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-2.5 py-1 text-[10px] font-bold uppercase transition ${mode === m ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-500 hover:text-slate-300'}`}
            >
              {m}
            </button>
          ))}
        </div>

        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-300">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
          Live
        </span>

        <button
          type="button"
          onClick={() => setIsExpanded((prev) => !prev)}
          title={isExpanded ? "Minimize (Esc)" : "Expand to full page"}
          aria-label={isExpanded ? "Minimize chart" : "Expand chart to full page"}
          className="ml-auto flex items-center justify-center rounded-md border border-slate-700/60 bg-slate-950/60 p-1.5 text-slate-400 transition hover:text-cyan-300"
        >
          {isExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        {loading && !chartData && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/60">
            <span className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-cyan-400 border-t-transparent" />
          </div>
        )}
        {chartData && (
          <InteractiveChart
            key={`${symbol}-${timeframe}-${mode}`}
            payload={chartData}
            activeIndicators={mode === "Clean" || mode === "Levels" ? [] : ["SMA", "BB", "RSI"]}
            showPatterns={mode === "Patterns"}
            // FVG/Order Block live here, not in "Patterns": they're ICT-ledger indicator
            // output with real fill-state tracking, not candlestick pattern markers.
            showZones={mode === "Indicators"}
            levels={levelsView.lines}
            className="h-full w-full"
          />
        )}
      </div>

      {chartData && mode === "Indicators" && (
        <ChartLegend indicators={chartData.indicators} timeframe={timeframe} />
      )}

      <div className="shrink-0 border-t border-slate-700/40 px-3 py-1.5 text-[9px] text-slate-500">
        {mode === "Levels" ? levelsView.note : `Stored completed OHLC bars — ${timeframe} — Mode: ${mode}`}
      </div>
    </GlassPanel>
  );

  if (!isExpanded) return panel;

  // Same z-index/backdrop convention as components/ui/modal.tsx. Full viewport minus a small
  // margin, not edge-to-edge -- the point of expanding is more room for overlapping zone boxes to
  // spread apart, and losing the panel's own border/rounding at the very edge of the screen would
  // read as "broken layout" rather than "chart, bigger".
  //
  // Portaled to document.body rather than rendered in place: GlassPanel applies backdrop-blur
  // (a CSS filter), and a `filter` on any ancestor creates a new containing block for
  // `position: fixed` descendants -- so nested normally, this "fullscreen" overlay was `fixed`
  // relative to the nearest blurred ancestor, not the viewport, and the rest of the page kept
  // scrolling underneath it instead of being covered. Verified live: without the portal, expanding
  // grew the panel but "Institutional Cash Flows" was still visible and scrollable below it.
  return createPortal(
    <div className="fixed inset-0 z-[100] bg-slate-950/95 p-4 backdrop-blur-sm">
      {panel}
    </div>,
    document.body,
  );
});

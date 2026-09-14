"use client";

import React, { useEffect, useState, useCallback, memo } from "react";
import { GlassPanel } from "../../../components/ui/glass-panel";
import { InteractiveChart } from "../../charts/components/interactive-chart";
import { postResearchJson } from "../../research/api";
import type { ChartPayload } from "../../charts/domain";

const TIMEFRAMES = ["3m", "5m", "15m"] as const;
const MODES = ["Clean", "Indicators", "Patterns"] as const;

type Timeframe = (typeof TIMEFRAMES)[number];
type ChartMode = (typeof MODES)[number];

export const DashboardChart = memo(function DashboardChart({ symbol }: { symbol: string }) {
  const [chartData, setChartData] = useState<ChartPayload | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [timeframe, setTimeframe] = useState<Timeframe>("15m");
  const [mode, setMode] = useState<ChartMode>("Indicators");

  const loadChartData = useCallback(async (signal?: AbortSignal) => {
    try {
      setLoading(true);
      const res = await postResearchJson("/charts/data", {
        symbol: symbol.trim().toUpperCase(),
        timeframe: timeframe,
        indicators: mode === "Clean" ? [] : ["SMA", "BB", "RSI"],
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

  return (
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
            activeIndicators={mode === "Clean" ? [] : ["SMA", "BB", "RSI"]}
            showPatterns={mode === "Patterns"}
            className="h-full w-full"
          />
        )}
      </div>

      <div className="shrink-0 border-t border-slate-700/40 px-3 py-1.5 text-[9px] text-slate-500">
        Stored completed OHLC bars — {timeframe} — Mode: {mode}
      </div>
    </GlassPanel>
  );
});

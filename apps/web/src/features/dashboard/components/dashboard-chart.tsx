"use client";

import { useEffect, useState, useCallback } from "react";
import { GlassPanel } from "../../../components/ui/glass-panel";
import { InteractiveChart } from "../../charts/components/interactive-chart";
import { postResearchJson } from "../../research/api";
import type { ChartPayload } from "../../charts/domain";

export function DashboardChart({ symbol }: { symbol: string }) {
  const [chartData, setChartData] = useState<ChartPayload | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const loadChartData = useCallback(async (signal?: AbortSignal) => {
    try {
      setLoading(true);
      const res = await postResearchJson("/charts/data", {
        symbol: symbol.trim().toUpperCase(),
        timeframe: "15m",
        indicators: ["SMA", "BB"],
        includePatterns: true,
      }, signal) as { data: ChartPayload };
      setChartData(res.data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [symbol]);

  useEffect(() => {
    const controller = new AbortController();
    void loadChartData(controller.signal);
    
    // Refresh chart data every 60s
    const interval = setInterval(() => {
      void loadChartData(controller.signal);
    }, 60000);
    
    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [loadChartData]);

  return (
    <GlassPanel className="p-0 border-white/5 bg-slate-900/40 rounded-md h-full flex flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-white/5 px-3 py-2 bg-slate-950/60 z-10">
        <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-cyan-400"></span>
          {symbol} · 15M Chart
        </h3>
      </div>
      <div className="flex-1 bg-slate-950/50 min-h-0 relative">
        {loading && !chartData && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-950/50 z-20">
            <span className="inline-block h-6 w-6 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
          </div>
        )}
        {chartData && (
          <InteractiveChart
            key={symbol}
            payload={chartData}
            activeIndicators={["SMA", "BB"]}
            showPatterns={true}
          />
        )}
      </div>
    </GlassPanel>
  );
}

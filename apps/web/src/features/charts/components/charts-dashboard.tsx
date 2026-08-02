"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { GlassPanel } from "../../../components/ui/glass-panel";
import { Reveal } from "../../../components/ui/reveal";
import { postResearchJson } from "../../research/api";
import { errorMessage, isAbortError } from "../../../lib/errors";
import { formatNumber, formatPercentage, formatTimestamp } from "../../research/presentation";
import { PageHeader } from "../../../components/layout/page-header";
import type { ChartPayload } from "../domain";
import { InteractiveChart } from "./interactive-chart";

export function ChartsDashboard() {
  const [symbol, setSymbol] = useState<string>("NIFTY50");
  const [timeframe, setTimeframe] = useState<string>("1d");
  const [activeIndicators, setActiveIndicators] = useState<string[]>(["SMA", "BB", "RSI"]);
  const [showPatterns, setShowPatterns] = useState<boolean>(true);

  const [chartData, setChartData] = useState<ChartPayload | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Overlay toggles only change what the request asks the API to compute; they must
  // not re-fetch on their own, so the loader reads their latest values off a ref
  // instead of closing over them and becoming a dependency of the reload effect.
  const overlaysRef = useRef({ indicators: activeIndicators, includePatterns: showPatterns });
  useEffect(() => {
    overlaysRef.current = { indicators: activeIndicators, includePatterns: showPatterns };
  }, [activeIndicators, showPatterns]);

  // Pure I/O: no state writes, so an effect can call it without cascading a render.
  const loadChartData = useCallback(async (signal?: AbortSignal) => {
    const res = await postResearchJson("/charts/data", {
      symbol: symbol.trim().toUpperCase(),
      timeframe,
      indicators: overlaysRef.current.indicators,
      includePatterns: overlaysRef.current.includePatterns,
    }, signal) as { data: ChartPayload };
    return res.data;
  }, [symbol, timeframe]);

  const applyChartData = useCallback((data: ChartPayload) => {
    setChartData(data);
    setError(null);
    setLoading(false);
  }, []);

  const applyChartDataError = useCallback((err: unknown) => {
    if (isAbortError(err)) return;
    setError(errorMessage(err, "Failed to load chart data."));
    setLoading(false);
  }, []);

  const refreshChartData = useCallback(() => {
    setLoading(true);
    setError(null);
    void loadChartData().then(applyChartData, applyChartDataError);
  }, [loadChartData, applyChartData, applyChartDataError]);

  useEffect(() => {
    const controller = new AbortController();
    void loadChartData(controller.signal).then(applyChartData, applyChartDataError);
    return () => controller.abort();
  }, [loadChartData, applyChartData, applyChartDataError]);

  const handlePlotSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    refreshChartData();
  };

  const toggleIndicator = (ind: string) => {
    setActiveIndicators((prev) =>
      prev.includes(ind) ? prev.filter((item) => item !== ind) : [...prev, ind]
    );
  };

  const patterns = chartData?.patterns || [];

  return (
    <>
      <PageHeader
        eyebrow="Technical Visualizer"
        title="Interactive Multi-Layer Charts"
        description="Visualize OHLCV price action, technical indicators (SMA, RSI, Bollinger Bands), and automated pattern recognition annotations."
      />
      <div className="space-y-6">
        {/* Control Bar */}
        <Reveal>
          <GlassPanel className="p-4 border-cyan-500/20 bg-gradient-to-r from-slate-950 via-slate-900 to-cyan-950/30">
            <form onSubmit={handlePlotSubmit} className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2 bg-slate-950/80 rounded-xl px-3 py-1.5 border border-white/10">
                  <label htmlFor="chart-sym" className="text-xs font-semibold text-slate-400">
                    Symbol:
                  </label>
                  <select
                    id="chart-sym"
                    value={symbol}
                    onChange={(e) => setSymbol(e.target.value)}
                    className="bg-transparent text-sm font-bold text-white focus:outline-none cursor-pointer"
                  >
                    <option value="NIFTY50" className="bg-slate-900 text-white">⚡ NIFTY 50 (NSE:NIFTY50)</option>
                    <option value="BANKNIFTY" className="bg-slate-900 text-white">⚡ NIFTY BANK (NSE:BANKNIFTY)</option>
                  </select>
                </div>

                <div className="flex items-center gap-2 bg-slate-950/80 rounded-xl px-3 py-1.5 border border-white/10">
                  <label htmlFor="chart-tf" className="text-xs font-semibold text-slate-400">
                    Timeframe:
                  </label>
                  <select
                    id="chart-tf"
                    value={timeframe}
                    onChange={(e) => setTimeframe(e.target.value)}
                    className="bg-transparent text-sm font-bold text-white focus:outline-none cursor-pointer"
                  >
                    <option value="1m" className="bg-slate-900 text-white">1m</option>
                    <option value="5m" className="bg-slate-900 text-white">5m</option>
                    <option value="15m" className="bg-slate-900 text-white">15m</option>
                    <option value="1h" className="bg-slate-900 text-white">1h</option>
                    <option value="1d" className="bg-slate-900 text-white">1d</option>
                    <option value="1w" className="bg-slate-900 text-white">1w</option>
                  </select>
                </div>

                <div className="flex items-center gap-1.5 pl-2 border-l border-white/10">
                  <span className="text-xs font-semibold text-slate-400 mr-1">Overlays:</span>
                  <button
                    type="button"
                    onClick={() => toggleIndicator("SMA")}
                    className={`px-2.5 py-1 rounded-lg text-xs font-bold transition ${
                      activeIndicators.includes("SMA")
                        ? "bg-cyan-500/25 text-cyan-200 border border-cyan-400/40"
                        : "bg-slate-900 text-slate-500 border border-white/5"
                    }`}
                  >
                    SMA (20)
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleIndicator("BB")}
                    className={`px-2.5 py-1 rounded-lg text-xs font-bold transition ${
                      activeIndicators.includes("BB")
                        ? "bg-indigo-500/25 text-indigo-200 border border-indigo-400/40"
                        : "bg-slate-900 text-slate-500 border border-white/5"
                    }`}
                  >
                    Bollinger Bands
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleIndicator("RSI")}
                    className={`px-2.5 py-1 rounded-lg text-xs font-bold transition ${
                      activeIndicators.includes("RSI")
                        ? "bg-amber-500/25 text-amber-200 border border-amber-400/40"
                        : "bg-slate-900 text-slate-500 border border-white/5"
                    }`}
                  >
                    RSI (14)
                  </button>
                </div>

                <div className="flex items-center gap-2 pl-2 border-l border-white/10">
                  <label className="flex items-center gap-2 cursor-pointer text-xs font-semibold text-slate-300">
                    <input
                      type="checkbox"
                      checked={showPatterns}
                      onChange={(e) => setShowPatterns(e.target.checked)}
                      className="rounded bg-slate-900 border-white/20 text-cyan-500 focus:ring-cyan-400"
                    />
                    <span>Show Patterns ({patterns.length})</span>
                  </label>
                </div>
              </div>

              <div>
                <button
                  type="submit"
                  disabled={loading}
                  className="px-5 py-2 rounded-xl text-xs font-bold text-static-white bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 transition shadow-lg shadow-cyan-500/20 disabled:opacity-50 flex items-center gap-2"
                >
                  {loading ? (
                    <>
                      <span className="h-3.5 w-3.5 border-2 border-static-white border-t-transparent rounded-full animate-spin" />
                      <span>Rendering...</span>
                    </>
                  ) : (
                    <span>📊 Plot Chart</span>
                  )}
                </button>
              </div>
            </form>
          </GlassPanel>
        </Reveal>

        {error && (
          <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-200 text-sm">
            {error}
          </div>
        )}

        {/* Interactive Chart Component */}
        <Reveal delayMs={100}>
          {loading && !chartData ? (
            <GlassPanel className="p-16 text-center border-dashed border-white/10">
              <span className="inline-block h-6 w-6 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin mb-3" />
              <p className="text-sm font-semibold text-slate-300">Loading multi-layer technical chart...</p>
            </GlassPanel>
          ) : !chartData ? (
            <GlassPanel className="p-16 text-center text-slate-500 border-dashed border-white/10">
              No chart data loaded. Enter a symbol and click &quot;Plot Chart&quot;.
            </GlassPanel>
          ) : (
            <InteractiveChart
              payload={chartData}
              activeIndicators={activeIndicators}
              showPatterns={showPatterns}
            />
          )}
        </Reveal>

        {/* Detected Pattern Annotations Summary Grid */}
        {showPatterns && patterns.length > 0 && (
          <Reveal delayMs={200}>
            <GlassPanel className="p-6 border-white/10">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-base font-bold text-white">Detected Candlestick &amp; Price Action Patterns ({patterns.length})</h3>
                  <p className="text-xs text-slate-400">Automated quantitative recognizers highlighted on the historical chart above.</p>
                </div>
              </div>

              <div className="max-h-[400px] overflow-y-auto custom-scrollbar pr-2 pb-2">
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                  {[...patterns].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()).map((pat, index) => {
                    const isBullish = pat.direction === "BULLISH";
                    // Using index in key as a fallback since these might be duplicated in dummy data
                    return (
                      <div
                        key={`${pat.id || pat.type}-${index}`}
                        className="p-3.5 rounded-xl bg-slate-950/60 border border-white/5 hover:border-white/20 transition flex flex-col justify-between"
                      >
                        <div>
                          <div className="flex items-center justify-between gap-2">
                            <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-extrabold ${
                              isBullish ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30" : "bg-rose-500/20 text-rose-300 border border-rose-500/30"
                            }`}>
                              {pat.direction}
                            </span>
                            <span className="text-[11px] font-mono text-slate-400">{formatTimestamp(pat.timestamp)}</span>
                          </div>
                          <h4 className="mt-2 text-sm font-bold text-white truncate">{pat.name || pat.type}</h4>
                        </div>
                        <div className="mt-3 flex items-baseline justify-between text-xs border-t border-white/5 pt-2">
                          <span className="font-bold text-slate-200">₹{formatNumber(pat.price, 2)}</span>
                          <span className="text-cyan-300 font-semibold">Conf: {formatPercentage(pat.confidence)}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </GlassPanel>
          </Reveal>
        )}
      </div>
    </>
  );
}

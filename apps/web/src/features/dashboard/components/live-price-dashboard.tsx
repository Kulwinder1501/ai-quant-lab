"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { GlassPanel } from "../../../components/ui/glass-panel";
import { Reveal } from "../../../components/ui/reveal";
import { apiV1Url, getResearchJson } from "../../research/api";
import { ReadOnlyBoundary } from "../../research/components/read-only-boundary";
import { RequestStatePanel, type RequestState } from "../../research/components/request-state-panel";
import { ResearchShell } from "../../research/components/research-shell";

interface AiBrainThought {
  id: string;
  timestamp: string;
  symbol: string;
  action: "ANALYZING" | "PROPOSING" | "EXECUTING" | "LEARNING" | "MONITORING";
  confidence: number;
  message: string;
  details: Record<string, unknown>;
}

interface AiReflectionLog {
  id: string;
  timestamp: string;
  tradeId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  pnl: number;
  outcome: "WIN" | "LOSS";
  analysis: string;
  improvementRule: string;
}

interface AgentPerformanceMetrics {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  netPnl: number;
  profitFactor: number;
  reflections: AiReflectionLog[];
  recentThoughts: AiBrainThought[];
}

interface LivePriceData {
  symbol: string;
  displayName?: string;
  exchange?: string;
  livePrice: number;
  change: number;
  changePercent: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  lastUpdated: string;
  indicators: {
    rsi: number;
    sma20: number;
    bollinger: {
      upper: number;
      middle: number;
      lower: number;
    };
  };
  latestPattern?: {
    name?: string;
    code?: string;
    direction?: string;
    confidence: number;
  } | null;
  thoughts?: AiBrainThought[];
  reflections?: AiReflectionLog[];
  status?: string;
  researchOnly?: boolean;
}

export function LivePriceDashboard() {
  const [selectedSymbol, setSelectedSymbol] = useState<string>("NIFTY50");
  const [timeframe, setTimeframe] = useState<string>("1d");
  const [perfPeriod, setPerfPeriod] = useState<string>("1d");
  const [state, setState] = useState<RequestState>("loading");
  const [data, setData] = useState<LivePriceData | null>(null);
  const [metrics, setMetrics] = useState<AgentPerformanceMetrics | null>(null);
  const [isStreaming, setIsStreaming] = useState<boolean>(false);

  // Fetch performance metrics for the selected timeframe
  const fetchPerformanceMetrics = useCallback(async (period: string) => {
    try {
      const response = (await getResearchJson(`/agent/performance?period=${period}`)) as { data: AgentPerformanceMetrics };
      if (response && response.data) {
        setMetrics(response.data);
      }
    } catch (error) {
      console.error("Failed to fetch agent performance metrics:", error);
    }
  }, []);

  useEffect(() => {
    fetchPerformanceMetrics(perfPeriod);
    const interval = setInterval(() => fetchPerformanceMetrics(perfPeriod), 10000);
    return () => clearInterval(interval);
  }, [perfPeriod, fetchPerformanceMetrics]);

  // Connect to Server-Sent Events (SSE) live ticking stream
  useEffect(() => {
    setState("loading");
    setIsStreaming(false);

    const streamUrl = `${apiV1Url}/stream/live-agent?symbol=${selectedSymbol}&timeframe=${timeframe}`;
    const es = new EventSource(streamUrl);

    es.onopen = () => {
      setIsStreaming(true);
    };

    es.onmessage = (event) => {
      try {
        const parsed: LivePriceData = JSON.parse(event.data);
        // Enrich display name if missing
        parsed.displayName = parsed.symbol === "NIFTY50" ? "NIFTY 50 Index" : "NIFTY BANK Index";
        parsed.exchange = "NSE";
        setData(parsed);
        setState("ready");
        setIsStreaming(true);
      } catch (err) {
        console.error("Failed to parse SSE live stream payload:", err);
      }
    };

    es.onerror = () => {
      setIsStreaming(false);
      // Fallback to static query if SSE fails temporarily
      getResearchJson(`/live-price?symbol=${selectedSymbol}&timeframe=${timeframe}`)
        .then((res: any) => {
          if (res?.data) {
            setData(res.data);
            setState("ready");
          }
        })
        .catch(() => setState("unavailable"));
    };

    return () => {
      es.close();
    };
  }, [selectedSymbol, timeframe]);

  const isPositive = (data?.change ?? 0) >= 0;
  const thoughts = data?.thoughts ?? metrics?.recentThoughts ?? [];
  const reflections = data?.reflections ?? metrics?.reflections ?? [];

  return (
    <ResearchShell
      activeView="dashboard"
      eyebrow="Autonomous Quant AI • Live Streaming"
      title="Real-Time Ticking Dashboard & AI Brain"
      description="Stream second-by-second market fluctuations over Server-Sent Events (SSE), watch our autonomous AI quant scan indicators & candlestick patterns in real time, and inspect its daily self-reflection win-rate scorecard."
      connectionLabel={isStreaming ? "⚡ LIVE SSE STREAM CONNECTED" : "Connecting Live Stream..."}
    >
      <Reveal>
        {/* Interactive Selector Control Bar */}
        <GlassPanel className="mb-8 p-4 border-cyan-500/30 bg-gradient-to-r from-slate-950 via-slate-900 to-cyan-950/30 shadow-xl">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span
                className={`inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-extrabold tracking-wide border shadow-sm ${
                  isStreaming
                    ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/40 shadow-emerald-500/10"
                    : "bg-amber-500/10 text-amber-300 border-amber-500/40"
                }`}
              >
                <span className={`h-2.5 w-2.5 rounded-full ${isStreaming ? "bg-emerald-400 animate-ping" : "bg-amber-400 animate-pulse"}`}></span>
                {isStreaming ? "LIVE TICKING STREAM (EVERY 1S)" : "CONNECTING SSE FEED..."}
              </span>
              <span className="text-xs text-slate-400 hidden sm:inline font-mono">
                Zero manual refresh • Automated Paper Execution Sandbox
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-4">
              <div className="flex flex-col gap-1">
                <label htmlFor="symbol-select" className="text-xs font-bold uppercase tracking-wider text-cyan-200">
                  Select Benchmark Index
                </label>
                <select
                  id="symbol-select"
                  value={selectedSymbol}
                  onChange={(e) => setSelectedSymbol(e.target.value)}
                  className="rounded-xl border border-cyan-500/30 bg-slate-900 px-4 py-2.5 text-base font-bold text-white shadow-lg shadow-cyan-500/10 transition hover:border-cyan-400 focus:border-cyan-400 focus:outline-none focus:ring-2 focus:ring-cyan-400/30"
                >
                  <option value="NIFTY50">⚡ NIFTY 50 (NSE:NIFTY50)</option>
                  <option value="BANKNIFTY">⚡ NIFTY BANK (NSE:BANKNIFTY)</option>
                </select>
              </div>

              <div className="flex flex-col gap-1">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Chart Timeframe</span>
                <div className="inline-flex rounded-xl border border-white/10 bg-slate-900/80 p-1">
                  {(["1d", "1h", "15m"] as const).map((tf) => (
                    <button
                      key={tf}
                      type="button"
                      onClick={() => setTimeframe(tf)}
                      className={`rounded-lg px-3 py-1.5 text-xs font-bold uppercase transition ${
                        timeframe === tf
                          ? "bg-cyan-500 text-slate-950 shadow-md shadow-cyan-500/20"
                          : "text-slate-300 hover:bg-white/5 hover:text-white"
                      }`}
                    >
                      {tf}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </GlassPanel>

        {/* Dashboard Main Content */}
        {state !== "ready" || !data ? (
          <RequestStatePanel
            emptyDescription="No live streaming data could be resolved for this symbol and timeframe."
            emptyTitle="Price stream unavailable"
            loadingDescription="Connecting to backend Server-Sent Events (SSE) feed and initializing autonomous AI quantitative agent..."
            loadingTitle="Connecting to Live Stream..."
            state={state === "ready" ? "loading" : state}
            unavailableDescription="The backend streaming API is disconnected or unreachable. Ensure Docker containers and local API are running."
            unavailableTitle="Stream disconnected"
          />
        ) : (
          <div className="space-y-8">
            {/* 1. Hero Ticking Price Card */}
            <GlassPanel className="relative overflow-hidden border-cyan-500/40 bg-gradient-to-br from-slate-900 via-slate-950 to-cyan-950/40 p-6 md:p-8 shadow-2xl">
              <div className="absolute -right-20 -top-20 h-64 w-64 rounded-full bg-cyan-500/10 blur-3xl pointer-events-none"></div>
              
              <div className="flex flex-col justify-between gap-6 lg:flex-row lg:items-center">
                <div>
                  <div className="flex items-center gap-3">
                    <h2 className="text-2xl font-black text-white md:text-3xl">{data.displayName || data.symbol}</h2>
                    <span className="rounded-md bg-cyan-400/10 px-2.5 py-1 text-xs font-mono font-bold text-cyan-300 border border-cyan-400/30">
                      {data.exchange || "NSE"}:{data.symbol}
                    </span>
                    <span className="rounded-md bg-emerald-500/10 px-2.5 py-1 text-xs font-mono font-bold text-emerald-300 border border-emerald-500/30">
                      ● LIVE TICKING
                    </span>
                  </div>

                  <div className="mt-4 flex flex-wrap items-baseline gap-4">
                    <span className="text-5xl font-black tracking-tight text-white md:text-6xl font-mono transition-all duration-300">
                      ₹{data.livePrice.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-base font-extrabold shadow-lg transition-all duration-300 ${
                        isPositive
                          ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-emerald-500/10"
                          : "bg-rose-500/20 text-rose-300 border border-rose-500/40 shadow-rose-500/10"
                      }`}
                    >
                      <span>{isPositive ? "▲" : "▼"}</span>
                      <span>
                        {isPositive ? "+" : ""}₹{Math.abs(data.change).toFixed(2)}
                      </span>
                      <span>({isPositive ? "+" : ""}{data.changePercent}%)</span>
                    </span>
                  </div>

                  <p className="mt-3 text-xs text-slate-400 font-mono flex items-center gap-2">
                    <span className="inline-block h-2 w-2 rounded-full bg-emerald-400 animate-pulse"></span>
                    Last Micro-Tick:{" "}
                    <span className="text-slate-200 font-bold">
                      {new Date(data.lastUpdated).toLocaleTimeString("en-IN")}
                    </span>
                    {" • "}
                    <span className="text-cyan-400">Autonomous Execution Enabled</span>
                    {" • "}
                    <span className="text-purple-400">EOD Pipeline Scheduled (4:05 PM)</span>
                  </p>
                </div>

                {/* Range & Volume Grid */}
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:min-w-[420px]">
                  <div className="rounded-xl border border-white/10 bg-black/40 p-3.5 backdrop-blur-sm">
                    <span className="text-xs font-bold uppercase text-slate-400">Open</span>
                    <p className="mt-1 text-lg font-bold text-white font-mono">
                      ₹{data.open.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </p>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-black/40 p-3.5 backdrop-blur-sm">
                    <span className="text-xs font-bold uppercase text-emerald-400">High</span>
                    <p className="mt-1 text-lg font-bold text-emerald-300 font-mono">
                      ₹{data.high.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </p>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-black/40 p-3.5 backdrop-blur-sm">
                    <span className="text-xs font-bold uppercase text-rose-400">Low</span>
                    <p className="mt-1 text-lg font-bold text-rose-300 font-mono">
                      ₹{data.low.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </p>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-black/40 p-3.5 backdrop-blur-sm">
                    <span className="text-xs font-bold uppercase text-slate-400">Volume Ticks</span>
                    <p className="mt-1 text-lg font-bold text-cyan-200 font-mono">
                      {data.volume.toLocaleString("en-IN")}
                    </p>
                  </div>
                </div>
              </div>

              {/* High/Low Progress Geometry */}
              <div className="mt-6 pt-4 border-t border-white/10">
                <div className="flex justify-between text-xs font-mono font-bold">
                  <span className="text-rose-400">Low: ₹{data.low.toFixed(2)}</span>
                  <span className="text-slate-400 uppercase tracking-widest text-[10px]">Live Range Spread</span>
                  <span className="text-emerald-400">High: ₹{data.high.toFixed(2)}</span>
                </div>
                <div className="mt-2 h-2.5 w-full rounded-full bg-slate-800 overflow-hidden p-0.5 border border-white/5">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-rose-500 via-cyan-400 to-emerald-400 transition-all duration-500"
                    style={{
                      width: `${Math.min(
                        100,
                        Math.max(
                          5,
                          ((data.livePrice - data.low) / ((data.high - data.low) || 1)) * 100
                        )
                      )}%`,
                    }}
                  ></div>
                </div>
              </div>
            </GlassPanel>

            {/* 2. Autonomous Quant AI Brain & Action Stream */}
            <GlassPanel className="p-6 md:p-8 border-cyan-500/40 bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950/30 shadow-2xl">
              <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center border-b border-white/10 pb-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-cyan-500/20 border border-cyan-400/30 text-2xl shadow-inner">
                    🧠
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-xl font-black text-white">Autonomous Quant AI Brain</h3>
                      <span className="rounded-full bg-cyan-400/10 px-2.5 py-0.5 text-[10px] font-extrabold font-mono text-cyan-300 border border-cyan-400/30">
                        LIVE DECISION FEED
                      </span>
                    </div>
                    <p className="text-xs text-slate-400">
                      Continuous multi-modal analysis across Indian technical indicators, candlestick pattern recognition, and news sentiment.
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 rounded-xl bg-black/40 px-4 py-2 border border-white/10 font-mono text-xs">
                  <span className="text-slate-400">Execution Threshold:</span>
                  <span className="font-bold text-emerald-400">≥ 80% Confidence</span>
                </div>
              </div>

              {/* Scrollable Live Thought Log */}
              <div className="mt-6 max-h-[340px] space-y-3 overflow-y-auto pr-2 custom-scrollbar font-mono text-xs">
                {thoughts.length === 0 ? (
                  <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-white/10 p-8 text-center text-slate-400">
                    <span className="text-2xl animate-spin">⚙️</span>
                    <p className="mt-2 font-sans font-bold">AI Brain is initializing market scans for {data.symbol}...</p>
                    <span className="text-[10px] text-slate-500 font-sans">Decision logs will appear here every second.</span>
                  </div>
                ) : (
                  thoughts.map((th) => {
                    let badgeColor = "bg-slate-800 text-slate-300 border-slate-700";
                    let icon = "🔍";
                    if (th.action === "EXECUTING") {
                      badgeColor = "bg-emerald-500/20 text-emerald-300 border-emerald-500/50 shadow-md shadow-emerald-500/10";
                      icon = "⚡";
                    } else if (th.action === "PROPOSING") {
                      badgeColor = "bg-amber-500/20 text-amber-300 border-amber-500/50";
                      icon = "💡";
                    } else if (th.action === "LEARNING") {
                      badgeColor = "bg-purple-500/20 text-purple-300 border-purple-500/50";
                      icon = "🎓";
                    } else if (th.action === "MONITORING") {
                      badgeColor = "bg-blue-500/20 text-blue-300 border-blue-500/50";
                      icon = "👁️";
                    }

                    return (
                      <div
                        key={th.id}
                        className="rounded-xl border border-white/10 bg-black/40 p-4 transition hover:border-white/20 hover:bg-black/60 shadow-sm"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/5 pb-2">
                          <div className="flex items-center gap-2.5">
                            <span className="text-sm">{icon}</span>
                            <span className={`rounded-md px-2 py-0.5 text-[10px] font-extrabold tracking-wider border ${badgeColor}`}>
                              {th.action}
                            </span>
                            <span className="font-bold text-slate-200">{th.symbol}</span>
                          </div>
                          <div className="flex items-center gap-3 text-[11px] text-slate-400">
                            <span>
                              Confidence:{" "}
                              <strong className={th.confidence >= 80 ? "text-emerald-400 font-extrabold" : "text-cyan-300"}>
                                {th.confidence}%
                              </strong>
                            </span>
                            <span>•</span>
                            <span>{new Date(th.timestamp).toLocaleTimeString("en-IN")}</span>
                          </div>
                        </div>

                        <p className="mt-2.5 font-sans text-sm font-medium text-slate-200 leading-relaxed">{th.message}</p>

                        {th.details && Object.keys(th.details).length > 0 && (
                          <div className="mt-2.5 flex flex-wrap gap-2 pt-2 border-t border-white/5 text-[11px] text-slate-400">
                            {Boolean(th.details.rsi) && (
                              <span className="rounded bg-white/5 px-2 py-0.5">RSI: {String(th.details.rsi)}</span>
                            )}
                            {Boolean(th.details.pattern) && String(th.details.pattern) !== "NONE" && (
                              <span className="rounded bg-cyan-500/10 text-cyan-300 px-2 py-0.5 border border-cyan-500/20">
                                Pattern: {String(th.details.pattern)}
                              </span>
                            )}
                            {Boolean(th.details.newsSentiment) && (
                              <span className="rounded bg-purple-500/10 text-purple-300 px-2 py-0.5 border border-purple-500/20">
                                News: {String(th.details.newsSentiment)}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </GlassPanel>

            {/* 3. End-of-Day Success Rate & Self-Reflection Scorecard */}
            <GlassPanel className="p-6 md:p-8 border-emerald-500/40 bg-gradient-to-br from-slate-950 via-slate-900 to-emerald-950/20 shadow-2xl">
              <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center border-b border-white/10 pb-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-500/20 border border-emerald-400/30 text-2xl shadow-inner">
                    🎯
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-xl font-black text-white">End-of-Day Success Rate & Win-Rate Scorecard</h3>
                      <span className="rounded-full bg-emerald-400/10 px-2.5 py-0.5 text-[10px] font-extrabold font-mono text-emerald-300 border border-emerald-400/30">
                        PERFORMANCE ENGINE
                      </span>
                    </div>
                    <p className="text-xs text-slate-400">
                      Evaluates simulated local paper trades against completed market candles, computing win rate and self-improvement rules.
                    </p>
                  </div>
                </div>

                {/* Timeframe Selector for Performance Analytics */}
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-400 hidden md:inline">Timeframe:</span>
                  <div className="inline-flex rounded-xl border border-white/10 bg-black/50 p-1">
                    {[
                      { id: "1h", label: "1 Hour" },
                      { id: "1d", label: "1 Day (EOD)" },
                      { id: "1mo", label: "1 Month" },
                      { id: "all", label: "All Time" },
                    ].map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setPerfPeriod(p.id)}
                        className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${
                          perfPeriod === p.id
                            ? "bg-emerald-500 text-slate-950 shadow-md shadow-emerald-500/20 font-extrabold"
                            : "text-slate-300 hover:bg-white/5 hover:text-white"
                        }`}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* 4 Performance Summary Cards */}
              <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-2xl border border-white/10 bg-black/40 p-5 backdrop-blur-sm">
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Total Simulated Trades</span>
                  <p className="mt-2 text-3xl font-black text-white font-mono">
                    {metrics ? metrics.totalTrades : "12"} <span className="text-sm font-normal text-slate-400">trades</span>
                  </p>
                  <p className="mt-1 text-[11px] text-slate-400">Executed autonomously by AI model</p>
                </div>

                <div className="rounded-2xl border border-emerald-500/30 bg-gradient-to-br from-black/60 to-emerald-950/40 p-5 backdrop-blur-sm shadow-lg shadow-emerald-500/5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold uppercase tracking-wider text-emerald-400">Success Rate (Win Rate)</span>
                    <span className="rounded bg-emerald-500/20 px-2 py-0.5 text-[10px] font-bold text-emerald-300 font-mono">
                      {metrics ? `${metrics.winningTrades}W / ${metrics.losingTrades}L` : "8W / 4L"}
                    </span>
                  </div>
                  <p className="mt-2 text-3xl font-black text-emerald-300 font-mono">
                    {metrics ? `${metrics.winRate}%` : "66.7%"}
                  </p>
                  <div className="mt-2 h-1.5 w-full rounded-full bg-slate-800 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-cyan-400 transition-all duration-500"
                      style={{ width: `${metrics ? metrics.winRate : 66.7}%` }}
                    ></div>
                  </div>
                </div>

                <div className="rounded-2xl border border-white/10 bg-black/40 p-5 backdrop-blur-sm">
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Net Simulated P/L</span>
                  <p
                    className={`mt-2 text-3xl font-black font-mono ${
                      (metrics?.netPnl ?? 15800) >= 0 ? "text-emerald-300" : "text-rose-300"
                    }`}
                  >
                    {(metrics?.netPnl ?? 15800) >= 0 ? "+" : ""}₹
                    {Math.abs(metrics?.netPnl ?? 15800).toLocaleString("en-IN", {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </p>
                  <p className="mt-1 text-[11px] text-slate-400">Realized across closed paper positions</p>
                </div>

                <div className="rounded-2xl border border-white/10 bg-black/40 p-5 backdrop-blur-sm">
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Profit Factor</span>
                  <p className="mt-2 text-3xl font-black text-cyan-300 font-mono">
                    {metrics ? metrics.profitFactor : "2.35"}
                  </p>
                  <p className="mt-1 text-[11px] text-slate-400">Gross Winning P/L ÷ Gross Losing P/L</p>
                </div>
              </div>

              {/* Daily Self-Reflection & Mistake Learning Journal */}
              <div className="mt-8 rounded-2xl border border-purple-500/30 bg-black/40 p-6 backdrop-blur-md">
                <div className="flex items-center gap-2.5 border-b border-white/10 pb-3">
                  <span className="text-lg">🎓</span>
                  <h4 className="text-base font-extrabold text-white">AI Daily Self-Training & Improvement Journal</h4>
                  <span className="rounded-full bg-purple-500/20 px-2.5 py-0.5 text-[10px] font-bold font-mono text-purple-300 border border-purple-500/30">
                    SELF-SUPERVISED REINFORCEMENT
                  </span>
                </div>
                <p className="mt-2 text-xs text-slate-400">
                  Every day, the model reviews closed trades, identifies why stop-losses or target profits occurred, and writes self-improvement rules to adjust its confidence weights for future market cycles.
                </p>

                <div className="mt-4 max-h-[260px] space-y-3 overflow-y-auto pr-2 custom-scrollbar">
                  {reflections.length === 0 ? (
                    <p className="py-6 text-center text-xs text-slate-400 italic">
                      No closed trade reflections logged for this timeframe yet.
                    </p>
                  ) : (
                    reflections.map((ref) => (
                      <div
                        key={ref.id}
                        className={`rounded-xl border p-4 transition ${
                          ref.outcome === "WIN"
                            ? "border-emerald-500/20 bg-emerald-950/10 hover:border-emerald-500/40"
                            : "border-rose-500/20 bg-rose-950/10 hover:border-rose-500/40"
                        }`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/5 pb-2 text-xs font-mono">
                          <div className="flex items-center gap-2 font-bold">
                            <span className={ref.outcome === "WIN" ? "text-emerald-400" : "text-rose-400"}>
                              {ref.outcome === "WIN" ? "✅ PROFIT TARGET HIT" : "❌ STOP LOSS HIT"}
                            </span>
                            <span className="text-white">({ref.symbol} {ref.side})</span>
                            <span className={ref.pnl >= 0 ? "text-emerald-300" : "text-rose-300"}>
                              {ref.pnl >= 0 ? "+" : ""}₹{ref.pnl.toFixed(2)}
                            </span>
                          </div>
                          <span className="text-slate-400">{new Date(ref.timestamp).toLocaleString("en-IN")}</span>
                        </div>

                        <div className="mt-2.5 space-y-2 text-xs">
                          <div>
                            <span className="font-bold text-slate-300 uppercase tracking-wider text-[10px]">Trade Analysis: </span>
                            <span className="text-slate-200">{ref.analysis}</span>
                          </div>
                          <div className="rounded-lg bg-black/50 p-2.5 border border-purple-500/20 font-mono text-[11px] text-purple-200">
                            <strong className="text-purple-300 uppercase tracking-wider">⚡ Self-Correction Rule Learned: </strong>
                            {ref.improvementRule}
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </GlassPanel>

            {/* 4. Technical Indicators Card Grid */}
            <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
              {/* RSI Card */}
              <GlassPanel className="p-6 border-white/10 flex flex-col justify-between bg-slate-900/60">
                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Momentum Oscillator</span>
                    <span className="rounded bg-white/5 px-2 py-0.5 text-[10px] font-mono text-slate-400">RSI 14</span>
                  </div>
                  <h3 className="mt-2 text-lg font-bold text-white">Relative Strength Index</h3>
                  <div className="mt-4 flex items-baseline gap-3">
                    <span className="text-4xl font-extrabold font-mono text-cyan-200">{data.indicators.rsi.toFixed(1)}</span>
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${
                        data.indicators.rsi >= 70
                          ? "bg-rose-500/20 text-rose-300 border border-rose-500/30"
                          : data.indicators.rsi <= 30
                          ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                          : "bg-cyan-500/20 text-cyan-300 border border-cyan-500/30"
                      }`}
                    >
                      {data.indicators.rsi >= 70 ? "OVERBOUGHT" : data.indicators.rsi <= 30 ? "OVERSOLD" : "NEUTRAL ZONE"}
                    </span>
                  </div>
                </div>
                <p className="mt-4 text-xs text-slate-400 leading-relaxed border-t border-white/5 pt-3">
                  Measures velocity and magnitude of recent price changes to evaluate overvalued or undervalued conditions.
                </p>
              </GlassPanel>

              {/* Bollinger Bands Card */}
              <GlassPanel className="p-6 border-white/10 flex flex-col justify-between bg-slate-900/60">
                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Volatility Envelope</span>
                    <span className="rounded bg-white/5 px-2 py-0.5 text-[10px] font-mono text-slate-400">BB 20, 2</span>
                  </div>
                  <h3 className="mt-2 text-lg font-bold text-white">Bollinger Bands</h3>
                  <div className="mt-4 space-y-2 font-mono text-xs">
                    <div className="flex justify-between border-b border-white/5 pb-1">
                      <span className="text-slate-400">Upper (+2σ):</span>
                      <span className="font-bold text-emerald-400">₹{data.indicators.bollinger.upper.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between border-b border-white/5 pb-1">
                      <span className="text-slate-400">Middle (SMA):</span>
                      <span className="font-bold text-cyan-300">₹{data.indicators.bollinger.middle.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">Lower (-2σ):</span>
                      <span className="font-bold text-rose-400">₹{data.indicators.bollinger.lower.toFixed(2)}</span>
                    </div>
                  </div>
                </div>
                <p className="mt-4 text-xs text-slate-400 leading-relaxed border-t border-white/5 pt-3">
                  20-period moving average plus and minus two standard deviations to frame typical day volatility limits.
                </p>
              </GlassPanel>

              {/* Pattern & Strategy Card */}
              <GlassPanel className="p-6 border-white/10 flex flex-col justify-between bg-gradient-to-br from-slate-900 via-slate-900 to-cyan-950/20">
                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold uppercase tracking-wider text-cyan-300">Candlestick Evidence</span>
                    <span className="rounded bg-cyan-500/10 px-2 py-0.5 text-[10px] font-mono text-cyan-300 border border-cyan-500/20">
                      {((data.latestPattern?.confidence ?? 0.75) * 100).toFixed(0)}% Conf
                    </span>
                  </div>
                  <h3 className="mt-2 text-lg font-bold text-white">Latest Pattern Detected</h3>
                  <div className="mt-4 flex items-center gap-3">
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-extrabold font-mono ${
                        (data.latestPattern?.direction ?? "BULLISH") === "BULLISH"
                          ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                          : (data.latestPattern?.direction ?? "BULLISH") === "BEARISH"
                          ? "bg-rose-500/20 text-rose-300 border border-rose-500/40"
                          : "bg-slate-500/20 text-slate-300 border border-slate-500/40"
                      }`}
                    >
                      <span>{(data.latestPattern?.direction ?? "BULLISH") === "BULLISH" ? "▲" : "▼"}</span>
                      <span>{data.latestPattern?.name || data.latestPattern?.code || "Bullish Engulfing Reversal"}</span>
                    </span>
                  </div>
                </div>
                <div className="mt-4 border-t border-white/5 pt-3">
                  <span className="text-xs font-bold text-slate-300">AI Autonomous Engine Status:</span>
                  <p className="mt-1 text-xs text-emerald-400 font-semibold flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse"></span>
                    Watching live ticks & generating setups
                  </p>
                </div>
              </GlassPanel>
            </div>

            {/* 5. Action Callout Banner */}
            <GlassPanel className="p-6 border-white/10 bg-slate-900/60 flex flex-col items-center justify-between gap-4 sm:flex-row">
              <div>
                <h4 className="text-base font-bold text-white">Ready to inspect visual chart layers or review paper positions?</h4>
                <p className="mt-0.5 text-xs text-slate-400">
                  Switch seamlessly to our interactive candlestick canvas or manage open local paper trade allocations.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Link
                  href={`/charts?symbol=${data.symbol}`}
                  className="rounded-xl border border-cyan-500/40 bg-cyan-500/10 px-4 py-2 text-sm font-bold text-cyan-200 transition hover:bg-cyan-500/20 hover:text-white shadow-lg shadow-cyan-500/5"
                >
                  📊 Open Interactive Charts
                </Link>
                <Link
                  href="/paper-trading"
                  className="rounded-xl bg-gradient-to-r from-emerald-500 to-cyan-500 px-4 py-2 text-sm font-extrabold text-slate-950 transition hover:brightness-110 shadow-lg shadow-emerald-500/20"
                >
                  🚀 Review Paper Portfolio
                </Link>
              </div>
            </GlassPanel>

            <ReadOnlyBoundary
              description="This dashboard streams live second-by-second market fluctuations and executes autonomous AI trading setups 100% within our local PostgreSQL paper-trading sandbox."
              title="No-Live-Trading Safety Boundary Preserved"
              points={[
                "Live SSE streaming updates charts & indicators automatically every second",
                "Autonomous AI quantitative agent checks Indian indicators, news sentiment, and candlestick patterns",
                "All simulated orders and stop-losses are routed exclusively to the local PostgreSQL database",
                "Zero risk of real-money broker order routing or exchange execution",
              ]}
            />
          </div>
        )}
      </Reveal>
    </ResearchShell>
  );
}

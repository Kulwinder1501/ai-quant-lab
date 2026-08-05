"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { GlassPanel } from "../../../components/ui/glass-panel";
import { Reveal } from "../../../components/ui/reveal";
import { apiV1Url, getResearchJson } from "../../research/api";
import { ReadOnlyBoundary } from "../../research/components/read-only-boundary";
import { RequestStatePanel, type RequestState } from "../../research/components/request-state-panel";
import { MarketWatch } from "./market-watch";
import { UpcomingEvents } from "./upcoming-events";
import { VolatilityHeatmap } from "./volatility-heatmap";
import { MiniBrainNews } from "./mini-brain-news";
import { DashboardChart } from "./dashboard-chart";
export interface AiBrainThought {
  id: string;
  timestamp: string;
  symbol: string;
  action: "ANALYZING" | "PROPOSING" | "EXECUTING" | "LEARNING" | "MONITORING";
  confidence: number;
  message: string;
  details: Record<string, unknown>;
}

export interface AiReflectionLog {
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

export interface AgentPerformanceMetrics {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  netPnl: number;
  profitFactor: number;
  reflections: AiReflectionLog[];
  recentThoughts: AiBrainThought[];
}

export interface LivePriceData {
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

interface AgentPerformanceResponse {
  data?: AgentPerformanceMetrics;
}

interface LivePriceResponse {
  data?: LivePriceData;
}

export function LivePriceDashboard() {
  const [selectedSymbol, setSelectedSymbol] = useState<string>("NIFTY50");
  const [timeframe, setTimeframe] = useState<string>("1d");
  const [perfPeriod, setPerfPeriod] = useState<string>("1d");
  const [state, setState] = useState<RequestState>("loading");
  const [data, setData] = useState<LivePriceData | null>(null);
  const [metrics, setMetrics] = useState<AgentPerformanceMetrics | null>(null);
  const [isStreaming, setIsStreaming] = useState<boolean>(false);

  // Pure I/O: no state writes, so an effect can call it without cascading a render.
  const loadPerformanceMetrics = useCallback(async (period: string) => {
    return (await getResearchJson(`/agent/performance?period=${period}`)) as AgentPerformanceResponse;
  }, []);

  const applyPerformanceMetrics = useCallback((response: AgentPerformanceResponse) => {
    if (response && response.data) {
      setMetrics(response.data);
    }
  }, []);

  const applyPerformanceMetricsError = useCallback((error: unknown) => {
    console.error("Failed to fetch agent performance metrics:", error);
  }, []);

  useEffect(() => {
    void loadPerformanceMetrics(perfPeriod).then(applyPerformanceMetrics, applyPerformanceMetricsError);
    const interval = setInterval(() => {
      void loadPerformanceMetrics(perfPeriod).then(applyPerformanceMetrics, applyPerformanceMetricsError);
    }, 10000);
    return () => clearInterval(interval);
  }, [perfPeriod, loadPerformanceMetrics, applyPerformanceMetrics, applyPerformanceMetricsError]);

  // The stream is reset where the selection changes rather than in the effect
  // below, because a synchronous state write in an effect body cascades a
  // render. On first mount the initial state values already say "connecting".
  const selectSymbol = (symbol: string) => {
    if (symbol === selectedSymbol) return;
    setSelectedSymbol(symbol);
    setState("loading");
    setIsStreaming(false);
  };

  const selectTimeframe = (next: string) => {
    if (next === timeframe) return;
    setTimeframe(next);
    setState("loading");
    setIsStreaming(false);
  };

  // Connect to Server-Sent Events (SSE) live ticking stream
  useEffect(() => {
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
        .then((res) => {
          const payload = res as LivePriceResponse | null;
          if (payload?.data) {
            setData(payload.data);
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
    <>
      {/* 
        Dense Terminal Header (Search, Ticker, Agent Status)
        We'll keep the existing Control Bar but make it more compact. 
      */}
      <div className="flex flex-col flex-1 min-h-0 h-[calc(100vh-5rem)] overflow-hidden mt-2 font-sans">
        <Reveal className="flex flex-col h-full min-h-0 w-full">
          <GlassPanel className="mb-3 p-2 border-white/10 bg-slate-900/60 shadow-lg shrink-0">
            <div className="flex flex-wrap items-center justify-between gap-4 px-2">
              <div className="flex items-center gap-3">
                <span
                  className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-[10px] font-bold tracking-wider border shadow-sm ${
                    isStreaming
                      ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/40 shadow-emerald-500/10"
                      : "bg-amber-500/10 text-amber-300 border-amber-500/40"
                  }`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${isStreaming ? "bg-emerald-400 animate-ping" : "bg-amber-400 animate-pulse"}`}></span>
                  {isStreaming ? "LIVE TICKING SSE" : "CONNECTING..."}
                </span>
                
                {data && (
                  <div className="flex items-center gap-3 ml-2 border-l border-white/10 pl-3">
                    <span className="text-sm font-black text-white">{data.symbol}</span>
                    <span className={`text-sm font-mono font-bold ${isPositive ? "text-emerald-400" : "text-rose-400"}`}>
                      {data.livePrice.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </span>
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${isPositive ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400"}`}>
                      {isPositive ? "+" : ""}{data.changePercent.toFixed(2)}%
                    </span>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-3">
                <select
                  value={selectedSymbol}
                  onChange={(e) => selectSymbol(e.target.value)}
                  className="rounded-md border border-cyan-500/50 bg-slate-900 px-3 py-1.5 text-xs font-bold text-white focus:outline-none focus:border-cyan-400 transition shadow-lg cursor-pointer"
                >
                  <option value="NIFTY50">⚡ NIFTY 50</option>
                  <option value="BANKNIFTY">⚡ BANKNIFTY</option>
                </select>
                <div className="flex bg-slate-950 rounded-md border border-white/10 overflow-hidden">
                  {(["15m", "1h", "1d"] as const).map((tf) => (
                    <button
                      key={tf}
                      onClick={() => selectTimeframe(tf)}
                      className={`px-2 py-1 text-[10px] font-bold uppercase transition ${
                        timeframe === tf
                          ? "bg-cyan-500/20 text-cyan-300 border-b border-cyan-400"
                          : "text-slate-500 hover:text-slate-300"
                      }`}
                    >
                      {tf}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </GlassPanel>

          {/* Dashboard Terminal Grid */}
          {state !== "ready" || !data ? (
            <RequestStatePanel
              emptyDescription="No live streaming data could be resolved."
              emptyTitle="Price stream unavailable"
              loadingDescription="Connecting to backend Server-Sent Events (SSE) feed..."
              loadingTitle="Connecting to Live Stream..."
              state={state === "ready" ? "loading" : state}
              unavailableDescription="The backend streaming API is disconnected or unreachable."
              unavailableTitle="Stream disconnected"
            />
          ) : (
            <div className="grid grid-cols-12 gap-3 h-full min-h-0 pb-2">
              
              <div className="col-span-12 xl:col-span-3 flex flex-col gap-3 min-h-[500px] xl:min-h-0 overflow-y-auto custom-scrollbar pr-1">
                <div className="min-h-[180px] shrink-0">
                  <MarketWatch selectedSymbol={selectedSymbol} onSelect={selectSymbol} />
                </div>
                <div className="min-h-[160px] shrink-0">
                  <UpcomingEvents />
                </div>
              </div>

              {/* Middle Column (col-span-6) */}
              <div className="col-span-12 xl:col-span-6 flex flex-col gap-3 min-h-[400px] xl:min-h-0 overflow-y-auto custom-scrollbar pr-1">
                <div className="flex-1 relative min-h-[300px] shrink-0">
                   <DashboardChart key={selectedSymbol} symbol={selectedSymbol} />
                </div>
                <div className="shrink-0 h-[140px]">
                  <VolatilityHeatmap />
                </div>
              </div>

              {/* Right Column (col-span-3) */}
              <div className="col-span-12 xl:col-span-3 flex flex-col gap-3 min-h-[500px] xl:min-h-0 overflow-hidden">
                <div className="flex-1 min-h-[400px]">
                  <MiniBrainNews thoughts={thoughts} />
                </div>
              </div>

            </div>
          )}
        </Reveal>
      </div>
    </>
  );
}

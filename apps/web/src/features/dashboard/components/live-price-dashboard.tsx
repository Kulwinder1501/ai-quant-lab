"use client";

import { useEffect, useState, useCallback } from "react";
import { GlassPanel } from "../../../components/ui/glass-panel";
import { Reveal } from "../../../components/ui/reveal";
import { getApiV1Url, getResearchJson } from "../../research/api";
import { RequestStatePanel, type RequestState } from "../../research/components/request-state-panel";
import { MarketWatch } from "./market-watch";
import { InstitutionalContextCards } from "./institutional-context-cards";
import { VolatilityHeatmap } from "./volatility-heatmap";
import { DashboardChart } from "./dashboard-chart";
import { OptionChainMetrics } from "./option-chain-metrics";
import { AiBrainStream } from "./ai-brain-stream";
import { PerformanceScorecard } from "./performance-scorecard";
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
  change: number | null;
  changePercent: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  lastUpdated: string;
  indicators: {
    rsi: number | null;
    sma20: number | null;
    bollinger: {
      upper: number;
      middle: number;
      lower: number;
    } | null;
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

function displayNumber(value: number | null, fractionDigits = 2): string {
  return value === null
    ? "—"
    : value.toLocaleString("en-IN", {
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits,
      });
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
    const streamUrl = `${getApiV1Url()}/stream/live-agent?symbol=${selectedSymbol}&timeframe=${timeframe}`;
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
      <div className="flex flex-col flex-1 mt-2 font-sans">
        <Reveal className="flex flex-col w-full">
          <GlassPanel className="mb-3 p-4 border-white/10 bg-slate-900/60 shadow-lg shrink-0">
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
                      {data.changePercent === null ? "—" : `${isPositive ? "+" : ""}${data.changePercent.toFixed(2)}%`}
                    </span>
                    <div className="hidden lg:flex items-center gap-3 ml-3 border-l border-white/10 pl-3 text-xs text-slate-400 font-mono tracking-wider">
                      <span>O: <span className="text-slate-200">{displayNumber(data.open)}</span></span>
                      <span>H: <span className="text-slate-200">{displayNumber(data.high)}</span></span>
                      <span>L: <span className="text-slate-200">{displayNumber(data.low)}</span></span>
                      <span>C: <span className="text-slate-200">{data.livePrice.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span></span>
                    </div>
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
            /* Two stacked cards. Each grid cell is a fixed height so its panel
               scrolls internally instead of growing and pushing the page. */
            <div className="flex flex-col gap-4 pb-6">

              {/* Card 1: Market Watch + Upcoming Events | Chart + Heatmap */}
              <GlassPanel className="p-3 border-white/10 bg-slate-900/40">
                <div className="grid grid-cols-12 gap-3">
                  <div className="col-span-12 xl:col-span-4 flex h-[720px] flex-col gap-3">
                    <div className="flex-1 min-h-0">
                      <MarketWatch selectedSymbol={selectedSymbol} onSelect={selectSymbol} />
                    </div>
                    <div className="shrink-0">
                      <OptionChainMetrics symbol={selectedSymbol} />
                    </div>
                  </div>

                  <div className="col-span-12 xl:col-span-8 flex h-[720px] flex-col gap-3">
                    <div className="min-h-0 flex-1">
                      <DashboardChart key={selectedSymbol} symbol={selectedSymbol} />
                    </div>
                    <div className="h-[280px] shrink-0">
                      <VolatilityHeatmap selectedSymbol={selectedSymbol} />
                    </div>
                  </div>
                </div>
              </GlassPanel>

              {/* Institutional Context */}
              <InstitutionalContextCards />

              {/* Card 2: AI Brain */}
              <GlassPanel className="p-3 border-white/10 bg-slate-900/40">
                <div className="grid grid-cols-1 gap-3">
                  <div className="h-[720px]">
                    <AiBrainStream data={data} thoughts={thoughts} />
                  </div>
                </div>
              </GlassPanel>

              {/* Card 3: Model Journal & Performance */}
              <PerformanceScorecard
                metrics={metrics}
                reflections={reflections}
                perfPeriod={perfPeriod}
                setPerfPeriod={setPerfPeriod}
              />

            </div>
          )}
        </Reveal>
      </div>
    </>
  );
}

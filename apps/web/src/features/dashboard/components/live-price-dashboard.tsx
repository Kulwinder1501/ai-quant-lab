"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { GlassPanel } from "../../../components/ui/glass-panel";
import { Reveal } from "../../../components/ui/reveal";
import { apiV1Url, getResearchJson } from "../../research/api";
import { ReadOnlyBoundary } from "../../research/components/read-only-boundary";
import { RequestStatePanel, type RequestState } from "../../research/components/request-state-panel";
import { PageHeader } from "../../../components/layout/page-header";
import { PriceHeroCard } from "./price-hero-card";
import { AiBrainStream } from "./ai-brain-stream";
import { PerformanceScorecard } from "./performance-scorecard";
import { TechnicalIndicators } from "./technical-indicators";
import { InstitutionalContextCards } from "./institutional-context-cards";
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
      <PageHeader eyebrow="Autonomous Quant AI • Live Streaming"
      title="Real-Time Ticking Dashboard & AI Brain"
      description="Stream second-by-second market fluctuations over Server-Sent Events (SSE), watch our autonomous AI quant scan indicators & candlestick patterns in real time, and inspect its daily self-reflection win-rate scorecard."
      connectionLabel={isStreaming ? "⚡ LIVE SSE STREAM CONNECTED" : "Connecting Live Stream..."} />
      <div className="mt-10">
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
                  onChange={(e) => selectSymbol(e.target.value)}
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
                      onClick={() => selectTimeframe(tf)}
                      className={`rounded-lg px-3 py-1.5 text-xs font-bold uppercase transition ${
                        timeframe === tf
                          ? "bg-cyan-500 text-static-navy shadow-md shadow-cyan-500/20"
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

        {/* Institutional context. Rendered outside the price-stream conditional
            because FII/DII and GIFT Nifty are end-of-day data that do not depend
            on the SSE feed being connected. */}
        <div className="mb-8">
          <InstitutionalContextCards />
        </div>

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
            <PriceHeroCard data={data} isPositive={isPositive} />

            {/* 2. Autonomous Quant AI Brain & Action Stream */}
            <AiBrainStream data={data} thoughts={thoughts} />

            {/* 3. End-of-Day Success Rate & Self-Reflection Scorecard */}
            <PerformanceScorecard 
              metrics={metrics} 
              reflections={reflections} 
              perfPeriod={perfPeriod} 
              setPerfPeriod={setPerfPeriod} 
            />

            {/* 4. Technical Indicators Card Grid */}
            <TechnicalIndicators data={data} />

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
                  className="rounded-xl bg-gradient-to-r from-emerald-500 to-cyan-500 px-4 py-2 text-sm font-extrabold text-static-navy transition hover:brightness-110 shadow-lg shadow-emerald-500/20"
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
    </div>
    </>
  );
}

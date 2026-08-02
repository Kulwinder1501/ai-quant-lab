"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { GlassPanel } from "../../../components/ui/glass-panel";
import { Reveal } from "../../../components/ui/reveal";
import { getResearchJson, postResearchJson } from "../../research/api";
import { isAbortError } from "../../../lib/errors";
import { ReadOnlyBoundary } from "../../research/components/read-only-boundary";
import { RequestStatePanel, type RequestState } from "../../research/components/request-state-panel";
import { PageHeader } from "../../../components/layout/page-header";
import { SentimentSummary } from "./sentiment-summary";
import { NewsCard } from "./news-card";

export type NewsProvider = "MONEYCONTROL" | "ECONOMIC_TIMES" | "LIVEMINT" | "NSE" | "TIMES_OF_INDIA" | "BUSINESS_STANDARD" | "NDTV_PROFIT";
export type SentimentLabel = "BULLISH" | "BEARISH" | "NEUTRAL" | "HIGH_VOLATILITY";

export interface NewsArticle {
  id: string;
  provider: NewsProvider;
  title: string;
  description: string;
  url: string;
  publishedAt: string;
  sentimentScore: number;
  sentimentLabel: SentimentLabel;
  symbolsMentioned: string[];
}

interface SentimentSummary {
  averageScore: number;
  articleCount: number;
  bullishCount: number;
  bearishCount: number;
}

interface NewsResponse {
  data: {
    articles: NewsArticle[];
    sentimentSummary: SentimentSummary;
  };
}

const PROVIDERS: Array<{ label: string; value: string }> = [
  { label: "All Feeds", value: "" },
  { label: "LiveMint", value: "LIVEMINT" },
  { label: "Times of India", value: "TIMES_OF_INDIA" },
  { label: "Business Standard", value: "BUSINESS_STANDARD" },
  { label: "NDTV Profit", value: "NDTV_PROFIT" },
];

const SENTIMENTS: Array<{ label: string; value: string; color: string }> = [
  { label: "All Sentiments", value: "", color: "text-slate-300" },
  { label: "🟢 Bullish", value: "BULLISH", color: "text-emerald-400" },
  { label: "🔴 Bearish", value: "BEARISH", color: "text-rose-400" },
  { label: "⚡ High Volatility", value: "HIGH_VOLATILITY", color: "text-purple-400" },
  { label: "⚪ Neutral", value: "NEUTRAL", color: "text-slate-400" },
];

const SYMBOLS: Array<string> = ["ALL", "NIFTY50", "BANKNIFTY", "RELIANCE", "HDFCBANK", "INFY", "TATAPOWER", "COALINDIA"];

export function NewsDashboard() {
  const [state, setState] = useState<RequestState>("loading");
  const [articles, setArticles] = useState<NewsArticle[]>([]);
  const [summary, setSummary] = useState<SentimentSummary>({
    averageScore: 0,
    articleCount: 0,
    bullishCount: 0,
    bearishCount: 0,
  });
  const [providerFilter, setProviderFilter] = useState<string>("");
  const [sentimentFilter, setSentimentFilter] = useState<string>("");
  const [symbolFilter, setSymbolFilter] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());

  // Pure I/O: no state writes, so an effect can call it without cascading a render.
  const loadNews = useCallback(async (signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (providerFilter) params.append("provider", providerFilter);
    if (sentimentFilter) params.append("sentiment", sentimentFilter);
    if (symbolFilter && symbolFilter !== "ALL") params.append("symbol", symbolFilter);
    if (searchQuery.trim()) params.append("search", searchQuery.trim());
    params.append("limit", "50");

    return await getResearchJson(`/market-news?${params.toString()}`, signal) as NewsResponse;
  }, [providerFilter, sentimentFilter, symbolFilter, searchQuery]);

  const applyNews = useCallback((res: NewsResponse) => {
    const fetchedArticles = res.data?.articles || [];
    setArticles(fetchedArticles);
    if (res.data?.sentimentSummary) {
      setSummary(res.data.sentimentSummary);
    }
    setState(fetchedArticles.length > 0 ? "ready" : "empty");
    setLastRefreshed(new Date());
  }, []);

  const applyNewsError = useCallback((err: unknown) => {
    if (isAbortError(err)) return;
    setState("unavailable");
  }, []);

  const refreshNews = useCallback(
    () => loadNews().then(applyNews, applyNewsError),
    [loadNews, applyNews, applyNewsError],
  );

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void loadNews(signal).then((res) => {
      // A response that lands after the filters changed must not overwrite the
      // newer one already in flight.
      if (!signal.aborted) applyNews(res);
    }, applyNewsError);
    const timer = setInterval(() => {
      void refreshNews();
    }, 30000); // 30s UI auto-refresh
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [loadNews, applyNews, applyNewsError, refreshNews]);

  const handleManualRefresh = async () => {
    setIsRefreshing(true);
    try {
      await postResearchJson("/market-news/refresh");
      await refreshNews();
    } catch {
      // Ignore refresh error
    } finally {
      setIsRefreshing(false);
    }
  };

  const getCircuitBreakerStatus = () => {
    if (summary.articleCount === 0) return { label: "⚪ NEUTRAL MARKET (No Recent News)", color: "border-slate-700 bg-slate-900/50 text-slate-300" };
    if (summary.averageScore <= -0.7) {
      return { label: "🚨 CIRCUIT BREAKER RULE 3: PANIC EXIT ACTIVE (Score <= -0.7)", color: "border-rose-500/80 bg-rose-950/80 text-rose-200 animate-pulse" };
    }
    if (summary.averageScore <= -0.5) {
      return { label: "⚠️ CIRCUIT BREAKER RULE 1: NEW TRADE FREEZE ACTIVE (Score <= -0.5)", color: "border-orange-500/80 bg-orange-950/80 text-orange-200" };
    }
    if (summary.averageScore < -0.3) {
      return { label: "🛡️ CIRCUIT BREAKER RULE 2: STOP-LOSS TIGHTENED TO 0.5% (Score < -0.3)", color: "border-amber-500/80 bg-amber-950/80 text-amber-200" };
    }
    if (summary.averageScore >= 0.2) {
      return { label: "🟢 BULLISH MACRO SENTIMENT: AI CONFIDENCE +10% BOOST", color: "border-emerald-500/60 bg-emerald-950/60 text-emerald-300" };
    }
    return { label: "✅ NORMAL MARKET SENTIMENT (Standard Rules Active)", color: "border-cyan-500/40 bg-cyan-950/40 text-cyan-200" };
  };

  const cbStatus = getCircuitBreakerStatus();

  const connectionLabel = useMemo(() => ({
    loading: "Syncing RSS Feeds...",
    ready: "3-MIN RSS AUTO-SYNC",
    empty: "3-MIN RSS AUTO-SYNC",
    unavailable: "Feed API offline",
  })[state], [state]);

  return (
    <>
      <PageHeader connectionLabel={connectionLabel}
      description="Live financial RSS feed ingestion with quantitative lexicon scoring and autonomous agent emergency circuit breakers."
      eyebrow="REAL-TIME MACRO INTELLIGENCE"
      title="Market News & Sentiment Engine"
      unavailable={state === "unavailable"} />
      <div className="mt-10">
      <section className="mt-6">
        {state === "ready" || state === "empty" ? (
          <div className="space-y-8">
            {/* Macro Sentiment Gauge & Circuit Breaker Banner */}
            <SentimentSummary summary={summary} cbStatus={cbStatus} />

            {/* Filter Bar & Action Controls */}
            <Reveal delayMs={50}>
              <GlassPanel className="p-5">
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                  {/* Search Input */}
                  <div className="relative flex-1 max-w-md">
                    <input
                      type="text"
                      placeholder="Search keywords (e.g. RBI, HDFC, dividend, crash)..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full rounded-xl border border-white/10 bg-slate-900/80 px-4 py-2.5 text-sm text-slate-100 placeholder-slate-500 focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-400 transition"
                    />
                    {searchQuery && (
                      <button
                        onClick={() => setSearchQuery("")}
                        className="absolute right-3 top-2.5 text-slate-400 hover:text-slate-200 text-sm"
                      >
                        ✕
                      </button>
                    )}
                  </div>

                  {/* Refresh Action Button */}
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-slate-400 hidden sm:inline">
                      Last updated: {lastRefreshed.toLocaleTimeString()}
                    </span>
                    <button
                      onClick={handleManualRefresh}
                      disabled={isRefreshing}
                      className="inline-flex items-center gap-2 rounded-xl border border-cyan-500/30 bg-gradient-to-r from-cyan-500/20 to-blue-500/20 px-4 py-2 text-sm font-semibold text-cyan-200 hover:from-cyan-500/30 hover:to-blue-500/30 hover:border-cyan-400/50 transition disabled:opacity-50 shadow-lg shadow-cyan-500/10"
                    >
                      <span className={isRefreshing ? "animate-spin" : ""}>🔄</span>
                      {isRefreshing ? "Syncing Feeds..." : "Sync Feeds Now"}
                    </button>
                  </div>
                </div>

                {/* Pill Filters */}
                <div className="mt-5 flex flex-wrap items-center gap-2 pt-4 border-t border-white/5">
                  <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider mr-2">Provider:</span>
                  {PROVIDERS.map((p) => (
                    <button
                      key={p.value}
                      onClick={() => setProviderFilter(p.value)}
                      className={`rounded-lg px-3 py-1 text-xs font-medium transition ${
                        providerFilter === p.value
                          ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-sm"
                          : "bg-slate-900/50 text-slate-400 hover:bg-slate-800/80 hover:text-slate-200 border border-transparent"
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}

                  <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider ml-4 mr-2 hidden sm:inline">Sentiment:</span>
                  {SENTIMENTS.map((s) => (
                    <button
                      key={s.value}
                      onClick={() => setSentimentFilter(s.value)}
                      className={`rounded-lg px-3 py-1 text-xs font-medium transition ${
                        sentimentFilter === s.value
                          ? "bg-slate-800 text-white border border-slate-600 shadow-sm"
                          : "bg-slate-900/50 text-slate-400 hover:bg-slate-800/80 hover:text-slate-200 border border-transparent"
                      }`}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>

                {/* Symbol Pills */}
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider mr-2">Symbol:</span>
                  {SYMBOLS.map((sym) => (
                    <button
                      key={sym}
                      onClick={() => setSymbolFilter(sym)}
                      className={`rounded-md px-2.5 py-1 text-xs font-semibold transition ${
                        symbolFilter === sym
                          ? "bg-blue-600/30 text-blue-300 border border-blue-500/50"
                          : "bg-slate-950/60 text-slate-400 hover:bg-slate-900 hover:text-slate-200 border border-white/5"
                      }`}
                    >
                      {sym}
                    </button>
                  ))}
                </div>
              </GlassPanel>
            </Reveal>

            {/* Article Grid or Empty State Panel */}
            {articles.length > 0 ? (
              <Reveal delayMs={100}>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
                  {articles.map((art) => (
                    <NewsCard key={art.id} art={art} />
                  ))}
                </div>
              </Reveal>
            ) : (
              <RequestStatePanel
                emptyDescription="No financial RSS articles matched your current provider, sentiment, or keyword filter criteria."
                emptyTitle="No matching news articles"
                loadingDescription="The dashboard is querying the local API for rolling 12-hour news sentiment and RSS headlines. No trading or broker action occurs."
                loadingTitle="Loading Market News & Sentiment..."
                state="empty"
                unavailableDescription="Start the local API server and ensure background RSS ingestion is running. This dashboard does not invent news headlines while offline."
                unavailableTitle="News Feed API is unavailable"
              />
            )}

            <ReadOnlyBoundary
              badge="EXECUTION DISABLED"
              description="This screen can only inspect live RSS market news and rolling sentiment scores. It cannot create a trade idea, open or close a paper trade, connect to a broker, or place a real order."
              points={[
                "No broker controls",
                "No paper-trade controls",
                "No automatic execution",
                "Circuit breakers operate in backend agent",
              ]}
              title="Read-only news intelligence"
            />
          </div>
        ) : (
          <RequestStatePanel
            emptyDescription="No financial RSS articles matched your current provider, sentiment, or keyword filter criteria."
            emptyTitle="No news articles found"
            loadingDescription="The dashboard is querying the local API for rolling 12-hour news sentiment and RSS headlines. No trading or broker action occurs."
            loadingTitle="Loading Market News & Sentiment..."
            state={state}
            unavailableDescription="Start the local API server and ensure background RSS ingestion is running. This dashboard does not invent news headlines while offline."
            unavailableTitle="News Feed API is unavailable"
          />
        )}
      </section>
    </div>
    </>
  );
}

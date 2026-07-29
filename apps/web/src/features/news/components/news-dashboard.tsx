"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { GlassPanel } from "../../../components/ui/glass-panel";
import { Reveal } from "../../../components/ui/reveal";
import { getResearchJson, postResearchJson } from "../../research/api";
import { ReadOnlyBoundary } from "../../research/components/read-only-boundary";
import { RequestStatePanel, type RequestState } from "../../research/components/request-state-panel";
import { ResearchShell } from "../../research/components/research-shell";

export type NewsProvider = "MONEYCONTROL" | "ECONOMIC_TIMES" | "LIVEMINT" | "NSE";
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
  { label: "Moneycontrol", value: "MONEYCONTROL" },
  { label: "Economic Times", value: "ECONOMIC_TIMES" },
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

  const fetchNews = useCallback(async (signal?: AbortSignal) => {
    try {
      const params = new URLSearchParams();
      if (providerFilter) params.append("provider", providerFilter);
      if (sentimentFilter) params.append("sentiment", sentimentFilter);
      if (symbolFilter && symbolFilter !== "ALL") params.append("symbol", symbolFilter);
      if (searchQuery.trim()) params.append("search", searchQuery.trim());
      params.append("limit", "50");

      const res = await getResearchJson(`/market-news?${params.toString()}`, signal) as NewsResponse;
      if (signal?.aborted) return;

      const fetchedArticles = res.data?.articles || [];
      setArticles(fetchedArticles);
      if (res.data?.sentimentSummary) {
        setSummary(res.data.sentimentSummary);
      }
      setState(fetchedArticles.length > 0 ? "ready" : "empty");
      setLastRefreshed(new Date());
    } catch (err) {
      if (signal?.aborted) return;
      setState("unavailable");
    }
  }, [providerFilter, sentimentFilter, symbolFilter, searchQuery]);

  useEffect(() => {
    const controller = new AbortController();
    fetchNews(controller.signal);
    const timer = setInterval(() => {
      fetchNews();
    }, 30000); // 30s UI auto-refresh
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [fetchNews]);

  const handleManualRefresh = async () => {
    setIsRefreshing(true);
    try {
      await postResearchJson("/market-news/refresh");
      await fetchNews();
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
    <ResearchShell
      activeView="news"
      connectionLabel={connectionLabel}
      description="Live financial RSS feed ingestion with quantitative lexicon scoring and autonomous agent emergency circuit breakers."
      eyebrow="REAL-TIME MACRO INTELLIGENCE"
      title="Market News & Sentiment Engine"
      unavailable={state === "unavailable"}
    >
      <section className="mt-6">
        {state === "ready" || state === "empty" ? (
          <div className="space-y-8">
            {/* Macro Sentiment Gauge & Circuit Breaker Banner */}
            <Reveal>
              <div className={`rounded-2xl border p-5 shadow-2xl backdrop-blur-xl transition-all ${cbStatus.color}`}>
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">⚡</span>
                    <div>
                      <h2 className="text-base font-bold tracking-wide uppercase">System Defense Status</h2>
                      <p className="text-sm font-semibold mt-0.5">{cbStatus.label}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-6 text-right">
                    <div>
                      <span className="text-xs uppercase tracking-wider opacity-80 block">12H Rolling Sentiment</span>
                      <span className={`text-2xl font-black ${summary.averageScore > 0 ? "text-emerald-400" : summary.averageScore < 0 ? "text-rose-400" : "text-slate-300"}`}>
                        {summary.averageScore > 0 ? `+${summary.averageScore}` : summary.averageScore}
                      </span>
                    </div>
                    <div className="border-l border-white/10 pl-6 hidden sm:block">
                      <span className="text-xs uppercase tracking-wider opacity-80 block">Article Breakdown</span>
                      <span className="text-sm font-semibold">
                        <span className="text-emerald-400">{summary.bullishCount} Bull</span> / <span className="text-rose-400">{summary.bearishCount} Bear</span> ({summary.articleCount} Total)
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </Reveal>

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
                  {articles.map((art) => {
                    const isBull = art.sentimentLabel === "BULLISH";
                    const isBear = art.sentimentLabel === "BEARISH";
                    const isVol = art.sentimentLabel === "HIGH_VOLATILITY";

                    const badgeStyle = isBull
                      ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                      : isBear
                        ? "bg-rose-500/15 text-rose-300 border-rose-500/30"
                        : isVol
                          ? "bg-purple-500/15 text-purple-300 border-purple-500/30"
                          : "bg-slate-800/60 text-slate-300 border-slate-700";

                    const badgeText = isBull
                      ? `🟢 BULLISH (${art.sentimentScore > 0 ? "+" : ""}${art.sentimentScore})`
                      : isBear
                        ? `🔴 BEARISH (${art.sentimentScore})`
                        : isVol
                          ? `⚡ VOLATILE (${art.sentimentScore})`
                          : `⚪ NEUTRAL (${art.sentimentScore})`;

                    const providerName = art.provider === "MONEYCONTROL" ? "Moneycontrol" : art.provider === "ECONOMIC_TIMES" ? "Economic Times" : art.provider;
                    const pubDate = new Date(art.publishedAt);
                    const timeStr = !isNaN(pubDate.getTime())
                      ? pubDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + " · " + pubDate.toLocaleDateString([], { month: "short", day: "numeric" })
                      : "Recent";

                    return (
                      <div
                        key={art.id}
                        className="group relative flex flex-col justify-between rounded-2xl border border-white/10 bg-slate-950/50 p-5 backdrop-blur-md hover:border-cyan-500/40 hover:bg-slate-900/60 transition-all duration-300 shadow-xl"
                      >
                        <div>
                          {/* Top Header Row */}
                          <div className="flex items-center justify-between gap-2 mb-3">
                            <span className="inline-flex items-center rounded-full bg-white/5 px-2.5 py-0.5 text-[11px] font-semibold text-slate-300 border border-white/10">
                              {providerName}
                            </span>
                            <span className="text-[11px] font-medium text-slate-400">{timeStr}</span>
                          </div>

                          {/* Title */}
                          <h3 className="text-base font-bold text-slate-100 group-hover:text-cyan-300 transition-colors line-clamp-2 leading-snug">
                            {art.title}
                          </h3>

                          {/* Description */}
                          <p className="mt-3 text-xs md:text-sm text-slate-300/90 line-clamp-5 leading-relaxed font-normal">
                            {art.description}
                          </p>
                        </div>

                        {/* Footer Badges */}
                        <div className="mt-5 pt-4 border-t border-white/5 flex flex-wrap items-center justify-between gap-2">
                          <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold ${badgeStyle}`}>
                            {badgeText}
                          </span>

                          <div className="flex items-center gap-1">
                            {art.symbolsMentioned?.map((s) => (
                              <span
                                key={s}
                                className="rounded bg-cyan-950/50 px-1.5 py-0.5 text-[10px] font-bold text-cyan-400 border border-cyan-800/40"
                              >
                                {s}
                              </span>
                            ))}
                          </div>
                        </div>
                      </div>
                    );
                  })}
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
    </ResearchShell>
  );
}

"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { GlassPanel } from "../../../components/ui/glass-panel";
import { Reveal } from "../../../components/ui/reveal";
import { apiV1Url, getResearchJson, postResearchJson } from "../../research/api";
import { formatNumber, formatPercentage, formatTimestamp } from "../../research/presentation";
import { ResearchShell } from "../../research/components/research-shell";
import type { PaperAccountSummary, PaperAccountFullSummary, PaperTradeRow } from "../../paper-trading/domain";

interface LivePriceMap {
  [symbol: string]: {
    livePrice: number;
    change: number;
    changePercent: number;
    direction?: "UP" | "DOWN" | "NONE";
  };
}

// Robust quote resolver that matches index quotes regardless of formatting (spaces, NSE: prefix, case, etc.)
const resolveLiveQuote = (tradeSymbol?: string, quotes?: LivePriceMap) => {
  if (!quotes) return undefined;
  const s = (tradeSymbol || "").toUpperCase().replace(/\s+/g, "");
  if (s.includes("BANK")) {
    return quotes["BANKNIFTY"] || quotes["NSE:BANKNIFTY"] || quotes["NIFTYBANK"];
  }
  return quotes["NIFTY50"] || quotes["NSE:NIFTY50"] || quotes["NIFTY"];
};

export function PositionsDashboard() {
  const [accounts, setAccounts] = useState<PaperAccountSummary[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>("");
  const [summary, setSummary] = useState<PaperAccountFullSummary | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Live Price State for real-time PnL
  const [liveQuotes, setLiveQuotes] = useState<LivePriceMap>({});
  const [lastUpdated, setLastUpdated] = useState<string>("");
  const [isStreaming, setIsStreaming] = useState<boolean>(false);

  // Close trade modal state
  const [tradeToClose, setTradeToClose] = useState<PaperTradeRow | null>(null);
  const [closeExitPrice, setCloseExitPrice] = useState<number>(0);
  const [closeNotes, setCloseNotes] = useState<string>("Manually closed from Positions Monitor");
  const [closeLoading, setCloseLoading] = useState<boolean>(false);
  const [closeError, setCloseError] = useState<string | null>(null);

  // 1. Fetch Paper Accounts
  const fetchAccounts = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = (await getResearchJson("/paper-accounts", signal)) as { data: PaperAccountSummary[] };
      const list = res?.data || [];
      setAccounts(list);
      if (list.length > 0 && !selectedAccountId) {
        setSelectedAccountId(list[0].id);
      }
    } catch (err: any) {
      if (err.name !== "AbortError") {
        setError(err.message || "Failed to load paper trading accounts.");
      }
    }
  }, [selectedAccountId]);

  // 2. Fetch Account Summary (Open Trades)
  const fetchSummary = useCallback(async (accId: string, signal?: AbortSignal) => {
    if (!accId) return;
    setLoading(true);
    setError(null);
    try {
      const res = (await getResearchJson(`/paper-accounts/${accId}/summary`, signal)) as { data: PaperAccountFullSummary };
      if (res?.data) {
        setSummary(res.data);
      }
    } catch (err: any) {
      if (err.name !== "AbortError") {
        setError(err.message || "Failed to load active positions summary.");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // 3. Connect to Server-Sent Events (SSE) live ticking stream for real-time P&L & AI Execution
  useEffect(() => {
    setIsStreaming(false);
    const symbols = ["NIFTY50", "BANKNIFTY"];
    const sources = symbols.map((sym) => {
      const streamUrl = `${apiV1Url}/stream/live-agent?symbol=${sym}&timeframe=1d`;
      const es = new EventSource(streamUrl);
      es.onopen = () => setIsStreaming(true);
      es.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data);
          if (parsed?.symbol && parsed?.livePrice) {
            setLiveQuotes((prev) => {
              const oldPrice = prev[parsed.symbol]?.livePrice || parsed.livePrice;
              const newPrice = parsed.livePrice;
              let direction: "UP" | "DOWN" | "NONE" = prev[parsed.symbol]?.direction || "NONE";
              if (newPrice > oldPrice) direction = "UP";
              else if (newPrice < oldPrice) direction = "DOWN";
              return {
                ...prev,
                [parsed.symbol]: {
                  livePrice: newPrice,
                  change: parsed.change || 0,
                  changePercent: parsed.changePercent || 0,
                  direction,
                },
              };
            });
            setLastUpdated(new Date().toLocaleTimeString());
          }
        } catch {
          // Ignore stream parse errors
        }
      };
      return es;
    });

    return () => {
      sources.forEach((es) => es.close());
    };
  }, []);

  // 4. Fetch Live Quotes fallback & position refresh (every 3s)
  const fetchLiveQuotesFallback = useCallback(async () => {
    try {
      const [niftyRes, bankRes] = await Promise.all([
        getResearchJson("/live-price?symbol=NIFTY50") as Promise<any>,
        getResearchJson("/live-price?symbol=BANKNIFTY") as Promise<any>,
      ]);
      const newQuotes: Record<string, { livePrice: number; change: number; changePercent: number }> = {};
      if (niftyRes?.data) {
        newQuotes.NIFTY50 = {
          livePrice: niftyRes.data.livePrice,
          change: niftyRes.data.change,
          changePercent: niftyRes.data.changePercent,
        };
      }
      if (bankRes?.data) {
        newQuotes.BANKNIFTY = {
          livePrice: bankRes.data.livePrice,
          change: bankRes.data.change,
          changePercent: bankRes.data.changePercent,
        };
      }
      setLiveQuotes((prev) => {
        const updateWithDir = (sym: string, newQ?: { livePrice: number; change: number; changePercent: number }) => {
          if (!newQ) return prev[sym];
          const oldPrice = prev[sym]?.livePrice || newQ.livePrice;
          let direction: "UP" | "DOWN" | "NONE" = prev[sym]?.direction || "NONE";
          if (newQ.livePrice > oldPrice) direction = "UP";
          else if (newQ.livePrice < oldPrice) direction = "DOWN";
          return { ...newQ, direction };
        };
        return {
          ...prev,
          NIFTY50: updateWithDir("NIFTY50", newQuotes.NIFTY50),
          BANKNIFTY: updateWithDir("BANKNIFTY", newQuotes.BANKNIFTY),
        };
      });
      setLastUpdated(new Date().toLocaleTimeString());
    } catch {
      // Ignore fallback error
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchAccounts(controller.signal);
    return () => controller.abort();
  }, [fetchAccounts]);

  useEffect(() => {
    if (!selectedAccountId) return;
    const controller = new AbortController();
    fetchSummary(selectedAccountId, controller.signal);
    return () => controller.abort();
  }, [selectedAccountId, fetchSummary]);

  useEffect(() => {
    fetchLiveQuotesFallback();
    const quoteTimer = setInterval(fetchLiveQuotesFallback, 2000);
    const summaryTimer = setInterval(() => {
      if (selectedAccountId) fetchSummary(selectedAccountId);
    }, 3000);

    return () => {
      clearInterval(quoteTimer);
      clearInterval(summaryTimer);
    };
  }, [fetchLiveQuotesFallback, selectedAccountId, fetchSummary]);

  // Calculate Real-Time Live Portfolio Metrics across all open trades
  const livePortfolioStats = useMemo(() => {
    const openTrades = summary?.openTrades || [];
    let totalUnrealizedPnl = 0;
    let totalInvestedMargin = 0;
    let winningPositions = 0;
    let losingPositions = 0;

    openTrades.forEach((trade) => {
      const sym = trade.instrumentSymbol || "NIFTY50";
      const resolved = resolveLiveQuote(sym, liveQuotes);
      const currentPrice = resolved?.livePrice || trade.fillPrice;
      const isBuy = trade.side === "BUY";
      const priceDiff = isBuy ? currentPrice - trade.fillPrice : trade.fillPrice - currentPrice;
      const tradePnl = priceDiff * trade.quantity;

      totalUnrealizedPnl += tradePnl;
      totalInvestedMargin += trade.fillPrice * trade.quantity;

      if (tradePnl > 0) winningPositions++;
      else if (tradePnl < 0) losingPositions++;
    });

    const baseBalance = summary?.account.openingBalance || 1000000;
    const realizedPnl = summary?.metrics.realizedPnl || 0;
    const liveEquity = baseBalance + realizedPnl + totalUnrealizedPnl;
    const totalReturnPercent = baseBalance > 0 ? ((realizedPnl + totalUnrealizedPnl) / baseBalance) * 100 : 0;

    return {
      openCount: openTrades.length,
      totalUnrealizedPnl,
      totalInvestedMargin,
      winningPositions,
      losingPositions,
      liveEquity,
      totalReturnPercent,
    };
  }, [summary, liveQuotes]);

  const handleOpenCloseModal = (trade: PaperTradeRow) => {
    const sym = trade.instrumentSymbol || "NIFTY50";
    const resolved = resolveLiveQuote(sym, liveQuotes);
    const currentPrice = resolved?.livePrice || trade.fillPrice;
    setTradeToClose(trade);
    setCloseExitPrice(currentPrice);
    setCloseNotes(`Manually closed at ₹${currentPrice.toFixed(2)} from Positions Monitor`);
    setCloseError(null);
  };

  const handleConfirmCloseTrade = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tradeToClose || !selectedAccountId) return;
    setCloseLoading(true);
    setCloseError(null);
    try {
      await postResearchJson("/paper-trades/close", {
        paperTradeId: tradeToClose.id,
        exitPrice: Number(closeExitPrice),
        notes: closeNotes,
      });
      setTradeToClose(null);
      fetchSummary(selectedAccountId);
    } catch (err: any) {
      setCloseError(err.message || "Failed to close position.");
    } finally {
      setCloseLoading(false);
    }
  };
return (
    <ResearchShell
      activeView="positions"
      eyebrow="Autonomous AI Trading Lab"
      title="Live Positions & Real-Time P&L Monitor"
      description="Track open quantitative positions executed by the autonomous AI strategy engine. Real-time second-by-second Server-Sent Events (SSE) live valuation stream."
      connectionLabel={isStreaming ? `⚡ Live SSE Stream Active @ ${lastUpdated}` : lastUpdated ? `Live Ticks Updated @ ${lastUpdated}` : "Connecting Live SSE Feed..."}
    >
      <div className="space-y-6">
        {/* Account Selector & Control Bar */}
        <Reveal>
          <GlassPanel className="p-4 border-cyan-500/20 bg-gradient-to-r from-slate-950 via-slate-900 to-cyan-950/30 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className={`inline-flex h-3 w-3 rounded-full animate-pulse ${isStreaming ? "bg-emerald-400" : "bg-cyan-400"}`} />
              <label htmlFor="acc-select" className="text-xs font-bold text-slate-400 uppercase tracking-wider">
                Active Trading Account:
              </label>
              <select
                id="acc-select"
                value={selectedAccountId}
                onChange={(e) => setSelectedAccountId(e.target.value)}
                className="bg-slate-900 border border-cyan-500/30 rounded-xl px-4 py-2 text-sm font-bold text-white focus:outline-none focus:border-cyan-400"
              >
                {accounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    {acc.name} (₹{formatNumber(acc.openingBalance, 0)})
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-4 text-xs">
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 font-bold">
                <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                <span>AI Brain: ONLINE &amp; EVALUATING</span>
              </div>
            </div>
          </GlassPanel>
        </Reveal>

        {error && (
          <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-200 text-sm font-semibold">
            {error}
          </div>
        )}

        {/* Real-Time Live Portfolio Overview Cards */}
        <Reveal delayMs={100}>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <GlassPanel className="p-5 border-cyan-500/30 bg-gradient-to-br from-slate-950 via-slate-900 to-cyan-950/20">
              <span className="text-xs font-extrabold text-cyan-400 uppercase tracking-wider">Live Portfolio Equity</span>
              <div className="mt-2 text-2xl font-black text-white">
                ₹{formatNumber(livePortfolioStats.liveEquity, 2)}
              </div>
              <p className="mt-1 text-xs text-slate-400">
                Total Return: <span className={livePortfolioStats.totalReturnPercent >= 0 ? "text-emerald-400 font-bold" : "text-rose-400 font-bold"}>
                  {formatPercentage(livePortfolioStats.totalReturnPercent / 100)}
                </span>
              </p>
            </GlassPanel>

            <GlassPanel className={`p-5 border-white/10 transition-colors duration-500 ${livePortfolioStats.totalUnrealizedPnl >= 0 ? "bg-emerald-950/20 border-emerald-500/30" : "bg-rose-950/20 border-rose-500/30"}`}>
              <span className="text-xs font-extrabold text-slate-400 uppercase tracking-wider">Live Unrealized P&amp;L</span>
              <div className={`mt-2 text-2xl font-black transition-colors duration-300 ${livePortfolioStats.totalUnrealizedPnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                {livePortfolioStats.totalUnrealizedPnl >= 0 ? "+" : ""}₹{formatNumber(livePortfolioStats.totalUnrealizedPnl, 2)}
              </div>
              <p className="mt-1 text-xs text-slate-400">
                Active Open Trades: <strong className="text-white">{livePortfolioStats.openCount}</strong>
              </p>
            </GlassPanel>

            <GlassPanel className="p-5 border-white/10 bg-slate-950/60">
              <span className="text-xs font-extrabold text-slate-400 uppercase tracking-wider">Position Win / Loss Ratio</span>
              <div className="mt-2 flex items-baseline gap-2 text-2xl font-black text-white">
                <span className="text-emerald-400">{livePortfolioStats.winningPositions} W</span>
                <span className="text-slate-600">/</span>
                <span className="text-rose-400">{livePortfolioStats.losingPositions} L</span>
              </div>
              <p className="mt-1 text-xs text-slate-400">Current live ticking performance</p>
            </GlassPanel>

            <GlassPanel className="p-5 border-white/10 bg-slate-950/60">
              <span className="text-xs font-extrabold text-slate-400 uppercase tracking-wider">Invested Capital Margin</span>
              <div className="mt-2 text-2xl font-black text-white">
                ₹{formatNumber(livePortfolioStats.totalInvestedMargin, 0)}
              </div>
              <p className="mt-1 text-xs text-slate-400">Total simulated capital deployed</p>
            </GlassPanel>
          </div>
        </Reveal>

        {/* Active AI Positions Table */}
        <Reveal delayMs={200}>
          <GlassPanel className="p-6 border-white/10">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h3 className="text-lg font-extrabold text-white flex items-center gap-2">
                  <span>🤖 AI Active Open Positions</span>
                  <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                    {summary?.openTrades.length || 0} Trades Running
                  </span>
                  {isStreaming && (
                    <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 animate-pulse">
                      ● Live SSE Ticking
                    </span>
                  )}
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  The AI Autonomous Agent continuously evaluates these positions against real-time RSI and Bollinger Band envelopes.
                </p>
              </div>
              <button
                type="button"
                onClick={() => selectedAccountId && fetchSummary(selectedAccountId)}
                className="px-3.5 py-1.5 rounded-xl text-xs font-bold text-slate-300 bg-slate-900 hover:bg-slate-800 border border-white/10 transition flex items-center gap-1.5"
              >
                <span>🔄 Refresh Positions</span>
              </button>
            </div>

            {loading && !summary ? (
              <div className="py-12 text-center text-sm font-semibold text-slate-400">
                <span className="inline-block h-6 w-6 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin mb-3" />
                <p>Loading open positions and calculating live valuations...</p>
              </div>
            ) : (summary?.openTrades.length || 0) === 0 ? (
              <div className="py-16 text-center rounded-2xl border border-dashed border-white/10 bg-slate-950/40 p-8">
                <span className="text-3xl">📭</span>
                <p className="mt-3 text-base font-bold text-white">No Active Open Positions Right Now</p>
                <p className="mt-1 text-xs text-slate-400 max-w-md mx-auto">
                  The AI Autonomous Agent is scanning NIFTY 50 and BANK NIFTY for high-confidence multi-modal setups (≥80% confidence). When a trade is triggered, it will appear here instantly.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-white/10 text-xs font-bold uppercase tracking-wider text-slate-400">
                      <th className="py-3 px-4">Instrument</th>
                      <th className="py-3 px-4">Side</th>
                      <th className="py-3 px-4">Qty</th>
                      <th className="py-3 px-4">Entry Price</th>
                      <th className="py-3 px-4">Live Price</th>
                      <th className="py-3 px-4">Live P&amp;L (₹)</th>
                      <th className="py-3 px-4">Return %</th>
                      <th className="py-3 px-4">AI Strategy / Notes</th>
                      <th className="py-3 px-4">Opened At</th>
                      <th className="py-3 px-4 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5 text-sm font-medium">
                    {summary?.openTrades.map((trade) => {
                      const sym = trade.instrumentSymbol || "NIFTY50";
                      const quote = resolveLiveQuote(sym, liveQuotes);
                      const currentPrice = quote?.livePrice || trade.fillPrice;
                      const direction = quote?.direction || "NONE";
                      const isBuy = trade.side === "BUY";
                      const priceDiff = isBuy ? currentPrice - trade.fillPrice : trade.fillPrice - currentPrice;
                      const livePnl = priceDiff * trade.quantity;
                      const liveRet = ((livePnl / (trade.fillPrice * trade.quantity)) * 100);
                      const isWinning = livePnl >= 0;

                      return (
                        <tr key={trade.id} className="hover:bg-white/[0.03] transition">
                          <td className="py-4 px-4 font-extrabold text-white">
                            <div className="flex items-center gap-2">
                              <span className="h-2 w-2 rounded-full bg-cyan-400"></span>
                              <span>{sym}</span>
                            </div>
                            <span className="block text-[11px] font-mono font-normal text-slate-400 mt-0.5">
                              ID: {trade.id.substring(0, 8)}...
                            </span>
                          </td>
                          <td className="py-4 px-4">
                            <span className={`inline-flex px-2.5 py-1 rounded-md text-xs font-black ${
                              isBuy ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30" : "bg-rose-500/20 text-rose-300 border border-rose-500/30"
                            }`}>
                              {trade.side}
                            </span>
                          </td>
                          <td className="py-4 px-4 font-bold text-slate-200">{formatNumber(trade.quantity, 0)}</td>
                          <td className="py-4 px-4 font-semibold text-slate-300">₹{formatNumber(trade.fillPrice, 2)}</td>
                          <td className="py-4 px-4 font-black text-white">
                            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg transition-colors duration-300 ${
                              direction === "UP" ? "bg-emerald-500/25 text-emerald-200 border border-emerald-500/40 shadow-sm shadow-emerald-500/10" :
                              direction === "DOWN" ? "bg-rose-500/25 text-rose-200 border border-rose-500/40 shadow-sm shadow-rose-500/10" :
                              "bg-slate-900 text-white border border-white/10"
                            }`}>
                              ₹{formatNumber(currentPrice, 2)}
                              <span className={`text-[10px] ${direction === "UP" ? "text-emerald-400 animate-bounce" : direction === "DOWN" ? "text-rose-400 animate-bounce" : "text-cyan-400 animate-pulse"}`}>
                                {direction === "UP" ? "▲" : direction === "DOWN" ? "▼" : "●"}
                              </span>
                            </span>
                          </td>
                          <td className="py-4 px-4">
                            <span className={`inline-flex px-2.5 py-1 rounded-lg text-xs font-black transition-colors duration-300 ${
                              isWinning
                                ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm shadow-emerald-500/10"
                                : "bg-rose-500/20 text-rose-300 border border-rose-500/40 shadow-sm shadow-rose-500/10"
                            }`}>
                              {isWinning ? "+" : ""}₹{formatNumber(livePnl, 2)}
                            </span>
                          </td>
                          <td className="py-4 px-4 font-extrabold">
                            <span className={`transition-colors duration-300 ${isWinning ? "text-emerald-400" : "text-rose-400"}`}>
                              {isWinning ? "+" : ""}{liveRet.toFixed(2)}%
                            </span>
                          </td>
                          <td className="py-4 px-4 max-w-[200px] truncate text-slate-400 text-xs">
                            <div className="flex flex-col gap-1">
                              <span className={`inline-flex self-start px-2 py-0.5 rounded text-[10px] font-bold ${
                                trade.timeframe === "1m" 
                                  ? "bg-purple-500/20 text-purple-300 border border-purple-500/30" 
                                  : "bg-blue-500/20 text-blue-300 border border-blue-500/30"
                              }`}>
                                {trade.timeframe === "1m" ? "momentum-scalp" : "trend-breakout"}
                              </span>
                              <span title={trade.notes || "Opened via AI Agent"}>
                                {trade.notes || "Opened via AI Agent"}
                              </span>
                            </div>
                          </td>
                          <td className="py-4 px-4 text-xs font-mono text-slate-400">{formatTimestamp(trade.openedAt)}</td>
                          <td className="py-4 px-4 text-right">
                            <button
                              type="button"
                              onClick={() => handleOpenCloseModal(trade)}
                              className="px-3.5 py-1.5 rounded-xl text-xs font-extrabold bg-rose-500/20 text-rose-200 hover:bg-rose-500/30 border border-rose-500/40 transition shadow-sm shadow-rose-500/10"
                            >
                              ⚡ Close Trade
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </GlassPanel>
        </Reveal>

        {/* Close Trade Modal */}
        {tradeToClose && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-md">
            <GlassPanel className="w-full max-w-md p-6 border-cyan-500/40 shadow-2xl">
              <div className="flex items-center justify-between border-b border-white/10 pb-3">
                <h3 className="text-base font-extrabold text-white flex items-center gap-2">
                  <span>⚡ Manually Close AI Position</span>
                </h3>
                <button
                  type="button"
                  onClick={() => setTradeToClose(null)}
                  className="text-slate-400 hover:text-white font-bold text-lg"
                >
                  ×
                </button>
              </div>

              <form onSubmit={handleConfirmCloseTrade} className="mt-4 space-y-4">
                <div className="p-3 rounded-xl bg-slate-950/80 border border-white/5 text-xs text-slate-300 space-y-1">
                  <div>Instrument: <strong className="text-white">{tradeToClose.instrumentSymbol || "NIFTY50"}</strong></div>
                  <div>Side &amp; Qty: <strong className="text-cyan-300">{tradeToClose.side} {tradeToClose.quantity} Qty</strong></div>
                  <div>Entry Price: <strong className="text-white">₹{formatNumber(tradeToClose.fillPrice, 2)}</strong></div>
                </div>

                <div>
                  <label htmlFor="exit-price" className="block text-xs font-bold text-slate-300 mb-1">
                    Exit Price (₹):
                  </label>
                  <input
                    id="exit-price"
                    type="number"
                    step="0.05"
                    required
                    value={closeExitPrice}
                    onChange={(e) => setCloseExitPrice(Number(e.target.value))}
                    className="w-full rounded-xl bg-slate-950 border border-white/20 px-3 py-2 text-sm font-bold text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  />
                  <p className="mt-1 text-[11px] text-slate-500">Pre-filled with latest market valuation.</p>
                </div>

                <div>
                  <label htmlFor="close-notes" className="block text-xs font-bold text-slate-300 mb-1">
                    Exit Reason / Notes:
                  </label>
                  <input
                    id="close-notes"
                    type="text"
                    value={closeNotes}
                    onChange={(e) => setCloseNotes(e.target.value)}
                    className="w-full rounded-xl bg-slate-950 border border-white/20 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  />
                </div>

                {closeError && (
                  <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-200 text-xs font-semibold">
                    {closeError}
                  </div>
                )}

                <div className="flex justify-end gap-3 pt-2 border-t border-white/10">
                  <button
                    type="button"
                    onClick={() => setTradeToClose(null)}
                    className="px-4 py-2 rounded-xl text-xs font-bold text-slate-300 bg-slate-900 hover:bg-slate-800 transition"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={closeLoading}
                    className="px-5 py-2 rounded-xl text-xs font-extrabold text-white bg-gradient-to-r from-rose-500 to-red-600 hover:from-rose-400 hover:to-red-500 transition shadow-lg shadow-rose-500/20 disabled:opacity-50 flex items-center gap-2"
                  >
                    {closeLoading ? "Closing..." : "⚡ Confirm Exit Position"}
                  </button>
                </div>
              </form>
            </GlassPanel>
          </div>
        )}
      </div>
    </ResearchShell>
  );
}

"use client";

import { useEffect, useState, useCallback, useMemo, type ReactNode } from "react";
import { GlassPanel } from "../../../components/ui/glass-panel";
import { Reveal } from "../../../components/ui/reveal";
import { apiV1Url, getResearchJson, postResearchJson } from "../../research/api";
import { formatNumber } from "../../research/presentation";
import { errorMessage, isAbortError } from "../../../lib/errors";
import { PageHeader } from "../../../components/layout/page-header";

import type { PaperAccountSummary, PaperAccountFullSummary, PaperTradeRow } from "../../paper-trading/domain";
import { LivePortfolioMetrics } from "./live-portfolio-metrics";
import { ActivePositionsTable, resolveLiveQuote } from "./active-positions-table";
import type { LiveQuote, LiveQuoteMap } from "./active-positions-table";
import { CloseTradeModal } from "./close-trade-modal";

interface LivePriceResponse {
  data?: {
    livePrice: number;
    change: number;
    changePercent: number;
  };
}

export function PositionsDashboard({ navigation }: { navigation?: ReactNode } = {}) {
  const [accounts, setAccounts] = useState<PaperAccountSummary[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>("");
  const [summary, setSummary] = useState<PaperAccountFullSummary | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Live Price State for real-time PnL
  const [liveQuotes, setLiveQuotes] = useState<LiveQuoteMap>({});
  const [lastUpdated, setLastUpdated] = useState<string>("");
  const [isStreaming, setIsStreaming] = useState<boolean>(false);

  // Close trade modal state
  const [tradeToClose, setTradeToClose] = useState<PaperTradeRow | null>(null);
  const [closeExitPrice, setCloseExitPrice] = useState<number>(0);
  const [closeNotes, setCloseNotes] = useState<string>("Manually closed from Positions Monitor");
  const [closeLoading, setCloseLoading] = useState<boolean>(false);
  const [closeError, setCloseError] = useState<string | null>(null);

  // 1. Fetch Paper Accounts. Pure I/O: no state writes, so an effect can call it
  // without cascading a render.
  const loadAccounts = useCallback(async (signal?: AbortSignal) => {
    const res = (await getResearchJson("/paper-accounts", signal)) as { data?: PaperAccountSummary[] };
    return res?.data || [];
  }, []);

  const applyAccounts = useCallback((list: PaperAccountSummary[]) => {
    setAccounts(list);
    if (list.length > 0 && !selectedAccountId) {
      setSelectedAccountId(list[0].id);
    }
  }, [selectedAccountId]);

  const applyAccountsError = useCallback((err: unknown) => {
    if (isAbortError(err)) return;
    setError(errorMessage(err, "Failed to load paper trading accounts."));
  }, []);

  // 2. Fetch Account Summary (Open Trades)
  const loadSummary = useCallback(async (accId: string, signal?: AbortSignal) => {
    const res = (await getResearchJson(`/paper-accounts/${accId}/summary`, signal)) as { data?: PaperAccountFullSummary };
    return res?.data;
  }, []);

  const applySummary = useCallback((data?: PaperAccountFullSummary) => {
    if (data) {
      setSummary(data);
    }
    setError(null);
    setLoading(false);
  }, []);

  const applySummaryError = useCallback((err: unknown) => {
    if (isAbortError(err)) return;
    setError(errorMessage(err, "Failed to load active positions summary."));
    setLoading(false);
  }, []);

  const refreshSummary = useCallback(() => {
    if (!selectedAccountId) return;
    setLoading(true);
    void loadSummary(selectedAccountId).then(applySummary, applySummaryError);
  }, [selectedAccountId, loadSummary, applySummary, applySummaryError]);

  // 3. Connect to Server-Sent Events (SSE) live ticking stream for real-time P&L & AI Execution
  useEffect(() => {
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
  const loadLiveQuotes = useCallback(async () => {
    const [niftyRes, bankRes] = (await Promise.all([
      getResearchJson("/live-price?symbol=NIFTY50"),
      getResearchJson("/live-price?symbol=BANKNIFTY"),
    ])) as [LivePriceResponse, LivePriceResponse];
    const newQuotes: Record<string, LiveQuote> = {};
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
    return newQuotes;
  }, []);

  const applyLiveQuotes = useCallback((newQuotes: Record<string, LiveQuote>) => {
    setLiveQuotes((prev) => {
      const updateWithDir = (sym: string, newQ?: LiveQuote) => {
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
  }, []);

  /** The SSE stream is the primary feed, so a failed fallback poll waits for the next tick. */
  const ignoreLiveQuotesError = useCallback(() => undefined, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadAccounts(controller.signal).then(applyAccounts, applyAccountsError);
    return () => controller.abort();
  }, [loadAccounts, applyAccounts, applyAccountsError]);

  useEffect(() => {
    if (!selectedAccountId) return;
    const controller = new AbortController();
    void loadSummary(selectedAccountId, controller.signal).then(applySummary, applySummaryError);
    return () => controller.abort();
  }, [selectedAccountId, loadSummary, applySummary, applySummaryError]);

  useEffect(() => {
    void loadLiveQuotes().then(applyLiveQuotes, ignoreLiveQuotesError);
    const quoteTimer = setInterval(() => {
      void loadLiveQuotes().then(applyLiveQuotes, ignoreLiveQuotesError);
    }, 2000);
    const summaryTimer = setInterval(refreshSummary, 3000);

    return () => {
      clearInterval(quoteTimer);
      clearInterval(summaryTimer);
    };
  }, [loadLiveQuotes, applyLiveQuotes, ignoreLiveQuotesError, refreshSummary]);

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
      refreshSummary();
    } catch (err: unknown) {
      setCloseError(errorMessage(err, "Failed to close position."));
    } finally {
      setCloseLoading(false);
    }
  };
return (
    <>
      <PageHeader eyebrow="Autonomous AI Trading Lab"
      title="Live Positions & Real-Time P&L Monitor"
      description="Track open quantitative positions executed by the autonomous AI strategy engine. Real-time second-by-second Server-Sent Events (SSE) live valuation stream."
      connectionLabel={isStreaming ? `⚡ Live SSE Stream Active @ ${lastUpdated}` : lastUpdated ? `Live Ticks Updated @ ${lastUpdated}` : "Connecting Live SSE Feed..."} />
      <div className="mt-10">
      <div className="space-y-6">
        {navigation && <Reveal>{navigation}</Reveal>}

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
          <LivePortfolioMetrics livePortfolioStats={livePortfolioStats} />
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
                onClick={refreshSummary}
                className="px-3.5 py-1.5 rounded-xl text-xs font-bold text-slate-300 bg-slate-900 hover:bg-slate-800 border border-white/10 transition flex items-center gap-1.5"
              >
                <span>🔄 Refresh Positions</span>
              </button>
            </div>

            <ActivePositionsTable 
              summary={summary}
              loading={loading}
              liveQuotes={liveQuotes}
              handleOpenCloseModal={handleOpenCloseModal}
            />
          </GlassPanel>
        </Reveal>

        {/* Close Trade Modal */}
        <CloseTradeModal
          tradeToClose={tradeToClose}
          setTradeToClose={setTradeToClose}
          closeExitPrice={closeExitPrice}
          setCloseExitPrice={setCloseExitPrice}
          closeNotes={closeNotes}
          setCloseNotes={setCloseNotes}
          closeError={closeError}
          closeLoading={closeLoading}
          onSubmit={handleConfirmCloseTrade}
        />
      </div>
    </div>
    </>
  );
}

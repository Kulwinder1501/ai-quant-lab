"use client";

import { useEffect, useState, useCallback } from "react";
import { GlassPanel } from "../../../components/ui/glass-panel";
import { Reveal } from "../../../components/ui/reveal";
import { getResearchJson, postResearchJson } from "../../research/api";
import { formatNumber, formatTimestamp } from "../../research/presentation";
import { PageHeader } from "../../../components/layout/page-header";
import type { PaperAccountSummary, PaperAccountFullSummary, PaperTradeRow } from "../domain";
import { EquityMetrics } from "./equity-metrics";
import { ActivePositionsTable } from "./active-positions-table";
import { TradeHistoryTable } from "./trade-history-table";
import { CreateAccountModal } from "./create-account-modal";
import { OpenTradeModal } from "./open-trade-modal";
import { CloseTradeModal } from "./close-trade-modal";
export interface TradeIdeaOption {
  id: string;
  instrumentSymbol: string;
  instrumentName: string;
  side: string;
  entryPrice: number;
  stopLoss: number;
  targetPrice: number;
  confidence: number;
  candleTimeframe?: string;
}

export function PaperTradingDashboard() {
  const [accounts, setAccounts] = useState<PaperAccountSummary[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>("");
  const [summary, setSummary] = useState<PaperAccountFullSummary | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Actions state
  const [evaluating, setEvaluating] = useState<boolean>(false);
  const [evalMessage, setEvalMessage] = useState<string | null>(null);

  // Modals state
  const [showCreateModal, setShowCreateModal] = useState<boolean>(false);
  const [newAccountName, setNewAccountName] = useState<string>("Alpha Simulation Fund");
  const [newAccountBalance, setNewAccountBalance] = useState<number>(1000000);
  const [createError, setCreateError] = useState<string | null>(null);

  const [showOpenModal, setShowOpenModal] = useState<boolean>(false);
  const [tradeIdeas, setTradeIdeas] = useState<TradeIdeaOption[]>([]);
  const [selectedIdeaId, setSelectedIdeaId] = useState<string>("");
  const [openFillPrice, setOpenFillPrice] = useState<number>(0);
  const [openLots, setOpenLots] = useState<number>(1);
  const [openOrderType, setOpenOrderType] = useState<"MARKET" | "PENDING">("MARKET");
  const [openNotes, setOpenNotes] = useState<string>("Opened from Paper Trading UI");
  const [openExpiryDate, setOpenExpiryDate] = useState("");
  const [openError, setOpenError] = useState<string | null>(null);

  const [showCloseModal, setShowCloseModal] = useState<boolean>(false);
  const [tradeToClose, setTradeToClose] = useState<PaperTradeRow | null>(null);
  const [closeExitPrice, setCloseExitPrice] = useState<number>(0);
  const [closeNotes, setCloseNotes] = useState<string>("Manually closed from UI");
  const [closeError, setCloseError] = useState<string | null>(null);

  const fetchAccounts = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await getResearchJson("/paper-accounts", signal) as { data: PaperAccountSummary[] };
      const list = res.data || [];
      setAccounts(list);
      if (list.length > 0 && !selectedAccountId) {
        setSelectedAccountId(list[0].id);
      }
    } catch (err: any) {
      if (err.name !== "AbortError") {
        setError(err.message || "Failed to load paper accounts.");
      }
    }
  }, [selectedAccountId]);

  const fetchSummary = useCallback(async (accId: string, signal?: AbortSignal) => {
    if (!accId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await getResearchJson(`/paper-accounts/${accId}/summary`, signal) as { data: PaperAccountFullSummary };
      setSummary(res.data);
    } catch (err: any) {
      if (err.name !== "AbortError") {
        setError(err.message || "Failed to load account summary.");
      }
    } finally {
      setLoading(false);
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

  const handleCreateAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateError(null);
    try {
      const res = await postResearchJson("/paper-accounts", {
        name: newAccountName,
        openingBalance: Number(newAccountBalance),
      }) as { data: PaperAccountSummary };
      setShowCreateModal(false);
      setAccounts((prev) => [...prev, res.data]);
      setSelectedAccountId(res.data.id);
    } catch (err: any) {
      setCreateError(err.message || "Failed to create account.");
    }
  };

  const handleEvaluateTrades = async () => {
    if (!selectedAccountId) return;
    setEvaluating(true);
    setEvalMessage(null);
    try {
      const res = await postResearchJson("/paper-trades/evaluate", { accountId: selectedAccountId }) as {
        data: { openTradesRead: number; eligibleCandlesRead: number; tradesClosed: number };
      };
      setEvalMessage(`Evaluated ${res.data.openTradesRead} open trades against ${res.data.eligibleCandlesRead} historical candles. Closed ${res.data.tradesClosed} trades based on stop-loss/take-profit rules.`);
      await fetchSummary(selectedAccountId);
    } catch (err: any) {
      setEvalMessage(`Error evaluating trades: ${err.message}`);
    } finally {
      setEvaluating(false);
    }
  };

  const openTradeModalWithIdeas = async () => {
    setShowOpenModal(true);
    setOpenError(null);
    try {
      const res = await getResearchJson("/trade-ideas?limit=20") as { data: TradeIdeaOption[] };
      const list = res.data || [];
      setTradeIdeas(list);
      if (list.length > 0) {
        const first = list[0];
        setSelectedIdeaId(first.id);
        setOpenFillPrice(first.entryPrice || 0);
      }
    } catch (err) {
      // ignore
    }
  };

  const handleIdeaSelectionChange = (id: string) => {
    setSelectedIdeaId(id);
    const found = tradeIdeas.find((i) => i.id === id);
    if (found) {
      setOpenFillPrice(found.entryPrice || 0);
    }
  };

  const handleOpenTradeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAccountId || !selectedIdeaId) return;
    setOpenError(null);
    try {
      await postResearchJson("/paper-trades/open", {
        accountId: selectedAccountId,
        tradeIdeaId: selectedIdeaId,
        fillPrice: Number(openFillPrice),
        lots: Number(openLots),
        notes: openNotes,
        orderType: openOrderType,
        asOptionBuyer: true,
        expiryDate: openExpiryDate,
      });
      setShowOpenModal(false);
      await fetchSummary(selectedAccountId);
    } catch (err: any) {
      setOpenError(err.message || "Failed to open simulated trade.");
    }
  };

  const openCloseTradeModal = (trade: PaperTradeRow) => {
    setTradeToClose(trade);
    setCloseExitPrice(trade.fillPrice);
    setCloseNotes("Closed from UI");
    setCloseError(null);
    setShowCloseModal(true);
  };

  const handleCloseTradeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tradeToClose) return;
    setCloseError(null);
    try {
      await postResearchJson("/paper-trades/close", {
        paperTradeId: tradeToClose.id,
        exitPrice: Number(closeExitPrice),
        notes: closeNotes,
      });
      setShowCloseModal(false);
      setTradeToClose(null);
      if (selectedAccountId) {
        await fetchSummary(selectedAccountId);
      }
    } catch (err: any) {
      setCloseError(err.message || "Failed to close trade.");
    }
  };

  const metrics = summary?.metrics || {
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    winRatePercent: 0,
    realizedPnl: 0,
    unrealizedPnl: 0,
    equity: accounts.find((a) => a.id === selectedAccountId)?.openingBalance || 0,
  };

  return (
    <>
      <PageHeader eyebrow="Quantitative Sandbox"
      title="Simulated Portfolio & Execution"
      description="Test quantitative strategies with real-time simulated order execution, automated exit rules, and zero financial risk."
      connectionLabel="Sandbox Ready" />
      <div className="mt-10">
      <div className="space-y-6">
        {/* Control Bar */}
        <Reveal>
          <GlassPanel className="p-4 border-cyan-500/20 bg-gradient-to-r from-slate-950 via-slate-900 to-cyan-950/30 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 bg-slate-950/80 rounded-xl px-3 py-1.5 border border-white/10">
                <span className="h-2 w-2 rounded-full bg-cyan-400 animate-pulse" />
                <label htmlFor="acc-select" className="text-xs font-semibold text-slate-400">
                  Active Fund:
                </label>
                <select
                  id="acc-select"
                  value={selectedAccountId}
                  onChange={(e) => setSelectedAccountId(e.target.value)}
                  className="bg-transparent text-sm font-semibold text-white focus:outline-none focus:ring-2 focus:ring-cyan-400 cursor-pointer"
                >
                  {accounts.map((acc) => (
                    <option key={acc.id} value={acc.id} className="bg-slate-900 text-white">
                      {acc.name} (₹{formatNumber(acc.openingBalance, 0)})
                    </option>
                  ))}
                  {accounts.length === 0 && (
                    <option value="" className="bg-slate-900 text-slate-400">No portfolios found</option>
                  )}
                </select>
              </div>

              <button
                type="button"
                onClick={() => setShowCreateModal(true)}
                className="px-3.5 py-2 rounded-xl text-xs font-semibold text-cyan-200 bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-400/30 transition shadow-sm flex items-center gap-1.5"
              >
                <span>+ Create Portfolio</span>
              </button>
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleEvaluateTrades}
                disabled={evaluating || !selectedAccountId}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-emerald-200 bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-400/30 transition disabled:opacity-50 flex items-center gap-2"
              >
                {evaluating ? (
                  <>
                    <span className="h-3.5 w-3.5 border-2 border-emerald-300 border-t-transparent rounded-full animate-spin" />
                    <span>Evaluating Rules...</span>
                  </>
                ) : (
                  <>
                    <span>⚡ Evaluate Rules</span>
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={openTradeModalWithIdeas}
                disabled={!selectedAccountId}
                className="px-4 py-2 rounded-xl text-xs font-bold text-white bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 transition shadow-md shadow-cyan-500/20 disabled:opacity-50 flex items-center gap-1.5"
              >
                <span>🚀 Simulate Trade</span>
              </button>
            </div>
          </GlassPanel>
        </Reveal>

        {evalMessage && (
          <div className="p-3.5 rounded-xl bg-slate-900/90 border border-cyan-500/40 text-xs md:text-sm text-cyan-200 flex items-center justify-between shadow-lg">
            <span>{evalMessage}</span>
            <button onClick={() => setEvalMessage(null)} className="text-slate-400 hover:text-white ml-4 font-bold text-base">×</button>
          </div>
        )}

        {error && (
          <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-200 text-sm">
            {error}
          </div>
        )}

        {/* Metrics Summary Grid */}
        <Reveal delayMs={100}>
          <EquityMetrics 
            metrics={metrics} 
            openingBalance={summary?.account.openingBalance || 0} 
            openTradesCount={summary?.openTrades.length || 0} 
          />
        </Reveal>

        {/* Open Positions Table */}
        <Reveal delayMs={200}>
          <ActivePositionsTable 
            openTrades={summary?.openTrades || []} 
            pendingTrades={summary?.pendingTrades || []}
            loading={loading && !summary} 
            onCloseTrade={openCloseTradeModal} 
          />
        </Reveal>

        {/* Closed Positions History */}
        <Reveal delayMs={300}>
          <TradeHistoryTable 
            closedTrades={summary?.closedTrades || []} 
          />
        </Reveal>

        {/* Modal: Create Portfolio Account */}
        <CreateAccountModal 
          show={showCreateModal}
          onClose={() => setShowCreateModal(false)}
          onSubmit={handleCreateAccount}
          newAccountName={newAccountName}
          setNewAccountName={setNewAccountName}
          newAccountBalance={newAccountBalance}
          setNewAccountBalance={setNewAccountBalance}
          createError={createError}
        />

        {/* Modal: Open Simulated Trade */}
        <OpenTradeModal 
          show={showOpenModal}
          onClose={() => setShowOpenModal(false)}
          onSubmit={handleOpenTradeSubmit}
          tradeIdeas={tradeIdeas}
          selectedIdeaId={selectedIdeaId}
          onIdeaSelectionChange={handleIdeaSelectionChange}
          openFillPrice={openFillPrice}
          setOpenFillPrice={setOpenFillPrice}
          openLots={openLots}
          setOpenLots={setOpenLots}
          openOrderType={openOrderType}
          setOpenOrderType={setOpenOrderType}
          openNotes={openNotes}
          setOpenNotes={setOpenNotes}
          openExpiryDate={openExpiryDate}
          setOpenExpiryDate={setOpenExpiryDate}
          openError={openError}
        />

        {/* Modal: Close Position Manually */}
        <CloseTradeModal 
          show={showCloseModal}
          onClose={() => setShowCloseModal(false)}
          onSubmit={handleCloseTradeSubmit}
          tradeToClose={tradeToClose}
          closeExitPrice={closeExitPrice}
          setCloseExitPrice={setCloseExitPrice}
          closeNotes={closeNotes}
          setCloseNotes={setCloseNotes}
          closeError={closeError}
        />
      </div>
    </div>
    </>
  );
}

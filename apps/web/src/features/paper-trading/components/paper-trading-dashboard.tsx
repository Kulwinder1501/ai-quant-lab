"use client";

import { useEffect, useState, useCallback } from "react";
import { GlassPanel } from "../../../components/ui/glass-panel";
import { Reveal } from "../../../components/ui/reveal";
import { getResearchJson, postResearchJson } from "../../research/api";
import { formatNumber, formatTimestamp } from "../../research/presentation";
import { ResearchShell } from "../../research/components/research-shell";
import type { PaperAccountSummary, PaperAccountFullSummary, PaperTradeRow } from "../domain";

interface TradeIdeaOption {
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
  const [openQuantity, setOpenQuantity] = useState<number>(50);
  const [openNotes, setOpenNotes] = useState<string>("Opened from Paper Trading UI");
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
        quantity: Number(openQuantity),
        notes: openNotes,
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
    <ResearchShell
      activeView="paper-trading"
      eyebrow="Quantitative Sandbox"
      title="Simulated Portfolio & Execution"
      description="Test quantitative strategies with real-time simulated order execution, automated exit rules, and zero financial risk."
      connectionLabel="Sandbox Ready"
    >
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
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <GlassPanel className="p-5 border-white/10 bg-gradient-to-br from-slate-950 to-slate-900/80">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Total Equity</p>
              <p className="mt-2 text-2xl md:text-3xl font-extrabold text-white">
                ₹{formatNumber(metrics.equity, 2)}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Initial: ₹{formatNumber(summary?.account.openingBalance || 0, 0)}
              </p>
            </GlassPanel>

            <GlassPanel className="p-5 border-white/10 bg-gradient-to-br from-slate-950 to-slate-900/80">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Realized P&amp;L</p>
              <p className={`mt-2 text-2xl md:text-3xl font-extrabold ${metrics.realizedPnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                {metrics.realizedPnl >= 0 ? "+" : ""}₹{formatNumber(metrics.realizedPnl, 2)}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                From {metrics.totalTrades} closed simulated positions
              </p>
            </GlassPanel>

            <GlassPanel className="p-5 border-white/10 bg-gradient-to-br from-slate-950 to-slate-900/80">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Unrealized P&amp;L</p>
              <p className={`mt-2 text-2xl md:text-3xl font-extrabold ${metrics.unrealizedPnl >= 0 ? "text-cyan-400" : "text-rose-400"}`}>
                {metrics.unrealizedPnl >= 0 ? "+" : ""}₹{formatNumber(metrics.unrealizedPnl, 2)}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Across {summary?.openTrades.length || 0} active positions
              </p>
            </GlassPanel>

            <GlassPanel className="p-5 border-white/10 bg-gradient-to-br from-slate-950 to-slate-900/80">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Win Rate &amp; Stats</p>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-2xl md:text-3xl font-extrabold text-amber-300">
                  {formatNumber(metrics.winRatePercent, 1)}%
                </span>
                <span className="text-xs text-slate-400">
                  ({metrics.winningTrades}W / {metrics.losingTrades}L)
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-500">
                Execution accuracy on completed trades
              </p>
            </GlassPanel>
          </div>
        </Reveal>

        {/* Open Positions Table */}
        <Reveal delayMs={200}>
          <GlassPanel className="p-6 border-white/10">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-lg font-bold text-white">Active Simulated Positions ({summary?.openTrades.length || 0})</h2>
                <p className="text-xs text-slate-400">Positions evaluated against market candles and take-profit/stop-loss targets.</p>
              </div>
            </div>

            {loading && !summary ? (
              <div className="py-8 text-center text-sm text-slate-400">Loading portfolio positions...</div>
            ) : (summary?.openTrades.length || 0) === 0 ? (
              <div className="py-10 text-center rounded-xl border border-dashed border-white/10 bg-white/5">
                <p className="text-sm font-semibold text-slate-300">No open simulated trades</p>
                <p className="text-xs text-slate-500 mt-1">Click &quot;Simulate Trade&quot; above to open a position from an AI strategy proposal.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-white/10 text-xs font-semibold uppercase tracking-wider text-slate-400">
                      <th className="py-3 px-4">Instrument</th>
                      <th className="py-3 px-4">Side</th>
                      <th className="py-3 px-4">Qty</th>
                      <th className="py-3 px-4">Entry Price</th>
                      <th className="py-3 px-4">Opened At</th>
                      <th className="py-3 px-4">Notes</th>
                      <th className="py-3 px-4 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5 text-sm">
                    {summary?.openTrades.map((trade) => (
                      <tr key={trade.id} className="hover:bg-white/[0.02] transition">
                        <td className="py-3.5 px-4 font-bold text-white">
                          {trade.instrumentSymbol || "NIFTY50"}
                          <span className="block text-xs font-normal text-slate-500">{trade.timeframe || "1d"}</span>
                        </td>
                        <td className="py-3.5 px-4">
                          <span className={`inline-flex px-2 py-0.5 rounded text-xs font-bold ${
                            trade.side === "BUY" ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30" : "bg-rose-500/20 text-rose-300 border border-rose-500/30"
                          }`}>
                            {trade.side}
                          </span>
                        </td>
                        <td className="py-3.5 px-4 font-medium text-slate-200">{formatNumber(trade.quantity, 0)}</td>
                        <td className="py-3.5 px-4 font-semibold text-white">₹{formatNumber(trade.fillPrice, 2)}</td>
                        <td className="py-3.5 px-4 text-xs text-slate-400">{formatTimestamp(trade.openedAt)}</td>
                        <td className="py-3.5 px-4 text-xs text-slate-400 max-w-xs truncate">{trade.notes || "—"}</td>
                        <td className="py-3.5 px-4 text-right">
                          <button
                            type="button"
                            onClick={() => openCloseTradeModal(trade)}
                            className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-rose-500/20 text-rose-200 hover:bg-rose-500/30 border border-rose-500/30 transition"
                          >
                            Close Position
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </GlassPanel>
        </Reveal>

        {/* Closed Positions History */}
        <Reveal delayMs={300}>
          <GlassPanel className="p-6 border-white/10">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-lg font-bold text-white">Trade History ({summary?.closedTrades.length || 0})</h2>
                <p className="text-xs text-slate-400">Completed simulated trades with realized P&amp;L and exit trigger reasons.</p>
              </div>
            </div>

            {(summary?.closedTrades.length || 0) === 0 ? (
              <div className="py-8 text-center text-sm text-slate-500">No completed trade history yet.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-white/10 text-xs font-semibold uppercase tracking-wider text-slate-400">
                      <th className="py-3 px-4">Instrument</th>
                      <th className="py-3 px-4">Side</th>
                      <th className="py-3 px-4">Qty</th>
                      <th className="py-3 px-4">Entry / Exit</th>
                      <th className="py-3 px-4">Realized P&amp;L</th>
                      <th className="py-3 px-4">Return %</th>
                      <th className="py-3 px-4">Exit Reason</th>
                      <th className="py-3 px-4">Closed At</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5 text-sm">
                    {summary?.closedTrades.map((trade) => {
                      const pnl = trade.realizedPnl || 0;
                      const ret = trade.returnPercent || 0;
                      return (
                        <tr key={trade.id} className="hover:bg-white/[0.02] transition">
                          <td className="py-3.5 px-4 font-bold text-white">
                            {trade.instrumentSymbol || "NIFTY50"}
                            <span className="block text-xs font-normal text-slate-500">{trade.timeframe || "1d"}</span>
                          </td>
                          <td className="py-3.5 px-4">
                            <span className={`inline-flex px-2 py-0.5 rounded text-xs font-bold ${
                              trade.side === "BUY" ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30" : "bg-rose-500/20 text-rose-300 border border-rose-500/30"
                            }`}>
                              {trade.side}
                            </span>
                          </td>
                          <td className="py-3.5 px-4 font-medium text-slate-200">{formatNumber(trade.quantity, 0)}</td>
                          <td className="py-3.5 px-4 text-xs text-slate-300">
                            <div>In: ₹{formatNumber(trade.fillPrice, 2)}</div>
                            <div className="font-semibold text-white">Out: ₹{formatNumber(trade.exitPrice || 0, 2)}</div>
                          </td>
                          <td className={`py-3.5 px-4 font-bold ${pnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                            {pnl >= 0 ? "+" : ""}₹{formatNumber(pnl, 2)}
                          </td>
                          <td className={`py-3.5 px-4 font-semibold ${ret >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                            {ret >= 0 ? "+" : ""}{formatNumber(ret, 2)}%
                          </td>
                          <td className="py-3.5 px-4">
                            <span className="inline-flex px-2 py-0.5 rounded text-xs bg-slate-800 text-slate-300 border border-white/10 font-mono">
                              {trade.exitReason || "MANUAL"}
                            </span>
                          </td>
                          <td className="py-3.5 px-4 text-xs text-slate-400">{formatTimestamp(trade.closedAt || null)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </GlassPanel>
        </Reveal>

        {/* Modal: Create Portfolio Account */}
        {showCreateModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
            <GlassPanel className="w-full max-w-md p-6 border-cyan-500/30 bg-slate-950 shadow-2xl">
              <h3 className="text-xl font-bold text-white">Create Paper Portfolio</h3>
              <p className="text-xs text-slate-400 mt-1">Set an opening capital balance in INR for quantitative strategy simulations.</p>
              {createError && <p className="mt-3 text-xs text-rose-400 bg-rose-500/10 p-2 rounded border border-rose-500/20">{createError}</p>}
              <form onSubmit={handleCreateAccount} className="mt-4 space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 uppercase">Portfolio Name</label>
                  <input
                    type="text"
                    required
                    value={newAccountName}
                    onChange={(e) => setNewAccountName(e.target.value)}
                    className="mt-1 w-full rounded-xl bg-slate-900 border border-white/10 px-3.5 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-400"
                    placeholder="e.g. Breakout Alpha Fund"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-300 uppercase">Opening Capital (₹ INR)</label>
                  <input
                    type="number"
                    required
                    min="1000"
                    step="1000"
                    value={newAccountBalance}
                    onChange={(e) => setNewAccountBalance(Number(e.target.value))}
                    className="mt-1 w-full rounded-xl bg-slate-900 border border-white/10 px-3.5 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-400"
                  />
                </div>
                <div className="flex items-center justify-end gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowCreateModal(false)}
                    className="px-4 py-2 rounded-xl text-sm font-semibold text-slate-400 hover:text-white transition"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-5 py-2 rounded-xl text-sm font-semibold text-white bg-cyan-600 hover:bg-cyan-500 transition shadow-lg shadow-cyan-500/20"
                  >
                    Create Fund
                  </button>
                </div>
              </form>
            </GlassPanel>
          </div>
        )}

        {/* Modal: Open Simulated Trade */}
        {showOpenModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
            <GlassPanel className="w-full max-w-lg p-6 border-cyan-500/30 bg-slate-950 shadow-2xl">
              <h3 className="text-xl font-bold text-white">Simulate Position Entry</h3>
              <p className="text-xs text-slate-400 mt-1">Select an AI trade idea from the quantitative strategy engine and execute a simulated order.</p>
              {openError && <p className="mt-3 text-xs text-rose-400 bg-rose-500/10 p-2 rounded border border-rose-500/20">{openError}</p>}
              <form onSubmit={handleOpenTradeSubmit} className="mt-4 space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 uppercase">Select Strategy Proposal</label>
                  {tradeIdeas.length === 0 ? (
                    <div className="mt-1 p-3 rounded-xl bg-slate-900 border border-white/10 text-xs text-slate-400">
                      No active proposals found in database. Go to Strategy &amp; Ideas tab to generate new proposals first!
                    </div>
                  ) : (
                    <select
                      value={selectedIdeaId}
                      onChange={(e) => handleIdeaSelectionChange(e.target.value)}
                      className="mt-1 w-full rounded-xl bg-slate-900 border border-white/10 px-3.5 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-400"
                    >
                      {tradeIdeas.map((idea) => (
                        <option key={idea.id} value={idea.id}>
                          {idea.side} {idea.instrumentSymbol} @ ₹{idea.entryPrice} (Target: ₹{idea.targetPrice}, SL: ₹{idea.stopLoss})
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 uppercase">Simulated Fill Price (₹)</label>
                    <input
                      type="number"
                      required
                      step="0.05"
                      min="0.05"
                      value={openFillPrice}
                      onChange={(e) => setOpenFillPrice(Number(e.target.value))}
                      className="mt-1 w-full rounded-xl bg-slate-900 border border-white/10 px-3.5 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-400"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 uppercase">Quantity (Shares/Lots)</label>
                    <input
                      type="number"
                      required
                      min="1"
                      step="1"
                      value={openQuantity}
                      onChange={(e) => setOpenQuantity(Number(e.target.value))}
                      className="mt-1 w-full rounded-xl bg-slate-900 border border-white/10 px-3.5 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-400"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-300 uppercase">Simulated Order Notes</label>
                  <input
                    type="text"
                    value={openNotes}
                    onChange={(e) => setOpenNotes(e.target.value)}
                    className="mt-1 w-full rounded-xl bg-slate-900 border border-white/10 px-3.5 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-400"
                    placeholder="e.g. Entering on breakout confirmation"
                  />
                </div>
                <div className="flex items-center justify-end gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowOpenModal(false)}
                    className="px-4 py-2 rounded-xl text-sm font-semibold text-slate-400 hover:text-white transition"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={!selectedIdeaId}
                    className="px-5 py-2 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 transition shadow-lg shadow-cyan-500/20 disabled:opacity-50"
                  >
                    Confirm Simulation
                  </button>
                </div>
              </form>
            </GlassPanel>
          </div>
        )}

        {/* Modal: Close Position Manually */}
        {showCloseModal && tradeToClose && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
            <GlassPanel className="w-full max-w-md p-6 border-rose-500/30 bg-slate-950 shadow-2xl">
              <h3 className="text-xl font-bold text-white">Manual Position Exit</h3>
              <p className="text-xs text-slate-400 mt-1">
                Closing simulated {tradeToClose.side} position on {tradeToClose.instrumentSymbol} ({tradeToClose.quantity} units entered at ₹{formatNumber(tradeToClose.fillPrice, 2)}).
              </p>
              {closeError && <p className="mt-3 text-xs text-rose-400 bg-rose-500/10 p-2 rounded border border-rose-500/20">{closeError}</p>}
              <form onSubmit={handleCloseTradeSubmit} className="mt-4 space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 uppercase">Simulated Exit Price (₹)</label>
                  <input
                    type="number"
                    required
                    step="0.05"
                    min="0.05"
                    value={closeExitPrice}
                    onChange={(e) => setCloseExitPrice(Number(e.target.value))}
                    className="mt-1 w-full rounded-xl bg-slate-900 border border-white/10 px-3.5 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-rose-400"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-300 uppercase">Exit Notes</label>
                  <input
                    type="text"
                    value={closeNotes}
                    onChange={(e) => setCloseNotes(e.target.value)}
                    className="mt-1 w-full rounded-xl bg-slate-900 border border-white/10 px-3.5 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-rose-400"
                    placeholder="e.g. Taking profits ahead of news event"
                  />
                </div>
                <div className="flex items-center justify-end gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowCloseModal(false)}
                    className="px-4 py-2 rounded-xl text-sm font-semibold text-slate-400 hover:text-white transition"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-5 py-2 rounded-xl text-sm font-semibold text-white bg-rose-600 hover:bg-rose-500 transition shadow-lg shadow-rose-500/20"
                  >
                    Close Position
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

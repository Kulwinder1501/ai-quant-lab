"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { GlassPanel } from "../../../components/ui/glass-panel";
import { Reveal } from "../../../components/ui/reveal";
import { getResearchJson } from "../../research/api";
import { formatNumber, formatPercentage, formatTimestamp } from "../../research/presentation";
import { ResearchShell } from "../../research/components/research-shell";
import type { PaperAccountSummary, PaperAccountFullSummary } from "../../paper-trading/domain";

export function OrdersDashboard() {
  const [accounts, setAccounts] = useState<PaperAccountSummary[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>("");
  const [summary, setSummary] = useState<PaperAccountFullSummary | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [filterSymbol, setFilterSymbol] = useState<string>("ALL");
  const [filterSide, setFilterSide] = useState<string>("ALL");
  const [filterOutcome, setFilterOutcome] = useState<string>("ALL");

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

  // 2. Fetch Account Summary (Closed Trades / Orders)
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
        setError(err.message || "Failed to load completed order history.");
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

    const timer = setInterval(() => {
      fetchSummary(selectedAccountId);
    }, 5000);

    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [selectedAccountId, fetchSummary]);

  // Filter and Compute Order Analytics
  const filteredOrders = useMemo(() => {
    const list = summary?.closedTrades || [];
    return list.filter((order) => {
      const sym = order.instrumentSymbol || "NIFTY50";
      if (filterSymbol !== "ALL" && sym !== filterSymbol) return false;
      if (filterSide !== "ALL" && order.side !== filterSide) return false;
      
      const pnl = order.realizedPnl || 0;
      if (filterOutcome === "WIN" && pnl <= 0) return false;
      if (filterOutcome === "LOSS" && pnl >= 0) return false;

      return true;
    });
  }, [summary?.closedTrades, filterSymbol, filterSide, filterOutcome]);

  const orderStats = useMemo(() => {
    const list = filteredOrders;
    let totalPnl = 0;
    let wins = 0;
    let losses = 0;
    let totalVolume = 0;

    list.forEach((ord) => {
      const p = ord.realizedPnl || 0;
      totalPnl += p;
      if (p > 0) wins++;
      else if (p < 0) losses++;
      totalVolume += ord.fillPrice * ord.quantity;
    });

    const total = list.length;
    const winRate = total > 0 ? (wins / total) * 100 : 0;

    return {
      total,
      wins,
      losses,
      winRate,
      totalPnl,
      totalVolume,
    };
  }, [filteredOrders]);

  return (
    <ResearchShell
      activeView="orders"
      eyebrow="Autonomous AI Trading Lab"
      title="Completed AI Orders & Execution Log"
      description="Review closed quantitative trade executions, algorithmic exit reasons (Take-Profit vs Stop-Loss), and realized P&L auditing."
      connectionLabel={`Auditing Account: ${accounts.find((a) => a.id === selectedAccountId)?.name || "Default"}`}
    >
      <div className="space-y-6">
        {/* Account & Filter Control Bar */}
        <Reveal>
          <GlassPanel className="p-4 border-cyan-500/20 bg-gradient-to-r from-slate-950 via-slate-900 to-cyan-950/30 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="inline-flex h-3 w-3 rounded-full bg-cyan-400 animate-pulse" />
              <label htmlFor="ord-acc-select" className="text-xs font-bold text-slate-400 uppercase tracking-wider">
                Trading Account:
              </label>
              <select
                id="ord-acc-select"
                value={selectedAccountId}
                onChange={(e) => setSelectedAccountId(e.target.value)}
                className="bg-slate-950 text-sm font-extrabold text-white px-3 py-1.5 rounded-xl border border-white/10 focus:outline-none focus:ring-2 focus:ring-cyan-500 cursor-pointer"
              >
                {accounts.map((acc) => (
                  <option key={acc.id} value={acc.id} className="bg-slate-900 text-white">
                    {acc.name} (₹{formatNumber(acc.openingBalance, 0)})
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2 bg-slate-950/80 rounded-xl px-3 py-1.5 border border-white/10">
                <span className="text-xs font-semibold text-slate-400">Symbol:</span>
                <select
                  value={filterSymbol}
                  onChange={(e) => setFilterSymbol(e.target.value)}
                  className="bg-transparent text-xs font-bold text-white focus:outline-none cursor-pointer uppercase"
                >
                  <option value="ALL" className="bg-slate-900 text-white">All Symbols</option>
                  <option value="NIFTY50" className="bg-slate-900 text-white">NIFTY 50</option>
                  <option value="BANKNIFTY" className="bg-slate-900 text-white">BANK NIFTY</option>
                </select>
              </div>

              <div className="flex items-center gap-2 bg-slate-950/80 rounded-xl px-3 py-1.5 border border-white/10">
                <span className="text-xs font-semibold text-slate-400">Side:</span>
                <select
                  value={filterSide}
                  onChange={(e) => setFilterSide(e.target.value)}
                  className="bg-transparent text-xs font-bold text-white focus:outline-none cursor-pointer uppercase"
                >
                  <option value="ALL" className="bg-slate-900 text-white">Buy &amp; Sell</option>
                  <option value="BUY" className="bg-slate-900 text-white">BUY Only</option>
                  <option value="SELL" className="bg-slate-900 text-white">SELL Only</option>
                </select>
              </div>

              <div className="flex items-center gap-2 bg-slate-950/80 rounded-xl px-3 py-1.5 border border-white/10">
                <span className="text-xs font-semibold text-slate-400">Outcome:</span>
                <select
                  value={filterOutcome}
                  onChange={(e) => setFilterOutcome(e.target.value)}
                  className="bg-transparent text-xs font-bold text-white focus:outline-none cursor-pointer uppercase"
                >
                  <option value="ALL" className="bg-slate-900 text-white">All Trades</option>
                  <option value="WIN" className="bg-slate-900 text-white">✅ Winners</option>
                  <option value="LOSS" className="bg-slate-900 text-white">❌ Losers</option>
                </select>
              </div>

              <button
                type="button"
                onClick={() => selectedAccountId && fetchSummary(selectedAccountId)}
                className="px-3 py-1.5 rounded-xl text-xs font-bold text-slate-300 bg-slate-900 hover:bg-slate-800 border border-white/10 transition"
              >
                🔄 Refresh
              </button>
            </div>
          </GlassPanel>
        </Reveal>

        {error && (
          <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-200 text-sm font-semibold">
            {error}
          </div>
        )}

        {/* Execution Summary Cards */}
        <Reveal delayMs={100}>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <GlassPanel className="p-5 border-white/10 bg-slate-950/60">
              <span className="text-xs font-extrabold text-slate-400 uppercase tracking-wider">Completed AI Orders</span>
              <div className="mt-2 text-2xl font-black text-white">
                {orderStats.total} <span className="text-xs font-normal text-slate-400">Executions</span>
              </div>
              <p className="mt-1 text-xs text-slate-400">
                Volume: <strong className="text-white">₹{formatNumber(orderStats.totalVolume, 0)}</strong>
              </p>
            </GlassPanel>

            <GlassPanel className="p-5 border-cyan-500/30 bg-gradient-to-br from-slate-950 via-slate-900 to-cyan-950/20">
              <span className="text-xs font-extrabold text-cyan-400 uppercase tracking-wider">AI Execution Win Rate</span>
              <div className="mt-2 text-2xl font-black text-white">
                {formatPercentage(orderStats.winRate / 100)}
              </div>
              <p className="mt-1 text-xs text-slate-400">
                Ratio: <span className="text-emerald-400 font-bold">{orderStats.wins} W</span> / <span className="text-rose-400 font-bold">{orderStats.losses} L</span>
              </p>
            </GlassPanel>

            <GlassPanel className={`p-5 border-white/10 ${orderStats.totalPnl >= 0 ? "bg-emerald-950/20 border-emerald-500/30" : "bg-rose-950/20 border-rose-500/30"}`}>
              <span className="text-xs font-extrabold text-slate-400 uppercase tracking-wider">Net Realized P&amp;L</span>
              <div className={`mt-2 text-2xl font-black ${orderStats.totalPnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                {orderStats.totalPnl >= 0 ? "+" : ""}₹{formatNumber(orderStats.totalPnl, 2)}
              </div>
              <p className="mt-1 text-xs text-slate-400">
                Locked-in trading gains / losses
              </p>
            </GlassPanel>

            <GlassPanel className="p-5 border-white/10 bg-slate-950/60">
              <span className="text-xs font-extrabold text-slate-400 uppercase tracking-wider">Execution Audit Status</span>
              <div className="mt-2 text-lg font-black text-emerald-400 flex items-center gap-1.5">
                <span>●</span>
                <span>100% Algorithmic</span>
              </div>
              <p className="mt-1 text-xs text-slate-400">Zero human slippage delays</p>
            </GlassPanel>
          </div>
        </Reveal>

        {/* Completed Orders Table */}
        <Reveal delayMs={200}>
          <GlassPanel className="p-6 border-white/10">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h3 className="text-lg font-extrabold text-white flex items-center gap-2">
                  <span>📜 Completed Trade Execution Log</span>
                  <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-white/10">
                    Showing {filteredOrders.length} of {summary?.closedTrades.length || 0}
                  </span>
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Chronological history of all buy and sell orders completed by the AI or manually closed.
                </p>
              </div>
            </div>

            {loading && !summary ? (
              <div className="py-12 text-center text-sm font-semibold text-slate-400">
                <span className="inline-block h-6 w-6 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin mb-3" />
                <p>Loading completed order audit log...</p>
              </div>
            ) : filteredOrders.length === 0 ? (
              <div className="py-16 text-center rounded-2xl border border-dashed border-white/10 bg-slate-950/40 p-8">
                <span className="text-3xl">📜</span>
                <p className="mt-3 text-base font-bold text-white">No Completed Orders Found</p>
                <p className="mt-1 text-xs text-slate-400 max-w-md mx-auto">
                  {summary?.closedTrades.length === 0
                    ? "The AI Autonomous Agent hasn't closed any positions yet. Once open positions hit their take-profit (+3.0%) or stop-loss (-1.5%) targets, the completed orders will appear here."
                    : "No orders match your selected symbol or outcome filter criteria."}
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
                      <th className="py-3 px-4">Exit Price</th>
                      <th className="py-3 px-4">Realized P&amp;L</th>
                      <th className="py-3 px-4">Return %</th>
                      <th className="py-3 px-4">AI Exit Trigger / Analysis</th>
                      <th className="py-3 px-4">Closed At</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5 text-sm font-medium">
                    {filteredOrders.map((order) => {
                      const sym = order.instrumentSymbol || "NIFTY50";
                      const pnl = order.realizedPnl || 0;
                      const ret = order.returnPercent || 0;
                      const isWin = pnl >= 0;

                      return (
                        <tr key={order.id} className="hover:bg-white/[0.03] transition">
                          <td className="py-4 px-4 font-extrabold text-white">
                            <div className="flex items-center gap-2">
                              <span className={`h-2 w-2 rounded-full ${isWin ? "bg-emerald-400" : "bg-rose-400"}`}></span>
                              <span>{sym}</span>
                            </div>
                            <span className="block text-[11px] font-mono font-normal text-slate-500 mt-0.5">
                              ID: {order.id.substring(0, 8)}...
                            </span>
                          </td>
                          <td className="py-4 px-4">
                            <span className={`inline-flex px-2.5 py-1 rounded-md text-xs font-black ${
                              order.side === "BUY" ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30" : "bg-rose-500/20 text-rose-300 border border-rose-500/30"
                            }`}>
                              {order.side}
                            </span>
                          </td>
                          <td className="py-4 px-4 font-bold text-slate-200">{formatNumber(order.quantity, 0)}</td>
                          <td className="py-4 px-4 font-semibold text-slate-300">₹{formatNumber(order.fillPrice, 2)}</td>
                          <td className="py-4 px-4 font-bold text-white">
                            ₹{formatNumber(order.exitPrice || 0, 2)}
                          </td>
                          <td className="py-4 px-4">
                            <span className={`inline-flex px-2.5 py-1 rounded-lg text-xs font-black ${
                              isWin
                                ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 shadow-sm shadow-emerald-500/10"
                                : "bg-rose-500/15 text-rose-300 border border-rose-500/30 shadow-sm shadow-rose-500/10"
                            }`}>
                              {isWin ? "+" : ""}₹{formatNumber(pnl, 2)}
                            </span>
                          </td>
                          <td className="py-4 px-4 font-extrabold">
                            <span className={isWin ? "text-emerald-400" : "text-rose-400"}>
                              {isWin ? "+" : ""}{ret.toFixed(2)}%
                            </span>
                          </td>
                          <td className="py-4 px-4 text-xs text-slate-300 max-w-xs">
                            <div className="truncate font-semibold text-cyan-200">
                              {order.exitReason || "Algorithmic Target Reached"}
                            </div>
                            <div className="text-[11px] text-slate-400 mt-0.5 max-w-xs truncate">
                              {order.notes || `Opened: ${formatTimestamp(order.openedAt)}`}
                            </div>
                          </td>
                          <td className="py-4 px-4 text-xs font-mono text-slate-400">
                            {order.closedAt ? formatTimestamp(order.closedAt) : "—"}
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
      </div>
    </ResearchShell>
  );
}

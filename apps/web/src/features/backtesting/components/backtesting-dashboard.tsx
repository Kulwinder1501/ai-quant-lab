"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { GlassPanel } from "../../../components/ui/glass-panel";
import { Reveal } from "../../../components/ui/reveal";
import { getResearchJson, postResearchJson } from "../../research/api";
import { formatNumber, formatPercentage, formatTimestamp } from "../../research/presentation";
import { ResearchShell } from "../../research/components/research-shell";
import type { BacktestRunRow, BacktestRunDetails } from "../domain";

export function BacktestingDashboard() {
  const [runs, setRuns] = useState<BacktestRunRow[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>("");
  const [details, setDetails] = useState<BacktestRunDetails | null>(null);
  const [loadingList, setLoadingList] = useState<boolean>(true);
  const [loadingDetails, setLoadingDetails] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Tab state in inspector
  const [activeTab, setActiveTab] = useState<"trades" | "monthly">("trades");

  // Run New Backtest Modal state
  const [showRunModal, setShowRunModal] = useState<boolean>(false);
  const [runSymbol, setRunSymbol] = useState<string>("NIFTY50");
  const [runTimeframe, setRunTimeframe] = useState<string>("1d");
  const [startDate, setStartDate] = useState<string>("2025-01-01");
  const [endDate, setEndDate] = useState<string>("2026-06-30");
  const [running, setRunning] = useState<boolean>(false);
  const [runMessage, setRunMessage] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const fetchRuns = useCallback(async (signal?: AbortSignal) => {
    setLoadingList(true);
    setError(null);
    try {
      const res = await getResearchJson("/backtest-runs?limit=50", signal) as { data: BacktestRunRow[] };
      const list = res.data || [];
      setRuns(list);
      if (list.length > 0 && !selectedRunId) {
        setSelectedRunId(list[0].id);
      }
    } catch (err: any) {
      if (err.name !== "AbortError") {
        setError(err.message || "Failed to load backtest runs.");
      }
    } finally {
      setLoadingList(false);
    }
  }, [selectedRunId]);

  const fetchDetails = useCallback(async (runId: string, signal?: AbortSignal) => {
    if (!runId) {
      setDetails(null);
      return;
    }
    setLoadingDetails(true);
    setError(null);
    try {
      const res = await getResearchJson(`/backtest-runs/${runId}`, signal) as { data: BacktestRunDetails };
      setDetails(res.data);
    } catch (err: any) {
      if (err.name !== "AbortError") {
        setError(err.message || "Failed to load backtest details.");
      }
    } finally {
      setLoadingDetails(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchRuns(controller.signal);
    return () => controller.abort();
  }, [fetchRuns]);

  useEffect(() => {
    if (!selectedRunId) return;
    const controller = new AbortController();
    fetchDetails(selectedRunId, controller.signal);
    return () => controller.abort();
  }, [selectedRunId, fetchDetails]);

  const handleRunSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setRunning(true);
    setRunMessage(null);
    setRunError(null);
    try {
      const res = await postResearchJson("/backtest-runs", {
        symbol: runSymbol.trim().toUpperCase(),
        timeframe: runTimeframe,
        startDate,
        endDate,
      }) as { data: { backtestRunId: string; tradesSimulated: number; status: string } };
      
      setRunMessage(`Successfully replayed historical data! Reconstructed and evaluated ${res.data.tradesSimulated} trades.`);
      await fetchRuns();
      if (res.data.backtestRunId) {
        setSelectedRunId(res.data.backtestRunId);
      }
      setTimeout(() => {
        setShowRunModal(false);
      }, 1500);
    } catch (err: any) {
      setRunError(err.message || "Failed to execute backtest simulation.");
    } finally {
      setRunning(false);
    }
  };

  const metrics = details?.run.metrics || {};
  const netPnl = metrics.netPnl || 0;
  const winRate = metrics.winRatePercent || 0;
  const sharpe = metrics.sharpeRatio !== undefined ? metrics.sharpeRatio : null;
  const sortino = metrics.sortinoRatio !== undefined ? metrics.sortinoRatio : null;
  const profitFactor = metrics.profitFactor !== undefined ? metrics.profitFactor : null;
  const maxDd = metrics.maxDrawdownPercent || 0;

  return (
    <ResearchShell
      activeView="backtesting"
      eyebrow="Historical Replay"
      title="Backtesting & Performance Reports"
      description="Simulate quantitative strategies over historical data windows with tick-level replay, slippage modeling, and multi-metric tear sheets."
      connectionLabel="Replay Engine Ready"
    >
      <div className="space-y-6">
        {/* Control Bar */}
        <Reveal>
          <GlassPanel className="p-4 border-cyan-500/20 bg-gradient-to-r from-slate-950 via-slate-900 to-cyan-950/30 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="text-sm font-bold text-white pl-2">
                Historical Simulations ({runs.length})
              </span>
              <button
                type="button"
                onClick={() => fetchRuns()}
                disabled={loadingList}
                className="px-3 py-1 rounded-lg text-xs font-semibold text-slate-400 hover:text-white bg-white/5 border border-white/10 transition"
              >
                🔄 Refresh List
              </button>
            </div>

            <div>
              <button
                type="button"
                onClick={() => { setShowRunModal(true); setRunMessage(null); setRunError(null); }}
                className="px-4 py-2 rounded-xl text-xs font-bold text-white bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 transition shadow-md shadow-cyan-500/20 flex items-center gap-1.5"
              >
                <span>⚡ Run New Backtest</span>
              </button>
            </div>
          </GlassPanel>
        </Reveal>

        {error && (
          <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-200 text-sm">
            {error}
          </div>
        )}

        {/* Split Content Area */}
        <div className="grid gap-6 lg:grid-cols-12">
          {/* Left Sidebar: List of Backtests */}
          <div className="lg:col-span-4 space-y-3">
            <Reveal delayMs={100}>
              <GlassPanel className="p-4 border-white/10 max-h-[750px] overflow-y-auto">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3 px-1">
                  Recorded Simulation Runs
                </h3>

                {loadingList && runs.length === 0 ? (
                  <div className="py-8 text-center text-xs text-slate-400">Loading simulations...</div>
                ) : runs.length === 0 ? (
                  <div className="py-8 text-center rounded-xl border border-dashed border-white/10 bg-white/5 p-4">
                    <p className="text-xs font-semibold text-slate-300">No backtest runs recorded</p>
                    <p className="text-[11px] text-slate-500 mt-1">Click &quot;Run New Backtest&quot; to replay historical strategy performance.</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {runs.map((run) => {
                      const isSelected = run.id === selectedRunId;
                      const runPnl = run.metrics?.netPnl || 0;
                      const runWr = run.metrics?.winRatePercent || 0;
                      return (
                        <button
                          key={run.id}
                          type="button"
                          onClick={() => setSelectedRunId(run.id)}
                          className={`w-full text-left p-3.5 rounded-xl border transition ${
                            isSelected
                              ? "bg-cyan-500/15 border-cyan-500/50 shadow-md shadow-cyan-500/10"
                              : "bg-slate-950/40 border-white/5 hover:bg-white/5 hover:border-white/10"
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <span className="text-sm font-extrabold text-white">
                                {run.instrumentSymbol || "NIFTY50"}
                              </span>
                              <span className="ml-1.5 text-xs font-mono text-slate-400">
                                ({run.timeframe})
                              </span>
                            </div>
                            <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                              run.status === "COMPLETED" ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30" : "bg-amber-500/20 text-amber-300"
                            }`}>
                              {run.status}
                            </span>
                          </div>

                          <div className="mt-2 flex items-baseline justify-between text-xs">
                            <span className={`font-bold ${runPnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                              {runPnl >= 0 ? "+" : ""}₹{formatNumber(runPnl, 0)}
                            </span>
                            <span className="text-slate-300 font-semibold">
                              Win: {formatNumber(runWr, 1)}%
                            </span>
                          </div>

                          <div className="mt-1.5 flex items-center justify-between text-[11px] text-slate-500 border-t border-white/5 pt-1.5 font-mono">
                            <span>{run.startedAt.split("T")[0]}</span>
                            <span>Trades: {run.metrics?.totalTrades || 0}</span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </GlassPanel>
            </Reveal>
          </div>

          {/* Right Inspector: Tear Sheet & Logs */}
          <div className="lg:col-span-8 space-y-6">
            {!selectedRunId ? (
              <GlassPanel className="p-12 text-center border-dashed border-white/10">
                <p className="text-sm font-semibold text-slate-300">Select a backtest run</p>
                <p className="text-xs text-slate-500 mt-1">Pick a simulation from the left sidebar to inspect full performance tear sheets and trade logs.</p>
              </GlassPanel>
            ) : loadingDetails && !details ? (
              <GlassPanel className="p-12 text-center">
                <span className="inline-block h-6 w-6 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin mb-3" />
                <p className="text-sm font-semibold text-slate-300">Rebuilding tear sheet &amp; trade logs...</p>
              </GlassPanel>
            ) : !details ? (
              <GlassPanel className="p-12 text-center text-rose-300">
                Backtest run details could not be loaded.
              </GlassPanel>
            ) : (
              <>
                {/* Tear Sheet Header & Grid */}
                <Reveal delayMs={150}>
                  <GlassPanel className="p-6 border-white/10 bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950">
                    <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 pb-4">
                      <div>
                        <span className="text-xs font-mono font-semibold uppercase tracking-wider text-cyan-300">
                          Performance Tear Sheet
                        </span>
                        <h2 className="text-xl md:text-2xl font-extrabold text-white mt-1">
                          {details.run.instrumentSymbol || "NIFTY50"} ({details.run.timeframe})
                        </h2>
                        <p className="text-xs text-slate-400 mt-0.5">
                          Data Window: {details.run.dataWindowStart.split("T")[0]} to {details.run.dataWindowEnd.split("T")[0]}
                        </p>
                      </div>

                      <div className="flex items-center gap-2">
                        <span className="px-3 py-1 rounded-full bg-slate-900 border border-white/10 text-xs font-mono text-slate-300">
                          ID: {details.run.id.slice(0, 8)}
                        </span>
                      </div>
                    </div>

                    {/* 6-Metric Grid */}
                    <div className="mt-5 grid grid-cols-2 md:grid-cols-3 gap-4">
                      <div className="p-3.5 rounded-xl bg-slate-900/80 border border-white/5">
                        <span className="block text-[11px] uppercase font-semibold text-slate-400">Net Profit / Loss</span>
                        <span className={`mt-1 block text-xl font-extrabold ${netPnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                          {netPnl >= 0 ? "+" : ""}₹{formatNumber(netPnl, 2)}
                        </span>
                        <span className="text-[10px] text-slate-500">Total strategy return</span>
                      </div>

                      <div className="p-3.5 rounded-xl bg-slate-900/80 border border-white/5">
                        <span className="block text-[11px] uppercase font-semibold text-slate-400">Win Rate</span>
                        <span className="mt-1 block text-xl font-extrabold text-amber-300">
                          {formatNumber(winRate, 1)}%
                        </span>
                        <span className="text-[10px] text-slate-500">
                          {metrics.winningTrades || 0} Wins / {metrics.losingTrades || 0} Losses
                        </span>
                      </div>

                      <div className="p-3.5 rounded-xl bg-slate-900/80 border border-white/5">
                        <span className="block text-[11px] uppercase font-semibold text-slate-400">Profit Factor</span>
                        <span className="mt-1 block text-xl font-extrabold text-white">
                          {profitFactor !== null ? formatNumber(profitFactor, 2) : "—"}
                        </span>
                        <span className="text-[10px] text-slate-500">
                          Gross Profit / Gross Loss
                        </span>
                      </div>

                      <div className="p-3.5 rounded-xl bg-slate-900/80 border border-white/5">
                        <span className="block text-[11px] uppercase font-semibold text-slate-400">Sharpe Ratio</span>
                        <span className="mt-1 block text-xl font-extrabold text-cyan-300">
                          {sharpe !== null ? formatNumber(sharpe, 2) : "—"}
                        </span>
                        <span className="text-[10px] text-slate-500">Risk-adjusted return</span>
                      </div>

                      <div className="p-3.5 rounded-xl bg-slate-900/80 border border-white/5">
                        <span className="block text-[11px] uppercase font-semibold text-slate-400">Max Drawdown</span>
                        <span className="mt-1 block text-xl font-extrabold text-rose-400">
                          -{formatNumber(maxDd, 2)}%
                        </span>
                        <span className="text-[10px] text-slate-500">Peak-to-trough decline</span>
                      </div>

                      <div className="p-3.5 rounded-xl bg-slate-900/80 border border-white/5">
                        <span className="block text-[11px] uppercase font-semibold text-slate-400">Total Trades</span>
                        <span className="mt-1 block text-xl font-extrabold text-white">
                          {metrics.totalTrades || 0}
                        </span>
                        <span className="text-[10px] text-slate-500">Executed simulations</span>
                      </div>
                    </div>
                  </GlassPanel>
                </Reveal>

                {/* Tabs & Table Inspector */}
                <Reveal delayMs={200}>
                  <GlassPanel className="p-6 border-white/10">
                    <div className="flex items-center justify-between border-b border-white/10 pb-4 mb-4">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setActiveTab("trades")}
                          className={`px-4 py-2 rounded-xl text-xs font-bold transition ${
                            activeTab === "trades"
                              ? "bg-cyan-500/20 text-cyan-200 border border-cyan-500/30 shadow-inner"
                              : "text-slate-400 hover:text-white hover:bg-white/5"
                          }`}
                        >
                          📜 Trade Log ({details.trades.length})
                        </button>
                        <button
                          type="button"
                          onClick={() => setActiveTab("monthly")}
                          className={`px-4 py-2 rounded-xl text-xs font-bold transition ${
                            activeTab === "monthly"
                              ? "bg-cyan-500/20 text-cyan-200 border border-cyan-500/30 shadow-inner"
                              : "text-slate-400 hover:text-white hover:bg-white/5"
                          }`}
                        >
                          📅 Monthly Breakdown ({details.monthlyPerformance.length})
                        </button>
                      </div>
                    </div>

                    {activeTab === "trades" ? (
                      details.trades.length === 0 ? (
                        <div className="py-8 text-center text-xs text-slate-500">No simulated trades executed in this window.</div>
                      ) : (
                        <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
                          <table className="w-full text-left border-collapse">
                            <thead>
                              <tr className="border-b border-white/10 text-[11px] font-semibold uppercase tracking-wider text-slate-400 sticky top-0 bg-slate-950 z-10">
                                <th className="py-3 px-3">Side</th>
                                <th className="py-3 px-3">Qty</th>
                                <th className="py-3 px-3">Entry Price / Time</th>
                                <th className="py-3 px-3">Exit Price / Time</th>
                                <th className="py-3 px-3">P&amp;L (₹)</th>
                                <th className="py-3 px-3">Return %</th>
                                <th className="py-3 px-3">Exit Reason</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-white/5 text-xs">
                              {details.trades.map((t) => {
                                const p = t.pnl || 0;
                                const r = t.returnPercent || 0;
                                return (
                                  <tr key={t.id} className="hover:bg-white/[0.02] transition">
                                    <td className="py-3 px-3">
                                      <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-extrabold ${
                                        t.side === "BUY" ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30" : "bg-rose-500/20 text-rose-300 border border-rose-500/30"
                                      }`}>
                                        {t.side}
                                      </span>
                                    </td>
                                    <td className="py-3 px-3 font-semibold text-slate-200">{formatNumber(t.quantity, 0)}</td>
                                    <td className="py-3 px-3">
                                      <div className="font-bold text-white">₹{formatNumber(t.entryPrice, 2)}</div>
                                      <div className="text-[10px] text-slate-500">{formatTimestamp(t.entryTime)}</div>
                                    </td>
                                    <td className="py-3 px-3">
                                      <div className="font-bold text-white">₹{formatNumber(t.exitPrice, 2)}</div>
                                      <div className="text-[10px] text-slate-500">{formatTimestamp(t.exitTime)}</div>
                                    </td>
                                    <td className={`py-3 px-3 font-extrabold ${p >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                                      {p >= 0 ? "+" : ""}₹{formatNumber(p, 2)}
                                    </td>
                                    <td className={`py-3 px-3 font-semibold ${r >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                                      {r >= 0 ? "+" : ""}{formatNumber(r, 2)}%
                                    </td>
                                    <td className="py-3 px-3">
                                      <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] bg-slate-900 text-slate-300 border border-white/10 font-mono">
                                        {t.exitReason || "TARGET"}
                                      </span>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )
                    ) : (
                      details.monthlyPerformance.length === 0 ? (
                        <div className="py-8 text-center text-xs text-slate-500">No monthly performance breakdown recorded.</div>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full text-left border-collapse">
                            <thead>
                              <tr className="border-b border-white/10 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                                <th className="py-3 px-4">Month</th>
                                <th className="py-3 px-4">Trades</th>
                                <th className="py-3 px-4">Wins / Losses</th>
                                <th className="py-3 px-4">Gross Profit</th>
                                <th className="py-3 px-4">Gross Loss</th>
                                <th className="py-3 px-4">Net P&amp;L (₹)</th>
                                <th className="py-3 px-4">Max Drawdown</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-white/5 text-xs">
                              {details.monthlyPerformance.map((m, idx) => {
                                const net = m.netPnl || 0;
                                const losses = (m.tradeCount || 0) - (m.winningTradeCount || 0);
                                return (
                                  <tr key={idx} className="hover:bg-white/[0.02] transition">
                                    <td className="py-3.5 px-4 font-bold text-white font-mono">{m.monthStart}</td>
                                    <td className="py-3.5 px-4 font-semibold text-slate-200">{m.tradeCount}</td>
                                    <td className="py-3.5 px-4">
                                      <span className="text-emerald-400 font-bold">{m.winningTradeCount}W</span>
                                      <span className="text-slate-500 mx-1">/</span>
                                      <span className="text-rose-400 font-bold">{losses}L</span>
                                    </td>
                                    <td className="py-3.5 px-4 text-emerald-400 font-semibold">+₹{formatNumber(m.grossProfit, 2)}</td>
                                    <td className="py-3.5 px-4 text-rose-400 font-semibold">-₹{formatNumber(m.grossLoss, 2)}</td>
                                    <td className={`py-3.5 px-4 font-extrabold text-sm ${net >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                                      {net >= 0 ? "+" : ""}₹{formatNumber(net, 2)}
                                    </td>
                                    <td className="py-3.5 px-4 text-rose-400 font-semibold">-{formatNumber(m.maxDrawdownPercent, 2)}%</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )
                    )}
                  </GlassPanel>
                </Reveal>
              </>
            )}
          </div>
        </div>

        {/* Modal: Run New Backtest Simulation */}
        {showRunModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
            <GlassPanel className="w-full max-w-md p-6 border-cyan-500/30 bg-slate-950 shadow-2xl">
              <h3 className="text-xl font-bold text-white">Replay Historical Data</h3>
              <p className="text-xs text-slate-400 mt-1">
                Execute tick/candle-level strategy replay over a specified historical date range.
              </p>

              {runMessage && <p className="mt-3 text-xs text-emerald-300 bg-emerald-500/10 p-2.5 rounded-xl border border-emerald-500/20 font-bold">{runMessage}</p>}
              {runError && <p className="mt-3 text-xs text-rose-400 bg-rose-500/10 p-2.5 rounded-xl border border-rose-500/20 font-medium">{runError}</p>}

              <form onSubmit={handleRunSubmit} className="mt-4 space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 uppercase">Instrument Symbol</label>
                  <input
                    type="text"
                    required
                    value={runSymbol}
                    onChange={(e) => setRunSymbol(e.target.value)}
                    className="mt-1 w-full rounded-xl bg-slate-900 border border-white/10 px-3.5 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-400 font-bold uppercase"
                    placeholder="e.g. NIFTY50, RELIANCE"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-300 uppercase">Timeframe</label>
                  <select
                    value={runTimeframe}
                    onChange={(e) => setRunTimeframe(e.target.value)}
                    className="mt-1 w-full rounded-xl bg-slate-900 border border-white/10 px-3.5 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-400"
                  >
                    <option value="15m">15 Minutes (15m)</option>
                    <option value="1h">1 Hour (1h)</option>
                    <option value="1d">Daily (1d)</option>
                    <option value="1w">Weekly (1w)</option>
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 uppercase">Start Date</label>
                    <input
                      type="date"
                      required
                      value={startDate}
                      onChange={(e) => setStartDate(e.target.value)}
                      className="mt-1 w-full rounded-xl bg-slate-900 border border-white/10 px-3 py-2 text-xs text-white focus:outline-none focus:ring-2 focus:ring-cyan-400"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 uppercase">End Date</label>
                    <input
                      type="date"
                      required
                      value={endDate}
                      onChange={(e) => setEndDate(e.target.value)}
                      className="mt-1 w-full rounded-xl bg-slate-900 border border-white/10 px-3 py-2 text-xs text-white focus:outline-none focus:ring-2 focus:ring-cyan-400"
                    />
                  </div>
                </div>
                <div className="flex items-center justify-end gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowRunModal(false)}
                    className="px-4 py-2 rounded-xl text-sm font-semibold text-slate-400 hover:text-white transition"
                  >
                    Close
                  </button>
                  <button
                    type="submit"
                    disabled={running}
                    className="px-5 py-2 rounded-xl text-sm font-bold text-white bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 transition shadow-lg shadow-cyan-500/20 disabled:opacity-50 flex items-center gap-2"
                  >
                    {running ? (
                      <>
                        <span className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                        <span>Replaying...</span>
                      </>
                    ) : (
                      <span>⚡ Execute Replay</span>
                    )}
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

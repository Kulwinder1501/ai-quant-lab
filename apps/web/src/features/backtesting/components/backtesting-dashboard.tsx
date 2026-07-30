"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { Download } from "lucide-react";
import { exportToCsv } from "../../../lib/export";
import { GlassPanel } from "../../../components/ui/glass-panel";
import { Reveal } from "../../../components/ui/reveal";
import { getResearchJson, postResearchJson } from "../../research/api";
import { formatNumber, formatPercentage, formatTimestamp } from "../../research/presentation";
import { PageHeader } from "../../../components/layout/page-header";
import type { BacktestRunRow, BacktestRunDetails } from "../domain";
import { RunBacktestModal } from "./run-backtest-modal";
import { BacktestList } from "./backtest-list";
import { TearSheetMetrics } from "./tear-sheet-metrics";
import { TradeLogTable } from "./trade-log-table";
import { MonthlyBreakdownTable } from "./monthly-breakdown-table";

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
    <>
      <PageHeader eyebrow="Historical Replay"
      title="Backtesting & Performance Reports"
      description="Simulate quantitative strategies over historical data windows with tick-level replay, slippage modeling, and multi-metric tear sheets."
      connectionLabel="Replay Engine Ready" />
      <div className="mt-10">
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

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  if (details?.trades) {
                    exportToCsv(details.trades, `backtest-trades-${selectedRunId}`);
                  }
                }}
                disabled={!details?.trades?.length}
                className="px-4 py-2 rounded-xl text-xs font-bold text-slate-200 bg-slate-900 border border-white/10 hover:bg-slate-800 transition flex items-center gap-1.5 disabled:opacity-50"
              >
                <Download className="h-4 w-4" />
                <span>Export CSV</span>
              </button>
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

                <BacktestList
                  runs={runs}
                  loadingList={loadingList}
                  selectedRunId={selectedRunId}
                  setSelectedRunId={setSelectedRunId}
                />
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
                  <TearSheetMetrics 
                    details={details}
                    netPnl={netPnl}
                    winRate={winRate}
                    profitFactor={profitFactor}
                    sharpe={sharpe}
                    maxDd={maxDd}
                  />
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
                      <TradeLogTable trades={details.trades} />
                    ) : (
                      <MonthlyBreakdownTable monthlyPerformance={details.monthlyPerformance} />
                    )}
                  </GlassPanel>
                </Reveal>
              </>
            )}
          </div>
        </div>

        {/* Modal: Run New Backtest Simulation */}
        <RunBacktestModal
          show={showRunModal}
          onClose={() => setShowRunModal(false)}
          runSymbol={runSymbol}
          setRunSymbol={setRunSymbol}
          runTimeframe={runTimeframe}
          setRunTimeframe={setRunTimeframe}
          startDate={startDate}
          setStartDate={setStartDate}
          endDate={endDate}
          setEndDate={setEndDate}
          running={running}
          runMessage={runMessage}
          runError={runError}
          onSubmit={handleRunSubmit}
        />
      </div>
    </div>
    </>
  );
}

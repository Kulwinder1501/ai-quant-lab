import React from "react";
import { formatNumber } from "../../research/presentation";
import type { BacktestRunRow } from "../domain";

interface BacktestListProps {
  runs: BacktestRunRow[];
  loadingList: boolean;
  selectedRunId: string;
  setSelectedRunId: (id: string) => void;
}

export function BacktestList({ runs, loadingList, selectedRunId, setSelectedRunId }: BacktestListProps) {
  if (loadingList && runs.length === 0) {
    return <div className="py-8 text-center text-xs text-slate-400">Loading simulations...</div>;
  }

  if (runs.length === 0) {
    return (
      <div className="py-8 text-center rounded-xl border border-dashed border-white/10 bg-white/5 p-4">
        <p className="text-xs font-semibold text-slate-300">No backtest runs recorded</p>
        <p className="text-[11px] text-slate-500 mt-1">Click &quot;Run New Backtest&quot; to replay historical strategy performance.</p>
      </div>
    );
  }

  return (
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
  );
}

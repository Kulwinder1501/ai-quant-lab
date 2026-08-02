import React from "react";
import { Tooltip } from "../../../components/ui/tooltip";
import { formatNumber } from "../../research/presentation";
import type { BacktestMetrics, BacktestRunDetails } from "../domain";

interface TearSheetMetricsProps {
  details: BacktestRunDetails;
  netPnl: number;
  winRate: number;
  profitFactor: number | null;
  sharpe: number | null;
  maxDd: number;
}

export function TearSheetMetrics({ details, netPnl, winRate, profitFactor, sharpe, maxDd }: TearSheetMetricsProps) {
  const metrics: BacktestMetrics = details.run.metrics || {};
  return (
    <div className="p-6 border-white/10 bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 rounded-2xl border">
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
          <span className="block text-[11px] uppercase font-semibold text-slate-400">
            <Tooltip content="Ratio of gross profit to gross loss. Values > 1 indicate profitability.">Profit Factor</Tooltip>
          </span>
          <span className="mt-1 block text-xl font-extrabold text-white">
            {profitFactor !== null ? formatNumber(profitFactor, 2) : "—"}
          </span>
          <span className="text-[10px] text-slate-500">
            Gross Profit / Gross Loss
          </span>
        </div>

        <div className="p-3.5 rounded-xl bg-slate-900/80 border border-white/5">
          <span className="block text-[11px] uppercase font-semibold text-slate-400">
            <Tooltip content="Risk-adjusted return metric. Higher is better.">Sharpe Ratio</Tooltip>
          </span>
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
    </div>
  );
}

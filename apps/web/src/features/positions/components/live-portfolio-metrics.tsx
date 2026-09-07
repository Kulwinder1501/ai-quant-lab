import React, { memo } from "react";
import { formatNumber, formatPercentage } from "../../research/presentation";
import { GlassPanel } from "../../../components/ui/glass-panel";

interface LivePortfolioMetricsProps {
  livePortfolioStats: {
    liveEquity: number;
    totalReturnPercent: number;
    totalUnrealizedPnl: number;
    openCount: number;
    winningPositions: number;
    losingPositions: number;
    unavailablePositions: number;
    totalInvestedMargin: number;
  };
}

export const LivePortfolioMetrics = memo(function LivePortfolioMetrics({ livePortfolioStats }: LivePortfolioMetricsProps) {
  return (
    <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-4">
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
          {livePortfolioStats.unavailablePositions > 0 && (
            <span className="ml-1 text-amber-300">({livePortfolioStats.unavailablePositions} awaiting mark; excluded)</span>
          )}
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
  );
});

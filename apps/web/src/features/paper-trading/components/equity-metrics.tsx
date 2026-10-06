import { GlassPanel } from "../../../components/ui/glass-panel";
import { formatNumber } from "../../research/presentation";

interface EquityMetricsProps {
  metrics: {
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    winRatePercent: number;
    realizedPnl: number;
    unrealizedPnl: number;
    equity: number;
  };
  openingBalance: number;
  openTradesCount: number;
}

export function EquityMetrics({ metrics, openingBalance, openTradesCount }: EquityMetricsProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      <GlassPanel className="p-5 border-white/10 bg-gradient-to-br from-slate-950 to-slate-900/80">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Total Equity</p>
        <p className="mt-2 text-2xl md:text-3xl font-extrabold text-white">
          ₹{formatNumber(metrics.equity, 2)}
        </p>
        <p className="mt-1 text-xs text-slate-500">
          Initial: ₹{formatNumber(openingBalance, 0)}
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
          Across {openTradesCount} active positions
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
  );
}

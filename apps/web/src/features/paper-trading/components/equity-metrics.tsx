import { GlassPanel } from "../../../components/ui/glass-panel";
import { formatNumber } from "../../research/presentation";
import type { PaperAccountMetrics } from "../domain";

interface EquityMetricsProps {
  metrics: PaperAccountMetrics;
  /** Sum of the live marks on open positions; zero when none is marked. */
  unrealizedPnl: number;
  /** Open positions with no safe live mark, which the unrealised figure leaves out. */
  unmarkedCount: number;
  openTradesCount: number;
}

export function EquityMetrics({ metrics, unrealizedPnl, unmarkedCount, openTradesCount }: EquityMetricsProps) {
  const liveEquity = metrics.currentEquity + unrealizedPnl;
  const losingTradeCount = metrics.closedTradeCount - metrics.winningTradeCount;
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      <GlassPanel className="p-5 border-white/10 bg-gradient-to-br from-slate-950 to-slate-900/80">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Total Equity</p>
        <p className="mt-2 text-xl md:text-2xl xl:text-3xl font-extrabold text-white">
          ₹{formatNumber(liveEquity, 2)}
        </p>
        <p className="mt-1 text-xs text-slate-500">
          Initial: ₹{formatNumber(metrics.openingBalance, 0)} · Available: ₹{formatNumber(metrics.availableCapital, 0)}
        </p>
      </GlassPanel>

      <GlassPanel className="p-5 border-white/10 bg-gradient-to-br from-slate-950 to-slate-900/80">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Realized P&amp;L</p>
        <p className={`mt-2 text-xl md:text-2xl xl:text-3xl font-extrabold ${metrics.realizedPnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
          {metrics.realizedPnl >= 0 ? "+" : ""}₹{formatNumber(metrics.realizedPnl, 2)}
        </p>
        <p className="mt-1 text-xs text-slate-500">
          From {metrics.closedTradeCount} closed simulated positions
        </p>
      </GlassPanel>

      <GlassPanel className="p-5 border-white/10 bg-gradient-to-br from-slate-950 to-slate-900/80">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Unrealized P&amp;L</p>
        <p className={`mt-2 text-xl md:text-2xl xl:text-3xl font-extrabold ${unrealizedPnl >= 0 ? "text-cyan-400" : "text-rose-400"}`}>
          {unrealizedPnl >= 0 ? "+" : ""}₹{formatNumber(unrealizedPnl, 2)}
        </p>
        <p className="mt-1 text-xs text-slate-500">
          Across {openTradesCount} active positions
          {unmarkedCount > 0 && <span className="text-amber-300"> ({unmarkedCount} without a live mark)</span>}
        </p>
      </GlassPanel>

      <GlassPanel className="p-5 border-white/10 bg-gradient-to-br from-slate-950 to-slate-900/80">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Win Rate &amp; Stats</p>
        <div className="mt-2 flex items-baseline gap-2">
          <span className="text-xl md:text-2xl xl:text-3xl font-extrabold text-amber-300">
            {formatNumber(metrics.winRatePercent, 1)}%
          </span>
          <span className="text-xs text-slate-400">
            ({metrics.winningTradeCount}W / {losingTradeCount}L)
          </span>
        </div>
        <p className="mt-1 text-xs text-slate-500">
          Execution accuracy on completed trades
        </p>
      </GlassPanel>
    </div>
  );
}

import { GlassPanel } from "../../../components/ui/glass-panel";
import { Reveal } from "../../../components/ui/reveal";
import { formatNumber } from "../../research/presentation";
import { formatHoldingPeriod } from "../domain";
import { StatCard } from "../../../components/ui/stat-card";
import { Tooltip } from "../../../components/ui/tooltip";

function currency(value: number | null, fractionDigits = 2): string {
  if (value === null) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}₹${formatNumber(value, fractionDigits)}`;
}

export function TradeHistorySummary({ summary }: { summary: any }) {
  if (!summary) return null;
  return (
    <>
      <Reveal delayMs={90}>
        <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-4">
          <StatCard
            hint={`${summary.closedTradeCount} closed - ${summary.openTradeCount} open`}
            label="Trades in view"
            value={String(summary.tradeCount)}
            accent="cyan"
          />
          <StatCard
            hint={`${summary.winningTradeCount} W / ${summary.losingTradeCount} L / ${summary.breakEvenTradeCount} flat`}
            label="Realised win rate"
            value={summary.winRatePercent === null ? "—" : `${formatNumber(summary.winRatePercent, 1)}%`}
            accent="cyan"
          />
          <StatCard
            hint={`Gross ${currency(summary.grossProfit)} / ${
              summary.grossLoss === 0 ? "₹0.00" : `-₹${formatNumber(summary.grossLoss, 2)}`
            }`}
            label="Net realised P&L"
            value={currency(summary.netRealizedPnl)}
            accent={summary.netRealizedPnl >= 0 ? "emerald" : "rose"}
          />
          <StatCard
            hint={`Expectancy ${currency(summary.expectancy)} per closed trade`}
            label={<Tooltip content="Ratio of gross profit to gross loss. Values > 1 indicate profitability.">Profit factor</Tooltip>}
            value={summary.profitFactor === null ? "—" : formatNumber(summary.profitFactor, 2)}
            accent="cyan"
          />
          <StatCard
            hint={`Average win ${currency(summary.averageWin)}`}
            label="Average loss"
            value={currency(summary.averageLoss)}
            accent="cyan"
          />
          <StatCard
            hint="Peak-to-trough decline of the realised P&L curve"
            label="Maximum drawdown"
            value={summary.maximumDrawdown === 0 ? "₹0.00" : `-₹${formatNumber(summary.maximumDrawdown, 2)}`}
            accent="rose"
          />
          <StatCard
            hint="Realised profit as a multiple of the risk accepted at entry"
            label="Average reward"
            value={summary.averageRewardMultiple === null ? "—" : `${formatNumber(summary.averageRewardMultiple, 2)}R`}
            accent="cyan"
          />
          <StatCard
            hint={`Costs ${currency(summary.totalFees)} fees - ${currency(summary.totalSlippage)} slippage`}
            label="Average hold"
            // formatHoldingPeriod reads null as "still open", which is right for a
            // row and wrong for an aggregate with no closed trades behind it.
            value={summary.averageHoldingMinutes === null
              ? "—"
              : formatHoldingPeriod(Math.round(summary.averageHoldingMinutes))}
            accent="cyan"
          />
        </div>
      </Reveal>

      {summary.closedTradeCount > 0 && (
        <Reveal delayMs={140}>
          <GlassPanel className="border-white/10 p-6">
            <h3 className="text-sm font-extrabold uppercase tracking-wider text-slate-300">How positions ended</h3>
            <div className="mt-4 grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-4">
              {(
                [
                  ["TARGET", "Target", "text-emerald-300"],
                  ["STOP_LOSS", "Stop loss", "text-rose-300"],
                  ["MANUAL", "Manual", "text-amber-200"],
                  ["CANCELLED", "Cancelled", "text-slate-300"],
                ] as const
              ).map(([key, label, tone]) => (
                <div className="rounded-xl border border-white/10 bg-slate-950/60 p-4" key={key}>
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">{label}</p>
                  <p className={`mt-1 text-xl font-black ${tone}`}>{summary.exitReasonCounts[key]}</p>
                </div>
              ))}
            </div>
          </GlassPanel>
        </Reveal>
      )}
    </>
  );
}

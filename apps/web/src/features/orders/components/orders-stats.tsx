import { formatNumber, formatPercentage } from "../../research/presentation";
import { StatCard } from "../../../components/ui/stat-card";

interface OrdersStatsProps {
  orderStats: {
    total: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnl: number;
    totalVolume: number;
  };
}

export function OrdersStats({ orderStats }: OrdersStatsProps) {
  return (
    <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-4">
      <StatCard
        label="Completed AI Orders"
        value={orderStats.total.toString()}
        hint={`Volume: ₹${formatNumber(orderStats.totalVolume, 0)}`}
        accent="cyan"
      />

      <StatCard
        label="AI Execution Win Rate"
        value={formatPercentage(orderStats.winRate / 100)}
        hint={`Ratio: ${orderStats.wins} W / ${orderStats.losses} L`}
        accent="cyan"
      />

      <StatCard
        label="Net Realized P&L"
        value={`${orderStats.totalPnl >= 0 ? "+" : ""}₹${formatNumber(orderStats.totalPnl, 2)}`}
        hint="Locked-in trading gains / losses"
        accent={orderStats.totalPnl >= 0 ? "emerald" : "rose"}
      />

      <StatCard
        label="Execution Audit Status"
        value="● 100% Algorithmic"
        hint="Zero human slippage delays"
        accent="emerald"
      />
    </div>
  );
}

import { TradeHistoryDashboard } from "../../features/trade-history/components/trade-history-dashboard";

export default function ScalpTradeHistoryPage() {
  return <TradeHistoryDashboard strategyKey="momentum-scalp" isScalp={true} />;
}

import { TradeHistoryDashboard } from "../../../features/trade-history/components/trade-history-dashboard";

export default async function TradeHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string }>;
}) {
  const { mode } = await searchParams;
  return <TradeHistoryDashboard initialMode={mode === "scalp" ? "scalp" : "swing"} />;
}

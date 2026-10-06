import { TradeHistoryDashboard } from "../../../features/trade-history/components/trade-history-dashboard";
import type { TradeHistoryMode } from "../../../features/trade-history/domain";

export default async function TradeHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string }>;
}) {
  const { mode } = await searchParams;
  const initialMode: TradeHistoryMode = mode === "scalp" ? "scalp" : mode === "swing" ? "swing" : "all";
  return <TradeHistoryDashboard initialMode={initialMode} />;
}

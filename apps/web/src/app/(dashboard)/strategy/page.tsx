import { StrategyDashboard } from "../../../features/strategy/components/strategy-dashboard";

export default async function StrategyPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string }>;
}) {
  const { mode } = await searchParams;
  return <StrategyDashboard initialMode={mode === "scalp" ? "scalp" : "swing"} />;
}

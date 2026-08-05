import { PositionsOrdersDashboard } from "../../../features/positions-orders/components/positions-orders-dashboard";

export default async function PositionsOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  const initialMode = tab === "orders" ? "orders" : tab === "history" ? "history" : "positions";
  return <PositionsOrdersDashboard initialMode={initialMode} />;
}

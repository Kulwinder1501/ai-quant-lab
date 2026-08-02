import { PositionsOrdersDashboard } from "../../../features/positions-orders/components/positions-orders-dashboard";

export default async function PositionsOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  return <PositionsOrdersDashboard initialMode={tab === "orders" ? "orders" : "positions"} />;
}

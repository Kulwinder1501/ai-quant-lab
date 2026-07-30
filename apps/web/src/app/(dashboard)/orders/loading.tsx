import { SkeletonCard, SkeletonStatGrid, SkeletonTable } from "../../../components/ui/skeleton";

export default function OrdersLoading() {
  return (
    <div className="space-y-8">
      <SkeletonCard className="h-16" />
      <SkeletonStatGrid columns={4} />
      <SkeletonTable rows={8} columns={6} />
    </div>
  );
}

import { SkeletonStatGrid, SkeletonTable, SkeletonCard } from "../../components/ui/skeleton";

export default function DashboardLoading() {
  return (
    <div className="space-y-8">
      <SkeletonCard className="h-24" />
      <SkeletonStatGrid columns={4} />
      <SkeletonTable rows={6} columns={5} />
    </div>
  );
}

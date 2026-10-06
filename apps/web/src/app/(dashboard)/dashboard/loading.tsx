import { SkeletonCard, SkeletonStatGrid, SkeletonTable } from "../../../components/ui/skeleton";

export default function DashboardLoading() {
  return (
    <div className="space-y-8">
      <SkeletonCard className="h-20" />
      <SkeletonCard className="h-48" />
      <SkeletonStatGrid columns={4} />
      <SkeletonTable rows={4} columns={4} />
    </div>
  );
}

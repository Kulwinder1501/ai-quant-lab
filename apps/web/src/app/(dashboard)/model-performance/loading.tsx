import { SkeletonCard, SkeletonStatGrid, SkeletonTable } from "../../../components/ui/skeleton";

export default function ModelPerformanceLoading() {
  return (
    <div className="space-y-8">
      <SkeletonCard className="h-16" />
      <SkeletonStatGrid columns={3} />
      <SkeletonTable rows={6} columns={7} />
    </div>
  );
}

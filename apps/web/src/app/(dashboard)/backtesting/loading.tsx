import { SkeletonCard, SkeletonStatGrid, SkeletonTable } from "../../../components/ui/skeleton";

export default function BacktestingLoading() {
  return (
    <div className="space-y-8">
      <SkeletonCard className="h-20" />
      <SkeletonStatGrid columns={3} />
      <SkeletonStatGrid columns={3} />
      <SkeletonTable rows={5} columns={6} />
    </div>
  );
}

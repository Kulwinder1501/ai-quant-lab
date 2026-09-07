import { SkeletonCard, SkeletonStatGrid } from "../../../components/ui/skeleton";

export default function StrategyLoading() {
  return (
    <div className="space-y-8">
      <SkeletonCard className="h-16" />
      <SkeletonStatGrid columns={3} />
      <div className="grid gap-4 md:grid-cols-2">
        <SkeletonCard className="h-48" />
        <SkeletonCard className="h-48" />
        <SkeletonCard className="h-48" />
        <SkeletonCard className="h-48" />
      </div>
    </div>
  );
}

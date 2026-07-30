import { SkeletonCard } from "../../../components/ui/skeleton";

export default function PredictionsLoading() {
  return (
    <div className="space-y-8">
      <SkeletonCard className="h-20" />
      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        <SkeletonCard className="h-64" />
        <SkeletonCard className="h-64" />
      </div>
    </div>
  );
}

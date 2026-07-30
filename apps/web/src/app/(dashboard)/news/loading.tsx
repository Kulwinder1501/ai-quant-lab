import { SkeletonCard } from "../../../components/ui/skeleton";

export default function NewsLoading() {
  return (
    <div className="space-y-8">
      <SkeletonCard className="h-24" />
      <SkeletonCard className="h-12" />
      <div className="grid gap-4 md:grid-cols-2">
        <SkeletonCard className="h-40" />
        <SkeletonCard className="h-40" />
        <SkeletonCard className="h-40" />
        <SkeletonCard className="h-40" />
      </div>
    </div>
  );
}

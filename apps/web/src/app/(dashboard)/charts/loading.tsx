import { SkeletonCard, SkeletonChart } from "../../../components/ui/skeleton";

export default function ChartsLoading() {
  return (
    <div className="space-y-8">
      <SkeletonCard className="h-16" />
      <SkeletonChart className="h-[500px]" />
    </div>
  );
}

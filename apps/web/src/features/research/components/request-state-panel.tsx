import { GlassPanel } from "../../../components/ui/glass-panel";
import { MarketLoader } from "../../../components/ui/market-loader";

export type RequestState = "loading" | "ready" | "empty" | "unavailable";

interface RequestStatePanelProps {
  state: Exclude<RequestState, "ready">;
  loadingTitle: string;
  emptyTitle: string;
  unavailableTitle: string;
  loadingDescription: string;
  emptyDescription: string;
  unavailableDescription: string;
  className?: string;
}

export function RequestStatePanel({
  state,
  loadingTitle,
  emptyTitle,
  unavailableTitle,
  loadingDescription,
  emptyDescription,
  unavailableDescription,
  className,
}: RequestStatePanelProps) {
  const title = state === "loading" ? loadingTitle : state === "empty" ? emptyTitle : unavailableTitle;
  const description = state === "loading"
    ? loadingDescription
    : state === "empty"
      ? emptyDescription
      : unavailableDescription;

  return (
    <GlassPanel className={`flex min-h-64 flex-col justify-center border-dashed border-slate-600/80 bg-slate-950/40 p-7 text-center ${className ?? ""}`}>
      {/* Only the waiting state animates. `empty` and `unavailable` are settled outcomes, and
          motion on them would suggest the view is still working on something. Changing it here
          rather than per view means all eight callers of this panel pick the loader up at once. */}
      {state === "loading"
        ? <MarketLoader className="py-0" label={title} size="sm" />
        : <p className="text-sm font-medium text-slate-100">{title}</p>}
      <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-slate-400">{description}</p>
    </GlassPanel>
  );
}

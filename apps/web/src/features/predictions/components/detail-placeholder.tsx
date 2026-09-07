import { GlassPanel } from "../../../components/ui/glass-panel";

interface DetailPlaceholderProps {
  loading: boolean;
  unavailable?: boolean;
}

export function DetailPlaceholder({ loading, unavailable = false }: DetailPlaceholderProps) {
  return (
    <GlassPanel className="flex min-h-80 flex-col justify-center border-dashed border-slate-600/80 bg-slate-950/40 p-7 text-center">
      <p className="text-sm font-medium text-slate-100">{loading ? "Loading the recorded explanation..." : unavailable ? "Prediction explanation is unavailable" : "Select a recorded prediction"}</p>
      <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-slate-400">
        {unavailable
          ? "The selected record could not be read, so the dashboard does not substitute live data or derive a new explanation."
          : "The explanation inspector only reads the stored model evidence and does not trigger a strategy, paper-trade, or order workflow."}
      </p>
    </GlassPanel>
  );
}

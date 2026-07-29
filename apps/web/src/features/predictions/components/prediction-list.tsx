import { GlassPanel } from "../../../components/ui/glass-panel";
import { formatPercentage, formatTimestamp, labelTone } from "../../research/presentation";
import type { PredictionSummary } from "../domain";

interface PredictionListProps {
  records: PredictionSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function PredictionList({ records, selectedId, onSelect }: PredictionListProps) {
  return (
    <GlassPanel className="overflow-hidden">
      <div className="border-b border-white/10 px-5 py-4">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-100">Persisted model records</p>
        <h2 className="mt-2 font-semibold text-slate-100">Recorded predictions</h2>
        <p className="mt-1 text-sm text-slate-400">Newest persisted research observations, not trading signals.</p>
      </div>
      <div className="divide-y divide-white/10">
        {records.map((record) => {
          const selected = record.id === selectedId;
          return (
            <button
              aria-pressed={selected}
              className={`group w-full px-5 py-4 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-200 motion-reduce:transition-none ${selected ? "bg-cyan-200/[0.08]" : "hover:bg-white/[0.045]"}`}
              key={record.id}
              onClick={() => onSelect(record.id)}
              type="button"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-medium text-slate-100">{record.instrument.symbol} <span className="font-normal text-slate-400">- {record.sourceCandle.timeframe ?? "timeframe unavailable"}</span></p>
                  <p className="mt-1 text-xs text-slate-500">Evidence cutoff: {formatTimestamp(record.evidenceCutoffAt)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`rounded-full border px-2.5 py-1 text-xs font-bold tracking-wide ${labelTone(record.prediction)}`}>{record.prediction}</span>
                  <span className="text-sm font-semibold text-slate-200">{formatPercentage(record.confidence)}</span>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </GlassPanel>
  );
}

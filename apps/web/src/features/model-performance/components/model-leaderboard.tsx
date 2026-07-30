import { GlassPanel } from "../../../components/ui/glass-panel";
import { Reveal } from "../../../components/ui/reveal";
import { Tooltip } from "../../../components/ui/tooltip";
import { formatNumber, formatTimestamp } from "../../research/presentation";
import {
  algorithmLabel,
  explanationMethodLabel,
  generalizationLabel,
  stageTone,
  type ModelVersionPerformance,
  type LeakageRisk,
} from "../domain";

function metric(value: number | null, fractionDigits = 3): string {
  return value === null ? "—" : formatNumber(value, fractionDigits);
}

export function leakageBadge(risk: LeakageRisk) {
  if (risk === "SUSPICIOUS_SCORE") {
    return <span className="ml-2 inline-flex items-center rounded bg-rose-500/20 px-1.5 py-0.5 text-[10px] font-bold text-rose-300" title="Suspiciously high score (>0.60)">LEAKAGE RISK</span>;
  }
  if (risk === "NEGATIVE_GAP") {
    return <span className="ml-2 inline-flex items-center rounded bg-rose-500/20 px-1.5 py-0.5 text-[10px] font-bold text-rose-300" title="Holdout score exceeds training score">LEAKAGE RISK</span>;
  }
  return null;
}

export function ModelLeaderboard({ 
  records, 
  selectedId, 
  setSelectedId, 
  pageTruncated, 
  pageLimit 
}: { 
  records: ModelVersionPerformance[]; 
  selectedId: string | null; 
  setSelectedId: (id: string) => void;
  pageTruncated: boolean;
  pageLimit: number;
}) {
  return (
    <Reveal delayMs={140}>
      <GlassPanel className="border-white/10 p-6">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-extrabold text-white">Version leaderboard</h3>
              <div className="group relative flex items-center justify-center">
                <div className="flex h-5 w-5 cursor-help items-center justify-center rounded-full bg-cyan-500/20 text-xs font-bold text-cyan-400 transition hover:bg-cyan-500/40">
                  i
                </div>
                <div className="pointer-events-none absolute -left-4 sm:left-0 top-full z-50 mt-2 w-[calc(100vw-4rem)] max-w-sm sm:w-80 origin-top-left scale-95 rounded-xl border border-white/10 bg-slate-950 p-4 opacity-0 shadow-2xl transition-all group-hover:scale-100 group-hover:opacity-100">
                  <p className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-300">Target Metrics</p>
                  <ul className="space-y-2 text-xs text-slate-400">
                    <li><strong className="text-emerald-400"><Tooltip content="Harmonic mean of precision and recall. Accounts for class imbalance.">Macro-F1</Tooltip> & Accuracy:</strong> 0.530 - 0.560 is excellent in quant finance. &gt;0.600 usually indicates data leakage.</li>
                    <li><strong className="text-cyan-400">Train-Holdout Gap:</strong> 0.000 - 0.050 is healthy. A massive gap (e.g., 0.200) means the model is severely overfitted and will fail in live trading.</li>
                  </ul>
                </div>
              </div>
            </div>
            <p className="mt-0.5 text-xs text-slate-400">
              Newest training run first. Holdout <Tooltip content="Harmonic mean of precision and recall. Accounts for class imbalance.">macro-F1</Tooltip> is the metric the promotion gate compares.
            </p>
          </div>
          {pageTruncated && (
            <span className="rounded-full border border-amber-300/35 bg-amber-200/10 px-3 py-1 text-xs font-semibold text-amber-100">
              Showing the newest {pageLimit} versions only
            </span>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-white/10 text-xs font-bold uppercase tracking-wider text-slate-400">
                <th className="px-4 py-3">Version</th>
                <th className="px-4 py-3">Algorithm</th>
                <th className="px-4 py-3">Stage</th>
                <th className="px-4 py-3">Holdout <Tooltip content="Harmonic mean of precision and recall. Accounts for class imbalance.">macro-F1</Tooltip></th>
                <th className="px-4 py-3">Holdout accuracy</th>
                <th className="px-4 py-3">Train-holdout gap</th>
                <th className="px-4 py-3">Rows</th>
                <th className="px-4 py-3">Predictions</th>
                <th className="px-4 py-3">Trained</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5 text-sm font-medium">
              {records.map((record) => {
                const gap = generalizationLabel(record.generalizationGap);
                const isSelected = selectedId === record.id;
                return (
                  <tr
                    aria-selected={isSelected}
                    className={`cursor-pointer transition ${isSelected ? "bg-cyan-300/[0.07]" : "hover:bg-white/[0.03]"}`}
                    key={record.id}
                    onClick={() => setSelectedId(record.id)}
                  >
                    <td className="px-4 py-4 font-extrabold text-white">
                      v{record.version}
                      <span className="mt-0.5 block max-w-[16rem] truncate font-mono text-[11px] font-normal text-slate-500">
                        {record.modelKey}
                      </span>
                    </td>
                    <td className="px-4 py-4 text-xs">
                      <span className="font-bold text-slate-100">{algorithmLabel(record.algorithm)}</span>
                      <span className="mt-0.5 block text-[11px] text-slate-500">
                        {explanationMethodLabel(record.algorithmFamily)}
                      </span>
                    </td>
                    <td className="px-4 py-4">
                      <span className={`inline-flex rounded-md border px-2 py-1 text-xs font-black ${stageTone(record.stage)}`}>
                        {record.stage}
                      </span>
                    </td>
                    <td className="px-4 py-4 font-black text-white">
                      {metric(record.validationMetrics.macroF1)}
                      {leakageBadge(record.leakageRisk)}
                    </td>
                    <td className="px-4 py-4 text-slate-300">{metric(record.validationMetrics.accuracy)}</td>
                    <td className={`px-4 py-4 font-bold ${gap.tone}`}>{metric(record.generalizationGap)}</td>
                    <td className="px-4 py-4 text-xs text-slate-300">
                      {formatNumber(record.trainingRows, 0)} train
                      <span className="mt-0.5 block text-[11px] text-slate-500">
                        {formatNumber(record.validationMetrics.sampleCount, 0)} holdout
                      </span>
                    </td>
                    <td className="px-4 py-4 text-xs text-slate-300">{record.predictionActivity.predictionCount}</td>
                    <td className="px-4 py-4 text-xs text-slate-400">{formatTimestamp(record.trainedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </GlassPanel>
    </Reveal>
  );
}

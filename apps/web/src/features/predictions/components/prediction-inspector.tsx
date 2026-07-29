import { GlassPanel } from "../../../components/ui/glass-panel";
import { asNumber } from "../../research/json";
import { formatNumber, formatPercentage, formatTimestamp, labelTone, scalarSummary } from "../../research/presentation";
import type {
  ExplanationEntry,
  FeatureContribution,
  PredictionDetail,
} from "../domain";

/**
 * Names where a contribution came from.
 *
 * A boosted forest has no coefficient, so it reports the TreeSHAP basis instead
 * of an empty coefficient field that would read as missing data.
 */
function contributionBasis(item: FeatureContribution): string {
  if (item.contributionMethod === "TREE_SHAP_V1") {
    return "exact TreeSHAP contribution";
  }
  return item.coefficient === null
    ? "contribution basis not recorded"
    : `coefficient ${formatNumber(item.coefficient, 4)}`;
}

function ContributionList({ contributions }: { contributions: FeatureContribution[] }) {
  if (contributions.length === 0) {
    return <p className="text-sm text-slate-400">No stored feature contributions are available for this record.</p>;
  }
  const maximumMagnitude = Math.max(...contributions.map((item) => Math.abs(item.contribution ?? 0)), 0.000001);
  return (
    <div className="space-y-3">
      {contributions.map((item) => {
        const contribution = item.contribution ?? 0;
        const supportsPrediction = item.supportsPredictedClass ?? contribution >= 0;
        return (
          <div key={item.feature}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
              <p className="font-medium text-slate-200">{item.feature}</p>
              <p className={supportsPrediction ? "text-emerald-100" : "text-rose-100"}>{contribution >= 0 ? "+" : ""}{formatNumber(contribution, 4)}</p>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-800/80">
              <div
                className={`h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none ${supportsPrediction ? "bg-emerald-300" : "bg-rose-300"}`}
                style={{ width: `${Math.max((Math.abs(contribution) / maximumMagnitude) * 100, 2)}%` }}
              />
            </div>
            <p className="mt-1 text-xs text-slate-500">
              {item.category ?? "model feature"} - raw {formatNumber(item.rawValue)} - {contributionBasis(item)}
            </p>
          </div>
        );
      })}
    </div>
  );
}

function ExplanationList({ entries }: { entries: ExplanationEntry[] }) {
  if (entries.length === 0) {
    return <p className="text-sm text-slate-400">No structured explanation entries are available for this record.</p>;
  }
  return (
    <div className="space-y-3">
      {entries.map((entry, index) => (
        <article className="rounded-xl border border-white/10 bg-slate-950/35 p-4" key={`${entry.kind}-${index}`}>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-100">{entry.kind.replaceAll("_", " ")}</p>
          <p className="mt-2 text-sm leading-6 text-slate-200">{entry.summary}</p>
          {scalarSummary(entry.details) ? <p className="mt-2 text-xs leading-5 text-slate-500">{scalarSummary(entry.details)}</p> : null}
        </article>
      ))}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl bg-slate-950/40 p-3"><dt className="text-xs text-slate-500">{label}</dt><dd className="mt-1 text-sm font-medium text-slate-200">{value}</dd></div>;
}

export function PredictionInspector({ prediction }: { prediction: PredictionDetail }) {
  const macroF1 = asNumber(prediction.model.validationMetrics.macroF1);
  return (
    <section className="space-y-5" aria-label="Prediction explanation inspector">
      <GlassPanel className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-100">Explanation inspector</p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-100">{prediction.instrument.symbol} - {prediction.sourceCandle.timeframe ?? "completed candle"}</h2>
            <p className="mt-2 text-sm text-slate-400">Source candle closed {formatTimestamp(prediction.sourceCandle.closeTime)} at {formatNumber(prediction.sourceCandle.close)}.</p>
          </div>
          <div className="text-right">
            <span className={`inline-flex rounded-full border px-3 py-1.5 text-sm font-bold tracking-wide ${labelTone(prediction.prediction)}`}>{prediction.prediction}</span>
            <p className="mt-2 text-sm font-semibold text-slate-100">Model confidence {formatPercentage(prediction.confidence)}</p>
            <p className="mt-1 text-xs text-slate-500">A model probability, not a market forecast guarantee.</p>
          </div>
        </div>
        <dl className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Model version" value={`${prediction.model.key ?? "Unrecorded"}${prediction.model.version === null ? "" : ` v${prediction.model.version}`}`} />
          <Metric label="Validation macro F1" value={formatPercentage(macroF1)} />
          <Metric label="Evidence cutoff" value={formatTimestamp(prediction.evidenceCutoffAt)} />
          <Metric label="Recorded at" value={formatTimestamp(prediction.createdAt)} />
        </dl>
      </GlassPanel>

      <div className="grid gap-5 xl:grid-cols-2">
        <GlassPanel className="p-5">
          <h3 className="font-semibold text-slate-100">Top model inputs</h3>
          <p className="mt-1 text-sm leading-6 text-slate-400">Positive terms support the selected class; negative terms oppose it. These are local logistic-model terms, not causal explanations.</p>
          <div className="mt-5"><ContributionList contributions={prediction.featureContributions} /></div>
        </GlassPanel>
        <GlassPanel className="p-5">
          <h3 className="font-semibold text-slate-100">Recorded context</h3>
          <p className="mt-1 text-sm leading-6 text-slate-400">Patterns, price action, similar-set context, validation limits, and model lineage captured with this observation.</p>
          <div className="mt-5"><ExplanationList entries={prediction.explanation} /></div>
        </GlassPanel>
      </div>
    </section>
  );
}

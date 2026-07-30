import { formatNumber, formatPercentage, formatTimestamp } from "../../research/presentation";
import {
  algorithmLabel,
  generalizationLabel,
  promotionDecisionLabel,
  stageTone,
  type ModelVersionPerformance,
} from "../domain";
import { GlassPanel, InteractiveGlassCard } from "../../../components/ui/glass-panel";
import { Reveal } from "../../../components/ui/reveal";
import { StatCard } from "../../../components/ui/stat-card";
import { Tooltip } from "../../../components/ui/tooltip";

function metric(value: number | null, fractionDigits = 3): string {
  return value === null ? "—" : formatNumber(value, fractionDigits);
}

export function ModelInspector({ selected }: { selected: ModelVersionPerformance }) {
  return (
    <Reveal delayMs={190}>
      <InteractiveGlassCard className="border-white/10 p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-200">Selected version</p>
            <h3 className="mt-1 text-2xl font-black text-white">
              {algorithmLabel(selected.algorithm)} v{selected.version}
            </h3>
            <p className="mt-1 break-all font-mono text-[11px] text-slate-500">{selected.modelKey}</p>
          </div>
          <span className={`rounded-full border px-3 py-1 text-xs font-bold ${stageTone(selected.stage)}`}>
            {selected.stage}
            {selected.promotedAt && ` since ${formatTimestamp(selected.promotedAt)}`}
          </span>
        </div>

        <div className="mt-6 grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-4">
          <StatCard
            hint={`Training macro-F1 ${metric(selected.trainingMetrics.macroF1)}`}
            label={<>Holdout <Tooltip content="Harmonic mean of precision and recall. Accounts for class imbalance.">macro-F1</Tooltip></>}
            value={metric(selected.validationMetrics.macroF1)}
          />
          <StatCard
            hint={selected.validationMetrics.coverage !== null ? `Coverage ${formatPercentage(selected.validationMetrics.coverage)}` : "Hit rate not recorded"}
            label="Directional Hit Rate"
            value={selected.validationMetrics.directionalHitRate !== null ? formatPercentage(selected.validationMetrics.directionalHitRate) : "—"}
          />
          <StatCard
            hint={generalizationLabel(selected.generalizationGap).text}
            label="Train-holdout gap"
            value={metric(selected.generalizationGap)}
          />
          <StatCard
            hint={`${formatNumber(selected.featureCount, 0)} features in the schema`}
            label="Training rows"
            value={formatNumber(selected.trainingRows, 0)}
          />
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-white/10 bg-slate-950/60 p-5">
            <h4 className="text-xs font-extrabold uppercase tracking-wider text-slate-400">Promotion gate</h4>
            <p className="mt-2 text-sm font-bold text-white">
              {promotionDecisionLabel(selected.promotionAssessment.decision)}
            </p>
            <dl className="mt-3 space-y-1.5 text-xs text-slate-400">
              <div className="flex justify-between gap-4">
                <dt>Gate metric</dt>
                <dd className="font-semibold text-slate-200">{selected.promotionAssessment.metric ?? "Not recorded"}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt>Improvement over incumbent</dt>
                <dd className="font-semibold text-slate-200">{metric(selected.promotionAssessment.improvement)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt>Incumbent <Tooltip content="Harmonic mean of precision and recall. Accounts for class imbalance.">macro-F1</Tooltip> on this holdout</dt>
                <dd className="font-semibold text-slate-200">{metric(selected.promotionAssessment.incumbentMacroF1)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt>Artifact checksum</dt>
                <dd className="font-mono text-[11px] text-slate-300">
                  {selected.artifactChecksum ? `${selected.artifactChecksum.slice(0, 16)}…` : "Not recorded"}
                </dd>
              </div>
            </dl>
          </div>

          <div className="rounded-xl border border-white/10 bg-slate-950/60 p-5">
            <h4 className="text-xs font-extrabold uppercase tracking-wider text-slate-400">Validation protocol</h4>
            <p className="mt-2 text-sm font-bold text-white">
              {selected.validationProtocol.method ?? "Not recorded"}
            </p>
            <dl className="mt-3 space-y-1.5 text-xs text-slate-400">
              <div className="flex justify-between gap-4">
                <dt>Holdout fraction</dt>
                <dd className="font-semibold text-slate-200">
                  {selected.validationProtocol.validationFraction === null
                    ? "Not recorded"
                    : formatPercentage(selected.validationProtocol.validationFraction)}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt>Purged bars between train and holdout</dt>
                <dd className="font-semibold text-slate-200">{formatNumber(selected.validationProtocol.purgeBars, 0)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt>Label horizon</dt>
                <dd className="font-semibold text-slate-200">
                  {formatNumber(selected.validationProtocol.horizonBars, 0)} bars
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt>Neutral band</dt>
                <dd className="font-semibold text-slate-200">
                  {formatNumber(selected.validationProtocol.neutralThresholdBps, 0)} bps
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt>Training window</dt>
                <dd className="font-semibold text-slate-200">
                  {formatTimestamp(selected.trainingWindow.start)} → {formatTimestamp(selected.trainingWindow.end)}
                </dd>
              </div>
            </dl>
          </div>

          <div className="rounded-xl border border-white/10 bg-slate-950/60 p-5">
            <h4 className="text-xs font-extrabold uppercase tracking-wider text-slate-400">Hyperparameters</h4>
            {Object.keys(selected.hyperparameters).length === 0 ? (
              <p className="mt-2 text-xs text-slate-400">
                This version was trained before hyperparameters were recorded in the artifact metadata.
              </p>
            ) : (
              <dl className="mt-3 grid gap-1.5 text-xs text-slate-400 sm:grid-cols-2">
                {Object.entries(selected.hyperparameters).map(([name, value]) => (
                  <div className="flex justify-between gap-3 rounded-lg bg-white/[0.03] px-2 py-1" key={name}>
                    <dt className="font-mono">{name}</dt>
                    <dd className="font-semibold text-slate-200">{String(value)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>

          <div className="rounded-xl border border-white/10 bg-slate-950/60 p-5">
            <h4 className="text-xs font-extrabold uppercase tracking-wider text-slate-400">Recorded prediction activity</h4>
            <p className="mt-2 text-sm font-bold text-white">
              {selected.predictionActivity.predictionCount} stored research prediction
              {selected.predictionActivity.predictionCount === 1 ? "" : "s"}
            </p>
            <p className="mt-1 text-[11px] text-slate-500">
              Usage of the model, not a claim that it was right: a realised hit rate needs each prediction&apos;s
              forward outcome, which is reported per prediction in the AI Predictions view.
            </p>
            <dl className="mt-3 space-y-1.5 text-xs text-slate-400">
              <div className="flex justify-between gap-4">
                <dt>Average stated confidence</dt>
                <dd className="font-semibold text-slate-200">
                  {selected.predictionActivity.averageConfidence === null
                    ? "—"
                    : formatPercentage(selected.predictionActivity.averageConfidence)}
                </dd>
              </div>
              {Object.entries(selected.predictionActivity.labelCounts).map(([label, count]) => (
                <div className="flex justify-between gap-4" key={label}>
                  <dt>{label}</dt>
                  <dd className="font-semibold text-slate-200">{count}</dd>
                </div>
              ))}
              <div className="flex justify-between gap-4">
                <dt>Most recent prediction</dt>
                <dd className="font-semibold text-slate-200">
                  {formatTimestamp(selected.predictionActivity.lastPredictionAt)}
                </dd>
              </div>
            </dl>
          </div>
        </div>

        <p className="mt-5 text-xs leading-6 text-slate-500">
          Holdout metrics come from a purged chronological split measured at training time. They describe how this
          version scored on one unseen historical period — not a forecast, a guarantee, or a trade instruction.
        </p>
      </InteractiveGlassCard>
    </Reveal>
  );
}

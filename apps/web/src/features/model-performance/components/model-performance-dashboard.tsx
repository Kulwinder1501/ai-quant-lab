"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { GlassPanel, InteractiveGlassCard } from "../../../components/ui/glass-panel";
import { Reveal } from "../../../components/ui/reveal";
import { getResearchJson } from "../../research/api";
import { ResearchShell } from "../../research/components/research-shell";
import { RequestStatePanel, type RequestState } from "../../research/components/request-state-panel";
import { formatNumber, formatPercentage, formatTimestamp } from "../../research/presentation";
import { parseModelPerformanceEnvelope } from "../api";
import {
  algorithmLabel,
  defaultModelPerformanceFilters,
  explanationMethodLabel,
  generalizationLabel,
  modelVersionQuery,
  promotionDecisionLabel,
  stageTone,
  type ModelPerformanceFilters,
  type ModelPerformancePage,
  type ModelVersionPerformance,
  type LeakageRisk,
} from "../domain";

const limitChoices = [25, 50, 100, 200] as const;

function metric(value: number | null, fractionDigits = 3): string {
  return value === null ? "—" : formatNumber(value, fractionDigits);
}

function MetricCell({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-slate-950/60 p-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">{label}</p>
      <p className="mt-1 text-xl font-black text-white">{value}</p>
      {hint && <p className="mt-1 text-[11px] text-slate-500">{hint}</p>}
    </div>
  );
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

/**
 * The Model Performance registry.
 *
 * Every number shown here was recorded by the trainer at the moment a version was
 * fitted, on a purged chronological holdout. None of it is a live accuracy claim,
 * and this view cannot train, promote, reject, or archive a model.
 */
export function ModelPerformanceDashboard() {
  const [filters, setFilters] = useState<ModelPerformanceFilters>(defaultModelPerformanceFilters);
  const [page, setPage] = useState<ModelPerformancePage | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [state, setState] = useState<RequestState>("loading");
  const [error, setError] = useState<string | null>(null);

  // Every state write happens after the request resolves, so the registry never
  // flashes a skeleton on a filter change and the effect stays free of the
  // synchronous updates that cause cascading renders.
  const load = useCallback(async (active: ModelPerformanceFilters, signal?: AbortSignal) => {
    try {
      const payload = await getResearchJson(modelVersionQuery(active), signal);
      const parsed = parseModelPerformanceEnvelope(payload);
      setPage(parsed);
      setError(null);
      setState(parsed.records.length === 0 ? "empty" : "ready");
      setSelectedId((previous) => (
        previous && parsed.records.some((record) => record.id === previous)
          ? previous
          : parsed.records[0]?.id ?? null
      ));
    } catch (caught) {
      if ((caught as Error).name === "AbortError") return;
      setError((caught as Error).message || "The model registry could not be read.");
      setState("unavailable");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(filters, controller.signal);
    return () => controller.abort();
  }, [filters, load]);

  const records = useMemo(() => page?.records ?? [], [page]);
  const selected: ModelVersionPerformance | null = useMemo(
    () => records.find((record) => record.id === selectedId) ?? records[0] ?? null,
    [records, selectedId],
  );
  const algorithms = useMemo(
    () => [...new Set(records.map((record) => record.algorithm))].sort(),
    [records],
  );
  const productionCount = records.filter((record) => record.stage === "PRODUCTION").length;

  const update = <K extends keyof ModelPerformanceFilters>(key: K, value: ModelPerformanceFilters[K]) => {
    setFilters((previous) => ({ ...previous, [key]: value }));
  };

  return (
    <ResearchShell
      activeView="model-performance"
      eyebrow="Local Model Registry"
      title="Model Performance"
      description="Every trained model version with the holdout metrics, hyperparameters, purged validation protocol, and promotion decision recorded at training time. This view reads the registry only: it cannot train, promote, reject, or archive a model."
      connectionLabel={state === "unavailable"
        ? "Registry unavailable"
        : `${records.length} versions - ${productionCount} in production`}
      unavailable={state === "unavailable"}
    >
      <div className="space-y-6">
        <Reveal>
          <GlassPanel className="flex flex-wrap items-end gap-3 border-cyan-500/20 bg-gradient-to-r from-slate-950 via-slate-900 to-cyan-950/30 p-4">
            <label className="flex flex-col gap-1 text-xs font-semibold text-slate-400">
              Stage
              <select
                className="cursor-pointer rounded-xl border border-white/10 bg-slate-950 px-3 py-1.5 text-sm font-bold text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
                onChange={(event) => update("stage", event.target.value as ModelPerformanceFilters["stage"])}
                value={filters.stage}
              >
                <option className="bg-slate-900" value="ALL">Every stage</option>
                <option className="bg-slate-900" value="PRODUCTION">Production</option>
                <option className="bg-slate-900" value="CANDIDATE">Candidate</option>
                <option className="bg-slate-900" value="REJECTED">Rejected</option>
                <option className="bg-slate-900" value="ARCHIVED">Archived</option>
              </select>
            </label>

            <label className="flex flex-col gap-1 text-xs font-semibold text-slate-400">
              Algorithm
              <select
                className="cursor-pointer rounded-xl border border-white/10 bg-slate-950 px-3 py-1.5 text-sm font-bold text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
                onChange={(event) => update("algorithm", event.target.value)}
                value={filters.algorithm}
              >
                <option className="bg-slate-900" value="ALL">Every algorithm</option>
                {algorithms.map((algorithm) => (
                  <option className="bg-slate-900" key={algorithm} value={algorithm}>
                    {algorithmLabel(algorithm)}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-xs font-semibold text-slate-400">
              Model family
              <select
                className="max-w-xs cursor-pointer truncate rounded-xl border border-white/10 bg-slate-950 px-3 py-1.5 text-sm font-bold text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
                onChange={(event) => update("modelKey", event.target.value)}
                value={filters.modelKey}
              >
                <option className="bg-slate-900" value="ALL">Every family</option>
                {(page?.families ?? []).map((family) => (
                  <option className="bg-slate-900" key={family.modelKey} value={family.modelKey}>
                    {family.modelKey}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-xs font-semibold text-slate-400">
              Rows
              <select
                className="cursor-pointer rounded-xl border border-white/10 bg-slate-950 px-3 py-1.5 text-sm font-bold text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
                onChange={(event) => update("limit", Number(event.target.value))}
                value={filters.limit}
              >
                {limitChoices.map((choice) => (
                  <option className="bg-slate-900" key={choice} value={choice}>{choice}</option>
                ))}
              </select>
            </label>

            <button
              className="rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-xs font-bold text-slate-200 transition hover:bg-slate-800"
              onClick={() => setFilters(defaultModelPerformanceFilters)}
              type="button"
            >
              Reset filters
            </button>
            <button
              className="rounded-xl border border-cyan-400/30 bg-cyan-400/10 px-3 py-2 text-xs font-bold text-cyan-100 transition hover:bg-cyan-400/20"
              onClick={() => load(filters)}
              type="button"
            >
              Refresh
            </button>
          </GlassPanel>
        </Reveal>

        {error && (
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm font-semibold text-rose-200">
            {error}
          </div>
        )}

        {state !== "ready" ? (
          <RequestStatePanel
            emptyDescription="No model version is registered for these filters. Train one with npm run ml:train (add --algorithm xgboost or --algorithm lightgbm for a boosted candidate) and it will appear here."
            emptyTitle="The model registry is empty"
            loadingDescription="Reading persisted model versions and their recorded training evidence."
            loadingTitle="Loading the model registry"
            state={state}
            unavailableDescription="The research API did not return the model registry. Confirm the API is running and the local database is reachable."
            unavailableTitle="Model registry unavailable"
          />
        ) : (
          <>
            {(page?.families.length ?? 0) > 0 && (
              <Reveal delayMs={90}>
                <GlassPanel className="border-white/10 p-6">
                  <h3 className="text-sm font-extrabold uppercase tracking-wider text-slate-300">
                    Model families and their production slot
                  </h3>
                  <p className="mt-1 text-xs text-slate-400">
                    Each family holds one production slot. Two algorithms only compete for the same slot when they were
                    trained under one shared model key.
                  </p>
                  <div className="mt-4 grid gap-3 lg:grid-cols-2">
                    {(page?.families ?? []).map((family) => (
                      <div className="rounded-xl border border-white/10 bg-slate-950/60 p-4" key={family.modelKey}>
                        <p className="break-all font-mono text-[11px] text-slate-400">{family.modelKey}</p>
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                          <span className="rounded-md border border-white/10 bg-slate-900 px-2 py-0.5 font-bold text-slate-200">
                            {family.versionCount} version{family.versionCount === 1 ? "" : "s"}
                          </span>
                          {family.algorithms.map((algorithm) => (
                            <span
                              className="rounded-md border border-cyan-300/25 bg-cyan-300/10 px-2 py-0.5 font-bold text-cyan-100"
                              key={algorithm}
                            >
                              {algorithmLabel(algorithm)}
                            </span>
                          ))}
                          <span className={`rounded-md border px-2 py-0.5 font-bold ${
                            family.productionVersionId
                              ? "border-emerald-300/35 bg-emerald-300/10 text-emerald-100"
                              : "border-slate-500/35 bg-slate-500/10 text-slate-300"
                          }`}>
                            {family.productionVersionId ? "Production model promoted" : "No production model"}
                          </span>
                          <span className="text-slate-400">
                            Best holdout macro-F1 {metric(family.bestValidationMacroF1)}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </GlassPanel>
              </Reveal>
            )}

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
                            <li><strong className="text-emerald-400">Macro-F1 & Accuracy:</strong> 0.530 - 0.560 is excellent in quant finance. &gt;0.600 usually indicates data leakage.</li>
                            <li><strong className="text-cyan-400">Train-Holdout Gap:</strong> 0.000 - 0.050 is healthy. A massive gap (e.g., 0.200) means the model is severely overfitted and will fail in live trading.</li>
                          </ul>
                        </div>
                      </div>
                    </div>
                    <p className="mt-0.5 text-xs text-slate-400">
                      Newest training run first. Holdout macro-F1 is the metric the promotion gate compares.
                    </p>
                  </div>
                  {page?.truncated && (
                    <span className="rounded-full border border-amber-300/35 bg-amber-200/10 px-3 py-1 text-xs font-semibold text-amber-100">
                      Showing the newest {page.limit} versions only
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
                        <th className="px-4 py-3">Holdout macro-F1</th>
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
                        const isSelected = selected?.id === record.id;
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

            {selected && (
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

                  <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <MetricCell
                      hint={`Training macro-F1 ${metric(selected.trainingMetrics.macroF1)}`}
                      label="Holdout macro-F1"
                      value={metric(selected.validationMetrics.macroF1)}
                    />
                    <MetricCell
                      hint={selected.validationMetrics.coverage !== null ? `Coverage ${formatPercentage(selected.validationMetrics.coverage)}` : "Hit rate not recorded"}
                      label="Directional Hit Rate"
                      value={selected.validationMetrics.directionalHitRate !== null ? formatPercentage(selected.validationMetrics.directionalHitRate) : "—"}
                    />
                    <MetricCell
                      hint={generalizationLabel(selected.generalizationGap).text}
                      label="Train-holdout gap"
                      value={metric(selected.generalizationGap)}
                    />
                    <MetricCell
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
                          <dt>Incumbent macro-F1 on this holdout</dt>
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
            )}
          </>
        )}
      </div>
    </ResearchShell>
  );
}

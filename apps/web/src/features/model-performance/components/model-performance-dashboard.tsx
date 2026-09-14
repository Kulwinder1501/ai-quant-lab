"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Download } from "lucide-react";
import { exportToCsv } from "../../../lib/export";
import { GlassPanel } from "../../../components/ui/glass-panel";
import { Reveal } from "../../../components/ui/reveal";
import { getResearchJson } from "../../research/api";
import { errorMessage, isAbortError } from "../../../lib/errors";
import { PageHeader } from "../../../components/layout/page-header";
import { RequestStatePanel, type RequestState } from "../../research/components/request-state-panel";
import { parseModelPerformanceEnvelope } from "../api";
import {
  algorithmLabel,
  defaultModelPerformanceFilters,
  modelVersionQuery,
  type ModelPerformanceFilters,
  type ModelPerformancePage,
  type ModelVersionPerformance,
} from "../domain";

const limitChoices = [25, 50, 100, 200] as const;

import { ModelFamilies } from "./model-families";
import { ModelLeaderboard } from "./model-leaderboard";
import { ModelInspector } from "./model-inspector";
import { ModelCompetition } from "./model-competition";

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

  // Pure I/O: no state writes, so an effect can call it without cascading a render.
  const loadRegistry = useCallback(async (active: ModelPerformanceFilters, signal?: AbortSignal) => {
    const payload = await getResearchJson(modelVersionQuery(active), signal);
    return parseModelPerformanceEnvelope(payload);
  }, []);

  // Every state write happens after the request resolves, so the registry never
  // flashes a skeleton on a filter change.
  const applyRegistry = useCallback((parsed: ModelPerformancePage) => {
    setPage(parsed);
    setError(null);
    setState(parsed.records.length === 0 ? "empty" : "ready");
    setSelectedId((previous) => (
      previous && parsed.records.some((record) => record.id === previous)
        ? previous
        : parsed.records[0]?.id ?? null
    ));
  }, []);

  const applyRegistryError = useCallback((caught: unknown) => {
    if (isAbortError(caught)) return;
    setError(errorMessage(caught, "The model registry could not be read."));
    setState("unavailable");
  }, []);

  const refreshRegistry = useCallback(() => {
    void loadRegistry(filters).then(applyRegistry, applyRegistryError);
  }, [filters, loadRegistry, applyRegistry, applyRegistryError]);

  useEffect(() => {
    const controller = new AbortController();
    void loadRegistry(filters, controller.signal).then(applyRegistry, applyRegistryError);
    return () => controller.abort();
  }, [filters, loadRegistry, applyRegistry, applyRegistryError]);

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
    <>
      <PageHeader eyebrow="Local Model Registry"
      title="Model Performance"
      description="Every trained model version with the holdout metrics, hyperparameters, purged validation protocol, and promotion decision recorded at training time. This view reads the registry only: it cannot train, promote, reject, or archive a model."
      connectionLabel={state === "unavailable"
        ? "Registry unavailable"
        : `${records.length} versions - ${productionCount} in production`}
      unavailable={state === "unavailable"} />
      <div className="mt-10">
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
              onClick={refreshRegistry}
              type="button"
            >
              Refresh
            </button>
            <button
              className="flex items-center gap-2 rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-xs font-bold text-slate-200 transition hover:bg-slate-800 disabled:opacity-50"
              onClick={() => exportToCsv(records, "model-performance")}
              type="button"
              disabled={records.length === 0}
            >
              <Download className="h-4 w-4" />
              Export CSV
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
            <ModelCompetition />

            <ModelFamilies families={page?.families ?? []} />

            <ModelLeaderboard 
              records={records}
              selectedId={selectedId}
              setSelectedId={setSelectedId}
              pageTruncated={page?.truncated ?? false}
              pageLimit={page?.limit ?? 0}
            />

            {selected && (
              <ModelInspector selected={selected} />
            )}
          </>
        )}
      </div>
    </div>
    </>
  );
}

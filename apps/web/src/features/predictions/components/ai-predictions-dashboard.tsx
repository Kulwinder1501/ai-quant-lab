"use client";

import { useEffect, useMemo, useState } from "react";
import { GlassPanel } from "../../../components/ui/glass-panel";
import { Reveal } from "../../../components/ui/reveal";
import { getResearchJson } from "../../research/api";
import { ReadOnlyBoundary } from "../../research/components/read-only-boundary";
import { RequestStatePanel, type RequestState } from "../../research/components/request-state-panel";
import { PageHeader } from "../../../components/layout/page-header";
import { parsePredictionDetailEnvelope, parsePredictionListEnvelope } from "../api";
import type { PredictionDetail, PredictionSummary } from "../domain";
import { PredictionInspector } from "./prediction-inspector";
import { PredictionList } from "./prediction-list";

const maximumRecords = 6;

import { DetailPlaceholder } from "./detail-placeholder";

export function AiPredictionsDashboard() {
  const [state, setState] = useState<RequestState>("loading");
  const [records, setRecords] = useState<PredictionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedPrediction, setSelectedPrediction] = useState<PredictionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailUnavailable, setDetailUnavailable] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    async function loadRecords() {
      try {
        const payload = await getResearchJson(`/model-predictions?limit=${maximumRecords}`, controller.signal);
        const parsed = parsePredictionListEnvelope(payload);
        if (controller.signal.aborted) return;
        setRecords(parsed);
        setSelectedId(parsed[0]?.id ?? null);
        setState(parsed.length > 0 ? "ready" : "empty");
      } catch {
        if (!controller.signal.aborted) setState("unavailable");
      }
    }
    void loadRecords();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!selectedId) {
      return;
    }
    const predictionId = selectedId;
    const controller = new AbortController();
    async function loadDetail() {
      setDetailLoading(true);
      setSelectedPrediction(null);
      setDetailUnavailable(false);
      try {
        const payload = await getResearchJson(`/model-predictions/${encodeURIComponent(predictionId)}`, controller.signal);
        const parsed = parsePredictionDetailEnvelope(payload);
        if (!controller.signal.aborted) {
          setSelectedPrediction(parsed);
          setDetailUnavailable(parsed === null);
        }
      } catch {
        if (!controller.signal.aborted) {
          setSelectedPrediction(null);
          setDetailUnavailable(true);
        }
      } finally {
        if (!controller.signal.aborted) setDetailLoading(false);
      }
    }
    void loadDetail();
    return () => controller.abort();
  }, [selectedId]);

  const connectionLabel = useMemo(() => ({
    loading: "Checking local API",
    ready: "Local API connected",
    empty: "Local API connected - no records",
    unavailable: "Local API unavailable",
  })[state], [state]);

  return (
    <>
      <PageHeader connectionLabel={connectionLabel}
      description="Inspect explainable model observations, their evidence cutoff, and validation context. The dashboard is deliberately read-only."
      eyebrow="Local research platform - Phase 12"
      title="AI Predictions"
      unavailable={state === "unavailable"} />
      <div className="mt-10">
      <Reveal delayMs={130}>
        <ReadOnlyBoundary
          badge="EXECUTION DISABLED"
          description="This screen can only inspect persisted local model predictions. It cannot create a trade idea, open or close a paper trade, connect to a broker, or place a real order."
          points={[
            "No broker controls",
            "No paper-trade controls",
            "No automatic execution",
            "Confidence is not a return guarantee",
          ]}
          title="Read-only research observations"
        />
      </Reveal>

      <section className="mt-8">
        {state === "ready" ? (
          <div className="grid gap-5 lg:grid-cols-[minmax(19rem,0.8fr)_minmax(0,1.7fr)]">
            <Reveal delayMs={170}><PredictionList onSelect={setSelectedId} records={records} selectedId={selectedId} /></Reveal>
            <Reveal delayMs={230}>
              {selectedPrediction
                ? <PredictionInspector prediction={selectedPrediction} />
                : <DetailPlaceholder loading={detailLoading} unavailable={detailUnavailable} />}
            </Reveal>
          </div>
        ) : (
          <RequestStatePanel
            emptyDescription="A promoted local model can persist an explainable research prediction for a completed candle. When one exists, its model lineage and explanation will appear here."
            emptyTitle="No recorded predictions yet"
            loadingDescription="The dashboard is making a read-only request to the local API. No market data, trade, paper-trade, or broker action is created while it loads."
            loadingTitle="Loading recorded predictions..."
            state={state}
            unavailableDescription="Start the local API after its database is ready. This dashboard does not invent market data, fall back to a broker, or submit any action while the API is offline."
            unavailableTitle="Prediction API is unavailable"
          />
        )}
      </section>
    </div>
    </>
  );
}

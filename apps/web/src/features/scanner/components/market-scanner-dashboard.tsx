"use client";

import { useEffect, useMemo, useState } from "react";
import { GlassPanel } from "../../../components/ui/glass-panel";
import { Reveal } from "../../../components/ui/reveal";
import { getResearchJson } from "../../research/api";
import { ReadOnlyBoundary } from "../../research/components/read-only-boundary";
import { RequestStatePanel, type RequestState } from "../../research/components/request-state-panel";
import { PageHeader } from "../../../components/layout/page-header";
import { parseScannerEnvelope, parseWatchlistEnvelope } from "../api";
import type { ScannerContext, ScannerRow, WatchlistInstrument } from "../domain";
import { ScannerRowCard } from "./scanner-row-card";
import { WatchlistPanel } from "./watchlist-panel";

const maximumRecords = 50;

interface ScannerPanelProps {
  state: RequestState;
  records: ScannerRow[];
  context: ScannerContext | null;
}

function ScannerPanel({ state, records, context }: ScannerPanelProps) {
  if (state !== "ready") {
    return (
      <RequestStatePanel
        emptyDescription="No completed-candle records matched the local scanner query. The dashboard does not collect data or manufacture a current market view when there is no saved evidence."
        emptyTitle="No completed-candle scanner records yet"
        loadingDescription="The dashboard is issuing a GET-only request to the local API. It will not start a collector, fetch a provider, or initiate a research workflow while it waits."
        loadingTitle="Loading completed-candle scanner records..."
        state={state}
        unavailableDescription="The local API did not return a valid persisted response. This screen does not substitute current market data or infer an alternative result."
        unavailableTitle="Completed-candle scanner records are unavailable"
      />
    );
  }

  return (
    <section aria-label="Market scanner">
      <Reveal>
        <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-100">Research inspection</p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-100">Completed-candle market scanner</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">Saved indicator, pattern, price-action, and optional model context for active local instruments. This is a review surface, not an execution workflow.</p>
          </div>
          <GlassPanel className="px-4 py-3 text-right">
            <p className="text-xs text-slate-500">Scanner timeframe</p>
            <p className="mt-1 text-sm font-semibold text-slate-200">{context?.timeframe ?? "Not recorded"}</p>
          </GlassPanel>
        </div>
      </Reveal>

      <Reveal delayMs={80}>
        <GlassPanel className="mb-5 border-white/10 bg-slate-950/35 p-4 shadow-none">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Active strategy registry context</p>
          {context && context.activeStrategies.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {context.activeStrategies.map((strategy) => (
                <span className="rounded-full border border-white/10 bg-slate-950/45 px-3 py-1 text-xs text-slate-300" key={`${strategy.key}-${strategy.version}`}>
                  {strategy.name} ({strategy.key} v{strategy.version})
                </span>
              ))}
            </div>
          ) : <p className="mt-2 text-sm text-slate-400">No active strategy registry entries were returned. The scanner does not generate or modify strategies.</p>}
        </GlassPanel>
      </Reveal>

      <div className="space-y-5">
        {records.map((record, index) => (
          <Reveal delayMs={Math.min(index * 65, 260)} key={`${record.instrument.id}-${record.latestCompletedCandle.id}`}>
            <ScannerRowCard record={record} />
          </Reveal>
        ))}
      </div>
    </section>
  );
}

export function MarketScannerDashboard() {
  const [watchlistState, setWatchlistState] = useState<RequestState>("loading");
  const [watchlist, setWatchlist] = useState<WatchlistInstrument[]>([]);
  const [scannerState, setScannerState] = useState<RequestState>("loading");
  const [scannerRecords, setScannerRecords] = useState<ScannerRow[]>([]);
  const [scannerContext, setScannerContext] = useState<ScannerContext | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    async function loadWatchlist() {
      try {
        const payload = await getResearchJson(`/watchlist?limit=${maximumRecords}`, controller.signal);
        const records = parseWatchlistEnvelope(payload);
        if (controller.signal.aborted) return;
        setWatchlist(records);
        setWatchlistState(records.length > 0 ? "ready" : "empty");
      } catch {
        if (!controller.signal.aborted) setWatchlistState("unavailable");
      }
    }

    async function loadScanner() {
      try {
        const payload = await getResearchJson(`/market-scanner?timeframe=1d&limit=${maximumRecords}`, controller.signal);
        const result = parseScannerEnvelope(payload);
        if (controller.signal.aborted) return;
        setScannerRecords(result.records);
        setScannerContext(result.context);
        setScannerState(result.records.length > 0 ? "ready" : "empty");
      } catch {
        if (!controller.signal.aborted) setScannerState("unavailable");
      }
    }

    void loadWatchlist();
    void loadScanner();
    return () => controller.abort();
  }, []);

  const unavailable = watchlistState === "unavailable" || scannerState === "unavailable";
  const connectionLabel = useMemo(() => {
    if (unavailable) return "Local API partially or fully unavailable";
    if (watchlistState === "loading" || scannerState === "loading") return "Checking local API";
    return "Local API connected";
  }, [scannerState, unavailable, watchlistState]);

  return (
    <>
      <PageHeader connectionLabel={connectionLabel}
      description="Review active local instruments and their latest persisted completed-candle research context. Nothing on this page refreshes market data or creates an action."
      eyebrow="Local research platform - Phase 13"
      title="Market Scanner and Watchlist"
      unavailable={unavailable} />
      <div className="mt-10">
      <Reveal delayMs={130}>
        <ReadOnlyBoundary
          description="The scanner only reads active local instruments and completed-candle research already stored by the platform. It does not collect market data, refresh a provider, produce a trade idea, create paper activity, connect to a broker, or place an order."
          points={[
            "Completed candles only",
            "No editable favorites",
            "No automatic refresh",
            "Research labels are not recommendations",
          ]}
          title="Persisted research, not a live signal feed"
        />
      </Reveal>

      <section className="mt-8">
        <Reveal delayMs={170}>
          <WatchlistPanel instruments={watchlist} state={watchlistState} />
        </Reveal>
      </section>
      <section className="mt-10">
        <ScannerPanel context={scannerContext} records={scannerRecords} state={scannerState} />
      </section>
    </div>
    </>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, Timer, TrendingUp } from "lucide-react";
import { exportToCsv } from "../../../lib/export";
import { GlassPanel } from "../../../components/ui/glass-panel";
import { Reveal } from "../../../components/ui/reveal";
import { getResearchJson } from "../../research/api";
import { errorMessage, isAbortError } from "../../../lib/errors";
import { Tabs } from "../../../components/ui/tabs";
import { RequestStatePanel, type RequestState } from "../../research/components/request-state-panel";
import { parseTradeHistoryEnvelope } from "../api";
import {
  defaultTradeHistoryFilters,
  isTradeInMode,
  summarizeTradeHistory,
  tradeHistoryQuery,
  type TradeHistoryFilters,
  type TradeHistoryMode,
  type TradeHistoryPage,
} from "../domain";

const limitChoices = [50, 100, 250, 500] as const;

import { TradeHistorySummary } from "./trade-history-summary";
import { TradeLedgerTable } from "./trade-ledger-table";

/**
 * The Trade History ledger.
 *
 * It reads the persisted simulated-trade record across every local paper account
 * and cannot open, close, evaluate, or cancel anything. Where a statistic has no
 * data behind it the tile shows an em dash rather than a zero, because a zero win
 * rate and an absent win rate are different facts.
 */
export function TradeHistoryDashboard({ initialMode = "swing" }: { initialMode?: TradeHistoryMode } = {}) {
  const [mode, setMode] = useState<TradeHistoryMode>(initialMode);
  const [filters, setFilters] = useState<TradeHistoryFilters>(defaultTradeHistoryFilters);
  const [symbolDraft, setSymbolDraft] = useState<string>("");
  const [page, setPage] = useState<TradeHistoryPage | null>(null);
  const [state, setState] = useState<RequestState>("loading");
  const [error, setError] = useState<string | null>(null);

  // Pure I/O: no state writes, so an effect can call it without cascading a render.
  const loadLedger = useCallback(async (active: TradeHistoryFilters, signal?: AbortSignal) => {
    // The API has no timeframe filter. Read its safe maximum, then partition
    // locally so one category cannot consume the selected row limit before the
    // active Swing/Scalp tab is applied.
    const payload = await getResearchJson(tradeHistoryQuery({ ...active, limit: 500 }), signal);
    return parseTradeHistoryEnvelope(payload);
  }, []);

  // Every state write happens after the request resolves. The previous ledger
  // stays on screen while a new filter loads, which avoids a skeleton flash.
  const applyLedger = useCallback((parsed: TradeHistoryPage) => {
    setPage(parsed);
    setError(null);
    setState("ready");
  }, []);

  const applyLedgerError = useCallback((caught: unknown) => {
    if (isAbortError(caught)) return;
    setError(errorMessage(caught, "The trade ledger could not be read."));
    setState("unavailable");
  }, []);

  const refreshLedger = useCallback(() => {
    void loadLedger(filters).then(applyLedger, applyLedgerError);
  }, [filters, loadLedger, applyLedger, applyLedgerError]);

  useEffect(() => {
    const controller = new AbortController();
    void loadLedger(filters, controller.signal).then(applyLedger, applyLedgerError);
    return () => controller.abort();
  }, [filters, loadLedger, applyLedger, applyLedgerError]);

  const matchingRecords = useMemo(
    () => (page?.records ?? []).filter((record) => isTradeInMode(record, mode)),
    [mode, page],
  );
  const records = useMemo(
    () => matchingRecords.slice(0, filters.limit),
    [filters.limit, matchingRecords],
  );
  const summary = useMemo(
    () => state === "ready" ? summarizeTradeHistory(records) : null,
    [records, state],
  );
  const viewState: RequestState = state === "ready"
    ? (records.length === 0 ? "empty" : "ready")
    : state;
  const pageTruncated = (page?.truncated ?? false) || matchingRecords.length > filters.limit;

  const symbolOptions = useMemo(
    () => [...new Set(matchingRecords.map((record) => record.instrumentSymbol))].sort(),
    [matchingRecords],
  );

  const update = <K extends keyof TradeHistoryFilters>(key: K, value: TradeHistoryFilters[K]) => {
    setFilters((previous) => ({ ...previous, [key]: value }));
  };

  const applyMode = useCallback((next: TradeHistoryMode) => {
    setMode(next);
    window.history.replaceState(null, "", next === "scalp" ? "/trade-history?mode=scalp" : "/trade-history");
  }, []);

  return (
      <div className="space-y-6">
        <Reveal>
          <Tabs
            tabs={[
              { id: "swing", label: "Swing", icon: <TrendingUp className="size-4" /> },
              { id: "scalp", label: "Scalp", icon: <Timer className="size-4" /> },
            ]}
            activeId={mode}
            onChange={(id) => applyMode(id as TradeHistoryMode)}
          />
        </Reveal>

        <Reveal>
          <GlassPanel className="flex flex-wrap items-end gap-3 border-cyan-500/20 bg-gradient-to-r from-slate-950 via-slate-900 to-cyan-950/30 p-4">
            <label className="flex flex-col gap-1 text-xs font-semibold text-slate-400">
              Account
              <select
                className="cursor-pointer rounded-xl border border-white/10 bg-slate-950 px-3 py-1.5 text-sm font-bold text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
                onChange={(event) => update("accountId", event.target.value)}
                value={filters.accountId}
              >
                <option className="bg-slate-900" value="ALL">All accounts</option>
                {(page?.accounts ?? []).map((account) => (
                  <option className="bg-slate-900" key={account.id} value={account.id}>{account.name}</option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-xs font-semibold text-slate-400">
              Instrument
              <span className="flex items-center gap-2">
                <input
                  className="w-36 rounded-xl border border-white/10 bg-slate-950 px-3 py-1.5 text-sm font-bold uppercase text-white placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-cyan-500"
                  list="trade-history-symbols"
                  onChange={(event) => setSymbolDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") update("instrumentSymbol", symbolDraft);
                  }}
                  placeholder="Any"
                  value={symbolDraft}
                />
                <datalist id="trade-history-symbols">
                  {symbolOptions.map((symbol) => <option key={symbol} value={symbol} />)}
                </datalist>
                <button
                  className="rounded-xl border border-white/10 bg-slate-900 px-3 py-1.5 text-xs font-bold text-slate-200 transition hover:bg-slate-800"
                  onClick={() => update("instrumentSymbol", symbolDraft)}
                  type="button"
                >
                  Apply
                </button>
              </span>
            </label>

            <label className="flex flex-col gap-1 text-xs font-semibold text-slate-400">
              Status
              <select
                className="cursor-pointer rounded-xl border border-white/10 bg-slate-950 px-3 py-1.5 text-sm font-bold text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
                onChange={(event) => update("status", event.target.value as TradeHistoryFilters["status"])}
                value={filters.status}
              >
                <option className="bg-slate-900" value="ALL">Every status</option>
                <option className="bg-slate-900" value="OPEN">Open</option>
                <option className="bg-slate-900" value="CLOSED">Closed</option>
                <option className="bg-slate-900" value="CANCELLED">Cancelled</option>
              </select>
            </label>

            <label className="flex flex-col gap-1 text-xs font-semibold text-slate-400">
              Direction
              <select
                className="cursor-pointer rounded-xl border border-white/10 bg-slate-950 px-3 py-1.5 text-sm font-bold text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
                onChange={(event) => update("side", event.target.value as TradeHistoryFilters["side"])}
                value={filters.side}
              >
                <option className="bg-slate-900" value="ALL">Long &amp; short</option>
                <option className="bg-slate-900" value="LONG">Long only</option>
                <option className="bg-slate-900" value="SHORT">Short only</option>
              </select>
            </label>

            <label className="flex flex-col gap-1 text-xs font-semibold text-slate-400">
              Exit
              <select
                className="cursor-pointer rounded-xl border border-white/10 bg-slate-950 px-3 py-1.5 text-sm font-bold text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
                onChange={(event) => update("exitReason", event.target.value as TradeHistoryFilters["exitReason"])}
                value={filters.exitReason}
              >
                <option className="bg-slate-900" value="ALL">Any exit</option>
                <option className="bg-slate-900" value="TARGET">Target</option>
                <option className="bg-slate-900" value="STOP_LOSS">Stop loss</option>
                <option className="bg-slate-900" value="MANUAL">Manual</option>
                <option className="bg-slate-900" value="CANCELLED">Cancelled</option>
              </select>
            </label>

            <label className="flex flex-col gap-1 text-xs font-semibold text-slate-400">
              Outcome
              <select
                className="cursor-pointer rounded-xl border border-white/10 bg-slate-950 px-3 py-1.5 text-sm font-bold text-white focus:outline-none focus:ring-2 focus:ring-cyan-500"
                onChange={(event) => update("outcome", event.target.value as TradeHistoryFilters["outcome"])}
                value={filters.outcome}
              >
                <option className="bg-slate-900" value="ALL">Any outcome</option>
                <option className="bg-slate-900" value="WIN">Winners</option>
                <option className="bg-slate-900" value="LOSS">Losers</option>
                <option className="bg-slate-900" value="BREAK_EVEN">Break even</option>
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
              onClick={() => {
                setSymbolDraft("");
                setFilters(defaultTradeHistoryFilters);
              }}
              type="button"
            >
              Reset filters
            </button>
            <button
              className="rounded-xl border border-cyan-400/30 bg-cyan-400/10 px-3 py-2 text-xs font-bold text-cyan-100 transition hover:bg-cyan-400/20"
              onClick={refreshLedger}
              type="button"
            >
              Refresh
            </button>
            <button
              className="flex items-center gap-2 rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-xs font-bold text-slate-200 transition hover:bg-slate-800 disabled:opacity-50"
              onClick={() => exportToCsv(records, `${mode}-trade-history`)}
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

        <TradeHistorySummary summary={summary} />

        {viewState === "ready" ? (
          <TradeLedgerTable 
            records={records}
            pageTruncated={pageTruncated}
            pageLimit={filters.limit}
          />
          ) : (
            <RequestStatePanel
              emptyDescription="No simulated trade matches these filters yet. Open a paper trade from the Paper Trading view, or let the autonomous agent act on a proposal, and the fill will appear here."
              emptyTitle="No trades in this slice of the ledger"
              loadingDescription="Reading the persisted simulated-trade ledger."
              loadingTitle="Loading trade history"
              state={viewState}
              unavailableDescription="The research API did not return the trade ledger. Confirm the API is running and the local database is reachable."
              unavailableTitle="Trade ledger unavailable"
            />
          )}
      </div>
  );
}

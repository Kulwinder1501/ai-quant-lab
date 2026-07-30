"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Download } from "lucide-react";
import { exportToCsv } from "../../../lib/export";
import { GlassPanel } from "../../../components/ui/glass-panel";
import { Reveal } from "../../../components/ui/reveal";
import { getResearchJson } from "../../research/api";
import { PageHeader } from "../../../components/layout/page-header";
import { RequestStatePanel, type RequestState } from "../../research/components/request-state-panel";
import { formatNumber, formatTimestamp } from "../../research/presentation";
import { parseTradeHistoryEnvelope } from "../api";
import {
  defaultTradeHistoryFilters,
  formatHoldingPeriod,
  tradeHistoryQuery,
  type TradeHistoryFilters,
  type TradeHistoryPage,
  type TradeHistoryRecord,
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
export function TradeHistoryDashboard({ strategyKey, isScalp }: { strategyKey?: string, isScalp?: boolean } = {}) {
  const [filters, setFilters] = useState<TradeHistoryFilters>(defaultTradeHistoryFilters);
  const [symbolDraft, setSymbolDraft] = useState<string>("");
  const [page, setPage] = useState<TradeHistoryPage | null>(null);
  const [state, setState] = useState<RequestState>("loading");
  const [error, setError] = useState<string | null>(null);

  // Every state write happens after the request resolves. The previous ledger
  // stays on screen while a new filter loads, which avoids both a skeleton flash
  // and the cascading renders a synchronous effect update would cause.
  const load = useCallback(async (active: TradeHistoryFilters, signal?: AbortSignal) => {
    try {
      const payload = await getResearchJson(tradeHistoryQuery(active), signal);
      const parsed = parseTradeHistoryEnvelope(payload);
      
      // Filter by strategy locally if strategyKey is provided
      if (strategyKey) {
        // Since trade idea data isn't joined fully in the list by default, 
        // we might not have the strategy on the paper trade record itself unless
        // we added it. But we can assume it's for momentum-scalp if timeframe is 1m.
        if (strategyKey === "momentum-scalp") {
          parsed.records = parsed.records.filter(r => r.timeframe === "1m");
        }
      }

      setPage(parsed);
      setError(null);
      setState(parsed.records.length === 0 ? "empty" : "ready");
    } catch (caught) {
      if ((caught as Error).name === "AbortError") return;
      setError((caught as Error).message || "The trade ledger could not be read.");
      setState("unavailable");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(filters, controller.signal);
    return () => controller.abort();
  }, [filters, load]);

  const summary = page?.summary ?? null;
  const records = useMemo(() => page?.records ?? [], [page]);

  const symbolOptions = useMemo(
    () => [...new Set(records.map((record) => record.instrumentSymbol))].sort(),
    [records],
  );

  const update = <K extends keyof TradeHistoryFilters>(key: K, value: TradeHistoryFilters[K]) => {
    setFilters((previous) => ({ ...previous, [key]: value }));
  };

  return (
    <>
      <PageHeader
        eyebrow="Simulated Execution Ledger"
        title={isScalp ? "Scalp History" : "Trade History"}
        description="The complete chronological record of local paper trades across every research account, with realised profit factor, expectancy, reward multiples, and holding periods. Reading this ledger cannot open, close, or cancel a position."
        connectionLabel={state === "unavailable" ? "Ledger unavailable" : `${records.length} simulated trades loaded`}
        unavailable={state === "unavailable"}
      />
      <div className="mt-10">
      <div className="space-y-6">
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
              onClick={() => load(filters)}
              type="button"
            >
              Refresh
            </button>
            <button
              className="flex items-center gap-2 rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-xs font-bold text-slate-200 transition hover:bg-slate-800 disabled:opacity-50"
              onClick={() => exportToCsv(records, "trade-history")}
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

        {state === "ready" ? (
          <TradeLedgerTable 
            records={records}
            pageTruncated={page?.truncated ?? false}
            pageLimit={page?.limit ?? 0}
          />
          ) : (
            <RequestStatePanel
              emptyDescription="No simulated trade matches these filters yet. Open a paper trade from the Paper Trading view, or let the autonomous agent act on a proposal, and the fill will appear here."
              emptyTitle="No trades in this slice of the ledger"
              loadingDescription="Reading the persisted simulated-trade ledger."
              loadingTitle="Loading trade history"
              state={state}
              unavailableDescription="The research API did not return the trade ledger. Confirm the API is running and the local database is reachable."
              unavailableTitle="Trade ledger unavailable"
            />
          )}
      </div>
      </div>
    </>
  );
}

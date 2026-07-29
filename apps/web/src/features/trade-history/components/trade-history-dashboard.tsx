"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { GlassPanel } from "../../../components/ui/glass-panel";
import { Reveal } from "../../../components/ui/reveal";
import { getResearchJson } from "../../research/api";
import { ResearchShell } from "../../research/components/research-shell";
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

function currency(value: number | null, fractionDigits = 2): string {
  if (value === null) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}₹${formatNumber(value, fractionDigits)}`;
}

function pnlTone(value: number | null): string {
  if (value === null || value === 0) return "text-slate-300";
  return value > 0 ? "text-emerald-400" : "text-rose-400";
}

function exitReasonLabel(record: TradeHistoryRecord): string {
  if (record.status === "OPEN") return "Position still open";
  switch (record.exitReason) {
    case "TARGET":
      return "Target reached";
    case "STOP_LOSS":
      return "Stop loss hit";
    case "MANUAL":
      return "Closed manually";
    case "CANCELLED":
      return "Cancelled";
    default:
      return "Not recorded";
  }
}

function StatTile({
  label,
  value,
  hint,
  tone = "text-white",
  accent = "border-white/10 bg-slate-950/60",
}: {
  label: string;
  value: string;
  hint: string;
  tone?: string;
  accent?: string;
}) {
  return (
    <GlassPanel className={`p-5 ${accent}`}>
      <span className="text-xs font-extrabold uppercase tracking-wider text-slate-400">{label}</span>
      <div className={`mt-2 text-2xl font-black ${tone}`}>{value}</div>
      <p className="mt-1 text-xs text-slate-400">{hint}</p>
    </GlassPanel>
  );
}

/**
 * The Trade History ledger.
 *
 * It reads the persisted simulated-trade record across every local paper account
 * and cannot open, close, evaluate, or cancel anything. Where a statistic has no
 * data behind it the tile shows an em dash rather than a zero, because a zero win
 * rate and an absent win rate are different facts.
 */
export function TradeHistoryDashboard() {
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
    <ResearchShell
      activeView="trade-history"
      eyebrow="Simulated Execution Ledger"
      title="Trade History"
      description="The complete chronological record of local paper trades across every research account, with realised profit factor, expectancy, reward multiples, and holding periods. Reading this ledger cannot open, close, or cancel a position."
      connectionLabel={state === "unavailable" ? "Ledger unavailable" : `${records.length} simulated trades loaded`}
      unavailable={state === "unavailable"}
    >
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
          </GlassPanel>
        </Reveal>

        {error && (
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm font-semibold text-rose-200">
            {error}
          </div>
        )}

        {summary && (
          <Reveal delayMs={90}>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatTile
                hint={`${summary.closedTradeCount} closed - ${summary.openTradeCount} open`}
                label="Trades in view"
                value={String(summary.tradeCount)}
              />
              <StatTile
                accent="border-cyan-500/30 bg-gradient-to-br from-slate-950 via-slate-900 to-cyan-950/20"
                hint={`${summary.winningTradeCount} W / ${summary.losingTradeCount} L / ${summary.breakEvenTradeCount} flat`}
                label="Realised win rate"
                value={summary.winRatePercent === null ? "—" : `${formatNumber(summary.winRatePercent, 1)}%`}
              />
              <StatTile
                accent={summary.netRealizedPnl >= 0
                  ? "border-emerald-500/30 bg-emerald-950/20"
                  : "border-rose-500/30 bg-rose-950/20"}
                hint={`Gross ${currency(summary.grossProfit)} / ${
                  summary.grossLoss === 0 ? "₹0.00" : `-₹${formatNumber(summary.grossLoss, 2)}`
                }`}
                label="Net realised P&L"
                tone={pnlTone(summary.netRealizedPnl)}
                value={currency(summary.netRealizedPnl)}
              />
              <StatTile
                hint={`Expectancy ${currency(summary.expectancy)} per closed trade`}
                label="Profit factor"
                value={summary.profitFactor === null ? "—" : formatNumber(summary.profitFactor, 2)}
              />
              <StatTile
                hint={`Average win ${currency(summary.averageWin)}`}
                label="Average loss"
                value={currency(summary.averageLoss)}
              />
              <StatTile
                hint="Peak-to-trough decline of the realised P&L curve"
                label="Maximum drawdown"
                value={summary.maximumDrawdown === 0 ? "₹0.00" : `-₹${formatNumber(summary.maximumDrawdown, 2)}`}
              />
              <StatTile
                hint="Realised profit as a multiple of the risk accepted at entry"
                label="Average reward"
                value={summary.averageRewardMultiple === null ? "—" : `${formatNumber(summary.averageRewardMultiple, 2)}R`}
              />
              <StatTile
                hint={`Costs ${currency(summary.totalFees)} fees - ${currency(summary.totalSlippage)} slippage`}
                label="Average hold"
                // formatHoldingPeriod reads null as "still open", which is right for a
                // row and wrong for an aggregate with no closed trades behind it.
                value={summary.averageHoldingMinutes === null
                  ? "—"
                  : formatHoldingPeriod(Math.round(summary.averageHoldingMinutes))}
              />
            </div>
          </Reveal>
        )}

        {summary && summary.closedTradeCount > 0 && (
          <Reveal delayMs={140}>
            <GlassPanel className="border-white/10 p-6">
              <h3 className="text-sm font-extrabold uppercase tracking-wider text-slate-300">How positions ended</h3>
              <div className="mt-4 grid gap-3 sm:grid-cols-4">
                {(
                  [
                    ["TARGET", "Target", "text-emerald-300"],
                    ["STOP_LOSS", "Stop loss", "text-rose-300"],
                    ["MANUAL", "Manual", "text-amber-200"],
                    ["CANCELLED", "Cancelled", "text-slate-300"],
                  ] as const
                ).map(([key, label, tone]) => (
                  <div className="rounded-xl border border-white/10 bg-slate-950/60 p-4" key={key}>
                    <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">{label}</p>
                    <p className={`mt-1 text-xl font-black ${tone}`}>{summary.exitReasonCounts[key]}</p>
                  </div>
                ))}
              </div>
            </GlassPanel>
          </Reveal>
        )}

        <Reveal delayMs={180}>
          {state === "ready" ? (
            <GlassPanel className="border-white/10 p-6">
              <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-lg font-extrabold text-white">Chronological trade ledger</h3>
                  <p className="mt-0.5 text-xs text-slate-400">
                    Newest fill first. Every row is a local simulation with no broker or order-routing path.
                  </p>
                </div>
                {page?.truncated && (
                  <span className="rounded-full border border-amber-300/35 bg-amber-200/10 px-3 py-1 text-xs font-semibold text-amber-100">
                    Showing the newest {page.limit} trades only - raise the row limit to see more
                  </span>
                )}
              </div>

              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left">
                  <thead>
                    <tr className="border-b border-white/10 text-xs font-bold uppercase tracking-wider text-slate-400">
                      <th className="px-4 py-3">Instrument</th>
                      <th className="px-4 py-3">Account</th>
                      <th className="px-4 py-3">Side</th>
                      <th className="px-4 py-3">Qty</th>
                      <th className="px-4 py-3">Entry</th>
                      <th className="px-4 py-3">Exit</th>
                      <th className="px-4 py-3">Realised P&amp;L</th>
                      <th className="px-4 py-3">Return</th>
                      <th className="px-4 py-3">Reward</th>
                      <th className="px-4 py-3">Held</th>
                      <th className="px-4 py-3">Outcome</th>
                      <th className="px-4 py-3">Opened</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5 text-sm font-medium">
                    {records.map((record) => {
                      const isOpen = record.status === "OPEN";
                      const pnl = record.realizedPnl;
                      return (
                        <tr className="transition hover:bg-white/[0.03]" key={record.id}>
                          <td className="px-4 py-4 font-extrabold text-white">
                            <div className="flex items-center gap-2">
                              <span
                                className={`h-2 w-2 rounded-full ${
                                  isOpen ? "bg-cyan-400" : (pnl ?? 0) >= 0 ? "bg-emerald-400" : "bg-rose-400"
                                }`}
                              />
                              {record.instrumentSymbol}
                            </div>
                            <span className="mt-0.5 block text-[11px] font-normal text-slate-500">
                              {record.timeframe ?? "timeframe not recorded"}
                            </span>
                          </td>
                          <td className="px-4 py-4 text-xs text-slate-300">{record.accountName}</td>
                          <td className="px-4 py-4">
                            <span
                              className={`inline-flex rounded-md px-2.5 py-1 text-xs font-black ${
                                record.side === "LONG"
                                  ? "border border-emerald-500/30 bg-emerald-500/20 text-emerald-300"
                                  : "border border-rose-500/30 bg-rose-500/20 text-rose-300"
                              }`}
                            >
                              {record.side}
                            </span>
                          </td>
                          <td className="px-4 py-4 font-bold text-slate-200">{formatNumber(record.quantity, 0)}</td>
                          <td className="px-4 py-4 text-slate-300">₹{formatNumber(record.entryPrice, 2)}</td>
                          <td className="px-4 py-4 font-bold text-white">
                            {record.exitPrice === null ? "—" : `₹${formatNumber(record.exitPrice, 2)}`}
                          </td>
                          <td className={`px-4 py-4 font-black ${pnlTone(pnl)}`}>{currency(pnl)}</td>
                          <td className={`px-4 py-4 font-bold ${pnlTone(record.returnPercent)}`}>
                            {record.returnPercent === null ? "—" : `${formatNumber(record.returnPercent, 2)}%`}
                          </td>
                          <td className={`px-4 py-4 font-bold ${pnlTone(record.rewardMultiple)}`}>
                            {record.rewardMultiple === null ? "—" : `${formatNumber(record.rewardMultiple, 2)}R`}
                          </td>
                          <td className="px-4 py-4 text-xs text-slate-300">{formatHoldingPeriod(record.holdingMinutes)}</td>
                          <td className="px-4 py-4 text-xs">
                            <span className="font-semibold text-cyan-200">{exitReasonLabel(record)}</span>
                            {record.notes && (
                              <span className="mt-0.5 block max-w-xs truncate text-[11px] text-slate-500">{record.notes}</span>
                            )}
                          </td>
                          <td className="px-4 py-4 text-xs text-slate-400">{formatTimestamp(record.openedAt)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </GlassPanel>
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
        </Reveal>
      </div>
    </ResearchShell>
  );
}

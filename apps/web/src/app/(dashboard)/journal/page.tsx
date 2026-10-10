"use client";

import { useEffect, useMemo, useState } from "react";
import { GlassPanel } from "../../../components/ui/glass-panel";
import { getApiV1Url } from "../../../features/research/api";
import { formatNumber } from "../../../features/research/presentation";
import {
  BookOpen,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  XCircle,
  MinusCircle,
  Lightbulb,
  Microscope,
} from "lucide-react";

interface JournalReview {
  outcome: "WIN" | "LOSS" | "BREAKEVEN";
  realizedR: number;
  maximumAdverseExcursionR: number | null;
  maximumFavourableExcursionR: number | null;
  observedTimeframe: string | null;
  observations: string[];
  proposedResearchTags: string[];
}

interface JournalTrade {
  id: string;
  accountName: string;
  instrumentSymbol: string;
  timeframe: string | null;
  strategyName: string | null;
  side: "LONG" | "SHORT";
  status: "OPEN" | "CLOSED" | "CANCELLED";
  entryPrice: number;
  stopLoss: number;
  targetPrice: number;
  openedAt: string;
  closedAt: string | null;
  exitPrice: number | null;
  exitReason: string | null;
  realizedPnl: number | null;
  rewardMultiple: number | null;
  holdingMinutes: number | null;
  reasoning: string[];
  review: JournalReview | null;
}

interface JournalSummary {
  tradeCount: number;
  closedTradeCount: number;
  winRatePercent: number | null;
  netRealizedPnl: number;
  profitFactor: number | null;
  averageRewardMultiple: number | null;
}

interface Account {
  id: string;
  name: string;
}

const TAG_LABELS: Record<string, { label: string; tone: "amber" | "rose" | "slate"; explain: string }> = {
  GAVE_BACK_FAVOURABLE_MOVE: {
    label: "Gave back an open profit",
    tone: "amber",
    explain: "This trade was winning at one point before finishing at this result.",
  },
  EXITED_BELOW_PEAK: {
    label: "Exited below its peak",
    tone: "amber",
    explain: "A winner, but it banked less than the best point it reached.",
  },
  STOP_NEARLY_HIT: {
    label: "Stop nearly hit first",
    tone: "amber",
    explain: "This winner came close to being stopped out before it worked.",
  },
  NO_FOLLOW_THROUGH: {
    label: "Never moved much in favour",
    tone: "slate",
    explain: "The trade barely developed in its intended direction before resolving.",
  },
  LOSS_EXCEEDED_STOP: {
    label: "Lost more than the stop allowed",
    tone: "rose",
    explain: "The exit did not fill cleanly at the stop level.",
  },
  MISSING_EXIT_REASON: { label: "No exit reason recorded", tone: "slate", explain: "The close wasn't tagged with why." },
  EXIT_OUTSIDE_GEOMETRY: {
    label: "Closed off-plan",
    tone: "slate",
    explain: "Closed somewhere other than the stop or target.",
  },
  NO_HOLDING_PERIOD_DATA: { label: "No price data to measure", tone: "slate", explain: "Excursions could not be measured." },
  EXCURSION_SERIES_MISMATCH: { label: "Data mismatch", tone: "slate", explain: "Excursions could not be measured reliably." },
};

function tagTone(tone: "amber" | "rose" | "slate"): string {
  if (tone === "amber") return "text-amber-300 bg-amber-400/10 border-amber-400/20";
  if (tone === "rose") return "text-rose-300 bg-rose-400/10 border-rose-400/20";
  return "text-slate-300 bg-slate-400/10 border-slate-400/20";
}

function outcomeBadge(trade: JournalTrade) {
  if (trade.status !== "CLOSED" || trade.realizedPnl === null) {
    return (
      <span className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs text-slate-400 bg-slate-400/10">
        <MinusCircle className="size-3" /> OPEN
      </span>
    );
  }
  if (trade.realizedPnl > 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs text-emerald-400 bg-emerald-400/10">
        <CheckCircle2 className="size-3" /> WIN
      </span>
    );
  }
  if (trade.realizedPnl < 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs text-rose-400 bg-rose-400/10">
        <XCircle className="size-3" /> LOSS
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs text-slate-400 bg-slate-400/10">
      <MinusCircle className="size-3" /> BREAKEVEN
    </span>
  );
}

export default function JournalPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState<string>("ALL");
  const [openedFrom, setOpenedFrom] = useState<string>("");
  const [openedTo, setOpenedTo] = useState<string>("");
  const [trades, setTrades] = useState<JournalTrade[]>([]);
  const [summary, setSummary] = useState<JournalSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    const controller = new AbortController();
    async function fetchData() {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (accountId !== "ALL") params.set("accountId", accountId);
        if (openedFrom) params.set("openedFrom", new Date(`${openedFrom}T00:00:00+05:30`).toISOString());
        if (openedTo) params.set("openedTo", new Date(`${openedTo}T23:59:59+05:30`).toISOString());
        params.set("limit", "200");

        const res = await fetch(`${getApiV1Url()}/journal?${params.toString()}`, { signal: controller.signal });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error ?? "Failed to load the journal.");
        }
        const body = await res.json();
        setTrades(Array.isArray(body.data) ? body.data : []);
        setSummary(body.summary ?? null);
        setAccounts(Array.isArray(body.context?.accounts) ? body.context.accounts : []);
      } catch (err) {
        if ((err as Error).name !== "AbortError") setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    }
    void fetchData();
    return () => controller.abort();
  }, [accountId, openedFrom, openedTo]);

  // Across exactly the trades currently in view, not all-time -- the mentor reading should match
  // whatever bot/date window is on screen, not blend it with everything else ever traded.
  const commonPatterns = useMemo(() => {
    const counts = new Map<string, number>();
    for (const trade of trades) {
      if (!trade.review || trade.realizedPnl === null || trade.realizedPnl >= 0) continue;
      for (const tag of trade.review.proposedResearchTags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  }, [trades]);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="flex h-full flex-col font-sans">
      <div className="px-6 py-4 shrink-0 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-black text-white tracking-tight">
            <BookOpen className="size-6 text-cyan-400" />
            Trade Journal
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Every trade, what it was meant to do, and the measured reason it won or lost.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            className="bg-slate-800 text-white border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-400/50"
          >
            <option value="ALL">All bots</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>{account.name}</option>
            ))}
          </select>
          <input
            type="date"
            value={openedFrom}
            onChange={(e) => setOpenedFrom(e.target.value)}
            className="bg-slate-800 text-white border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-400/50"
            aria-label="From date"
          />
          <span className="text-slate-500 text-sm">to</span>
          <input
            type="date"
            value={openedTo}
            onChange={(e) => setOpenedTo(e.target.value)}
            className="bg-slate-800 text-white border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-400/50"
            aria-label="To date"
          />
          {(openedFrom || openedTo || accountId !== "ALL") && (
            <button
              type="button"
              onClick={() => { setOpenedFrom(""); setOpenedTo(""); setAccountId("ALL"); }}
              className="text-xs text-slate-400 hover:text-slate-200 underline underline-offset-2"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 pb-6 custom-scrollbar">
        {error && (
          <GlassPanel className="p-4 mb-6 text-rose-300 text-sm">{error}</GlassPanel>
        )}

        {summary && (
          <div className="grid grid-cols-2 gap-4 md:grid-cols-5 mb-6">
            <GlassPanel className="p-4 flex flex-col items-center justify-center">
              <p className="text-xs text-slate-400 font-medium">Trades</p>
              <p className="text-2xl font-bold text-white mt-1">{summary.tradeCount}</p>
            </GlassPanel>
            <GlassPanel className="p-4 flex flex-col items-center justify-center">
              <p className="text-xs text-slate-400 font-medium">Win Rate</p>
              <p className="text-2xl font-bold text-white mt-1">
                {summary.winRatePercent === null ? "—" : `${summary.winRatePercent.toFixed(1)}%`}
              </p>
            </GlassPanel>
            <GlassPanel className="p-4 flex flex-col items-center justify-center">
              <p className="text-xs text-slate-400 font-medium">Net P&amp;L</p>
              <p className={`text-2xl font-bold mt-1 ${summary.netRealizedPnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                {summary.netRealizedPnl >= 0 ? "+" : ""}{formatNumber(summary.netRealizedPnl, 0)}
              </p>
            </GlassPanel>
            <GlassPanel className="p-4 flex flex-col items-center justify-center">
              <p className="text-xs text-slate-400 font-medium">Profit Factor</p>
              <p className="text-2xl font-bold text-white mt-1">
                {summary.profitFactor === null ? "—" : summary.profitFactor.toFixed(2)}
              </p>
            </GlassPanel>
            <GlassPanel className="p-4 flex flex-col items-center justify-center">
              <p className="text-xs text-slate-400 font-medium">Avg R</p>
              <p className="text-2xl font-bold text-white mt-1">
                {summary.averageRewardMultiple === null ? "—" : `${summary.averageRewardMultiple.toFixed(2)}R`}
              </p>
            </GlassPanel>
          </div>
        )}

        {commonPatterns.length > 0 && (
          <GlassPanel className="p-4 mb-6">
            <div className="flex items-center gap-2 mb-3">
              <Lightbulb className="size-4 text-amber-300" />
              <h2 className="text-sm font-semibold text-white tracking-wide">
                RECURRING PATTERNS IN LOSSES (this view)
              </h2>
            </div>
            <div className="flex flex-wrap gap-2">
              {commonPatterns.map(([tag, count]) => {
                const meta = TAG_LABELS[tag] ?? { label: tag, tone: "slate" as const, explain: "" };
                return (
                  <span
                    key={tag}
                    title={meta.explain}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${tagTone(meta.tone)}`}
                  >
                    {meta.label} <span className="font-bold">x{count}</span>
                  </span>
                );
              })}
            </div>
          </GlassPanel>
        )}

        {loading ? (
          <div className="p-8 text-center text-slate-400">Loading the journal…</div>
        ) : trades.length === 0 ? (
          <GlassPanel className="p-8 text-center text-slate-400">
            No trades match these filters.
          </GlassPanel>
        ) : (
          <div className="flex flex-col gap-2">
            {trades.map((trade) => {
              const isExpanded = expanded.has(trade.id);
              return (
                <GlassPanel key={trade.id} className="overflow-hidden">
                  <button
                    type="button"
                    onClick={() => toggle(trade.id)}
                    className="w-full flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-left hover:bg-white/5 transition-colors"
                  >
                    <span className="text-xs text-slate-500 whitespace-nowrap w-36 shrink-0">
                      {new Date(trade.openedAt).toLocaleString(undefined, {
                        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
                      })}
                    </span>
                    <span className="text-xs text-slate-400 w-32 shrink-0 truncate" title={trade.accountName}>
                      {trade.accountName}
                    </span>
                    <span className="text-sm font-semibold text-slate-200 w-24 shrink-0">{trade.instrumentSymbol}</span>
                    <span className={`text-xs font-semibold w-14 shrink-0 ${trade.side === "LONG" ? "text-emerald-400" : "text-rose-400"}`}>
                      {trade.side}
                    </span>
                    <span className="text-xs text-slate-400 font-mono">
                      {formatNumber(trade.entryPrice, 2)} → {trade.exitPrice !== null ? formatNumber(trade.exitPrice, 2) : "—"}
                    </span>
                    <span className="shrink-0">{outcomeBadge(trade)}</span>
                    {trade.rewardMultiple !== null && (
                      <span className={`text-xs font-bold ${trade.rewardMultiple >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                        {trade.rewardMultiple >= 0 ? "+" : ""}{trade.rewardMultiple.toFixed(2)}R
                      </span>
                    )}
                    <span className="ml-auto shrink-0 text-slate-500">
                      {isExpanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
                    </span>
                  </button>

                  {isExpanded && (
                    <div className="border-t border-white/10 px-4 py-4 grid grid-cols-1 md:grid-cols-2 gap-6 bg-black/10">
                      <div>
                        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                          The setup
                        </h3>
                        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-300 mb-3">
                          <dt className="text-slate-500">Strategy</dt>
                          <dd>{trade.strategyName ?? "—"}</dd>
                          <dt className="text-slate-500">Entry</dt>
                          <dd className="font-mono">{formatNumber(trade.entryPrice, 2)}</dd>
                          <dt className="text-slate-500">Stop</dt>
                          <dd className="font-mono text-rose-400/80">{formatNumber(trade.stopLoss, 2)}</dd>
                          <dt className="text-slate-500">Target</dt>
                          <dd className="font-mono text-emerald-400/80">{formatNumber(trade.targetPrice, 2)}</dd>
                          <dt className="text-slate-500">Exit reason</dt>
                          <dd>{trade.exitReason ?? "—"}</dd>
                          <dt className="text-slate-500">Held</dt>
                          <dd>{trade.holdingMinutes !== null ? `${trade.holdingMinutes} min` : "—"}</dd>
                        </dl>
                        {trade.reasoning.length > 0 ? (
                          <ul className="space-y-1 text-xs text-slate-300 list-disc list-inside">
                            {trade.reasoning.map((line, i) => <li key={i}>{line}</li>)}
                          </ul>
                        ) : (
                          <p className="text-xs text-slate-500 italic">No recorded reasoning for this trade.</p>
                        )}
                      </div>

                      <div>
                        <h3 className="flex items-center gap-1.5 text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                          <Microscope className="size-3.5" /> Why it {trade.review?.outcome === "LOSS" ? "lost" : "won"}
                        </h3>
                        {trade.review ? (
                          <>
                            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-300 mb-3">
                              <dt className="text-slate-500">Realised</dt>
                              <dd className={trade.review.realizedR >= 0 ? "text-emerald-400" : "text-rose-400"}>
                                {trade.review.realizedR.toFixed(2)}R
                              </dd>
                              <dt className="text-slate-500">Ran in favour</dt>
                              <dd>
                                {trade.review.maximumFavourableExcursionR !== null
                                  ? `${trade.review.maximumFavourableExcursionR.toFixed(2)}R` : "unmeasured"}
                              </dd>
                              <dt className="text-slate-500">Ran against</dt>
                              <dd>
                                {trade.review.maximumAdverseExcursionR !== null
                                  ? `${trade.review.maximumAdverseExcursionR.toFixed(2)}R` : "unmeasured"}
                              </dd>
                            </dl>
                            <ul className="space-y-1 text-xs text-slate-300 mb-3">
                              {trade.review.observations.map((line, i) => <li key={i}>{line}</li>)}
                            </ul>
                            {trade.review.proposedResearchTags.length > 0 && (
                              <div className="flex flex-wrap gap-1.5">
                                {trade.review.proposedResearchTags.map((tag) => {
                                  const meta = TAG_LABELS[tag] ?? { label: tag, tone: "slate" as const, explain: "" };
                                  return (
                                    <span
                                      key={tag}
                                      title={meta.explain}
                                      className={`rounded-full border px-2.5 py-0.5 text-[11px] ${tagTone(meta.tone)}`}
                                    >
                                      {meta.label}
                                    </span>
                                  );
                                })}
                              </div>
                            )}
                          </>
                        ) : (
                          <p className="text-xs text-slate-500 italic">
                            {trade.status === "OPEN" ? "Still open — reviewed once it closes." : "Not yet reviewed."}
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                </GlassPanel>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

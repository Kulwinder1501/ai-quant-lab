"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "../../../components/layout/page-header";
import { GlassPanel } from "../../../components/ui/glass-panel";
import { errorMessage, isAbortError } from "../../../lib/errors";
import { getApiV1Url } from "../../research/api";
import { formatNumber } from "../../research/presentation";
import { OptionTradeModal } from "./option-trade-modal";
import { GreeksByStrikeChart } from "./greeks-by-strike-chart";
import { OiByStrikeChart } from "./oi-by-strike-chart";
import { OiHistoryPanel } from "./oi-history-panel";
import { DepthView } from "./depth-view";
import { ExposurePanel } from "./exposure-panel";
import { VolumeProfilePanel } from "./volume-profile-panel";
import { VolumeByTimePanel } from "./volume-by-time-panel";
import { DevelopingValuePanel } from "./developing-value-panel";
import { DataCoveragePanel } from "./data-coverage-panel";
import { ChainBasisView } from "./chain-basis-view";
import { VendorGreeksCheckView } from "./vendor-greeks-check-view";
import { SessionHistorySection } from "./session-history-section";
import { IvSkewView } from "./iv-skew-view";
import { ContractCostPanel, type CostStrike } from "./contract-cost-panel";
import { ImpliedMovePanel } from "./implied-move-panel";
import type { ImpliedMoveInput } from "../implied-move";
import {
  DEFAULT_COST_BUDGET_PERCENT,
  applyChainTick,
  subscribeToChainTicks,
  type ChainResponse,
  type Leg,
} from "../live-chain";
import { ivRefusalLabel } from "../iv-refusal-label";

/**
 * This page reads the API base URL from the same store as every other feature.
 *
 * It used to hold `process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4001/api/v1"`, which
 * broke two ways: the Settings page writes its override into the store, so changing the API
 * URL there had no effect here, and the fallback port disagreed with the 4000 that
 * `app-store.ts` and `.env.example` both use -- so with no env var set, this one page pointed
 * somewhere nothing was listening.
 */

const UNDERLYINGS = ["NIFTY50", "BANKNIFTY", "SBIN", "RELIANCE"] as const;

/**
 * Quotes and greeks are separate views rather than one table.
 *
 * Both sides of the ladder need seven columns each; showing greeks alongside would be
 * twenty-two columns, which is unreadable at any width.
 */
type ChainView = "quotes" | "greeks" | "oi" | "model" | "history" | "depth" | "profile" | "exposure" | "coverage";

/** Compact Indian-numbering for OI and volume, which run to crores. */
function compact(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1e7) return `${(value / 1e7).toFixed(2)}Cr`;
  if (abs >= 1e5) return `${(value / 1e5).toFixed(2)}L`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return String(Math.round(value));
}

/**
 * IV as a percentage, or a short reason why it could not be solved.
 *
 * A blank would read as "no data"; the reason distinguishes an expired contract from an
 * unquoted one from a stale price below intrinsic, and those imply different actions.
 */
function ivLabel(leg: Leg | null): string {
  if (!leg) return "—";
  if (leg.impliedVolatility !== null) return `${(leg.impliedVolatility * 100).toFixed(1)}%`;
  return ivRefusalLabel(leg.impliedVolatilityRefusal);
}

/** Fixed decimals, or an em dash when the greek could not be computed. */
function fixed(value: number | null, places: number): string {
  return value === null || !Number.isFinite(value) ? "—" : value.toFixed(places);
}

function signed(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${compact(value)}`;
}

export function OptionChainDashboard() {
  const [underlying, setUnderlying] = useState<string>("NIFTY50");
  const [expiry, setExpiry] = useState<string>("");
  const [view, setView] = useState<ChainView>("quotes");
  const [chain, setChain] = useState<ChainResponse | null>(null);
  /**
   * The server response exactly as fetched, never touched by `applyChainTick`.
   *
   * The charts read this, not `chain`. A tick re-solves any leg that ticked from its live mid, but
   * leaves the implied forward at its snapshot value, so the tick-merged chain mixes clocks: streamed
   * strikes near ATM on live mids, the rest on snapshot mids, all at a stale forward. Charted, that
   * shows up as a step at the edge of the streamed band that reads as real structure. One clock per
   * chart is what the "snapshot" label on it promises.
   */
  const [snapshotChain, setSnapshotChain] = useState<ChainResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tradeModalConfig, setTradeModalConfig] = useState<{
    leg: Leg;
    strike: number;
    optionType: "CE" | "PE";
  } | null>(null);

  /**
   * Fetches without touching state, so the effect below can set it in a callback.
   *
   * `react-hooks/set-state-in-effect` forbids a synchronous setState in an effect body
   * because it causes a cascading render, which is why this returns a result instead of
   * assigning one. Matches the pattern the other dashboards in this app already use.
   */
  type LoadResult =
    | { status: "loaded"; chain: ChainResponse }
    | { status: "failed"; message: string }
    | { status: "aborted" };

  const fetchChain = useCallback(async (signal: AbortSignal): Promise<LoadResult> => {
    try {
      const query = new URLSearchParams({
        underlying,
        costBudgetPercent: String(DEFAULT_COST_BUDGET_PERCENT),
      });
      if (expiry) query.set("expiry", expiry);
      const response = await fetch(`${getApiV1Url()}/option-chain?${query.toString()}`, { signal });
      if (!response.ok) throw new Error(`Option chain request failed (${response.status}).`);
      const payload = await response.json();
      return { status: "loaded", chain: payload.data as ChainResponse };
    } catch (caught) {
      if (isAbortError(caught)) return { status: "aborted" };
      return { status: "failed", message: errorMessage(caught, "The option chain could not be loaded.") };
    }
  }, [underlying, expiry]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchChain(controller.signal).then((result) => {
      // An aborted request belongs to a superseded selection, so it must not clear the
      // error or overwrite the chain the current selection is about to load.
      if (result.status === "aborted") return;
      if (result.status === "loaded") {
        setChain(result.chain);
        setSnapshotChain(result.chain);
        setError(null);
      } else {
        setError(result.message);
      }
      setLoading(false);
    });
    return () => controller.abort();
  }, [fetchChain]);

  const [lastTickAt, setLastTickAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 2000);
    return () => window.clearInterval(timer);
  }, []);

  // Live streaming via SSE
  useEffect(() => {
    if (!chain?.available) return;
    return subscribeToChainTicks(underlying, (tick) => {
      setLastTickAt(Date.now());
      setChain((prev) => applyChainTick(prev, tick));
    });
  }, [chain?.available, underlying]);

  /**
   * Stable strike rows for charts. Inline mapping on every 2s `now` tick would defeat
   * the chart's useMemo and re-animate bars; keep the reference while the chain snapshot is unchanged.
   */
  const oiChartStrikes = useMemo(
    () =>
      (snapshotChain?.strikes ?? []).map((row) => ({
        strikePrice: row.strikePrice,
        call: row.call
          ? {
              openInterest: row.call.openInterest,
              openInterestChange: row.call.openInterestChange,
            }
          : null,
        put: row.put
          ? {
              openInterest: row.put.openInterest,
              openInterestChange: row.put.openInterestChange,
            }
          : null,
      })),
    [snapshotChain?.strikes],
  );

  const greeksChartStrikes = useMemo(
    () =>
      (snapshotChain?.strikes ?? []).map((row) => ({
        strikePrice: row.strikePrice,
        call: row.call
          ? {
              impliedVolatility: row.call.impliedVolatility,
              impliedVolatilityRefusal: row.call.impliedVolatilityRefusal,
              delta: row.call.delta,
              gamma: row.call.gamma,
              theta: row.call.theta,
              vega: row.call.vega,
              vendorGreeks: row.call.vendorGreeks ?? null,
            }
          : null,
        put: row.put
          ? {
              impliedVolatility: row.put.impliedVolatility,
              impliedVolatilityRefusal: row.put.impliedVolatilityRefusal,
              delta: row.put.delta,
              gamma: row.put.gamma,
              theta: row.put.theta,
              vega: row.put.vega,
              vendorGreeks: row.put.vendorGreeks ?? null,
            }
          : null,
      })),
    [snapshotChain?.strikes],
  );

  /** Exposure reads OI, the solved IV and time to expiry from the same untouched snapshot as the other charts. */
  const exposureChartStrikes = useMemo(
    () =>
      (snapshotChain?.strikes ?? []).map((row) => ({
        strikePrice: row.strikePrice,
        call: row.call
          ? {
              openInterest: row.call.openInterest,
              impliedVolatility: row.call.impliedVolatility,
              daysToExpiry: row.call.daysToExpiry,
              vendorGamma: row.call.vendorGreeks?.gamma ?? null,
            }
          : null,
        put: row.put
          ? {
              openInterest: row.put.openInterest,
              impliedVolatility: row.put.impliedVolatility,
              daysToExpiry: row.put.daysToExpiry,
              vendorGamma: row.put.vendorGreeks?.gamma ?? null,
            }
          : null,
      })),
    [snapshotChain?.strikes],
  );

  /** The ATM legs' quotes, the solved ATM IV and the days to expiry, from the same untouched snapshot as the other charts. */
  const impliedMoveInput = useMemo<ImpliedMoveInput>(() => {
    const atmStrike = snapshotChain?.atmStrike ?? null;
    const row = atmStrike === null ? undefined : (snapshotChain?.strikes ?? []).find((entry) => entry.strikePrice === atmStrike);
    return {
      spot: snapshotChain?.underlyingValue ?? null,
      atmStrike,
      atmCall: row?.call ? { bid: row.call.bid, ask: row.call.ask } : null,
      atmPut: row?.put ? { bid: row.put.bid, ask: row.put.ask } : null,
      atmIv: snapshotChain?.atmImpliedVolatility ?? null,
      daysToExpiry: row?.call?.daysToExpiry ?? row?.put?.daysToExpiry ?? null,
    };
  }, [snapshotChain]);

  /** Each leg's quote, solved IV and Greeks for the contract cost card, from the same untouched snapshot. */
  const contractCostStrikes = useMemo<CostStrike[]>(
    () =>
      (snapshotChain?.strikes ?? []).map((row) => ({
        strikePrice: row.strikePrice,
        call: row.call
          ? { bid: row.call.bid, ask: row.call.ask, impliedVolatility: row.call.impliedVolatility, delta: row.call.delta, gamma: row.call.gamma, theta: row.call.theta, daysToExpiry: row.call.daysToExpiry }
          : null,
        put: row.put
          ? { bid: row.put.bid, ask: row.put.ask, impliedVolatility: row.put.impliedVolatility, delta: row.put.delta, gamma: row.put.gamma, theta: row.put.theta, daysToExpiry: row.put.daysToExpiry }
          : null,
      })),
    [snapshotChain?.strikes],
  );

  /** The stored snapshot's strikes, ATM and ATM volatility, which the Model greeks panels all read, counted for the basis line. */
  const chainBasisInput = useMemo(() => ({
    strikes: snapshotChain?.strikes ?? [],
    atmStrike: snapshotChain?.atmStrike ?? null,
    atmImpliedVolatility: snapshotChain?.atmImpliedVolatility ?? null,
  }), [snapshotChain?.strikes, snapshotChain?.atmStrike, snapshotChain?.atmImpliedVolatility]);

  const chartExpiryLabel = useMemo(() => {
    const selected = expiry
      ? (chain?.expiries ?? []).find((entry) => entry.expiryDate === expiry)
      : (chain?.expiries ?? [])[0];
    return selected ? `${selected.expiryDate} ${selected.expiryKind}` : "—";
  }, [chain?.expiries, expiry]);

  const spreadTone = useCallback((leg: Leg | null) => {
    // A one-sided quote is unknown, not cheap. Rendering it as good would make the most
    // illiquid strikes look the most tradeable, which is the inversion that matters.
    if (!leg || leg.spreadPercentOfMid === null) return "text-slate-500";
    if (leg.withinCostBudget) return "text-emerald-300";
    return leg.spreadPercentOfMid <= DEFAULT_COST_BUDGET_PERCENT * 2
      ? "text-amber-300"
      : "text-rose-300";
  }, []);

  const rows = useMemo(() => {
    const allRows = chain?.strikes ?? [];
    if (allRows.length === 0) return [];
    const atmIndex = allRows.findIndex((r) => r.isAtm);
    if (atmIndex === -1) return allRows;
    const startIndex = Math.max(0, atmIndex - 5);
    const endIndex = Math.min(allRows.length, atmIndex + 6);
    return allRows.slice(startIndex, endIndex);
  }, [chain]);

  return (
    <div className="space-y-5 p-4 md:p-6">
      <PageHeader
        eyebrow="Derivatives"
        title="Option Chain"
        description="Point-in-time observations: open interest, traded volume, bid–ask spread and the real expiry calendar."
        unavailable={chain !== null && !chain.available}
      />

      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {UNDERLYINGS.map((symbol) => (
          <button
            key={symbol}
            type="button"
            onClick={() => { setUnderlying(symbol); setExpiry(""); }}
            className={`rounded-xl border px-3 py-1.5 text-xs font-bold transition ${
              underlying === symbol
                ? "border-cyan-400/60 bg-cyan-500/15 text-cyan-200"
                : "border-white/10 bg-slate-950/60 text-slate-400 hover:text-slate-200"
            }`}
          >
            {symbol}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-1 rounded-xl border border-white/10 bg-slate-950/60 p-1">
          {(["quotes", "greeks", "oi", "history", "model", "exposure", "depth", "profile", "coverage"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setView(option)}
              className={`rounded-lg px-3 py-1 text-xs font-bold capitalize transition ${
                view === option ? "bg-violet-500/20 text-violet-200" : "text-slate-400 hover:text-slate-200"
              }`}
            >
              {option === "oi" ? "OI chart" : option === "history" ? "OI history" : option === "model" ? "Model greeks" : option === "depth" ? "Depth" : option === "profile" ? "Volume profile" : option === "exposure" ? "Exposure" : option === "coverage" ? "Data coverage" : option}
            </button>
          ))}
        </div>
        {(chain?.expiries ?? []).length > 1 && (
          <select
            value={expiry}
            onChange={(event) => setExpiry(event.target.value)}
            className="rounded-xl border border-white/10 bg-slate-950 px-3 py-1.5 text-xs font-bold text-slate-200"
          >
            <option value="">All expiries</option>
            {(chain?.expiries ?? []).map((entry) => (
              <option key={entry.expiryDate} value={entry.expiryDate}>
                {entry.expiryDate} · {entry.expiryKind}
              </option>
            ))}
          </select>
        )}
      </div>

      {error && (
        <GlassPanel className="border-rose-500/30 p-4 text-sm text-rose-200">{error}</GlassPanel>
      )}

      {loading && chain === null && (
        <GlassPanel className="p-6 text-sm text-slate-400">Loading option chain…</GlassPanel>
      )}

      {chain && !chain.available && (
        <GlassPanel className="p-6 text-sm text-slate-300">
          <p className="font-bold text-amber-300">No snapshot collected yet</p>
          <p className="mt-2 text-slate-400">{chain.reason}</p>
          {/* Absence is the normal early state: the series only deepens from the moment
              collection starts, because no historical option-chain source exists. */}
          <p className="mt-2 text-xs text-slate-500">
            Run <code className="text-cyan-300">npm run data:collect:option-chain</code>. Option-chain
            history accumulates forward only — there is no historical source to backfill from.
          </p>
        </GlassPanel>
      )}

      {chain?.available && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <GlassPanel className="p-4">
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Underlying</p>
              <p className="mt-1 text-2xl font-black text-white">
                {formatNumber(chain.underlyingValue ?? 0, 2)}
              </p>
              <p className="mt-1 text-xs text-slate-400">
                fwd{" "}
                {Object.values(chain.impliedForwardByExpiry ?? {})[0] === undefined
                  ? "—"
                  : formatNumber(Object.values(chain.impliedForwardByExpiry ?? {})[0]!, 0)}
                {" · "}ATM {chain.atmStrike ?? "—"} · IV{" "}
                {chain.atmImpliedVolatility === null || chain.atmImpliedVolatility === undefined
                  ? "unmeasurable"
                  : `${(chain.atmImpliedVolatility * 100).toFixed(2)}%`}
              </p>
            </GlassPanel>

            <GlassPanel className="p-4">
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Put / Call ratio</p>
              <p className="mt-1 text-2xl font-black text-white">
                {chain.putCall?.openInterestRatio === null || chain.putCall === undefined
                  ? "—"
                  : chain.putCall.openInterestRatio.toFixed(3)}
              </p>
              {/* OI and volume answer different questions: positioning carried overnight
                  versus what changed hands today. Showing one as "the" PCR hides that. */}
              <p className="mt-1 text-xs text-slate-400">
                by volume {chain.putCall?.volumeRatio?.toFixed(3) ?? "—"}
              </p>
            </GlassPanel>

            <GlassPanel className="p-4">
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Median spread</p>
              <p className="mt-1 text-2xl font-black text-white">
                {chain.liquidity?.medianSpreadPercent === null || !chain.liquidity
                  ? "—"
                  : `${chain.liquidity.medianSpreadPercent.toFixed(2)}%`}
              </p>
              <p className="mt-1 text-xs text-slate-400">
                {chain.liquidity?.withinCostBudget ?? 0} of {chain.liquidity?.quotedBothSides ?? 0} within{" "}
                {chain.liquidity?.costBudgetPercent ?? DEFAULT_COST_BUDGET_PERCENT}%
              </p>
            </GlassPanel>

            <GlassPanel className="p-4">
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                Largest open interest
              </p>
              <p className="mt-1 text-sm font-bold text-white">
                CE {chain.largestOpenInterest?.call?.strikePrice ?? "—"} · PE{" "}
                {chain.largestOpenInterest?.put?.strikePrice ?? "—"}
              </p>
              {/* Deliberately not called support or resistance: it is where positions sit,
                  not a level price must respect. */}
              <p className="mt-1 text-xs text-slate-500">
                Where positions sit — not a support or resistance level.
              </p>
            </GlassPanel>
          </div>

          <GlassPanel className="p-0">
            {view === "oi" ? (
              <div className="px-4 py-4">
                <OiByStrikeChart
                  strikes={oiChartStrikes}
                  atmStrike={snapshotChain?.atmStrike ?? null}
                  underlyingValue={snapshotChain?.underlyingValue ?? null}
                  observedAt={snapshotChain?.observedAt}
                  provider={snapshotChain?.provider}
                  expiryLabel={chartExpiryLabel}
                  nowMs={now}
                />
              </div>
            ) : view === "exposure" ? (
              <div className="px-4 py-4">
                <ExposurePanel
                  strikes={exposureChartStrikes}
                  atmStrike={snapshotChain?.atmStrike ?? null}
                  underlyingValue={snapshotChain?.underlyingValue ?? null}
                  forward={Object.values(snapshotChain?.impliedForwardByExpiry ?? {})[0] ?? null}
                  observedAt={snapshotChain?.observedAt}
                  provider={snapshotChain?.provider}
                  expiryLabel={chartExpiryLabel}
                  nowMs={now}
                />
              </div>
            ) : view === "profile" ? (
              <div className="px-4 py-4">
                {/* Futures bars from the database, not the broker; keyed so a switch drops the session and row choice. */}
                <VolumeProfilePanel key={`profile-${underlying}`} underlying={underlying} nowMs={now} />
                {/* The same profile as it formed through the day; keyed so a switch drops its own selections. */}
                <DevelopingValuePanel key={`developing-${underlying}`} underlying={underlying} nowMs={now} />
                {/* Observed volume by time of day, same futures bars; keyed so a switch drops its own selections. */}
                <VolumeByTimePanel key={`by-time-${underlying}`} underlying={underlying} nowMs={now} />
              </div>
            ) : view === "coverage" ? (
              <div className="px-4 py-4">
                {/* Counts of what is stored from each source; keyed so a switch drops its look-back choice. */}
                <DataCoveragePanel key={`coverage-${underlying}`} underlying={underlying} nowMs={now} />
              </div>
            ) : view === "depth" ? (
              <div className="px-4 py-4">
                {/* Reads the collector's stored frames, not the broker; keyed so a switch resets its poll and its session. */}
                <DepthView key={underlying} underlying={underlying} nowMs={now} />
              </div>
            ) : view === "history" ? (
              <div className="px-4 py-4">
                {/* Keyed by underlying so a switch drops the session and contract selection. */}
                <OiHistoryPanel key={underlying} underlying={underlying} expiry={expiry} nowMs={now} />
              </div>
            ) : view === "model" ? (
              <div className="px-4 py-4">
                <ChainBasisView input={chainBasisInput} />
                <GreeksByStrikeChart
                  strikes={greeksChartStrikes}
                  atmStrike={snapshotChain?.atmStrike ?? null}
                  underlyingValue={snapshotChain?.underlyingValue ?? null}
                  observedAt={snapshotChain?.observedAt}
                  provider={snapshotChain?.provider}
                  expiryLabel={chartExpiryLabel}
                  nowMs={now}
                />
                {/* The shape of the smile in three numbers, from the same stored snapshot. */}
                <IvSkewView strikes={greeksChartStrikes} />
                {/* The model Greeks against Fyers' own, for the contracts that have both. */}
                <VendorGreeksCheckView strikes={greeksChartStrikes} />
                {/* Skew and the model-vs-Fyers gap across sessions; one read of the stored chains, keyed so a switch drops it. */}
                <SessionHistorySection key={`session-history-${underlying}`} underlying={underlying} />
                {/* Observed option prices and the model IV beside observed futures moves; separate request, keyed with the page. */}
                <ImpliedMovePanel key={`implied-${underlying}`} underlying={underlying} input={impliedMoveInput} expiryLabel={chartExpiryLabel} />
                {/* What one contract costs and needs; the selection is local, so it is keyed with the underlying. */}
                <ContractCostPanel key={`contract-cost-${underlying}`} strikes={contractCostStrikes} input={impliedMoveInput} expiryLabel={chartExpiryLabel} underlying={underlying} expiry={expiry} observedAt={snapshotChain?.observedAt} nowMs={now} />
              </div>
            ) : (
              <>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/5 px-4 py-3">
              <p className="text-sm font-bold text-white">
                {chain.underlyingSymbol}
                <span className="ml-2 text-xs font-normal text-slate-400">
                  {chain.expiries?.map((entry) => `${entry.expiryDate} ${entry.expiryKind}`).join(" · ")}
                </span>
              </p>
              <div className="flex flex-wrap items-center gap-3 text-xs">
                {lastTickAt && now - lastTickAt < 10000 ? (
                  <span className="flex items-center gap-1.5 font-semibold text-emerald-400">
                    <span className="inline-block h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                    Live ticks streaming
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5 text-slate-400">
                    <span className="inline-block h-2 w-2 rounded-full bg-amber-400" />
                    Connecting live feed…
                  </span>
                )}
                <span className="text-slate-500">
                  (Snapshot: {chain.observedAt?.slice(0, 19).replace("T", " ")} UTC · {chain.provider})
                </span>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[1000px] text-right text-xs">
                <thead className="text-[10px] uppercase tracking-wider text-slate-500">
                  <tr className="border-b border-white/5">
                    {view === "quotes" ? (
                      <>
                        <th className="px-3 py-2 text-right">OI chg</th>
                        <th className="px-3 py-2 text-right">OI</th>
                        <th className="px-3 py-2 text-right">Vol</th>
                        <th className="px-3 py-2 text-right">IV</th>
                        <th className="px-3 py-2 text-right">Spread</th>
                        <th className="px-3 py-2 text-right">Bid</th>
                        <th className="px-3 py-2 text-right">Ask</th>
                        <th className="px-3 py-2 text-center">Action</th>
                      </>
                    ) : (
                      <>
                        <th className="px-3 py-2 text-right">Vega</th>
                        <th className="px-3 py-2 text-right">Theta</th>
                        <th className="px-3 py-2 text-right">Gamma</th>
                        <th className="px-3 py-2 text-right">Delta</th>
                        <th className="px-3 py-2 text-right">IV</th>
                        <th className="px-3 py-2 text-right">Bid</th>
                        <th className="px-3 py-2 text-right">Ask</th>
                        <th className="px-3 py-2 text-center">Action</th>
                      </>
                    )}
                    <th className="px-3 py-2 text-center text-cyan-300 sticky left-0 right-0 z-20 bg-slate-900 border-x border-white/10 shadow-[0_0_15px_rgba(0,0,0,0.5)]">Strike</th>
                    {view === "quotes" ? (
                      <>
                        <th className="px-3 py-2 text-center">Action</th>
                        <th className="px-3 py-2 text-left">Bid</th>
                        <th className="px-3 py-2 text-left">Ask</th>
                        <th className="px-3 py-2 text-left">Spread</th>
                        <th className="px-3 py-2 text-left">IV</th>
                        <th className="px-3 py-2 text-left">Vol</th>
                        <th className="px-3 py-2 text-left">OI</th>
                        <th className="px-3 py-2 text-left">OI chg</th>
                      </>
                    ) : (
                      <>
                        <th className="px-3 py-2 text-left">Bid</th>
                        <th className="px-3 py-2 text-left">Ask</th>
                        <th className="px-3 py-2 text-left">IV</th>
                        <th className="px-3 py-2 text-left">Delta</th>
                        <th className="px-3 py-2 text-left">Gamma</th>
                        <th className="px-3 py-2 text-left">Theta</th>
                        <th className="px-3 py-2 text-left">Vega</th>
                      </>
                    )}
                  </tr>
                  <tr className="border-b border-white/10 text-[10px]">
                    <th colSpan={8} className="px-3 py-1 text-center font-bold text-emerald-300/80">CALLS</th>
                    <th />
                    <th colSpan={8} className="px-3 py-1 text-center font-bold text-rose-300/80">PUTS</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const ivCell = (leg: Leg | null, align: string) => (
                      <td
                        className={`px-3 py-1.5 ${align} ${
                          leg?.impliedVolatility === null ? "text-slate-600 italic" : "text-violet-300"
                        }`}
                        title={leg?.impliedVolatilityRefusal ?? undefined}
                      >
                        {ivLabel(leg)}
                      </td>
                    );
                    return (
                      <tr
                        key={row.strikePrice}
                        className={`border-b border-white/5 ${
                          row.isAtm ? "bg-cyan-500/10" : "hover:bg-white/[0.03]"
                        }`}
                      >
                        {view === "quotes" ? (
                          <>
                            <td className={`px-3 py-1.5 ${(row.call?.openInterestChange ?? 0) > 0 ? "text-emerald-300" : "text-rose-300"}`}>
                              {signed(row.call?.openInterestChange ?? null)}
                            </td>
                            <td className="px-3 py-1.5 text-slate-300">{compact(row.call?.openInterest ?? null)}</td>
                            <td className="px-3 py-1.5 text-slate-400">{compact(row.call?.volume ?? null)}</td>
                            {ivCell(row.call, "text-right")}
                            <td className={`px-3 py-1.5 font-bold ${spreadTone(row.call)}`}>
                              {row.call?.spreadPercentOfMid == null ? "—" : `${row.call.spreadPercentOfMid.toFixed(2)}%`}
                            </td>
                            <td className="px-3 py-1.5 text-slate-300">{row.call?.bid ?? "—"}</td>
                            <td className="px-3 py-1.5 text-slate-300">{row.call?.ask ?? "—"}</td>
                            <td className="px-3 py-1.5 text-center">
                              {row.call && row.call.ask && (
                                <button
                                  type="button"
                                  onClick={() => setTradeModalConfig({ leg: row.call!, strike: row.strikePrice, optionType: "CE" })}
                                  className="rounded bg-emerald-500/20 px-2 py-0.5 text-[10px] font-bold text-emerald-300 hover:bg-emerald-500/40 transition"
                                >
                                  BUY
                                </button>
                              )}
                            </td>
                          </>
                        ) : (
                          <>
                            <td className="px-3 py-1.5 text-sky-300">{fixed(row.call?.vega ?? null, 2)}</td>
                            <td className="px-3 py-1.5 text-amber-300">{fixed(row.call?.theta ?? null, 2)}</td>
                            <td className="px-3 py-1.5 text-slate-400">{fixed(row.call?.gamma ?? null, 6)}</td>
                            <td className="px-3 py-1.5 font-bold text-emerald-300">{fixed(row.call?.delta ?? null, 4)}</td>
                            {ivCell(row.call, "text-right")}
                            <td className="px-3 py-1.5 text-slate-300">{row.call?.bid ?? "—"}</td>
                            <td className="px-3 py-1.5 text-slate-300">{row.call?.ask ?? "—"}</td>
                            <td className="px-3 py-1.5 text-center">
                              {row.call && row.call.ask && (
                                <button
                                  type="button"
                                  onClick={() => setTradeModalConfig({ leg: row.call!, strike: row.strikePrice, optionType: "CE" })}
                                  className="rounded bg-emerald-500/20 px-2 py-0.5 text-[10px] font-bold text-emerald-300 hover:bg-emerald-500/40 transition"
                                >
                                  BUY
                                </button>
                              )}
                            </td>
                          </>
                        )}
                        <td className={`px-3 py-1.5 text-center font-black sticky left-0 right-0 z-10 border-x border-white/10 shadow-[0_0_15px_rgba(0,0,0,0.5)] ${row.isAtm ? "text-cyan-200 bg-slate-800" : "text-white bg-slate-900"}`}>
                          {row.strikePrice}
                        </td>
                        {view === "quotes" ? (
                          <>
                            <td className="px-3 py-1.5 text-center">
                              {row.put && row.put.ask && (
                                <button
                                  type="button"
                                  onClick={() => setTradeModalConfig({ leg: row.put!, strike: row.strikePrice, optionType: "PE" })}
                                  className="rounded bg-rose-500/20 px-2 py-0.5 text-[10px] font-bold text-rose-300 hover:bg-rose-500/40 transition"
                                >
                                  BUY
                                </button>
                              )}
                            </td>
                            <td className="px-3 py-1.5 text-left text-slate-300">{row.put?.bid ?? "—"}</td>
                            <td className="px-3 py-1.5 text-left text-slate-300">{row.put?.ask ?? "—"}</td>
                            <td className={`px-3 py-1.5 text-left font-bold ${spreadTone(row.put)}`}>
                              {row.put?.spreadPercentOfMid == null ? "—" : `${row.put.spreadPercentOfMid.toFixed(2)}%`}
                            </td>
                            {ivCell(row.put, "text-left")}
                            <td className="px-3 py-1.5 text-left text-slate-400">{compact(row.put?.volume ?? null)}</td>
                            <td className="px-3 py-1.5 text-left text-slate-300">{compact(row.put?.openInterest ?? null)}</td>
                            <td className={`px-3 py-1.5 text-left ${(row.put?.openInterestChange ?? 0) > 0 ? "text-emerald-300" : "text-rose-300"}`}>
                              {signed(row.put?.openInterestChange ?? null)}
                            </td>
                          </>
                        ) : (
                          <>
                            <td className="px-3 py-1.5 text-center">
                              {row.put && row.put.ask && (
                                <button
                                  type="button"
                                  onClick={() => setTradeModalConfig({ leg: row.put!, strike: row.strikePrice, optionType: "PE" })}
                                  className="rounded bg-rose-500/20 px-2 py-0.5 text-[10px] font-bold text-rose-300 hover:bg-rose-500/40 transition"
                                >
                                  BUY
                                </button>
                              )}
                            </td>
                            <td className="px-3 py-1.5 text-left text-slate-300">{row.put?.bid ?? "—"}</td>
                            <td className="px-3 py-1.5 text-left text-slate-300">{row.put?.ask ?? "—"}</td>
                            {ivCell(row.put, "text-left")}
                            <td className="px-3 py-1.5 text-left font-bold text-rose-300">{fixed(row.put?.delta ?? null, 4)}</td>
                            <td className="px-3 py-1.5 text-left text-slate-400">{fixed(row.put?.gamma ?? null, 6)}</td>
                            <td className="px-3 py-1.5 text-left text-amber-300">{fixed(row.put?.theta ?? null, 2)}</td>
                            <td className="px-3 py-1.5 text-left text-sky-300">{fixed(row.put?.vega ?? null, 2)}</td>
                          </>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <p className="border-t border-white/5 px-4 py-3 text-[11px] text-slate-500">
              {view === "greeks" && (
                <>
                  Theta is currency per calendar day and is negative for a long option — the buyer
                  pays it. Vega is per one absolute percentage point of IV and is positive for calls
                  and puts alike. Every greek is computed <strong>at the solved IV</strong>, so it is
                  blank exactly when IV is, never at a substituted volatility.{" "}
                </>
              )}
              IV is <strong>derived</strong>: the volatility that reproduces the observed mid under
              Black-Scholes, solved from a two-sided quote only — never from a last price, which can be
              hours stale. An italic entry names why it could not be solved rather than showing a blank.
              Spread is coloured against a {DEFAULT_COST_BUDGET_PERCENT}% of mid budget — the level at
              which a measured volatility edge of +0.117% of spot is consumed by four option legs. A
              dash means one side was unquoted, which is an unknown spread rather than a cheap one.
            </p>
              </>
            )}
          </GlassPanel>
        </>
      )}

      {tradeModalConfig && (() => {
        // Read from the live chain, so the ticket's price keeps moving while it is open.
        const liveLeg = chain?.strikes?.find((row) => row.strikePrice === tradeModalConfig.strike)
          ?.[tradeModalConfig.optionType === "CE" ? "call" : "put"] ?? null;
        return (
        <OptionTradeModal
          show={true}
          onClose={() => setTradeModalConfig(null)}
          underlyingSymbol={chain!.underlyingSymbol}
          strike={tradeModalConfig.strike}
          optionType={tradeModalConfig.optionType}
          expiryDate={expiry || chain!.expiries![0].expiryDate}
          premium={tradeModalConfig.leg.ask!}
          impliedVolatility={liveLeg?.impliedVolatility ?? tradeModalConfig.leg.impliedVolatility}
          livePremium={liveLeg ? { bid: liveLeg.bid, ask: liveLeg.ask } : null}
        />
        );
      })()}
    </div>
  );
}

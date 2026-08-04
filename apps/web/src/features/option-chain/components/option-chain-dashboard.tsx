"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "../../../components/layout/page-header";
import { GlassPanel } from "../../../components/ui/glass-panel";
import { errorMessage, isAbortError } from "../../../lib/errors";
import { formatNumber } from "../../research/presentation";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4001/api/v1";

/** The cost budget the measured volatility edge can afford: it dies near 1.09% per leg. */
const DEFAULT_COST_BUDGET_PERCENT = 1.0;

const UNDERLYINGS = ["NIFTY50", "BANKNIFTY", "SBIN", "RELIANCE"] as const;

/**
 * Quotes and greeks are separate views rather than one table.
 *
 * Both sides of the ladder need seven columns each; showing greeks alongside would be
 * twenty-two columns, which is unreadable at any width.
 */
type ChainView = "quotes" | "greeks";

interface Leg {
  lastPrice: number | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  openInterest: number | null;
  openInterestChange: number | null;
  spreadAbsolute: number | null;
  spreadPercentOfMid: number | null;
  withinCostBudget: boolean | null;
  moneyness: "ITM" | "ATM" | "OTM" | null;
  providerSymbol: string;
  /** Solved from the mid, not published by the exchange. Null carries a reason. */
  impliedVolatility: number | null;
  impliedVolatilityRefusal: string | null;
  /** Computed at the solved IV, so null together with it - never at a house volatility. */
  delta: number | null;
  gamma: number | null;
  /** Currency per calendar day. Negative for a long option: the buyer pays theta. */
  theta: number | null;
  /** Per one absolute percentage point of IV. Positive for calls and puts alike. */
  vega: number | null;
  daysToExpiry: number | null;
}

interface StrikeRow {
  strikePrice: number;
  isAtm: boolean;
  call: Leg | null;
  put: Leg | null;
}

interface ChainResponse {
  underlyingSymbol: string;
  available: boolean;
  reason?: string;
  provider?: string;
  observedAt?: string;
  underlyingValue?: number | null;
  atmStrike?: number | null;
  atmImpliedVolatility?: number | null;
  impliedForwardByExpiry?: Record<string, number>;
  expiries?: Array<{ expiryDate: string; expiryKind: string }>;
  putCall?: {
    openInterestRatio: number | null;
    volumeRatio: number | null;
    callOpenInterest: number;
    putOpenInterest: number;
  };
  liquidity?: {
    contracts: number;
    quotedBothSides: number;
    medianSpreadPercent: number | null;
    withinCostBudget: number;
    costBudgetPercent: number;
  };
  largestOpenInterest?: {
    call: { strikePrice: number; openInterest: number } | null;
    put: { strikePrice: number; openInterest: number } | null;
  };
  strikes?: StrikeRow[];
}

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
  switch (leg.impliedVolatilityRefusal) {
    case "EXPIRED_OR_ZERO_TIME": return "expired";
    case "NO_TWO_SIDED_QUOTE": return "no quote";
    case "BELOW_INTRINSIC": return "sub-intr.";
    case "ABOVE_UPPER_BOUND": return "over cap";
    case "EXTRINSIC_BELOW_PRICE_RESOLUTION": return "no extr.";
    case "NO_UNDERLYING": return "no spot";
    default: return "—";
  }
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
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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
      const response = await fetch(`${API}/option-chain?${query.toString()}`, { signal });
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
        setError(null);
      } else {
        setError(result.message);
      }
      setLoading(false);
    });
    return () => controller.abort();
  }, [fetchChain]);

  const spreadTone = useCallback((leg: Leg | null) => {
    // A one-sided quote is unknown, not cheap. Rendering it as good would make the most
    // illiquid strikes look the most tradeable, which is the inversion that matters.
    if (!leg || leg.spreadPercentOfMid === null) return "text-slate-500";
    if (leg.withinCostBudget) return "text-emerald-300";
    return leg.spreadPercentOfMid <= DEFAULT_COST_BUDGET_PERCENT * 2
      ? "text-amber-300"
      : "text-rose-300";
  }, []);

  const rows = useMemo(() => chain?.strikes ?? [], [chain]);

  return (
    <div className="space-y-5 p-4 md:p-6">
      <PageHeader
        eyebrow="Derivatives"
        title="Option Chain"
        description="Point-in-time observations: open interest, traded volume, bid–ask spread and the real expiry calendar."
        unavailable={chain !== null && !chain.available}
      />

      <div className="flex flex-wrap items-center gap-2">
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
          {(["quotes", "greeks"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setView(option)}
              className={`rounded-lg px-3 py-1 text-xs font-bold capitalize transition ${
                view === option ? "bg-violet-500/20 text-violet-200" : "text-slate-400 hover:text-slate-200"
              }`}
            >
              {option}
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
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/5 px-4 py-3">
              <p className="text-sm font-bold text-white">
                {chain.underlyingSymbol}
                <span className="ml-2 text-xs font-normal text-slate-400">
                  {chain.expiries?.map((entry) => `${entry.expiryDate} ${entry.expiryKind}`).join(" · ")}
                </span>
              </p>
              <p className="text-xs text-slate-500">
                observed {chain.observedAt?.slice(0, 19).replace("T", " ")} UTC · {chain.provider}
              </p>
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
                      </>
                    )}
                    <th className="px-3 py-2 text-center text-cyan-300">Strike</th>
                    {view === "quotes" ? (
                      <>
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
                    <th colSpan={7} className="px-3 py-1 text-center font-bold text-emerald-300/80">CALLS</th>
                    <th />
                    <th colSpan={7} className="px-3 py-1 text-center font-bold text-rose-300/80">PUTS</th>
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
                          </>
                        )}
                        <td className={`px-3 py-1.5 text-center font-black ${row.isAtm ? "text-cyan-200" : "text-white"}`}>
                          {row.strikePrice}
                        </td>
                        {view === "quotes" ? (
                          <>
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
          </GlassPanel>
        </>
      )}
    </div>
  );
}

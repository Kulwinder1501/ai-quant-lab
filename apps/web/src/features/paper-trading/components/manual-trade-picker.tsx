"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GlassPanel } from "../../../components/ui/glass-panel";
import { errorMessage, isAbortError } from "../../../lib/errors";
import { getApiV1Url } from "../../research/api";
import { formatNumber } from "../../research/presentation";
import { OptionTradeModal } from "../../option-chain/components/option-trade-modal";
import {
  applyChainTick,
  subscribeToChainTicks,
  type ChainResponse,
  type Leg,
  type StrikeRow,
} from "../../option-chain/live-chain";

/** Underlyings the option chain is collected for. Same list the Option Chain page offers. */
const UNDERLYINGS = ["NIFTY50", "BANKNIFTY", "SBIN", "RELIANCE"] as const;

/** Strikes shown either side of the at-the-money strike, unless the whole ladder is asked for. */
const STRIKES_EACH_SIDE = 8;

/**
 * The stored snapshot is re-read this often, but only while the live stream has been silent. While ticks
 * arrive they are the source of truth, and a snapshot is older than the ticks already merged into the chain.
 */
const CHAIN_REFRESH_MS = 15_000;
const STREAM_SILENCE_MS = 30_000;

/** A tick this recent means the chain on screen is live. */
const LIVE_TICK_WINDOW_MS = 15_000;

/** The server refuses a contract quote older than 40 minutes; this warns well before that. */
const STALE_CHAIN_MINUTES = 10;

type LoadResult =
  | { status: "loaded"; chain: ChainResponse }
  | { status: "failed"; message: string }
  | { status: "aborted" };

interface Pick {
  strike: number;
  optionType: "CE" | "PE";
  leg: Leg;
}

interface ManualTradePickerProps {
  show: boolean;
  onClose: () => void;
  /** The account the position will be booked to. Chosen on the page, confirmed again on the ticket. */
  accountId: string;
  accountName: string;
  /** Called after a trade is booked, so the page can refresh its positions. */
  onOpened: () => void;
}

/**
 * A manual entry: choose a contract from the live chain and buy it.
 *
 * The ticket it opens books through POST /paper-trades/open-manual-option, which fills at the observed ask
 * and reads the underlying server-side, so nothing typed here can move the fill. A contract with no ask, or
 * no measured implied volatility, cannot be bought and its button is disabled rather than failing on submit.
 */
export function ManualTradePicker({ show, onClose, accountId, accountName, onOpened }: ManualTradePickerProps) {
  const [underlying, setUnderlying] = useState<string>("NIFTY50");
  const [expiry, setExpiry] = useState<string>("");
  const [chain, setChain] = useState<ChainResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [pick, setPick] = useState<Pick | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [lastTickAt, setLastTickAt] = useState<number | null>(null);
  // Read from timers and event handlers only, never while rendering.
  const lastTickRef = useRef(0);

  const fetchChain = useCallback(async (signal: AbortSignal): Promise<LoadResult> => {
    try {
      const query = new URLSearchParams({ underlying, costBudgetPercent: "1" });
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

  // The stored snapshot: read when the picker opens or the selection changes, and again only while no tick has
  // arrived for a while, so a dead feed does not leave the screen frozen on old prices.
  useEffect(() => {
    if (!show) return;
    let controller = new AbortController();
    const load = () => {
      controller.abort();
      controller = new AbortController();
      void fetchChain(controller.signal).then((result) => {
        if (result.status === "aborted") return;
        if (result.status === "loaded") {
          setChain(result.chain);
          setError(null);
        } else {
          setError(result.message);
        }
        setLoading(false);
      });
    };
    load();
    const timer = window.setInterval(() => {
      if (Date.now() - lastTickRef.current > STREAM_SILENCE_MS) load();
    }, CHAIN_REFRESH_MS);
    return () => {
      window.clearInterval(timer);
      controller.abort();
    };
  }, [show, fetchChain]);

  // The live tick stream, merged into the chain exactly as the Option Chain page does it.
  const chainAvailable = chain?.available === true;
  useEffect(() => {
    if (!show || !chainAvailable) return;
    return subscribeToChainTicks(underlying, (tick) => {
      setChain((prev) => applyChainTick(prev, tick));
      const at = Date.now();
      if (at - lastTickRef.current >= 1000) {
        lastTickRef.current = at;
        setLastTickAt(at);
      }
    });
  }, [show, chainAvailable, underlying]);

  // Drives the "how old" and "is it live" labels between ticks.
  useEffect(() => {
    if (!show) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [show]);

  const changeUnderlying = (value: string) => {
    setUnderlying(value);
    setExpiry("");
    lastTickRef.current = 0;
    setLastTickAt(null);
    setChain(null);
    setLoading(true);
    setError(null);
  };

  const changeExpiry = (value: string) => {
    setExpiry(value);
    setLoading(true);
  };

  const expiries = useMemo(() => chain?.expiries ?? [], [chain]);
  const resolvedExpiry = expiry || expiries[0]?.expiryDate || "";

  const visibleStrikes = useMemo(() => {
    const strikes = chain?.strikes ?? [];
    if (showAll || strikes.length === 0) return strikes;
    const spot = chain?.underlyingValue ?? null;
    let atmIndex = strikes.findIndex((row) => row.isAtm);
    if (atmIndex < 0 && spot !== null) {
      let best = Number.POSITIVE_INFINITY;
      strikes.forEach((row, index) => {
        const distance = Math.abs(row.strikePrice - spot);
        if (distance < best) {
          best = distance;
          atmIndex = index;
        }
      });
    }
    if (atmIndex < 0) return strikes;
    return strikes.slice(Math.max(0, atmIndex - STRIKES_EACH_SIDE), atmIndex + STRIKES_EACH_SIDE + 1);
  }, [chain, showAll]);

  if (!show) return null;

  // The contract the ticket is open on, read from the live chain so its price keeps moving while the ticket is open.
  const liveLeg = pick === null
    ? null
    : (chain?.strikes?.find((row) => row.strikePrice === pick.strike)?.[pick.optionType === "CE" ? "call" : "put"] ?? null);

  const observedAtMs = chain?.observedAt ? Date.parse(chain.observedAt) : Number.NaN;
  const ageMinutes = Number.isFinite(observedAtMs) ? Math.max(0, (now - observedAtMs) / 60_000) : null;
  const stale = ageMinutes !== null && ageMinutes > STALE_CHAIN_MINUTES;
  const live = lastTickAt !== null && now - lastTickAt < LIVE_TICK_WINDOW_MS;
  const botAccount = accountName.toLowerCase().startsWith("autobot");

  const buyButton = (row: StrikeRow, optionType: "CE" | "PE") => {
    const leg = optionType === "CE" ? row.call : row.put;
    const tradable = leg !== null && leg.ask !== null && leg.ask > 0 && leg.impliedVolatility !== null;
    const reason = leg === null || leg.ask === null || leg.ask <= 0
      ? "No ask on this contract."
      : "No measured implied volatility, so the position could not be valued safely.";
    return (
      <button
        type="button"
        disabled={!tradable}
        title={tradable ? undefined : reason}
        onClick={() => leg && setPick({ strike: row.strikePrice, optionType, leg })}
        className="rounded bg-emerald-500/20 px-2 py-0.5 text-[10px] font-bold text-emerald-300 transition hover:bg-emerald-500/40 disabled:cursor-not-allowed disabled:opacity-30"
      >
        BUY
      </button>
    );
  };

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
        <GlassPanel className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden border-cyan-500/30 bg-slate-950 p-5 shadow-2xl sm:p-6">
          <div className="flex shrink-0 items-start justify-between gap-4">
            <div>
              <h3 className="text-xl font-bold text-white">Manual Trade</h3>
              <p className="mt-1 text-xs text-slate-400">
                Buy a contract from the live chain into <span className="font-semibold text-slate-200">{accountName || "the selected account"}</span>.
                Fills at the observed ask; fees are charged as in the live books.
              </p>
            </div>
            <button type="button" onClick={onClose} className="text-xl font-bold leading-none text-slate-400 hover:text-white" aria-label="Close">×</button>
          </div>

          {botAccount && (
            <p className="mt-3 shrink-0 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-200">
              This is a bot account. A manual position here is mixed in with that bot&apos;s trades and can count against its limits.
              Create a separate portfolio for hand-taken trades and pick it as the Active Fund.
            </p>
          )}

          <div className="mt-4 flex shrink-0 flex-wrap items-end gap-3">
            <label className="text-xs font-semibold uppercase text-slate-300">
              Underlying
              <select
                value={underlying}
                onChange={(e) => changeUnderlying(e.target.value)}
                className="mt-1 block rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-400"
              >
                {UNDERLYINGS.map((symbol) => <option key={symbol} value={symbol}>{symbol}</option>)}
              </select>
            </label>
            <label className="text-xs font-semibold uppercase text-slate-300">
              Expiry
              <select
                value={resolvedExpiry}
                onChange={(e) => changeExpiry(e.target.value)}
                disabled={expiries.length === 0}
                className="mt-1 block rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-400 disabled:opacity-50"
              >
                {expiries.map((item) => (
                  <option key={item.expiryDate} value={item.expiryDate}>{item.expiryDate} ({item.expiryKind.toLowerCase()})</option>
                ))}
              </select>
            </label>
            <div className="ml-auto text-right text-xs text-slate-400">
              {chain?.underlyingValue != null && (
                <p>Spot <span className="font-bold text-white">{formatNumber(chain.underlyingValue, 2)}</span></p>
              )}
              {live ? (
                <p className="font-semibold text-emerald-300">● Live — prices streaming</p>
              ) : ageMinutes !== null && (
                <p className={stale ? "text-amber-300" : undefined}>
                  Snapshot {ageMinutes < 1 ? "just now" : `${Math.round(ageMinutes)} min old`}
                  {stale && " — no live ticks (market closed or feed delayed)"}
                </p>
              )}
            </div>
          </div>

          {error && <p className="mt-3 shrink-0 rounded border border-rose-500/20 bg-rose-500/10 p-2 text-xs text-rose-300">{error}</p>}

          <div className="mt-4 min-h-0 flex-1 overflow-auto rounded-xl border border-white/10">
            {loading && !chain ? (
              <p className="p-8 text-center text-sm text-slate-400">Loading the option chain…</p>
            ) : chain && !chain.available ? (
              <p className="p-8 text-center text-sm text-slate-400">{chain.reason || "No option chain is available for this underlying."}</p>
            ) : (
              <table className="w-full border-collapse text-right text-xs">
                <thead className="sticky top-0 bg-slate-900 text-[10px] uppercase tracking-wider text-slate-400">
                  <tr>
                    <th className="px-3 py-2">Call bid</th>
                    <th className="px-3 py-2">Call ask</th>
                    <th className="px-3 py-2" />
                    <th className="px-3 py-2 text-center">Strike</th>
                    <th className="px-3 py-2" />
                    <th className="px-3 py-2">Put ask</th>
                    <th className="px-3 py-2">Put bid</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {visibleStrikes.map((row) => (
                    <tr key={row.strikePrice} className={row.isAtm ? "bg-cyan-500/10" : undefined}>
                      <td className="px-3 py-1.5 text-slate-300">{row.call?.bid ?? "—"}</td>
                      <td className="px-3 py-1.5 font-semibold text-white">{row.call?.ask ?? "—"}</td>
                      <td className="px-3 py-1.5 text-center">{buyButton(row, "CE")}</td>
                      <td className={`px-3 py-1.5 text-center font-black ${row.isAtm ? "text-cyan-200" : "text-white"}`}>{row.strikePrice}</td>
                      <td className="px-3 py-1.5 text-center">{buyButton(row, "PE")}</td>
                      <td className="px-3 py-1.5 font-semibold text-white">{row.put?.ask ?? "—"}</td>
                      <td className="px-3 py-1.5 text-slate-300">{row.put?.bid ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="mt-3 flex shrink-0 items-center justify-between text-xs text-slate-400">
            <button type="button" onClick={() => setShowAll((value) => !value)} className="font-semibold text-cyan-300 hover:text-cyan-200">
              {showAll ? "Show strikes near the money" : "Show every strike"}
            </button>
            <span>Buy only: a paper trade here is a long call or long put.</span>
          </div>
        </GlassPanel>
      </div>

      {pick && (
        <OptionTradeModal
          show={true}
          onClose={() => setPick(null)}
          onOpened={() => {
            onOpened();
            onClose();
          }}
          defaultAccountId={accountId}
          underlyingSymbol={underlying}
          strike={pick.strike}
          optionType={pick.optionType}
          expiryDate={resolvedExpiry}
          premium={pick.leg.ask!}
          impliedVolatility={liveLeg?.impliedVolatility ?? pick.leg.impliedVolatility}
          livePremium={liveLeg ? { bid: liveLeg.bid, ask: liveLeg.ask } : null}
        />
      )}
    </>
  );
}

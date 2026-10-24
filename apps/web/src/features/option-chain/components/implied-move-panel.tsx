"use client";

import React, { useEffect, useMemo, useState } from "react";
import { errorMessage, isAbortError } from "../../../lib/errors";
import { getApiV1Url } from "../../research/api";
import { DEPTH_UNDERLYINGS } from "../depth-ladder-view";
import {
  IMPLIED_MOVE_DEFINITIONS,
  bandText,
  buildImpliedMove,
  compareMoves,
  comparisonSentence,
  impliedMoveNotes,
  type ImpliedMoveInput,
  type RealizedStatsInput,
} from "../implied-move";

interface RealizedPayload {
  available: boolean;
  window: number;
  windowChoices: number[];
  statistics: RealizedStatsInput & { medianAbsCloseToClosePoints: number | null };
  reason: string | null;
}

interface Loaded {
  key: string;
  payload: RealizedPayload | null;
  error: string | null;
}

function points(value: number): string {
  return Math.round(value).toLocaleString("en-IN");
}

function Figure({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-slate-950/40 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className="text-sm font-bold text-white">{value}</p>
      {detail ? <p className="text-[11px] text-slate-500">{detail}</p> : null}
    </div>
  );
}

/**
 * What the ATM options price as a move, next to what the index future has actually moved.
 *
 * Three kinds of number, each labelled where it appears: observed option prices (the straddle), the model reading of the implied
 * volatility (typical daily move, shown as a range over the two day-count conventions because neither is right for every tenor)
 * and observed history (realized close-to-close moves from stored futures bars). The page says what the comparison cannot say.
 */
export function ImpliedMovePanel({
  underlying,
  input,
  expiryLabel,
}: {
  underlying: string;
  input: ImpliedMoveInput;
  expiryLabel: string;
}) {
  const [window, setWindow] = useState<number | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const supported = DEPTH_UNDERLYINGS.includes(underlying);
  const query = new URLSearchParams({ underlying, ...(window !== null ? { window: String(window) } : {}) }).toString();

  useEffect(() => {
    if (!supported) return undefined;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${getApiV1Url()}/realized-moves?${query}`, { signal: controller.signal });
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { error?: string } | null;
          throw new Error(body?.error ?? `Realized moves request failed (${response.status}).`);
        }
        const body = await response.json() as { data: RealizedPayload };
        setLoaded({ key: query, payload: body.data, error: null });
      } catch (caught) {
        if (isAbortError(caught)) return;
        setLoaded({ key: query, payload: null, error: errorMessage(caught, "Realized moves could not be loaded.") });
      }
    })();
    return () => controller.abort();
  }, [query, supported]);

  const payload = loaded?.key === query ? loaded.payload : null;
  const realized = payload?.available ? payload.statistics : null;
  const implied = useMemo(() => buildImpliedMove(input), [input]);
  const comparison = useMemo(() => compareMoves(implied, realized), [implied, realized]);
  const sentence = useMemo(() => comparisonSentence(implied, realized), [implied, realized]);
  // Realized data is only expected once loaded: not while loading, after a failure (its own message), or without futures.
  const loadingNow = supported && (loaded === null || loaded.key !== query);
  const failedNow = loaded?.key === query && loaded.error !== null;
  const notes = useMemo(
    () => impliedMoveNotes(implied, input, realized, supported && !loadingNow && !failedNow),
    [implied, input, realized, supported, loadingNow, failedNow],
  );

  const loading = supported && (loaded === null || loaded.key !== query);
  const failure = loaded?.key === query ? loaded.error : null;

  return (
    <section className="mt-6 w-full border-t border-white/10 pt-4" aria-busy={loading} aria-label="Implied and realized move">
      <h3 className="text-sm font-bold text-white">Implied move vs realized move</h3>
      <p className="mt-1 text-[11px] text-slate-400">
        What the ATM options of {expiryLabel} price as a move, beside how far the future actually moved over recent sessions.
        {input.daysToExpiry !== null ? ` ${input.daysToExpiry.toFixed(1)} calendar days to this expiry.` : ""}
      </p>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <div>
          <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-sky-300">What the options price</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <Figure
              label="ATM straddle (observed)"
              value={implied.straddle ? `${points(implied.straddle.points)} pts · ${implied.straddle.percentOfSpot.toFixed(2)}%` : "–"}
              detail={implied.straddle ? `call ${implied.straddle.callMid.toFixed(2)} + put ${implied.straddle.putMid.toFixed(2)}; breakevens ${points(implied.straddle.lowerBreakeven)}–${points(implied.straddle.upperBreakeven)}` : "needs both legs two-sided"}
            />
            <Figure
              label="Typical move to expiry (model, 1σ)"
              value={implied.oneSigmaToExpiryPoints !== null ? `±${points(implied.oneSigmaToExpiryPoints)} pts` : "–"}
              detail={input.atmIv !== null ? `from ATM IV ${(input.atmIv * 100).toFixed(2)}%` : "no ATM IV"}
            />
            <Figure
              label="Typical day (model, 1σ)"
              value={implied.oneSigmaDailyPoints ? `±${bandText(implied.oneSigmaDailyPoints)} pts` : "–"}
              detail="range over calendar-day and trading-day conventions"
            />
            <Figure
              label="Expected absolute day (model)"
              value={implied.expectedAbsDailyPoints ? `${bandText(implied.expectedAbsDailyPoints)} pts` : "–"}
              detail={implied.expectedAbsDailyPercent ? `${bandText(implied.expectedAbsDailyPercent, (v) => v.toFixed(2))}% of spot, if moves are normal` : undefined}
            />
          </div>
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between gap-2">
            <p className="text-[11px] font-bold uppercase tracking-wide text-emerald-300">What the future did (observed)</p>
            {supported && (
              <label className="flex items-center gap-1 text-[11px] text-slate-400">
                last
                <select
                  value={window ?? payload?.window ?? ""}
                  onChange={(event) => setWindow(Number(event.target.value))}
                  disabled={!payload}
                  className="rounded-lg border border-white/10 bg-slate-950/60 px-1.5 py-0.5 text-[11px] text-slate-200 disabled:opacity-50"
                >
                  {(payload?.windowChoices ?? []).map((count) => <option key={count} value={count}>{count} sessions</option>)}
                </select>
              </label>
            )}
          </div>
          {!supported && <p className="rounded-xl border border-white/10 bg-slate-950/40 p-3 text-[11px] text-slate-400">Realized moves come from the index futures ({DEPTH_UNDERLYINGS.join(" and ")}); {underlying} has none here.</p>}
          {loading && <p className="text-xs text-slate-400">Loading…</p>}
          {failure && <p className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{failure}</p>}
          {supported && payload && !payload.available && <p className="text-[11px] text-slate-400">{payload.reason}</p>}
          {realized && (
            <div className="grid gap-2 sm:grid-cols-2">
              <Figure
                label="Mean close-to-close move"
                value={realized.meanAbsCloseToClosePoints !== null ? `${points(realized.meanAbsCloseToClosePoints)} pts` : "–"}
                detail={realized.meanAbsCloseToClosePercent !== null ? `${realized.meanAbsCloseToClosePercent.toFixed(2)}% of the previous close · ${realized.closeToCloseCount} sessions` : undefined}
              />
              <Figure
                label="Mean intraday range"
                value={realized.meanRangePoints !== null ? `${points(realized.meanRangePoints)} pts` : "–"}
                detail={realized.meanRangePercentOfOpen !== null ? `${realized.meanRangePercentOfOpen.toFixed(2)}% of the open · ${realized.rangeCount} sessions` : undefined}
              />
              <Figure
                label="Realized over implied"
                value={comparison.ratio ? `${bandText(comparison.ratio, (v) => `${v.toFixed(2)}×`)}` : "–"}
                detail="mean absolute move over the expected absolute day"
              />
              <Figure label="Window" value={realized.fromDate && realized.toDate ? `${realized.fromDate} to ${realized.toDate}` : "–"} detail="finished sessions only" />
            </div>
          )}
        </div>
      </div>

      {sentence && <p className="mt-3 text-[11px] text-slate-200">{sentence}</p>}
      {notes.map((note) => (
        <p key={note.text} className={`mt-1 text-[11px] ${note.tone === "warn" ? "text-amber-200" : "text-slate-500"}`}>{note.text}</p>
      ))}

      <details className="mt-3 text-[11px] text-slate-400">
        <summary className="cursor-pointer text-slate-300">Definitions and what this cannot say</summary>
        <dl className="mt-2 space-y-1">
          {Object.entries(IMPLIED_MOVE_DEFINITIONS).map(([name, text]) => (
            <div key={name}><dt className="inline font-bold text-slate-300">{name}: </dt><dd className="inline">{text}</dd></div>
          ))}
        </dl>
      </details>
      <p className="mt-2 text-[11px] text-slate-500">
        Observation, not a signal: realized below implied is the usual case and is not by itself a reason to sell options, nor the reverse a reason to buy them.
      </p>
    </section>
  );
}

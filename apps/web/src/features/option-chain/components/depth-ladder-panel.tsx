"use client";

import React, { useEffect, useMemo, useState } from "react";
import { errorMessage, isAbortError } from "../../../lib/errors";
import { getApiV1Url } from "../../research/api";
import {
  bookAgeSeconds,
  buildLadderRows,
  coverageSentence,
  DEFAULT_VISIBLE_LEVELS,
  DEPTH_UNDERLYINGS,
  describeImbalance,
  effectiveStatus,
  presentStatus,
  topLevels,
  type DepthAvailable,
  type DepthPayload,
} from "../depth-ladder-view";
import { formatIstClock } from "../depth-history-view";

/** The API is read-only and the query is an index walk (about 0.2 ms), so a two second poll is cheap. */
const POLL_MS = 2_000;

interface Fetched {
  /** What the payload was fetched for ("live", or the requested instant), so a slow answer is never shown for another. */
  key: string | null;
  payload: DepthPayload | null;
  fetchedAtMs: number | null;
  /** The last refresh failure, kept beside the last good payload so a silent API never reads as a live book. */
  error: string | null;
}

const TONE_CLASS: Record<"ok" | "warn" | "idle", string> = {
  ok: "border-emerald-400/40 bg-emerald-500/10 text-emerald-200",
  warn: "border-amber-400/40 bg-amber-500/10 text-amber-100",
  idle: "border-slate-500/40 bg-slate-800/60 text-slate-300",
};

function formatPrice(value: number | null): string {
  return value === null ? "—" : value.toFixed(2);
}

function formatQty(value: number): string {
  return value.toLocaleString("en-IN");
}

function ImbalanceRow({ label, value, hint }: { label: string; value: number | null; hint: string }) {
  const described = describeImbalance(value);
  const width = value === null ? 0 : Math.min(100, Math.abs(value) * 100) / 2;
  return (
    <div className="grid grid-cols-[7.5rem_3.5rem_5.5rem_1fr] items-center gap-2 text-xs" title={hint}>
      <span className="text-slate-300">{label}</span>
      <span className="font-mono text-slate-100">{described.text}</span>
      <span className="text-slate-400">{described.word}</span>
      {/* Centre-anchored: ask-heavy grows left, bid-heavy grows right. The word beside it carries the meaning. */}
      <div className="relative h-2 rounded bg-slate-800" aria-hidden="true">
        <div className="absolute inset-y-0 left-1/2 w-px bg-slate-500" />
        {value !== null && value !== 0 && (
          <div
            className={`absolute inset-y-0 rounded ${value > 0 ? "left-1/2 bg-emerald-400/70" : "right-1/2 bg-rose-400/70"}`}
            style={{ width: `${width}%` }}
          />
        )}
      </div>
    </div>
  );
}

function LadderBook({ data, nowMs, fetchedAtMs }: { data: DepthAvailable; nowMs: number; fetchedAtMs: number }) {
  const { ladder, contract } = data;
  const age = bookAgeSeconds(ladder.ageSeconds, fetchedAtMs, nowMs);
  const status = presentStatus(effectiveStatus(ladder.status, age));
  const [showAll, setShowAll] = useState(false);
  const deeperThanDefault = ladder.bids.length > DEFAULT_VISIBLE_LEVELS || ladder.asks.length > DEFAULT_VISIBLE_LEVELS;
  const rows = useMemo(
    () => buildLadderRows(showAll ? ladder : topLevels(ladder, DEFAULT_VISIBLE_LEVELS), contract.lotSize),
    [ladder, contract.lotSize, showAll],
  );

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className={`rounded-lg border px-2 py-0.5 font-bold ${TONE_CLASS[status.tone]}`} title={status.detail}>
          {status.label}
        </span>
        <span className="font-semibold text-white">{contract.providerSymbol.replace("NSE:", "")}</span>
        <span className="text-slate-400">expiry {contract.expiryDate} · lot {contract.lotSize}</span>
        <span className="text-slate-300">
          book received <span className="font-mono text-slate-100">{formatIstClock(Date.parse(ladder.receivedAt))}</span> IST
          {data.requestedAsOf !== null ? (
            // A past instant: an age measured from now would only say how long ago the day was.
            <span className="ml-2 text-slate-400">(last book at or before {formatIstClock(Date.parse(data.requestedAsOf))})</span>
          ) : (
            <span className={status.tone === "warn" ? "ml-2 font-bold text-amber-200" : "ml-2 text-slate-400"}>
              ({age < 60 ? `${age.toFixed(0)}s` : `${(age / 60).toFixed(1)}m`} old)
            </span>
          )}
        </span>
      </div>
      <p className="mb-3 text-[11px] text-slate-500">{status.detail}</p>

      {ladder.issues.length > 0 && (
        <div className="mb-3 rounded-lg border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
          {ladder.issues.map((issue) => <p key={issue}>{issue}</p>)}
        </div>
      )}

      <div className="mb-3 rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 text-[11px] text-slate-400">
        {coverageSentence(ladder.coverage)} Resting quantity is not traded quantity, and a large order here can be
        withdrawn before it trades.
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <div className="mb-3 grid grid-cols-4 gap-2 text-xs">
            <div><p className="text-slate-500">Best bid</p><p className="font-mono text-sm text-slate-100">{formatPrice(ladder.bestBid)}</p></div>
            <div><p className="text-slate-500">Best ask</p><p className="font-mono text-sm text-slate-100">{formatPrice(ladder.bestAsk)}</p></div>
            <div><p className="text-slate-500">Mid</p><p className="font-mono text-sm text-slate-100">{formatPrice(ladder.mid)}</p></div>
            <div>
              <p className="text-slate-500">Spread</p>
              <p className="font-mono text-sm text-slate-100">
                {ladder.spread === null ? "—" : `${ladder.spread.points.toFixed(1)} pts`}
              </p>
              <p className="text-[10px] text-slate-500">
                {ladder.spread === null ? "" : `${ladder.spread.basisPoints.toFixed(1)} bps of mid`}
              </p>
            </div>
          </div>

          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Imbalance (bid − ask) / (bid + ask)
          </p>
          <div className="space-y-1.5">
            <ImbalanceRow label="Top 1 level" value={ladder.imbalance.topOfBook.l1} hint={data.definitions.topOfBook ?? ""} />
            <ImbalanceRow label="Top 3 levels" value={ladder.imbalance.topOfBook.l3} hint={data.definitions.topOfBook ?? ""} />
            <ImbalanceRow label="Top 5 levels" value={ladder.imbalance.topOfBook.l5} hint={data.definitions.topOfBook ?? ""} />
            <ImbalanceRow label="Top 10 levels" value={ladder.imbalance.topOfBook.l10} hint={data.definitions.topOfBook ?? ""} />
            <ImbalanceRow label="Rank-weighted" value={ladder.imbalance.rankWeighted} hint={data.definitions.rankWeighted ?? ""} />
            <div className="my-1 border-t border-white/10" />
            <ImbalanceRow label="Whole book" value={ladder.imbalance.wholeBook} hint={data.definitions.wholeBook ?? ""} />
          </div>
          <p className="mt-2 text-[11px] text-slate-500">
            The first five rows describe only the stored top of the book. &quot;Whole book&quot; comes from the feed&apos;s own
            totals ({ladder.coverage.wholeBookTotals.bid === null ? "n/a" : formatQty(ladder.coverage.wholeBookTotals.bid)} bid vs{" "}
            {ladder.coverage.wholeBookTotals.ask === null ? "n/a" : formatQty(ladder.coverage.wholeBookTotals.ask)} ask units)
            and covers more of the book than the stored levels do. A positive value describes resting liquidity; it does not predict price.
          </p>
        </div>

        <div>
          <div className="grid grid-cols-[3rem_2.5rem_1fr_4.5rem_5rem] gap-x-2 border-b border-white/10 pb-1 text-[10px] uppercase tracking-wider text-slate-500">
            <span>Side</span><span className="text-right">Ord</span><span>Qty (units · lots)</span><span className="text-right">Cum</span><span className="text-right">Price</span>
          </div>
          <div className="text-xs">
            {rows.map((row, index) => (
              <React.Fragment key={`${row.side}-${row.level}`}>
                {row.side === "bid" && rows[index - 1]?.side === "ask" && (
                  <div className="my-1 border-y border-white/10 py-0.5 text-center text-[10px] text-slate-400">
                    {ladder.spread === null ? "spread unavailable" : `spread ${ladder.spread.points.toFixed(1)} pts`}
                  </div>
                )}
                <div className="grid grid-cols-[3rem_2.5rem_1fr_4.5rem_5rem] items-center gap-x-2 py-px">
                  <span className={row.side === "ask" ? "text-rose-300" : "text-emerald-300"}>
                    {row.side === "ask" ? "ASK" : "BID"} {row.level}
                  </span>
                  <span className="text-right font-mono text-slate-500">{row.orders ?? "—"}</span>
                  <div className="relative h-5">
                    <div
                      className={`absolute inset-y-0 left-0 rounded-sm ${row.side === "ask" ? "bg-rose-500/25" : "bg-emerald-500/25"}`}
                      style={{ width: `${row.barFraction * 100}%` }}
                      aria-hidden="true"
                    />
                    <span className="relative z-10 pl-1 font-mono text-slate-100">
                      {formatQty(row.qty)}
                      {row.lots !== null && <span className="ml-1 text-slate-500">· {row.lots.toFixed(1)}</span>}
                    </span>
                  </div>
                  <span className="text-right font-mono text-slate-400">{formatQty(row.cumulativeQty)}</span>
                  <span className="text-right font-mono text-slate-100">{row.price.toFixed(2)}</span>
                </div>
              </React.Fragment>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-slate-500">
            Bars compare levels within this one book; the number beside each is the quantity. Units are contracts
            × lot size, not lots (lots shown after the dot).
          </p>
          {deeperThanDefault && (
            <button
              type="button"
              onClick={() => setShowAll((current) => !current)}
              aria-pressed={showAll}
              className="mt-2 rounded-lg border border-white/10 bg-slate-950/60 px-2 py-1 text-xs font-bold text-slate-200"
            >
              {showAll
                ? `Show the top ${DEFAULT_VISIBLE_LEVELS} levels`
                : `Show all ${Math.max(ladder.bids.length, ladder.asks.length)} stored levels`}
            </button>
          )}
        </div>
      </div>

      <details className="mt-3 text-[11px] text-slate-500">
        <summary className="cursor-pointer text-slate-400">Definitions and provenance</summary>
        <ul className="mt-1 space-y-1">
          {Object.entries(data.definitions).map(([key, text]) => <li key={key}>{text}</li>)}
          <li>
            Frame sequence {ladder.provenance.sequenceNo ?? "n/a"}
            {ladder.provenance.gapBefore ? `, ${ladder.provenance.gapBefore} sequence numbers skipped just before it` : ""}
            {ladder.provenance.isDuplicate ? ", flagged as a repeat of the previous frame" : ""}
            {ladder.provenance.isSnapshot ? ", a full snapshot rather than an update" : ""}. The feed clock is whole
            seconds; the received time is our own millisecond clock.
          </li>
          <li>{data.source}</li>
        </ul>
      </details>
    </>
  );
}

/**
 * The stored order book for an index future as a ladder, with spread and imbalance.
 *
 * Polls the API's stored frames, never the broker: the depth collector already holds the feed's single
 * tick-by-tick slot, so this reads what it wrote. Shows how old the book is, counting the time since the last
 * successful refresh, so a stalled collector or an unreachable API cannot pass for a live market.
 */
export function DepthLadderPanel({ underlying, nowMs, asOf }: { underlying: string; nowMs: number; asOf?: string }) {
  const supported = DEPTH_UNDERLYINGS.includes(underlying);
  const key = asOf ?? "live";
  const [fetched, setFetched] = useState<Fetched>({ key: null, payload: null, fetchedAtMs: null, error: null });

  useEffect(() => {
    if (!supported) return;
    const controller = new AbortController();
    let inFlight = false;

    const load = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      try {
        const asOfParam = asOf ? `&asOf=${encodeURIComponent(asOf)}` : "";
        const response = await fetch(`${getApiV1Url()}/depth/ladder?underlying=${encodeURIComponent(underlying)}${asOfParam}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { error?: string } | null;
          throw new Error(body?.error ?? `Depth request failed (${response.status}).`);
        }
        const body = await response.json() as { data: DepthPayload };
        setFetched({ key, payload: body.data, fetchedAtMs: Date.now(), error: null });
      } catch (caught) {
        if (isAbortError(caught)) return;
        setFetched((previous) => ({
          ...(previous.key === key ? previous : { key, payload: null, fetchedAtMs: null }),
          error: errorMessage(caught, "The depth ladder could not be refreshed."),
        }));
      } finally {
        inFlight = false;
      }
    };

    void load();
    // A past instant cannot change: fetch it once. Only the live book is polled.
    const timer = asOf ? null : window.setInterval(() => void load(), POLL_MS);
    return () => {
      controller.abort();
      if (timer !== null) window.clearInterval(timer);
    };
  }, [underlying, supported, asOf, key]);

  if (!supported) {
    return (
      <div className="rounded-xl border border-white/10 bg-slate-950/40 p-6 text-sm text-slate-400">
        Order-book depth is captured for the index futures (NIFTY50, BANKNIFTY) only, not for {underlying}.
      </div>
    );
  }

  // An answer fetched for another instant (a slow reply after the page moved on) is never shown for this one.
  const current = fetched.key === key;
  const payload = current ? fetched.payload : null;
  const fetchedAtMs = current ? fetched.fetchedAtMs : null;
  const error = current ? fetched.error : null;
  return (
    <div className="w-full" aria-live="off">
      {error && (
        <p className="mb-3 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          Could not refresh the book ({error}).{" "}
          {payload?.available && fetchedAtMs !== null
            ? "The book below is the last one received and keeps ageing."
            : "Nothing has been received yet."}
        </p>
      )}
      {payload === null && !error && <p className="text-xs text-slate-400">Loading…</p>}
      {payload && !payload.available && (
        <div className="rounded-xl border border-white/10 bg-slate-950/40 p-6 text-sm text-slate-300">
          {payload.reason}
        </div>
      )}
      {payload?.available && fetchedAtMs !== null && (
        <LadderBook data={payload} nowMs={nowMs} fetchedAtMs={fetchedAtMs} />
      )}
    </div>
  );
}

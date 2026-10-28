"use client";

import React, { useEffect, useMemo, useState } from "react";
import { errorMessage, isAbortError } from "../../../lib/errors";
import { getApiV1Url } from "../../research/api";
import { DEPTH_UNDERLYINGS } from "../depth-ladder-view";
import { dataAgeSeconds } from "../depth-history-view";
import {
  buildSplitBars,
  liveSideSplitQuery,
  splitHeadline,
  totalsText,
  type LiveSideSplitPayload,
} from "../live-side-split-view";

/** The count lives in the server's memory, so asking is cheap and costs no broker request. */
const REFRESH_MS = 10_000;

const BUY_COLOR = "#34d399";
const SELL_COLOR = "#fb7185";
const UNKNOWN_COLOR = "rgba(148,163,184,0.55)";

interface Loaded {
  key: string;
  payload: LiveSideSplitPayload | null;
  fetchedAtMs: number | null;
  error: string | null;
}

/**
 * TODAY's volume at price split by the side of the quote the last price sat on, ESTIMATED live from the server's own
 * ticks and never stored. It has no history and no other date. It says what it is above the bars (the wording comes from
 * the API), and the share of volume that has no side is drawn as its own part of every bar.
 */
export function LiveSideSplitPanel({ underlying, nowMs }: { underlying: string; nowMs: number }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const supported = DEPTH_UNDERLYINGS.includes(underlying);
  const query = liveSideSplitQuery({ underlying, rowPoints: null });

  useEffect(() => {
    if (!supported) return undefined;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${getApiV1Url()}/volume-profile/live-side-split?${query}`, { signal: controller.signal });
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { error?: string } | null;
          throw new Error(body?.error ?? `The live split could not be read (HTTP ${response.status}).`);
        }
        const body = await response.json() as { data: LiveSideSplitPayload };
        setLoaded({ key: query, payload: body.data, fetchedAtMs: Date.now(), error: null });
      } catch (error) {
        if (isAbortError(error)) return;
        const message = errorMessage(error, "The live split could not be loaded.");
        // A failed refresh keeps the last good numbers on screen, with the failure and their age stated.
        setLoaded((previous) => (previous?.key === query
          ? { ...previous, error: message }
          : { key: query, payload: null, fetchedAtMs: null, error: message }));
      }
    })();
    return () => controller.abort();
  }, [query, refreshTick, supported]);

  useEffect(() => {
    if (!supported) return undefined;
    const timer = setInterval(() => setRefreshTick((tick) => tick + 1), REFRESH_MS);
    return () => clearInterval(timer);
  }, [supported]);

  const payload = loaded?.key === query ? loaded.payload : null;
  const available = payload !== null && payload.available ? payload : null;
  const bars = useMemo(() => (available ? buildSplitBars(available) : []), [available]);
  const failure = loaded?.key === query ? loaded.error : null;
  const ageSeconds = loaded?.key === query && loaded.fetchedAtMs ? dataAgeSeconds(loaded.fetchedAtMs, nowMs) : null;

  if (!supported) return null;

  return (
    <section className="mt-6 w-full" aria-label="Live buy and sell split of today's volume at price (estimate)">
      <h3 className="mb-1 text-sm font-semibold text-slate-200">
        Live buy / sell split at price <span className="ml-1 rounded border border-amber-300/40 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-200">estimate</span>
      </h3>
      <p className="mb-2 text-[11px] text-slate-500">Today only, counted live in the server&apos;s memory, never stored.</p>

      {loaded === null && <p className="mb-2 text-xs text-slate-400">Loading…</p>}
      {failure && (
        <p className="mb-2 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          {failure}{available && ageSeconds !== null ? ` Showing the numbers fetched ${ageSeconds} s ago.` : ""}
        </p>
      )}
      {payload && !payload.available && (
        <>
          <p className="mb-2 rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2 text-xs text-slate-300">{payload.reason}</p>
          {payload.definitions && <p className="mb-1 text-[11px] text-slate-500">{payload.definitions.estimate}</p>}
        </>
      )}

      {available && (
        <>
          <p className="mb-1 text-[11px] text-slate-400">
            {splitHeadline(available)}
            {ageSeconds !== null ? ` · fetched ${ageSeconds} s ago, refreshed every ${REFRESH_MS / 1000} s` : ""}
          </p>
          <p className="mb-1 text-[11px] text-slate-400">{totalsText(available)}</p>
          {[available.definitions.estimate, available.definitions.placement, available.definitions.sideRule, available.definitions.scope].map((text) => (
            <p key={text} className="mb-1 text-[11px] text-slate-500">{text}</p>
          ))}

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-400" aria-label="Legend">
            <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: BUY_COLOR }} aria-hidden="true" />at or above the ask (buy guess)</span>
            <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: SELL_COLOR }} aria-hidden="true" />at or below the bid (sell guess)</span>
            <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: UNKNOWN_COLOR }} aria-hidden="true" />side unknown</span>
          </div>

          <ul className="mt-2 max-h-[420px] space-y-px overflow-y-auto pr-1" aria-label="Rows, highest price first">
            {bars.map((bar) => (
              <li
                key={bar.key}
                className="grid grid-cols-[7.5rem_1fr_4.5rem] items-center gap-2 text-[11px] text-slate-300"
                title={`${bar.label}: buy ${bar.buyPct.toFixed(0)}% · sell ${bar.sellPct.toFixed(0)}% · unknown ${bar.unknownPct.toFixed(0)}% of ${bar.total.toLocaleString("en-IN")} units`}
              >
                <span className="font-mono text-slate-400">{bar.label}</span>
                <span className="block h-3">
                  <span className="flex h-3 overflow-hidden rounded-sm" style={{ width: `${Math.max(bar.lengthPct, 1)}%` }}>
                    <span style={{ width: `${bar.buyPct}%`, background: BUY_COLOR }} />
                    <span style={{ width: `${bar.sellPct}%`, background: SELL_COLOR }} />
                    <span style={{ width: `${bar.unknownPct}%`, background: UNKNOWN_COLOR }} />
                  </span>
                </span>
                <span className="text-right font-mono text-slate-400">{bar.total.toLocaleString("en-IN")}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

"use client";

import React, { useEffect, useMemo, useState } from "react";
import { errorMessage, isAbortError } from "../../../lib/errors";
import { getApiV1Url } from "../../research/api";
import type { ChainResponse } from "../live-chain";
import { formatDifference, summariseAgreement } from "../vendor-greeks-check";
import {
  VENDOR_HISTORY_DEFINITIONS,
  buildHistory,
  driftSentence,
  stateText,
  toGreeksStrikes,
  type SessionAgreement,
} from "../vendor-greeks-history";

interface SessionsPayload {
  sessions: Array<{ sessionDate: string; observedAt: string }>;
  days: number;
  dayChoices: number[];
}

interface Loaded {
  key: string;
  sessions: SessionAgreement[] | null;
  dayChoices: number[];
  error: string | null;
}

/** Chains are read a few at a time so ten sessions do not open ten requests at once. */
const CONCURRENCY = 3;

async function readJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed (${response.status}).`);
  }
  return (await response.json() as { data: T }).data;
}

/**
 * The model-against-Fyers gap session by session, from each session's last in-session chain snapshot. The chain is read as of that
 * snapshot (`asOf`), the comparison of `vendor-greeks-check.ts` is run on it, and the days are set side by side. Stored data only.
 */
export function VendorGreeksHistoryView({ underlying }: { underlying: string }) {
  const [days, setDays] = useState<number | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const key = `${underlying}|${days ?? "default"}`;

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const params = new URLSearchParams({ underlying, ...(days !== null ? { days: String(days) } : {}) });
        const listing = await readJson<SessionsPayload>(`${getApiV1Url()}/option-chain/session-snapshots?${params.toString()}`, controller.signal);
        const results: SessionAgreement[] = new Array(listing.sessions.length);
        let next = 0;
        const worker = async () => {
          while (next < listing.sessions.length) {
            const index = next;
            next += 1;
            const session = listing.sessions[index]!;
            try {
              const chainParams = new URLSearchParams({ underlying, asOf: session.observedAt });
              const chain = await readJson<ChainResponse>(`${getApiV1Url()}/option-chain?${chainParams.toString()}`, controller.signal);
              results[index] = chain.available === false || !chain.strikes
                ? { ...session, summary: null, error: chain.reason ?? "No chain is stored." }
                : { ...session, summary: summariseAgreement(toGreeksStrikes(chain.strikes)), error: null };
            } catch (caught) {
              if (isAbortError(caught)) throw caught;
              results[index] = { ...session, summary: null, error: errorMessage(caught, "The chain could not be read.") };
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, listing.sessions.length) }, worker));
        setLoaded({ key, sessions: results, dayChoices: listing.dayChoices, error: null });
      } catch (caught) {
        if (isAbortError(caught)) return;
        setLoaded({ key, sessions: null, dayChoices: [], error: errorMessage(caught, "The sessions could not be listed.") });
      }
    })();
    return () => controller.abort();
  }, [underlying, days, key]);

  const current = loaded?.key === key ? loaded : null;
  const rows = useMemo(() => (current?.sessions ? buildHistory(current.sessions) : []), [current]);
  const anyCompared = rows.some((row) => row.state === "compared");

  return (
    <section className="mt-6 w-full border-t border-white/10 pt-4" aria-busy={current === null} aria-label="Model against Fyers Greeks by session">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-white">The same comparison, session by session</h3>
        {current && current.dayChoices.length > 0 && (
          <label className="flex items-center gap-1 text-[11px] text-slate-400">
            last
            <select
              value={days ?? rows.length}
              onChange={(event) => setDays(Number(event.target.value))}
              className="rounded-lg border border-white/10 bg-slate-950/60 px-1.5 py-0.5 text-[11px] text-slate-200"
            >
              {current.dayChoices.map((count) => <option key={count} value={count}>{count} sessions</option>)}
            </select>
          </label>
        )}
      </div>
      <p className="mt-1 text-[11px] text-slate-400">
        Each row is the last in-session chain snapshot of a trading session. Fyers&apos; value minus the model&apos;s, in volatility points for IV.
      </p>

      {current === null && <p className="mt-2 text-xs text-slate-400">Loading…</p>}
      {current?.error && <p className="mt-2 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{current.error}</p>}
      {current?.sessions && rows.length === 0 && <p className="mt-2 text-[11px] text-slate-400">No in-session chain snapshot is stored for this underlying.</p>}

      {rows.length > 0 && (
        <>
          <p className="mt-2 text-[11px] text-slate-200">{driftSentence(rows)}</p>
          <div className="mt-2 overflow-x-auto rounded-xl border border-white/10">
            <table className="w-full min-w-[560px] text-left text-[11px] text-slate-300">
              <thead className="bg-slate-950 text-[10px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-2 py-1.5 font-normal">Session</th>
                  <th className="px-2 py-1.5 text-right font-normal">IV bias</th>
                  <th className="px-2 py-1.5 text-right font-normal">IV worst</th>
                  <th className="px-2 py-1.5 text-right font-normal">Delta bias</th>
                  <th className="px-2 py-1.5 font-normal">Stored</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.sessionDate} className="border-t border-white/5">
                    <td className="px-2 py-1 font-bold text-white">{row.sessionDate}</td>
                    <td className="px-2 py-1 text-right">{row.iv ? formatDifference("iv", row.iv.bias) : "–"}</td>
                    <td className="px-2 py-1 text-right">{row.iv?.worst ? formatDifference("iv", row.iv.worst.difference) : "–"}</td>
                    <td className="px-2 py-1 text-right">{row.delta ? formatDifference("delta", row.delta.bias) : "–"}</td>
                    <td className="px-2 py-1 text-slate-400">{stateText(row)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!anyCompared && (
            <p className="mt-1 text-[11px] text-slate-500">None of these sessions has provider Greeks yet, so there is no gap to show. They are stored by the chain runs of the deployed collector, from its first weekday session.</p>
          )}
        </>
      )}

      <details className="mt-3 text-[11px] text-slate-400">
        <summary className="cursor-pointer text-slate-300">What the history is, and is not</summary>
        <dl className="mt-2 space-y-1">
          {Object.entries(VENDOR_HISTORY_DEFINITIONS).map(([name, text]) => (
            <div key={name}><dt className="inline font-bold text-slate-300">{name}: </dt><dd className="inline">{text}</dd></div>
          ))}
        </dl>
      </details>
    </section>
  );
}

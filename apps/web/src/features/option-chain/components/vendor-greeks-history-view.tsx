"use client";

import React, { useMemo } from "react";
import { formatDifference, summariseAgreement } from "../vendor-greeks-check";
import {
  VENDOR_HISTORY_DEFINITIONS,
  buildHistory,
  driftSentence,
  stateText,
  toGreeksStrikes,
  type SessionAgreement,
} from "../vendor-greeks-history";
import type { SessionChain } from "../use-session-chains";

/**
 * The model-against-Fyers gap session by session, from each session's last in-session chain snapshot (read by `SessionHistorySection`).
 * The comparison of `vendor-greeks-check.ts` is run on each chain and the days are set side by side. Stored data only.
 */
export function VendorGreeksHistoryView({ sessions }: { sessions: readonly SessionChain[] }) {
  const rows = useMemo(() => {
    const agreements: SessionAgreement[] = sessions.map((session) => ({
      sessionDate: session.sessionDate,
      observedAt: session.observedAt,
      summary: session.chain?.strikes ? summariseAgreement(toGreeksStrikes(session.chain.strikes)) : null,
      error: session.error,
    }));
    return buildHistory(agreements);
  }, [sessions]);
  const anyCompared = rows.some((row) => row.state === "compared");

  return (
    <section className="mt-4" aria-label="Model against Fyers Greeks by session">
      <h4 className="text-sm font-bold text-white">Model against Fyers Greeks</h4>
      <p className="mt-1 text-[11px] text-slate-400">Fyers&apos; value minus the model&apos;s, in volatility points for IV.</p>

      {rows.length === 0 && <p className="mt-2 text-[11px] text-slate-400">No in-session chain snapshot is stored for this underlying.</p>}

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

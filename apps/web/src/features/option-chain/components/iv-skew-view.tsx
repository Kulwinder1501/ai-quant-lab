"use client";

import React, { useMemo } from "react";
import type { GreeksStrikeInput } from "../build-greeks-by-strike";
import {
  IV_SKEW_DEFINITIONS,
  buildSkew,
  formatIv,
  formatPoints,
  historySentence,
  skewSentence,
  type IvAtDelta,
  type SessionSkew,
} from "../iv-skew";
import { toGreeksStrikes } from "../vendor-greeks-history";
import type { SessionChain } from "../use-session-chains";

const between = (value: IvAtDelta) => (value.between === null ? "" : value.between[0] === value.between[1] ? `at ${value.between[0]}` : `between ${value.between[0]} and ${value.between[1]}`);

function Definitions() {
  return (
    <details className="mt-3 text-[11px] text-slate-400">
      <summary className="cursor-pointer text-slate-300">What the skew is, and is not</summary>
      <dl className="mt-2 space-y-1">
        {Object.entries(IV_SKEW_DEFINITIONS).map(([name, text]) => (
          <div key={name}><dt className="inline font-bold text-slate-300">{name}: </dt><dd className="inline">{text}</dd></div>
        ))}
      </dl>
    </details>
  );
}

/** The 25-delta skew of the stored snapshot: the three IVs it is read from, the risk reversal and the butterfly. Model values. */
export function IvSkewView({ strikes }: { strikes: readonly GreeksStrikeInput[] }) {
  const skew = useMemo(() => buildSkew(strikes), [strikes]);
  const rows: Array<{ label: string; value: IvAtDelta }> = [
    { label: "25-delta put", value: skew.put25 },
    { label: "50-delta (at the money)", value: skew.middle },
    { label: "25-delta call", value: skew.call25 },
  ];

  return (
    <section className="mt-6 w-full border-t border-white/10 pt-4" aria-label="Implied volatility skew">
      <h3 className="text-sm font-bold text-white">The smile in three numbers</h3>
      <p className="mt-1 text-[11px] text-slate-200">{skewSentence(skew)}</p>
      <div className="mt-2 grid grid-cols-2 gap-2 xl:grid-cols-5">
        {rows.map((row) => (
          <div key={row.label} className="rounded-xl border border-white/10 bg-slate-950/40 px-2 py-1.5">
            <p className="text-[10px] uppercase tracking-wide text-slate-500">{row.label}</p>
            <p className="text-sm font-bold text-white">{formatIv(row.value.iv)}</p>
            <p className="text-[10px] text-slate-500">{row.value.iv === null ? "not found" : between(row.value)}</p>
          </div>
        ))}
        <div className="rounded-xl border border-white/10 bg-slate-950/40 px-2 py-1.5">
          <p className="text-[10px] uppercase tracking-wide text-slate-500">Risk reversal</p>
          <p className="text-sm font-bold text-white">{formatPoints(skew.riskReversal)}</p>
          <p className="text-[10px] text-slate-500">call minus put, points</p>
        </div>
        <div className="rounded-xl border border-white/10 bg-slate-950/40 px-2 py-1.5">
          <p className="text-[10px] uppercase tracking-wide text-slate-500">Butterfly</p>
          <p className="text-sm font-bold text-white">{formatPoints(skew.butterfly)}</p>
          <p className="text-[10px] text-slate-500">wings minus middle, points</p>
        </div>
      </div>
      {[skew.put25, skew.call25, skew.middle].filter((value) => value.refusal !== null).map((value) => (
        <p key={value.refusal} className="mt-1 text-[11px] text-slate-500">{value.refusal}</p>
      ))}
      <p className="mt-1 text-[10px] text-slate-500">Model values (Black-Scholes at each contract&apos;s own solved IV), in volatility points.</p>
      <Definitions />
    </section>
  );
}

/** The risk reversal and butterfly at the last in-session snapshot of each session, set side by side. */
export function IvSkewHistoryView({ sessions }: { sessions: readonly SessionChain[] }) {
  const rows = useMemo<SessionSkew[]>(() => sessions.map((session) => ({
    sessionDate: session.sessionDate,
    observedAt: session.observedAt,
    skew: session.chain?.strikes ? buildSkew(toGreeksStrikes(session.chain.strikes)) : null,
    error: session.error,
  })), [sessions]);

  return (
    <section className="mt-4" aria-label="Implied volatility skew by session">
      <h4 className="text-sm font-bold text-white">Smile skew</h4>
      <p className="mt-1 text-[11px] text-slate-400">Call minus put IV at 25 delta, and wings minus middle, in volatility points.</p>
      {rows.length === 0 && <p className="mt-2 text-[11px] text-slate-400">No in-session chain snapshot is stored for this underlying.</p>}
      {rows.length > 0 && (
        <>
          <p className="mt-2 text-[11px] text-slate-200">{historySentence(rows)}</p>
          <div className="mt-2 overflow-x-auto rounded-xl border border-white/10">
            <table className="w-full min-w-[480px] text-left text-[11px] text-slate-300">
              <thead className="bg-slate-950 text-[10px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-2 py-1.5 font-normal">Session</th>
                  <th className="px-2 py-1.5 text-right font-normal">25Δ put IV</th>
                  <th className="px-2 py-1.5 text-right font-normal">25Δ call IV</th>
                  <th className="px-2 py-1.5 text-right font-normal">Risk reversal</th>
                  <th className="px-2 py-1.5 text-right font-normal">Butterfly</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.sessionDate} className="border-t border-white/5">
                    <td className="px-2 py-1 font-bold text-white">{row.sessionDate}</td>
                    {row.skew === null ? (
                      <td className="px-2 py-1 text-slate-400" colSpan={4}>chain could not be read</td>
                    ) : (
                      <>
                        <td className="px-2 py-1 text-right">{formatIv(row.skew.put25.iv)}</td>
                        <td className="px-2 py-1 text-right">{formatIv(row.skew.call25.iv)}</td>
                        <td className="px-2 py-1 text-right">{formatPoints(row.skew.riskReversal)}</td>
                        <td className="px-2 py-1 text-right">{formatPoints(row.skew.butterfly)}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-[10px] text-slate-500">A dash means the value could not be found for that session (the 25-delta contracts were not bracketed by solved contracts).</p>
        </>
      )}
    </section>
  );
}

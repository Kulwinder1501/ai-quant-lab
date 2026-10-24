"use client";

import React from "react";
import { useSessionChains } from "../use-session-chains";
import { IvSkewHistoryView } from "./iv-skew-view";
import { VendorGreeksHistoryView } from "./vendor-greeks-history-view";

/**
 * The comparisons that set trading sessions side by side. They share one read of the stored chains (the last in-session snapshot of each
 * of the newest sessions), so the chains are fetched once however many views use them. Stored data only.
 */
export function SessionHistorySection({ underlying }: { underlying: string }) {
  const { days, setDays, current } = useSessionChains(underlying);

  return (
    <section className="mt-6 w-full border-t border-white/10 pt-4" aria-busy={current === null} aria-label="Session by session">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-white">Session by session</h3>
        {current && current.dayChoices.length > 0 && (
          <label className="flex items-center gap-1 text-[11px] text-slate-400">
            last
            <select
              value={days ?? current.sessions?.length ?? current.dayChoices[0]}
              onChange={(event) => setDays(Number(event.target.value))}
              className="rounded-lg border border-white/10 bg-slate-950/60 px-1.5 py-0.5 text-[11px] text-slate-200"
            >
              {current.dayChoices.map((count) => <option key={count} value={count}>{count} sessions</option>)}
            </select>
          </label>
        )}
      </div>
      <p className="mt-1 text-[11px] text-slate-400">Each row is the last in-session chain snapshot of a trading session.</p>

      {current === null && <p className="mt-2 text-xs text-slate-400">Loading…</p>}
      {current?.error && <p className="mt-2 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{current.error}</p>}
      {current?.sessions && (
        <>
          <IvSkewHistoryView sessions={current.sessions} />
          <VendorGreeksHistoryView sessions={current.sessions} />
        </>
      )}
    </section>
  );
}

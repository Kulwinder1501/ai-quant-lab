"use client";

import React, { useMemo } from "react";
import { bandText } from "../implied-move";
import { STRIKE_LADDER_DEFINITIONS, ladderNotes, type LadderRow } from "../strike-ladder";
import { contractFlag, stalenessKey, type ContractStalenessView } from "../quote-staleness";

function points(value: number): string {
  return Math.round(value).toLocaleString("en-IN");
}

function two(value: number): string {
  return value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Every strike's contract cost in one table, for the side chosen above. The rows are the single-contract card's figures, in strike
 * order and unranked; choosing a row selects that strike in the card. A strike with no two-sided quote stays as a row of dashes.
 */
export function StrikeLadderView({
  rows,
  side,
  selectedStrike,
  onSelect,
  staleness,
}: {
  rows: LadderRow[];
  side: "CE" | "PE";
  selectedStrike: number | null;
  onSelect: (strike: number) => void;
  /** Which contracts have repeated their quote across recent snapshots; null until that read has answered. */
  staleness: { index: Map<string, ContractStalenessView>; marketOpen: boolean } | null;
}) {
  const notes = useMemo(() => ladderNotes(rows), [rows]);
  const flagOf = (row: LadderRow) => (staleness ? contractFlag(staleness.index.get(stalenessKey(row.strike, side)), staleness.marketOpen) : null);

  return (
    <div className="mt-6">
      <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-slate-300">Every {side === "CE" ? "call" : "put"} strike, bought at the ask</p>
      <div className="max-h-96 overflow-auto rounded-xl border border-white/10">
        <table className="w-full min-w-[700px] text-left text-[11px] text-slate-300">
          <thead className="sticky top-0 bg-slate-950 text-[10px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-2 py-1.5 font-normal">Strike</th>
              <th className="px-2 py-1.5 text-right font-normal">Bid / ask</th>
              <th className="px-2 py-1.5 text-right font-normal">Round trip</th>
              <th className="px-2 py-1.5 text-right font-normal">Breakeven</th>
              <th className="px-2 py-1.5 text-right font-normal">Index has to move</th>
              <th className="px-2 py-1.5 text-right font-normal">× a typical day</th>
              <th className="px-2 py-1.5 text-right font-normal">Theta / day</th>
              <th className="px-2 py-1.5 text-right font-normal" title="Whether the bid and ask repeated across the newest snapshots">Quote</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const { cost } = row;
              const selected = row.strike === selectedStrike;
              return (
                <tr
                  key={row.strike}
                  onClick={() => onSelect(row.strike)}
                  className={`cursor-pointer border-t border-white/5 hover:bg-white/[0.05] ${selected ? "bg-sky-500/10" : row.moneyness === "ATM" ? "bg-white/[0.03]" : ""}`}
                  aria-selected={selected}
                >
                  <td className="px-2 py-1">
                    <button type="button" onClick={() => onSelect(row.strike)} className="font-bold text-white underline-offset-2 hover:underline">{points(row.strike)}</button>
                    <span className="ml-1 text-slate-500">{row.moneyness}</span>
                  </td>
                  {cost.quote === null ? (
                    <td colSpan={7} className="px-2 py-1 text-right text-slate-500">no two-sided quote</td>
                  ) : (
                    <>
                      <td className="px-2 py-1 text-right">{two(cost.quote.bid)} / {two(cost.quote.ask)}</td>
                      <td className="px-2 py-1 text-right">{cost.roundTripPercentOfAsk!.toFixed(2)}%</td>
                      <td className="px-2 py-1 text-right">{points(cost.breakevenAtExpiry!)}</td>
                      <td className="px-2 py-1 text-right">
                        {cost.neededMove === null ? "–" : cost.belowIntrinsic ? "ask below intrinsic" : `${points(cost.neededMove.points)} pts · ${cost.neededMove.percentOfSpot.toFixed(2)}%`}
                      </td>
                      <td className="px-2 py-1 text-right">{cost.neededOverDaily ? bandText(cost.neededOverDaily, (v) => `${v.toFixed(2)}×`) : "–"}</td>
                      <td className="px-2 py-1 text-right">{cost.thetaLossPercentOfAsk !== null ? `${cost.thetaLossPercentOfAsk.toFixed(1)}%` : "–"}</td>
                      <td className={`px-2 py-1 text-right ${flagOf(row)?.flagged ? "text-amber-200" : "text-slate-500"}`}>{flagOf(row)?.cell ?? "–"}</td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {notes.map((note) => (
        <p key={note.text} className={`mt-1 text-[11px] ${note.tone === "warn" ? "text-amber-200" : "text-slate-500"}`}>{note.text}</p>
      ))}
      <details className="mt-2 text-[11px] text-slate-400">
        <summary className="cursor-pointer text-slate-300">What the ladder is, and is not</summary>
        <dl className="mt-2 space-y-1">
          {Object.entries(STRIKE_LADDER_DEFINITIONS).map(([name, text]) => (
            <div key={name}><dt className="inline font-bold text-slate-300">{name}: </dt><dd className="inline">{text}</dd></div>
          ))}
        </dl>
      </details>
    </div>
  );
}

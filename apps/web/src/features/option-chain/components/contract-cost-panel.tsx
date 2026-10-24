"use client";

import React, { useMemo, useState } from "react";
import { bandText, buildImpliedMove, type ImpliedMoveInput } from "../implied-move";
import {
  CONTRACT_COST_DEFINITIONS,
  buildContractCost,
  contractCostNotes,
  hurdleSentence,
  type CostLeg,
  type OptionSide,
} from "../contract-cost";

export interface CostStrike {
  strikePrice: number;
  call: CostLeg | null;
  put: CostLeg | null;
}

function points(value: number): string {
  return Math.round(value).toLocaleString("en-IN");
}

function two(value: number): string {
  return value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
 * What it costs to be long one option, and what the market has to do for it to pay.
 *
 * The side and strike are the viewer's choice (the ATM strike until they pick one). Every figure is per one unit of the underlying;
 * the page says to multiply by the lot size rather than carry a lot-size table the chain does not hold. Observed prices (the quote),
 * arithmetic on them (breakeven, needed move, time value) and model readings (theta, Greeks, the typical-move band) are labelled
 * as such, and a contract without a two-sided quote shows none of the derived figures.
 */
export function ContractCostPanel({
  strikes,
  input,
  expiryLabel,
}: {
  strikes: CostStrike[];
  input: ImpliedMoveInput;
  expiryLabel: string;
}) {
  const [side, setSide] = useState<OptionSide>("CE");
  const [picked, setPicked] = useState<number | null>(null);

  const strikePrices = useMemo(() => strikes.map((row) => row.strikePrice).sort((a, b) => a - b), [strikes]);
  // A picked strike that is no longer in the snapshot falls back to the money rather than showing a stale selection.
  const strike = picked !== null && strikePrices.includes(picked) ? picked : input.atmStrike;
  const row = strike === null ? undefined : strikes.find((entry) => entry.strikePrice === strike);
  const leg = (side === "CE" ? row?.call : row?.put) ?? null;

  const implied = useMemo(() => buildImpliedMove(input), [input]);
  const cost = useMemo(
    () => (strike === null ? null : buildContractCost({ optionType: side, strike, spot: input.spot, leg }, implied)),
    [side, strike, input.spot, leg, implied],
  );
  const sentence = cost && strike !== null ? hurdleSentence(cost, side, strike) : null;
  const notes = cost ? contractCostNotes(cost, leg) : [];

  return (
    <section className="mt-6 w-full border-t border-white/10 pt-4" aria-label="Contract cost">
      <h3 className="text-sm font-bold text-white">What one contract costs, and what it needs</h3>
      <p className="mt-1 text-[11px] text-slate-400">
        Long one option of {expiryLabel}, bought at the ask. Per unit of the underlying: multiply by the lot size for rupees per lot.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-slate-400">
        <span className="inline-flex overflow-hidden rounded-lg border border-white/10" role="group" aria-label="Option side">
          {(["CE", "PE"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setSide(option)}
              aria-pressed={side === option}
              className={`px-3 py-1 font-bold ${side === option ? "bg-sky-500/20 text-sky-200" : "bg-slate-950/40 text-slate-400"}`}
            >
              {option === "CE" ? "Call" : "Put"}
            </button>
          ))}
        </span>
        <label className="flex items-center gap-1">
          strike
          <select
            value={strike ?? ""}
            onChange={(event) => setPicked(Number(event.target.value))}
            disabled={strikePrices.length === 0}
            className="rounded-lg border border-white/10 bg-slate-950/60 px-1.5 py-0.5 text-slate-200 disabled:opacity-50"
          >
            {strikePrices.map((price) => (
              <option key={price} value={price}>{points(price)}{price === input.atmStrike ? " (ATM)" : ""}</option>
            ))}
          </select>
        </label>
        {picked !== null && picked !== input.atmStrike && (
          <button type="button" onClick={() => setPicked(null)} className="text-sky-300 underline">back to ATM</button>
        )}
      </div>

      {strike === null || cost === null ? (
        <p className="mt-3 text-xs text-slate-400">No chain is loaded, so there is no contract to price.</p>
      ) : (
        <>
          <div className="mt-3 grid gap-3 lg:grid-cols-3">
            <div>
              <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-sky-300">Observed prices</p>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
                <Figure
                  label="Bid / ask"
                  value={cost.quote ? `${two(cost.quote.bid)} / ${two(cost.quote.ask)}` : "–"}
                  detail={cost.quote ? `mid ${two(cost.quote.mid)}` : "needs a positive bid and an ask"}
                />
                <Figure
                  label="Spread"
                  value={cost.quote ? `${two(cost.quote.spreadPoints)} · ${cost.quote.spreadPercentOfMid.toFixed(2)}% of mid` : "–"}
                  detail={cost.roundTripPercentOfAsk !== null ? `in and out at once costs ${cost.roundTripPercentOfAsk.toFixed(2)}% of the ask` : undefined}
                />
              </div>
            </div>

            <div>
              <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-emerald-300">Arithmetic on those prices</p>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
                <Figure
                  label="Breakeven at expiry"
                  value={cost.breakevenAtExpiry !== null ? points(cost.breakevenAtExpiry) : "–"}
                  detail={cost.breakevenAtExpiry !== null ? `strike ${side === "CE" ? "+" : "−"} ask` : undefined}
                />
                <Figure
                  label="Index has to move"
                  value={cost.neededMove ? `${points(Math.abs(cost.neededMove.points))} pts ${cost.neededMove.direction} · ${Math.abs(cost.neededMove.percentOfSpot).toFixed(2)}%` : "–"}
                  detail={cost.neededMove?.alreadyPastBreakeven ? "the breakeven is already behind the index: see the note" : cost.neededOverDaily ? `${bandText(cost.neededOverDaily, (v) => `${v.toFixed(2)}×`)} a typical day's absolute move` : undefined}
                />
                <Figure
                  label="Intrinsic / time value"
                  value={cost.intrinsic !== null && cost.timeValue !== null ? `${two(cost.intrinsic)} / ${two(cost.timeValue)}` : "–"}
                  detail={cost.timeValueShareOfAsk !== null ? `${(cost.timeValueShareOfAsk * 100).toFixed(1)}% of the ask is time value` : undefined}
                />
              </div>
            </div>

            <div>
              <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-violet-300">Model readings</p>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
                <Figure
                  label="Theta per calendar day"
                  value={cost.thetaLossPerDay !== null ? `−${two(cost.thetaLossPerDay)}` : "–"}
                  detail={cost.thetaLossPercentOfAsk !== null ? `${cost.thetaLossPercentOfAsk.toFixed(2)}% of the ask, at today's rate` : "no solved implied volatility"}
                />
                <Figure
                  label="Delta · gamma"
                  value={cost.delta !== null ? `${cost.delta.toFixed(3)} · ${cost.gamma !== null ? cost.gamma.toFixed(5) : "–"}` : "–"}
                  detail={cost.impliedVolatility !== null ? `IV ${(cost.impliedVolatility * 100).toFixed(2)}%${cost.daysToExpiry !== null ? ` · ${cost.daysToExpiry.toFixed(1)} days` : ""}` : undefined}
                />
                <Figure
                  label="Against the move to expiry (1σ)"
                  value={cost.neededOverToExpiry !== null ? `${cost.neededOverToExpiry.toFixed(2)}×` : "–"}
                  detail={implied.oneSigmaToExpiryPoints !== null ? `one σ is ±${points(implied.oneSigmaToExpiryPoints)} pts from the ATM IV` : "no ATM IV"}
                />
              </div>
            </div>
          </div>

          {sentence && <p className="mt-3 text-[11px] text-slate-200">{sentence}</p>}
          {notes.map((note) => (
            <p key={note.text} className={`mt-1 text-[11px] ${note.tone === "warn" ? "text-amber-200" : "text-slate-500"}`}>{note.text}</p>
          ))}
        </>
      )}

      <details className="mt-3 text-[11px] text-slate-400">
        <summary className="cursor-pointer text-slate-300">Definitions and what this cannot say</summary>
        <dl className="mt-2 space-y-1">
          {Object.entries(CONTRACT_COST_DEFINITIONS).map(([name, text]) => (
            <div key={name}><dt className="inline font-bold text-slate-300">{name}: </dt><dd className="inline">{text}</dd></div>
          ))}
        </dl>
      </details>
    </section>
  );
}

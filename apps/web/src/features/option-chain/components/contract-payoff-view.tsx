"use client";

import React from "react";
import { CONTRACT_PAYOFF_DEFINITIONS, type Payoff, type PayoffLabel, type PayoffSide } from "../contract-payoff";

const WIDTH = 600;
const HEIGHT = 170;
const PAD = { left: 56, right: 12, top: 12, bottom: 24 };

function points(value: number): string {
  return Math.round(value).toLocaleString("en-IN");
}

/** A signed figure at the shown precision: a value that rounds to zero is "0", not "−0.00" (the breakeven row is zero up to float error). */
function signed(value: number, digits = 2): string {
  const rounded = Number(value.toFixed(digits));
  const text = Math.abs(rounded).toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return rounded < 0 ? `−${text}` : rounded > 0 ? `+${text}` : text;
}

function two(value: number): string {
  return value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const LABEL_TEXT: Record<PayoffLabel, string> = { spot: "index now", strike: "strike", breakeven: "breakeven" };

/**
 * The position at expiry as a line and a table: profit or loss per unit against the index level, from the ask paid.
 * Arithmetic on one observed price, held to expiry; not a forecast and not a probability.
 */
export function ContractPayoffView({ payoff, side, strike }: { payoff: Payoff; side: PayoffSide; strike: number }) {
  const levels = payoff.rows.map((row) => row.level);
  const pnls = payoff.rows.map((row) => row.pnl);
  const xMin = Math.min(...levels);
  const xMax = Math.max(...levels);
  const yMin = Math.min(0, ...pnls);
  const yMax = Math.max(0, ...pnls);
  const x = (level: number) => PAD.left + ((level - xMin) / (xMax - xMin || 1)) * (WIDTH - PAD.left - PAD.right);
  const y = (pnl: number) => PAD.top + ((yMax - pnl) / (yMax - yMin || 1)) * (HEIGHT - PAD.top - PAD.bottom);
  const line = payoff.rows.map((row) => `${x(row.level).toFixed(1)},${y(row.pnl).toFixed(1)}`).join(" ");
  const marker = (label: PayoffLabel) => payoff.rows.find((row) => row.labels.includes(label));
  const spotRow = marker("spot");
  const breakevenRow = marker("breakeven");

  return (
    <div className="mt-4">
      <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-amber-300">At expiry, if held (arithmetic on the ask paid)</p>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full" role="img" aria-label={`Profit or loss at expiry for the ${points(strike)} ${side === "CE" ? "call" : "put"}`}>
        <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y(0)} y2={y(0)} stroke="currentColor" className="text-slate-500" strokeWidth={1} />
        {spotRow && <line x1={x(spotRow.level)} x2={x(spotRow.level)} y1={PAD.top} y2={HEIGHT - PAD.bottom} stroke="currentColor" className="text-sky-400" strokeDasharray="4 3" strokeWidth={1} />}
        {breakevenRow && <line x1={x(breakevenRow.level)} x2={x(breakevenRow.level)} y1={PAD.top} y2={HEIGHT - PAD.bottom} stroke="currentColor" className="text-emerald-400" strokeDasharray="4 3" strokeWidth={1} />}
        <polyline points={line} fill="none" stroke="currentColor" className="text-amber-300" strokeWidth={2} />
        {payoff.rows.map((row) => <circle key={row.level} cx={x(row.level)} cy={y(row.pnl)} r={2.5} className={row.pnl >= 0 ? "fill-emerald-300" : "fill-rose-300"} />)}
        <text x={PAD.left - 6} y={y(yMax) + 4} textAnchor="end" className="fill-slate-400" fontSize={10}>{signed(yMax, 0)}</text>
        <text x={PAD.left - 6} y={y(yMin) + 4} textAnchor="end" className="fill-slate-400" fontSize={10}>{signed(yMin, 0)}</text>
        <text x={PAD.left} y={HEIGHT - 6} className="fill-slate-400" fontSize={10}>{points(xMin)}</text>
        <text x={WIDTH - PAD.right} y={HEIGHT - 6} textAnchor="end" className="fill-slate-400" fontSize={10}>{points(xMax)}</text>
      </svg>
      <p className="text-[11px] text-slate-500">
        Dashed: index now (blue){breakevenRow ? ", breakeven (green)" : ""}. Most that can be lost: {signed(-payoff.maxLoss)} (the whole premium).{" "}
        {payoff.maxGain === null ? "A call's gain has no upper limit." : `Most that can be gained: ${signed(payoff.maxGain)} (the index cannot fall below zero).`}
      </p>

      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[480px] text-left text-[11px] text-slate-300">
          <thead className="text-[10px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="py-1 pr-3 font-normal">Index at expiry</th>
              <th className="py-1 pr-3 font-normal">From now</th>
              <th className="py-1 pr-3 font-normal">In typical moves</th>
              <th className="py-1 pr-3 text-right font-normal">Worth</th>
              <th className="py-1 pr-3 text-right font-normal">Profit / loss</th>
              <th className="py-1 text-right font-normal">% of ask</th>
            </tr>
          </thead>
          <tbody>
            {payoff.rows.map((row) => (
              <tr key={row.level} className={`border-t border-white/5 ${row.labels.length > 0 ? "bg-white/[0.03]" : ""}`}>
                <td className="py-1 pr-3">
                  {points(row.level)}
                  {row.labels.length > 0 && <span className="ml-1 text-slate-500">{row.labels.map((label) => LABEL_TEXT[label]).join(", ")}</span>}
                </td>
                <td className="py-1 pr-3">{row.moveFromSpotPoints === 0 ? "0" : `${signed(row.moveFromSpotPoints, 0)} (${signed(row.moveFromSpotPercent)}%)`}</td>
                <td className="py-1 pr-3">{row.sigmas === null ? "–" : `${signed(row.sigmas)}σ`}</td>
                <td className="py-1 pr-3 text-right">{two(row.intrinsicAtExpiry)}</td>
                <td className={`py-1 pr-3 text-right font-bold ${row.pnl >= 0 ? "text-emerald-300" : "text-rose-300"}`}>{signed(row.pnl)}</td>
                <td className="py-1 text-right">{signed(row.pnlPercentOfAsk, 1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <details className="mt-2 text-[11px] text-slate-400">
        <summary className="cursor-pointer text-slate-300">What the payoff line is, and is not</summary>
        <dl className="mt-2 space-y-1">
          {Object.entries(CONTRACT_PAYOFF_DEFINITIONS).map(([name, text]) => (
            <div key={name}><dt className="inline font-bold text-slate-300">{name}: </dt><dd className="inline">{text}</dd></div>
          ))}
        </dl>
      </details>
    </div>
  );
}

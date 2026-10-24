"use client";

import React, { useMemo } from "react";
import type { GreeksStrikeInput } from "../build-greeks-by-strike";
import {
  CHECK_UNITS,
  VENDOR_CHECK_DEFINITIONS,
  coverageSentence,
  formatDifference,
  summariseAgreement,
  verdictText,
  type CheckMetric,
  type Verdict,
} from "../vendor-greeks-check";

const METRIC_LABEL: Record<CheckMetric, string> = { iv: "Implied volatility", delta: "Delta", gamma: "Gamma", theta: "Theta", vega: "Vega" };
const VERDICT_CLASS: Record<Verdict, string> = { within: "text-emerald-300", beyond: "text-amber-300", "not-judged": "text-slate-400" };

/**
 * The model's Greeks against Fyers' own for every contract of the stored snapshot that has both: the signed bias, the mean and the
 * worst difference, and where the worst one is. Two routes to the same numbers; agreement is some evidence for each and a gap is a
 * prompt to look, never a statement of which is right.
 */
export function VendorGreeksCheckView({ strikes }: { strikes: GreeksStrikeInput[] }) {
  const summary = useMemo(() => summariseAgreement(strikes), [strikes]);
  const hasPairs = summary.metrics.some((metric) => metric.compared > 0);

  return (
    <section className="mt-6 w-full border-t border-white/10 pt-4" aria-label="Model against Fyers Greeks">
      <h3 className="text-sm font-bold text-white">Model Greeks against Fyers&apos; own</h3>
      <p className="mt-1 text-[11px] text-slate-400">
        Both are read from the one stored snapshot. Each difference is Fyers&apos; value minus the model&apos;s, in the same units.
      </p>
      <p className="mt-1 text-[11px] text-slate-300">{coverageSentence(summary)}</p>

      {hasPairs && (
        <div className="mt-3 overflow-x-auto rounded-xl border border-white/10">
          <table className="w-full min-w-[620px] text-left text-[11px] text-slate-300">
            <thead className="bg-slate-950 text-[10px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-2 py-1.5 font-normal">Metric</th>
                <th className="px-2 py-1.5 text-right font-normal">Compared</th>
                <th className="px-2 py-1.5 text-right font-normal">Bias</th>
                <th className="px-2 py-1.5 text-right font-normal">Mean |gap|</th>
                <th className="px-2 py-1.5 text-right font-normal">Worst gap</th>
                <th className="px-2 py-1.5 font-normal">Reading</th>
              </tr>
            </thead>
            <tbody>
              {summary.metrics.map((metric) => (
                <tr key={metric.metric} className="border-t border-white/5" title={CHECK_UNITS[metric.metric]}>
                  <td className="px-2 py-1 font-bold text-white">{METRIC_LABEL[metric.metric]}<span className="ml-1 font-normal text-slate-500">{CHECK_UNITS[metric.metric]}</span></td>
                  <td className="px-2 py-1 text-right">{metric.compared}</td>
                  <td className="px-2 py-1 text-right">{formatDifference(metric.metric, metric.bias)}</td>
                  <td className="px-2 py-1 text-right">{metric.meanAbsolute === null ? "–" : formatDifference(metric.metric, metric.meanAbsolute).replace("+", "")}</td>
                  <td className="px-2 py-1 text-right">
                    {metric.worst ? `${formatDifference(metric.metric, metric.worst.difference)} at ${metric.worst.strike.toLocaleString("en-IN")} ${metric.worst.side === "CE" ? "call" : "put"}` : "–"}
                  </td>
                  <td className={`px-2 py-1 ${VERDICT_CLASS[metric.verdict]}`}>{verdictText(metric)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <details className="mt-3 text-[11px] text-slate-400">
        <summary className="cursor-pointer text-slate-300">How this is compared, and what it cannot say</summary>
        <dl className="mt-2 space-y-1">
          {Object.entries(VENDOR_CHECK_DEFINITIONS).map(([name, text]) => (
            <div key={name}><dt className="inline font-bold text-slate-300">{name}: </dt><dd className="inline">{text}</dd></div>
          ))}
        </dl>
      </details>
    </section>
  );
}

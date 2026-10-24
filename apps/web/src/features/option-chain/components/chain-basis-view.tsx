"use client";

import React, { useMemo } from "react";
import {
  CHAIN_BASIS_DEFINITIONS,
  basisSentence,
  buildChainBasis,
  greeksSufficiency,
  impliedMoveSufficiency,
  quoteSufficiency,
  type ChainBasisInput,
  type SufficiencyLevel,
} from "../chain-basis";

const LEVEL_WORD: Record<SufficiencyLevel, string> = { enough: "enough", partial: "partial", thin: "thin", cannot: "cannot be shown" };
const LEVEL_CLASS: Record<SufficiencyLevel, string> = {
  enough: "border-emerald-400/30 text-emerald-200",
  partial: "border-amber-400/30 text-amber-200",
  thin: "border-rose-400/30 text-rose-200",
  cannot: "border-rose-400/30 text-rose-200",
};

/**
 * What the Model greeks tab stands on, above its panels: the shape of the one stored snapshot it reads and, for each group of
 * panels, whether the chain has enough for it (the rules are on the page). It reads only the snapshot the panels read.
 */
export function ChainBasisView({ input }: { input: ChainBasisInput }) {
  const basis = useMemo(() => buildChainBasis(input), [input]);
  const rows = useMemo(() => [
    { label: "Greeks by strike", ...greeksSufficiency(basis) },
    { label: "Implied move", ...impliedMoveSufficiency(basis) },
    { label: "Contract cost, payoff and ladder", ...quoteSufficiency(basis) },
  ], [basis]);

  return (
    <section className="mb-4 w-full rounded-xl border border-white/10 bg-slate-950/40 px-3 py-2" aria-label="What this tab stands on">
      <p className="text-[11px] font-bold uppercase tracking-wide text-slate-400">What this tab stands on</p>
      <p className="mt-1 text-[11px] text-slate-300">{basisSentence(basis)}</p>
      <ul className="mt-2 grid gap-1.5 sm:grid-cols-3">
        {rows.map((row) => (
          <li key={row.label} className={`rounded-lg border px-2 py-1 text-[11px] ${LEVEL_CLASS[row.level]}`}>
            <span className="font-bold">{row.label}: {LEVEL_WORD[row.level]}</span> <span className="text-slate-300">— {row.text}.</span>
          </li>
        ))}
      </ul>
      <details className="mt-2 text-[11px] text-slate-400">
        <summary className="cursor-pointer text-slate-300">How these are judged</summary>
        <dl className="mt-2 space-y-1">
          {Object.entries(CHAIN_BASIS_DEFINITIONS).map(([name, text]) => (
            <div key={name}><dt className="inline font-bold text-slate-300">{name}: </dt><dd className="inline">{text}</dd></div>
          ))}
        </dl>
      </details>
    </section>
  );
}

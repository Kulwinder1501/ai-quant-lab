"use client";

import React, { useEffect, useMemo, useState } from "react";
import { errorMessage, isAbortError } from "../../../lib/errors";
import { getResearchJson } from "../../research/api";
import type { ContractCost, OptionSide } from "../contract-cost";
import {
  CHECKLIST_RULES,
  buildChecklist,
  feeModelFromEstimates,
  findOiWalls,
  type CheckStatus,
  type FeeModel,
  type OiWallStrike,
} from "../pre-trade-checklist";

interface LotInfoResponse {
  data: { lotSize: number; feeEstimate: { roundTripTotal: number } };
}

const BUDGET_STORAGE_KEY = "preTradeChecklist.riskBudgetInr";

const STATUS_WORD: Record<CheckStatus, string> = {
  pass: "Pass",
  caution: "Caution",
  fail: "Fail",
  unknown: "Unknown",
  "not-scored": "Not scored",
};

const STATUS_CLASS: Record<CheckStatus, string> = {
  pass: "border-emerald-400/40 bg-emerald-500/10 text-emerald-200",
  caution: "border-amber-400/40 bg-amber-500/10 text-amber-200",
  fail: "border-rose-400/40 bg-rose-500/10 text-rose-200",
  unknown: "border-slate-500/40 bg-slate-500/10 text-slate-300",
  "not-scored": "border-dashed border-slate-500/40 bg-transparent text-slate-400",
};

/** A positive number from a text box, or null: an empty or half-typed box is "not entered", never zero. */
function parsePositive(text: string): number | null {
  const value = Number(text.replace(/,/g, "").trim());
  return text.trim() !== "" && Number.isFinite(value) && value > 0 ? value : null;
}

function readStoredBudget(): string {
  try {
    return window.localStorage.getItem(BUDGET_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function storeBudget(value: string): void {
  try {
    window.localStorage.setItem(BUDGET_STORAGE_KEY, value);
  } catch {
    // Private windows and blocked storage are fine: the box just starts empty next time.
  }
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-[11px] text-slate-400">
      <span className="font-bold text-slate-300">{label}</span>
      {children}
      {hint ? <span className="text-[10px] text-slate-500">{hint}</span> : null}
    </label>
  );
}

const INPUT_CLASS = "rounded-lg border border-white/10 bg-slate-950/60 px-2 py-1 text-xs text-slate-100 placeholder:text-slate-600";

/**
 * A checklist to run through by hand before buying the contract chosen above.
 *
 * The contract's own figures (spread, days, theta, delta) come from the cost card; the stop, target, time limit, reason and the
 * most you will lose are typed in here, because they are the person's plan and nothing in the chain can supply them. Lot size and
 * round-trip charges come from the existing `lot-info` endpoint, asked at one and two lots to get the charges line. Each check
 * shows its measured figure, what it means and the rule it was judged by. Nothing here says to trade or not to trade.
 */
export function PreTradeChecklistPanel({
  underlying,
  side,
  cost,
  quoteWarning,
  oiStrikes,
  spot,
  typicalDay,
}: {
  underlying: string;
  side: OptionSide;
  cost: ContractCost | null;
  quoteWarning: string | null;
  oiStrikes: OiWallStrike[];
  spot: number | null;
  /** The expected absolute daily move in points (a low-high band) from the implied-move panel, or null when there is no ATM IV. */
  typicalDay: { low: number; high: number } | null;
}) {
  const [stopText, setStopText] = useState("");
  const [targetText, setTargetText] = useState("");
  const [holdText, setHoldText] = useState("");
  const [reason, setReason] = useState("");
  // The risk limit is a standing habit, not a per-trade figure, so it is remembered. This panel only mounts once the chain has loaded in
  // the browser (never in the server render), and a missing or blocked store reads as an empty box.
  const [budgetText, setBudgetText] = useState(readStoredBudget);

  const ask = cost?.quote?.ask ?? null;
  // Charges depend on the premium only through whole-rupee turnover, so the lookup is keyed to the rounded ask, as the order ticket does.
  const premiumBasis = ask !== null ? Math.max(1, Math.round(ask)) : null;
  const [fees, setFees] = useState<{ key: string; model: FeeModel | null; error: string | null } | null>(null);
  const feeKey = `${underlying}@${premiumBasis ?? ""}`;
  useEffect(() => {
    if (premiumBasis === null) return undefined;
    const controller = new AbortController();
    const path = (lots: number) => `/instruments/by-symbol/${encodeURIComponent(underlying)}/lot-info?lots=${lots}&premium=${premiumBasis}`;
    void (async () => {
      try {
        const [one, two] = await Promise.all([
          getResearchJson(path(1), controller.signal) as Promise<LotInfoResponse>,
          getResearchJson(path(2), controller.signal) as Promise<LotInfoResponse>,
        ]);
        const model = feeModelFromEstimates(one.data.lotSize, one.data.feeEstimate.roundTripTotal, two.data.feeEstimate.roundTripTotal);
        setFees({ key: feeKey, model, error: model === null ? "The charges estimate was not usable." : null });
      } catch (caught) {
        if (isAbortError(caught)) return;
        setFees({ key: feeKey, model: null, error: errorMessage(caught, "Lot size and charges could not be loaded.") });
      }
    })();
    return () => controller.abort();
  }, [underlying, premiumBasis, feeKey]);
  const feeModel = fees?.key === feeKey ? fees.model : null;
  const feeError = fees?.key === feeKey ? fees.error : null;

  const walls = useMemo(() => findOiWalls(oiStrikes, spot), [oiStrikes, spot]);
  const plan = useMemo(
    () => ({
      stopPremium: parsePositive(stopText),
      targetPremium: parsePositive(targetText),
      holdMinutes: parsePositive(holdText),
      reason,
      riskBudgetInr: parsePositive(budgetText),
    }),
    [stopText, targetText, holdText, reason, budgetText],
  );
  const checklist = useMemo(
    () => buildChecklist({ side, cost, quoteWarning, plan, fees: feeModel, walls, spot, typicalDay }),
    [side, cost, quoteWarning, plan, feeModel, walls, spot, typicalDay],
  );

  return (
    <section className="mt-6 w-full border-t border-white/10 pt-4" aria-label="Before you buy checklist">
      <h3 className="text-sm font-bold text-white">Before you buy: checklist</h3>
      <p className="mt-1 text-[11px] text-slate-400">
        For the contract chosen above, bought at the ask. Type your plan; each check shows its figure and the rule it is judged by.
        A rule of thumb, not a signal: passing does not mean the trade will win.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Field label="Stop (premium)" hint={ask !== null ? `below the ask ${ask.toFixed(2)}` : "needs a quote"}>
          <input className={INPUT_CLASS} inputMode="decimal" placeholder="e.g. 300" value={stopText} onChange={(event) => setStopText(event.target.value)} />
        </Field>
        <Field label="Target (premium)" hint={ask !== null ? `above the ask ${ask.toFixed(2)}` : "needs a quote"}>
          <input className={INPUT_CLASS} inputMode="decimal" placeholder="e.g. 420" value={targetText} onChange={(event) => setTargetText(event.target.value)} />
        </Field>
        <Field label="Out after (minutes)" hint="the longest you will hold it">
          <input className={INPUT_CLASS} inputMode="numeric" placeholder="e.g. 30" value={holdText} onChange={(event) => setHoldText(event.target.value)} />
        </Field>
        <Field label="Most you will lose (₹)" hint="charges included; remembered on this device">
          <input
            className={INPUT_CLASS}
            inputMode="numeric"
            placeholder="e.g. 3000"
            value={budgetText}
            onChange={(event) => {
              setBudgetText(event.target.value);
              storeBudget(event.target.value);
            }}
          />
        </Field>
        <div className="sm:col-span-2 lg:col-span-5">
          <Field label="Why will the index move, by about how much, by when?" hint={`at least ${CHECKLIST_RULES.minReasonLength} characters; the text is not judged, only that you wrote it`}>
            <textarea className={`${INPUT_CLASS} min-h-[3rem]`} value={reason} onChange={(event) => setReason(event.target.value)} />
          </Field>
        </div>
      </div>
      {feeError && <p className="mt-2 text-[11px] text-slate-500">{feeError}</p>}

      <p className="mt-3 text-[11px] text-slate-200" aria-live="polite">{checklist.summary.sentence}</p>

      <ul className="mt-2 space-y-2">
        {checklist.checks.map((check) => (
          <li key={check.id} className="rounded-xl border border-white/10 bg-slate-950/40 px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${STATUS_CLASS[check.status]}`}>{STATUS_WORD[check.status]}</span>
              <span className="text-xs font-bold text-white">{check.title}</span>
              <span className="text-[11px] text-slate-300">{check.value}</span>
            </div>
            <p className="mt-1 text-[11px] text-slate-400">{check.detail}</p>
            <details className="mt-1 text-[10px] text-slate-500">
              <summary className="cursor-pointer text-slate-400">The rule</summary>
              <p className="mt-1">{check.rule}</p>
            </details>
          </li>
        ))}
      </ul>

      <p className="mt-2 text-[10px] text-slate-500">
        Charges are priced at the entry premium on both legs and lots at the lot size the platform holds; the open-interest wall check is a
        first-order estimate. Not advice: you decide, and a person should review any trade before it is placed.
      </p>
    </section>
  );
}

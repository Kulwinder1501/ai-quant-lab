import type { BaselineName } from "./snapshot.js";
import type { MeasuredOutcome, PremarketInstrument, PremarketTarget } from "./targets.js";

/** Below this many non-abstained calls per target, no verdict is issued -- whatever the numbers look like. */
export const MIN_CALLS_FOR_VERDICT = 30;
export const SIGNIFICANCE_LEVEL = 0.05;

/** One scored session: what the model called, what each baseline called, and what happened. */
export interface ScoredObservation {
  sessionDate: string;
  runSlot: string;
  instrument: PremarketInstrument;
  target: PremarketTarget;
  /** The model's call mapped onto the measured alphabet; null when it abstained (UNCERTAIN). */
  llmCall: MeasuredOutcome | null;
  baselines: Partial<Record<BaselineName, MeasuredOutcome | null>>;
  actual: MeasuredOutcome;
}

const logFactorialCache: number[] = [0, 0];
function logFactorial(n: number): number {
  for (let k = logFactorialCache.length; k <= n; k += 1) {
    logFactorialCache[k] = logFactorialCache[k - 1]! + Math.log(k);
  }
  return logFactorialCache[n]!;
}

/**
 * One-sided exact McNemar p-value: the chance of at least `modelOnly` model-wins among
 * `modelOnly + baselineOnly` discordant sessions if the two were equally good.
 *
 * Only sessions where exactly one of the two was right carry information about which is better, so
 * sessions where both were right (or both wrong) are excluded by construction.
 */
export function mcnemarOneSidedP(modelOnly: number, baselineOnly: number): number {
  const n = modelOnly + baselineOnly;
  if (n === 0) return 1;
  let tail = 0;
  for (let k = modelOnly; k <= n; k += 1) {
    tail += Math.exp(logFactorial(n) - logFactorial(k) - logFactorial(n - k) - n * Math.LN2);
  }
  return Math.min(1, tail);
}

/** Holm step-down adjustment, preserving input order. */
export function holmAdjust(pValues: readonly number[]): number[] {
  const order = pValues.map((p, index) => ({ p, index })).sort((a, b) => a.p - b.p);
  const adjusted = new Array<number>(pValues.length).fill(1);
  let running = 0;
  order.forEach(({ p, index }, rank) => {
    running = Math.max(running, Math.min(1, (pValues.length - rank) * p));
    adjusted[index] = running;
  });
  return adjusted;
}

export interface BaselineComparison {
  baseline: BaselineName;
  comparableCalls: number;
  llmCorrect: number;
  baselineCorrect: number;
  modelOnlyCorrect: number;
  baselineOnlyCorrect: number;
  pValue: number;
  holmAdjustedP: number;
}

export type Verdict = "INSUFFICIENT_SAMPLE" | "NO_INCREMENTAL_VALUE" | "LLM_CANDIDATE";

export interface TargetScore {
  target: PremarketTarget;
  sessions: number;
  calls: number;
  abstentions: number;
  coverage: number | null;
  llmAccuracy: number | null;
  baselineAccuracy: Partial<Record<BaselineName, number | null>>;
  comparisons: BaselineComparison[];
  verdict: Verdict;
}

export interface ScoreReport {
  targets: TargetScore[];
  note: string;
}

const BASELINES: readonly BaselineName[] = ["GIFT_THRESHOLD", "FOLLOW_GAP", "ALWAYS_FLAT"];

/**
 * Scores the model against every deterministic baseline, per target, pooled over instruments.
 *
 * Accuracy is over non-abstained calls only; abstentions are reported as coverage, because a model
 * that abstains whenever unsure would otherwise be graded on a flattering subset with no disclosure.
 * Comparisons are paired on the sessions the model actually called, and a verdict is only issued
 * once a target has `MIN_CALLS_FOR_VERDICT` calls. Even then the strongest word is `LLM_CANDIDATE`:
 * five comparisons are run per report, so the Holm-adjusted p is what must clear the bar, and a
 * candidate still has to replicate on later sessions before anyone sizes a position on it.
 */
export function scoreObservations(observations: readonly ScoredObservation[]): ScoreReport {
  const targets: TargetScore[] = [];
  const pending: Array<{ target: TargetScore; comparison: BaselineComparison }> = [];

  for (const target of ["OPENING_GAP", "FIRST_60_MINUTES", "FULL_SESSION"] as const) {
    const rows = observations.filter((row) => row.target === target);
    const called = rows.filter((row) => row.llmCall !== null);
    const llmCorrect = called.filter((row) => row.llmCall === row.actual).length;

    const baselineAccuracy: TargetScore["baselineAccuracy"] = {};
    const comparisons: BaselineComparison[] = [];
    for (const name of BASELINES) {
      const comparable = called.filter((row) => row.baselines[name] !== undefined && row.baselines[name] !== null);
      if (comparable.length === 0) continue;
      const baselineCorrect = comparable.filter((row) => row.baselines[name] === row.actual).length;
      baselineAccuracy[name] = baselineCorrect / comparable.length;
      const modelOnlyCorrect = comparable.filter((row) => row.llmCall === row.actual && row.baselines[name] !== row.actual).length;
      const baselineOnlyCorrect = comparable.filter((row) => row.llmCall !== row.actual && row.baselines[name] === row.actual).length;
      comparisons.push({
        baseline: name,
        comparableCalls: comparable.length,
        llmCorrect: comparable.filter((row) => row.llmCall === row.actual).length,
        baselineCorrect,
        modelOnlyCorrect,
        baselineOnlyCorrect,
        pValue: mcnemarOneSidedP(modelOnlyCorrect, baselineOnlyCorrect),
        holmAdjustedP: 1,
      });
    }

    const score: TargetScore = {
      target,
      sessions: rows.length,
      calls: called.length,
      abstentions: rows.length - called.length,
      coverage: rows.length === 0 ? null : called.length / rows.length,
      llmAccuracy: called.length === 0 ? null : llmCorrect / called.length,
      baselineAccuracy,
      comparisons,
      verdict: "INSUFFICIENT_SAMPLE",
    };
    targets.push(score);
    for (const comparison of comparisons) pending.push({ target: score, comparison });
  }

  const adjusted = holmAdjust(pending.map(({ comparison }) => comparison.pValue));
  pending.forEach(({ comparison }, index) => { comparison.holmAdjustedP = adjusted[index]!; });

  for (const score of targets) {
    if (score.calls < MIN_CALLS_FOR_VERDICT) continue;
    const beatsAll = score.comparisons.length > 0 && score.comparisons.every(
      (c) => c.llmCorrect > c.baselineCorrect && c.holmAdjustedP <= SIGNIFICANCE_LEVEL,
    );
    score.verdict = beatsAll ? "LLM_CANDIDATE" : "NO_INCREMENTAL_VALUE";
  }

  return {
    targets,
    note: `No verdict until ${MIN_CALLS_FOR_VERDICT} non-abstained calls per target; the model must beat every baseline `
      + `with Holm-adjusted p <= ${SIGNIFICANCE_LEVEL}. LLM_CANDIDATE is not proof -- it must replicate on later sessions.`,
  };
}

export interface LevelObservation {
  instrument: PremarketInstrument;
  /** True when the model selected this level; false for the remaining candidates (the base rate). */
  selectedByModel: boolean;
  touched: boolean;
}

export interface LevelScore {
  instrument: PremarketInstrument;
  selectedLevels: number;
  selectedTouchRate: number | null;
  unselectedLevels: number;
  unselectedTouchRate: number | null;
}

/**
 * Whether the levels the model chose were touched more often than the candidates it passed over.
 * Touch rate alone says nothing about support or resistance holding; it only checks the model's
 * picks are relevant to where price actually traded. Reported as rates, with no verdict.
 */
export function scoreLevels(observations: readonly LevelObservation[]): LevelScore[] {
  return (["NIFTY50", "BANKNIFTY"] as const).map((instrument) => {
    const mine = observations.filter((o) => o.instrument === instrument);
    const selected = mine.filter((o) => o.selectedByModel);
    const rest = mine.filter((o) => !o.selectedByModel);
    const rate = (rows: readonly LevelObservation[]): number | null => (
      rows.length === 0 ? null : rows.filter((o) => o.touched).length / rows.length
    );
    return {
      instrument,
      selectedLevels: selected.length,
      selectedTouchRate: rate(selected),
      unselectedLevels: rest.length,
      unselectedTouchRate: rate(rest),
    };
  });
}

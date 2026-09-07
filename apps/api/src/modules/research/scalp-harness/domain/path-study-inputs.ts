import { walkBarrierFreePath, type BarrierFreePathResult } from "./barrier-free-path.js";
import type { PathContrastUnit } from "./directional-information-curve.js";
import { sha256CanonicalJson } from "../../../platform/identity/identity.js";

/**
 * Dataset identity for a path-study trial, and the assembly of the units it walks.
 *
 * ## Three identities, kept separate
 *
 *   policy         — what was predeclared            (`studyDefinitionHash`)
 *   implementation — which code produced the numbers (`studyCodeVersion`)
 *   dataset        — which observations were visible  (this module)
 *
 * Collapsing any two of them makes a reproducibility claim that cannot be checked. The third is the one
 * that was still missing: a trial keyed on the *range* of sessions cannot distinguish two datasets that
 * share a first session, a last session and a count while differing inside, and — far more likely here —
 * cannot see that the nightly candle healer appended repaired bars to a session that was already counted.
 * Without it, a healed dataset produces the same trial key and a different result, which the ledger would
 * correctly but misleadingly report as a `DETERMINISM_VIOLATION` when nothing nondeterministic happened.
 * The input changed.
 *
 * ## Why unit assembly lives here rather than in the runner
 *
 * `studyCodeVersion` hashes a declared list of domain files, and the guarantee it offers — "no source
 * capable of changing this number has changed" — is only as good as that list. Slicing a forward window
 * and pairing a subject with its controls are both squarely result-affecting, so leaving them in the CLI
 * put them outside the hash. Anything that can move a figure belongs in a file the hash covers.
 */

export interface PathStudyBarInput {
  readonly openTime: Date;
  readonly closeTime: Date;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

export interface PathStudyDecisionInput {
  readonly decisionAt: Date;
  readonly sessionCloseAt: Date;
  readonly referencePrice: number;
  readonly atr: number | null;
}

export interface PathStudySubjectInput {
  readonly opportunityId: string;
  readonly sessionId: string;
  readonly instrumentId: string;
  readonly direction: "LONG" | "SHORT";
  readonly strategyDefinitionHashes: readonly string[];
  readonly selected: PathStudyDecisionInput;
  readonly controls: readonly PathStudyDecisionInput[];
}

/**
 * The exact set of trading sessions a cell drew on, as an order-independent digest.
 *
 * Replaces first/last/count in the trial key. Those three agree across genuinely different session sets —
 * `2026-08-01 … 2026-08-25, 15 sessions` describes many distinct collections — so they identify a range
 * rather than a dataset.
 */
export function sessionSetHash(sessionIds: readonly string[]): string {
  return sha256CanonicalJson({
    namespace: "path-study-session-set",
    sessions: [...new Set(sessionIds)].sort(),
  });
}

/**
 * Everything the walker will read, digested: the decision rows and the bars behind them.
 *
 * Covers the two mutable inputs this study depends on. Bars are appended and repaired by the healer, and
 * `indicator_snapshots` — the source of every `atr` here — is rewritten wholesale by recompute passes, so
 * a decision's volatility scale can change under a trial that has already run. Both now move the dataset
 * identity instead of moving the result silently.
 *
 * Prices are stringified through `sha256CanonicalJson`'s number handling rather than rounded, so a repair
 * that alters a bar in the sixth decimal still registers. That is the right sensitivity: the point is to
 * detect that the input differs, not to judge whether the difference was material.
 */
export function inputSnapshotHash(input: {
  readonly subjects: readonly PathStudySubjectInput[];
  readonly bars: readonly PathStudyBarInput[];
}): string {
  const decision = (item: PathStudyDecisionInput) => ({
    decisionAt: item.decisionAt,
    sessionCloseAt: item.sessionCloseAt,
    referencePrice: item.referencePrice,
    atr: item.atr,
  });
  return sha256CanonicalJson({
    namespace: "path-study-input-snapshot",
    // Sorted by a stable key so the digest cannot move on row order out of the database.
    subjects: [...input.subjects]
      .sort((left, right) => left.opportunityId.localeCompare(right.opportunityId))
      .map((subject) => ({
        opportunityId: subject.opportunityId,
        sessionId: subject.sessionId,
        direction: subject.direction,
        strategyDefinitionHashes: [...subject.strategyDefinitionHashes].sort(),
        selected: decision(subject.selected),
        controls: subject.controls.map(decision),
      })),
    bars: [...input.bars]
      .sort((left, right) => left.closeTime.getTime() - right.closeTime.getTime())
      .map((bar) => ({
        closeTime: bar.closeTime,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      })),
  });
}

/**
 * Walks one decision's forward window out of an already-loaded instrument series.
 *
 * Slicing in memory rather than querying per subject: a single session is roughly 1,500 control points
 * across two instruments, and a query each would be thousands of round trips for data already held.
 */
export function walkDecisionInSeries(input: {
  readonly decision: PathStudyDecisionInput;
  readonly direction: "LONG" | "SHORT";
  readonly horizonsMinutes: readonly number[];
  readonly series: readonly PathStudyBarInput[];
  readonly furthestMinutes: number;
}): BarrierFreePathResult {
  const from = input.decision.decisionAt.getTime();
  const to = from + input.furthestMinutes * 60_000;
  return walkBarrierFreePath({
    direction: input.direction,
    decisionAt: input.decision.decisionAt,
    referencePrice: input.decision.referencePrice,
    sessionCloseAt: input.decision.sessionCloseAt,
    horizonsMinutes: input.horizonsMinutes,
    atr: input.decision.atr,
    forwardCandles: input.series.filter(
      (bar) => bar.closeTime.getTime() > from && bar.closeTime.getTime() <= to,
    ),
  });
}

/**
 * Pairs every subject's barrier-free path with its controls' paths.
 *
 * Controls are walked with the *subject's* direction, not their own. A control point exists in both
 * directions at the same minute and the matcher already selected the one matching the treated direction;
 * re-deriving it here would risk reading the opposite sign convention into the baseline, which would
 * invert the contrast rather than merely weaken it.
 */
export function buildPathContrastUnits(input: {
  readonly subjects: readonly PathStudySubjectInput[];
  readonly seriesByInstrument: ReadonlyMap<string, readonly PathStudyBarInput[]>;
  readonly horizonsMinutes: readonly number[];
}): PathContrastUnit[] {
  const furthestMinutes = Math.max(...input.horizonsMinutes);
  return input.subjects.map((subject) => {
    const series = input.seriesByInstrument.get(subject.instrumentId) ?? [];
    const walk = (decision: PathStudyDecisionInput) => walkDecisionInSeries({
      decision,
      direction: subject.direction,
      horizonsMinutes: input.horizonsMinutes,
      series,
      furthestMinutes,
    });
    return {
      subjectId: subject.opportunityId,
      sessionId: subject.sessionId,
      strategyDefinitionHashes: subject.strategyDefinitionHashes,
      selected: walk(subject.selected),
      controls: subject.controls.map(walk),
    };
  });
}

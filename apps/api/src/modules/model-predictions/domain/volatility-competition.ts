import {
  computeAlphabetSettledMetrics,
  type GenericConfusionCell,
  type GenericSettledMetrics,
  type LabelAlphabet,
} from "./settled-metrics.js";
import { VOLATILITY_ABSTAIN_LABEL, VOLATILITY_LABELS, type VolatilityLabel } from "./volatility-expansion-label.js";

/**
 * Ranking and promotion for volatility-regime models.
 *
 * Separate from the directional competition rather than a mode of it. The directional
 * pool once enrolled a volatility model as PRIMARY of a BULLISH/BEARISH/NEUTRAL group it
 * could never score in, and `competition-eligibility.ts` fixed that by excluding
 * non-directional schemes. Making the same table serve both would reintroduce exactly
 * that failure; the two alphabets are disjoint and so are their competitions.
 *
 * What a promotion here does and does not authorise: a volatility PRIMARY may inform
 * risk and regime context only. It is never a trade direction, and nothing in the
 * directional path reads it.
 */

export const VOLATILITY_ALPHABET: LabelAlphabet<VolatilityLabel> = {
  labels: VOLATILITY_LABELS,
  abstainLabel: VOLATILITY_ABSTAIN_LABEL,
  name: "volatility-expansion",
};

export type VolatilityConfusionCell = GenericConfusionCell<VolatilityLabel>;
export type VolatilitySettledMetrics = GenericSettledMetrics;

export function computeVolatilitySettledMetrics(
  cells: readonly VolatilityConfusionCell[],
): VolatilitySettledMetrics {
  return computeAlphabetSettledMetrics(cells, VOLATILITY_ALPHABET);
}

export type VolatilityRole = "PRIMARY" | "CHALLENGER";

export interface VolatilityStanding {
  modelVersionId: string;
  modelKey: string;
  role: VolatilityRole | null;
  metrics: VolatilitySettledMetrics;
  /**
   * Distinct sessions this model settled anything on, inside the rolling window.
   *
   * The time-in-market unit for both sample gates below, and also read by the silence
   * check. It must be a true count of distinct days across *all* of the model's settled
   * rows -- see the union note in `postgres-volatility-competition-repository.ts`.
   */
  scoredDays: number;
  /** Most recent day this model settled anything, or null if never. */
  lastScoredDate: string | null;
}

export interface VolatilityCompetitionRules {
  /** Distinct settled sessions before a model may enter the ranking at all. */
  minimumScoredDays: number;
  /** Distinct settled sessions both sides need before a dethroning is considered. */
  minimumScoredDaysForPromotion: number;
  /**
   * Row floors, secondary to the session gates.
   *
   * A session count alone would let a single-instrument model qualify on fifteen rows, where
   * SE(macro-F1) is far too wide to rank anything. These are the *statistical* minimum only;
   * time in market is the session gates' job.
   */
  minimumSettledPredictions: number;
  minimumSettledForPromotion: number;
  promotionMargin: number;
  /** Days without a settled prediction before a PRIMARY is treated as silent. */
  silenceToleranceDays: number;
}

/**
 * Deliberately stricter than the directional rules on one axis and looser on another.
 *
 * The margin is the same 0.088 two-standard-error filter the directional rules use, and
 * for the same reason: at ~250 settled predictions per side the standard error of a
 * macro-F1 *difference* is about 0.044, so anything smaller promotes on noise.
 *
 * ## Time in market is counted in sessions, not rows
 *
 * These gates were `minimumSettledPredictions: 300` / `minimumSettledForPromotion: 750`, chosen
 * as "roughly fifteen sessions" and "roughly 37.5 sessions" of a twenty-instrument pool. Rows and
 * sessions are only interchangeable at a **fixed** roster size, and this project does not have
 * one: a model's fan-out is whatever roster it was trained on, recorded in
 * `validationProtocol.pooledInstruments` and read back by `_pooled_roster()` in `predict.py`. The
 * live population is genuinely mixed -- measured 2026-08-10, enrolled volatility models included
 * pool23, pool20, pool2 (`NIFTY50` + `BANKNIFTY`, which is what all three PRODUCTION models were)
 * and single-instrument artifacts.
 *
 * Against a single row threshold those are not comparable. 300 rows is fifteen sessions for a
 * pool-20 model, 150 for a pool-2 model, and 300 for a single-instrument one. Worse, the
 * promotion gate below requires the **incumbent** to clear its threshold too, so a pool-2
 * champion needed ~375 sessions before any challenger could dethrone it however good the
 * challenger was -- and raising the row numbers to track a larger pool would have pushed that
 * further out, delaying exactly the wider-pool work it was meant to protect.
 *
 * Counting sessions makes fifteen mean fifteen for every model regardless of roster, and needs no
 * revision the next time the pool changes. Rows remain as a floor underneath, but at the value the
 * statistics actually call for rather than the one that was doubling as a clock -- see below.
 *
 * 38 rather than 37.5 for the promotion gate: sessions are integers, and rounding up keeps the
 * bar no weaker than the figure it replaces.
 *
 * ## Why the row floors drop to the directional numbers
 *
 * 300 and 750 were never statistical figures -- they were 15 and 37.5 sessions multiplied by a
 * twenty-instrument roster. Now that sessions are counted directly, keeping them would leave the
 * row count as the binding constraint for every roster smaller than twenty and the session gate
 * inert: a pool-2 model would still need 150 sessions to reach 300 rows. So they revert to the
 * statistical minimum, which is the directional pair (60 / 250) -- and 250 is specifically the *n*
 * the 0.088 margin was derived from. Each number now carries one justification instead of two
 * conflated ones.
 *
 * ## An honest limit on all of this
 *
 * The margin's derivation assumes ~250 *independent* observations. Rows are not independent: this
 * comment's own earlier revision made the point that twenty correlated names in one market share
 * most of their systematic variance. If a session is closer to the true independent unit than a
 * row, then 38 sessions supports SE(macro-F1 difference) near 0.115, which is *wider* than the
 * 0.088 margin it is being asked to defend -- and the same was true of the 37.5 sessions the old
 * row figures encoded, so this change neither introduces nor fixes it.
 *
 * Resolving it properly means measuring the effective sample size -- how much a marginal
 * instrument-day actually adds once cross-sectional correlation is accounted for -- and then
 * setting the margin and the session gate together from that. Not guessed at here. What this
 * change does fix is the unit: the gates now say what they mean, so that measurement has something
 * coherent to adjust.
 *
 * There is no head-to-head daily-wins rule yet. That check needs a meaningful number of
 * common scored days, and the settled history is still shallow (84 settled rows on 2026-08-10),
 * so calibrating one now would be inventing a threshold rather than measuring it.
 */
export const DEFAULT_VOLATILITY_COMPETITION_RULES: VolatilityCompetitionRules = {
  minimumScoredDays: 15,
  minimumScoredDaysForPromotion: 38,
  minimumSettledPredictions: 60,
  minimumSettledForPromotion: 250,
  promotionMargin: 0.088,
  silenceToleranceDays: 5,
};

export type VolatilityDecisionReason =
  | "NO_QUALIFYING_MODEL"
  | "INITIAL_PRIMARY_ESTABLISHED"
  | "PRIMARY_RETAINED"
  | "PRIMARY_REPLACED"
  | "PRIMARY_QUARANTINED_SILENT"
  | "PRIMARY_QUARANTINED_BELOW_TRIVIAL";

export interface VolatilityCompetitionDecision {
  reason: VolatilityDecisionReason;
  primaryModelVersionId: string | null;
  previousPrimaryModelVersionId: string | null;
  challengerModelVersionId: string | null;
  /** Ranked qualifying models, best macro-F1 first. */
  ranking: VolatilityStanding[];
  excludedForSample: number;
  excludedBelowTrivial: number;
  explanation: string;
}

/**
 * A model must beat the trivial majority-class predictor on **both** macro-F1 and
 * accuracy.
 *
 * Requiring both is the whole lesson of the directional target. Under CPCV it beat
 * trivial on macro-F1 on 100% of splits while losing on accuracy on 93% of them, because
 * spreading predictions across three classes raises macro-F1 and lowers accuracy. A
 * macro-F1-only gate ranks the spreader first; an accuracy-only gate (this function's
 * original form) has the mirror-image hole and admits a majority-hugger with no more
 * class discrimination than trivial. The volatility target passes both, which is why it
 * is here at all.
 */
function beatsTrivial(metrics: VolatilitySettledMetrics): boolean {
  if (
    metrics.macroF1 === null
    || metrics.accuracy === null
    || metrics.trivialAccuracy === null
    || metrics.trivialMacroF1 === null
  ) {
    return false;
  }
  return metrics.accuracy > metrics.trivialAccuracy && metrics.macroF1 > metrics.trivialMacroF1;
}

/**
 * Both gates, and both must hold.
 *
 * Sessions carry the time-in-market requirement so it means the same thing for every roster size;
 * rows are the statistical floor underneath it. Neither subsumes the other -- a single-instrument
 * model reaches 15 sessions with 15 rows, and a pool-23 model reaches 60 rows in three sessions.
 */
function hasEnoughSample(standing: VolatilityStanding, rules: VolatilityCompetitionRules): boolean {
  return standing.scoredDays >= rules.minimumScoredDays
    && standing.metrics.sampleCount >= rules.minimumSettledPredictions;
}

/** The deeper evidence a dethroning needs, in the same two units. */
function isDeeplyEvidenced(standing: VolatilityStanding, rules: VolatilityCompetitionRules): boolean {
  return standing.scoredDays >= rules.minimumScoredDaysForPromotion
    && standing.metrics.sampleCount >= rules.minimumSettledForPromotion;
}

function isSilent(
  standing: VolatilityStanding,
  rules: VolatilityCompetitionRules,
  asOfDate: string,
): boolean {
  if (standing.lastScoredDate === null) return true;
  const last = Date.parse(`${standing.lastScoredDate}T00:00:00Z`);
  const now = Date.parse(`${asOfDate}T00:00:00Z`);
  if (!Number.isFinite(last) || !Number.isFinite(now)) return false;
  return (now - last) / 86_400_000 > rules.silenceToleranceDays;
}

/**
 * Decides the volatility PRIMARY from settled evidence alone.
 *
 * Never promotes on a training score. Every input here is a rolling window of settled
 * live outcomes, which is what makes this the gate Phase 25's invariant 9 asks for.
 */
export function decideVolatilityCompetition(input: {
  standings: readonly VolatilityStanding[];
  asOfDate: string;
  rules?: VolatilityCompetitionRules;
}): VolatilityCompetitionDecision {
  const rules = input.rules ?? DEFAULT_VOLATILITY_COMPETITION_RULES;
  const incumbent = input.standings.find((standing) => standing.role === "PRIMARY") ?? null;

  const withSample = input.standings.filter((standing) => hasEnoughSample(standing, rules));
  const qualifying = withSample.filter((standing) => beatsTrivial(standing.metrics));
  const ranking = [...qualifying].sort((left, right) => {
    const gap = (right.metrics.macroF1 ?? 0) - (left.metrics.macroF1 ?? 0);
    // Ties break on the larger settled sample: the better-evidenced model wins.
    return gap !== 0 ? gap : right.metrics.sampleCount - left.metrics.sampleCount;
  });

  const base = {
    ranking,
    excludedForSample: input.standings.length - withSample.length,
    excludedBelowTrivial: withSample.length - qualifying.length,
    previousPrimaryModelVersionId: incumbent?.modelVersionId ?? null,
  };

  // A silent PRIMARY is quarantined before any ranking question, because its metrics
  // describe a window it stopped contributing to. Left in place it would defend the
  // title on stale evidence.
  if (incumbent && isSilent(incumbent, rules, input.asOfDate)) {
    return {
      ...base,
      reason: "PRIMARY_QUARANTINED_SILENT",
      primaryModelVersionId: null,
      challengerModelVersionId: ranking[0]?.modelVersionId ?? null,
      explanation:
        `The volatility PRIMARY last settled a prediction on ${incumbent.lastScoredDate ?? "never"}, `
        + `beyond the ${rules.silenceToleranceDays}-day tolerance. Vacating the slot rather than `
        + "letting it hold on stale evidence.",
    };
  }

  // An incumbent that has fallen to or below the trivial predictor is vacated even if no
  // challenger qualifies. Keeping it would leave risk consumers reading a model that is
  // measurably worse than guessing the commonest outcome.
  if (incumbent && hasEnoughSample(incumbent, rules) && !beatsTrivial(incumbent.metrics)) {
    return {
      ...base,
      reason: "PRIMARY_QUARANTINED_BELOW_TRIVIAL",
      primaryModelVersionId: null,
      challengerModelVersionId: ranking[0]?.modelVersionId ?? null,
      explanation:
        "The volatility PRIMARY no longer beats the trivial majority-class predictor on both axes "
        + `(accuracy ${formatMetric(incumbent.metrics.accuracy)} vs ${formatMetric(incumbent.metrics.trivialAccuracy)}, `
        + `macro-F1 ${formatMetric(incumbent.metrics.macroF1)} vs ${formatMetric(incumbent.metrics.trivialMacroF1)}). `
        + "Vacating the slot.",
    };
  }

  const leader = ranking[0] ?? null;
  if (leader === null) {
    return {
      ...base,
      reason: "NO_QUALIFYING_MODEL",
      primaryModelVersionId: incumbent?.modelVersionId ?? null,
      challengerModelVersionId: null,
      explanation:
        `No volatility model both cleared ${rules.minimumScoredDays} scored sessions and `
        + `${rules.minimumSettledPredictions} settled predictions, and beat the trivial predictor `
        + "on macro-F1 and accuracy.",
    };
  }

  if (incumbent === null) {
    return {
      ...base,
      reason: "INITIAL_PRIMARY_ESTABLISHED",
      primaryModelVersionId: leader.modelVersionId,
      challengerModelVersionId: null,
      explanation:
        `${leader.modelKey} becomes the first volatility PRIMARY on `
        + `${leader.metrics.sampleCount} settled predictions, macro-F1 `
        + `${formatMetric(leader.metrics.macroF1)} against trivial accuracy `
        + `${formatMetric(leader.metrics.trivialAccuracy)}.`,
    };
  }

  if (leader.modelVersionId === incumbent.modelVersionId) {
    return {
      ...base,
      reason: "PRIMARY_RETAINED",
      primaryModelVersionId: incumbent.modelVersionId,
      challengerModelVersionId: ranking[1]?.modelVersionId ?? null,
      explanation: `${incumbent.modelKey} remains the volatility PRIMARY as the ranking leader.`,
    };
  }

  const incumbentF1 = incumbent.metrics.macroF1 ?? 0;
  const challengerF1 = leader.metrics.macroF1 ?? 0;
  const margin = challengerF1 - incumbentF1;
  // Both sides need the deeper sample before a dethroning: a challenger that has just
  // qualified has not out-evidenced a champion measured over far longer.
  const bothDeeplyEvidenced = isDeeplyEvidenced(leader, rules)
    && isDeeplyEvidenced(incumbent, rules);

  if (margin >= rules.promotionMargin && bothDeeplyEvidenced) {
    return {
      ...base,
      reason: "PRIMARY_REPLACED",
      primaryModelVersionId: leader.modelVersionId,
      challengerModelVersionId: leader.modelVersionId,
      explanation:
        `${leader.modelKey} replaces ${incumbent.modelKey}: macro-F1 `
        + `${formatMetric(challengerF1)} vs ${formatMetric(incumbentF1)}, a margin of `
        + `${margin.toFixed(4)} clearing ${rules.promotionMargin}, with both sides past `
        + `${rules.minimumScoredDaysForPromotion} scored sessions and `
        + `${rules.minimumSettledForPromotion} settled predictions.`,
    };
  }

  return {
    ...base,
    reason: "PRIMARY_RETAINED",
    primaryModelVersionId: incumbent.modelVersionId,
    challengerModelVersionId: leader.modelVersionId,
    explanation: bothDeeplyEvidenced
      ? `${leader.modelKey} leads by ${margin.toFixed(4)}, short of the ${rules.promotionMargin} `
        + "margin. Retaining the incumbent rather than promoting on noise."
      // Names which side is short and in which unit: "needs more evidence" is unactionable when
      // the answer could be either more sessions or a wider roster.
      : `${leader.modelKey} leads but both sides need ${rules.minimumScoredDaysForPromotion} scored `
        + `sessions and ${rules.minimumSettledForPromotion} settled predictions before a dethroning `
        + `is considered. Challenger: ${leader.scoredDays} sessions / `
        + `${leader.metrics.sampleCount} rows. Incumbent: ${incumbent.scoredDays} sessions / `
        + `${incumbent.metrics.sampleCount} rows.`,
  };
}

function formatMetric(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(4);
}

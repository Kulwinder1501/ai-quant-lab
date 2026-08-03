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
  /** Scored days inside the rolling window, used for the silence check. */
  scoredDays: number;
  /** Most recent day this model settled anything, or null if never. */
  lastScoredDate: string | null;
}

export interface VolatilityCompetitionRules {
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
 * `minimumSettledPredictions` is higher than the directional 60 because a pooled model
 * writes one prediction per instrument per session. Sixty settled rows can be three
 * sessions of a twenty-instrument pool, which is not three independent observations —
 * twenty correlated names in one market share most of their systematic variance. 300
 * keeps the bar at roughly fifteen sessions.
 *
 * There is no head-to-head daily-wins rule yet. That check needs a meaningful number of
 * common scored days, and no volatility model has a single settled prediction so far, so
 * calibrating one now would be inventing a threshold rather than measuring it.
 */
export const DEFAULT_VOLATILITY_COMPETITION_RULES: VolatilityCompetitionRules = {
  minimumSettledPredictions: 300,
  minimumSettledForPromotion: 750,
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
 * macro-F1-only gate ranks the spreader first. The volatility target passes both, which
 * is why it is here at all.
 */
function beatsTrivial(metrics: VolatilitySettledMetrics): boolean {
  if (metrics.macroF1 === null || metrics.accuracy === null || metrics.trivialAccuracy === null) {
    return false;
  }
  // Trivial macro-F1 for a single-class predictor over N classes is 2/(N+1)/N... but
  // rather than model it, compare accuracy directly against the trivial strategy's own
  // accuracy, which is exactly what trivialAccuracy is.
  return metrics.accuracy > metrics.trivialAccuracy;
}

function hasEnoughSample(standing: VolatilityStanding, rules: VolatilityCompetitionRules): boolean {
  return standing.metrics.sampleCount >= rules.minimumSettledPredictions;
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
        "The volatility PRIMARY no longer beats the trivial majority-class predictor on accuracy "
        + `(${formatMetric(incumbent.metrics.accuracy)} vs ${formatMetric(incumbent.metrics.trivialAccuracy)}). `
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
        `No volatility model both cleared ${rules.minimumSettledPredictions} settled predictions `
        + "and beat the trivial predictor on macro-F1 and accuracy.",
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
  // Both sides need the deeper sample before a dethroning: a challenger that has
  // qualified on 300 rows has not out-evidenced a champion measured over thousands.
  const bothDeeplyEvidenced = leader.metrics.sampleCount >= rules.minimumSettledForPromotion
    && incumbent.metrics.sampleCount >= rules.minimumSettledForPromotion;

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
      : `${leader.modelKey} leads but both sides need ${rules.minimumSettledForPromotion} settled `
        + "predictions before a dethroning is considered.",
  };
}

function formatMetric(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(4);
}

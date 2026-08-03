/**
 * Daily model competition (championâ€“challenger) domain rules.
 *
 * The PRIMARY model is the sole PRODUCTION version of its competition group and
 * the only one whose predictions drive downstream consumers. Every other pool
 * member shadow-predicts to build a live, settled track record. Promotion is
 * decided here, on live outcomes, not on training-time holdout metrics â€” a
 * challenger must beat the champion repeatedly before it takes over.
 */

import { computeAlphabetSettledMetrics, type LabelAlphabet } from "./settled-metrics.js";

export type CompetitionRole = "PRIMARY" | "SECONDARY" | "COMPETITOR";

export const DIRECTIONAL_LABELS = ["BULLISH", "BEARISH", "NEUTRAL"] as const;
export type DirectionalLabel = (typeof DIRECTIONAL_LABELS)[number];

/** NEUTRAL is the directional abstain: the call that declines to pick a side. */
const DIRECTIONAL_ALPHABET: LabelAlphabet<DirectionalLabel> = {
  labels: DIRECTIONAL_LABELS,
  abstainLabel: "NEUTRAL",
  name: "directional",
};

/** One (predicted, realized) cell of a confusion matrix with its observation count. */
export interface ConfusionCell {
  prediction: DirectionalLabel;
  realizedLabel: DirectionalLabel;
  count: number;
}

export interface SettledMetrics {
  sampleCount: number;
  correctCount: number;
  accuracy: number | null;
  macroF1: number | null;
  /** Hit rate among non-NEUTRAL calls; null when the model never committed. */
  directionalHitRate: number | null;
  /**
   * Accuracy of always predicting the most frequent *realized* label over the same
   * settled window — the trivial majority-class strategy.
   *
   * Carried alongside accuracy because macro-F1 alone cannot see it. Macro-F1 rewards
   * spreading predictions across classes, so a model that commits to all three can
   * outscore one that is far more accurate: on a realistic 45/34/21 outcome mix, an
   * always-BULLISH predictor scores macro-F1 0.2500 at 60% accuracy while a worse
   * spreader scores 0.3400 at 39%. Ranking on macro-F1 alone promotes the spreader.
   * That is the same artifact that made triple-barrier look like an improvement.
   */
  trivialAccuracy: number | null;
}

/**
 * Metrics from a settled-prediction confusion matrix.
 *
 * A thin directional binding of `computeAlphabetSettledMetrics`. The arithmetic moved
 * there when the volatility scoreboard needed the identical computation over
 * CONTRACTION/STABLE/EXPANSION; keeping two copies would have meant maintaining the
 * `trivialAccuracy` reasoning twice. Behaviour here is unchanged, including
 * `directionalHitRate`, which is the committed-call hit rate under its directional name.
 *
 * Macro F1 mirrors scikit-learn's `f1_score(average="macro")` over the three directional
 * classes - the same definition the training-time gate uses, so a live score is
 * comparable to a holdout score. Classes absent from both predictions and outcomes
 * contribute an F1 of 0, exactly as sklearn scores a label listed in `labels=` but never
 * observed.
 */
export function computeSettledMetrics(cells: ConfusionCell[]): SettledMetrics {
  const metrics = computeAlphabetSettledMetrics(cells, DIRECTIONAL_ALPHABET);
  return {
    sampleCount: metrics.sampleCount,
    correctCount: metrics.correctCount,
    accuracy: metrics.accuracy,
    macroF1: metrics.macroF1,
    directionalHitRate: metrics.committedHitRate,
    trivialAccuracy: metrics.trivialAccuracy,
  };
}

export interface CompetitionRules {
  /** Rolling window length in scored trading days used for ranking. */
  rollingWindowDays: number;
  /** Settled predictions a model needs inside the window before it can rank. */
  minimumSettledPredictions: number;
  /** Settled predictions BOTH sides need before a dethroning can even be considered. */
  minimumSettledForPromotion: number;
  /** Common scored days compared for the head-to-head promotion check. */
  headToHeadWindowDays: number;
  /** Daily wins the challenger needs inside the head-to-head window. */
  winsRequired: number;
  /** Rolling macro-F1 margin the challenger must clear over the champion. */
  promotionMargin: number;
}

/**
 * Calibrated against the trainer's own noise model (train.py: SE(macro-F1) â‰ˆ 0.5/sqrt(n)):
 * at 250 settled predictions per side, the SE of a macro-F1 *difference* is â‰ˆ 0.044, so
 * the 0.088 margin is a 2-SE filter â€” anything smaller promotes on noise. 6-of-7 daily
 * wins holds the coin-flip pass rate to ~6% (5-of-7 lets 22.7% of pure noise through).
 * The measured gap between the best directional model and the trivial majority-class
 * predictor is ~0.059, i.e. *below* this margin: a promotion firing under these rules
 * requires an edge larger than any observed so far. That is intentional. The competition
 * exists to measure; dethroning a champion should be rare and evidence-backed, not a
 * weekly rotation driven by overlapping-window variance.
 */
export const DEFAULT_COMPETITION_RULES: CompetitionRules = {
  rollingWindowDays: 10,
  minimumSettledPredictions: 60,
  minimumSettledForPromotion: 250,
  headToHeadWindowDays: 7,
  winsRequired: 6,
  promotionMargin: 0.088,
};

export interface PoolMemberStanding {
  modelVersionId: string;
  role: CompetitionRole;
  /** Rolling-window metrics over settled predictions; sampleCount 0 when unscored. */
  rolling: SettledMetrics;
  /** ISO date (YYYY-MM-DD) â†’ that day's settled macro F1, when computable. */
  dailyMacroF1: Record<string, number>;
}

export interface RoleAssignment {
  modelVersionId: string;
  role: CompetitionRole;
  rollingMacroF1: number | null;
}

export interface PromotionDecision {
  newPrimaryId: string;
  /** Null for an initial crowning: a group that never had a champion. */
  previousPrimaryId: string | null;
  challengerRollingMacroF1: number;
  primaryRollingMacroF1: number | null;
  winsInWindow: number;
  comparedDays: number;
  rules: CompetitionRules;
}

export interface CompetitionDecision {
  assignments: RoleAssignment[];
  promotion: PromotionDecision | null;
  /** Head-to-head progress for observability even when no promotion fires. */
  headToHead: { challengerId: string; winsInWindow: number; comparedDays: number } | null;
  /**
   * A PRIMARY that produced nothing in the rolling window and was stood down so the pool
   * could re-crown. Reported rather than silent: a champion going dark is an operational
   * fault, not a routine role change.
   */
  demotedSilentPrimaryId: string | null;
}

function isEligible(member: PoolMemberStanding, rules: CompetitionRules): boolean {
  return member.rolling.macroF1 !== null && member.rolling.sampleCount >= rules.minimumSettledPredictions;
}

/**
 * Whether a model is more accurate than always predicting the commonest outcome.
 *
 * A necessary condition for taking the title, checked separately from the macro-F1
 * margin because macro-F1 cannot see it: a model that spreads its calls across all three
 * classes scores well on macro-F1 while being less accurate than a one-class predictor.
 * Ranking stays on macro-F1 — it is the metric the trainer gates on and is robust to
 * class imbalance — but a model that cannot beat the trivial strategy has no business
 * driving trade ideas, whatever its macro-F1 says.
 *
 * Deliberately a strict inequality with no margin. The 2-SE macro-F1 margin already
 * supplies the statistical strength; this is a floor, not a second significance test, and
 * stacking two margins would make promotion unreachable rather than merely rare.
 *
 * Eligibility is left alone on purpose, so a challenger that loses to trivial still ranks
 * and still shows up in head-to-head reporting. It simply cannot be crowned.
 */
function beatsTrivial(member: PoolMemberStanding): boolean {
  const { accuracy, trivialAccuracy } = member.rolling;
  if (accuracy === null || trivialAccuracy === null) return false;
  return accuracy > trivialAccuracy;
}

/**
 * A champion that has stopped producing settled predictions.
 *
 * `sampleCount === 0` over the whole rolling window means the model contributed nothing —
 * its artifact fails to load, its feature schema was superseded, or inference is failing
 * silently. That is different from merely low volume, which `isEligible` already handles,
 * so the test is "produced nothing at all" rather than "produced too little".
 *
 * It has to be detected, because every promotion condition compares the challenger
 * *against* the champion: head-to-head needs common scored days, and both sides need
 * `minimumSettledForPromotion` settled predictions. A silent champion fails all of them,
 * which locked it in permanently — and `removeStaleUnscoredMembers` only deletes
 * COMPETITORs that never scored, so it could not reach a PRIMARY either. This project has
 * already orphaned two PRODUCTION models with a feature-schema bump, so it is not
 * hypothetical.
 */
function hasGoneSilent(member: PoolMemberStanding): boolean {
  return member.rolling.sampleCount === 0;
}

function headToHeadWins(
  challenger: PoolMemberStanding,
  primary: PoolMemberStanding,
  rules: CompetitionRules,
): { wins: number; comparedDays: number } {
  const commonDays = Object.keys(challenger.dailyMacroF1)
    .filter((day) => day in primary.dailyMacroF1)
    .sort()
    .slice(-rules.headToHeadWindowDays);
  let wins = 0;
  for (const day of commonDays) {
    if (challenger.dailyMacroF1[day] > primary.dailyMacroF1[day]) wins += 1;
  }
  return { wins, comparedDays: commonDays.length };
}

/**
 * Rank the pool and decide roles for the day.
 *
 * The reigning PRIMARY keeps its title unless the top-ranked challenger clears
 * every promotion condition: full head-to-head evidence, enough daily wins, and
 * a rolling macro-F1 margin. Rankings alone never change the champion â€” that is
 * what keeps one lucky day from rotating production models.
 */
export function decideCompetition(
  members: PoolMemberStanding[],
  rules: CompetitionRules = DEFAULT_COMPETITION_RULES,
): CompetitionDecision {
  if (members.length === 0) {
    return { assignments: [], promotion: null, headToHead: null, demotedSilentPrimaryId: null };
  }
  const primaries = members.filter((member) => member.role === "PRIMARY");
  if (primaries.length > 1) {
    throw new Error("A competition group cannot have more than one PRIMARY model.");
  }
  const reigning = primaries[0] ?? null;
  // Stood down before the challenger logic runs, because every promotion condition below
  // compares against the champion and a silent one fails all of them.
  const silentPrimary = reigning !== null && hasGoneSilent(reigning) ? reigning : null;
  const currentPrimary = silentPrimary === null ? reigning : null;

  // Without a champion (bootstrap), the best eligible model takes the title;
  // if nobody has enough live evidence yet, nothing changes today. The initial
  // crowning is reported as a promotion with no previous primary, so the caller
  // can stage-promote the winner and record it in the promotion audit trail.
  if (!currentPrimary) {
    // A model that loses to the trivial predictor is not crowned, even with no incumbent:
    // an empty title is better than one held by something worse than always guessing the
    // commonest outcome.
    const eligible = members
      .filter((member) => isEligible(member, rules) && beatsTrivial(member))
      .sort((a, b) => (b.rolling.macroF1 ?? 0) - (a.rolling.macroF1 ?? 0));
    const chosen = eligible[0] ?? null;
    return {
      assignments: assignRoles(members, chosen?.modelVersionId ?? null, eligible[1]?.modelVersionId ?? null),
      promotion: chosen === null || chosen.rolling.macroF1 === null
        ? null
        : {
          newPrimaryId: chosen.modelVersionId,
          previousPrimaryId: null,
          challengerRollingMacroF1: chosen.rolling.macroF1,
          primaryRollingMacroF1: null,
          winsInWindow: 0,
          comparedDays: 0,
          rules,
        },
      headToHead: null,
      demotedSilentPrimaryId: silentPrimary?.modelVersionId ?? null,
    };
  }

  const challengers = members
    .filter((member) => member.modelVersionId !== currentPrimary.modelVersionId && isEligible(member, rules))
    .sort((a, b) => (b.rolling.macroF1 ?? 0) - (a.rolling.macroF1 ?? 0));
  const challenger = challengers[0] ?? null;

  if (!challenger) {
    return {
      assignments: assignRoles(members, currentPrimary.modelVersionId, null),
      promotion: null,
      headToHead: null,
      demotedSilentPrimaryId: null,
    };
  }

  const { wins, comparedDays } = headToHeadWins(challenger, currentPrimary, rules);
  const challengerScore = challenger.rolling.macroF1;
  const primaryScore = currentPrimary.rolling.macroF1;
  const promotes =
    comparedDays >= rules.headToHeadWindowDays
    && wins >= rules.winsRequired
    && challengerScore !== null
    && primaryScore !== null
    && isEligible(currentPrimary, rules)
    && challenger.rolling.sampleCount >= rules.minimumSettledForPromotion
    && currentPrimary.rolling.sampleCount >= rules.minimumSettledForPromotion
    && challengerScore >= primaryScore + rules.promotionMargin
    // Necessary condition macro-F1 cannot express: a challenger that loses to always
    // predicting the commonest outcome does not take over, however well it spreads its
    // calls across classes.
    && beatsTrivial(challenger);

  if (!promotes) {
    return {
      assignments: assignRoles(members, currentPrimary.modelVersionId, challenger.modelVersionId),
      promotion: null,
      headToHead: { challengerId: challenger.modelVersionId, winsInWindow: wins, comparedDays },
      demotedSilentPrimaryId: null,
    };
  }

  return {
    // The dethroned champion becomes SECONDARY: it keeps shadow-predicting and
    // may win the title back, rather than being archived on the spot.
    assignments: assignRoles(members, challenger.modelVersionId, currentPrimary.modelVersionId),
    promotion: {
      newPrimaryId: challenger.modelVersionId,
      previousPrimaryId: currentPrimary.modelVersionId,
      challengerRollingMacroF1: challengerScore,
      primaryRollingMacroF1: primaryScore,
      winsInWindow: wins,
      comparedDays,
      rules,
    },
    headToHead: { challengerId: challenger.modelVersionId, winsInWindow: wins, comparedDays },
    demotedSilentPrimaryId: null,
  };

  function assignRoles(
    pool: PoolMemberStanding[],
    primaryId: string | null,
    secondaryId: string | null,
  ): RoleAssignment[] {
    return pool.map((member) => ({
      modelVersionId: member.modelVersionId,
      role: member.modelVersionId === primaryId
        ? "PRIMARY"
        : member.modelVersionId === secondaryId
          ? "SECONDARY"
          : "COMPETITOR",
      rollingMacroF1: member.rolling.macroF1,
    }));
  }
}

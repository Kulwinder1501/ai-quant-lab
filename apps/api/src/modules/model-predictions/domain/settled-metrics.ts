/**
 * Confusion-matrix metrics over an arbitrary label alphabet.
 *
 * Extracted from `model-competition.ts`, which computed exactly this over the three
 * directional labels. The volatility scoreboard needs the same arithmetic over
 * CONTRACTION/STABLE/EXPANSION, and duplicating it would mean maintaining the
 * `trivialAccuracy` reasoning twice — the one guard that distinguishes real skill from
 * spreading predictions across classes, and the reason the directional target was
 * finally seen to be worthless. One implementation, two alphabets.
 *
 * The directional entry point keeps its exact previous behaviour; nothing about the
 * live directional scoreboard changes.
 */

export interface LabelAlphabet<TLabel extends string> {
  /** Canonical order. Absent labels score F1 0, matching sklearn's `labels=`. */
  readonly labels: readonly TLabel[];
  /**
   * The label that declines to commit — NEUTRAL directionally, STABLE for volatility.
   * The "committed hit rate" is computed over everything else, which is the figure
   * comparable to a binary "right N% of the time" claim.
   */
  readonly abstainLabel: TLabel;
  /** Used in error messages so a bad cell says which alphabet it violated. */
  readonly name: string;
}

export interface GenericConfusionCell<TLabel extends string> {
  prediction: TLabel;
  realizedLabel: TLabel;
  count: number;
}

export interface GenericSettledMetrics {
  sampleCount: number;
  correctCount: number;
  accuracy: number | null;
  macroF1: number | null;
  /** Hit rate among committed (non-abstain) calls; null when the model never committed. */
  committedHitRate: number | null;
  /**
   * Accuracy of always predicting the most frequent *realized* label over the same
   * settled window — the trivial majority-class strategy.
   *
   * Carried alongside accuracy because macro-F1 alone cannot see it. Macro-F1 rewards
   * spreading predictions across classes, so a model that commits to all three can
   * outscore one that is far more accurate. Ranking on macro-F1 alone promotes the
   * spreader; that artifact is what made the directional target look viable for as
   * long as it did.
   */
  trivialAccuracy: number | null;
}

export function computeAlphabetSettledMetrics<TLabel extends string>(
  cells: readonly GenericConfusionCell<TLabel>[],
  alphabet: LabelAlphabet<TLabel>,
): GenericSettledMetrics {
  let sampleCount = 0;
  let correctCount = 0;
  let committedCount = 0;
  let committedCorrect = 0;
  const truePositive = new Map<TLabel, number>();
  const predictedTotal = new Map<TLabel, number>();
  const realizedTotal = new Map<TLabel, number>();

  for (const cell of cells) {
    if (!alphabet.labels.includes(cell.prediction) || !alphabet.labels.includes(cell.realizedLabel)) {
      throw new Error(
        `Confusion cell labels must be one of ${alphabet.labels.join(", ")} (${alphabet.name}).`,
      );
    }
    if (!Number.isInteger(cell.count) || cell.count < 0) {
      throw new Error("Confusion cell count must be a non-negative integer.");
    }
    sampleCount += cell.count;
    predictedTotal.set(cell.prediction, (predictedTotal.get(cell.prediction) ?? 0) + cell.count);
    realizedTotal.set(cell.realizedLabel, (realizedTotal.get(cell.realizedLabel) ?? 0) + cell.count);
    if (cell.prediction === cell.realizedLabel) {
      correctCount += cell.count;
      truePositive.set(cell.prediction, (truePositive.get(cell.prediction) ?? 0) + cell.count);
    }
    if (cell.prediction !== alphabet.abstainLabel) {
      committedCount += cell.count;
      if (cell.prediction === cell.realizedLabel) {
        committedCorrect += cell.count;
      }
    }
  }

  if (sampleCount === 0) {
    return {
      sampleCount: 0,
      correctCount: 0,
      accuracy: null,
      macroF1: null,
      committedHitRate: null,
      trivialAccuracy: null,
    };
  }

  let f1Sum = 0;
  for (const label of alphabet.labels) {
    const tp = truePositive.get(label) ?? 0;
    const predicted = predictedTotal.get(label) ?? 0;
    const realized = realizedTotal.get(label) ?? 0;
    // F1 = 2tp / (predicted + realized); zero when the label never appears.
    f1Sum += predicted + realized === 0 ? 0 : (2 * tp) / (predicted + realized);
  }

  // The majority class is read from realized outcomes, not predictions: the baseline is
  // "what would always guessing the commonest actual outcome have scored".
  const largestRealized = Math.max(...alphabet.labels.map((label) => realizedTotal.get(label) ?? 0));

  return {
    sampleCount,
    correctCount,
    accuracy: correctCount / sampleCount,
    macroF1: f1Sum / alphabet.labels.length,
    committedHitRate: committedCount === 0 ? null : committedCorrect / committedCount,
    trivialAccuracy: largestRealized / sampleCount,
  };
}

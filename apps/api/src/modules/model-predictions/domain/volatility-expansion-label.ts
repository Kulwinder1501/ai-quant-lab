/**
 * The volatility-expansion label rule, as settlement must apply it.
 *
 * This is a deliberate second implementation of
 * `apps/ml/ai_quant_lab_ml/volatility_expansion.py`. Training labels a bar in Python;
 * settlement grades a live prediction here. If the two rules diverge, a model's live
 * scoreboard silently measures something other than what it was trained to predict —
 * which is exactly the class of drift `0d66e16` made loud for the directional path.
 *
 * The invariants that must not drift:
 *
 * * equal window lengths — the trailing window is the K bars *ending at* the source
 *   bar, the forward window the K bars *after* it, so the ratio reads directly as
 *   "wider or narrower than the recent past" with no horizon constant to calibrate;
 * * multiplicative thresholds — EXPANSION at `ratio >= 1 + band`, CONTRACTION at
 *   `ratio <= 1 / (1 + band)`. The reciprocal, never `1 - band`: a range ratio is
 *   multiplicative, so 2x wider and 2x narrower are the symmetric pair, and
 *   `1 - band` would make contraction a materially smaller target and skew the class
 *   balance for no reason;
 * * refusal over guessing — a flat trailing window has no scale to compare against,
 *   and an incomplete forward window is right-censored. Both return unmeasurable.
 *   Grading either as STABLE would manufacture agreement precisely where the
 *   evidence is absent, and would do it at the most recent end of the series.
 */

export const VOLATILITY_LABELS = ["CONTRACTION", "STABLE", "EXPANSION"] as const;
export type VolatilityLabel = (typeof VOLATILITY_LABELS)[number];

/** Structural counterpart of NEUTRAL: the call that declines to predict a change. */
export const VOLATILITY_ABSTAIN_LABEL: VolatilityLabel = "STABLE";

export function isVolatilityLabel(value: unknown): value is VolatilityLabel {
  return typeof value === "string" && (VOLATILITY_LABELS as readonly string[]).includes(value);
}

export interface RangeBar {
  high: number;
  low: number;
}

export type VolatilityGrade =
  | {
    measurable: true;
    label: VolatilityLabel;
    rangeRatio: number;
    forwardRange: number;
    trailingRange: number;
  }
  | { measurable: false; reason: string };

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function envelope(bars: readonly RangeBar[]): number {
  return Math.max(...bars.map((bar) => bar.high)) - Math.min(...bars.map((bar) => bar.low));
}

export interface GradeVolatilityInput {
  /** The K bars ending at (and including) the prediction's source bar. */
  trailingBars: readonly RangeBar[];
  /** The K bars strictly after the source bar. */
  forwardBars: readonly RangeBar[];
  /** K. Both windows must supply exactly this many bars. */
  horizonBars: number;
  /** The model's own `validationProtocol.expansionBand` — never a default. */
  band: number;
}

/**
 * Grades a matured volatility prediction against realised bars.
 *
 * `band` is required rather than defaulted. The band *is* the label rule, so reading
 * it from anywhere other than the model's recorded protocol would let a model trained
 * at 0.25 be scored at 0.30 with nothing in the data to show it happened.
 */
export function gradeVolatilityOutcome(input: GradeVolatilityInput): VolatilityGrade {
  const { trailingBars, forwardBars, horizonBars, band } = input;

  if (!Number.isInteger(horizonBars) || horizonBars <= 0) {
    throw new Error("horizonBars must be a positive integer.");
  }
  if (!finitePositive(band)) {
    throw new Error("The expansion band must be a positive, finite number.");
  }

  if (trailingBars.length < horizonBars) {
    return {
      measurable: false,
      reason: `Trailing window has ${trailingBars.length} of ${horizonBars} required bars.`,
    };
  }
  // Right-censoring, not an error: the forward envelope is simply not complete yet
  // and would look artificially narrow.
  if (forwardBars.length < horizonBars) {
    return {
      measurable: false,
      reason: `Forward window has ${forwardBars.length} of ${horizonBars} required bars; not yet matured.`,
    };
  }

  const trailing = trailingBars.slice(-horizonBars);
  const forward = forwardBars.slice(0, horizonBars);
  for (const bar of [...trailing, ...forward]) {
    if (!Number.isFinite(bar.high) || !Number.isFinite(bar.low)) {
      return { measurable: false, reason: "A bar has a non-finite high or low." };
    }
    if (bar.high < bar.low) {
      return { measurable: false, reason: "A bar has high below low." };
    }
  }

  const trailingRange = envelope(trailing);
  if (!finitePositive(trailingRange)) {
    // A flat window has no scale, so the ratio is undefined. Reported rather than
    // graded — dividing by zero would be an infinite "expansion".
    return { measurable: false, reason: "The trailing range is not positive, so the ratio is undefined." };
  }
  const forwardRange = envelope(forward);
  const rangeRatio = forwardRange / trailingRange;

  const expansionThreshold = 1 + band;
  const contractionThreshold = 1 / (1 + band);
  const label: VolatilityLabel = rangeRatio >= expansionThreshold
    ? "EXPANSION"
    : rangeRatio <= contractionThreshold
      ? "CONTRACTION"
      : "STABLE";

  return { measurable: true, label, rangeRatio, forwardRange, trailingRange };
}

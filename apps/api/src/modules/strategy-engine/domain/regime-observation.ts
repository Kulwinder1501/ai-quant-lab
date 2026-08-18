import {
  regimeSourceIndicatorAlgorithmVersion,
  regimeSourceIndicatorCode,
  regimeSourceIndicatorPeriod,
  regimeSourceInstrumentSymbol,
  regimeStalenessBars,
  type RegimeContext,
} from "./regime.js";

/**
 * What the market looked like at the moment a decision was taken, recorded once and never
 * re-derived.
 *
 * ## Why this is stored rather than computed later
 *
 * Both regime readings this system has are derived from mutable inputs. The volatility regime in
 * `regime.ts` is India VIX close over its own SMA(20), and both terms come from `candles` and
 * `indicator_snapshots` -- series that get backfilled, revised, and recomputed under new algorithm
 * versions. The model regime comes from `auxiliary_model_predictions`, filtered to the model
 * currently in PRODUCTION, so promoting a new model silently changes what a past bar "was".
 *
 * So asking "did trades opened in HIGH_VOL fare worse?" six months from now by re-deriving regime
 * asks a different question than the one the bot answered at the time, and the two can disagree
 * without anything being wrong. Recording the reading makes the answer stable. That is the whole
 * value here: this record changes no trading behaviour and is not read by any executor.
 *
 * ## Unknown is a reading
 *
 * `deriveVolatilityRegime` returns null for a gap in the VIX series rather than defaulting to
 * LOW_VOL, and `findVolatilityRegime` returns null when no PRODUCTION prediction is within the
 * staleness window. Both nulls survive into the record. A row where both are absent is not junk --
 * it says the market was observed and could not be classified, which is a different fact from no
 * observation at all, and only the stored row can tell those apart afterwards.
 */

export type VolatilityRegimeLabel = "HIGH_VOL" | "LOW_VOL";
export type ModelRegimeLabel = "CONTRACTION" | "STABLE" | "EXPANSION";

export const modelRegimeLabels: readonly ModelRegimeLabel[] = ["CONTRACTION", "STABLE", "EXPANSION"];

/** The model's volatility verdict as it stood at `observedAt`. */
export interface ModelRegimeReading {
  readonly prediction: ModelRegimeLabel;
  readonly confidence: number;
  /** Evidence boundary of the prediction. Must not be later than `observedAt`. */
  readonly evidenceCutoffAt: Date;
}

/**
 * How much of the market could be classified.
 *
 * Recorded explicitly instead of being inferred from two null checks at query time, because the
 * distinction that matters -- observed-and-unclassifiable versus never-observed -- is the one a
 * `WHERE regime IS NULL` cannot make.
 */
export type RegimeObservationCompleteness = "BOTH" | "VOLATILITY_ONLY" | "MODEL_ONLY" | "NEITHER";

export interface RegimeObservationProvenance {
  /** Constants from `regime.ts`. Changing any of them changes what a stored label meant. */
  readonly volatilitySourceSymbol: string;
  readonly volatilityIndicatorCode: string;
  readonly volatilityIndicatorPeriod: number;
  readonly volatilityIndicatorAlgorithmVersion: string;
  readonly volatilityStalenessBars: number;
  /** Label alphabet of the auxiliary prediction the model reading came from. */
  readonly modelLabelScheme: string;
}

export interface RegimeObservation {
  readonly instrumentId: string;
  readonly timeframe: string;
  /** The bar the observation describes, or null when it was not taken on a bar. */
  readonly sourceCandleId: string | null;
  /** The caller's decision time, never wall-clock at insert. */
  readonly observedAt: Date;
  readonly volatilityRegime: VolatilityRegimeLabel | null;
  /** VIX close over VIX SMA(20). Kept alongside the label so a threshold change stays auditable. */
  readonly volatilityValueRatio: number | null;
  readonly modelRegime: ModelRegimeLabel | null;
  readonly modelConfidence: number | null;
  readonly modelEvidenceCutoffAt: Date | null;
  readonly completeness: RegimeObservationCompleteness;
  readonly provenance: RegimeObservationProvenance;
}

export interface BuildRegimeObservationInput {
  readonly instrumentId: string;
  readonly timeframe: string;
  readonly sourceCandleId?: string | null;
  readonly observedAt: Date;
  /** As returned by `deriveVolatilityRegime`; absent or null both mean unknown. */
  readonly volatility?: RegimeContext | null;
  /** As returned by `findVolatilityRegime`; absent or null both mean unknown. */
  readonly model?: ModelRegimeReading | null;
  readonly modelLabelScheme: string;
}

function completenessOf(
  volatility: VolatilityRegimeLabel | null,
  model: ModelRegimeLabel | null,
): RegimeObservationCompleteness {
  if (volatility !== null && model !== null) return "BOTH";
  if (volatility !== null) return "VOLATILITY_ONLY";
  if (model !== null) return "MODEL_ONLY";
  return "NEITHER";
}

/**
 * Assembles one observation, dropping any reading that could not have been known at `observedAt`.
 *
 * A model prediction whose `evidenceCutoffAt` is after `observedAt` is treated as **absent**, not as
 * a late arrival to be kept: the record's only job is to say what was visible at decision time, and
 * a reading from the future recorded as though it were visible is worse than no reading, because
 * every later analysis would trust it. The repository that supplies it already filters on
 * `evidence_cutoff_at <= asOf`, so this catches a caller that passes the wrong clock rather than a
 * routine case -- which is exactly when a silent pass-through would do the most damage.
 */
export function buildRegimeObservation(input: BuildRegimeObservationInput): RegimeObservation {
  if (Number.isNaN(input.observedAt.getTime())) {
    throw new Error("A regime observation needs a valid observation time.");
  }
  if (input.timeframe.trim().length === 0) {
    throw new Error("A regime observation needs a timeframe.");
  }

  const volatility = input.volatility ?? null;
  const candidateModel = input.model ?? null;
  const model = candidateModel !== null
    && candidateModel.evidenceCutoffAt.getTime() <= input.observedAt.getTime()
    && Number.isFinite(candidateModel.confidence)
    ? candidateModel
    : null;

  const volatilityRegime = volatility?.regime ?? null;
  const modelRegime = model?.prediction ?? null;

  return {
    instrumentId: input.instrumentId,
    timeframe: input.timeframe,
    sourceCandleId: input.sourceCandleId ?? null,
    observedAt: input.observedAt,
    volatilityRegime,
    volatilityValueRatio: volatility === null || !Number.isFinite(volatility.valueRatio)
      ? null
      : volatility.valueRatio,
    modelRegime,
    modelConfidence: model?.confidence ?? null,
    modelEvidenceCutoffAt: model?.evidenceCutoffAt ?? null,
    completeness: completenessOf(volatilityRegime, modelRegime),
    provenance: {
      volatilitySourceSymbol: regimeSourceInstrumentSymbol,
      volatilityIndicatorCode: regimeSourceIndicatorCode,
      volatilityIndicatorPeriod: regimeSourceIndicatorPeriod,
      volatilityIndicatorAlgorithmVersion: regimeSourceIndicatorAlgorithmVersion,
      volatilityStalenessBars: regimeStalenessBars,
      modelLabelScheme: input.modelLabelScheme,
    },
  };
}

import type { QueryResultRow } from "pg";
import type {
  ModelRegimeLabel,
  RegimeObservation,
  RegimeObservationCompleteness,
  RegimeObservationProvenance,
  VolatilityRegimeLabel,
} from "../../../modules/strategy-engine/domain/regime-observation.js";
import type { DatabaseQueryable } from "../database.js";

interface RegimeObservationRow extends QueryResultRow {
  id: string;
  instrument_id: string;
  timeframe: string;
  source_candle_id: string | null;
  observed_at: Date;
  volatility_regime: VolatilityRegimeLabel | null;
  volatility_value_ratio: string | null;
  model_regime: ModelRegimeLabel | null;
  model_confidence: string | null;
  model_evidence_cutoff_at: Date | null;
  completeness: RegimeObservationCompleteness;
  provenance: Record<string, unknown>;
}

export interface StoredRegimeObservation extends RegimeObservation {
  readonly id: string;
}

function toNumberOrNull(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Reads the provenance back, refusing a row that does not carry all of it.
 *
 * Parsed rather than cast. The whole reason the provenance is stored is that a label means nothing
 * without the constants that produced it, so a row missing them is not a usable observation, and
 * casting would hand the caller a half-populated object that reads as a complete one.
 */
function toProvenance(value: Record<string, unknown>): RegimeObservationProvenance {
  const {
    volatilitySourceSymbol,
    volatilityIndicatorCode,
    volatilityIndicatorPeriod,
    volatilityIndicatorAlgorithmVersion,
    volatilityStalenessBars,
    modelLabelScheme,
  } = value;
  if (
    typeof volatilitySourceSymbol !== "string"
    || typeof volatilityIndicatorCode !== "string"
    || typeof volatilityIndicatorPeriod !== "number"
    || typeof volatilityIndicatorAlgorithmVersion !== "string"
    || typeof volatilityStalenessBars !== "number"
    || typeof modelLabelScheme !== "string"
  ) {
    throw new Error("A stored regime observation is missing the provenance that defines its labels.");
  }
  return {
    volatilitySourceSymbol,
    volatilityIndicatorCode,
    volatilityIndicatorPeriod,
    volatilityIndicatorAlgorithmVersion,
    volatilityStalenessBars,
    modelLabelScheme,
  };
}

function toObservation(row: RegimeObservationRow): StoredRegimeObservation {
  return {
    id: row.id,
    instrumentId: row.instrument_id,
    timeframe: row.timeframe,
    sourceCandleId: row.source_candle_id,
    observedAt: row.observed_at,
    volatilityRegime: row.volatility_regime,
    volatilityValueRatio: toNumberOrNull(row.volatility_value_ratio),
    modelRegime: row.model_regime,
    modelConfidence: toNumberOrNull(row.model_confidence),
    modelEvidenceCutoffAt: row.model_evidence_cutoff_at,
    completeness: row.completeness,
    provenance: toProvenance(row.provenance),
  };
}

/**
 * Append-only writer for `regime_observations`.
 *
 * There is no update and no delete, and that is the contract rather than an omission: the table
 * exists so a past reading stays the reading that was taken, and a method that could revise one
 * would defeat the only reason to store it.
 *
 * `record` is idempotent on the bar. Successive bot cycles inside one five-minute bar re-read the
 * same completed bar, so without a first-writer-wins key the table would grow a near-duplicate row
 * per cycle and a later `GROUP BY regime` would count the same bar several times.
 */
export class PostgresRegimeObservationRepository {
  constructor(private readonly database: DatabaseQueryable) {}

  /**
   * Records an observation and returns it, or returns the observation already held for that bar.
   *
   * The `DO NOTHING` plus re-select is deliberate over `DO UPDATE`: a repeat observation of the same
   * bar must not overwrite the first, because the first is the one that was in hand when the bar was
   * acted on. The re-select then hands the caller the winning row's id, so a trade opened on a later
   * cycle still points at the reading its decision actually used.
   */
  async record(observation: RegimeObservation): Promise<StoredRegimeObservation> {
    const parameters = [
      observation.instrumentId,
      observation.timeframe,
      observation.sourceCandleId,
      observation.observedAt,
      observation.volatilityRegime,
      observation.volatilityValueRatio,
      observation.modelRegime,
      observation.modelConfidence,
      observation.modelEvidenceCutoffAt,
      observation.completeness,
      JSON.stringify(observation.provenance),
    ];

    const inserted = await this.database.query<RegimeObservationRow>(`
      INSERT INTO regime_observations (
        instrument_id, timeframe, source_candle_id, observed_at,
        volatility_regime, volatility_value_ratio,
        model_regime, model_confidence, model_evidence_cutoff_at,
        completeness, provenance
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
      ON CONFLICT (instrument_id, timeframe, source_candle_id)
        WHERE source_candle_id IS NOT NULL
        DO NOTHING
      RETURNING
        id, instrument_id, timeframe, source_candle_id, observed_at,
        volatility_regime, volatility_value_ratio,
        model_regime, model_confidence, model_evidence_cutoff_at,
        completeness, provenance
    `, parameters);

    const row = inserted.rows[0];
    if (row) {
      return toObservation(row);
    }

    // Only reachable when the bar already had an observation, which the unique index guarantees is
    // exactly one row.
    const existing = await this.findByBar({
      instrumentId: observation.instrumentId,
      timeframe: observation.timeframe,
      sourceCandleId: observation.sourceCandleId,
    });
    if (!existing) {
      throw new Error(
        "Recording a regime observation neither inserted a row nor found the conflicting one.",
      );
    }
    return existing;
  }

  async findByBar(input: {
    instrumentId: string;
    timeframe: string;
    sourceCandleId: string | null;
  }): Promise<StoredRegimeObservation | null> {
    if (input.sourceCandleId === null) return null;
    const result = await this.database.query<RegimeObservationRow>(`
      SELECT
        id, instrument_id, timeframe, source_candle_id, observed_at,
        volatility_regime, volatility_value_ratio,
        model_regime, model_confidence, model_evidence_cutoff_at,
        completeness, provenance
      FROM regime_observations
      WHERE instrument_id = $1 AND timeframe = $2 AND source_candle_id = $3
    `, [input.instrumentId, input.timeframe, input.sourceCandleId]);
    const row = result.rows[0];
    return row ? toObservation(row) : null;
  }
}

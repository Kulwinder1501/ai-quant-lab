import type { DatabasePool } from "../../../infrastructure/database/database.js";

export interface RiskControlResult {
  regime: "EXPANSION" | "CONTRACTION" | "STABLE" | "UNKNOWN";
  adjustedLots: number;
  stopMultiplier: number;
}

export interface VolatilityRiskInput {
  baseLots: number;
  instrumentId: string;
  asOf?: Date;
  maxAgeMinutes?: number;
}

export class VolatilityRiskControl {
  constructor(private readonly database: DatabasePool) {}

  /**
   * Evaluates the latest settled or unsettled volatility prediction to adjust
   * position sizing and stop loss width for option buying.
   */
  async evaluateRisk(input: VolatilityRiskInput): Promise<RiskControlResult> {
    if (!Number.isFinite(input.baseLots) || input.baseLots <= 0) {
      throw new Error("baseLots must be a positive finite number.");
    }
    const asOf = input.asOf ?? new Date();
    const maxAgeMinutes = Math.max(1, Math.floor(input.maxAgeMinutes ?? 60));
    const result = await this.database.query<{ prediction: string; confidence: string }>(`
      SELECT p.prediction, p.confidence
      FROM auxiliary_model_predictions p
      INNER JOIN model_versions m ON p.model_version_id = m.id
      WHERE p.instrument_id = $1
        AND p.label_scheme = 'volatility-expansion-v1'
        AND m.stage = 'PRODUCTION'
        AND p.evidence_cutoff_at <= $2
        AND p.evidence_cutoff_at >= $2 - make_interval(mins => $3::integer)
      ORDER BY p.evidence_cutoff_at DESC, p.created_at DESC
      LIMIT 1
    `, [input.instrumentId, asOf, maxAgeMinutes]);

    const row = result.rows[0];
    const prediction = row !== undefined && Number(row.confidence) >= 0.5
      ? row.prediction
      : "UNKNOWN";

    switch (prediction) {
      case "EXPANSION":
        return {
          regime: "EXPANSION",
          // Expansion increases stop-out risk; never increase unattended exposure.
          adjustedLots: input.baseLots * 0.5,
          stopMultiplier: 1.0,
        };
      case "CONTRACTION":
        return {
          regime: "CONTRACTION",
          adjustedLots: input.baseLots,
          stopMultiplier: 1.0,
        };
      case "STABLE":
      default:
        return {
          regime: prediction === "STABLE" ? "STABLE" : "UNKNOWN",
          adjustedLots: input.baseLots,
          stopMultiplier: 1.0,
        };
    }
  }
}

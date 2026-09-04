/**
 * Pipeline versions stamped on every Stock Intelligence artifact.
 *
 * These start at v0.1 with Gate 1. Bumping a version is a model change: it requires a
 * replay re-run once the harness exists. They live in one file so a snapshot cannot
 * silently mix engines from different vintages.
 */
export const STOCK_INTELLIGENCE_DATA_SCHEMA_VERSION = "v0.1";
export const STOCK_INTELLIGENCE_FEATURE_VERSION = "v0.1";
export const STOCK_INTELLIGENCE_FUNDAMENTAL_ENGINE_VERSION = "v0.1";
export const STOCK_INTELLIGENCE_TECHNICAL_ENGINE_VERSION = "v0.1";
export const STOCK_INTELLIGENCE_VALUATION_ENGINE_VERSION = "v0.1";
export const STOCK_INTELLIGENCE_REGIME_MODEL_VERSION = "v0.1";
export const STOCK_INTELLIGENCE_ANALOGUE_METHOD_VERSION = "v0.1";
export const STOCK_INTELLIGENCE_OUTCOME_MODEL_VERSION = "v0.1";
export const STOCK_INTELLIGENCE_CALIBRATION_MODEL_VERSION = "v0.1";
export const STOCK_INTELLIGENCE_EXTRACTION_VERSION = "v0.1";
export const STOCK_INTELLIGENCE_CORPORATE_ACTION_ADJUSTMENT_VERSION = "v0.1";
export const STOCK_INTELLIGENCE_REPLAY_HARNESS_VERSION = "v0.1";

export interface StockIntelligenceVersions {
  readonly dataSchema: typeof STOCK_INTELLIGENCE_DATA_SCHEMA_VERSION;
  readonly feature: typeof STOCK_INTELLIGENCE_FEATURE_VERSION;
  readonly fundamentalEngine: typeof STOCK_INTELLIGENCE_FUNDAMENTAL_ENGINE_VERSION;
  readonly technicalEngine: typeof STOCK_INTELLIGENCE_TECHNICAL_ENGINE_VERSION;
  readonly valuationEngine: typeof STOCK_INTELLIGENCE_VALUATION_ENGINE_VERSION;
  readonly regimeModel: typeof STOCK_INTELLIGENCE_REGIME_MODEL_VERSION;
  readonly analogueMethod: typeof STOCK_INTELLIGENCE_ANALOGUE_METHOD_VERSION;
  readonly outcomeModel: typeof STOCK_INTELLIGENCE_OUTCOME_MODEL_VERSION;
  readonly calibrationModel: typeof STOCK_INTELLIGENCE_CALIBRATION_MODEL_VERSION;
  readonly extraction: typeof STOCK_INTELLIGENCE_EXTRACTION_VERSION;
  readonly corporateActionAdjustment: typeof STOCK_INTELLIGENCE_CORPORATE_ACTION_ADJUSTMENT_VERSION;
  readonly replayHarness: typeof STOCK_INTELLIGENCE_REPLAY_HARNESS_VERSION;
}

export const stockIntelligenceVersions: StockIntelligenceVersions = {
  dataSchema: STOCK_INTELLIGENCE_DATA_SCHEMA_VERSION,
  feature: STOCK_INTELLIGENCE_FEATURE_VERSION,
  fundamentalEngine: STOCK_INTELLIGENCE_FUNDAMENTAL_ENGINE_VERSION,
  technicalEngine: STOCK_INTELLIGENCE_TECHNICAL_ENGINE_VERSION,
  valuationEngine: STOCK_INTELLIGENCE_VALUATION_ENGINE_VERSION,
  regimeModel: STOCK_INTELLIGENCE_REGIME_MODEL_VERSION,
  analogueMethod: STOCK_INTELLIGENCE_ANALOGUE_METHOD_VERSION,
  outcomeModel: STOCK_INTELLIGENCE_OUTCOME_MODEL_VERSION,
  calibrationModel: STOCK_INTELLIGENCE_CALIBRATION_MODEL_VERSION,
  extraction: STOCK_INTELLIGENCE_EXTRACTION_VERSION,
  corporateActionAdjustment: STOCK_INTELLIGENCE_CORPORATE_ACTION_ADJUSTMENT_VERSION,
  replayHarness: STOCK_INTELLIGENCE_REPLAY_HARNESS_VERSION,
};

/** A directional label produced by the local research model, not a trade instruction. */
export const modelPredictionLabels = ["BULLISH", "BEARISH", "NEUTRAL"] as const;
export type ModelPredictionLabel = (typeof modelPredictionLabels)[number];

export const modelStages = ["CANDIDATE", "PRODUCTION", "REJECTED", "ARCHIVED"] as const;
export type ModelStage = (typeof modelStages)[number];

/** JSON stored alongside a prediction is evidence for inspection, not executable input. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface PredictionInstrument {
  id: string;
  exchange: "NSE" | "NFO" | "BSE";
  symbol: string;
  displayName: string;
}

/** The completed candle used by the local inference run, if it still exists. */
export interface PredictionSourceCandle {
  id: string;
  timeframe: string;
  openTime: Date;
  closeTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Safe model lineage for the read-only research UI. Artifact locations are intentionally excluded. */
export interface PredictionModelSummary {
  id: string;
  key: string;
  version: number;
  algorithm: string;
  /** Current registry stage, which may differ from the stage at prediction time. */
  currentStage: ModelStage;
  artifactChecksum: string | null;
  trainingRows: number;
  validationMetrics: JsonObject;
  trainedAt: Date;
  promotedAt: Date | null;
}

export interface PredictionModelDetail extends PredictionModelSummary {
  featureSchema: JsonValue[];
  trainingWindow: {
    start: Date;
    end: Date;
  };
}

/** A compact, read-only row suitable for the predictions list. */
export interface ModelPredictionSummary {
  /** The API exposes an inspectable research observation, never an executable trade. */
  researchOnly: true;
  id: string;
  prediction: ModelPredictionLabel;
  confidence: number;
  createdAt: Date;
  evidenceCutoffAt: Date;
  instrument: PredictionInstrument;
  sourceCandle: PredictionSourceCandle | null;
  model: PredictionModelSummary;
}

/** A fully inspectable local-model prediction. It does not create a trade idea or paper trade. */
export interface ModelPredictionDetail extends Omit<ModelPredictionSummary, "model"> {
  model: PredictionModelDetail;
  featureContributions: JsonValue[];
  explanation: JsonValue[];
}

export interface ListModelPredictionsInput {
  instrumentSymbol?: string;
  modelKey?: string;
  timeframe?: string;
  prediction?: ModelPredictionLabel;
  cursor?: ModelPredictionCursor;
  limit: number;
}

/** A deterministic descending `createdAt, id` keyset position. */
export interface ModelPredictionCursor {
  createdAt: Date;
  id: string;
}

/** Query-only boundary for stored local model predictions. */
export interface ModelPredictionQueryRepository {
  list(input: ListModelPredictionsInput): Promise<ModelPredictionSummary[]>;
  findById(predictionId: string): Promise<ModelPredictionDetail | null>;
}

import type { InstrumentType } from "../../market-data/domain/instrument.js";
import type { ModelPredictionLabel, ModelStage } from "../../model-predictions/domain/model-prediction.js";
import type { CandlestickPatternCode, PatternDirection, PriceActionEventCode } from "../../pattern-recognition/domain/market-pattern.js";
import type { IndicatorCode, IndicatorValues } from "../../technical-analysis/domain/technical-indicator.js";

export const scannerExchanges = ["NSE", "NFO", "BSE"] as const;
export type ScannerExchange = (typeof scannerExchanges)[number];

export interface WatchlistInstrument {
  /** The active instrument registry is a local, read-only watchlist projection. */
  researchOnly: true;
  id: string;
  exchange: ScannerExchange;
  symbol: string;
  displayName: string;
  instrumentType: InstrumentType;
  currency: "INR";
  timezone: string;
  tickSize: number;
  lotSize: number;
  registryStatus: "ACTIVE";
}

export interface WatchlistCursor {
  exchange: ScannerExchange;
  symbol: string;
  id: string;
}

export interface ListWatchlistInput {
  exchange?: ScannerExchange;
  instrumentType?: InstrumentType;
  cursor?: WatchlistCursor;
  limit: number;
}

export interface ScannerInstrument {
  id: string;
  exchange: ScannerExchange;
  symbol: string;
  displayName: string;
  instrumentType: InstrumentType;
}

/** Only a persisted completed candle is eligible for scanner output. */
export interface ScannerCompletedCandle {
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

export interface ScannerIndicator {
  code: IndicatorCode;
  algorithmVersion: string;
  parameters: Record<string, string | number | boolean>;
  values: IndicatorValues;
}

export interface ScannerPattern {
  code: CandlestickPatternCode;
  algorithmVersion: string;
  direction: PatternDirection;
  confidence: number;
}

export interface ScannerPriceActionEvent {
  eventType: PriceActionEventCode;
  algorithmVersion: string;
  direction: PatternDirection;
  level: number | null;
  confidence: number;
}

/**
 * A stored model observation associated with the exact completed scanner candle.
 * It is not a trade instruction and does not trigger inference.
 */
export interface ScannerModelPrediction {
  id: string;
  prediction: ModelPredictionLabel;
  confidence: number;
  createdAt: Date;
  evidenceCutoffAt: Date;
  model: {
    key: string;
    version: number;
    algorithm: string;
    /** The model registry's current mutable stage, not a stage frozen at inference. */
    currentStage: ModelStage;
  };
}

export interface MarketScannerRow {
  researchOnly: true;
  instrument: ScannerInstrument;
  latestCompletedCandle: ScannerCompletedCandle;
  indicators: ScannerIndicator[];
  patterns: ScannerPattern[];
  priceActionEvents: ScannerPriceActionEvent[];
  modelPrediction: ScannerModelPrediction | null;
}

export interface MarketScannerCursor {
  closeTime: Date;
  instrumentId: string;
}

export interface ListMarketScannerInput {
  timeframe: string;
  instrumentSymbol?: string;
  exchange?: ScannerExchange;
  prediction?: ModelPredictionLabel;
  cursor?: MarketScannerCursor;
  limit: number;
}

/** Safe strategy catalogue metadata only; no configuration or trade proposal is exposed. */
export interface ActiveResearchStrategy {
  key: string;
  name: string;
  version: number;
}

/** Query-only boundary over persisted local research evidence. */
export interface MarketScannerQueryRepository {
  listWatchlist(input: ListWatchlistInput): Promise<WatchlistInstrument[]>;
  listScannerRows(input: ListMarketScannerInput): Promise<MarketScannerRow[]>;
  listActiveResearchStrategies(): Promise<ActiveResearchStrategy[]>;
}

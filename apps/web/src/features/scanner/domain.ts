import type { JsonObject } from "../research/json";

export interface WatchlistInstrument {
  id: string;
  researchOnly: true;
  exchange: string;
  symbol: string;
  displayName: string;
  instrumentType: string;
  currency: string;
  timezone: string;
  tickSize: number;
  lotSize: number;
  registryStatus: string;
}

export interface CompletedCandle {
  id: string;
  timeframe: string;
  openTime: string;
  closeTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ScannerInstrument {
  id: string;
  exchange: string;
  symbol: string;
  displayName: string;
  instrumentType: string;
}

export interface ScannerIndicator {
  code: string;
  algorithmVersion: string;
  parameters: JsonObject;
  values: JsonObject;
}

export interface ScannerPattern {
  code: string;
  algorithmVersion: string;
  direction: string;
  confidence: number;
}

export interface ScannerPriceActionEvent {
  eventType: string;
  algorithmVersion: string;
  direction: string;
  level: number | null;
  confidence: number;
}

export interface ScannerModelPrediction {
  id: string;
  prediction: string;
  confidence: number;
  createdAt: string;
  evidenceCutoffAt: string;
  model: {
    key: string;
    version: number;
    algorithm: string;
    currentStage: string;
  };
}

export interface ScannerRow {
  researchOnly: true;
  instrument: ScannerInstrument;
  latestCompletedCandle: CompletedCandle;
  indicators: ScannerIndicator[];
  patterns: ScannerPattern[];
  priceActionEvents: ScannerPriceActionEvent[];
  modelPrediction: ScannerModelPrediction | null;
}

export interface ScannerContext {
  researchOnly: true;
  timeframe: string;
  activeStrategies: Array<{ key: string; name: string; version: number }>;
}

export interface CandleData {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface IndicatorPoint {
  timestamp: string;
  value?: number;
  upper?: number;
  middle?: number;
  lower?: number;
  signal?: number;
  histogram?: number;
}

export interface PatternAnnotation {
  id: string;
  name: string;
  type: string;
  timestamp: string;
  price: number;
  confidence: number;
  direction: "BULLISH" | "BEARISH" | "NEUTRAL" | string;
}

export interface ChartPayload {
  symbol: string;
  timeframe: string;
  candles: CandleData[];
  indicators?: Record<string, IndicatorPoint[]>;
  patterns?: PatternAnnotation[];
}

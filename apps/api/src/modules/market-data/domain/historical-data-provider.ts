export const supportedHistoricalTimeframes = ["1m", "3m", "5m", "10m", "15m", "30m", "60m", "1d"] as const;
export type HistoricalTimeframe = (typeof supportedHistoricalTimeframes)[number];

export interface HistoricalMarketDataRequest {
  providerInstrumentId: string;
  timeframe: HistoricalTimeframe;
  from: Date;
  to: Date;
}

export interface HistoricalMarketCandle {
  openTime: Date;
  closeTime: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

/** A provider port. Implementations may use a licensed HTTP API or a local export file. */
export interface HistoricalMarketDataProvider {
  readonly id: string;
  fetchCandles(request: HistoricalMarketDataRequest): Promise<HistoricalMarketCandle[]>;
}

export interface LiveMarketQuote {
  providerInstrumentId: string;
  lastPrice: string;
  /** Cumulative traded volume for the current market session, when provided. */
  cumulativeVolume: string | null;
  observedAt: Date;
  exchangeTimestamp: Date | null;
}

/** Read-only snapshot/stream abstraction. It must never expose order methods. */
export interface LiveMarketDataProvider {
  readonly id: string;
  fetchQuotes(providerInstrumentIds: string[]): Promise<LiveMarketQuote[]>;
}

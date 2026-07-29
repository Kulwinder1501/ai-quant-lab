export type MarketDataIngestionStatus = "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";

export interface MarketDataIngestion {
  id: string;
  provider: string;
  mode: "HISTORICAL" | "LIVE";
  status: MarketDataIngestionStatus;
  recordCount: number;
  startedAt: Date;
  completedAt: Date | null;
  errorMessage: string | null;
}

export interface StartMarketDataIngestionInput {
  provider: string;
  mode: "HISTORICAL" | "LIVE";
  requestMetadata: Record<string, unknown>;
}

export interface MarketDataIngestionRepository {
  start(input: StartMarketDataIngestionInput): Promise<MarketDataIngestion>;
  complete(id: string, recordCount: number): Promise<MarketDataIngestion>;
  fail(id: string, errorMessage: string): Promise<MarketDataIngestion>;
}

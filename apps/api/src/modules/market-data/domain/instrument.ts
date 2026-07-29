export const instrumentTypes = ["INDEX", "EQUITY", "ETF"] as const;
export type InstrumentType = (typeof instrumentTypes)[number];

export interface Instrument {
  id: string;
  exchange: "NSE" | "NFO" | "BSE";
  symbol: string;
  displayName: string;
  instrumentType: InstrumentType;
  isin: string | null;
  tickSize: string;
  lotSize: number;
  isActive: boolean;
  metadata: Record<string, unknown>;
}

export interface UpsertInstrumentInput {
  exchange: Instrument["exchange"];
  symbol: string;
  displayName: string;
  instrumentType: InstrumentType;
  isin?: string | null;
  tickSize?: string;
  lotSize?: number;
  isActive?: boolean;
  metadata?: Record<string, unknown>;
}

export interface InstrumentRepository {
  upsert(input: UpsertInstrumentInput): Promise<Instrument>;
  findByExchangeAndSymbol(exchange: Instrument["exchange"], symbol: string): Promise<Instrument | null>;
  listActive(): Promise<Instrument[]>;
}

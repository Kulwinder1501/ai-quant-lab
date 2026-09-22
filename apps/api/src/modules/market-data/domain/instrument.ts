export const instrumentTypes = ["INDEX", "EQUITY", "ETF", "OPTION", "FUTURE"] as const;
export type InstrumentType = (typeof instrumentTypes)[number];
export type OptionType = "CE" | "PE";

export interface Instrument {
  id: string;
  exchange: "NSE" | "NFO" | "BSE" | "TWELVEDATA";
  symbol: string;
  displayName: string;
  instrumentType: InstrumentType;
  isin: string | null;
  /** Every instrument was NSE/BSE-listed and INR-priced until OANDA's USD-quoted XAU_USD. */
  currency: "INR" | "USD";
  tickSize: string;
  lotSize: number;
  isActive: boolean;
  metadata: Record<string, unknown>;
  underlyingSymbol?: string | null;
  strikePrice?: number | null;
  expiryDate?: string | null;
  optionType?: OptionType | null;
}

export interface UpsertInstrumentInput {
  exchange: Instrument["exchange"];
  symbol: string;
  displayName: string;
  instrumentType: InstrumentType;
  isin?: string | null;
  /** Defaults to `"INR"` -- every instrument before OANDA's XAU_USD was Indian-exchange-listed. */
  currency?: Instrument["currency"];
  tickSize?: string;
  lotSize?: number;
  isActive?: boolean;
  metadata?: Record<string, unknown>;
  underlyingSymbol?: string | null;
  strikePrice?: number | null;
  expiryDate?: string | null;
  optionType?: OptionType | null;
}

export interface InstrumentRepository {
  upsert(input: UpsertInstrumentInput): Promise<Instrument>;
  findById(id: string): Promise<Instrument | null>;
  findByExchangeAndSymbol(exchange: Instrument["exchange"], symbol: string): Promise<Instrument | null>;
  findByIsin(isin: string): Promise<Instrument[]>;
  listActive(): Promise<Instrument[]>;
}

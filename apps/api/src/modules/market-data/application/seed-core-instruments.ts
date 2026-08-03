import type { Instrument, InstrumentRepository } from "../domain/instrument.js";

const coreInstruments = [
  {
    exchange: "NSE" as const,
    symbol: "NIFTY50",
    displayName: "NIFTY 50",
    instrumentType: "INDEX" as const,
    lotSize: 75,
    metadata: { market: "India", canonicalName: "NIFTY 50", kiteQuoteSymbol: "NSE:NIFTY 50" },
  },
  {
    exchange: "NSE" as const,
    symbol: "BANKNIFTY",
    displayName: "NIFTY BANK",
    instrumentType: "INDEX" as const,
    lotSize: 15,
    metadata: { market: "India", canonicalName: "NIFTY BANK", kiteQuoteSymbol: "NSE:NIFTY BANK" },
  },
  {
    exchange: "NSE" as const,
    symbol: "INDIAVIX",
    displayName: "India VIX",
    instrumentType: "INDEX" as const,
    lotSize: 1,
    tickSize: "0.01",
    isActive: false,
    metadata: { market: "India", canonicalName: "India VIX", purpose: "volatility-regime", yahooSymbol: "^INDIAVIX" },
  },
];
export async function seedCoreInstruments(repository: InstrumentRepository): Promise<Instrument[]> {
  return Promise.all(coreInstruments.map((instrument) => repository.upsert(instrument)));
}

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
    // 30, matching migration 020. 15 is the pre-revision lot and implies an 8.6 lakh contract at
    // ~57,000 against SEBI's 15 lakh minimum -- `assessContractSize` grades it
    // BELOW_REGULATORY_MINIMUM. Confirm against the current NSE contract note before trusting it
    // for anything but paper trading; lot sizes are revised as the index drifts.
    lotSize: 30,
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

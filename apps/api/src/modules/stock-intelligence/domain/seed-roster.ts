import { NIFTY50_DRIVER_WEIGHTS } from "../../market-data/domain/nifty50-driver-weights.js";
import type { StockIntelligenceUniverse } from "./universe.js";

/**
 * Calendar day the M01 roster was frozen. Membership rows are available from this
 * instant, not from 2015. Treating these names as index members in 2015 would be
 * survivorship leakage.
 */
export const STOCK_INTELLIGENCE_ROSTER_AS_OF = "2026-09-03";

export interface SeedRosterName {
  readonly symbol: string;
  readonly displayName: string;
  readonly universe: StockIntelligenceUniverse;
  readonly aliases: readonly string[];
}

function aliasesFor(symbol: string, displayName: string): string[] {
  const unique = new Set<string>([
    symbol,
    symbol.replace(/-/g, ""),
    displayName,
    displayName.toLowerCase(),
    `${symbol}.NS`,
  ]);
  return [...unique];
}

/**
 * Nifty 50 cash names reused from the dashboard driver roster so the two lists cannot
 * drift. That roster is itself an approximate current snapshot, not a PIT archive.
 */
export function nifty50EquityRoster(): SeedRosterName[] {
  return NIFTY50_DRIVER_WEIGHTS.map((driver) => ({
    symbol: driver.symbol,
    displayName: driver.name,
    universe: "NIFTY50" as const,
    aliases: aliasesFor(driver.symbol, driver.name),
  }));
}

/**
 * Nifty Next 50 cash names as of {@link STOCK_INTELLIGENCE_ROSTER_AS_OF}.
 *
 * This is a seed snapshot for M01, not NSE's historical constituent file. Names that
 * entered or left the index before this date are not reconstructed. Overlap with the
 * Nifty 50 roster is refused at seed time rather than stored twice.
 */
export const NIFTY_NEXT_50_EQUITY_ROSTER: readonly SeedRosterName[] = [
  { symbol: "ABB", displayName: "ABB India", universe: "NIFTYNXT50", aliases: aliasesFor("ABB", "ABB India") },
  { symbol: "ADANIENSOL", displayName: "Adani Energy Solutions", universe: "NIFTYNXT50", aliases: aliasesFor("ADANIENSOL", "Adani Energy Solutions") },
  { symbol: "ADANIGREEN", displayName: "Adani Green Energy", universe: "NIFTYNXT50", aliases: aliasesFor("ADANIGREEN", "Adani Green Energy") },
  { symbol: "AMBUJACEM", displayName: "Ambuja Cements", universe: "NIFTYNXT50", aliases: aliasesFor("AMBUJACEM", "Ambuja Cements") },
  { symbol: "ATGL", displayName: "Adani Total Gas", universe: "NIFTYNXT50", aliases: aliasesFor("ATGL", "Adani Total Gas") },
  { symbol: "BAJAJHLDNG", displayName: "Bajaj Holdings", universe: "NIFTYNXT50", aliases: aliasesFor("BAJAJHLDNG", "Bajaj Holdings") },
  { symbol: "BANKBARODA", displayName: "Bank of Baroda", universe: "NIFTYNXT50", aliases: aliasesFor("BANKBARODA", "Bank of Baroda") },
  { symbol: "BERGEPAINT", displayName: "Berger Paints", universe: "NIFTYNXT50", aliases: aliasesFor("BERGEPAINT", "Berger Paints") },
  { symbol: "BOSCHLTD", displayName: "Bosch", universe: "NIFTYNXT50", aliases: aliasesFor("BOSCHLTD", "Bosch") },
  { symbol: "CANBK", displayName: "Canara Bank", universe: "NIFTYNXT50", aliases: aliasesFor("CANBK", "Canara Bank") },
  { symbol: "CHOLAFIN", displayName: "Cholamandalam Investment", universe: "NIFTYNXT50", aliases: aliasesFor("CHOLAFIN", "Cholamandalam Investment") },
  { symbol: "COLPAL", displayName: "Colgate-Palmolive India", universe: "NIFTYNXT50", aliases: aliasesFor("COLPAL", "Colgate-Palmolive India") },
  { symbol: "DLF", displayName: "DLF", universe: "NIFTYNXT50", aliases: aliasesFor("DLF", "DLF") },
  { symbol: "DMART", displayName: "Avenue Supermarts", universe: "NIFTYNXT50", aliases: aliasesFor("DMART", "Avenue Supermarts") },
  { symbol: "FEDERALBNK", displayName: "Federal Bank", universe: "NIFTYNXT50", aliases: aliasesFor("FEDERALBNK", "Federal Bank") },
  { symbol: "GAIL", displayName: "GAIL India", universe: "NIFTYNXT50", aliases: aliasesFor("GAIL", "GAIL India") },
  { symbol: "GODREJCP", displayName: "Godrej Consumer Products", universe: "NIFTYNXT50", aliases: aliasesFor("GODREJCP", "Godrej Consumer Products") },
  { symbol: "HAL", displayName: "Hindustan Aeronautics", universe: "NIFTYNXT50", aliases: aliasesFor("HAL", "Hindustan Aeronautics") },
  { symbol: "HAVELLS", displayName: "Havells India", universe: "NIFTYNXT50", aliases: aliasesFor("HAVELLS", "Havells India") },
  { symbol: "ICICIGI", displayName: "ICICI Lombard", universe: "NIFTYNXT50", aliases: aliasesFor("ICICIGI", "ICICI Lombard") },
  { symbol: "ICICIPRULI", displayName: "ICICI Prudential Life", universe: "NIFTYNXT50", aliases: aliasesFor("ICICIPRULI", "ICICI Prudential Life") },
  { symbol: "INDIGO", displayName: "InterGlobe Aviation", universe: "NIFTYNXT50", aliases: aliasesFor("INDIGO", "InterGlobe Aviation") },
  { symbol: "IOC", displayName: "Indian Oil Corporation", universe: "NIFTYNXT50", aliases: aliasesFor("IOC", "Indian Oil Corporation") },
  { symbol: "IRCTC", displayName: "IRCTC", universe: "NIFTYNXT50", aliases: aliasesFor("IRCTC", "IRCTC") },
  { symbol: "IREDA", displayName: "IREDA", universe: "NIFTYNXT50", aliases: aliasesFor("IREDA", "IREDA") },
  { symbol: "JINDALSTEL", displayName: "Jindal Steel", universe: "NIFTYNXT50", aliases: aliasesFor("JINDALSTEL", "Jindal Steel") },
  { symbol: "JIOFIN", displayName: "Jio Financial Services", universe: "NIFTYNXT50", aliases: aliasesFor("JIOFIN", "Jio Financial Services") },
  { symbol: "LICI", displayName: "Life Insurance Corporation", universe: "NIFTYNXT50", aliases: aliasesFor("LICI", "Life Insurance Corporation") },
  { symbol: "LODHA", displayName: "Macrotech Developers", universe: "NIFTYNXT50", aliases: aliasesFor("LODHA", "Macrotech Developers") },
  { symbol: "LUPIN", displayName: "Lupin", universe: "NIFTYNXT50", aliases: aliasesFor("LUPIN", "Lupin") },
  { symbol: "MARICO", displayName: "Marico", universe: "NIFTYNXT50", aliases: aliasesFor("MARICO", "Marico") },
  { symbol: "MOTHERSON", displayName: "Samvardhana Motherson", universe: "NIFTYNXT50", aliases: aliasesFor("MOTHERSON", "Samvardhana Motherson") },
  { symbol: "NAUKRI", displayName: "Info Edge", universe: "NIFTYNXT50", aliases: aliasesFor("NAUKRI", "Info Edge") },
  { symbol: "NHPC", displayName: "NHPC", universe: "NIFTYNXT50", aliases: aliasesFor("NHPC", "NHPC") },
  { symbol: "PFC", displayName: "Power Finance Corporation", universe: "NIFTYNXT50", aliases: aliasesFor("PFC", "Power Finance Corporation") },
  { symbol: "PIDILITIND", displayName: "Pidilite Industries", universe: "NIFTYNXT50", aliases: aliasesFor("PIDILITIND", "Pidilite Industries") },
  { symbol: "PNB", displayName: "Punjab National Bank", universe: "NIFTYNXT50", aliases: aliasesFor("PNB", "Punjab National Bank") },
  { symbol: "RECLTD", displayName: "REC", universe: "NIFTYNXT50", aliases: aliasesFor("RECLTD", "REC") },
  { symbol: "SBICARD", displayName: "SBI Cards", universe: "NIFTYNXT50", aliases: aliasesFor("SBICARD", "SBI Cards") },
  { symbol: "SHREECEM", displayName: "Shree Cement", universe: "NIFTYNXT50", aliases: aliasesFor("SHREECEM", "Shree Cement") },
  { symbol: "SHRIRAMFIN", displayName: "Shriram Finance", universe: "NIFTYNXT50", aliases: aliasesFor("SHRIRAMFIN", "Shriram Finance") },
  { symbol: "SIEMENS", displayName: "Siemens", universe: "NIFTYNXT50", aliases: aliasesFor("SIEMENS", "Siemens") },
  { symbol: "TATAPOWER", displayName: "Tata Power", universe: "NIFTYNXT50", aliases: aliasesFor("TATAPOWER", "Tata Power") },
  { symbol: "TORNTPHARM", displayName: "Torrent Pharmaceuticals", universe: "NIFTYNXT50", aliases: aliasesFor("TORNTPHARM", "Torrent Pharmaceuticals") },
  { symbol: "TRENT", displayName: "Trent", universe: "NIFTYNXT50", aliases: aliasesFor("TRENT", "Trent") },
  { symbol: "TVSMOTOR", displayName: "TVS Motor", universe: "NIFTYNXT50", aliases: aliasesFor("TVSMOTOR", "TVS Motor") },
  { symbol: "UNITDSPR", displayName: "United Spirits", universe: "NIFTYNXT50", aliases: aliasesFor("UNITDSPR", "United Spirits") },
  { symbol: "VBL", displayName: "Varun Beverages", universe: "NIFTYNXT50", aliases: aliasesFor("VBL", "Varun Beverages") },
  { symbol: "VEDL", displayName: "Vedanta", universe: "NIFTYNXT50", aliases: aliasesFor("VEDL", "Vedanta") },
  { symbol: "ZOMATO", displayName: "Zomato", universe: "NIFTYNXT50", aliases: aliasesFor("ZOMATO", "Zomato") },
];

export const INDEX_CONTEXT_ROSTER: readonly SeedRosterName[] = [
  { symbol: "NIFTY50", displayName: "NIFTY 50", universe: "INDEX_CONTEXT", aliases: aliasesFor("NIFTY50", "NIFTY 50") },
  { symbol: "NIFTYNXT50", displayName: "Nifty Next 50", universe: "INDEX_CONTEXT", aliases: aliasesFor("NIFTYNXT50", "Nifty Next 50") },
  { symbol: "INDIAVIX", displayName: "India VIX", universe: "INDEX_CONTEXT", aliases: aliasesFor("INDIAVIX", "India VIX") },
];

export function stockIntelligenceEquityRoster(): SeedRosterName[] {
  const nifty50 = nifty50EquityRoster();
  const nifty50Symbols = new Set(nifty50.map((row) => row.symbol));
  const next50 = NIFTY_NEXT_50_EQUITY_ROSTER.filter((row) => !nifty50Symbols.has(row.symbol));
  return [...nifty50, ...next50];
}

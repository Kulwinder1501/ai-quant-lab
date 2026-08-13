/**
 * Approximate index driver rosters for the dashboard contribution heatmap.
 *
 * Weights are hand-maintained snapshots for UI estimation only — not live exchange
 * free-float weights, and never consumed by ML feature construction.
 *
 * Formula:
 *   estPts = weightPct * dayPct * indexLevel / 10000
 */

export interface IndexDriverWeight {
  symbol: string;
  name: string;
  /** Approximate index weight in percent (sums ~100 across the roster). */
  weightPct: number;
}

export interface IndexDriverUniverse {
  key: string;
  label: string;
  indexSymbol: string;
  drivers: readonly IndexDriverWeight[];
}

/** Approximate Nifty 50 free-float weights (UI estimate). */
export const NIFTY50_DRIVER_WEIGHTS: readonly IndexDriverWeight[] = [
  { symbol: "HDFCBANK", name: "HDFC Bank", weightPct: 8.9 },
  { symbol: "RELIANCE", name: "Reliance Industries", weightPct: 8.4 },
  { symbol: "ICICIBANK", name: "ICICI Bank", weightPct: 7.8 },
  { symbol: "INFY", name: "Infosys", weightPct: 6.1 },
  { symbol: "ITC", name: "ITC", weightPct: 4.2 },
  { symbol: "TCS", name: "Tata Consultancy Services", weightPct: 4.0 },
  { symbol: "LT", name: "Larsen & Toubro", weightPct: 3.9 },
  { symbol: "BHARTIARTL", name: "Bharti Airtel", weightPct: 3.7 },
  { symbol: "SBIN", name: "State Bank of India", weightPct: 3.2 },
  { symbol: "AXISBANK", name: "Axis Bank", weightPct: 3.1 },
  { symbol: "KOTAKBANK", name: "Kotak Mahindra Bank", weightPct: 2.9 },
  { symbol: "BAJFINANCE", name: "Bajaj Finance", weightPct: 2.4 },
  { symbol: "HINDUNILVR", name: "Hindustan Unilever", weightPct: 2.3 },
  { symbol: "M&M", name: "Mahindra & Mahindra", weightPct: 2.2 },
  { symbol: "SUNPHARMA", name: "Sun Pharma", weightPct: 1.9 },
  { symbol: "MARUTI", name: "Maruti Suzuki", weightPct: 1.8 },
  { symbol: "NTPC", name: "NTPC", weightPct: 1.7 },
  { symbol: "HCLTECH", name: "HCL Technologies", weightPct: 1.6 },
  { symbol: "TATAMOTORS", name: "Tata Motors", weightPct: 1.6 },
  { symbol: "TITAN", name: "Titan Company", weightPct: 1.5 },
  { symbol: "POWERGRID", name: "Power Grid", weightPct: 1.5 },
  { symbol: "ULTRACEMCO", name: "UltraTech Cement", weightPct: 1.4 },
  { symbol: "TATASTEEL", name: "Tata Steel", weightPct: 1.3 },
  { symbol: "ADANIENT", name: "Adani Enterprises", weightPct: 1.3 },
  { symbol: "ADANIPORTS", name: "Adani Ports", weightPct: 1.2 },
  { symbol: "BAJAJFINSV", name: "Bajaj Finserv", weightPct: 1.2 },
  { symbol: "ASIANPAINT", name: "Asian Paints", weightPct: 1.2 },
  { symbol: "ONGC", name: "ONGC", weightPct: 1.1 },
  { symbol: "NESTLEIND", name: "Nestle India", weightPct: 1.1 },
  { symbol: "JSWSTEEL", name: "JSW Steel", weightPct: 1.1 },
  { symbol: "TECHM", name: "Tech Mahindra", weightPct: 1.0 },
  { symbol: "WIPRO", name: "Wipro", weightPct: 1.0 },
  { symbol: "COALINDIA", name: "Coal India", weightPct: 0.9 },
  { symbol: "GRASIM", name: "Grasim Industries", weightPct: 0.9 },
  { symbol: "CIPLA", name: "Cipla", weightPct: 0.9 },
  { symbol: "HDFCLIFE", name: "HDFC Life", weightPct: 0.8 },
  { symbol: "DRREDDY", name: "Dr Reddy's Labs", weightPct: 0.8 },
  { symbol: "SBILIFE", name: "SBI Life", weightPct: 0.8 },
  { symbol: "BRITANNIA", name: "Britannia", weightPct: 0.7 },
  { symbol: "EICHERMOT", name: "Eicher Motors", weightPct: 0.7 },
  { symbol: "APOLLOHOSP", name: "Apollo Hospitals", weightPct: 0.7 },
  { symbol: "HEROMOTOCO", name: "Hero MotoCorp", weightPct: 0.7 },
  { symbol: "INDUSINDBK", name: "IndusInd Bank", weightPct: 0.7 },
  { symbol: "DIVISLAB", name: "Divi's Labs", weightPct: 0.6 },
  { symbol: "BPCL", name: "BPCL", weightPct: 0.6 },
  { symbol: "TATACONSUM", name: "Tata Consumer", weightPct: 0.6 },
  { symbol: "HINDALCO", name: "Hindalco", weightPct: 0.6 },
  { symbol: "BAJAJ-AUTO", name: "Bajaj Auto", weightPct: 0.6 },
  { symbol: "LTIM", name: "LTIMindtree", weightPct: 0.5 },
  { symbol: "BEL", name: "Bharat Electronics", weightPct: 0.5 },
] as const;

/** Approximate Bank Nifty constituent weights (UI estimate; ~12 names). */
export const BANKNIFTY_DRIVER_WEIGHTS: readonly IndexDriverWeight[] = [
  { symbol: "HDFCBANK", name: "HDFC Bank", weightPct: 28.5 },
  { symbol: "ICICIBANK", name: "ICICI Bank", weightPct: 23.0 },
  { symbol: "AXISBANK", name: "Axis Bank", weightPct: 10.5 },
  { symbol: "KOTAKBANK", name: "Kotak Mahindra Bank", weightPct: 9.5 },
  { symbol: "SBIN", name: "State Bank of India", weightPct: 9.0 },
  { symbol: "INDUSINDBK", name: "IndusInd Bank", weightPct: 5.0 },
  { symbol: "BAJFINANCE", name: "Bajaj Finance", weightPct: 4.0 },
  { symbol: "FEDERALBNK", name: "Federal Bank", weightPct: 2.8 },
  { symbol: "BANKBARODA", name: "Bank of Baroda", weightPct: 2.5 },
  { symbol: "AUBANK", name: "AU Small Finance Bank", weightPct: 2.0 },
  { symbol: "IDFCFIRSTB", name: "IDFC First Bank", weightPct: 1.7 },
  { symbol: "PNB", name: "Punjab National Bank", weightPct: 1.5 },
] as const;

/** Approximate Nifty Financial Services weights (UI estimate). */
export const FINNIFTY_DRIVER_WEIGHTS: readonly IndexDriverWeight[] = [
  { symbol: "HDFCBANK", name: "HDFC Bank", weightPct: 21.0 },
  { symbol: "ICICIBANK", name: "ICICI Bank", weightPct: 17.0 },
  { symbol: "BAJFINANCE", name: "Bajaj Finance", weightPct: 8.5 },
  { symbol: "AXISBANK", name: "Axis Bank", weightPct: 7.5 },
  { symbol: "KOTAKBANK", name: "Kotak Mahindra Bank", weightPct: 7.0 },
  { symbol: "SBIN", name: "State Bank of India", weightPct: 6.5 },
  { symbol: "BAJAJFINSV", name: "Bajaj Finserv", weightPct: 4.5 },
  { symbol: "HDFCLIFE", name: "HDFC Life", weightPct: 3.5 },
  { symbol: "SBILIFE", name: "SBI Life", weightPct: 3.2 },
  { symbol: "PFC", name: "Power Finance Corp", weightPct: 2.8 },
  { symbol: "RECLTD", name: "REC Ltd", weightPct: 2.5 },
  { symbol: "CHOLAFIN", name: "Cholamandalam Finance", weightPct: 2.3 },
  { symbol: "INDUSINDBK", name: "IndusInd Bank", weightPct: 2.2 },
  { symbol: "HDFCAMC", name: "HDFC AMC", weightPct: 2.0 },
  { symbol: "ICICIGI", name: "ICICI Lombard", weightPct: 1.8 },
  { symbol: "LICHSGFIN", name: "LIC Housing Finance", weightPct: 1.6 },
  { symbol: "MUTHOOTFIN", name: "Muthoot Finance", weightPct: 1.5 },
  { symbol: "SHRIRAMFIN", name: "Shriram Finance", weightPct: 1.4 },
  { symbol: "ICICIPRULI", name: "ICICI Prudential Life", weightPct: 1.3 },
  { symbol: "SBICARD", name: "SBI Cards", weightPct: 1.2 },
  { symbol: "BANKBARODA", name: "Bank of Baroda", weightPct: 1.1 },
  { symbol: "PNB", name: "Punjab National Bank", weightPct: 1.0 },
] as const;

/** Approximate Sensex constituent weights (UI estimate; top BSE30). */
export const SENSEX_DRIVER_WEIGHTS: readonly IndexDriverWeight[] = [
  { symbol: "RELIANCE", name: "Reliance Industries", weightPct: 11.5 },
  { symbol: "HDFCBANK", name: "HDFC Bank", weightPct: 11.0 },
  { symbol: "ICICIBANK", name: "ICICI Bank", weightPct: 9.0 },
  { symbol: "INFY", name: "Infosys", weightPct: 7.5 },
  { symbol: "TCS", name: "Tata Consultancy Services", weightPct: 5.5 },
  { symbol: "ITC", name: "ITC", weightPct: 4.5 },
  { symbol: "LT", name: "Larsen & Toubro", weightPct: 4.2 },
  { symbol: "BHARTIARTL", name: "Bharti Airtel", weightPct: 4.0 },
  { symbol: "SBIN", name: "State Bank of India", weightPct: 3.5 },
  { symbol: "AXISBANK", name: "Axis Bank", weightPct: 3.3 },
  { symbol: "KOTAKBANK", name: "Kotak Mahindra Bank", weightPct: 3.0 },
  { symbol: "BAJFINANCE", name: "Bajaj Finance", weightPct: 2.8 },
  { symbol: "HINDUNILVR", name: "Hindustan Unilever", weightPct: 2.6 },
  { symbol: "M&M", name: "Mahindra & Mahindra", weightPct: 2.4 },
  { symbol: "MARUTI", name: "Maruti Suzuki", weightPct: 2.2 },
  { symbol: "SUNPHARMA", name: "Sun Pharma", weightPct: 2.0 },
  { symbol: "TATAMOTORS", name: "Tata Motors", weightPct: 1.9 },
  { symbol: "NTPC", name: "NTPC", weightPct: 1.8 },
  { symbol: "TITAN", name: "Titan Company", weightPct: 1.7 },
  { symbol: "POWERGRID", name: "Power Grid", weightPct: 1.6 },
  { symbol: "ULTRACEMCO", name: "UltraTech Cement", weightPct: 1.5 },
  { symbol: "ASIANPAINT", name: "Asian Paints", weightPct: 1.4 },
  { symbol: "NESTLEIND", name: "Nestle India", weightPct: 1.3 },
  { symbol: "TATASTEEL", name: "Tata Steel", weightPct: 1.2 },
  { symbol: "TECHM", name: "Tech Mahindra", weightPct: 1.1 },
  { symbol: "HCLTECH", name: "HCL Technologies", weightPct: 1.1 },
  { symbol: "INDUSINDBK", name: "IndusInd Bank", weightPct: 1.0 },
  { symbol: "BAJAJFINSV", name: "Bajaj Finserv", weightPct: 1.0 },
  { symbol: "WIPRO", name: "Wipro", weightPct: 0.9 },
  { symbol: "ONGC", name: "ONGC", weightPct: 0.9 },
] as const;

export const INDEX_DRIVER_UNIVERSES: Readonly<Record<string, IndexDriverUniverse>> = {
  NIFTY50: {
    key: "NIFTY50",
    label: "Nifty 50",
    indexSymbol: "NIFTY50",
    drivers: NIFTY50_DRIVER_WEIGHTS,
  },
  BANKNIFTY: {
    key: "BANKNIFTY",
    label: "Bank Nifty",
    indexSymbol: "BANKNIFTY",
    drivers: BANKNIFTY_DRIVER_WEIGHTS,
  },
  FINNIFTY: {
    key: "FINNIFTY",
    label: "Fin Nifty",
    indexSymbol: "FINNIFTY",
    drivers: FINNIFTY_DRIVER_WEIGHTS,
  },
  SENSEX: {
    key: "SENSEX",
    label: "Sensex",
    indexSymbol: "SENSEX",
    drivers: SENSEX_DRIVER_WEIGHTS,
  },
};

export const SUPPORTED_DRIVER_INDEX_KEYS = Object.keys(INDEX_DRIVER_UNIVERSES);

export function resolveIndexDriverUniverse(
  indexKey: string,
): IndexDriverUniverse | null {
  const normalized = indexKey.trim().toUpperCase().replace(/\s+/g, "");
  // Market-watch labels sometimes include spaces ("HANG SENG"); Indian keys do not.
  if (normalized === "NIFTY50" || normalized === "NIFTY") {
    return INDEX_DRIVER_UNIVERSES.NIFTY50;
  }
  return INDEX_DRIVER_UNIVERSES[normalized] ?? null;
}

export function yahooEquitySymbol(symbol: string): string {
  // Yahoo uses .NS for NSE cash equities; a few tickers keep a hyphen in the name.
  return `${symbol}.NS`;
}

export function estimateContributionPts(
  weightPct: number,
  dayPct: number,
  indexLevel: number,
): number {
  return (weightPct * dayPct * indexLevel) / 10_000;
}

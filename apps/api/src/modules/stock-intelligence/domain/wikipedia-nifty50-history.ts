import { monthlyMonthEndCutoffs } from "./replay.js";

/**
 * Research-grade NIFTY 50 constituent history reconstructed from the public
 * Wikipedia replacement table.
 *
 * Source: https://en.wikipedia.org/wiki/NIFTY_50
 * Attribution: Wikipedia contributors, "NIFTY 50", CC BY-SA 4.0.
 * Snapshot cross-checked against NegativeZone/nsepit (MIT code; its bundled
 * tables are derived from the same CC BY-SA page). This is not licensed NSE
 * market data and is deliberately limited to NIFTY 50 month-end membership.
 */
export const WIKIPEDIA_NIFTY50_SOURCE = {
  url: "https://en.wikipedia.org/wiki/NIFTY_50",
  license: "CC BY-SA 4.0",
  snapshotThrough: "2025-09-30",
  reconstructionWindowFrom: "2015-01-31",
  reconstructionWindowTo: "2024-12-31",
} as const;

export interface Nifty50HistoryName {
  readonly company: string;
  readonly symbol: string;
}

export interface Nifty50Replacement {
  readonly excluded: string;
  readonly included: string;
  readonly effectiveOn: string;
}

export interface Nifty50MembershipSpell {
  readonly symbol: string;
  readonly company: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

export const WIKIPEDIA_NIFTY50_CURRENT: readonly Nifty50HistoryName[] = [
  { company: "Adani Enterprises", symbol: "ADANIENT" },
  { company: "Adani Ports & SEZ", symbol: "ADANIPORTS" },
  { company: "Apollo Hospitals", symbol: "APOLLOHOSP" },
  { company: "Asian Paints", symbol: "ASIANPAINT" },
  { company: "Axis Bank", symbol: "AXISBANK" },
  { company: "Bajaj Auto", symbol: "BAJAJ-AUTO" },
  { company: "Bajaj Finance", symbol: "BAJFINANCE" },
  { company: "Bajaj Finserv", symbol: "BAJAJFINSV" },
  { company: "Bharat Electronics", symbol: "BEL" },
  { company: "Bharti Airtel", symbol: "BHARTIARTL" },
  { company: "Cipla", symbol: "CIPLA" },
  { company: "Coal India", symbol: "COALINDIA" },
  { company: "Dr. Reddy's Laboratories", symbol: "DRREDDY" },
  { company: "Eicher Motors", symbol: "EICHERMOT" },
  { company: "Eternal", symbol: "ETERNAL" },
  { company: "Grasim Industries", symbol: "GRASIM" },
  { company: "HCLTech", symbol: "HCLTECH" },
  { company: "HDFC Bank", symbol: "HDFCBANK" },
  { company: "HDFC Life", symbol: "HDFCLIFE" },
  { company: "Hindalco Industries", symbol: "HINDALCO" },
  { company: "Hindustan Unilever", symbol: "HINDUNILVR" },
  { company: "ICICI Bank", symbol: "ICICIBANK" },
  { company: "IndiGo", symbol: "INDIGO" },
  { company: "Infosys", symbol: "INFY" },
  { company: "ITC", symbol: "ITC" },
  { company: "Jio Financial Services", symbol: "JIOFIN" },
  { company: "JSW Steel", symbol: "JSWSTEEL" },
  { company: "Kotak Mahindra Bank", symbol: "KOTAKBANK" },
  { company: "Larsen & Toubro", symbol: "LT" },
  { company: "Mahindra & Mahindra", symbol: "M&M" },
  { company: "Maruti Suzuki", symbol: "MARUTI" },
  { company: "Max Healthcare", symbol: "MAXHEALTH" },
  { company: "Nestlé India", symbol: "NESTLEIND" },
  { company: "NTPC", symbol: "NTPC" },
  { company: "Oil and Natural Gas Corporation", symbol: "ONGC" },
  { company: "Power Grid", symbol: "POWERGRID" },
  { company: "Reliance Industries", symbol: "RELIANCE" },
  { company: "SBI Life Insurance Company", symbol: "SBILIFE" },
  { company: "Shriram Finance", symbol: "SHRIRAMFIN" },
  { company: "State Bank of India", symbol: "SBIN" },
  { company: "Sun Pharma", symbol: "SUNPHARMA" },
  { company: "Tata Consultancy Services", symbol: "TCS" },
  { company: "Tata Consumer Products", symbol: "TATACONSUM" },
  // The source now calls the post-demerger company TMPV. The historical
  // trading series used through 2024 is TATAMOTORS.
  { company: "Tata Motors Passenger Vehicles", symbol: "TATAMOTORS" },
  { company: "Tata Steel", symbol: "TATASTEEL" },
  { company: "Tech Mahindra", symbol: "TECHM" },
  { company: "Titan Company", symbol: "TITAN" },
  { company: "Trent", symbol: "TRENT" },
  { company: "UltraTech Cement", symbol: "ULTRACEMCO" },
  { company: "Wipro", symbol: "WIPRO" },
] as const;

export const WIKIPEDIA_NIFTY50_REPLACEMENTS: readonly Nifty50Replacement[] = [
  { excluded: "DLF", included: "IDEA", effectiveOn: "2015-03-27" },
  { excluded: "JINDALSTEL", included: "YESBANK", effectiveOn: "2015-03-27" },
  { excluded: "IDFC", included: "BOSCHLTD", effectiveOn: "2015-05-29" },
  { excluded: "NMDC", included: "ADANIPORTS", effectiveOn: "2015-09-28" },
  { excluded: "CAIRN", included: "AUROPHARMA", effectiveOn: "2016-04-01" },
  { excluded: "PNB", included: "INDUSTOWER", effectiveOn: "2016-04-01" },
  { excluded: "VEDL", included: "EICHERMOT", effectiveOn: "2016-04-01" },
  { excluded: "BHEL", included: "IBULHSGFIN", effectiveOn: "2017-03-31" },
  { excluded: "IDEA", included: "IOC", effectiveOn: "2017-03-31" },
  { excluded: "GRASIM", included: "VEDL", effectiveOn: "2017-05-26" },
  { excluded: "ACC", included: "BAJFINANCE", effectiveOn: "2017-09-29" },
  { excluded: "BANKBARODA", included: "HINDPETRO", effectiveOn: "2017-09-29" },
  { excluded: "TATAPOWER", included: "UPL", effectiveOn: "2017-09-29" },
  { excluded: "AMBUJACEM", included: "BAJAJFINSV", effectiveOn: "2018-04-02" },
  { excluded: "AUROPHARMA", included: "GRASIM", effectiveOn: "2018-04-02" },
  { excluded: "BOSCHLTD", included: "TITAN", effectiveOn: "2018-04-02" },
  { excluded: "LUPIN", included: "JSWSTEEL", effectiveOn: "2018-09-28" },
  { excluded: "HINDPETRO", included: "BRITANNIA", effectiveOn: "2019-03-29" },
  { excluded: "IBULHSGFIN", included: "NESTLEIND", effectiveOn: "2019-09-27" },
  { excluded: "YESBANK", included: "SHREECEM", effectiveOn: "2020-03-19" },
  { excluded: "VEDL", included: "HDFCLIFE", effectiveOn: "2020-07-31" },
  { excluded: "ZEEL", included: "SBILIFE", effectiveOn: "2020-09-25" },
  { excluded: "INDUSTOWER", included: "DIVISLAB", effectiveOn: "2020-09-25" },
  { excluded: "GAIL", included: "TATACONSUM", effectiveOn: "2021-03-31" },
  { excluded: "IOC", included: "APOLLOHOSP", effectiveOn: "2022-03-31" },
  { excluded: "SHREECEM", included: "ADANIENT", effectiveOn: "2022-09-30" },
  { excluded: "HDFC", included: "LTIM", effectiveOn: "2023-07-13" },
  { excluded: "UPL", included: "SHRIRAMFIN", effectiveOn: "2024-03-28" },
  { excluded: "DIVISLAB", included: "BEL", effectiveOn: "2024-09-30" },
  { excluded: "LTIM", included: "TRENT", effectiveOn: "2024-09-30" },
  // Later changes are needed to walk the 2025 snapshot back to 2024.
  { excluded: "BPCL", included: "JIOFIN", effectiveOn: "2025-03-28" },
  { excluded: "BRITANNIA", included: "ETERNAL", effectiveOn: "2025-03-28" },
  { excluded: "HEROMOTOCO", included: "INDIGO", effectiveOn: "2025-09-30" },
  { excluded: "INDUSINDBK", included: "MAXHEALTH", effectiveOn: "2025-09-30" },
] as const;

const displayNames = new Map<string, string>([
  ...WIKIPEDIA_NIFTY50_CURRENT.map((row) => [row.symbol, row.company] as const),
  ["DLF", "DLF"],
  ["IDEA", "Idea Cellular"],
  ["JINDALSTEL", "Jindal Steel & Power"],
  ["YESBANK", "Yes Bank"],
  ["IDFC", "IDFC"],
  ["BOSCHLTD", "Bosch India"],
  ["NMDC", "NMDC"],
  ["CAIRN", "Cairn India"],
  ["AUROPHARMA", "Aurobindo Pharma"],
  ["PNB", "Punjab National Bank"],
  ["INDUSTOWER", "Bharti Infratel / Indus Towers"],
  ["VEDL", "Vedanta"],
  ["BHEL", "BHEL"],
  ["IBULHSGFIN", "Indiabulls Housing Finance"],
  ["GRASIM", "Grasim Industries"],
  ["ACC", "ACC"],
  ["BANKBARODA", "Bank of Baroda"],
  ["HINDPETRO", "Hindustan Petroleum"],
  ["TATAPOWER", "Tata Power"],
  ["UPL", "UPL"],
  ["AMBUJACEM", "Ambuja Cements"],
  ["LUPIN", "Lupin"],
  ["BRITANNIA", "Britannia Industries"],
  ["NESTLEIND", "Nestlé India"],
  ["ZEEL", "Zee Entertainment Enterprises"],
  ["DIVISLAB", "Divi's Laboratories"],
  ["GAIL", "GAIL"],
  ["IOC", "Indian Oil Corporation"],
  ["SHREECEM", "Shree Cement"],
  ["HDFC", "HDFC"],
  ["LTIM", "LTIMindtree"],
  ["BPCL", "Bharat Petroleum"],
  ["HEROMOTOCO", "Hero MotoCorp"],
  ["INDUSINDBK", "IndusInd Bank"],
]);

export function nifty50HistoryDisplayName(symbol: string): string {
  return displayNames.get(symbol) ?? symbol;
}

function membershipAt(date: Date): Set<string> {
  const members = new Set(WIKIPEDIA_NIFTY50_CURRENT.map((row) => row.symbol));
  const reverse = [...WIKIPEDIA_NIFTY50_REPLACEMENTS]
    .filter((row) => new Date(`${row.effectiveOn}T00:00:00.000Z`).getTime() > date.getTime())
    .reverse();
  for (const change of reverse) {
    members.delete(change.included);
    members.add(change.excluded);
  }
  return members;
}

export function reconstructNifty50MonthEnds(
  from = new Date(`${WIKIPEDIA_NIFTY50_SOURCE.reconstructionWindowFrom}T23:59:59.999Z`),
  to = new Date(`${WIKIPEDIA_NIFTY50_SOURCE.reconstructionWindowTo}T23:59:59.999Z`),
): ReadonlyMap<string, ReadonlySet<string>> {
  const result = new Map<string, ReadonlySet<string>>();
  for (const monthEnd of monthlyMonthEndCutoffs(from, to)) {
    const key = monthEnd.toISOString().slice(0, 10);
    const members = membershipAt(monthEnd);
    if (members.size !== 50) {
      throw new Error(`NIFTY 50 history invariant failed at ${key}: expected 50, got ${members.size}.`);
    }
    result.set(key, members);
  }
  return result;
}

export function reconstructNifty50MembershipSpells(): Nifty50MembershipSpell[] {
  const months = [...reconstructNifty50MonthEnds().entries()];
  const symbols = new Set(months.flatMap(([, members]) => [...members]));
  const spells: Nifty50MembershipSpell[] = [];
  for (const symbol of symbols) {
    let started: string | null = null;
    for (const [monthEnd, members] of months) {
      if (members.has(symbol) && started === null) started = monthEnd;
      if (!members.has(symbol) && started !== null) {
        spells.push({
          symbol,
          company: nifty50HistoryDisplayName(symbol),
          effectiveFrom: started,
          effectiveTo: monthEnd,
        });
        started = null;
      }
    }
    if (started !== null) {
      spells.push({
        symbol,
        company: nifty50HistoryDisplayName(symbol),
        effectiveFrom: started,
        // The reconstruction is intentionally bounded. A separate current
        // roster row owns live eligibility; this archive must not silently
        // extend beyond the last month that was reconstructed.
        effectiveTo: "2025-01-31",
      });
    }
  }
  return spells.sort((left, right) =>
    left.effectiveFrom.localeCompare(right.effectiveFrom) || left.symbol.localeCompare(right.symbol)
  );
}

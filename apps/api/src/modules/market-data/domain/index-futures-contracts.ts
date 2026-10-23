/**
 * The monthly NIFTY and BANKNIFTY index futures that are still live, derived from the date.
 *
 * `ingest-index-futures-ohlcv.ts` used to list its contracts by hand, ending at October 2026, so
 * nothing fetched futures bars after 2026-10-12 and the volume profile had no prior session to read
 * from the next day on. The nightly job needs the contracts that are live *today*, so they are
 * derived: the next two monthly expiries per index, because a roll to the next month is decided
 * from the next month's own volume and both have to be collected before it happens.
 *
 * Monthly expiry is taken as the last Tuesday of the month, which is what every contract in the lab
 * (Aug 25, Sep 29, Oct 27) was. When the exchange moves an expiry for a holiday the date here is a
 * day late; that only means one more day of asking the provider for a contract that has stopped
 * trading, which returns nothing.
 */

export interface IndexFutureContract {
  /** Lab symbol, no exchange prefix: `NIFTY26OCTFUT`. */
  symbol: string;
  /** Fyers provider id: `NSE:NIFTY26OCTFUT`. */
  providerInstrumentId: string;
  displayName: string;
  /** The index's own instrument symbol, which is also what `instruments.underlying_symbol` holds. */
  underlyingSymbol: "NIFTY50" | "BANKNIFTY";
  /** ISO date `YYYY-MM-DD`. */
  expiryDate: string;
  lotSize: number;
}

const MONTH_CODES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"] as const;
const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

const INDICES: ReadonlyArray<{ underlyingSymbol: IndexFutureContract["underlyingSymbol"]; prefix: string; label: string; lotSize: number }> = [
  // 65: the exchange's current NIFTY lot (see migration 141). 75 is the pre-revision figure.
  { underlyingSymbol: "NIFTY50", prefix: "NIFTY", label: "NIFTY", lotSize: 65 },
  { underlyingSymbol: "BANKNIFTY", prefix: "BANKNIFTY", label: "BANKNIFTY", lotSize: 30 },
];

const TUESDAY = 2;

/** `YYYY-MM-DD` of the last Tuesday in the month (`monthIndex` is 0-11). */
export function lastTuesdayOfMonth(year: number, monthIndex: number): string {
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0));
  const daysBack = (lastDay.getUTCDay() - TUESDAY + 7) % 7;
  return new Date(Date.UTC(year, monthIndex, lastDay.getUTCDate() - daysBack)).toISOString().slice(0, 10);
}

/**
 * The next `perIndex` monthly futures per index whose expiry is on or after `today` (an India date,
 * `YYYY-MM-DD`), nearest first within each index.
 */
export function upcomingIndexFutures(today: string, perIndex = 2): IndexFutureContract[] {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7)) - 1;
  const contracts: IndexFutureContract[] = [];

  for (const index of INDICES) {
    let found = 0;
    for (let offset = 0; found < perIndex && offset < 6; offset += 1) {
      const expiryYear = year + Math.floor((month + offset) / 12);
      const expiryMonth = (month + offset) % 12;
      const expiryDate = lastTuesdayOfMonth(expiryYear, expiryMonth);
      if (expiryDate < today) continue;
      const symbol = `${index.prefix}${String(expiryYear % 100).padStart(2, "0")}${MONTH_CODES[expiryMonth]}FUT`;
      contracts.push({
        symbol,
        providerInstrumentId: `NSE:${symbol}`,
        displayName: `${index.label} ${MONTH_NAMES[expiryMonth]} ${expiryYear} Future`,
        underlyingSymbol: index.underlyingSymbol,
        expiryDate,
        lotSize: index.lotSize,
      });
      found += 1;
    }
  }
  return contracts;
}

import axios from "axios";
import { parseNseNumber } from "./nse-api-client.js";

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export class NseIxApiError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "NseIxApiError";
  }
}

export interface GiftNiftyFuturesQuote {
  lastPrice: number;
  changePercent: number;
  expiryDate: string;
  observedAt: Date;
}

export interface DerivativesRow {
  INSTRUMENTTYPE?: unknown;
  SYMBOL?: unknown;
  EXPIRYDATE?: unknown;
  LASTPRICE?: unknown;
  PERCHANGE?: unknown;
}

const MONTH_ABBREVIATIONS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * Turns NSE IX's "27-Oct-2026" into a lexically sortable "2026-10-27".
 *
 * Only ever compares two values parsed from this same source format, so a value that doesn't
 * match sorts last ("9999-99-99") rather than throwing -- a malformed expiry should lose the
 * "nearest" comparison, not crash the whole quote.
 */
export function expiryDateSortKey(expiryDate: unknown): string {
  if (typeof expiryDate !== "string") return "9999-99-99";
  const match = /^(\d{1,2})-([A-Za-z]{3})[A-Za-z]*-(\d{4})$/.exec(expiryDate.trim());
  if (!match) return "9999-99-99";
  const monthIndex = MONTH_ABBREVIATIONS.indexOf(match[2].toLowerCase());
  if (monthIndex < 0) return "9999-99-99";
  return `${match[3]}-${String(monthIndex + 1).padStart(2, "0")}-${match[1].padStart(2, "0")}`;
}

/**
 * Picks GIFT Nifty's reference contract out of NSE IX's full derivatives list.
 *
 * NSE IX's own "NIFTY" index futures contract (`INSTRUMENTTYPE: "FUTIDX"`) *is* GIFT Nifty --
 * there is no separately labelled "GIFT NIFTY" row. Among the index-futures rows, the
 * nearest-expiry contract is the one every "GIFT Nifty live" page quotes; far-month contracts
 * trade too thin to be the reference price.
 */
export function selectGiftNiftyFuturesRow(rows: readonly DerivativesRow[]): DerivativesRow | null {
  const candidates = rows.filter((row) => row.INSTRUMENTTYPE === "FUTIDX" && row.SYMBOL === "NIFTY");
  if (candidates.length === 0) return null;
  return candidates.reduce((nearest, row) =>
    expiryDateSortKey(row.EXPIRYDATE) < expiryDateSortKey(nearest.EXPIRYDATE) ? row : nearest,
  );
}

/**
 * Live GIFT Nifty quote, read from NSE IX's own public homepage API.
 *
 * NSE IX documents no supported external API, but its own homepage calls this endpoint,
 * unauthenticated, to render its live derivatives ticker -- verified live on 2026-10-10 with a
 * clean, cookie-less request (plain User-Agent, no session, no token). This reads the same data
 * a visitor to nseix.com sees rendered on the page; it is not reverse-engineering an internal
 * system or bypassing any access control, and it replaces the dead Yahoo-ticker path in
 * `nse-api-client.ts` (seven tickers tried there, all 404) as this codebase's one real GIFT
 * Nifty source.
 */
export class NseIxClient {
  private readonly baseUrl = "https://www.nseix.com";

  async getGiftNiftyFuturesQuote(): Promise<GiftNiftyFuturesQuote | null> {
    let response;
    try {
      response = await axios.get(`${this.baseUrl}/api/market-rate`, {
        params: { type: "derivatives" },
        headers: { "User-Agent": BROWSER_USER_AGENT, Accept: "application/json" },
        timeout: 10_000,
      });
    } catch (error) {
      throw new NseIxApiError("GIFT Nifty futures request to NSE IX failed.", error);
    }

    const rows: unknown = (response.data as { data?: unknown } | undefined)?.data;
    if (!Array.isArray(rows)) {
      throw new NseIxApiError("NSE IX returned an unexpected derivatives payload shape.");
    }

    const row = selectGiftNiftyFuturesRow(rows as DerivativesRow[]);
    if (!row) return null;

    const changePercent = parseNseNumber(row.PERCHANGE);
    const lastPrice = parseNseNumber(row.LASTPRICE);
    if (changePercent === null || lastPrice === null || lastPrice <= 0 || typeof row.EXPIRYDATE !== "string") {
      return null;
    }

    return { lastPrice, changePercent, expiryDate: row.EXPIRYDATE, observedAt: new Date() };
  }
}

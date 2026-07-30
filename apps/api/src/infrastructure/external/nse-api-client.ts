import axios from "axios";
import type { InstitutionalFlow } from "../../modules/market-data/domain/institutional-flow.js";
import type { OffshoreDerivative } from "../../modules/market-data/domain/offshore-derivative.js";

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const MONTH_ABBREVIATIONS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Raised when the upstream payload is reachable but not shaped as expected. */
export class NseApiError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "NseApiError";
  }
}

/**
 * Parse an NSE numeric string.
 *
 * NSE renders these values for display, so they arrive with thousands separators
 * and occasionally a leading currency symbol or a parenthesised negative. Bare
 * `parseFloat("12,345.67")` silently returns 12 — a three-order-of-magnitude
 * error that flows straight into a NUMERIC column and then into a model feature.
 * Anything that does not parse cleanly to a finite number returns null so the
 * caller can record absent data rather than a wrong number.
 */
export function parseNseNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;

  let text = value.trim();
  if (text === "" || text === "-" || text.toLowerCase() === "na") return null;

  // "(1,234.5)" is an accounting-style negative.
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }

  text = text.replace(/[₹$\s,]/g, "");
  if (!/^[+-]?\d*\.?\d+$/.test(text)) return null;

  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -parsed : parsed;
}

/**
 * Parse NSE's "29-Jul-2026" trading-date format into a UTC-midnight Date.
 *
 * The date is the session identity, so it is anchored at UTC midnight rather than
 * local midnight: the row is keyed by a DATE column, and letting the server's
 * timezone shift the value would file a session under the wrong day on any host
 * west of UTC.
 */
export function parseNseDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s](\d{4})$/.exec(value.trim());
  if (!match) return null;

  const day = Number(match[1]);
  const month = MONTH_ABBREVIATIONS[match[2].toLowerCase()];
  const year = Number(match[3]);
  if (month === undefined || day < 1 || day > 31) return null;

  const parsed = new Date(Date.UTC(year, month, day));
  // Rejects 31-Feb and friends, which Date.UTC would silently roll forward.
  if (parsed.getUTCMonth() !== month || parsed.getUTCDate() !== day) return null;
  return parsed;
}

export interface NseApiClientOptions {
  /**
   * Yahoo-style symbol for the offshore Nifty contract, if the deployment has one.
   * Left unset there is no free, reliable GIFT Nifty (NSE IX) feed, and this
   * client will report the quote as unavailable rather than invent a number.
   */
  giftNiftySymbol?: string;
}

export class NseApiClient {
  private readonly baseUrl = "https://www.nseindia.com";
  private sessionCookies: string[] = [];
  private readonly giftNiftySymbol: string | undefined;

  constructor(options: NseApiClientOptions = {}) {
    this.giftNiftySymbol = options.giftNiftySymbol ?? process.env.GIFT_NIFTY_YAHOO_SYMBOL;
  }

  /**
   * Fetch the session cookies NSE's JSON endpoints require.
   *
   * Throws rather than warning. Previously a failure here was logged and the
   * request proceeded cookie-less, which NSE rejects — so a broken handshake was
   * reported downstream as "no data available" and looked identical to a market
   * holiday. Cookies are cached for the life of the client, since re-running the
   * handshake before every call doubled the request count for no benefit.
   */
  private async ensureSession(): Promise<void> {
    if (this.sessionCookies.length > 0) return;

    let response;
    try {
      response = await axios.get(this.baseUrl, {
        headers: {
          "User-Agent": BROWSER_USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
        },
        timeout: 10_000,
      });
    } catch (error) {
      throw new NseApiError("Could not reach NSE to establish a session.", error);
    }

    const cookies = response.headers["set-cookie"];
    if (!cookies || cookies.length === 0) {
      throw new NseApiError("NSE did not return session cookies; its JSON endpoints will reject the request.");
    }
    this.sessionCookies = cookies.map((cookie) => cookie.split(";")[0]);
  }

  /**
   * Fetch the most recently published FII/DII cash print.
   *
   * The returned `date` is the session NSE itself reports, not the date the
   * collector happened to run. Stamping the caller's "today" onto whatever the
   * endpoint returned meant that on a holiday — or any run before NSE published —
   * the previous session's figures were filed under the current date, so a
   * date-keyed feature read numbers from the wrong session entirely. Callers that
   * need a specific session compare against the returned date.
   */
  async getFiiDiiData(): Promise<InstitutionalFlow> {
    await this.ensureSession();

    let response;
    try {
      response = await axios.get(`${this.baseUrl}/api/fiidiiTradeReact`, {
        headers: {
          "User-Agent": BROWSER_USER_AGENT,
          Accept: "*/*",
          Referer: `${this.baseUrl}/reports/fii-dii`,
          Cookie: this.sessionCookies.join("; "),
        },
        timeout: 10_000,
      });
    } catch (error) {
      // A stale cookie jar is the common cause, so drop it and let the next
      // attempt re-handshake instead of failing identically forever.
      this.sessionCookies = [];
      throw new NseApiError("FII/DII request to NSE failed.", error);
    }

    const rows: unknown = response.data;
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new NseApiError("NSE returned an empty FII/DII payload.");
    }

    const findRow = (prefix: string): Record<string, unknown> | undefined =>
      rows.find(
        (row): row is Record<string, unknown> =>
          typeof row === "object" &&
          row !== null &&
          typeof (row as Record<string, unknown>).category === "string" &&
          ((row as Record<string, unknown>).category as string).trim().toUpperCase().startsWith(prefix),
      );

    // Matched on a prefix because NSE decorates these labels with a varying number
    // of footnote asterisks ("FII/FPI *", "DII **"), and an exact-equality match
    // broke whenever that changed.
    const fiiRow = findRow("FII");
    const diiRow = findRow("DII");
    if (!fiiRow || !diiRow) {
      throw new NseApiError("NSE FII/DII payload did not contain both an FII and a DII row.");
    }

    const date = parseNseDate(fiiRow.date) ?? parseNseDate(diiRow.date);
    if (!date) {
      throw new NseApiError(`Could not parse the session date from the NSE payload (got ${String(fiiRow.date)}).`);
    }

    const netOf = (row: Record<string, unknown>): number | null => {
      const buy = parseNseNumber(row.buyValue);
      const sell = parseNseNumber(row.sellValue);
      if (buy === null || sell === null) return null;
      return Number((buy - sell).toFixed(4));
    };

    const fiiCashNetCr = netOf(fiiRow);
    const diiCashNetCr = netOf(diiRow);
    if (fiiCashNetCr === null && diiCashNetCr === null) {
      throw new NseApiError("Neither the FII nor the DII row carried parseable buy/sell values.");
    }

    return {
      date,
      fiiCashNetCr,
      diiCashNetCr,
      // `fiidiiTradeReact` is cash-only. These stay null rather than 0 so a
      // consumer can tell "not sourced yet" from "genuinely flat".
      fiiIndexFuturesNetCr: null,
      fiiIndexOptionsNetCr: null,
      publishedAt: new Date(),
    };
  }

  /**
   * Fetch the offshore (GIFT Nifty) close for a session, if a provider is configured.
   *
   * GIFT Nifty trades on NSE IX, which publishes no free machine-readable feed,
   * and no default Yahoo symbol carries it either. Rather than return a
   * placeholder — the previous behaviour was a hardcoded `closePrice: 0`, which
   * the collector then persisted as though it were a real print — this returns
   * null unless `GIFT_NIFTY_YAHOO_SYMBOL` names a series that actually resolves.
   * Point a paid feed at that env var, or leave the implied-gap feature absent.
   */
  async getGiftNiftyData(date: Date): Promise<OffshoreDerivative | null> {
    if (!this.giftNiftySymbol) return null;

    // Imported lazily: the default configuration never reaches this branch, and
    // yahoo-finance2 is heavy enough that the collector should not pay for it just
    // to discover that no offshore symbol is configured.
    const yahooModule = (await import("yahoo-finance2")) as unknown as {
      default: { chart: (symbol: string, options: Record<string, unknown>) => Promise<unknown> };
    };
    const dayAfter = new Date(date.getTime() + 24 * 60 * 60 * 1000);

    let quotes: Array<{ date: Date; close: number | null }>;
    try {
      const chart = (await yahooModule.default.chart(this.giftNiftySymbol, {
        period1: date,
        period2: dayAfter,
        interval: "1d",
      })) as { quotes?: Array<{ date: Date; close: number | null }> };
      quotes = chart.quotes ?? [];
    } catch (error) {
      throw new NseApiError(`GIFT Nifty quote request for ${this.giftNiftySymbol} failed.`, error);
    }

    const settled = quotes
      .filter((quote) => typeof quote.close === "number" && Number.isFinite(quote.close) && quote.close > 0)
      .at(-1);
    if (!settled) return null;

    return {
      instrumentId: "GIFT_NIFTY",
      date,
      closePrice: settled.close as number,
      publishedAt: new Date(),
    };
  }
}

import { describe, expect, it } from "vitest";
import {
  MAX_GIFT_QUOTE_AGE_MS,
  assessGiftQuoteFreshness,
  expiryDateSortKey,
  giftQuoteFromRow,
  selectGiftNiftyFuturesRow,
  type DerivativesRow,
} from "./nse-ix-client.js";

describe("giftQuoteFromRow", () => {
  // The real NSE IX row shape, captured 2026-10-12: TIMESTMP is IST with seconds.
  const row: DerivativesRow = {
    INSTRUMENTTYPE: "FUTIDX", SYMBOL: "NIFTY", EXPIRYDATE: "27-Oct-2026",
    LASTPRICE: "22379.00", PERCHANGE: ".04", TIMESTMP: "12-Oct-2026 17:31:33",
  };
  const fetchedAt = new Date("2026-10-12T12:02:21.000Z");

  it("reads the exchange's own last-update time, in IST, not the fetch time", () => {
    const quote = giftQuoteFromRow(row, fetchedAt)!;
    expect(quote.quoteTime!.toISOString()).toBe("2026-10-12T12:01:33.000Z"); // 17:31:33 IST
    expect(quote.observedAt).toBe(fetchedAt);
    expect(quote.lastPrice).toBe(22379);
    expect(quote.changePercent).toBeCloseTo(0.04, 5);
  });

  it("keeps the quote with a null quote time when the payload omits or garbles it", () => {
    expect(giftQuoteFromRow({ ...row, TIMESTMP: undefined }, fetchedAt)!.quoteTime).toBeNull();
    expect(giftQuoteFromRow({ ...row, TIMESTMP: "not a time" }, fetchedAt)!.quoteTime).toBeNull();
  });

  it("returns null when the price fields are unusable", () => {
    expect(giftQuoteFromRow({ ...row, LASTPRICE: "-" }, fetchedAt)).toBeNull();
  });
});

describe("assessGiftQuoteFreshness", () => {
  const now = new Date("2026-10-12T03:22:00.000Z"); // 08:52 IST

  it("is fresh for a recent print", () => {
    expect(assessGiftQuoteFreshness(new Date(now.getTime() - 3 * 60_000), now)).toEqual({ status: "FRESH", ageMs: 3 * 60_000 });
  });

  it("is stale beyond the limit -- last night's print, or a dead feed", () => {
    const result = assessGiftQuoteFreshness(new Date(now.getTime() - MAX_GIFT_QUOTE_AGE_MS - 1), now);
    expect(result.status).toBe("STALE");
  });

  it("is unknown, not stale, when there is no exchange time", () => {
    expect(assessGiftQuoteFreshness(null, now)).toEqual({ status: "UNKNOWN" });
  });

  it("treats a quote stamped well ahead of the clock as unknown rather than fresh", () => {
    expect(assessGiftQuoteFreshness(new Date(now.getTime() + 10 * 60_000), now)).toEqual({ status: "UNKNOWN" });
    // A little skew is tolerated.
    expect(assessGiftQuoteFreshness(new Date(now.getTime() + 30_000), now).status).toBe("FRESH");
  });
});

describe("expiryDateSortKey", () => {
  it("turns NSE IX's DD-Mon-YYYY into a lexically sortable key", () => {
    expect(expiryDateSortKey("27-Oct-2026")).toBe("2026-10-27");
    expect(expiryDateSortKey("5-Jan-2027")).toBe("2027-01-05");
  });

  it("sorts an unparseable value last rather than throwing", () => {
    expect(expiryDateSortKey("garbage")).toBe("9999-99-99");
    expect(expiryDateSortKey(undefined)).toBe("9999-99-99");
    expect(expiryDateSortKey(123)).toBe("9999-99-99");
  });
});

describe("selectGiftNiftyFuturesRow", () => {
  const nearMonth: DerivativesRow = {
    INSTRUMENTTYPE: "FUTIDX",
    SYMBOL: "NIFTY",
    EXPIRYDATE: "27-Oct-2026",
    LASTPRICE: "22575.50",
    PERCHANGE: "-.12",
  };
  const farMonth: DerivativesRow = {
    INSTRUMENTTYPE: "FUTIDX",
    SYMBOL: "NIFTY",
    EXPIRYDATE: "23-Nov-2026",
    LASTPRICE: "22620.00",
    PERCHANGE: "-.31",
  };
  const bankNiftyRow: DerivativesRow = {
    INSTRUMENTTYPE: "FUTIDX",
    SYMBOL: "BANKNIFTY",
    EXPIRYDATE: "27-Oct-2026",
    LASTPRICE: "54700",
    PERCHANGE: "0.2",
  };
  const optionRow: DerivativesRow = {
    INSTRUMENTTYPE: "OPTIDX",
    SYMBOL: "NIFTY",
    EXPIRYDATE: "27-Oct-2026",
    LASTPRICE: "100",
    PERCHANGE: "5",
  };

  it("picks the nearest-expiry NIFTY index-futures row among several contracts", () => {
    // NSE IX's own payload repeats each row (duplicate near-month and far-month entries).
    const rows = [nearMonth, nearMonth, farMonth, farMonth];
    expect(selectGiftNiftyFuturesRow(rows)).toBe(nearMonth);
  });

  it("ignores other symbols and instrument types", () => {
    const rows = [bankNiftyRow, optionRow, farMonth];
    expect(selectGiftNiftyFuturesRow(rows)).toBe(farMonth);
  });

  it("returns null when no matching row exists", () => {
    expect(selectGiftNiftyFuturesRow([bankNiftyRow, optionRow])).toBeNull();
    expect(selectGiftNiftyFuturesRow([])).toBeNull();
  });
});

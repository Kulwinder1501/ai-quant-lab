import { describe, expect, it } from "vitest";
import { expiryDateSortKey, selectGiftNiftyFuturesRow, type DerivativesRow } from "./nse-ix-client.js";

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

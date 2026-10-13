import { describe, expect, it } from "vitest";
import { lastTuesdayOfMonth, upcomingIndexFutures } from "./index-futures-contracts.js";

describe("lastTuesdayOfMonth", () => {
  it("matches the expiries the lab already holds", () => {
    expect(lastTuesdayOfMonth(2026, 7)).toBe("2026-08-25");
    expect(lastTuesdayOfMonth(2026, 8)).toBe("2026-09-29");
    expect(lastTuesdayOfMonth(2026, 9)).toBe("2026-10-27");
  });

  it("handles a month that ends on a Tuesday, and a leap February", () => {
    expect(lastTuesdayOfMonth(2026, 2)).toBe("2026-03-31");
    expect(lastTuesdayOfMonth(2028, 1)).toBe("2028-02-29");
  });
});

describe("upcomingIndexFutures", () => {
  it("returns the next two monthlies per index, nearest first", () => {
    const contracts = upcomingIndexFutures("2026-10-13");

    expect(contracts.map((contract) => contract.symbol)).toEqual([
      "NIFTY26OCTFUT", "NIFTY26NOVFUT", "BANKNIFTY26OCTFUT", "BANKNIFTY26NOVFUT",
    ]);
    expect(contracts[0]).toMatchObject({
      providerInstrumentId: "NSE:NIFTY26OCTFUT", underlyingSymbol: "NIFTY50", expiryDate: "2026-10-27", lotSize: 75,
    });
    expect(contracts[3]).toMatchObject({ underlyingSymbol: "BANKNIFTY", expiryDate: "2026-11-24", lotSize: 30 });
  });

  it("keeps a contract on its expiry day, and drops it the day after", () => {
    expect(upcomingIndexFutures("2026-10-27").map((c) => c.symbol)).toContain("NIFTY26OCTFUT");
    const after = upcomingIndexFutures("2026-10-28").map((c) => c.symbol);
    expect(after).not.toContain("NIFTY26OCTFUT");
    expect(after.slice(0, 2)).toEqual(["NIFTY26NOVFUT", "NIFTY26DECFUT"]);
  });

  it("rolls into the next calendar year", () => {
    const symbols = upcomingIndexFutures("2026-12-30").map((c) => c.symbol);
    expect(symbols).toEqual(["NIFTY27JANFUT", "NIFTY27FEBFUT", "BANKNIFTY27JANFUT", "BANKNIFTY27FEBFUT"]);
  });

  it("names a contract the way the existing ones are named", () => {
    expect(upcomingIndexFutures("2026-10-13")[0]!.displayName).toBe("NIFTY Oct 2026 Future");
  });
});

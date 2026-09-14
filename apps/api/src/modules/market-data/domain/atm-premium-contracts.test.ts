import { describe, expect, it } from "vitest";
import { premiumCoverageExpiries, selectAtmPremiumContracts } from "./atm-premium-contracts.js";
import type { OptionExpiryCalendar } from "./option-expiry-calendar.js";
import type { OptionChainSnapshot } from "./option-chain.js";

function snapshot(overrides: Partial<OptionChainSnapshot> = {}): OptionChainSnapshot {
  const expiry = new Date("2026-08-18T10:00:00.000Z");
  const make = (strike: number, type: "CE" | "PE") => ({
    expiryDate: expiry,
    expiryKind: "WEEKLY" as const,
    strikePrice: strike,
    optionType: type,
    providerSymbol: `NSE:NIFTY26AUG${strike}${type}`,
    providerToken: null,
    lastPrice: 100,
    bid: 99,
    ask: 101,
    volume: 1_000,
    openInterest: 10_000,
    previousOpenInterest: 9_000,
    openInterestChange: 1_000,
  });
  return {
    underlyingSymbol: "NIFTY50",
    provider: "fyers-api-v3",
    observedAt: new Date("2026-08-11T05:00:00.000Z"),
    underlyingValue: 24_650,
    quotes: [
      make(24_600, "CE"), make(24_600, "PE"),
      make(24_650, "CE"), make(24_650, "PE"),
      make(24_700, "CE"), make(24_700, "PE"),
    ],
    listedExpiries: [{ expiryDate: expiry, expiryKind: "WEEKLY" }],
    ...overrides,
  };
}

describe("selectAtmPremiumContracts", () => {
  it("selects ATM ±1 strikes for CE and PE", () => {
    const contracts = selectAtmPremiumContracts(snapshot(), {
      now: new Date("2026-08-11T05:05:00.000Z"),
    });
    const expiryIso = new Date("2026-08-18T10:00:00.000Z").toISOString().slice(0, 10);
    expect(contracts).toHaveLength(6);
    expect(contracts.every((c) => c.expiryDate === expiryIso)).toBe(true);
    expect(new Set(contracts.map((c) => c.strikePrice))).toEqual(
      new Set([24_600, 24_650, 24_700]),
    );
  });

  it("refuses a stale chain rather than inventing strikes", () => {
    const contracts = selectAtmPremiumContracts(snapshot(), {
      now: new Date("2026-08-11T06:00:00.000Z"),
      maxAgeMs: 40 * 60 * 1000,
    });
    expect(contracts).toHaveLength(0);
  });

  it("refuses when spot is missing", () => {
    expect(selectAtmPremiumContracts(snapshot({ underlyingValue: null }), {
      now: new Date("2026-08-11T05:05:00.000Z"),
    })).toHaveLength(0);
  });

  it("infers the strike grid only from the selected expiry", () => {
    const base = snapshot();
    const laterExpiry = new Date("2026-08-25T10:00:00.000Z");
    const mixed = snapshot({
      quotes: [
        ...base.quotes,
        ...base.quotes.map((quote, index) => ({
          ...quote,
          expiryDate: laterExpiry,
          strikePrice: 24_625 + index * 25,
        })),
      ],
    });
    const contracts = selectAtmPremiumContracts(mixed, {
      now: new Date("2026-08-11T05:05:00.000Z"),
    });
    expect(new Set(contracts.map((contract) => contract.strikePrice))).toEqual(
      new Set([24_600, 24_650, 24_700]),
    );
  });
});

describe("premiumCoverageExpiries", () => {
  const calendar = (dates: readonly string[]): OptionExpiryCalendar => ({
    underlyingSymbol: "BANKNIFTY",
    provider: "fyers",
    observedAt: new Date("2026-08-24T04:00:00.000Z"),
    // BANKNIFTY is monthly-only, which is why the roll is a 35-day jump rather than a week.
    expiries: dates.map((date) => ({ expiryDate: new Date(`${date}T10:00:00.000Z`), expiryKind: "MONTHLY" })),
  });

  it("returns one expiry when the front contract is itself tradable", () => {
    // 2026-08-21: the front expiry was 4 days out, and the bots traded normally.
    const keys = premiumCoverageExpiries(
      calendar(["2026-08-25", "2026-09-29"]), new Date("2026-08-21T04:00:00.000Z"), 2,
    );

    expect(keys).toEqual(["2026-08-25"]);
  });

  it("adds the rolled expiry once the front one is inside the trading floor", () => {
    // 2026-08-24: the front expiry is 1.25 days out, so the bot rolls to September and nothing was
    // collecting it. Both are needed -- the front for D2, the rolled one for the bots.
    const keys = premiumCoverageExpiries(
      calendar(["2026-08-25", "2026-09-29"]), new Date("2026-08-24T04:00:00.000Z"), 2,
    );

    expect(keys).toEqual(["2026-08-25", "2026-09-29"]);
  });

  it("keeps the front expiry first, so D2's nearest-expiry series is never displaced", () => {
    const keys = premiumCoverageExpiries(
      calendar(["2026-08-25", "2026-09-29"]), new Date("2026-08-25T04:00:00.000Z"), 2,
    );

    expect(keys[0]).toBe("2026-08-25");
    expect(keys).toContain("2026-09-29");
  });

  it("ignores an expiry that has already settled", () => {
    // Past 15:30 IST on expiry day the contract is gone; quoting it is not coverage.
    const keys = premiumCoverageExpiries(
      calendar(["2026-08-25", "2026-09-29"]), new Date("2026-08-25T10:30:00.000Z"), 2,
    );

    expect(keys).toEqual(["2026-09-29"]);
  });

  it("returns nothing rather than guessing when there is no calendar", () => {
    expect(premiumCoverageExpiries(null, new Date("2026-08-24T04:00:00.000Z"), 2)).toEqual([]);
  });
});

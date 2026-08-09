import { describe, expect, it } from "vitest";
import {
  assertSnapshotStorable,
  atmStrikeOf,
  expiriesOf,
  largestOpenInterestStrikes,
  moneynessOf,
  putCallRatios,
  quoteSpread,
  summariseLiquidity,
  impliedVolatilitySkew,
  type OptionChainQuote,
  type OptionChainSnapshot,
} from "./option-chain.js";

const EXPIRY = new Date("2026-08-04T10:00:00Z");
const OBSERVED_AT = new Date("2026-08-04T09:30:00Z");

function quote(overrides: Partial<OptionChainQuote> = {}): OptionChainQuote {
  return {
    expiryDate: EXPIRY,
    expiryKind: "WEEKLY",
    strikePrice: 24_000,
    optionType: "CE",
    providerSymbol: "NSE:NIFTY2680424000CE",
    providerToken: "101126080465853",
    lastPrice: 100,
    bid: 99,
    ask: 101,
    volume: 5_000,
    openInterest: 1_000,
    previousOpenInterest: 900,
    openInterestChange: 100,
    ...overrides,
  };
}

function snapshot(overrides: Partial<OptionChainSnapshot> = {}): OptionChainSnapshot {
  return {
    underlyingSymbol: "NIFTY50",
    provider: "fyers-api-v3",
    observedAt: new Date("2026-08-04T09:30:00Z"),
    underlyingValue: 24_010,
    quotes: [quote()],
    listedExpiries: [
      { expiryDate: new Date("2026-08-11T10:00:00.000Z"), expiryKind: "WEEKLY" },
      { expiryDate: new Date("2026-08-25T10:00:00.000Z"), expiryKind: "MONTHLY" },
    ],
    ...overrides,
  };
}

describe("quoteSpread", () => {
  it("reports the spread absolutely and against the mid", () => {
    const spread = quoteSpread(quote({ bid: 99, ask: 101 }));

    expect(spread).not.toBeNull();
    expect(spread!.absolute).toBeCloseTo(2, 10);
    expect(spread!.mid).toBeCloseTo(100, 10);
    expect(spread!.percentOfMid).toBeCloseTo(2, 10);
  });

  // The inversion that matters most: a contract nobody quotes has an UNKNOWN spread,
  // and calling it zero would rank the most illiquid strikes as the cheapest to trade.
  it.each([
    ["no bid", { bid: null }],
    ["no ask", { ask: null }],
  ])("returns null for a one-sided market (%s), never zero", (_label, overrides) => {
    expect(quoteSpread(quote(overrides))).toBeNull();
  });

  it("returns null for a non-positive mid rather than dividing by it", () => {
    expect(quoteSpread(quote({ bid: 0, ask: 0 }))).toBeNull();
  });

  it("returns null for an inverted market", () => {
    expect(quoteSpread(quote({ bid: 101, ask: 99 }))).toBeNull();
  });
});

describe("atmStrikeOf and moneynessOf", () => {
  const strikes = [23_900, 23_950, 24_000, 24_050].map((strikePrice) => quote({ strikePrice }));

  it("picks the nearest listed strike rather than rounding to a guessed step", () => {
    // The chain tells us which strikes exist, so no step needs guessing -- and a guessed
    // step can name a strike the exchange does not list.
    expect(atmStrikeOf(strikes, 24_010)).toBe(24_000);
    expect(atmStrikeOf(strikes, 23_930)).toBe(23_950);
  });

  it("returns null when there are no strikes to choose from", () => {
    expect(atmStrikeOf([], 24_000)).toBeNull();
  });

  it("classifies calls and puts on opposite sides of spot", () => {
    const spot = 24_010;
    const atm = 24_000;
    expect(moneynessOf(quote({ strikePrice: 24_000, optionType: "CE" }), spot, atm)).toBe("ATM");
    expect(moneynessOf(quote({ strikePrice: 23_900, optionType: "CE" }), spot, atm)).toBe("ITM");
    expect(moneynessOf(quote({ strikePrice: 24_500, optionType: "CE" }), spot, atm)).toBe("OTM");
    // A put is in the money above spot, which is the mirror of a call.
    expect(moneynessOf(quote({ strikePrice: 24_500, optionType: "PE" }), spot, atm)).toBe("ITM");
    expect(moneynessOf(quote({ strikePrice: 23_500, optionType: "PE" }), spot, atm)).toBe("OTM");
  });
});

describe("putCallRatios", () => {
  it("reports open-interest and volume ratios separately", () => {
    // They answer different questions: OI is carried positioning, volume is today.
    const ratios = putCallRatios([
      quote({ optionType: "CE", openInterest: 100, volume: 10 }),
      quote({ optionType: "PE", strikePrice: 24_050, openInterest: 150, volume: 5 }),
    ]);

    expect(ratios.openInterestRatio).toBeCloseTo(1.5, 10);
    expect(ratios.volumeRatio).toBeCloseTo(0.5, 10);
    expect(ratios).toMatchObject({ callOpenInterest: 100, putOpenInterest: 150 });
  });

  it("returns null rather than infinity when there is no call side", () => {
    const ratios = putCallRatios([quote({ optionType: "PE", openInterest: 10, volume: 10 })]);

    expect(ratios.openInterestRatio).toBeNull();
    expect(ratios.volumeRatio).toBeNull();
  });

  it("treats a missing open interest as absent, contributing nothing", () => {
    const ratios = putCallRatios([
      quote({ optionType: "CE", openInterest: 100, volume: null }),
      quote({ optionType: "PE", strikePrice: 24_050, openInterest: null, volume: null }),
    ]);

    expect(ratios.putOpenInterest).toBe(0);
    expect(ratios.openInterestRatio).toBeCloseTo(0, 10);
    expect(ratios.volumeRatio).toBeNull();
  });
});

describe("largestOpenInterestStrikes", () => {
  it("finds the heaviest strike on each side", () => {
    const result = largestOpenInterestStrikes([
      quote({ optionType: "CE", strikePrice: 24_000, openInterest: 100 }),
      quote({ optionType: "CE", strikePrice: 24_500, openInterest: 900 }),
      quote({ optionType: "PE", strikePrice: 23_500, openInterest: 700 }),
    ]);

    expect(result.call).toEqual({ strikePrice: 24_500, openInterest: 900 });
    expect(result.put).toEqual({ strikePrice: 23_500, openInterest: 700 });
  });

  it("returns null for a side with no measurable open interest", () => {
    const result = largestOpenInterestStrikes([quote({ optionType: "CE", openInterest: 5 })]);

    expect(result.put).toBeNull();
  });
});

describe("summariseLiquidity", () => {
  it("counts only contracts that can actually be costed", () => {
    const summary = summariseLiquidity([
      quote({ bid: 99, ask: 101 }),                              // 2% of mid
      quote({ strikePrice: 24_050, bid: 100, ask: 100.5 }),       // ~0.5%
      quote({ strikePrice: 24_100, bid: null, ask: 50 }),         // uncostable
    ]);

    expect(summary.contracts).toBe(3);
    expect(summary.quotedBothSides).toBe(2);
    expect(summary.medianSpreadPercent).toBeCloseTo((2 + 0.4987562189) / 2, 4);
  });

  // The 1% default is the measured figure: the volatility edge dies near 1.09% per leg.
  it("counts how many contracts fit the cost budget the edge can afford", () => {
    const summary = summariseLiquidity([
      quote({ bid: 100, ask: 100.5 }),                       // ~0.5% -> affordable
      quote({ strikePrice: 24_050, bid: 90, ask: 110 }),      // 20%   -> not
    ], 1.0);

    expect(summary.withinCostBudget).toBe(1);
    expect(summary.costBudgetPercent).toBe(1.0);
  });

  it("reports a null median when nothing is two-sided", () => {
    expect(summariseLiquidity([quote({ bid: null, ask: null })]).medianSpreadPercent).toBeNull();
  });
});

describe("assertSnapshotStorable", () => {
  it("accepts a well-formed snapshot", () => {
    expect(() => assertSnapshotStorable(snapshot())).not.toThrow();
  });

  // An empty book is a provider or auth fault. Storing it would put a snapshot with no
  // rows into the table whose entire purpose is to be the raw record.
  it("refuses an empty chain rather than storing a snapshot with no contracts", () => {
    expect(() => assertSnapshotStorable(snapshot({ quotes: [] }))).toThrow(/no contracts/);
  });

  it("refuses an inverted market", () => {
    expect(() => assertSnapshotStorable(snapshot({ quotes: [quote({ bid: 120, ask: 100 })] })))
      .toThrow(/ask below bid/);
  });

  it("refuses a non-positive strike", () => {
    expect(() => assertSnapshotStorable(snapshot({ quotes: [quote({ strikePrice: 0 })] })))
      .toThrow(/non-positive strike/);
  });

  it("names the duplicated contract instead of leaving it to the unique index", () => {
    expect(() => assertSnapshotStorable(snapshot({ quotes: [quote(), quote()] })))
      .toThrow(/repeated contract/);
  });
});

describe("expiriesOf", () => {
  it("lists distinct expiries earliest first, carrying their kind", () => {
    const later = new Date("2026-08-25T10:00:00Z");
    const result = expiriesOf(snapshot({
      quotes: [
        quote({ expiryDate: later, expiryKind: "MONTHLY", strikePrice: 24_050 }),
        quote({ expiryDate: EXPIRY, expiryKind: "WEEKLY" }),
        quote({ expiryDate: EXPIRY, expiryKind: "WEEKLY", optionType: "PE" }),
      ],
    }));

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ expiryKind: "WEEKLY" });
    expect(result[1]).toMatchObject({ expiryKind: "MONTHLY" });
  });
});

describe("impliedVolatilitySkew", () => {
  it("calculates skew as put IV minus call IV at target offset", () => {
    // 24000 spot. 2% OTM is 23520 (PE) and 24480 (CE).
    // Closest listed strikes in quotes: 23500 PE and 24500 CE.
    const quotes = [
      // Call side
      quote({ strikePrice: 24_000, optionType: "CE", bid: 200, ask: 202 }),
      quote({ strikePrice: 24_500, optionType: "CE", bid: 30, ask: 32 }), // 2% OTM Call
      quote({ strikePrice: 24_600, optionType: "CE", bid: 20, ask: 22 }),
      // Put side
      quote({ strikePrice: 24_000, optionType: "PE", bid: 200, ask: 202 }),
      quote({ strikePrice: 23_500, optionType: "PE", bid: 45, ask: 47 }), // 2% OTM Put
      quote({ strikePrice: 23_400, optionType: "PE", bid: 35, ask: 37 }),
    ];

    const result = impliedVolatilitySkew(quotes, 24_000, OBSERVED_AT, 0.02);

    expect(result.putStrike).toBe(23_500);
    expect(result.callStrike).toBe(24_500);
    expect(result.putIv).toBeGreaterThan(0);
    expect(result.callIv).toBeGreaterThan(0);
    expect(typeof result.skew).toBe("number");

    // In typical equity index markets, OTM puts trade at a premium to OTM calls (volatility smirk)
    // Because we set the PE bid/ask higher than CE bid/ask in the mock, put IV > call IV
    expect(result.skew).toBeGreaterThan(0);
  });

  it("returns null if no quotes or invalid underlying", () => {
    expect(impliedVolatilitySkew([], 24_000, OBSERVED_AT).skew).toBeNull();
    expect(impliedVolatilitySkew([quote()], NaN, OBSERVED_AT).skew).toBeNull();
  });

  it("scopes to the nearest listed expiry, ignoring a later expiry's quotes", () => {
    // A chain fetched with no expiry filter spans every listed expiry. A far-dated
    // monthly at the same 2% OTM strikes, priced for a much wider move, must not blend
    // into the near-week skew -- that would average two different term-structure
    // points into a number that describes neither.
    const monthly = new Date("2026-08-25T10:00:00Z");
    const nearWeek = [
      quote({ expiryDate: EXPIRY, strikePrice: 24_500, optionType: "CE", bid: 30, ask: 32 }),
      quote({ expiryDate: EXPIRY, strikePrice: 23_500, optionType: "PE", bid: 45, ask: 47 }),
    ];
    const laterMonth = [
      quote({ expiryDate: monthly, strikePrice: 24_500, optionType: "CE", bid: 300, ask: 320 }),
      quote({ expiryDate: monthly, strikePrice: 23_500, optionType: "PE", bid: 450, ask: 470 }),
    ];

    const scoped = impliedVolatilitySkew(nearWeek, 24_000, OBSERVED_AT, 0.02);
    const mixed = impliedVolatilitySkew([...nearWeek, ...laterMonth], 24_000, OBSERVED_AT, 0.02);

    expect(mixed.putIv).toBeCloseTo(scoped.putIv as number, 10);
    expect(mixed.callIv).toBeCloseTo(scoped.callIv as number, 10);
    expect(mixed.skew).toBeCloseTo(scoped.skew as number, 10);
  });
});

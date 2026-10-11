import { describe, expect, it } from "vitest";
import {
  RISK_FREE_RATE,
  effectiveSpotForForward,
  impliedVolatilityFromPremium,
  priceEuropeanOption,
  yearsToExpiry,
} from "@ai-quant-lab/pricing";
import { atmImpliedVolatility, calendarDaysToExpiry, type AtmQuote } from "./atm-implied-volatility.js";
import {
  MINIMUM_BUCKET_OBSERVATIONS,
  buildTenorIvHistory,
  ivPercentileForValidator,
  ivTenorBucket,
  summariseTenorMatchedIvPercentile,
  type DailyChainQuote,
  type TenorImpliedVolatilityObservation,
} from "./iv-percentile-by-tenor.js";

/** A two-sided parity-consistent chain priced on `forward`, so the true IV is `sigma`. */
function chain(input: { observedAt: Date; expiryDate: Date; forward: number; sigma: number }): AtmQuote[] {
  const time = yearsToExpiry(input.observedAt, input.expiryDate);
  const spot = effectiveSpotForForward(input.forward, RISK_FREE_RATE, time);
  const quotes: AtmQuote[] = [];
  for (let strike = input.forward - 500; strike <= input.forward + 500; strike += 50) {
    for (const optionType of ["CE", "PE"] as const) {
      const premium = priceEuropeanOption({
        spot, strike, timeToExpiryYears: time, riskFreeRate: RISK_FREE_RATE, volatility: input.sigma, optionType,
      }).premium;
      quotes.push({ strikePrice: strike, optionType, bid: premium - 0.05, ask: premium + 0.05 });
    }
  }
  return quotes;
}

const OBSERVED = new Date("2026-09-01T09:45:00Z"); // 15:15 IST
const EXPIRY_TOMORROW = new Date("2026-09-02T10:00:00Z"); // 15:30 IST
const EXPIRY_IN_5 = new Date("2026-09-06T10:00:00Z");

describe("calendarDaysToExpiry", () => {
  it("counts IST dates, so a snapshot a minute past the prior settle time is still 1 day out", () => {
    expect(calendarDaysToExpiry(OBSERVED, EXPIRY_TOMORROW)).toBe(1);
    expect(calendarDaysToExpiry(new Date("2026-09-01T10:01:00Z"), EXPIRY_TOMORROW)).toBe(1);
    expect(calendarDaysToExpiry(OBSERVED, new Date("2026-09-01T10:00:00Z"))).toBe(0);
    expect(calendarDaysToExpiry(OBSERVED, EXPIRY_IN_5)).toBe(5);
  });
});

describe("atmImpliedVolatility", () => {
  it("recovers the generating volatility on the parity forward and reports the DTE", () => {
    const quotes = chain({ observedAt: OBSERVED, expiryDate: EXPIRY_IN_5, forward: 23_480, sigma: 0.12 });
    const result = atmImpliedVolatility({ observedAt: OBSERVED, expiryDate: EXPIRY_IN_5, quotes });

    expect(result.measurable).toBe(true);
    if (!result.measurable) return;
    expect(result.impliedVolatility).toBeCloseTo(0.12, 2);
    expect(result.impliedForward).toBeCloseTo(23_480, -1);
    // The grid is forward +/- k*50, so the forward itself is the ATM strike.
    expect(result.atmStrike).toBe(23_480);
    expect(result.daysToExpiry).toBe(5);
  });

  it("is on the forward basis: a spot-based solve of the same chain reads materially different", () => {
    // Carry/dividend gap of 100 points between spot and forward on a 5-day option.
    const quotes = chain({ observedAt: OBSERVED, expiryDate: EXPIRY_IN_5, forward: 23_480, sigma: 0.12 });
    const onForward = atmImpliedVolatility({ observedAt: OBSERVED, expiryDate: EXPIRY_IN_5, quotes });
    if (!onForward.measurable) throw new Error("expected measurable");
    // The same ATM put mid solved against a spot 100 points above the forward-consistent one.
    const time = yearsToExpiry(OBSERVED, EXPIRY_IN_5);
    const atmPut = quotes.find((quote) => quote.strikePrice === onForward.atmStrike && quote.optionType === "PE")!;
    const putMid = ((atmPut.bid as number) + (atmPut.ask as number)) / 2;
    const rawSpot = effectiveSpotForForward(23_480, RISK_FREE_RATE, time) + 100;
    const onSpot = impliedVolatilityFromPremium({
      spot: rawSpot, strike: onForward.atmStrike, timeToExpiryYears: time,
      riskFreeRate: RISK_FREE_RATE, optionType: "PE", premium: putMid,
    });
    expect(onSpot.measurable).toBe(true);
    if (!onSpot.measurable) return;
    // A spot/forward basis gap moves the reading by whole vol points: comparing the two bases
    // would rank a level shift, not volatility.
    expect(Math.abs(onSpot.impliedVolatility - onForward.impliedVolatility)).toBeGreaterThan(0.01);
  });

  it("refuses rather than falling back to spot when parity cannot be evaluated", () => {
    const callsOnly = chain({ observedAt: OBSERVED, expiryDate: EXPIRY_IN_5, forward: 23_480, sigma: 0.12 })
      .filter((quote) => quote.optionType === "CE");
    const result = atmImpliedVolatility({ observedAt: OBSERVED, expiryDate: EXPIRY_IN_5, quotes: callsOnly });

    expect(result).toMatchObject({ measurable: false, reason: "NO_PARITY_FORWARD" });
  });

  it("refuses an expired contract", () => {
    const result = atmImpliedVolatility({ observedAt: EXPIRY_IN_5, expiryDate: OBSERVED, quotes: [] });
    expect(result).toMatchObject({ measurable: false, reason: "EXPIRED" });
  });
});

describe("ivTenorBucket", () => {
  it.each([
    [0, null], [0.4, null], [Number.NaN, null],
    [1, "DTE_1"], [2, "DTE_2_3"], [3, "DTE_2_3"], [4, "DTE_4_7"], [7, "DTE_4_7"], [8, "DTE_8_PLUS"], [30, "DTE_8_PLUS"],
  ])("DTE %s -> %s", (dte, bucket) => {
    expect(ivTenorBucket(dte)).toBe(bucket);
  });
});

function observations(count: number, dte: number, base: number, step = 0.001, startDay = 1): TenorImpliedVolatilityObservation[] {
  return Array.from({ length: count }, (_unused, index) => ({
    date: `2026-0${7 + Math.floor((startDay + index - 1) / 28)}-${String(((startDay + index - 1) % 28) + 1).padStart(2, "0")}`,
    impliedVolatility: base + index * step,
    daysToExpiry: dte,
  }));
}

describe("summariseTenorMatchedIvPercentile", () => {
  it("ranks only against the same bucket, not against other tenors", () => {
    // 25 days at DTE 1 priced rich (0.145+) and 25 days at DTE 5 priced low (0.090-0.114).
    const history = [
      ...observations(25, 1, 0.145, 0.0005, 1),
      ...observations(25, 5, 0.09, 0.001, 30),
    ];
    const result = summariseTenorMatchedIvPercentile({
      history, current: { impliedVolatility: 0.102, daysToExpiry: 5 },
    });

    expect(result.measurable).toBe(true);
    if (!result.measurable) return;
    expect(result.bucket).toBe("DTE_4_7");
    expect(result.observedDays).toBe(25);
    // 0.102 sits above the 12 values 0.090..0.101 of the DTE-5 history -> 12/25.
    expect(result.percentile).toBeCloseTo(48, 5);
    // Against the pooled history the same reading would rank at 24/50: the pollution this removes.
    const pooled = summariseTenorMatchedIvPercentile({
      history: history.map((entry) => ({ ...entry, daysToExpiry: 5 })),
      current: { impliedVolatility: 0.102, daysToExpiry: 5 },
    });
    expect(pooled.measurable && pooled.percentile).not.toBeCloseTo(48, 0);
  });

  it("refuses a bucket with fewer than the minimum observations, naming the bucket", () => {
    const history = [...observations(MINIMUM_BUCKET_OBSERVATIONS - 1, 3, 0.1), ...observations(40, 5, 0.1, 0.001, 40)];
    const result = summariseTenorMatchedIvPercentile({
      history, current: { impliedVolatility: 0.11, daysToExpiry: 3 },
    });

    expect(result).toMatchObject({
      measurable: false,
      reason: "INSUFFICIENT_BUCKET_HISTORY",
      bucket: "DTE_2_3",
      observedDays: MINIMUM_BUCKET_OBSERVATIONS - 1,
      requiredDays: MINIMUM_BUCKET_OBSERVATIONS,
    });
  });

  it("excludes expiry day on the current side and from the base", () => {
    const history = observations(30, 0, 0.2);
    expect(summariseTenorMatchedIvPercentile({
      history, current: { impliedVolatility: 0.2, daysToExpiry: 0 },
    })).toMatchObject({ measurable: false, reason: "EXPIRY_DAY_EXCLUDED" });
    // DTE-0 history never counts toward any bucket.
    expect(summariseTenorMatchedIvPercentile({
      history, current: { impliedVolatility: 0.2, daysToExpiry: 1 },
    })).toMatchObject({ measurable: false, reason: "INSUFFICIENT_BUCKET_HISTORY", observedDays: 0 });
  });

  it("refuses without a current reading", () => {
    expect(summariseTenorMatchedIvPercentile({ history: observations(30, 5, 0.1), current: null }))
      .toMatchObject({ measurable: false, reason: "NO_CURRENT_READING" });
  });

  it("maps to the validator's 0-100 field, and to null when not measurable", () => {
    const ok = summariseTenorMatchedIvPercentile({
      history: observations(25, 5, 0.1), current: { impliedVolatility: 0.5, daysToExpiry: 5 },
    });
    expect(ivPercentileForValidator(ok)).toBe(100);
    expect(ivPercentileForValidator(summariseTenorMatchedIvPercentile({ history: [], current: null }))).toBeNull();
  });
});

describe("buildTenorIvHistory", () => {
  it("solves each day on the parity forward and tags it with its own DTE", () => {
    const days: Array<{ date: string; observedAt: Date; expiryDate: Date; sigma: number }> = [
      { date: "2026-09-01", observedAt: OBSERVED, expiryDate: EXPIRY_IN_5, sigma: 0.11 },
      { date: "2026-09-02", observedAt: new Date("2026-09-02T09:45:00Z"), expiryDate: EXPIRY_IN_5, sigma: 0.13 },
    ];
    const quotes: DailyChainQuote[] = days.flatMap((day) => chain({
      observedAt: day.observedAt, expiryDate: day.expiryDate, forward: 23_480, sigma: day.sigma,
    }).map((quote) => ({ ...quote, date: day.date, observedAt: day.observedAt, expiryDate: day.expiryDate })));

    const history = buildTenorIvHistory(quotes);

    expect(history).toHaveLength(2);
    expect(history[0]!.impliedVolatility).toBeCloseTo(0.11, 2);
    expect(history[0]!.daysToExpiry).toBe(5);
    expect(history[1]!.impliedVolatility).toBeCloseTo(0.13, 2);
    expect(history[1]!.daysToExpiry).toBe(4);
  });

  it("skips a day whose parity forward cannot be solved instead of using spot", () => {
    const callsOnly = chain({ observedAt: OBSERVED, expiryDate: EXPIRY_IN_5, forward: 23_480, sigma: 0.12 })
      .filter((quote) => quote.optionType === "CE")
      .map((quote) => ({ ...quote, date: "2026-09-01", observedAt: OBSERVED, expiryDate: EXPIRY_IN_5 }));

    expect(buildTenorIvHistory(callsOnly)).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import {
  premiumCoverageExpiries,
  selectAtmPremiumContracts,
  selectDeltaTargetPremiumContracts,
} from "./atm-premium-contracts.js";
import type { OptionExpiryCalendar } from "./option-expiry-calendar.js";
import type { OptionChainQuote, OptionChainSnapshot } from "./option-chain.js";
import { priceEuropeanOption, RISK_FREE_RATE, yearsToExpiry } from "@ai-quant-lab/pricing";
import { solveContractGreeksFromChain } from "./chain-greeks.js";
import { resolveOptionEntryDeltaThresholds } from "./option-entry-delta-thresholds.js";

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

  it("chooses ATM from spotOverride when given, not the snapshot's own (possibly stale) spot", () => {
    // Snapshot spot is 24,650; a live spot of 24,700 has since moved a full strike. Before
    // spotOverride existed, this always picked ATM from the snapshot's spot regardless of how
    // stale it was -- exactly the defect that left the true ATM strike uncovered for several
    // minutes at the open on 43% of sessions.
    const contracts = selectAtmPremiumContracts(snapshot(), {
      now: new Date("2026-08-11T05:05:00.000Z"),
      strikeBand: 0,
      spotOverride: 24_700,
    });
    expect(new Set(contracts.map((c) => c.strikePrice))).toEqual(new Set([24_700]));
  });

  it("falls back to the snapshot's own spot when spotOverride is null or missing", () => {
    const withNull = selectAtmPremiumContracts(snapshot(), {
      now: new Date("2026-08-11T05:05:00.000Z"),
      strikeBand: 0,
      spotOverride: null,
    });
    const withoutOption = selectAtmPremiumContracts(snapshot(), {
      now: new Date("2026-08-11T05:05:00.000Z"),
      strikeBand: 0,
    });
    expect(new Set(withNull.map((c) => c.strikePrice))).toEqual(new Set([24_650]));
    expect(new Set(withoutOption.map((c) => c.strikePrice))).toEqual(new Set([24_650]));
  });

  it("ignores a non-finite or non-positive spotOverride rather than trusting it", () => {
    const contracts = selectAtmPremiumContracts(snapshot(), {
      now: new Date("2026-08-11T05:05:00.000Z"),
      strikeBand: 0,
      spotOverride: -100,
    });
    expect(new Set(contracts.map((c) => c.strikePrice))).toEqual(new Set([24_650]));
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

/**
 * A synthetic chain priced by this project's own Black-Scholes engine so delta is exactly known,
 * built to match the real BANKNIFTY monthly book measured live on 2026-10-05: spot 54,612.70,
 * expiry 2026-10-27 (22.1 DTE at that observation), 100-point strikes, ~17% IV -- the chain whose
 * 0.75-delta call landed 11-15 strikes below ATM and whose idea refused with
 * `NO_FRESH_EXECUTABLE_QUOTE` for exactly that reason.
 */
function bankniftyLikeSnapshot(overrides: Partial<OptionChainSnapshot> = {}): OptionChainSnapshot {
  const observedAt = new Date("2026-10-05T07:23:00.687Z");
  const expiry = new Date("2026-10-27T10:00:00.000Z");
  const spot = 54_612.7;
  const iv = 0.17;
  const step = 100;
  const atm = Math.round(spot / step) * step;
  const timeToExpiryYears = yearsToExpiry(observedAt, expiry);

  const quotes: OptionChainQuote[] = [];
  for (let i = -20; i <= 20; i += 1) {
    const strike = atm + i * step;
    for (const optionType of ["CE", "PE"] as const) {
      const { premium } = priceEuropeanOption({
        spot, strike, timeToExpiryYears, riskFreeRate: RISK_FREE_RATE, volatility: iv, optionType,
      });
      const halfSpread = Math.max(premium * 0.01, 0.5);
      quotes.push({
        expiryDate: expiry,
        expiryKind: "MONTHLY",
        strikePrice: strike,
        optionType,
        providerSymbol: `NSE:BANKNIFTY26OCT${strike}${optionType}`,
        providerToken: null,
        lastPrice: premium,
        bid: Math.max(0.05, premium - halfSpread),
        ask: premium + halfSpread,
        volume: 1_000,
        openInterest: 10_000,
        previousOpenInterest: 9_000,
        openInterestChange: 1_000,
      });
    }
  }

  return {
    underlyingSymbol: "BANKNIFTY",
    provider: "fyers-api-v3",
    observedAt,
    underlyingValue: spot,
    quotes,
    listedExpiries: [{ expiryDate: expiry, expiryKind: "MONTHLY" }],
    ...overrides,
  };
}

describe("selectDeltaTargetPremiumContracts", () => {
  it("covers the real 2026-10-05 BANKNIFTY failure: a 0.75-delta call the ATM band misses", () => {
    const snap = bankniftyLikeSnapshot();
    const now = new Date("2026-10-05T07:25:00.000Z");

    // The ATM band (what shipped) does not reach it.
    const atmOnly = selectAtmPremiumContracts(snap, { strikeBand: 1, now });
    expect(atmOnly.some((c) => c.optionType === "CE" && c.strikePrice <= 53_500)).toBe(false);

    // The delta-target selection does. With this synthetic chain's flat 17% IV the closest strike
    // to clear the 0.75 floor is 53,300 (the live incident's own mixed-IV book put it a step away
    // at 53,400 -- both sit 12-13 strikes below ATM, which is the point: either way, strikeBand
    // 1-3 (the CLI's enforced ceiling) cannot reach it, and this does.
    const deltaTargeted = selectDeltaTargetPremiumContracts(snap, { now, targetDelta: 0.75 });
    const ceStrikes = deltaTargeted.filter((c) => c.optionType === "CE").map((c) => c.strikePrice);
    expect(ceStrikes.length).toBeGreaterThan(0);
    expect(ceStrikes).toContain(53_300);
    expect(Math.min(...ceStrikes)).toBeLessThanOrEqual(53_300 - 200);
  });

  it("selects the strike closest to 0.75 delta among those that clear the floor, not merely any ITM strike", () => {
    const snap = bankniftyLikeSnapshot();
    const contracts = selectDeltaTargetPremiumContracts(snap, {
      now: new Date("2026-10-05T07:25:00.000Z"),
      targetDelta: 0.75,
      strikeMargin: 0,
    });
    const ceStrikes = contracts.filter((c) => c.optionType === "CE").map((c) => c.strikePrice);
    expect(ceStrikes).toEqual([53_300]);
  });

  it("widens coverage with strikeMargin to absorb drift between snapshots", () => {
    const snap = bankniftyLikeSnapshot();
    const now = new Date("2026-10-05T07:25:00.000Z");
    const tight = selectDeltaTargetPremiumContracts(snap, { now, strikeMargin: 0 });
    const wide = selectDeltaTargetPremiumContracts(snap, { now, strikeMargin: 3 });
    const ceTight = tight.filter((c) => c.optionType === "CE").length;
    const ceWide = wide.filter((c) => c.optionType === "CE").length;
    expect(ceWide).toBeGreaterThan(ceTight);
    expect(ceWide).toBeLessThanOrEqual(7); // 2*3+1 -- cheap relative to a band wide enough for this DTE
  });

  it("returns nothing for a side whose listed strikes never reach the delta floor", () => {
    // Mirrors the live BANKNIFTY put side on 2026-10-05: the furthest listed strike only reached
    // delta -0.71, short of the 0.75 floor PrepareOptionEntry enforces. There is nothing to
    // pre-emptively quote -- PrepareOptionEntry refuses that side with NO_OPTION_ENTRY regardless
    // of what this collector does.
    const snap = bankniftyLikeSnapshot();
    const narrow: OptionChainSnapshot = {
      ...snap,
      quotes: snap.quotes.filter((q) => q.strikePrice >= 53_900 && q.strikePrice <= 55_300),
    };
    const contracts = selectDeltaTargetPremiumContracts(narrow, {
      now: new Date("2026-10-05T07:25:00.000Z"),
      targetDelta: 0.75,
    });
    expect(contracts.filter((c) => c.optionType === "PE")).toHaveLength(0);
  });

  it("honours an explicit targetDelta override", () => {
    const snap = bankniftyLikeSnapshot();
    const contracts = selectDeltaTargetPremiumContracts(snap, {
      now: new Date("2026-10-05T07:25:00.000Z"),
      targetDelta: 0.5,
      strikeMargin: 0,
    });
    const ceStrikes = contracts.filter((c) => c.optionType === "CE").map((c) => c.strikePrice);
    // With a 0.50 target the closest eligible strike is at or near ATM, nowhere near the deep-ITM
    // 53,400 the 0.75 target needs.
    expect(ceStrikes.length).toBeGreaterThan(0);
    expect(Math.min(...ceStrikes)).toBeGreaterThan(54_000);
  });

  describe("follows the entry gate's own thresholds by default", () => {
    const now = new Date("2026-10-05T07:25:00.000Z");
    const gateChoice = (snap: OptionChainSnapshot, optionType: "CE" | "PE", minDelta: number, targetDelta: number): number => {
      const candidates = snap.quotes
        .filter((q) => q.optionType === optionType)
        .map((q) => ({ strike: q.strikePrice, d: Math.abs(solveContractGreeksFromChain({ snapshot: snap, strikePrice: q.strikePrice, optionType })?.delta ?? NaN) }))
        .filter((c) => Number.isFinite(c.d) && c.d >= minDelta)
        .sort((a, b) => Math.abs(a.d - targetDelta) - Math.abs(b.d - targetDelta));
      return candidates[0]!.strike;
    };

    it("regression 2026-10-12: far-dated BANKNIFTY quotes the 0.65-delta strike the gate picks, not the 0.75 one", () => {
      // 22 DTE: the gate resolves 0.55 floor / 0.65 target. The collector used to chase 0.75 and quoted
      // strikes ~300-400 points deeper than the one the gate then asked for, so every idea refused
      // NO_FRESH_EXECUTABLE_QUOTE.
      const snap = bankniftyLikeSnapshot();
      expect(resolveOptionEntryDeltaThresholds("BANKNIFTY", 22)).toEqual({ minEntryDelta: 0.55, targetDelta: 0.65 });
      const contracts = selectDeltaTargetPremiumContracts(snap, { now, strikeMargin: 0 });
      for (const optionType of ["CE", "PE"] as const) {
        const strikes = contracts.filter((c) => c.optionType === optionType).map((c) => c.strikePrice);
        expect(strikes).toEqual([gateChoice(snap, optionType, 0.55, 0.65)]);
      }
      const deep = selectDeltaTargetPremiumContracts(snap, { now, strikeMargin: 0, targetDelta: 0.75 });
      const ce = (list: typeof deep) => list.find((c) => c.optionType === "CE")!.strikePrice;
      expect(ce(contracts)).toBeGreaterThan(ce(deep)); // the call side is shallower, i.e. nearer spot
    });

    it("skips a strike the gate would skip for want of a two-sided quote, as the gate does", () => {
      const snap = bankniftyLikeSnapshot();
      const first = selectDeltaTargetPremiumContracts(snap, { now, strikeMargin: 0 });
      const ceFirst = first.find((c) => c.optionType === "CE")!.strikePrice;
      // Make the gate's favourite call strike illiquid (no ask above its bid).
      const thin: OptionChainSnapshot = {
        ...snap,
        quotes: snap.quotes.map((q) => (q.optionType === "CE" && q.strikePrice === ceFirst ? { ...q, bid: 50, ask: 50 } : q)),
      };
      const second = selectDeltaTargetPremiumContracts(thin, { now, strikeMargin: 0 });
      const ceSecond = second.find((c) => c.optionType === "CE")!.strikePrice;
      expect(ceSecond).not.toBe(ceFirst);
      const liquid = thin.quotes.filter((q) => q.optionType === "CE" && q.ask! > q.bid!);
      const expected = liquid
        .map((q) => ({ strike: q.strikePrice, d: Math.abs(solveContractGreeksFromChain({ snapshot: thin, strikePrice: q.strikePrice, optionType: "CE" })?.delta ?? NaN) }))
        .filter((c) => Number.isFinite(c.d) && c.d >= 0.55)
        .sort((a, b) => Math.abs(a.d - 0.65) - Math.abs(b.d - 0.65))[0]!.strike;
      expect(ceSecond).toBe(expected);
    });

    it("keeps NIFTY50 on 0.75/0.75 whatever the days to expiry", () => {
      const snap = bankniftyLikeSnapshot({ underlyingSymbol: "NIFTY50" });
      expect(selectDeltaTargetPremiumContracts(snap, { now })).toEqual(
        selectDeltaTargetPremiumContracts(snap, { now, targetDelta: 0.75 }),
      );
    });

    it("switches BANKNIFTY to 0.75/0.75 once its own expiry is within 10 days", () => {
      const nearNow = new Date("2026-10-20T07:25:00.000Z"); // 7.1 days to 2026-10-27 10:00Z
      const snap = bankniftyLikeSnapshot({ observedAt: new Date("2026-10-20T07:23:00.000Z") });
      expect(selectDeltaTargetPremiumContracts(snap, { now: nearNow })).toEqual(
        selectDeltaTargetPremiumContracts(snap, { now: nearNow, targetDelta: 0.75 }),
      );
    });

    it("lets an explicit target override both the target and the floor", () => {
      const snap = bankniftyLikeSnapshot();
      const pinned = selectDeltaTargetPremiumContracts(snap, { now, strikeMargin: 0, targetDelta: 0.65 });
      expect(pinned.find((c) => c.optionType === "CE")!.strikePrice).toBe(gateChoice(snap, "CE", 0.65, 0.65));
    });
  });

  it("refuses a stale chain rather than inventing a target strike", () => {
    const snap = bankniftyLikeSnapshot();
    const contracts = selectDeltaTargetPremiumContracts(snap, {
      now: new Date("2026-10-05T08:10:00.000Z"), // 47 minutes later
      maxAgeMs: 40 * 60 * 1000,
    });
    expect(contracts).toHaveLength(0);
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

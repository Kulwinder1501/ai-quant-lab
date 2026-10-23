import { describe, expect, it } from "vitest";
import {
  RISK_FREE_RATE,
  effectiveSpotForForward,
  impliedVolatilityFromPremium,
} from "@ai-quant-lab/pricing";
import { applyChainTick, type ChainResponse, type Leg } from "./live-chain";

function leg(providerSymbol: string, overrides: Partial<Leg> = {}): Leg {
  return {
    lastPrice: 100, bid: 99, ask: 101, volume: 10, openInterest: 1000, openInterestChange: 0,
    spreadAbsolute: 2, spreadPercentOfMid: 2, withinCostBudget: false, moneyness: "ATM",
    providerSymbol, impliedVolatility: 0.15, impliedVolatilityRefusal: null,
    delta: 0.5, gamma: 0.001, theta: -10, vega: 12, daysToExpiry: 7,
    ...overrides,
  };
}

function chain(): ChainResponse {
  return {
    underlyingSymbol: "NIFTY50",
    available: true,
    underlyingValue: 22350,
    strikes: [
      { strikePrice: 22300, isAtm: false, call: leg("NSE:NIFTY26OCT22300CE"), put: leg("NSE:NIFTY26OCT22300PE") },
      { strikePrice: 22350, isAtm: true, call: leg("NSE:NIFTY26OCT22350CE"), put: leg("NSE:NIFTY26OCT22350PE") },
    ],
  };
}

describe("applyChainTick", () => {
  it("passes a missing chain straight through", () => {
    expect(applyChainTick(null, { symbol: "NSE:NIFTY26OCT22350CE", ask: 120 })).toBeNull();
  });

  it("takes the new quote on the leg that ticked and leaves every other leg alone", () => {
    const before = chain();
    const after = applyChainTick(before, { symbol: "NSE:NIFTY26OCT22350CE", bid: 119, ask: 121, ltp: 120 })!;
    const ticked = after.strikes![1]!.call!;
    expect(ticked.bid).toBe(119);
    expect(ticked.ask).toBe(121);
    expect(ticked.lastPrice).toBe(120);
    // Untouched legs are the same objects, not copies re-solved against a quote that did not move.
    expect(after.strikes![1]!.put).toBe(before.strikes![1]!.put);
    expect(after.strikes![0]!.call).toBe(before.strikes![0]!.call);
  });

  it("does not mutate the chain it was given", () => {
    const before = chain();
    const snapshot = JSON.stringify(before);
    applyChainTick(before, { symbol: "NSE:NIFTY26OCT22350CE", bid: 119, ask: 121 });
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("returns the same chain when the tick matches nothing in it", () => {
    const before = chain();
    expect(applyChainTick(before, { symbol: "NSE:BANKNIFTY26OCTFUT", ask: 5 })).toBe(before);
  });

  it("moves the spot on an index tick and re-solves every leg against it", () => {
    const before = chain();
    const after = applyChainTick(before, { symbol: "NSE:NIFTY50-INDEX", ltp: 22400 })!;
    expect(after.underlyingValue).toBe(22400);
    expect(after.strikes![0]!.call).not.toBe(before.strikes![0]!.call);
    // The quotes themselves are unchanged: only an option's own tick moves its bid and ask.
    expect(after.strikes![0]!.call!.ask).toBe(101);
  });

  it("moves the spot on a Bank Nifty index tick", () => {
    const before = chain();
    const after = applyChainTick(before, { symbol: "NSE:NIFTYBANK-INDEX", ltp: 55700 })!;
    expect(after.underlyingValue).toBe(55700);
  });

  it("moves the spot on an equity underlying tick", () => {
    const before = chain();
    const after = applyChainTick(before, { symbol: "NSE:SBIN-EQ", ltp: 820 })!;
    expect(after.underlyingValue).toBe(820);
  });

  it("keeps the previous quote for a field the tick does not carry", () => {
    const after = applyChainTick(chain(), { symbol: "NSE:NIFTY26OCT22350CE", ask: 130 })!;
    const ticked = after.strikes![1]!.call!;
    expect(ticked.ask).toBe(130);
    expect(ticked.bid).toBe(99);
  });
});

describe("applyChainTick: the forward a live premium is solved against", () => {
  const SNAPSHOT_SPOT = 22_350;
  const SNAPSHOT_FORWARD = 22_360;
  const YEARS = 7 / 365;
  const TICKED = "NSE:NIFTY26OCT22350CE";

  function chainWithForward(): ChainResponse {
    return { ...chain(), underlyingValue: SNAPSHOT_SPOT, impliedForwardByExpiry: { "2026-10-27": SNAPSHOT_FORWARD } };
  }

  /** The independent solve a correct implementation must agree with. */
  function ivAtForward(forward: number, premium: number): number {
    const result = impliedVolatilityFromPremium({
      spot: effectiveSpotForForward(forward, RISK_FREE_RATE, YEARS),
      strike: 22_350,
      timeToExpiryYears: YEARS,
      riskFreeRate: RISK_FREE_RATE,
      optionType: "CE",
      premium,
    });
    if (!result.measurable) throw new Error(`fixture is not solvable: ${result.reason}`);
    return result.impliedVolatility;
  }

  const freshQuote = { symbol: TICKED, bid: 189, ask: 191 }; // mid 190

  it("prices a ticking leg at the snapshot forward carried to the live spot", () => {
    const movedSpot = applyChainTick(chainWithForward(), { symbol: "NSE:NIFTY50-INDEX", ltp: 22_380 })!;
    const live = applyChainTick(movedSpot, freshQuote)!.strikes![1]!.call!;

    // 22,360 x (22,380 / 22,350): F/S is steady over minutes, so the forward follows spot.
    expect(live.impliedVolatility).toBeCloseTo(ivAtForward(SNAPSHOT_FORWARD * (22_380 / SNAPSHOT_SPOT), 190), 8);
  });

  it("no longer absorbs the spot move into the implied vol", () => {
    const sameSpot = applyChainTick(chainWithForward(), freshQuote)!.strikes![1]!.call!;
    const movedSpot = applyChainTick(chainWithForward(), { symbol: "NSE:NIFTY50-INDEX", ltp: 22_380 })!;
    const live = applyChainTick(movedSpot, freshQuote)!.strikes![1]!.call!;

    // Same fresh premium, spot 30 points higher: a call is worth more, so the vol that explains the
    // same price must be lower. Against the stale forward it was not (it stayed at the same-spot value).
    expect(live.impliedVolatility!).toBeLessThan(sameSpot.impliedVolatility!);
    // About 15 / 12.4 = 1.2 vol points for a 30-point move on a 7-day ATM option.
    const shift = sameSpot.impliedVolatility! - live.impliedVolatility!;
    expect(shift).toBeGreaterThan(0.008);
    expect(shift).toBeLessThan(0.016);
  });

  it("is unchanged when spot has not moved since the snapshot", () => {
    const live = applyChainTick(chainWithForward(), freshQuote)!.strikes![1]!.call!;
    expect(live.impliedVolatility).toBeCloseTo(ivAtForward(SNAPSHOT_FORWARD, 190), 8);
  });

  it("leaves a leg that did not tick consistent with its own snapshot premium", () => {
    // Its premium is from the snapshot, so it must stay on the snapshot forward however far spot moves.
    const noMove = applyChainTick(chainWithForward(), { symbol: "NSE:NIFTY50-INDEX", ltp: SNAPSHOT_SPOT })!;
    const moved = applyChainTick(chainWithForward(), { symbol: "NSE:NIFTY50-INDEX", ltp: 22_420 })!;
    const idle = (c: ChainResponse) => c.strikes![1]!.put!;
    expect(idle(moved).impliedVolatility).toBe(idle(noMove).impliedVolatility);
    expect(idle(moved).delta).toBe(idle(noMove).delta);
  });

  it("remembers the snapshot spot on the first tick and keeps it as spot keeps moving", () => {
    const first = applyChainTick(chainWithForward(), { symbol: "NSE:NIFTY50-INDEX", ltp: 22_380 })!;
    expect(first.snapshotUnderlyingValue).toBe(SNAPSHOT_SPOT);
    const second = applyChainTick(first, { symbol: "NSE:NIFTY50-INDEX", ltp: 22_410 })!;
    expect(second.underlyingValue).toBe(22_410);
    expect(second.snapshotUnderlyingValue).toBe(SNAPSHOT_SPOT);
    // A response straight from the server carries no such field.
    expect(chainWithForward().snapshotUnderlyingValue).toBeUndefined();
  });

  it("falls back to the live spot when the response carries no forward, as before", () => {
    const withoutForward = { ...chain(), underlyingValue: SNAPSHOT_SPOT };
    const live = applyChainTick(withoutForward, freshQuote)!.strikes![1]!.call!;
    expect(live.impliedVolatility).toBeCloseTo(ivAtForward(SNAPSHOT_SPOT * Math.exp(RISK_FREE_RATE * YEARS), 190), 8);
  });
});

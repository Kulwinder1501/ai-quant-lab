import { describe, expect, it } from "vitest";
import type { GreeksStrikeInput } from "./build-greeks-by-strike";
import type { StrikeRow } from "./live-chain";
import { summariseAgreement } from "./vendor-greeks-check";
import {
  buildHistory,
  driftSentence,
  stateText,
  toGreeksStrikes,
  type SessionAgreement,
} from "./vendor-greeks-history";

/** Synthetic sessions, hand-built (not recorded from the API). One call leg per session, model IV 15.00 points. */
const strikesWith = (vendorIvOffset: number | null): GreeksStrikeInput[] => [{
  strikePrice: 54_300,
  call: {
    impliedVolatility: 0.15, impliedVolatilityRefusal: null, delta: 0.5, gamma: 0.0004, theta: -48, vega: 33,
    vendorGreeks: vendorIvOffset === null ? null : { impliedVolatilityPercent: 15 + vendorIvOffset, delta: 0.502, gamma: 0.0004, theta: -46, vega: 33 },
  },
  put: null,
}];

const session = (sessionDate: string, offset: number | null): SessionAgreement => ({
  sessionDate, observedAt: `${sessionDate}T09:53:00.000Z`, summary: summariseAgreement(strikesWith(offset)), error: null,
});

describe("buildHistory", () => {
  it("makes one row per session in the order given, with the IV and delta agreement of the ones that have a pair", () => {
    const rows = buildHistory([session("2026-10-27", 0.05), session("2026-10-26", null)]);
    expect(rows[0]).toMatchObject({ sessionDate: "2026-10-27", state: "compared", legs: 1, legsWithVendor: 1 });
    expect(rows[0]!.iv!.bias).toBeCloseTo(0.05, 9);
    expect(rows[0]!.delta!.bias).toBeCloseTo(0.002, 12);
  });

  it("shows a session with no provider Greeks as having none, not as agreement", () => {
    const [row] = buildHistory([session("2026-10-26", null)]);
    expect(row).toMatchObject({ state: "no-vendor", legsWithVendor: 0, iv: null, delta: null });
    expect(stateText(row!)).toBe("no Fyers Greeks stored that session");
  });

  it("says when provider Greeks are stored but no contract has both values, and when the chain could not be read", () => {
    const unsolved: SessionAgreement = {
      sessionDate: "2026-10-26", observedAt: "2026-10-26T09:53:00.000Z", error: null,
      summary: summariseAgreement([{ strikePrice: 54_300, call: { impliedVolatility: null, impliedVolatilityRefusal: "BELOW_INTRINSIC", delta: null, gamma: null, theta: null, vega: null, vendorGreeks: { impliedVolatilityPercent: 15, delta: 0.5, gamma: 0.0004, theta: -46, vega: 33 } }, put: null }]),
    };
    expect(buildHistory([unsolved])[0]).toMatchObject({ state: "no-pairs", legsWithVendor: 1 });
    const failed: SessionAgreement = { sessionDate: "2026-10-25", observedAt: "2026-10-25T09:53:00.000Z", summary: null, error: "HTTP 500" };
    const [row] = buildHistory([failed]);
    expect(row).toMatchObject({ state: "unavailable", legs: 0 });
    expect(stateText(row!)).toBe("chain could not be read");
  });
});

describe("driftSentence", () => {
  const rows = (offsets: Array<number | null>) => buildHistory(offsets.map((offset, index) => session(`2026-10-${String(30 - index).padStart(2, "0")}`, offset)));

  it("flags a newest IV bias outside the range of the earlier sessions, and says it is not a test", () => {
    // Newest +0.30 against earlier +0.05, +0.06, +0.04: the earlier range is +0.04 to +0.06.
    const sentence = driftSentence(rows([0.3, 0.05, 0.06, 0.04]));
    expect(sentence).toBe("The newest session's IV bias (+0.30 volatility points) is outside the range of the 3 earlier sessions (+0.04 to +0.06). This flags a change, it does not test one: 4 sessions are not a distribution.");
  });

  it("calls a newest bias inside the earlier range inside, below as well as above", () => {
    expect(driftSentence(rows([0.05, 0.05, 0.06, 0.04]))).toContain("is inside the range of the 3 earlier sessions");
    expect(driftSentence(rows([0.01, 0.05, 0.06, 0.04]))).toContain("is outside the range");
  });

  it("does not use sessions without an IV comparison, and needs four with one", () => {
    expect(driftSentence(rows([0.3, null, 0.06, 0.04]))).toBe("3 of the 4 sessions have an IV comparison; at least 4 are needed before it can be said whether the gap moves.");
    expect(driftSentence([])).toBe("0 of the 0 sessions have an IV comparison; at least 4 are needed before it can be said whether the gap moves.");
    // Five sessions, one without: four with a comparison is enough, and the gap session is skipped.
    expect(driftSentence(rows([0.05, null, 0.06, 0.04, 0.05]))).toContain("of the 3 earlier sessions");
  });
});

describe("toGreeksStrikes", () => {
  it("keeps what the comparison reads and the provider's Greeks, and turns an absent provider value into null", () => {
    const leg = (vendor: boolean) => ({
      lastPrice: null, bid: 330, ask: 336, volume: null, openInterest: null, openInterestChange: null, spreadAbsolute: null, spreadPercentOfMid: null,
      withinCostBudget: null, moneyness: null, providerSymbol: "x", impliedVolatility: 0.15, impliedVolatilityRefusal: null, delta: 0.5, gamma: 0.0004, theta: -48, vega: 33,
      daysToExpiry: 4, ...(vendor ? { vendorGreeks: { delta: 0.5, gamma: 0.0004, theta: -46, vega: 33, impliedVolatilityPercent: 15.05 } } : {}),
    });
    const rows: StrikeRow[] = [{ strikePrice: 54_300, isAtm: true, call: leg(true), put: leg(false) }, { strikePrice: 54_600, isAtm: false, call: null, put: null }];
    const mapped = toGreeksStrikes(rows);
    expect(mapped[0]!.call!.vendorGreeks).toEqual({ delta: 0.5, gamma: 0.0004, theta: -46, vega: 33, impliedVolatilityPercent: 15.05 });
    expect(mapped[0]!.put!.vendorGreeks).toBeNull();
    expect(mapped[1]).toEqual({ strikePrice: 54_600, call: null, put: null });
  });
});

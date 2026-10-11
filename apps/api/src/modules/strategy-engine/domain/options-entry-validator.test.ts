import { afterEach, describe, expect, it } from "vitest";
import { validateOptionsEntry } from "./options-entry-validator.js";
import type { ConfluenceSignal } from "./strategy.js";
import type { OptionChainQuote, OptionChainSnapshot } from "../../market-data/domain/option-chain.js";

const EXPIRY = new Date("2026-08-25T10:00:00.000Z");
const OBSERVED = new Date("2026-08-05T06:45:00.000Z");

function quote(overrides: Partial<OptionChainQuote> = {}): OptionChainQuote {
  return {
    expiryDate: EXPIRY,
    expiryKind: "MONTHLY",
    strikePrice: 57_700,
    optionType: "CE",
    providerSymbol: "NSE:BANKNIFTY26AUG57700CE",
    providerToken: null,
    lastPrice: 812,
    bid: 811.45,
    ask: 813.55,
    volume: 1_000,
    openInterest: 5_000,
    previousOpenInterest: 4_800,
    openInterestChange: 200,
    ...overrides,
  };
}

function chain(overrides: Partial<OptionChainSnapshot> = {}): OptionChainSnapshot {
  return {
    underlyingSymbol: "BANKNIFTY",
    provider: "fyers-api-v3",
    observedAt: OBSERVED,
    underlyingValue: 57_684.35,
    quotes: [quote(), quote({ optionType: "PE", bid: 700.1, ask: 702.4 })],
    listedExpiries: [{ expiryDate: EXPIRY, expiryKind: "MONTHLY" }],
    ...overrides,
  };
}

const IDEA = { side: "LONG" as const, confidence: 0.75, reasoning: ["strong volume breakout"] };

describe("validateOptionsEntry", () => {
  it("passes a liquid, near-the-money contract with rising open interest", () => {
    const result = validateOptionsEntry({
      proposedIdea: IDEA,
      candleVolume: 12_000,
      optionChain: chain(),
      intendedStrike: 57_700,
      intendedContractDelta: 0.51,
      hasMacroEvent: false,
      ivPercentile: 50,
    });

    expect(result.isValid).toBe(true);
    expect(result.unchecked).toEqual([]);
  });

  it("refuses when IV percentile is at or above ceiling", () => {
    const result = validateOptionsEntry({
      proposedIdea: IDEA,
      candleVolume: 12_000,
      optionChain: chain(),
      intendedStrike: 57_700,
      intendedContractDelta: 0.51,
      hasMacroEvent: false,
      ivPercentile: 88, // >= 85% default ceiling
    });

    expect(result.isValid).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/IV percentile 88% >= 85% ceiling/);
  });

  it("passes when IV percentile is below custom ceiling", () => {
    const passed = validateOptionsEntry({
      proposedIdea: IDEA,
      candleVolume: 12_000,
      optionChain: chain(),
      intendedStrike: 57_700,
      intendedContractDelta: 0.51,
      hasMacroEvent: false,
      ivPercentile: 65,
      ivPercentileCeiling: 70,
    });
    const failed = validateOptionsEntry({
      proposedIdea: IDEA,
      candleVolume: 12_000,
      optionChain: chain(),
      intendedStrike: 57_700,
      intendedContractDelta: 0.51,
      hasMacroEvent: false,
      ivPercentile: 72,
      ivPercentileCeiling: 70,
    });

    expect(passed.isValid).toBe(true);
    expect(failed.isValid).toBe(false);
  });

  it("allows trade but records unchecked when IV percentile is unavailable", () => {
    const result = validateOptionsEntry({
      proposedIdea: IDEA,
      candleVolume: 12_000,
      optionChain: chain(),
      intendedStrike: 57_700,
      intendedContractDelta: 0.51,
      hasMacroEvent: false,
      ivPercentile: null,
    });

    expect(result.isValid).toBe(true);
    expect(result.unchecked.join(" ")).toMatch(/IV percentile is unavailable/);
  });

  it("refuses a far-OTM contract on delta", () => {
    const result = validateOptionsEntry({
      proposedIdea: IDEA,
      candleVolume: 12_000,
      optionChain: chain(),
      intendedStrike: 57_700,
      intendedContractDelta: 0.21,
      hasMacroEvent: false,
    });

    expect(result.isValid).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/Delta is 0\.21/);
  });

  it("refuses a wide spread, because spread is the dominant cost", () => {
    const result = validateOptionsEntry({
      proposedIdea: IDEA,
      candleVolume: 12_000,
      // ~5% of mid, past the 3% limit.
      optionChain: chain({ quotes: [quote({ bid: 790, ask: 830 })] }),
      intendedStrike: 57_700,
      intendedContractDelta: 0.51,
      hasMacroEvent: false,
    });

    expect(result.isValid).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/Liquidity Alert/);
  });

  // Changed 2026-10: this used to REFUSE on `openInterestChange < 0`. That field is the vendor's
  // open_interest - previous_open_interest (change vs the PREVIOUS DAY, not the last poll); its sign
  // without the price direction says nothing about whether to buy, and it is negative on almost
  // every contract near expiry. It is now informational only.
  it("does not refuse on a day-over-day open-interest decline; it is informational", () => {
    const result = validateOptionsEntry({
      proposedIdea: IDEA,
      candleVolume: 12_000,
      optionChain: chain({ quotes: [quote({ openInterestChange: -1_500 })] }),
      intendedStrike: 57_700,
      intendedContractDelta: 0.51,
      hasMacroEvent: false,
    });

    expect(result.isValid).toBe(true);
    expect(result.reasons.join(" ")).toMatch(/down 1500 versus the previous day's close.*Informational only/);
  });

  describe("OI walls are compared with spot before being labelled", () => {
    // Spot is 57_684.35 in `chain()`.
    const putWall = (strikePrice: number) => quote({ optionType: "PE", strikePrice, openInterest: 90_000 });
    const callWall = (strikePrice: number) => quote({ optionType: "CE", strikePrice, openInterest: 90_000 });

    it("calls a put wall below spot support", () => {
      const result = validateOptionsEntry({
        proposedIdea: IDEA, candleVolume: 12_000, hasMacroEvent: false,
        optionChain: chain({ quotes: [quote(), putWall(57_000)] }),
      });

      expect(result.reasons.join(" ")).toMatch(/Strong Put OI support at strike 57000/);
    });

    it("does not call a put wall ABOVE spot support", () => {
      const result = validateOptionsEntry({
        proposedIdea: IDEA, candleVolume: 12_000, hasMacroEvent: false,
        optionChain: chain({ quotes: [quote(), putWall(58_500)] }),
      });

      expect(result.reasons.join(" ")).not.toMatch(/Strong Put OI support/);
      expect(result.reasons.join(" ")).toMatch(/ABOVE spot.*not support/);
    });

    it("calls a call wall above spot resistance, but not one below spot", () => {
      const short = { ...IDEA, side: "SHORT" as const };
      const above = validateOptionsEntry({
        proposedIdea: short, candleVolume: 12_000, hasMacroEvent: false,
        optionChain: chain({ quotes: [callWall(58_500)] }),
      });
      const below = validateOptionsEntry({
        proposedIdea: short, candleVolume: 12_000, hasMacroEvent: false,
        optionChain: chain({ quotes: [callWall(57_000)] }),
      });

      expect(above.reasons.join(" ")).toMatch(/Strong Call OI resistance at strike 58500/);
      expect(below.reasons.join(" ")).not.toMatch(/Strong Call OI resistance/);
      expect(below.reasons.join(" ")).toMatch(/BELOW spot.*not resistance/);
    });

    it("reports the wall as unchecked when the chain carries no spot", () => {
      const result = validateOptionsEntry({
        proposedIdea: IDEA, candleVolume: 12_000, hasMacroEvent: false,
        optionChain: chain({ underlyingValue: null, quotes: [putWall(57_000)] }),
      });

      expect(result.unchecked.join(" ")).toMatch(/Put OI wall at strike 57000.*no underlying value/);
      expect(result.reasons.join(" ")).not.toMatch(/support/);
    });
  });

  describe("the intended contract is matched on expiry as well as strike and side", () => {
    const NEAR = new Date("2026-08-25T10:00:00.000Z");
    const FAR = new Date("2026-09-29T10:00:00.000Z");
    // Same strike and side on two expiries; only the far one has a wide spread.
    const twoExpiries = chain({
      quotes: [
        quote({ expiryDate: NEAR, bid: 811.45, ask: 813.55 }),
        quote({ expiryDate: FAR, bid: 790, ask: 830 }),
      ],
      listedExpiries: [
        { expiryDate: NEAR, expiryKind: "MONTHLY" },
        { expiryDate: FAR, expiryKind: "MONTHLY" },
      ],
    });
    const base = {
      proposedIdea: IDEA, candleVolume: 12_000, intendedStrike: 57_700,
      intendedContractDelta: 0.51, hasMacroEvent: false, optionChain: twoExpiries,
    };

    it("evaluates the far-expiry contract when that expiry is intended", () => {
      const result = validateOptionsEntry({ ...base, intendedExpiryDate: FAR });

      expect(result.isValid).toBe(false);
      expect(result.reasons.join(" ")).toMatch(/Liquidity Alert/);
    });

    it("evaluates the near-expiry contract when that expiry is intended", () => {
      const result = validateOptionsEntry({ ...base, intendedExpiryDate: NEAR });

      expect(result.reasons.join(" ")).not.toMatch(/Liquidity Alert/);
      expect(result.unchecked.join(" ")).not.toMatch(/Intended expiry/);
    });

    it("assumes the nearest expiry, and says so, when none is supplied", () => {
      const result = validateOptionsEntry(base);

      expect(result.reasons.join(" ")).not.toMatch(/Liquidity Alert/);
      expect(result.unchecked.join(" ")).toMatch(/Intended expiry: not supplied.*2026-08-25/);
    });
  });

  it("refuses a 0-DTE contract unless confidence is high", () => {
    // Days-to-expiry is derived from the contract and the snapshot, not read off a field.
    const expiringChain = chain({ observedAt: new Date("2026-08-25T04:00:00.000Z") });
    const low = validateOptionsEntry({
      proposedIdea: { ...IDEA, confidence: 0.7 },
      candleVolume: 12_000, optionChain: expiringChain,
      intendedStrike: 57_700, intendedContractDelta: 0.51, hasMacroEvent: false,
    });
    const high = validateOptionsEntry({
      proposedIdea: { ...IDEA, confidence: 0.85 },
      candleVolume: 12_000, optionChain: expiringChain,
      intendedStrike: 57_700, intendedContractDelta: 0.51, hasMacroEvent: false,
    });

    expect(low.isValid).toBe(false);
    expect(low.reasons.join(" ")).toMatch(/Time Decay Alert/);
    expect(high.isValid).toBe(true);
  });

  // The guards used to be written `x !== null && x !== undefined` against field names that
  // did not exist. `undefined !== null` is true, so each check reached a comparison that
  // silently failed and the validator returned isValid with nothing evaluated. These assert
  // the absence of an input is *reported*, not passed.
  it("reports an unsolvable delta as unchecked rather than passing it", () => {
    const result = validateOptionsEntry({
      proposedIdea: IDEA,
      candleVolume: 12_000,
      optionChain: chain(),
      intendedStrike: 57_700,
      intendedContractDelta: null,
      hasMacroEvent: false,
    });

    expect(result.isValid).toBe(true);
    expect(result.unchecked.join(" ")).toMatch(/no solved delta was supplied/);
  });

  it("reports a one-sided market as unchecked, not as a zero spread", () => {
    const result = validateOptionsEntry({
      proposedIdea: IDEA,
      candleVolume: 12_000,
      optionChain: chain({ quotes: [quote({ bid: null })] }),
      intendedStrike: 57_700,
      intendedContractDelta: 0.51,
      hasMacroEvent: false,
    });

    expect(result.unchecked.join(" ")).toMatch(/no two-sided quote/);
  });

  it("reports every chain factor as unchecked when no chain is supplied", () => {
    const result = validateOptionsEntry({ proposedIdea: IDEA, candleVolume: 12_000 });

    expect(result.unchecked.join(" ")).toMatch(/no option chain was supplied/);
    expect(result.unchecked.join(" ")).toMatch(/no scheduled-event calendar/);
  });

  it("reports missing volume as unchecked instead of treating it as zero", () => {
    // A zero would have failed the check outright and read as a real low-volume refusal.
    const result = validateOptionsEntry({ proposedIdea: IDEA, optionChain: chain() });

    expect(result.unchecked.join(" ")).toMatch(/no bar volume was supplied/);
  });

  it("carries the caller's reason for absent volume, so 'not reported' is distinguishable", () => {
    // Measured: all 1,069 stored 15m index bars have zero volume, because 15m is Yahoo's
    // under the provenance split and Yahoo carries no index volume. "Not reported by this
    // series" and "nobody looked it up" must not collapse into one line, because only one of
    // them is worth acting on.
    const result = validateOptionsEntry({
      proposedIdea: IDEA,
      optionChain: chain(),
      candleVolume: null,
      volumeAbsenceReason: "BANKNIFTY 15m carries no volume in this dataset",
    });

    expect(result.isValid).toBe(true);
    expect(result.unchecked.join(" ")).toMatch(/BANKNIFTY 15m carries no volume/);
  });

  it("refuses a genuinely zero-volume bar when the series does report volume", () => {
    // Reasoning that does not claim volume support, and a bar with none: nothing corroborates
    // the move.
    const result = validateOptionsEntry({
      proposedIdea: { ...IDEA, reasoning: ["momentum breakout"] },
      optionChain: chain(),
      intendedStrike: 57_700,
      intendedContractDelta: 0.51,
      hasMacroEvent: false,
      candleVolume: 0,
    });

    expect(result.isValid).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/Low-volume moves are weak/);
  });

  it("passes a real volume figure through to the check", () => {
    const result = validateOptionsEntry({
      proposedIdea: { ...IDEA, reasoning: ["momentum breakout"] },
      optionChain: chain(),
      intendedStrike: 57_700,
      intendedContractDelta: 0.51,
      hasMacroEvent: false,
      candleVolume: 148_000,
    });

    expect(result.isValid).toBe(true);
    // Checked, so it must not appear as unevaluated.
    expect(result.unchecked.join(" ")).not.toMatch(/Volume confirmation/);
  });

  it("refuses low-confidence ideas outright", () => {
    const result = validateOptionsEntry({
      proposedIdea: { ...IDEA, confidence: 0.4 }, candleVolume: 12_000, optionChain: chain(),
    });

    expect(result.isValid).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/confidence is too low/);
  });

  it("blocks only when a macro event is actually asserted", () => {
    const asserted = validateOptionsEntry({
      proposedIdea: IDEA, candleVolume: 12_000, optionChain: chain(),
      intendedStrike: 57_700, intendedContractDelta: 0.51, hasMacroEvent: true,
    });

    expect(asserted.isValid).toBe(false);
    expect(asserted.reasons.join(" ")).toMatch(/Macro Event Filter/);
  });

  describe("ORDERBOOK-01 directional gate kill switch", () => {
    // gate_action recommends SHORT; IDEA is LONG, so evaluateOrderbookDirectionalGate returns BLOCK.
    const BLOCKING_SIGNAL: ConfluenceSignal = {
      is_level_proximate: true,
      nearest_level_type: "SWING_HIGH",
      nearest_level_price: 57_750,
      distance_bps: 5,
      raw_di: 0.4,
      di_tilde: 0.4,
      directional_bias: "BEARISH_SWEEP",
      gate_action: "BUY_PUT_OR_SHORT",
    };

    const originalFlag = process.env.ORDERBOOK01_LIVE_GATE_ENABLED;
    afterEach(() => {
      if (originalFlag === undefined) {
        delete process.env.ORDERBOOK01_LIVE_GATE_ENABLED;
      } else {
        process.env.ORDERBOOK01_LIVE_GATE_ENABLED = originalFlag;
      }
    });

    // Regression test: this must fail on the pre-kill-switch code (isValid would be false) and
    // pass once the flag defaults the blocking behaviour off. Shadow reasoning still surfaces
    // via `reasons` -- only `isValid` stops flipping.
    it("does not invalidate an entry on a BLOCK verdict when the flag is unset", () => {
      delete process.env.ORDERBOOK01_LIVE_GATE_ENABLED;

      const result = validateOptionsEntry({
        proposedIdea: IDEA,
        candleVolume: 12_000,
        optionChain: chain(),
        intendedStrike: 57_700,
        intendedContractDelta: 0.51,
        hasMacroEvent: false,
        ivPercentile: 50,
        confluenceSignal: BLOCKING_SIGNAL,
      });

      expect(result.isValid).toBe(true);
      expect(result.reasons.join(" ")).toMatch(/ORDERBOOK-01 BLOCK/);
    });

    it("still invalidates an entry on a BLOCK verdict when the flag is explicitly true", () => {
      process.env.ORDERBOOK01_LIVE_GATE_ENABLED = "true";

      const result = validateOptionsEntry({
        proposedIdea: IDEA,
        candleVolume: 12_000,
        optionChain: chain(),
        intendedStrike: 57_700,
        intendedContractDelta: 0.51,
        hasMacroEvent: false,
        ivPercentile: 50,
        confluenceSignal: BLOCKING_SIGNAL,
      });

      expect(result.isValid).toBe(false);
      expect(result.reasons.join(" ")).toMatch(/ORDERBOOK-01 BLOCK/);
    });
  });
});

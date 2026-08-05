import { describe, expect, it } from "vitest";
import { validateOptionsEntry } from "./options-entry-validator.js";
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
    });

    expect(result.isValid).toBe(true);
    expect(result.unchecked).toEqual([]);
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

  it("refuses when open interest is falling on the intended strike", () => {
    const result = validateOptionsEntry({
      proposedIdea: IDEA,
      candleVolume: 12_000,
      optionChain: chain({ quotes: [quote({ openInterestChange: -1_500 })] }),
      intendedStrike: 57_700,
      intendedContractDelta: 0.51,
      hasMacroEvent: false,
    });

    expect(result.isValid).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/Open interest is decreasing/);
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
});

import { describe, expect, it } from "vitest";
import { chooseManualOptionFill, MAXIMUM_MANUAL_QUOTE_AGE_MS } from "./manual-option-fill.js";

const now = new Date("2026-10-13T06:40:59.000Z");
const secondsAgo = (s: number) => new Date(now.getTime() - s * 1000);

describe("chooseManualOptionFill", () => {
  it("fills at the live tick's ask and carries its underlying", () => {
    const result = chooseManualOptionFill({
      tick: { bid: 557.2, ask: 558, observedAt: secondsAgo(3), underlyingValue: 55060.3 },
      chainQuote: null,
      now,
    });
    expect(result).toEqual({ ok: true, fillPrice: 558, observedAt: secondsAgo(3), source: "OPTION_PREMIUM_TICK_ASK", underlyingValue: 55060.3 });
  });

  it("prefers a fresh tick over a fresh chain quote", () => {
    const result = chooseManualOptionFill({
      tick: { bid: 557, ask: 558, observedAt: secondsAgo(5) },
      chainQuote: { bid: 600, ask: 601, observedAt: secondsAgo(20) },
      now,
    });
    expect(result.ok && result.fillPrice).toBe(558);
  });

  it("refuses the 30-minute-old snapshot that used to be accepted -- the Rs 643 fill on a Rs 558 market", () => {
    const result = chooseManualOptionFill({
      tick: null,
      chainQuote: { bid: 641, ask: 642.85, observedAt: secondsAgo(30 * 60) },
      now,
    });
    expect(result.ok).toBe(false);
  });

  it("ignores a stale tick and uses a fresh chain quote when there is one", () => {
    const result = chooseManualOptionFill({
      tick: { bid: 557, ask: 558, observedAt: secondsAgo(10 * 60) },
      chainQuote: { bid: 590, ask: 591, observedAt: secondsAgo(45) },
      now,
    });
    expect(result).toMatchObject({ ok: true, fillPrice: 591, source: "OPTION_CHAIN_QUOTE", underlyingValue: null });
  });

  it("accepts a quote right at the age limit and refuses one just past it", () => {
    const at = { bid: 100, ask: 101, observedAt: new Date(now.getTime() - MAXIMUM_MANUAL_QUOTE_AGE_MS) };
    const past = { bid: 100, ask: 101, observedAt: new Date(now.getTime() - MAXIMUM_MANUAL_QUOTE_AGE_MS - 1) };
    expect(chooseManualOptionFill({ tick: at, chainQuote: null, now }).ok).toBe(true);
    expect(chooseManualOptionFill({ tick: past, chainQuote: null, now }).ok).toBe(false);
  });

  it("refuses a one-sided or crossed market", () => {
    for (const quote of [
      { bid: null, ask: 101, observedAt: secondsAgo(1) },
      { bid: 100, ask: null, observedAt: secondsAgo(1) },
      { bid: 0, ask: 101, observedAt: secondsAgo(1) },
      { bid: 102, ask: 101, observedAt: secondsAgo(1) },
    ]) {
      expect(chooseManualOptionFill({ tick: quote, chainQuote: null, now }).ok, JSON.stringify(quote)).toBe(false);
    }
  });

  it("tolerates a little clock skew ahead of now but not a quote from the future", () => {
    expect(chooseManualOptionFill({ tick: { bid: 100, ask: 101, observedAt: new Date(now.getTime() + 2000) }, chainQuote: null, now }).ok).toBe(true);
    expect(chooseManualOptionFill({ tick: { bid: 100, ask: 101, observedAt: new Date(now.getTime() + 60_000) }, chainQuote: null, now }).ok).toBe(false);
  });

  it("does not invent an underlying: a tick without a usable one leaves it null", () => {
    const result = chooseManualOptionFill({ tick: { bid: 100, ask: 101, observedAt: secondsAgo(1), underlyingValue: 0 }, chainQuote: null, now });
    expect(result).toMatchObject({ ok: true, underlyingValue: null });
  });
});

import { describe, expect, it } from "vitest";
import { chooseMarkQuote } from "./option-mark-quote.js";

const now = new Date("2026-10-14T06:33:00.000Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

describe("chooseMarkQuote", () => {
  // The reported case: bought at the live ask of 575 at 12:02:42 IST, marked at the 11:53 snapshot's mid (556.63).
  it("refuses a nine-minute-old chain snapshot, so a fresh buy does not open under water", () => {
    const quote = chooseMarkQuote({
      chain: { bid: 556.05, ask: 557.2, observedAt: ago(9 * 60 * 1000), impliedForward: 55_500 },
      now,
    });
    expect(quote).toBeNull();
  });

  it("uses the live stream book when it is fresh, and takes its mid", () => {
    const quote = chooseMarkQuote({
      stream: { bid: 573.65, ask: 575.95, observedAt: ago(3_000) },
      tick: { bid: 560, ask: 562, observedAt: ago(60_000) },
      chain: { bid: 540, ask: 542, observedAt: ago(30_000) },
      now,
    });
    expect(quote!.mid).toBeCloseTo(574.8, 6);
    expect(quote!.bid).toBe(573.65);
  });

  it("falls to the stored tick when the stream has gone quiet", () => {
    const quote = chooseMarkQuote({
      stream: { bid: 573.65, ask: 575.95, observedAt: ago(30_000) },
      tick: { bid: 560, ask: 562, observedAt: ago(60_000) },
      now,
    });
    expect(quote!.mid).toBe(561);
  });

  it("accepts a chain quote only when it is as fresh as a tick, and keeps its forward", () => {
    const quote = chooseMarkQuote({
      chain: { bid: 540, ask: 542, observedAt: ago(90_000), impliedForward: 55_500 },
      now,
    });
    expect(quote!.mid).toBe(541);
    expect(quote!.impliedForward).toBe(55_500);
  });

  it("does not use a one-sided or crossed book", () => {
    expect(chooseMarkQuote({ tick: { bid: null, ask: 575, observedAt: ago(1_000) }, now })).toBeNull();
    expect(chooseMarkQuote({ tick: { bid: 0, ask: 575, observedAt: ago(1_000) }, now })).toBeNull();
    expect(chooseMarkQuote({ tick: { bid: 580, ask: 575, observedAt: ago(1_000) }, now })).toBeNull();
  });

  it("tolerates a few seconds of clock skew but not a quote from the future", () => {
    expect(chooseMarkQuote({ tick: { bid: 560, ask: 562, observedAt: new Date(now.getTime() + 3_000) }, now })).not.toBeNull();
    expect(chooseMarkQuote({ tick: { bid: 560, ask: 562, observedAt: new Date(now.getTime() + 60_000) }, now })).toBeNull();
  });

  it("returns null when there is nothing fresh at all", () => {
    expect(chooseMarkQuote({ now })).toBeNull();
  });
});

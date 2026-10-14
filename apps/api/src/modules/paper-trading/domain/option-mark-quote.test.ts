import { describe, expect, it } from "vitest";
import { chooseMarkQuote } from "./option-mark-quote.js";

const now = new Date("2026-10-14T06:33:00.000Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

describe("chooseMarkQuote", () => {
  // The reported case: bought at the live ask of 575 at 12:02:42 IST, marked at the 11:53 snapshot's mid (556.63).
  // The chooser hands the old quote over with the index level it was taken at; the valuation decides whether the
  // index is still there (see paper-trade-live-valuation.test.ts) -- it is not a fresh quote.
  it("hands over a nine-minute-old chain snapshot with its index level, for the valuation to judge", () => {
    const quote = chooseMarkQuote({
      chain: { bid: 556.05, ask: 557.2, observedAt: ago(9 * 60 * 1000), impliedForward: 55_500, underlyingValue: 55_426.45 },
      now,
    });
    expect(quote!.observedAt).toEqual(ago(9 * 60 * 1000));
    expect(quote!.underlyingValue).toBe(55_426.45);
  });

  it("prefers a fresh quote over a newer-looking old one, and the newest old one when none is fresh", () => {
    const fresh = chooseMarkQuote({
      tick: { bid: 560, ask: 562, observedAt: ago(60_000) },
      chain: { bid: 540, ask: 542, observedAt: ago(10 * 60_000) },
      now,
    });
    expect(fresh!.mid).toBe(561);

    const old = chooseMarkQuote({
      tick: { bid: 650, ask: 652, observedAt: ago(30 * 60_000) },
      chain: { bid: 646, ask: 648, observedAt: ago(20 * 60_000) },
      now,
    });
    expect(old!.mid).toBe(647);
  });

  // The reported close: last tick 652.35 / 654.20 at 15:30:04, then a 15:53 snapshot of 641.6 / 653.0 -- a book
  // nobody was trading. The newer snapshot marked the position Rs 360 lower than where it last traded.
  it("does not let a newer, much wider post-close snapshot replace the last tight quote", () => {
    const quote = chooseMarkQuote({
      tick: { bid: 652.35, ask: 654.2, observedAt: ago(45 * 60_000), underlyingValue: 55_316 },
      chain: { bid: 641.6, ask: 653, observedAt: ago(22 * 60_000), underlyingValue: 55_316 },
      now,
    });
    expect(quote!.mid).toBeCloseTo(653.275, 6);
  });

  it("gives up on a quote older than the anchoring window", () => {
    expect(chooseMarkQuote({
      tick: { bid: 650, ask: 652, observedAt: ago(21 * 60 * 60 * 1000), underlyingValue: 55_316 },
      now,
    })).toBeNull();
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

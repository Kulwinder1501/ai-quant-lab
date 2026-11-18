import { describe, expect, it } from "vitest";
import { chooseManualOptionFill, MAXIMUM_MANUAL_QUOTE_AGE_MS, resolveManualUnderlyingEntry } from "./manual-option-fill.js";

const now = new Date("2026-10-13T06:40:59.000Z");
const secondsAgo = (s: number) => new Date(now.getTime() - s * 1000);

describe("chooseManualOptionFill: the live stream", () => {
  it("fills at the live stream's ask, which is what the ticket shows, ahead of a stored tick", () => {
    const result = chooseManualOptionFill({
      stream: { bid: 644.5, ask: 646, observedAt: secondsAgo(1), underlyingValue: 55125.4 },
      tick: { bid: 636, ask: 637.1, observedAt: secondsAgo(30) },
      chainQuote: null,
      now,
    });
    expect(result).toEqual({ ok: true, fillPrice: 646, observedAt: secondsAgo(1), source: "LIVE_STREAM_ASK", underlyingValue: 55125.4 });
  });

  it("serves a contract that has no stored ticks at all -- an out-of-the-money strike the collector does not subscribe", () => {
    const result = chooseManualOptionFill({ stream: { bid: 644.5, ask: 646, observedAt: secondsAgo(2) }, tick: null, chainQuote: null, now });
    expect(result).toMatchObject({ ok: true, fillPrice: 646, source: "LIVE_STREAM_ASK" });
  });

  it("holds the stream to 10 seconds, then falls back to a stored tick that is still fresh", () => {
    const stale = { bid: 644.5, ask: 646, observedAt: secondsAgo(11) };
    const tick = { bid: 640, ask: 641, observedAt: secondsAgo(40) };
    expect(chooseManualOptionFill({ stream: stale, tick, chainQuote: null, now })).toMatchObject({ fillPrice: 641, source: "OPTION_PREMIUM_TICK_ASK" });
    expect(chooseManualOptionFill({ stream: stale, tick: null, chainQuote: null, now }).ok).toBe(false);
  });

  it("refuses a one-sided stream book rather than trusting it", () => {
    expect(chooseManualOptionFill({ stream: { bid: null, ask: 646, observedAt: secondsAgo(1) }, tick: null, chainQuote: null, now }).ok).toBe(false);
  });
});

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

describe("resolveManualUnderlyingEntry: where the underlying was at the fill", () => {
  const snapshotAt = (secondsOld: number, underlyingValue: number | null = 62239.1) => ({ underlyingValue, observedAt: secondsAgo(secondsOld) });

  it("never records a 14-minute-old chain snapshot as the entry spot -- the 2026-11-18 BANKNIFTY put (62,239.1 stored, index near 62,100)", () => {
    // the fill quote carried no spot, the stream had a live index price, the snapshot was 14 minutes old
    const result = resolveManualUnderlyingEntry({ fillUnderlying: null, liveSpot: 62100.8, snapshot: snapshotAt(14 * 60), now });
    expect(result).toEqual({ price: 62100.8, fillSource: null });
  });

  it("returns nothing, rather than the stale snapshot, when only an old snapshot exists (the caller then asks for a live quote)", () => {
    expect(resolveManualUnderlyingEntry({ fillUnderlying: null, liveSpot: null, snapshot: snapshotAt(14 * 60), now })).toBeNull();
    expect(resolveManualUnderlyingEntry({ fillUnderlying: undefined, liveSpot: undefined, snapshot: null, now })).toBeNull();
  });

  it("prefers the spot the winning fill quote carried, tagged as the tick's", () => {
    const result = resolveManualUnderlyingEntry({ fillUnderlying: 55125.4, liveSpot: 55130, snapshot: snapshotAt(5), now });
    expect(result).toEqual({ price: 55125.4, fillSource: "OPTION_PREMIUM_TICK_ASK" });
  });

  it("accepts a snapshot only while it is as fresh as a stored tick may be, and tags it as the chain's", () => {
    const atLimit = { underlyingValue: 62100, observedAt: new Date(now.getTime() - MAXIMUM_MANUAL_QUOTE_AGE_MS) };
    const pastLimit = { underlyingValue: 62100, observedAt: new Date(now.getTime() - MAXIMUM_MANUAL_QUOTE_AGE_MS - 1) };
    expect(resolveManualUnderlyingEntry({ fillUnderlying: null, liveSpot: null, snapshot: atLimit, now })).toEqual({ price: 62100, fillSource: "OPTION_CHAIN_QUOTE" });
    expect(resolveManualUnderlyingEntry({ fillUnderlying: null, liveSpot: null, snapshot: pastLimit, now })).toBeNull();
  });

  it("does not invent a spot: zero, negative or non-finite values are skipped, and a snapshot without a value gives nothing", () => {
    expect(resolveManualUnderlyingEntry({ fillUnderlying: 0, liveSpot: Number.NaN, snapshot: snapshotAt(5, null), now })).toBeNull();
    expect(resolveManualUnderlyingEntry({ fillUnderlying: -1, liveSpot: 62100, snapshot: null, now })).toEqual({ price: 62100, fillSource: null });
  });

  it("tolerates a snapshot stamped a little ahead of the clock but not one from the future", () => {
    expect(resolveManualUnderlyingEntry({ fillUnderlying: null, liveSpot: null, snapshot: { underlyingValue: 62100, observedAt: new Date(now.getTime() + 2000) }, now })).not.toBeNull();
    expect(resolveManualUnderlyingEntry({ fillUnderlying: null, liveSpot: null, snapshot: { underlyingValue: 62100, observedAt: new Date(now.getTime() + 60_000) }, now })).toBeNull();
  });
});

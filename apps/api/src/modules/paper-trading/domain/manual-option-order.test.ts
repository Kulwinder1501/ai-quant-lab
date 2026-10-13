import { describe, expect, it } from "vitest";
import {
  checkLimitAgainstAsk,
  decidePendingOrder,
  parseOrderValidity,
  readPendingOrderMeta,
  resolveOrderValidUntil,
} from "./manual-option-order.js";

// 2026-10-13 12:10:59 IST
const placedAt = new Date("2026-10-13T06:40:59.000Z");
const closeInstant = new Date("2026-10-13T10:00:00.000Z"); // 15:30 IST

describe("resolveOrderValidUntil", () => {
  it("lapses the requested number of minutes after placement", () => {
    expect(resolveOrderValidUntil(placedAt, 30).toISOString()).toBe("2026-10-13T07:10:59.000Z");
  });

  it("never outlives the 15:30 IST close of the day it was placed", () => {
    expect(resolveOrderValidUntil(placedAt, null)).toEqual(closeInstant);
    // 15:00 IST + 120 minutes would run past the close.
    expect(resolveOrderValidUntil(new Date("2026-10-13T09:30:00.000Z"), 120)).toEqual(closeInstant);
  });

  it("uses the IST day, not the UTC day, for an order placed just after IST midnight", () => {
    // 00:30 IST on the 14th is 19:00 UTC on the 13th.
    expect(resolveOrderValidUntil(new Date("2026-10-13T19:00:00.000Z"), null).toISOString()).toBe("2026-10-14T10:00:00.000Z");
  });
});

describe("parseOrderValidity", () => {
  it("accepts the offered choices and treats an absent value as the rest of the day", () => {
    expect(parseOrderValidity(30)).toEqual({ ok: true, minutes: 30 });
    expect(parseOrderValidity("60")).toEqual({ ok: true, minutes: 60 });
    expect(parseOrderValidity(undefined)).toEqual({ ok: true, minutes: null });
    expect(parseOrderValidity("EOD")).toEqual({ ok: true, minutes: null });
  });

  it("refuses anything else rather than guessing", () => {
    expect(parseOrderValidity(45).ok).toBe(false);
    expect(parseOrderValidity("soon").ok).toBe(false);
  });
});

describe("checkLimitAgainstAsk", () => {
  it("accepts a limit below the ask", () => {
    expect(checkLimitAgainstAsk(540, 561.8)).toBeNull();
  });

  it("refuses a limit at or above the ask: that is a market order", () => {
    expect(checkLimitAgainstAsk(561.8, 561.8)).toMatch(/Market/);
    expect(checkLimitAgainstAsk(600, 561.8)).toMatch(/Market/);
  });

  it("refuses a missing or non-positive limit", () => {
    expect(checkLimitAgainstAsk(0, 561.8)).not.toBeNull();
    expect(checkLimitAgainstAsk(Number.NaN, 561.8)).not.toBeNull();
  });
});

describe("decidePendingOrder", () => {
  const now = new Date("2026-10-13T06:50:00.000Z");
  const validUntil = closeInstant;
  const quote = (ask: number, ageSeconds = 2) => ({
    bid: ask - 1.5, ask, observedAt: new Date(now.getTime() - ageSeconds * 1000), underlyingValue: 55050,
  });

  it("waits while the ask is still above the limit", () => {
    expect(decidePendingOrder({ limitPrice: 540, validUntil, quote: quote(561.8), now })).toEqual({ action: "WAIT" });
  });

  it("fills at the ask once it has come down to the limit", () => {
    expect(decidePendingOrder({ limitPrice: 540, validUntil, quote: quote(540), now })).toMatchObject({ action: "FILL", fillPrice: 540, underlyingValue: 55050 });
  });

  it("fills at the better price when the market gaps through the limit, never above it", () => {
    expect(decidePendingOrder({ limitPrice: 540, validUntil, quote: quote(520), now })).toMatchObject({ action: "FILL", fillPrice: 520 });
  });

  it("does not fill on a stale quote, even one below the limit", () => {
    expect(decidePendingOrder({ limitPrice: 540, validUntil, quote: quote(500, 10 * 60), now })).toEqual({ action: "WAIT" });
    expect(decidePendingOrder({ limitPrice: 540, validUntil, quote: null, now })).toEqual({ action: "WAIT" });
  });

  it("does not fill on a one-sided quote", () => {
    expect(decidePendingOrder({ limitPrice: 540, validUntil, quote: { bid: null, ask: 530, observedAt: now }, now })).toEqual({ action: "WAIT" });
  });

  it("expires an order past its time, and gives it no last fill", () => {
    const late = new Date(validUntil.getTime() + 1000);
    const lateQuote = { bid: 500, ask: 501, observedAt: late };
    expect(decidePendingOrder({ limitPrice: 540, validUntil, quote: lateQuote, now: late })).toEqual({ action: "EXPIRE", reason: "ORDER_EXPIRED" });
  });
});

describe("readPendingOrderMeta", () => {
  it("reads a stored limit order back", () => {
    const meta = { type: "LIMIT", limitPrice: 540, placedAt: "2026-10-13T06:40:59.000Z", placedAsk: 561.8, validUntil: "2026-10-13T10:00:00.000Z" };
    expect(readPendingOrderMeta({ order: meta })).toEqual(meta);
  });

  it("returns null for a trade that is not a stored limit order", () => {
    expect(readPendingOrderMeta({})).toBeNull();
    expect(readPendingOrderMeta(undefined)).toBeNull();
    expect(readPendingOrderMeta({ order: { type: "LIMIT" } })).toBeNull();
  });
});

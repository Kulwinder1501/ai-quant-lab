import { describe, expect, it } from "vitest";
import { resolveShadowSignal } from "./ict-shadow-resolution.js";
import type { CompletedPriceCandle } from "../../paper-trading/domain/paper-trade-exit-policy.js";

const MINUTE = 60_000;
// 2026-10-13: IST is UTC+05:30, so 10:00 IST = 04:30Z and 15:15 IST = 09:45Z.
const at = (utc: string) => new Date(`2026-10-13T${utc}:00.000Z`);
const SIGNAL_CLOSE = at("04:30");

function bar(open: Date, price: number, overrides: Partial<CompletedPriceCandle> = {}): CompletedPriceCandle {
  return {
    id: `b-${open.getTime()}`, openTime: open, closeTime: new Date(open.getTime() + MINUTE),
    open: price, high: price, low: price, close: price, ...overrides,
  };
}

/** Flat 1m bars from `from` up to (not including) `to`. */
function flat(from: Date, to: Date, price: number): CompletedPriceCandle[] {
  const bars: CompletedPriceCandle[] = [];
  for (let t = from.getTime(); t < to.getTime(); t += MINUTE) bars.push(bar(new Date(t), price));
  return bars;
}

const LONG = { side: "LONG" as const, entryPrice: 100, stopLoss: 98, targetPrice: 104, barCloseTime: SIGNAL_CLOSE };
const SHORT = { side: "SHORT" as const, entryPrice: 100, stopLoss: 102, targetPrice: 96, barCloseTime: SIGNAL_CLOSE };

describe("resolveShadowSignal", () => {
  it("resolves a target, in R, and reports how many minutes it took", () => {
    const bars = [...flat(at("04:30"), at("04:40"), 100), bar(at("04:40"), 103, { high: 104.5 })];
    const result = resolveShadowSignal({ ...LONG, bars, now: at("05:00") });
    expect(result).toMatchObject({ status: "RESOLVED", outcome: "TARGET", rMultiple: 2 });
    if (result.status === "RESOLVED") expect(result.minutesToResolution).toBe(11);
  });

  it("books a stop when one bar spans both levels", () => {
    const bars = [bar(at("04:30"), 100, { high: 105, low: 97 })];
    expect(resolveShadowSignal({ ...LONG, bars, now: at("05:00") })).toMatchObject({ outcome: "STOP", rMultiple: -1 });
  });

  it("stays OPEN while the session is running and nothing has been touched", () => {
    const bars = flat(at("04:30"), at("04:45"), 100.5);
    expect(resolveShadowSignal({ ...LONG, bars, now: at("04:45") })).toEqual({ status: "OPEN" });
  });

  it("closes at the 15:15 bar's close when neither level was reached", () => {
    const bars = flat(at("04:30"), at("09:45"), 101);
    const result = resolveShadowSignal({ ...LONG, bars, now: at("09:50") });
    expect(result).toMatchObject({ status: "RESOLVED", outcome: "SESSION_END", rMultiple: 0.5 });
  });

  it("signs a short's session-end return the other way", () => {
    const bars = flat(at("04:30"), at("09:45"), 101);
    expect(resolveShadowSignal({ ...SHORT, bars, now: at("09:50") })).toMatchObject({ outcome: "SESSION_END", rMultiple: -0.5 });
  });

  it("does not settle at session end before the last bar has arrived", () => {
    const bars = flat(at("04:30"), at("09:30"), 101);
    expect(resolveShadowSignal({ ...LONG, bars, now: at("09:50") })).toEqual({ status: "DEFERRED_GAP" });
  });

  it("defers a hole inside the session, then gives up after the grace period", () => {
    const bars = [...flat(at("04:30"), at("04:35"), 100.5), ...flat(at("04:40"), at("09:45"), 100.5)];
    expect(resolveShadowSignal({ ...LONG, bars, now: at("10:00") })).toEqual({ status: "DEFERRED_GAP" });
    const later = new Date(at("10:00").getTime() + 3 * 24 * 60 * MINUTE);
    expect(resolveShadowSignal({ ...LONG, bars, now: later })).toMatchObject({ status: "UNMEASURABLE" });
  });

  it("keeps a level touched before the hole as final", () => {
    const bars = [bar(at("04:30"), 100, { low: 97 }), ...flat(at("04:40"), at("09:45"), 100.5)];
    expect(resolveShadowSignal({ ...LONG, bars, now: at("10:00") })).toMatchObject({ outcome: "STOP" });
  });

  it("refuses a signal that closed at or after the square-off", () => {
    expect(resolveShadowSignal({ ...LONG, barCloseTime: at("09:45"), bars: [], now: at("10:00") }))
      .toMatchObject({ status: "UNMEASURABLE", reason: "SIGNAL_AT_OR_AFTER_SQUARE_OFF" });
  });

  it("ignores bars before the signal and from the next session", () => {
    const bars = [
      bar(at("04:00"), 100, { low: 90 }), // before the signal: a stop here must not count
      ...flat(at("04:30"), at("09:45"), 101),
      bar(new Date("2026-10-14T04:00:00.000Z"), 100, { low: 90 }), // next day
    ];
    expect(resolveShadowSignal({ ...LONG, bars, now: new Date("2026-10-14T05:00:00.000Z") }))
      .toMatchObject({ outcome: "SESSION_END", rMultiple: 0.5 });
  });
});

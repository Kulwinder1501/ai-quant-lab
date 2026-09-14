import { describe, expect, it } from "vitest";
import {
  excursionSeriesMismatchFactor,
  measureExcursions,
  type ExcursionCandle,
} from "./excursions.js";

/**
 * `measureExcursions` had no direct tests, which is part of why the mismatch below survived: it is
 * shared by the closed-trade review and the candidate settlement, so it looked well-exercised while
 * only ever being reached through two callers that each asserted their own outputs.
 */

function series(...pairs: Array<[number, number]>): ExcursionCandle[] {
  return pairs.map(([low, high]) => ({ low, high }));
}

const LONG = { side: "LONG" as const, entryPrice: 100, riskPerUnit: 10 };

describe("measuring excursions", () => {
  it("measures both sides of a LONG from the series extremes", () => {
    const result = measureExcursions({ ...LONG, candles: series([94, 118]) });

    expect(result.status).toBe("MEASURED");
    if (result.status !== "MEASURED") throw new Error("unreachable");
    expect(result.excursions.maximumAdverse).toBe(6);
    expect(result.excursions.maximumFavourable).toBe(18);
    expect(result.excursions.maximumAdverseR).toBe(0.6);
    expect(result.excursions.maximumFavourableR).toBe(1.8);
  });

  it("measures a SHORT from the other side", () => {
    const result = measureExcursions({
      side: "SHORT", entryPrice: 100, riskPerUnit: 10, candles: series([82, 105]),
    });

    if (result.status !== "MEASURED") throw new Error("unreachable");
    expect(result.excursions.maximumAdverseR).toBe(0.5);
    expect(result.excursions.maximumFavourableR).toBe(1.8);
  });

  it("clamps at zero rather than reporting a favourable move with the wrong sign", () => {
    // A LONG that never traded below its entry has no adverse excursion.
    const result = measureExcursions({ ...LONG, candles: series([101, 118]) });

    if (result.status !== "MEASURED") throw new Error("unreachable");
    expect(result.excursions.maximumAdverse).toBe(0);
  });

  it("reports NO_SERIES for an empty window rather than zeroes", () => {
    expect(measureExcursions({ ...LONG, candles: [] }).status).toBe("NO_SERIES");
  });
});

describe("the series-instrument mismatch sentinel", () => {
  it("reproduces the real defect: index levels measured against an option entry", () => {
    /*
     * Trade 31ccadb5, 2026-09-01. `paper_trades.instrument_id` points at NIFTY50 while `entry_price`
     * and `stop_loss` are option premiums, so the review measured an index high of 23,980.55 against
     * an entry of 108.75 over a risk of 8.05 and reported 2,974.79R favourable with **zero** adverse.
     *
     * Zero adverse on all 339 stored reviews was the dangerous half: "this position never moved
     * against us" is what makes a bad stop look safe.
     */
    const result = measureExcursions({
      side: "LONG",
      entryPrice: 108.75,
      riskPerUnit: 8.05,
      candles: series([23_980.55, 23_980.55]),
    });

    expect(result.status).toBe("SERIES_INSTRUMENT_MISMATCH");
    if (result.status !== "SERIES_INSTRUMENT_MISMATCH") throw new Error("unreachable");
    expect(result.detail).toMatch(/entirely above an entry of 108.75/);
  });

  it("catches a series entirely below the entry too", () => {
    const result = measureExcursions({ ...LONG, candles: series([1, 2]) });

    expect(result.status).toBe("SERIES_INSTRUMENT_MISMATCH");
  });

  it("does not fire on a legitimately large option move", () => {
    /*
     * The false-positive that would matter. An option can multiply several times over, and the series
     * still contains the entry because the window starts at the entry instant -- so a real series is
     * never *entirely* off the entry, whatever its range.
     */
    const result = measureExcursions({ ...LONG, candles: series([95, 400]) });

    expect(result.status).toBe("MEASURED");
  });

  it("tolerates a first bar that misses the entry, up to the factor", () => {
    // Just inside: lowest is 5x the entry exactly, which is not "more than" the factor.
    const inside = measureExcursions({ ...LONG, candles: series([500, 600]) });
    const outside = measureExcursions({ ...LONG, candles: series([501, 600]) });

    expect(excursionSeriesMismatchFactor).toBe(5);
    expect(inside.status).toBe("MEASURED");
    expect(outside.status).toBe("SERIES_INSTRUMENT_MISMATCH");
  });

  it("honours an overridden factor", () => {
    const result = measureExcursions({ ...LONG, candles: series([150, 200]), mismatchFactor: 1.2 });

    expect(result.status).toBe("SERIES_INSTRUMENT_MISMATCH");
  });
});

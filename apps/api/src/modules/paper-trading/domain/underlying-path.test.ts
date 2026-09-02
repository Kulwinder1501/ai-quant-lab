import { describe, expect, it } from "vitest";
import { resolveUnderlyingPath, type UnderlyingPathBar } from "./underlying-path.js";

const MINUTE = 60_000;
const start = new Date("2026-09-02T04:00:00.000Z");

function bar(offset: number, low: number, high: number): UnderlyingPathBar {
  return { openTime: new Date(start.getTime() + offset * MINUTE), low, high };
}

/** A SHORT thesis: entry 23,850, target 23,790 below it, stop 23,880 above. */
const SHORT_THESIS = {
  direction: "SHORT" as const,
  entryReference: 23_850,
  stop: 23_880,
  target: 23_790,
};

/** A LONG thesis: entry 57,000, target 57,120 above, stop 56,940 below. */
const LONG_THESIS = {
  direction: "LONG" as const,
  entryReference: 57_000,
  stop: 56_940,
  target: 57_120,
};

describe("resolving the underlying's path", () => {
  it("reports the target touched, which is what makes INSTRUMENT reachable", () => {
    /*
     * The case endpoint resolution could not see. Measured across 22 real trades, none ever finished
     * at its thesis target -- so TARGET_REACHED never occurred and `attributeShortfall` could never
     * return INSTRUMENT, the verdict meaning "the thesis was right and the expression was wrong".
     *
     * Here the underlying reaches target on the third bar and gives it back, finishing between the
     * barriers. The endpoint says UNRESOLVED; the path says the thesis was right.
     */
    const path = resolveUnderlyingPath({
      thesis: SHORT_THESIS,
      bars: [bar(0, 23_840, 23_855), bar(1, 23_820, 23_845), bar(2, 23_788, 23_825), bar(3, 23_840, 23_860)],
      timeframe: "1m",
    })!;

    expect(path.firstTouch).toBe("TARGET");
    expect(path.favourableExcursion).toBe(62);
    expect(path.excursionTimeframe).toBe("1m");
    expect(path.barsRead).toBe(4);
  });

  it("reports the stop touched when the underlying went the other way", () => {
    const path = resolveUnderlyingPath({
      thesis: SHORT_THESIS,
      bars: [bar(0, 23_845, 23_860), bar(1, 23_860, 23_885)],
      timeframe: "1m",
    })!;

    expect(path.firstTouch).toBe("STOP");
    expect(path.adverseExcursion).toBe(35);
  });

  it("decides by bar order, not by which excursion was larger", () => {
    /*
     * Both barriers are exceeded over this hold, and the adverse excursion is the bigger of the two.
     * Order is what matters: a thesis that reached its target before its stop was right first,
     * whatever happened afterwards. Using the larger excursion would invert this.
     */
    const path = resolveUnderlyingPath({
      thesis: SHORT_THESIS,
      bars: [bar(0, 23_785, 23_852), bar(1, 23_800, 23_950)],
      timeframe: "1m",
    })!;

    expect(path.firstTouch).toBe("TARGET");
    expect(path.adverseExcursion).toBeGreaterThan(path.favourableExcursion);
  });

  it("gives an ambiguous bar to the stop", () => {
    /*
     * One bar spanning both barriers. The intrabar path is unknowable, so the tie goes to the stop --
     * matching `decidePaperTradeExit`'s CONSERVATIVE_STOP_FIRST convention, and conservative in the
     * direction that matters: crediting the target here would manufacture "the thesis was right" out
     * of a bar that may never have reached it.
     */
    const path = resolveUnderlyingPath({
      thesis: SHORT_THESIS,
      bars: [bar(0, 23_780, 23_890)],
      timeframe: "1m",
    })!;

    expect(path.firstTouch).toBe("STOP");
  });

  it("reports neither when the underlying stayed between the barriers", () => {
    const path = resolveUnderlyingPath({
      thesis: SHORT_THESIS,
      bars: [bar(0, 23_840, 23_860), bar(1, 23_830, 23_855)],
      timeframe: "1m",
    })!;

    expect(path.firstTouch).toBeNull();
    // Still measured: the excursions say how far it got even though nothing resolved.
    expect(path.favourableExcursion).toBe(20);
    expect(path.adverseExcursion).toBe(10);
  });

  it("sorts bars before walking them, so input order cannot decide the verdict", () => {
    // The same bars as the target-first case, supplied newest-first.
    const path = resolveUnderlyingPath({
      thesis: SHORT_THESIS,
      bars: [bar(1, 23_800, 23_950), bar(0, 23_785, 23_852)],
      timeframe: "1m",
    })!;

    expect(path.firstTouch).toBe("TARGET");
  });

  it("resolves a LONG thesis from the other side", () => {
    const path = resolveUnderlyingPath({
      thesis: LONG_THESIS,
      bars: [bar(0, 56_990, 57_010), bar(1, 57_050, 57_130)],
      timeframe: "1m",
    })!;

    expect(path.firstTouch).toBe("TARGET");
    expect(path.favourableExcursion).toBe(130);
  });

  it("returns null with no bars, rather than a zero-excursion measurement", () => {
    expect(resolveUnderlyingPath({ thesis: SHORT_THESIS, bars: [], timeframe: "1m" })).toBeNull();
  });

  it("returns null when the bars cannot be the thesis instrument's", () => {
    /*
     * Reuses `measureExcursions`' mismatch sentinel, which exists because index levels were once
     * measured against option premiums across 339 reviews. Option bars here would produce excursions
     * of exactly that kind -- nonsense that reads as a real measurement.
     */
    const optionBars = [bar(0, 105, 130), bar(1, 110, 140)];

    expect(resolveUnderlyingPath({ thesis: SHORT_THESIS, bars: optionBars, timeframe: "1m" })).toBeNull();
  });

  it("returns null when the thesis has no risk distance to measure against", () => {
    expect(resolveUnderlyingPath({
      thesis: { ...SHORT_THESIS, stop: SHORT_THESIS.entryReference },
      bars: [bar(0, 23_840, 23_860)],
      timeframe: "1m",
    })).toBeNull();
  });
});

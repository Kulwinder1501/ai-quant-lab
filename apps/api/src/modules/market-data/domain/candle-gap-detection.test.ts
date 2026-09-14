import { describe, expect, it } from "vitest";
import { classifySessionCoverage } from "./candle-gap-detection.js";

/** A run of consecutive present minute indices [0, n). */
function contiguous(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

describe("classifySessionCoverage", () => {
  it("calls a full session complete", () => {
    expect(classifySessionCoverage({ presentMinuteIndices: contiguous(375), barsExpected: 375 }).kind)
      .toBe("COMPLETE");
  });

  it("flags a hole between present bars as a confirmed gap", () => {
    // Present 0..199 and 210..374: minutes 200-209 are missing between live bars either side. This is
    // the 08-12/08-13 shape.
    const present = [...contiguous(200), ...Array.from({ length: 165 }, (_, i) => 210 + i)];
    const coverage = classifySessionCoverage({ presentMinuteIndices: present, barsExpected: 375 });
    expect(coverage.kind).toBe("CONFIRMED_GAP");
    expect(coverage.interiorMissing).toBe(10);
    expect(coverage.openMissing).toBe(false);
  });

  it("treats a missing morning as a confirmed gap, because the open is never legitimately late", () => {
    // The 08-07/08-11 shape: first bar at 13:38. NSE opens 09:15, so a late first bar is a missed open
    // -- a real collection miss, not an ambiguous short session. 08-11 was exactly this and was real.
    const present = Array.from({ length: 113 }, (_, i) => 262 + i);
    const coverage = classifySessionCoverage({ presentMinuteIndices: present, barsExpected: 375 });
    expect(coverage.kind).toBe("CONFIRMED_GAP");
    expect(coverage.openMissing).toBe(true);
  });

  it("treats an early close with a present open as tail-short, not a gap", () => {
    // Contiguous from the open, ending early. A half-day closes early on purpose; escalating this would
    // false-alarm every legitimate short session. Ambiguous, so reported soft.
    const coverage = classifySessionCoverage({ presentMinuteIndices: contiguous(300), barsExpected: 375 });
    expect(coverage.kind).toBe("TAIL_SHORT");
    expect(coverage.interiorMissing).toBe(0);
    expect(coverage.openMissing).toBe(false);
  });

  it("counts a single interior missing minute — the 08-18 shape", () => {
    const present = contiguous(375).filter((i) => i !== 357); // 15:13 was missing
    const coverage = classifySessionCoverage({ presentMinuteIndices: present, barsExpected: 375 });
    expect(coverage.kind).toBe("CONFIRMED_GAP");
    expect(coverage.interiorMissing).toBe(1);
  });

  it("treats an entirely empty session as a confirmed gap", () => {
    const coverage = classifySessionCoverage({ presentMinuteIndices: [], barsExpected: 375 });
    expect(coverage.kind).toBe("CONFIRMED_GAP");
    expect(coverage.openMissing).toBe(true);
    expect(coverage.barsPresent).toBe(0);
  });

  it("is order-independent", () => {
    expect(classifySessionCoverage({ presentMinuteIndices: [5, 2, 0, 4, 1, 3], barsExpected: 6 }).kind)
      .toBe("COMPLETE");
  });

  it("refuses a bar index outside the regular session, rather than reading it as a missing open", () => {
    // A Muhurat evening bar mapped against the 09:15 open lands far beyond 375. Feeding it here would
    // make the open look missing and raise a false CONFIRMED_GAP; the caller must exclude such days.
    expect(() => classifySessionCoverage({ presentMinuteIndices: [526], barsExpected: 375 }))
      .toThrow(/outside the regular session/);
  });

  it("refuses a nonsensical expected count", () => {
    expect(() => classifySessionCoverage({ presentMinuteIndices: [0], barsExpected: 0 }))
      .toThrow(/positive integer/);
  });
});

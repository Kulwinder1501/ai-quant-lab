import { describe, expect, it } from "vitest";
import {
  STUDY_PARAMETERS,
  countBy,
  countSession,
  describeReaction,
  evaluateSession,
  mulberry32,
  placeboLines,
  summariseReaction,
  type IntradayBar,
  type SessionCounts,
  type StudyLine,
} from "./reaction-study.js";

const flat = (price: number): IntradayBar => ({ open: price, high: price, low: price, close: price });
const bar = (open: number, high: number, low: number, close: number): IntradayBar => ({ open, high, low, close });
const real = (price: number, key = "pdh", family: StudyLine["family"] = "PRIOR_DAY"): StudyLine => ({ key, family, kind: "REAL", price });

describe("touch and outcome", () => {
  it("calls a fall of 0.25% after touching a line from below a bounce off resistance", () => {
    // Line 100; the touch band is 0.05, so a high of 99.96 touches. The previous close, 98, is below the line: a resistance test.
    const bars = [bar(98, 99.96, 98, 99), bar(99.8, 99.9, 99.7, 99.75)];
    const [result] = evaluateSession(bars, 98, [real(100)]);
    expect(result.side).toBe("RESISTANCE");
    expect(result.touchIndex).toBe(0);
    expect(result.outcome).toBe("BOUNCE");
  });

  it("calls a rise of 0.25% through a resistance line a break", () => {
    const bars = [bar(98, 100, 98, 99.9), bar(99.9, 100.26, 99.8, 100.2)];
    const [result] = evaluateSession(bars, 98, [real(100)]);
    expect(result.outcome).toBe("BREAK");
  });

  it("reverses the directions for a support test from above", () => {
    // The previous close, 102, is above the line: a support test, so a bounce is a rise of 0.25% and a break a fall of it.
    const touchBar = bar(102, 102, 100.02, 101);
    const [bounce] = evaluateSession([touchBar, bar(100.1, 100.3, 100, 100.2)], 102, [real(100, "s1", "PIVOT")]);
    expect(bounce.side).toBe("SUPPORT");
    expect(bounce.outcome).toBe("BOUNCE");
    const [broke] = evaluateSession([touchBar, bar(100, 100.1, 99.7, 99.8)], 102, [real(100, "s1", "PIVOT")]);
    expect(broke.outcome).toBe("BREAK");
  });

  it("leaves a touch UNRESOLVED when neither move happens inside the window", () => {
    const bars = [bar(98, 100, 98, 99.9), ...Array.from({ length: 12 }, () => bar(99.9, 100.1, 99.9, 100))];
    const [result] = evaluateSession(bars, 98, [real(100)]);
    expect(result.outcome).toBe("UNRESOLVED");
  });

  it("looks only `windowBars` bars past the touch", () => {
    const quiet = Array.from({ length: STUDY_PARAMETERS.windowBars }, () => bar(99.9, 100.1, 99.9, 100));
    const late = bar(100, 100.4, 99.9, 100.3); // a break, but one bar too late
    const [result] = evaluateSession([bar(98, 100, 98, 99.9), ...quiet, late], 98, [real(100)]);
    expect(result.outcome).toBe("UNRESOLVED");
  });

  it("calls a bar that reaches both targets UNRESOLVED, because the order inside it is unknown", () => {
    const [result] = evaluateSession([bar(98, 100, 98, 99.9), bar(99.9, 100.3, 99.7, 100)], 98, [real(100)]);
    expect(result.outcome).toBe("UNRESOLVED");
  });

  it("counts only the first touch of a line", () => {
    const bars = [bar(98, 100, 98, 99.9), bar(99.9, 99.9, 99.7, 99.8), bar(99.8, 100, 99.8, 99.9)];
    expect(evaluateSession(bars, 98, [real(100)])).toHaveLength(1);
  });

  it("uses the previous session's close to set the side when the first bar touches", () => {
    const [fromBelow] = evaluateSession([bar(100.1, 100.2, 99.99, 100.1), bar(100.1, 100.1, 99.7, 99.8)], 99, [real(100)]);
    const [fromAbove] = evaluateSession([bar(100.1, 100.2, 99.99, 100.1), bar(100.1, 100.1, 99.7, 99.8)], 101, [real(100)]);
    expect(fromBelow.side).toBe("RESISTANCE");
    expect(fromAbove.side).toBe("SUPPORT");
  });

  it("ignores a line the session never reaches", () => {
    expect(evaluateSession([flat(100), flat(100.1)], 100, [real(110)])).toEqual([]);
  });
});

describe("placebo lines", () => {
  it("makes four displaced lines per real level", () => {
    const lines = placeboLines([{ key: "pdh", family: "PRIOR_DAY", price: 20_000 }]);
    expect(lines).toHaveLength(4);
    expect(lines.every((line) => line.kind === "PLACEBO" && line.family === "PRIOR_DAY")).toBe(true);
    expect(lines.map((line) => Math.round((line.price / 20_000 - 1) * 10_000)).sort((a, b) => a - b)).toEqual([-50, -35, 35, 50]);
  });

  it("drops a placebo line that lands within 0.15% of another real level", () => {
    // Real levels 20,000 and 20,100. Displaced from 20,000: +0.50% is 20,100 (on the real level) and +0.35% is 20,070 (30 points away,
    // inside 0.15% of 20,100 = 30.15), so both go; -0.50% and -0.35% stay.
    const lines = placeboLines([
      { key: "a", family: "PIVOT", price: 20_000 },
      { key: "b", family: "PRIOR_DAY", price: 20_100 },
    ]);
    const fromA = lines.filter((line) => line.key.startsWith("a")).map((line) => line.key).sort();
    expect(fromA).toEqual(["a-0.35%", "a-0.50%"]);
  });
});

describe("counting and the interval", () => {
  const touch = (kind: "REAL" | "PLACEBO", outcome: "BOUNCE" | "BREAK" | "UNRESOLVED", family: StudyLine["family"] = "PIVOT") =>
    ({ key: "k", family, kind, side: "RESISTANCE" as const, outcome, touchIndex: 0 });

  it("counts resolved touches by class and drops unresolved ones", () => {
    const results = [touch("REAL", "BOUNCE"), touch("REAL", "BREAK"), touch("REAL", "UNRESOLVED"), touch("PLACEBO", "BOUNCE", "PRIOR_DAY")];
    expect(countSession(results, "ALL")).toEqual({ realBounce: 1, realBreak: 1, placeboBounce: 1, placeboBreak: 0 });
    expect(countSession(results, "PIVOT")).toEqual({ realBounce: 1, realBreak: 1, placeboBounce: 0, placeboBreak: 0 });
  });

  it("compares two groups of real levels with the same counter", () => {
    const results = [
      { ...touch("REAL", "BOUNCE"), confluence: 2 },
      { ...touch("REAL", "BREAK"), confluence: 2 },
      { ...touch("REAL", "BOUNCE"), confluence: 1 },
      { ...touch("PLACEBO", "BOUNCE") },
    ];
    const counts = countBy(results, (result) => (result.kind !== "REAL" ? null : (result.confluence ?? 0) >= 2 ? "A" : "B"));
    expect(counts).toEqual({ realBounce: 1, realBreak: 1, placeboBounce: 1, placeboBreak: 0 });
  });

  it("gives the same interval every time for the same seed", () => {
    const sessions: SessionCounts[] = Array.from({ length: 80 }, (_, index) => ({ realBounce: 1 + (index % 3), realBreak: 1, placeboBounce: 1, placeboBreak: 1 + (index % 2) }));
    expect(summariseReaction("ALL", sessions)).toEqual(summariseReaction("ALL", sessions));
  });

  it("generates the same sequence for the same seed", () => {
    const a = mulberry32(7); const b = mulberry32(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("finds a real difference when one is built in, and not when there is none", () => {
    const random = mulberry32(11);
    const day = (pReal: number, pPlacebo: number): SessionCounts => {
      let realBounce = 0; let realBreak = 0; let placeboBounce = 0; let placeboBreak = 0;
      for (let i = 0; i < 6; i += 1) { if (random() < pReal) realBounce += 1; else realBreak += 1; }
      for (let i = 0; i < 12; i += 1) { if (random() < pPlacebo) placeboBounce += 1; else placeboBreak += 1; }
      return { realBounce, realBreak, placeboBounce, placeboBreak };
    };
    const strong = summariseReaction("ALL", Array.from({ length: 400 }, () => day(0.7, 0.5)));
    expect(strong.lower).not.toBeNull();
    expect(strong.lower as number).toBeGreaterThan(0);
    const none = summariseReaction("ALL", Array.from({ length: 400 }, () => day(0.5, 0.5)));
    expect(none.lower as number).toBeLessThan(0);
    expect(none.upper as number).toBeGreaterThan(0);
  });

  it("has no interval when there is nothing to compare", () => {
    const empty = summariseReaction("ALL", [{ realBounce: 0, realBreak: 0, placeboBounce: 0, placeboBreak: 0 }]);
    expect(empty.difference).toBeNull();
    expect(empty.lower).toBeNull();
    expect(describeReaction(empty)).toMatch(/too few/i);
  });
});

describe("the sentence", () => {
  const base = { family: "ALL" as const, sessions: 100, realResolved: 100, placeboResolved: 300, realBounceShare: 0.5, placeboBounceShare: 0.5 };

  it("says no difference when the interval contains zero", () => {
    expect(describeReaction({ ...base, difference: 0.01, lower: -0.04, upper: 0.06 })).toBe("No demonstrated difference from random lines (-4.0 to +6.0 points).");
  });

  it("says more or less often only when the interval excludes zero", () => {
    expect(describeReaction({ ...base, difference: 0.05, lower: 0.01, upper: 0.09 })).toBe("Bounced more often than random lines (+1.0 to +9.0 points).");
    expect(describeReaction({ ...base, difference: -0.05, lower: -0.09, upper: -0.01 })).toBe("Bounced less often than random lines (-9.0 to -1.0 points).");
  });

  it("names the other group when it is not random lines", () => {
    expect(describeReaction({ ...base, difference: -0.03, lower: -0.07, upper: -0.01 }, "single-source levels")).toBe("Bounced less often than single-source levels (-7.0 to -1.0 points).");
    expect(describeReaction({ ...base, difference: 0, lower: -0.02, upper: 0.02 }, "single-source levels")).toBe("No demonstrated difference from single-source levels (-2.0 to +2.0 points).");
  });
});


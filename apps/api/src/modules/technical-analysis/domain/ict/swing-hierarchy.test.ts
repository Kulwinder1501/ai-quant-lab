import { describe, expect, it } from "vitest";
import {
  classifySwingHierarchy,
  computeSwingHierarchyFeature,
  computeSwingHierarchySnapshot,
} from "./swing-hierarchy.js";
import type { ConfirmedPivot } from "./causal-pivot.js";

let nextIndex = 0;
function pivot(type: "HIGH" | "LOW", price: number): ConfirmedPivot {
  const index = nextIndex++;
  return {
    index,
    time: new Date(2026, 0, 1, 0, index),
    price,
    type,
    confirmedAtIndex: index + 3,
    confirmedAtTime: new Date(2026, 0, 1, 0, index + 3),
  };
}

describe("classifySwingHierarchy", () => {
  it("classifies a HIGH pivot as INTERMEDIATE_TERM when it is higher than both same-type neighbours", () => {
    const pivots = [pivot("HIGH", 100), pivot("HIGH", 110), pivot("HIGH", 105)];
    const classified = classifySwingHierarchy(pivots);
    expect(classified[0].tier).toBe("SHORT_TERM"); // no left same-type neighbour
    expect(classified[1].tier).toBe("INTERMEDIATE_TERM"); // 110 > 100 and 110 > 105
    expect(classified[2].tier).toBe("SHORT_TERM"); // no right same-type neighbour yet
  });

  it("classifies a LOW pivot as INTERMEDIATE_TERM when it is lower than both same-type neighbours", () => {
    const pivots = [pivot("LOW", 100), pivot("LOW", 90), pivot("LOW", 95)];
    const classified = classifySwingHierarchy(pivots);
    expect(classified[0].tier).toBe("SHORT_TERM");
    expect(classified[1].tier).toBe("INTERMEDIATE_TERM"); // 90 < 100 and 90 < 95
    expect(classified[2].tier).toBe("SHORT_TERM");
  });

  it("does not classify a middle pivot that is not more extreme than both neighbours", () => {
    // Monotonically rising highs: the middle one is not a local extremum either side.
    const pivots = [pivot("HIGH", 100), pivot("HIGH", 105), pivot("HIGH", 110)];
    const classified = classifySwingHierarchy(pivots);
    expect(classified[1].tier).toBe("SHORT_TERM");
  });

  it("classifies HIGH and LOW independently -- interleaving does not affect either series", () => {
    const pivots = [
      pivot("HIGH", 100),
      pivot("LOW", 90),
      pivot("HIGH", 110), // middle HIGH: 110 > 100 and 110 > 105 -> ITH
      pivot("LOW", 95),
      pivot("HIGH", 105),
      pivot("LOW", 85), // middle LOW: 90 not compared here; this is the 3rd LOW, not yet classifiable
    ];
    const classified = classifySwingHierarchy(pivots);
    const highs = classified.filter((c) => c.pivot.type === "HIGH");
    expect(highs.map((c) => c.tier)).toEqual(["SHORT_TERM", "INTERMEDIATE_TERM", "SHORT_TERM"]);
  });

  it("retroactively promotes a pivot once its right same-type neighbour arrives", () => {
    const first = [pivot("HIGH", 100), pivot("HIGH", 110)];
    expect(classifySwingHierarchy(first)[1].tier).toBe("SHORT_TERM"); // no right neighbour yet

    const withThird = [...first, pivot("HIGH", 104)];
    expect(classifySwingHierarchy(withThird)[1].tier).toBe("INTERMEDIATE_TERM"); // now confirmable
  });

  it("returns an empty list for an empty input", () => {
    expect(classifySwingHierarchy([])).toEqual([]);
  });
});

describe("computeSwingHierarchySnapshot", () => {
  it("returns all nulls when there is no history", () => {
    expect(computeSwingHierarchySnapshot([])).toEqual({
      nearestIntermediateTermHigh: null,
      nearestIntermediateTermLow: null,
      nearestShortTermHigh: null,
      nearestShortTermLow: null,
    });
  });

  it("picks the most recent (last) pivot in each of the four categories", () => {
    const ith1 = pivot("HIGH", 110); // will become ITH once its right neighbour (a) arrives
    const a = pivot("HIGH", 104);
    const pivots = [pivot("HIGH", 100), ith1, a];
    const snapshot = computeSwingHierarchySnapshot(pivots);
    expect(snapshot.nearestIntermediateTermHigh).toBe(ith1);
    expect(snapshot.nearestShortTermHigh).toBe(a); // last HIGH, not yet classifiable -> short term
  });

  it("tracks HIGH and LOW nearest-points independently", () => {
    const itl = pivot("LOW", 90);
    const pivots = [pivot("LOW", 100), itl, pivot("LOW", 95), pivot("HIGH", 120), pivot("HIGH", 130)];
    const snapshot = computeSwingHierarchySnapshot(pivots);
    expect(snapshot.nearestIntermediateTermLow).toBe(itl);
    expect(snapshot.nearestShortTermHigh?.price).toBe(130);
  });
});

describe("computeSwingHierarchyFeature", () => {
  const emptySnapshot = {
    nearestIntermediateTermHigh: null,
    nearestIntermediateTermLow: null,
    nearestShortTermHigh: null,
    nearestShortTermLow: null,
  };

  it("returns all nulls and no breach when there is no swing hierarchy yet, regardless of trend", () => {
    const feature = computeSwingHierarchyFeature(emptySnapshot, "BULLISH", 100);
    expect(feature.protectedSide).toBeNull();
    expect(feature.protectedLevelBreached).toBe(false);
    expect(feature.distanceToIntermediateTermHigh).toBeNull();
    expect(feature.distanceToIntermediateTermLow).toBeNull();
  });

  it("protects the Intermediate Term LOW when the trend is BULLISH", () => {
    const itl = pivot("LOW", 100);
    const feature = computeSwingHierarchyFeature(
      { ...emptySnapshot, nearestIntermediateTermLow: itl },
      "BULLISH",
      110
    );
    expect(feature.protectedSide).toBe("INTERMEDIATE_TERM_LOW");
    expect(feature.protectedLevelBreached).toBe(false); // 110 > 100, not breached
    expect(feature.distanceToIntermediateTermLow).toBe(10);
  });

  it("flags a breach when price has closed below the protected ITL in a BULLISH trend", () => {
    const itl = pivot("LOW", 100);
    const feature = computeSwingHierarchyFeature(
      { ...emptySnapshot, nearestIntermediateTermLow: itl },
      "BULLISH",
      95
    );
    expect(feature.protectedLevelBreached).toBe(true);
  });

  it("protects the Intermediate Term HIGH when the trend is BEARISH", () => {
    const ith = pivot("HIGH", 200);
    const feature = computeSwingHierarchyFeature(
      { ...emptySnapshot, nearestIntermediateTermHigh: ith },
      "BEARISH",
      190
    );
    expect(feature.protectedSide).toBe("INTERMEDIATE_TERM_HIGH");
    expect(feature.protectedLevelBreached).toBe(false); // 190 < 200, not breached
  });

  it("flags a breach when price has closed above the protected ITH in a BEARISH trend", () => {
    const ith = pivot("HIGH", 200);
    const feature = computeSwingHierarchyFeature(
      { ...emptySnapshot, nearestIntermediateTermHigh: ith },
      "BEARISH",
      205
    );
    expect(feature.protectedLevelBreached).toBe(true);
  });

  it("has no protected side when the trend is NEUTRAL, even with both ITH and ITL present", () => {
    const feature = computeSwingHierarchyFeature(
      {
        ...emptySnapshot,
        nearestIntermediateTermHigh: pivot("HIGH", 200),
        nearestIntermediateTermLow: pivot("LOW", 100),
      },
      "NEUTRAL",
      150
    );
    expect(feature.protectedSide).toBeNull();
    expect(feature.protectedLevelBreached).toBe(false);
  });

  it("reports unsigned distances to the short-term points independently of the protected side", () => {
    const feature = computeSwingHierarchyFeature(
      { ...emptySnapshot, nearestShortTermHigh: pivot("HIGH", 120), nearestShortTermLow: pivot("LOW", 80) },
      "BULLISH",
      100
    );
    expect(feature.distanceToShortTermHigh).toBe(20);
    expect(feature.distanceToShortTermLow).toBe(20);
  });

  it("is a pure function of its inputs: identical inputs twice give identical output", () => {
    const snapshot = { ...emptySnapshot, nearestIntermediateTermLow: pivot("LOW", 100) };
    expect(computeSwingHierarchyFeature(snapshot, "BULLISH", 110)).toEqual(
      computeSwingHierarchyFeature(snapshot, "BULLISH", 110)
    );
  });
});

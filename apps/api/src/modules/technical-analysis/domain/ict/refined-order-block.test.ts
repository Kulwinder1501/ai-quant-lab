import { describe, expect, it } from "vitest";
import {
  alignHtfSnapshotsToLtf,
  computeRefinedOrderBlock,
  type HtfSnapshotWithCloseTime,
} from "./refined-order-block.js";
import type { OrderBlock } from "./zones.js";
import type { IctStateCompositeSnapshot } from "./config.js";

function makeOb(overrides: Partial<OrderBlock> & Pick<OrderBlock, "id" | "type" | "top" | "bottom">): OrderBlock {
  const meanThreshold = overrides.meanThreshold ?? (overrides.top + overrides.bottom) / 2;
  return {
    meanThreshold,
    createdAtBarIndex: 0,
    createdAtBarTime: new Date(),
    obCandleIndex: 0,
    displacementCandleIndex: 1,
    attachedFvgId: null,
    isExtreme: false,
    isIdmAdjacent: false,
    kind: "CLASSIC",
    state: "FRESH",
    ...overrides,
  };
}

describe("computeRefinedOrderBlock", () => {
  it("returns null when no HTF order block is active", () => {
    expect(computeRefinedOrderBlock([], [], 100)).toBeNull();
  });

  it("reports the HTF distance alone when no LTF order block is nested inside it", () => {
    // 4H-style box: 24000-24200 (bullish). No LTF OB anywhere near it.
    const htfOb = makeOb({ id: "htf-1", type: "BULLISH", top: 24200, bottom: 24000, isExtreme: true });
    const ltfObs = [makeOb({ id: "ltf-1", type: "BULLISH", top: 25200, bottom: 25100 })]; // unrelated range
    const result = computeRefinedOrderBlock([htfOb], ltfObs, 24150);
    expect(result).not.toBeNull();
    expect(result!.htfOrderBlockSide).toBe("BULLISH");
    expect(result!.htfOrderBlockDistance).toBe(Math.abs(24150 - 24100)); // meanThreshold defaults to midpoint
    expect(result!.refinedOrderBlockDistance).toBeNull();
    expect(result!.stopCompressionRatio).toBeNull();
  });

  it("finds a nested LTF order block strictly inside the HTF range and reports compression", () => {
    // Matches lecture 4's own worked example shape: a wide HTF block refined by a much tighter LTF one.
    const htfOb = makeOb({ id: "htf-1", type: "BULLISH", top: 24200, bottom: 24000, isExtreme: true }); // 200-pt range
    const nested = makeOb({ id: "ltf-1", type: "BULLISH", top: 24130, bottom: 24055 }); // 75-pt range, inside
    const outside = makeOb({ id: "ltf-2", type: "BULLISH", top: 24250, bottom: 24210 }); // wider box entirely, not nested
    const result = computeRefinedOrderBlock([htfOb], [nested, outside], 24100);
    expect(result!.refinedOrderBlockDistance).toBe(Math.abs(24100 - nested.meanThreshold));
    expect(result!.stopCompressionRatio).toBeCloseTo(75 / 200, 10);
  });

  it("prefers a nested order block with an attached FVG, per lecture 4's own stated criterion", () => {
    const htfOb = makeOb({ id: "htf-1", type: "BULLISH", top: 24200, bottom: 24000, isExtreme: true });
    const withoutFvg = makeOb({ id: "ltf-1", type: "BULLISH", top: 24120, bottom: 24060, attachedFvgId: null });
    const withFvg = makeOb({ id: "ltf-2", type: "BULLISH", top: 24150, bottom: 24080, attachedFvgId: "fvg-1" }); // wider than the other candidate
    const result = computeRefinedOrderBlock([htfOb], [withoutFvg, withFvg], 24100);
    expect(result!.refinedOrderBlockDistance).toBe(Math.abs(24100 - withFvg.meanThreshold));
  });

  it("among candidates with the same FVG status, prefers the tightest (smallest range)", () => {
    const htfOb = makeOb({ id: "htf-1", type: "BULLISH", top: 24200, bottom: 24000, isExtreme: true });
    const wider = makeOb({ id: "ltf-1", type: "BULLISH", top: 24150, bottom: 24050, attachedFvgId: "f1" }); // 100
    const tighter = makeOb({ id: "ltf-2", type: "BULLISH", top: 24130, bottom: 24070, attachedFvgId: "f2" }); // 60
    const result = computeRefinedOrderBlock([htfOb], [wider, tighter], 24100);
    expect(result!.refinedOrderBlockDistance).toBe(Math.abs(24100 - tighter.meanThreshold));
  });

  it("requires the same polarity: a bearish LTF block never nests inside a bullish HTF block", () => {
    const htfOb = makeOb({ id: "htf-1", type: "BULLISH", top: 24200, bottom: 24000, isExtreme: true });
    const oppositeSide = makeOb({ id: "ltf-1", type: "BEARISH", top: 24150, bottom: 24050 });
    const result = computeRefinedOrderBlock([htfOb], [oppositeSide], 24100);
    expect(result!.refinedOrderBlockDistance).toBeNull();
  });

  it("requires the LTF range to be strictly smaller, not merely contained at equal size", () => {
    const htfOb = makeOb({ id: "htf-1", type: "BULLISH", top: 24200, bottom: 24000, isExtreme: true });
    const sameSize = makeOb({ id: "ltf-1", type: "BULLISH", top: 24200, bottom: 24000 });
    const result = computeRefinedOrderBlock([htfOb], [sameSize], 24100);
    expect(result!.refinedOrderBlockDistance).toBeNull();
  });

  it("picks the HTF order block nearest to current price when several are active", () => {
    const near = makeOb({ id: "htf-near", type: "BULLISH", top: 24120, bottom: 24080, isExtreme: true }); // mean 24100
    const far = makeOb({ id: "htf-far", type: "BEARISH", top: 25200, bottom: 25100, isIdmAdjacent: true }); // mean 25150
    const result = computeRefinedOrderBlock([far, near], [], 24105);
    expect(result!.htfOrderBlockSide).toBe("BULLISH");
  });

  it("ignores an HTF order block that is neither IDM-adjacent nor extreme, even if it is nearer to price", () => {
    // Per lecture 4 (~47:08, ~42:44): only the IDM-adjacent and extreme order blocks in a swing range
    // are ever real candidates -- everything "in between" is explicitly not a candidate at all.
    const inBetween = makeOb({ id: "htf-mid", type: "BULLISH", top: 24105, bottom: 24095 }); // mean 24100, nearest to price
    const validButFarther = makeOb({ id: "htf-extreme", type: "BULLISH", top: 23920, bottom: 23880, isExtreme: true }); // mean 23900
    const result = computeRefinedOrderBlock([inBetween, validButFarther], [], 24100);
    expect(result!.htfOrderBlockDistance).toBe(Math.abs(24100 - 23900));
  });

  it("returns null when every active HTF order block is neither IDM-adjacent nor extreme", () => {
    const inBetween = makeOb({ id: "htf-mid", type: "BULLISH", top: 24105, bottom: 24095 });
    expect(computeRefinedOrderBlock([inBetween], [], 24100)).toBeNull();
  });
});

describe("alignHtfSnapshotsToLtf", () => {
  function stubSnapshot(barIndex: number): IctStateCompositeSnapshot {
    return { barIndex } as unknown as IctStateCompositeSnapshot;
  }

  it("is anti-lookahead: a bar not yet closed must not be visible to an earlier LTF bar", () => {
    const htfBars: HtfSnapshotWithCloseTime[] = [
      { closeTime: new Date("2026-01-01T04:00:00Z"), snapshot: stubSnapshot(0) },
      { closeTime: new Date("2026-01-01T05:00:00Z"), snapshot: stubSnapshot(1) },
    ];
    const ltfCloseTimes = [
      new Date("2026-01-01T03:45:00Z"), // before the first HTF bar closes
      new Date("2026-01-01T04:00:00Z"), // exactly at the first HTF close -- visible
      new Date("2026-01-01T04:30:00Z"), // still only the first HTF bar
      new Date("2026-01-01T05:00:00Z"), // now the second is visible too
    ];
    const aligned = alignHtfSnapshotsToLtf(htfBars, ltfCloseTimes);
    expect(aligned[0]).toBeNull();
    expect((aligned[1] as unknown as { barIndex: number }).barIndex).toBe(0);
    expect((aligned[2] as unknown as { barIndex: number }).barIndex).toBe(0);
    expect((aligned[3] as unknown as { barIndex: number }).barIndex).toBe(1);
  });

  it("never regresses to an earlier HTF bar as the LTF series advances", () => {
    const htfBars: HtfSnapshotWithCloseTime[] = [
      { closeTime: new Date("2026-01-01T04:00:00Z"), snapshot: stubSnapshot(0) },
      { closeTime: new Date("2026-01-01T05:00:00Z"), snapshot: stubSnapshot(1) },
      { closeTime: new Date("2026-01-01T06:00:00Z"), snapshot: stubSnapshot(2) },
    ];
    const ltfCloseTimes = [
      new Date("2026-01-01T05:15:00Z"),
      new Date("2026-01-01T05:30:00Z"),
      new Date("2026-01-01T06:00:00Z"),
    ];
    const aligned = alignHtfSnapshotsToLtf(htfBars, ltfCloseTimes).map(
      (s) => (s as unknown as { barIndex: number } | null)?.barIndex ?? null
    );
    expect(aligned).toEqual([1, 1, 2]);
  });
});

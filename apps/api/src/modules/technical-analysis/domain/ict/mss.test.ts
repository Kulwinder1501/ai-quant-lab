import { describe, expect, it } from "vitest";
import type { CausalCandle, ConfirmedPivot } from "./causal-pivot.js";
import { MssTracker, type MssSnapshot } from "./mss.js";
import type { SessionSweepEvent } from "./session-levels.js";
import { computeOteBandForLeg, OTE_RETRACE_SWEET_SPOT } from "./ote.js";
import { IctZoneLedger } from "./zones.js";
import { IctStructureTracker } from "./structure.js";

const ATR = 5;

function candle(index: number, open: number, high: number, low: number, close: number): CausalCandle {
  return {
    id: `c-${index}`,
    openTime: new Date(Date.UTC(2026, 0, 5, 3, 45 + index * 5)),
    open,
    high,
    low,
    close,
    volume: 100,
  };
}

function pivot(type: "HIGH" | "LOW", index: number, price: number, confirmedAtIndex: number): ConfirmedPivot {
  const time = new Date(Date.UTC(2026, 0, 5, 3, 45 + index * 5));
  return {
    index,
    time,
    price,
    type,
    confirmedAtIndex,
    confirmedAtTime: new Date(Date.UTC(2026, 0, 5, 3, 45 + confirmedAtIndex * 5)),
    candidateAt: time.getTime(),
    formedAt: time.getTime(),
    confirmedAt: time.getTime(),
    availableAt: time.getTime(),
  };
}

/** Feeds the tracker bar by bar, handing it only the pivots confirmed by that bar. */
function run(
  candles: CausalCandle[],
  pivots: ConfirmedPivot[],
  sessionSweeps: Record<number, SessionSweepEvent> = {}
): (MssSnapshot | null)[] {
  const tracker = new MssTracker();
  return candles.map((_, i) =>
    tracker.processCandle(
      candles.slice(0, i + 1),
      i,
      pivots.filter((p) => p.confirmedAtIndex <= i),
      ATR,
      sessionSweeps[i] ?? null
    )
  );
}

/**
 * Bullish setup. A swing high at 110 (index 2), then a swing low at 100 (index 6). Bar 10 wicks to 98,
 * under that low, and closes back at 101: sell-side liquidity taken. Bar 11 is a 8-point bullish body
 * (1.6 ATR) closing at 112, through the 110 swing high that preceded the sweep.
 */
function bullishSetup(): { candles: CausalCandle[]; pivots: ConfirmedPivot[] } {
  const candles = [
    candle(0, 105, 108, 104, 107),
    candle(1, 107, 109, 106, 108),
    candle(2, 108, 110, 107, 109),
    candle(3, 109, 109, 105, 106),
    candle(4, 106, 107, 103, 104),
    candle(5, 104, 105, 101, 102),
    candle(6, 102, 103, 100, 101),
    candle(7, 101, 104, 101, 103),
    candle(8, 103, 106, 102, 105),
    candle(9, 105, 106, 102, 103),
    candle(10, 103, 104, 98, 101), // sweep: low 98 < 100, close 101 > 100
    candle(11, 104, 113, 103, 112), // displacement through 110
    candle(12, 112, 115, 111, 114),
  ];
  const pivots = [pivot("HIGH", 2, 110, 5), pivot("LOW", 6, 100, 9)];
  return { candles, pivots };
}

describe("MssTracker", () => {
  it("fires a bullish shift only after a sweep AND a displacement close through the preceding swing high", () => {
    const { candles, pivots } = bullishSetup();
    const out = run(candles, pivots);

    // The sweep bar alone is not a shift, and neither is anything before the displacement.
    for (let i = 0; i <= 10; i += 1) expect(out[i]).toBeNull();

    const shift = out[11];
    expect(shift).not.toBeNull();
    expect(shift!.direction).toBe("BULLISH");
    expect(shift!.brokenLevel).toBe(110);
    expect(shift!.sweptKind).toBe("SWING");
    expect(shift!.sweepBarIndex).toBe(10);
    expect(shift!.breakBarIndex).toBe(11);
    expect(shift!.barsSinceBreak).toBe(0);
    expect(shift!.legStart).toBe(98); // the sweep extreme is the protective level
    expect(shift!.legEnd).toBe(113);
    expect(shift!.displacementBodyAtr).toBeCloseTo(1.6, 5);
    // Bar 11's low (103) does not clear bar 9's high (106): a displacement, but no 3-bar gap.
    expect(shift!.hasFvg).toBe(false);
  });

  it("records a fair value gap when the breaking candle leaves one", () => {
    const { candles, pivots } = bullishSetup();
    candles[9] = candle(9, 105, 106, 102, 103);
    candles[11] = candle(11, 108, 113, 107, 112); // low 107 > bar 9 high 106
    expect(run(candles, pivots)[11]!.hasFvg).toBe(true);
  });

  it("extends the leg forward as price runs and never rewrites an earlier snapshot", () => {
    const { candles, pivots } = bullishSetup();
    const out = run(candles, pivots);
    expect(out[11]!.legEnd).toBe(113);
    expect(out[12]!.legEnd).toBe(115);
    expect(out[12]!.barsSinceBreak).toBe(1);
    // The object handed out on bar 11 is untouched by what happened on bar 12.
    expect(out[11]!.legEnd).toBe(113);
    expect(out[11]).not.toBe(out[12]);
  });

  it("kills the shift on a body close beyond the sweep extreme", () => {
    const { candles, pivots } = bullishSetup();
    // Closes under 98 without first wicking above the 110 swing high (which would be its own sweep).
    candles.push(candle(13, 109, 109.5, 96, 97));
    const out = run(candles, pivots);
    expect(out[12]).not.toBeNull();
    expect(out[13]).toBeNull();
  });

  it("does not fire without a prior sweep, however strong the displacement", () => {
    const { candles, pivots } = bullishSetup();
    // Same path but bar 10 never wicks under the 100 low.
    candles[10] = candle(10, 103, 104, 101, 102);
    const out = run(candles, pivots);
    expect(out.every((s) => s === null)).toBe(true);
  });

  it("does not fire when the breaking candle is not a displacement", () => {
    const { candles, pivots } = bullishSetup();
    // Closes through 110 but with a 2-point body (0.4 ATR), a drift rather than a displacement.
    candles[11] = candle(11, 109, 112, 108.5, 111);
    const out = run(candles, pivots);
    expect(out[11]).toBeNull();
  });

  it("does not fire when the close stays under the preceding swing high", () => {
    const { candles, pivots } = bullishSetup();
    candles[11] = candle(11, 103, 110, 102, 109.5); // strong body, but under 110
    const out = run(candles, pivots);
    expect(out[11]).toBeNull();
  });

  it("lets a sweep expire if no shift follows within the lookback", () => {
    const { candles, pivots } = bullishSetup();
    // Replace the displacement with drift and put it 12 bars after the sweep instead.
    candles[11] = candle(11, 101, 104, 100, 102);
    candles[12] = candle(12, 102, 104, 101, 103);
    for (let i = 13; i <= 22; i += 1) candles.push(candle(i, 103, 105, 102, 104));
    candles.push(candle(23, 104, 114, 103, 113));
    const out = run(candles, pivots);
    expect(out[23]).toBeNull();
  });

  it("detects the bearish mirror image", () => {
    const candles = [
      candle(0, 100, 101, 96, 97),
      candle(1, 97, 98, 94, 95),
      candle(2, 95, 96, 92, 93), // swing low 92
      candle(3, 93, 97, 93, 96),
      candle(4, 96, 99, 95, 98),
      candle(5, 98, 101, 97, 100),
      candle(6, 100, 104, 99, 103), // swing high 104
      candle(7, 103, 103, 100, 101),
      candle(8, 101, 102, 98, 99),
      candle(9, 99, 101, 97, 100),
      candle(10, 100, 106, 99, 102), // sweep: high 106 > 104, close 102 < 104
      candle(11, 98, 99, 88, 89), // displacement down through 92 (9-point body = 1.8 ATR)
      candle(12, 89, 90, 85, 86),
    ];
    const pivots = [pivot("LOW", 2, 92, 5), pivot("HIGH", 6, 104, 9)];
    const out = run(candles, pivots);
    expect(out[10]).toBeNull();
    expect(out[11]).not.toBeNull();
    expect(out[11]!.direction).toBe("BEARISH");
    expect(out[11]!.brokenLevel).toBe(92);
    expect(out[11]!.legStart).toBe(106);
    expect(out[11]!.legEnd).toBe(88);
    expect(out[12]!.legEnd).toBe(85);
  });

  it("counts a previous-day-low sweep as the liquidity taken", () => {
    const { candles, pivots } = bullishSetup();
    // No swing-low pool taken on bar 10 this time (the low pivot is removed), but PDL was.
    const out = run(
      candles,
      pivots.filter((p) => p.type === "HIGH"),
      {
        10: {
          barIndex: 10,
          barTime: candles[10].openTime,
          levelType: "PDL",
          levelPrice: 100,
          eventType: "SWEEP",
          penetrationBps: 20,
          reclaimDistanceBps: 10,
        },
      }
    );
    expect(out[11]).not.toBeNull();
    expect(out[11]!.sweptKind).toBe("PDL");
  });

  it("is causal: a snapshot for a bar is identical whether or not later bars exist", () => {
    const { candles, pivots } = bullishSetup();
    const full = run(candles, pivots);
    const truncated = run(candles.slice(0, 12), pivots);
    expect(truncated[11]).toEqual(full[11]);
  });

  it("never uses a pivot that had not been confirmed by the evaluated bar", () => {
    const { candles } = bullishSetup();
    // The swing low is only confirmed at bar 12, AFTER the sweep bar, so bar 10 cannot have swept it.
    const late = [pivot("HIGH", 2, 110, 5), pivot("LOW", 6, 100, 12)];
    const out = run(candles, late);
    expect(out[11]).toBeNull();
  });
});

describe("computeOteBandForLeg", () => {
  it("places the band at 62-79% retracement BELOW a bullish leg's far end", () => {
    const band = computeOteBandForLeg(100, 200, "BULLISH")!;
    expect(band.bandHigh).toBeCloseTo(200 - 62, 6);
    expect(band.bandLow).toBeCloseTo(200 - 79, 6);
    expect(band.level).toBeCloseTo(200 - 100 * OTE_RETRACE_SWEET_SPOT, 6);
    expect(band.span).toBe(100);
  });

  it("mirrors above a bearish leg's far end", () => {
    const band = computeOteBandForLeg(200, 100, "BEARISH")!;
    expect(band.bandLow).toBeCloseTo(100 + 62, 6);
    expect(band.bandHigh).toBeCloseTo(100 + 79, 6);
    expect(band.level).toBeCloseTo(100 + 70.5, 6);
  });

  it("is null for a degenerate or wrong-way leg", () => {
    expect(computeOteBandForLeg(100, 100, "BULLISH")).toBeNull();
    expect(computeOteBandForLeg(100, 90, "BULLISH")).toBeNull();
    expect(computeOteBandForLeg(100, 110, "BEARISH")).toBeNull();
  });
});

describe("IctZoneLedger size floors", () => {
  /** A bullish gap of exactly `gap` points between candle 1's high (100) and candle 3's low. */
  function ledgerWithGap(gap: number, minFraction: number, atr: number | null) {
    const ledger = new IctZoneLedger(1.5, 0.5, false, 10, minFraction, 0);
    const struct = new IctStructureTracker(2);
    const candles = [
      candle(0, 95, 100, 90, 98),
      candle(1, 98, 122, 97, 120),
      candle(2, 115, 125, 100 + gap, 123),
    ];
    let snap = ledger.processCandle(candles, 0, struct.processCandle(candles, 0), atr);
    snap = ledger.processCandle(candles, 1, struct.processCandle(candles, 1), atr);
    snap = ledger.processCandle(candles, 2, struct.processCandle(candles, 2), atr);
    return snap;
  }

  it("keeps every gap when no floor is configured (the old behaviour)", () => {
    expect(ledgerWithGap(0.05, 0, ATR).activeFvgs).toHaveLength(1);
  });

  it("drops a gap smaller than the configured ATR fraction", () => {
    // 0.2 points against a floor of 0.1 x ATR(5) = 0.5.
    expect(ledgerWithGap(0.2, 0.1, ATR).activeFvgs).toHaveLength(0);
  });

  it("keeps a gap at or above the floor", () => {
    expect(ledgerWithGap(0.5, 0.1, ATR).activeFvgs).toHaveLength(1);
    expect(ledgerWithGap(5, 0.1, ATR).activeFvgs).toHaveLength(1);
  });

  it("fails closed when a floor is configured but ATR is not yet known", () => {
    expect(ledgerWithGap(5, 0.1, null).activeFvgs).toHaveLength(0);
  });
});

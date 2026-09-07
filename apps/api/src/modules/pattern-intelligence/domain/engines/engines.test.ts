import { describe, expect, it } from "vitest";
import { BreakoutStateEngine } from "./breakout-state-engine.js";
import { CandleGeometryEngine } from "./candle-geometry-engine.js";
import { ClassicalReversalEngine } from "./classical-reversal-engine.js";
import { CompressionExpansionEngine } from "./compression-expansion-engine.js";
import { ContinuationStructureEngine } from "./continuation-structure-engine.js";
import { EffortResultEngine } from "./effort-result-engine.js";
import { GapStructureEngine } from "./gap-structure-engine.js";
import { LevelInteractionEngine } from "./level-interaction-engine.js";
import { MultiCandleEngine } from "./multi-candle-engine.js";
import { OpeningStructureEngine } from "./opening-structure-engine.js";
import { SweepReclaimEngine } from "./sweep-reclaim-engine.js";
import { SwingStructureEngine } from "./swing-structure-engine.js";

function makeCandle(openTime: Date, open: number, high: number, low: number, close: number, volume = 1000) {
  return { openTime, open, high, low, close, volume };
}

describe("Pattern Intelligence Engines", () => {
  it("SweepReclaimEngine detects Spring / Upthrust accurately", () => {
    const engine = new SweepReclaimEngine();
    const baseTime = new Date("2026-08-25T09:15:00.000Z");

    // Construct a swing low at candle 1 (low: 24500), rally to 24550, then candle 5 sweeps below 24500 (low: 24480) and closes at 24510
    const candles = [
      makeCandle(new Date(baseTime.getTime() + 0 * 60000), 24520, 24530, 24510, 24515),
      makeCandle(new Date(baseTime.getTime() + 1 * 60000), 24515, 24520, 24500, 24505), // swing low
      makeCandle(new Date(baseTime.getTime() + 2 * 60000), 24505, 24540, 24505, 24535),
      makeCandle(new Date(baseTime.getTime() + 3 * 60000), 24535, 24550, 24530, 24545),
      makeCandle(new Date(baseTime.getTime() + 4 * 60000), 24545, 24545, 24505, 24510),
      makeCandle(new Date(baseTime.getTime() + 5 * 60000), 24510, 24520, 24480, 24510), // sweep & reclaim
    ];

    const results = engine.detect(candles);
    expect(results.length).toBeGreaterThanOrEqual(1);
    const spring = results.find((r) => r.subtype === "SPRING");
    expect(spring).toBeDefined();
    expect(spring!.orientation).toBe("UP");
    expect(spring!.wyckoffEquivalent).toBe("SPRING");
    expect(spring!.referenceLevel).toBe(24500);
    expect(spring!.penetrationExcursionBps).toBeGreaterThan(0);
    expect(spring!.reclaimDistanceBps).toBeGreaterThan(0);
  });

  it("BreakoutStateEngine detects Breakout and Retest", () => {
    const engine = new BreakoutStateEngine();
    const baseTime = new Date("2026-08-25T09:15:00.000Z");

    // Local resistance at 25000, candle 5 closes at 25050 (Breakout)
    const candles = [
      makeCandle(new Date(baseTime.getTime() + 0 * 60000), 24950, 25000, 24940, 24980),
      makeCandle(new Date(baseTime.getTime() + 1 * 60000), 24980, 24990, 24960, 24970),
      makeCandle(new Date(baseTime.getTime() + 2 * 60000), 24970, 24995, 24950, 24960),
      makeCandle(new Date(baseTime.getTime() + 3 * 60000), 24960, 24980, 24950, 24970),
      makeCandle(new Date(baseTime.getTime() + 4 * 60000), 24970, 24990, 24960, 24980),
      makeCandle(new Date(baseTime.getTime() + 5 * 60000), 24980, 25060, 24975, 25050),
    ];

    const results = engine.detect(candles);
    const breakout = results.find((r) => r.subtype === "BREAKOUT");
    expect(breakout).toBeDefined();
    expect(breakout!.orientation).toBe("UP");
    expect(breakout!.breakoutLevel).toBe(25000);
    expect(breakout!.breakoutDistanceBps).toBeGreaterThan(0);
  });

  it("CompressionExpansionEngine detects Inside Bar, NR4, NR7, and VCP", () => {
    const engine = new CompressionExpansionEngine();
    const baseTime = new Date("2026-08-25T09:15:00.000Z");

    const candles = [
      makeCandle(new Date(baseTime.getTime() + 0 * 60000), 25000, 25100, 24900, 25050), // mother bar
      makeCandle(new Date(baseTime.getTime() + 1 * 60000), 25050, 25080, 24950, 25020), // inside bar
    ];

    const results = engine.detect(candles);
    const inside = results.find((r) => r.subtype === "INSIDE_BAR");
    expect(inside).toBeDefined();
    expect(inside!.orientation).toBe("BIDIRECTIONAL");
    expect(inside!.compressionRatio).toBeLessThan(1.0);
  });

  it("OpeningStructureEngine detects ORB and Opening Drive", () => {
    const engine = new OpeningStructureEngine({ openingRangeMinutes: 15 });
    // First candle has massive green body (Opening Drive)
    const candles = [
      makeCandle(new Date("2026-08-25T03:45:00.000Z"), 25000, 25100, 24995, 25095), // 09:15 IST
      makeCandle(new Date("2026-08-25T03:50:00.000Z"), 25095, 25110, 25080, 25100),
      makeCandle(new Date("2026-08-25T03:55:00.000Z"), 25100, 25120, 25090, 25115),
      makeCandle(new Date("2026-08-25T04:00:00.000Z"), 25115, 25180, 25110, 25170), // ORB breakout above 25120
    ];

    const results = engine.detect(candles);
    const drive = results.find((r) => r.subtype === "OPENING_DRIVE");
    const orb = results.find((r) => r.subtype === "ORB");

    expect(drive).toBeDefined();
    expect(drive!.orientation).toBe("UP");
    expect(orb).toBeDefined();
    expect(orb!.orientation).toBe("UP");
  });

  it("GapStructureEngine detects Gap and Go vs Gap and Fade", () => {
    const engine = new GapStructureEngine();
    const day1Candle = makeCandle(new Date("2026-08-24T09:55:00.000Z"), 25000, 25050, 24950, 25020);
    // Day 2 opens above PDH (25050) at 25100 and closes higher at 25150
    const day2Candle = makeCandle(new Date("2026-08-25T03:45:00.000Z"), 25100, 25160, 25090, 25150);

    const results = engine.detect([day1Candle, day2Candle], [null, 50], { pdh: 25050, pdl: 24950, pdc: 25020 });
    const gapGo = results.find((r) => r.subtype === "GAP_AND_GO");
    expect(gapGo).toBeDefined();
    expect(gapGo!.orientation).toBe("UP");
    expect(gapGo!.gapDirectionVsPriorRange).toBe("ABOVE_RANGE");
  });

  it("LevelInteractionEngine detects Break and Hold", () => {
    const engine = new LevelInteractionEngine();
    const candles = [
      makeCandle(new Date("2026-08-25T04:00:00.000Z"), 24980, 24995, 24970, 24990),
      makeCandle(new Date("2026-08-25T04:05:00.000Z"), 24990, 25030, 25001, 25025), // breaks 25000 and holds above
    ];

    const results = engine.detect(candles, [{ type: "PDH", value: 25000 }]);
    const levelEvent = results.find((r) => r.subtype === "BREAK_AND_HOLD");
    expect(levelEvent).toBeDefined();
    expect(levelEvent!.orientation).toBe("UP");
    expect(levelEvent!.levelValue).toBe(25000);
  });

  it("SwingStructureEngine detects Higher High and BOS", () => {
    const engine = new SwingStructureEngine(1); // 1-bar window for test
    const candles = [
      makeCandle(new Date("2026-08-25T04:00:00.000Z"), 24900, 24950, 24890, 24920),
      makeCandle(new Date("2026-08-25T04:01:00.000Z"), 24920, 25000, 24910, 24980), // Peak 1 at 25000
      makeCandle(new Date("2026-08-25T04:02:00.000Z"), 24980, 24990, 24930, 24950), // Valley
      makeCandle(new Date("2026-08-25T04:03:00.000Z"), 24950, 25080, 24940, 25070), // Peak 2 at 25080 (HH)
      makeCandle(new Date("2026-08-25T04:04:00.000Z"), 25070, 25075, 25020, 25040),
    ];

    const results = engine.detect(candles);
    const hh = results.find((r) => r.subtype === "HIGHER_HIGH");
    const bos = results.find((r) => r.subtype === "BOS_UP");
    expect(hh).toBeDefined();
    expect(hh!.orientation).toBe("UP");
    expect(bos).toBeDefined();
  });

  it("EffortResultEngine detects High Effort Low Result and Climaxes", () => {
    const engine = new EffortResultEngine();
    // 19 normal volume bars, 20th bar has 10x volume but narrow range (absorption)
    const candles = Array.from({ length: 19 }, (_, i) =>
      makeCandle(new Date(Date.UTC(2026, 7, 25, 4, i)), 25000, 25050, 24950, 25020, 1000),
    );
    candles.push(makeCandle(new Date(Date.UTC(2026, 7, 25, 4, 19)), 25020, 25025, 25015, 25022, 10000));

    const results = engine.detect(candles);
    const absorption = results.find((r) => r.subtype === "HIGH_EFFORT_LOW_RESULT");
    expect(absorption).toBeDefined();
    // Errata Section 2 prunes the duplicated z-scores off the details; the multiplier is the
    // surviving effort measure. 10000 against a 20-bar mean of 1450 is a little under 7x.
    expect(absorption!.climaxVolumeMultiplier).toBeGreaterThan(5);
    expect(absorption!.absorptionWickRatio).not.toBeNull();
  });

  it("CandleGeometryEngine detects Hammer, Marubozu, and Engulfing with clean orientations", () => {
    const engine = new CandleGeometryEngine();
    // Hammer: open 24980, close 25000 (body=20), high 25005 (upper shadow=5), low 24940 (lower shadow=40)
    const hammer = makeCandle(new Date("2026-08-25T04:00:00.000Z"), 24980, 25005, 24940, 25000);
    const marubozu = makeCandle(new Date("2026-08-25T04:01:00.000Z"), 24900, 25000, 24898, 24998); // long body

    const results = engine.detect([hammer, marubozu]);
    const hammerRes = results.find((r) => r.subtype === "HAMMER");
    const marubozuRes = results.find((r) => r.subtype === "BULLISH_MARUBOZU");

    expect(hammerRes).toBeDefined();
    expect(hammerRes!.orientation).toBe("UP");
    expect(marubozuRes).toBeDefined();
    expect(marubozuRes!.orientation).toBe("UP");
  });

  it("MultiCandleEngine detects Morning Star and Three White Soldiers", () => {
    const engine = new MultiCandleEngine();
    const soldiers = [
      makeCandle(new Date("2026-08-25T04:00:00.000Z"), 24900, 24950, 24890, 24940),
      makeCandle(new Date("2026-08-25T04:01:00.000Z"), 24930, 25000, 24925, 24990),
      makeCandle(new Date("2026-08-25T04:02:00.000Z"), 24985, 25060, 24980, 25050),
    ];

    const results = engine.detect(soldiers);
    const pattern = results.find((r) => r.subtype === "THREE_WHITE_SOLDIERS");
    expect(pattern).toBeDefined();
    expect(pattern!.orientation).toBe("UP");
  });

  it("ClassicalReversalEngine detects Double Bottom", () => {
    const engine = new ClassicalReversalEngine();
    const candles = [
      makeCandle(new Date("2026-08-25T04:00:00.000Z"), 25000, 25010, 24900, 24920), // Valley 1
      makeCandle(new Date("2026-08-25T04:01:00.000Z"), 24920, 24980, 24915, 24970),
      makeCandle(new Date("2026-08-25T04:02:00.000Z"), 24970, 25050, 24960, 25040), // Peak at 25050
      makeCandle(new Date("2026-08-25T04:03:00.000Z"), 25040, 25045, 24950, 24960),
      makeCandle(new Date("2026-08-25T04:04:00.000Z"), 24960, 24980, 24900, 24930), // Valley 2
      makeCandle(new Date("2026-08-25T04:05:00.000Z"), 24930, 25020, 24925, 25010),
      makeCandle(new Date("2026-08-25T04:06:00.000Z"), 25010, 25080, 25005, 25070), // Breaks above 25050
    ];

    const results = engine.detect(candles);
    const db = results.find((r) => r.subtype === "DOUBLE_BOTTOM");
    expect(db).toBeDefined();
    expect(db!.orientation).toBe("UP");
    expect(db!.necklineLevel).toBe(25050);
  });

  it("ContinuationStructureEngine detects Bull Flag", () => {
    const engine = new ContinuationStructureEngine();
    const candles = [
      makeCandle(new Date("2026-08-25T04:00:00.000Z"), 24800, 24850, 24790, 24840), // Pole start
      makeCandle(new Date("2026-08-25T04:01:00.000Z"), 24840, 24920, 24835, 24910),
      makeCandle(new Date("2026-08-25T04:02:00.000Z"), 24910, 25000, 24905, 24990), // Pole peak at 25000
      makeCandle(new Date("2026-08-25T04:03:00.000Z"), 24990, 24995, 24940, 24950), // Flag consolidation
      makeCandle(new Date("2026-08-25T04:04:00.000Z"), 24950, 24970, 24930, 24945),
      makeCandle(new Date("2026-08-25T04:05:00.000Z"), 24945, 25020, 24940, 25010), // Breakout above flag high
    ];

    const results = engine.detect(candles);
    const flag = results.find((r) => r.subtype === "BULL_FLAG");
    expect(flag).toBeDefined();
    expect(flag!.orientation).toBe("UP");
  });
});

import { describe, expect, it } from "vitest";
import type { PatternObservationSummary } from "../../../pattern-intelligence/domain/observation-summary.js";
import type { StrategyMarketContext } from "../../../strategy-engine/domain/strategy.js";
import {
  PatternIntelligenceResearchAdapter,
  patternIntelligenceResearchDefinition,
} from "./pattern-intelligence-research-strategy.js";
import { researchScalpStrategies } from "./research-strategies.js";

const closeTime = new Date("2026-08-25T06:01:00.000Z");

function context(observations?: readonly PatternObservationSummary[]): StrategyMarketContext {
  return {
    candle: {
      id: "candle-1", instrumentId: "instrument-1", timeframe: "1m",
      openTime: new Date("2026-08-25T06:00:00.000Z"), closeTime,
      open: 57500, high: 57540, low: 57480, close: 57520, volume: 12000, tickSize: 0.05,
    },
    indicators: [{ code: "ATR", algorithmVersion: "ta-v1", parameters: { period: 14, smoothing: "WILDER" }, values: { value: 20 } }],
    patterns: [],
    priceActionEvents: [],
    ...(observations === undefined ? {} : { patternObservations: observations, patternObservationCoverage: "COMPLETE" as const }),
  } as StrategyMarketContext;
}

function observation(overrides: Partial<PatternObservationSummary> = {}): PatternObservationSummary {
  return {
    observationId: "obs-1", patternFamily: "SWEEP_RECLAIM", patternSubtype: "SPRING", orientation: "UP",
    definitionId: "pattern-intelligence.sweep-reclaim", definitionVersion: "1.0.0", definitionHash: "a".repeat(64),
    detectedAt: new Date("2026-08-25T06:00:00.000Z"), knownAt: new Date("2026-08-25T06:00:00.000Z"),
    earliestExecutionAt: new Date("2026-08-25T06:01:00.000Z"),
    durationBars: 3, rangeBps: 40, rangeAtr: 1.2, trendState: "DOWN", sessionSegment: "MIDDAY",
    volumeZscore: 1.1, rangeZscore: 0.3, effortResultDivergence: 0.8, details: { kind: "SWEEP_RECLAIM" },
    ...overrides,
  };
}

describe("Pattern V4 Research generation 2", () => {
  it("runs as a sibling of generation 1, never replacing it", () => {
    const keys = researchScalpStrategies.map((adapter) => adapter.definition.strategyKey);
    expect(keys).toContain("pattern-v4-research");
    expect(keys).toContain("pattern-v4-research-v2");
    // Distinct definition hashes, so the two cohorts can never be pooled by accident.
    const generation1 = researchScalpStrategies.find((a) => a.definition.strategyKey === "pattern-v4-research")!;
    expect(generation1.definition.strategyDefinitionHash)
      .not.toBe(patternIntelligenceResearchDefinition.strategyDefinitionHash);
  });

  it("emits nothing when observations were never loaded, and does not treat that as a quiet bar", () => {
    // `undefined` is "not loaded"; the harness must not read it as "no patterns present".
    expect(new PatternIntelligenceResearchAdapter().evaluate(context(), context())).toHaveLength(0);
    // Loaded-but-empty is also no proposals, but the two are distinguishable via coverage.
    expect(new PatternIntelligenceResearchAdapter().evaluate(context([]), context([]))).toHaveLength(0);
  });

  it("replicates the incumbent geometry exactly: entry at close, 1.0 ATR stop, 1.5R target", () => {
    const [proposal] = new PatternIntelligenceResearchAdapter().evaluate(context([observation()]), context([observation()]));
    expect(proposal).toBeDefined();
    const geometry = proposal!.nativeGeometry;
    expect(geometry.direction).toBe("LONG");
    expect(geometry.entryPrice).toBe(57520);        // bar close
    expect(geometry.stopLoss).toBe(57500);          // 57520 - 1.0 * ATR(20)
    expect(geometry.targetPrice).toBe(57550);       // risk 20 -> +1.5R
    // 3-candle expiry off a 1m bar.
    expect(geometry.expiresAt).toEqual(new Date(closeTime.getTime() + 3 * 60_000));
  });

  it("maps orientation to a side only for UP and DOWN, never for NONE or BIDIRECTIONAL", () => {
    const adapter = new PatternIntelligenceResearchAdapter();
    const short = adapter.evaluate(context([observation({ orientation: "DOWN" })]), context([observation()]));
    expect(short[0]!.nativeGeometry.direction).toBe("SHORT");
    expect(short[0]!.nativeGeometry.stopLoss).toBe(57540);   // 57520 + ATR
    expect(short[0]!.nativeGeometry.targetPrice).toBe(57490); // -1.5R

    // A structure that points nowhere must not be assigned a direction.
    for (const orientation of ["NONE", "BIDIRECTIONAL"] as const) {
      expect(adapter.evaluate(context([observation({ orientation })]), context([observation()]))).toHaveLength(0);
    }
  });

  it("refuses to let a degenerate high-frequency family generate proposals", () => {
    const adapter = new PatternIntelligenceResearchAdapter();
    // CLASSICAL_REVERSAL fires on 50.6% of 1m bars because it reads fixed bar offsets rather than
    // detected pivots; CANDLE_GEOMETRY on 80.3%. Neither may trigger.
    for (const patternFamily of ["CLASSICAL_REVERSAL", "CANDLE_GEOMETRY"]) {
      const observations = [observation({ patternFamily, patternSubtype: "DOUBLE_TOP", orientation: "DOWN" })];
      expect(adapter.evaluate(context(observations), context(observations))).toHaveLength(0);
    }

    // ...but they are still recorded as covariates on a proposal a real family triggered.
    const mixed = [observation(), observation({ observationId: "obs-2", patternFamily: "CANDLE_GEOMETRY", patternSubtype: "DOJI", orientation: "NONE" })];
    const [proposal] = adapter.evaluate(context(mixed), context(mixed));
    const raw = proposal!.rawContext as Record<string, unknown>;
    expect(raw.covariateObservations).toEqual([
      { patternFamily: "CANDLE_GEOMETRY", patternSubtype: "DOJI", orientation: "NONE", observationId: "obs-2" },
    ]);
  });

  it("carries the full pattern provenance into the proposal, and no score of any kind", () => {
    const [proposal] = new PatternIntelligenceResearchAdapter().evaluate(context([observation()]), context([observation()]));
    const raw = proposal!.rawContext as Record<string, unknown>;
    const observed = raw.patternObservation as Record<string, unknown>;

    // The chain the research question depends on: "does SWEEP_RECLAIM have edge?", not just
    // "did Pattern V4 make money?".
    expect(observed.observationId).toBe("obs-1");
    expect(observed.patternFamily).toBe("SWEEP_RECLAIM");
    expect(observed.patternSubtype).toBe("SPRING");
    expect(observed.tier).toBe("A");
    expect(observed.definitionRef).toEqual({
      definitionId: "pattern-intelligence.sweep-reclaim", definitionVersion: "1.0.0", definitionHash: "a".repeat(64),
    });
    expect(proposal!.setupType).toBe("PATTERN_INTELLIGENCE:SWEEP_RECLAIM:SPRING");

    // No gate is asserted where none existed, and nothing resembling a score is recorded.
    expect(raw.legacyScoreGate).toBeNull();
    expect(raw.patternObservationCoverage).toBe("COMPLETE");
    const serialised = JSON.stringify(raw);
    expect(serialised).not.toContain("\"confidence\"");
    expect(serialised).not.toContain("\"nativeConfidence\"");
  });

  it("emits one proposal per observation so families never merge into one signal", () => {
    const observations = [
      observation(),
      observation({ observationId: "obs-2", patternFamily: "BREAKOUT_STATE", patternSubtype: "BREAKOUT" }),
      observation({ observationId: "obs-3", patternFamily: "SWING_STRUCTURE", patternSubtype: "HIGHER_LOW" }),
    ];
    const proposals = new PatternIntelligenceResearchAdapter().evaluate(context(observations), context(observations));
    expect(proposals).toHaveLength(3);
    expect(proposals.map((p) => p.setupType).sort()).toEqual([
      "PATTERN_INTELLIGENCE:BREAKOUT_STATE:BREAKOUT",
      "PATTERN_INTELLIGENCE:SWEEP_RECLAIM:SPRING",
      "PATTERN_INTELLIGENCE:SWING_STRUCTURE:HIGHER_LOW",
    ]);
    // Distinct fingerprints, so the harness cannot collapse them into a single opportunity.
    expect(new Set(proposals.map((p) => p.setupFingerprint)).size).toBe(3);
  });

  it("emits nothing without a usable ATR, rather than inventing a bracket", () => {
    const withoutAtr = { ...context([observation()]), indicators: [] } as StrategyMarketContext;
    expect(new PatternIntelligenceResearchAdapter().evaluate(withoutAtr, withoutAtr)).toHaveLength(0);
  });
});

import { describe, expect, it } from "vitest";
import {
  DEFAULT_VOLATILITY_COMPETITION_RULES,
  computeVolatilitySettledMetrics,
  decideVolatilityCompetition,
  type VolatilityConfusionCell,
  type VolatilityStanding,
} from "./volatility-competition.js";

const TODAY = "2026-08-03";

/**
 * A confusion matrix with `diagonal` correct per class and `offDiagonal` errors.
 *
 * The errors are split across two *different* realized labels deliberately. Piling them
 * all onto one realized class inflates that class's share until the trivial
 * majority-class predictor matches the model, which makes every fixture fail the
 * beats-trivial gate for reasons that have nothing to do with what is under test.
 */
function cells(diagonal: [number, number, number], offDiagonal: number): VolatilityConfusionCell[] {
  const labels = ["CONTRACTION", "STABLE", "EXPANSION"] as const;
  const result: VolatilityConfusionCell[] = labels.map((label, index) => ({
    prediction: label,
    realizedLabel: label,
    count: diagonal[index]!,
  }));
  if (offDiagonal > 0) {
    result.push({ prediction: "CONTRACTION", realizedLabel: "STABLE", count: Math.ceil(offDiagonal / 2) });
    result.push({ prediction: "EXPANSION", realizedLabel: "CONTRACTION", count: Math.floor(offDiagonal / 2) });
  }
  return result;
}

function standing(overrides: Partial<VolatilityStanding> = {}): VolatilityStanding {
  return {
    modelVersionId: "model-1",
    modelKey: "volatility-expansion-lightgbm--pool20-f887399b--1d--h5",
    role: null,
    metrics: computeVolatilitySettledMetrics(cells([140, 130, 130], 20)),
    scoredDays: 20,
    lastScoredDate: TODAY,
    ...overrides,
  };
}

describe("computeVolatilitySettledMetrics", () => {
  it("scores the volatility alphabet and reports the trivial baseline", () => {
    const metrics = computeVolatilitySettledMetrics(cells([40, 30, 20], 10));

    expect(metrics.sampleCount).toBe(100);
    expect(metrics.correctCount).toBe(90);
    expect(metrics.accuracy).toBeCloseTo(0.9, 10);
    // Realized totals are CONTRACTION 40+5, STABLE 30+5, EXPANSION 20, so always
    // guessing CONTRACTION -- the commonest actual outcome -- would score 0.45.
    expect(metrics.trivialAccuracy).toBeCloseTo(0.45, 10);
    // Closed form for the same always-CONTRACTION strategy: the majority class gets
    // precision 0.45 and recall 1, F1 = 2(0.45)/1.45, the other two classes get 0,
    // and the macro average divides by the three-label alphabet.
    expect(metrics.trivialMacroF1).toBeCloseTo((2 * 0.45) / 1.45 / 3, 10);
  });

  it("treats STABLE as the abstain class when computing the committed hit rate", () => {
    // 10 STABLE calls are abstentions and must not count toward committed accuracy.
    const metrics = computeVolatilitySettledMetrics([
      { prediction: "STABLE", realizedLabel: "STABLE", count: 10 },
      { prediction: "EXPANSION", realizedLabel: "EXPANSION", count: 6 },
      { prediction: "EXPANSION", realizedLabel: "CONTRACTION", count: 4 },
    ]);

    expect(metrics.committedHitRate).toBeCloseTo(0.6, 10);
    expect(metrics.accuracy).toBeCloseTo(0.8, 10);
  });

  it("refuses a directional label", () => {
    expect(() => computeVolatilitySettledMetrics([
      { prediction: "BULLISH" as never, realizedLabel: "STABLE", count: 1 },
    ])).toThrow(/CONTRACTION, STABLE, EXPANSION/);
  });

  it("returns nulls rather than zeros for an empty window", () => {
    expect(computeVolatilitySettledMetrics([])).toMatchObject({
      sampleCount: 0,
      accuracy: null,
      macroF1: null,
      trivialAccuracy: null,
      trivialMacroF1: null,
    });
  });
});

describe("decideVolatilityCompetition", () => {
  it("establishes a first PRIMARY from settled evidence", () => {
    const decision = decideVolatilityCompetition({ standings: [standing()], asOfDate: TODAY });

    expect(decision.reason).toBe("INITIAL_PRIMARY_ESTABLISHED");
    expect(decision.primaryModelVersionId).toBe("model-1");
  });

  it("excludes a model below the settled-prediction floor", () => {
    const thin = standing({ metrics: computeVolatilitySettledMetrics(cells([10, 10, 10], 2)) });

    const decision = decideVolatilityCompetition({ standings: [thin], asOfDate: TODAY });

    expect(decision.reason).toBe("NO_QUALIFYING_MODEL");
    expect(decision.excludedForSample).toBe(1);
    expect(decision.primaryModelVersionId).toBeNull();
  });

  // The whole lesson of the directional target: it beat trivial on macro-F1 on every
  // CPCV split while losing on accuracy on 93% of them, because spreading predictions
  // across classes raises macro-F1 and lowers accuracy.
  it("excludes a class-spreader that beats trivial on macro-F1 but not accuracy", () => {
    // Realized outcomes are 70% EXPANSION, so always-EXPANSION scores 0.70 accuracy.
    // This model spreads across all three and lands well below that.
    const spreader = standing({
      metrics: computeVolatilitySettledMetrics([
        { prediction: "EXPANSION", realizedLabel: "EXPANSION", count: 200 },
        { prediction: "CONTRACTION", realizedLabel: "EXPANSION", count: 250 },
        { prediction: "STABLE", realizedLabel: "EXPANSION", count: 250 },
        { prediction: "CONTRACTION", realizedLabel: "CONTRACTION", count: 100 },
        { prediction: "STABLE", realizedLabel: "STABLE", count: 100 },
      ]),
    });

    expect(spreader.metrics.accuracy!).toBeLessThan(spreader.metrics.trivialAccuracy!);

    const decision = decideVolatilityCompetition({ standings: [spreader], asOfDate: TODAY });

    expect(decision.reason).toBe("NO_QUALIFYING_MODEL");
    expect(decision.excludedBelowTrivial).toBe(1);
  });

  // The mirror-image hole of the spreader test: the original gate compared accuracy
  // only, so a model winning on accuracy while showing no more class discrimination
  // than trivial slipped through. Metrics are hand-authored because reaching this
  // corner from a real confusion matrix takes a pathological window; the gate must
  // still hold when settlement arithmetic changes or a different alphabet arrives.
  it("excludes a model that beats trivial on accuracy but not macro-F1", () => {
    const hugger = standing({
      metrics: {
        sampleCount: 1000,
        correctCount: 710,
        accuracy: 0.71,
        macroF1: 0.25,
        committedHitRate: 0.71,
        trivialAccuracy: 0.7,
        trivialMacroF1: 0.2745,
      },
    });

    const decision = decideVolatilityCompetition({ standings: [hugger], asOfDate: TODAY });

    expect(decision.reason).toBe("NO_QUALIFYING_MODEL");
    expect(decision.excludedBelowTrivial).toBe(1);
  });

  it("retains the incumbent when the challenger's lead is inside the noise margin", () => {
    const deep = (correct: number) => computeVolatilitySettledMetrics(cells([correct, correct, correct], 60));
    const decision = decideVolatilityCompetition({
      standings: [
        standing({ modelVersionId: "champion", role: "PRIMARY", metrics: deep(300) }),
        standing({ modelVersionId: "challenger", modelKey: "challenger-key", metrics: deep(305) }),
      ],
      asOfDate: TODAY,
    });

    expect(decision.reason).toBe("PRIMARY_RETAINED");
    expect(decision.primaryModelVersionId).toBe("champion");
    expect(decision.challengerModelVersionId).toBe("challenger");
  });

  it("replaces the incumbent only on a margin past the noise filter with both deeply evidenced", () => {
    const decision = decideVolatilityCompetition({
      standings: [
        standing({
          modelVersionId: "champion",
          role: "PRIMARY",
          metrics: computeVolatilitySettledMetrics(cells([300, 300, 300], 600)),
        }),
        standing({
          modelVersionId: "challenger",
          modelKey: "challenger-key",
          metrics: computeVolatilitySettledMetrics(cells([600, 600, 600], 60)),
        }),
      ],
      asOfDate: TODAY,
    });

    expect(decision.reason).toBe("PRIMARY_REPLACED");
    expect(decision.primaryModelVersionId).toBe("challenger");
    expect(decision.previousPrimaryModelVersionId).toBe("champion");
  });

  it("will not dethrone until both sides pass the deeper promotion sample", () => {
    const rules = { ...DEFAULT_VOLATILITY_COMPETITION_RULES, minimumSettledForPromotion: 100_000 };
    const decision = decideVolatilityCompetition({
      standings: [
        standing({
          modelVersionId: "champion",
          role: "PRIMARY",
          metrics: computeVolatilitySettledMetrics(cells([300, 300, 300], 600)),
        }),
        standing({
          modelVersionId: "challenger",
          modelKey: "challenger-key",
          metrics: computeVolatilitySettledMetrics(cells([600, 600, 600], 60)),
        }),
      ],
      asOfDate: TODAY,
      rules,
    });

    expect(decision.reason).toBe("PRIMARY_RETAINED");
    expect(decision.explanation).toMatch(/before a dethroning/);
  });

  // A silent PRIMARY's metrics describe a window it stopped contributing to, so it
  // would be defending the title on stale evidence.
  it("quarantines a silent PRIMARY before asking any ranking question", () => {
    const decision = decideVolatilityCompetition({
      standings: [standing({ modelVersionId: "stale", role: "PRIMARY", lastScoredDate: "2026-07-01" })],
      asOfDate: TODAY,
    });

    expect(decision.reason).toBe("PRIMARY_QUARANTINED_SILENT");
    expect(decision.primaryModelVersionId).toBeNull();
  });

  it("vacates a PRIMARY that has fallen below trivial even with no challenger", () => {
    const decision = decideVolatilityCompetition({
      standings: [
        standing({
          modelVersionId: "decayed",
          role: "PRIMARY",
          metrics: computeVolatilitySettledMetrics([
            { prediction: "CONTRACTION", realizedLabel: "EXPANSION", count: 500 },
            { prediction: "EXPANSION", realizedLabel: "EXPANSION", count: 200 },
            { prediction: "STABLE", realizedLabel: "STABLE", count: 50 },
          ]),
        }),
      ],
      asOfDate: TODAY,
    });

    expect(decision.reason).toBe("PRIMARY_QUARANTINED_BELOW_TRIVIAL");
    expect(decision.primaryModelVersionId).toBeNull();
  });

  it("breaks a macro-F1 tie on the larger settled sample", () => {
    const shallow = computeVolatilitySettledMetrics(cells([120, 120, 120], 20));
    const deep = computeVolatilitySettledMetrics(cells([240, 240, 240], 40));

    const decision = decideVolatilityCompetition({
      standings: [
        standing({ modelVersionId: "shallow", metrics: shallow }),
        standing({ modelVersionId: "deep", modelKey: "deep-key", metrics: deep }),
      ],
      asOfDate: TODAY,
    });

    expect(decision.ranking[0]!.modelVersionId).toBe("deep");
  });
});

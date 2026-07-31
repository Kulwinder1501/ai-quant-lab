import { describe, expect, it } from "vitest";
import {
  computeSettledMetrics,
  decideCompetition,
  DEFAULT_COMPETITION_RULES,
  type ConfusionCell,
  type PoolMemberStanding,
} from "./model-competition.js";

describe("computeSettledMetrics", () => {
  it("returns nulls for an empty confusion matrix", () => {
    expect(computeSettledMetrics([])).toEqual({
      sampleCount: 0,
      correctCount: 0,
      accuracy: null,
      macroF1: null,
      directionalHitRate: null,
      trivialAccuracy: null,
    });
  });

  it("matches hand-computed sklearn-style macro F1 over the three classes", () => {
    const cells: ConfusionCell[] = [
      { prediction: "BULLISH", realizedLabel: "BULLISH", count: 3 },
      { prediction: "BULLISH", realizedLabel: "NEUTRAL", count: 1 },
      { prediction: "NEUTRAL", realizedLabel: "NEUTRAL", count: 4 },
      { prediction: "BEARISH", realizedLabel: "BULLISH", count: 2 },
    ];
    const metrics = computeSettledMetrics(cells);
    expect(metrics.sampleCount).toBe(10);
    expect(metrics.correctCount).toBe(7);
    expect(metrics.accuracy).toBeCloseTo(0.7, 10);
    // BULLISH F1 = 2*3/(4+5) = 2/3; BEARISH F1 = 0/(2+0) = 0; NEUTRAL F1 = 2*4/(4+5) = 8/9.
    expect(metrics.macroF1).toBeCloseTo((2 / 3 + 0 + 8 / 9) / 3, 10);
    // Directional commits: 4 BULLISH + 2 BEARISH = 6, of which 3 were right.
    expect(metrics.directionalHitRate).toBeCloseTo(0.5, 10);
  });
});

function standing(
  id: string,
  role: PoolMemberStanding["role"],
  rollingMacroF1: number | null,
  sampleCount: number,
  dailyMacroF1: Record<string, number>,
  // Defaults to a baseline nothing can lose to, so cases about the promotion rules are
  // not silently also testing the trivial-accuracy gate.
  trivialAccuracy = 0,
): PoolMemberStanding {
  return {
    modelVersionId: id,
    role,
    rolling: {
      sampleCount,
      correctCount: Math.round(sampleCount / 2),
      accuracy: rollingMacroF1,
      macroF1: rollingMacroF1,
      directionalHitRate: rollingMacroF1,
      trivialAccuracy,
    },
    dailyMacroF1,
  };
}

/** Seven consecutive scored days where the challenger wins `challengerWins` of them. */
function sevenDays(primaryScore: number, challengerScore: number, challengerWins: number): {
  primary: Record<string, number>;
  challenger: Record<string, number>;
} {
  const primary: Record<string, number> = {};
  const challenger: Record<string, number> = {};
  for (let day = 1; day <= 7; day += 1) {
    const date = `2026-07-${String(20 + day).padStart(2, "0")}`;
    primary[date] = primaryScore;
    challenger[date] = day <= challengerWins ? primaryScore + 0.1 : primaryScore - 0.1;
    void challengerScore;
  }
  return { primary, challenger };
}

describe("decideCompetition", () => {
  it("promotes the challenger after 6 of 7 daily wins and a 2-SE rolling margin", () => {
    const days = sevenDays(0.4, 0.5, 6);
    const decision = decideCompetition([
      standing("champ", "PRIMARY", 0.4, 300, days.primary),
      standing("challenger", "COMPETITOR", 0.5, 300, days.challenger),
    ]);
    expect(decision.promotion).toMatchObject({
      newPrimaryId: "challenger",
      previousPrimaryId: "champ",
      winsInWindow: 6,
      comparedDays: 7,
    });
    expect(decision.assignments).toContainEqual(
      expect.objectContaining({ modelVersionId: "challenger", role: "PRIMARY" }),
    );
    // The dethroned champion stays in the pool as SECONDARY.
    expect(decision.assignments).toContainEqual(
      expect.objectContaining({ modelVersionId: "champ", role: "SECONDARY" }),
    );
  });

  it("does not promote on rolling score alone when daily wins fall short", () => {
    const days = sevenDays(0.4, 0.6, 5);
    const decision = decideCompetition([
      standing("champ", "PRIMARY", 0.4, 300, days.primary),
      standing("challenger", "COMPETITOR", 0.6, 300, days.challenger),
    ]);
    expect(decision.promotion).toBeNull();
    expect(decision.headToHead).toMatchObject({ challengerId: "challenger", winsInWindow: 5 });
    expect(decision.assignments).toContainEqual(
      expect.objectContaining({ modelVersionId: "champ", role: "PRIMARY" }),
    );
    expect(decision.assignments).toContainEqual(
      expect.objectContaining({ modelVersionId: "challenger", role: "SECONDARY" }),
    );
  });

  it("does not promote when the rolling margin is inside the noise band", () => {
    const days = sevenDays(0.4, 0.41, 7);
    const decision = decideCompetition([
      standing("champ", "PRIMARY", 0.4, 300, days.primary),
      standing("challenger", "COMPETITOR", 0.4 + DEFAULT_COMPETITION_RULES.promotionMargin - 0.001, 300, days.challenger),
    ]);
    expect(decision.promotion).toBeNull();
  });

  it("does not promote before both sides have promotion-grade sample sizes", () => {
    // 100 settled ranks a model, but SE(macro-F1 diff) at that size swamps the margin,
    // so a dethroning needs the full promotion sample even with perfect daily wins.
    const days = sevenDays(0.3, 0.6, 7);
    const decision = decideCompetition([
      standing("champ", "PRIMARY", 0.3, 100, days.primary),
      standing("challenger", "COMPETITOR", 0.6, 100, days.challenger),
    ]);
    expect(decision.promotion).toBeNull();
    expect(decision.headToHead).toMatchObject({ challengerId: "challenger", winsInWindow: 7 });
  });

  it("does not promote without a full head-to-head window of common scored days", () => {
    const decision = decideCompetition([
      standing("champ", "PRIMARY", 0.4, 100, { "2026-07-21": 0.4, "2026-07-22": 0.4 }),
      standing("challenger", "COMPETITOR", 0.6, 100, { "2026-07-21": 0.6, "2026-07-22": 0.6 }),
    ]);
    expect(decision.promotion).toBeNull();
    expect(decision.headToHead).toMatchObject({ comparedDays: 2, winsInWindow: 2 });
  });

  it("ignores challengers without enough settled predictions", () => {
    const days = sevenDays(0.4, 0.6, 7);
    const decision = decideCompetition([
      standing("champ", "PRIMARY", 0.4, 100, days.primary),
      standing("thin", "COMPETITOR", 0.6, 10, days.challenger),
    ]);
    expect(decision.promotion).toBeNull();
    expect(decision.assignments).toContainEqual(
      expect.objectContaining({ modelVersionId: "thin", role: "COMPETITOR" }),
    );
  });

  it("crowns the best eligible model as first PRIMARY when the group has none", () => {
    const decision = decideCompetition([
      standing("a", "COMPETITOR", 0.45, 100, {}),
      standing("b", "COMPETITOR", 0.5, 100, {}),
      standing("c", "COMPETITOR", null, 0, {}),
    ]);
    // The initial crowning is a promotion with no previous champion.
    expect(decision.promotion).toMatchObject({
      newPrimaryId: "b",
      previousPrimaryId: null,
      challengerRollingMacroF1: 0.5,
    });
    expect(decision.assignments).toContainEqual(expect.objectContaining({ modelVersionId: "b", role: "PRIMARY" }));
    expect(decision.assignments).toContainEqual(expect.objectContaining({ modelVersionId: "a", role: "SECONDARY" }));
    expect(decision.assignments).toContainEqual(expect.objectContaining({ modelVersionId: "c", role: "COMPETITOR" }));
  });

  it("crowns nobody while no member has enough live evidence", () => {
    const decision = decideCompetition([
      standing("a", "COMPETITOR", 0.6, 10, {}),
      standing("b", "COMPETITOR", null, 0, {}),
    ]);
    expect(decision.promotion).toBeNull();
    expect(decision.assignments.every((assignment) => assignment.role === "COMPETITOR")).toBe(true);
  });
  it("scores the trivial majority-class baseline alongside accuracy", () => {
    // 60 BULLISH / 25 BEARISH / 15 NEUTRAL outcomes: always guessing BULLISH gets 60%.
    const metrics = computeSettledMetrics([
      { prediction: "BULLISH", realizedLabel: "BULLISH", count: 30 },
      { prediction: "BEARISH", realizedLabel: "BULLISH", count: 30 },
      { prediction: "BULLISH", realizedLabel: "BEARISH", count: 25 },
      { prediction: "NEUTRAL", realizedLabel: "NEUTRAL", count: 15 },
    ]);

    // Read from realized outcomes, not from what the model predicted.
    expect(metrics.trivialAccuracy).toBeCloseTo(0.6, 10);
    expect(metrics.accuracy).toBeCloseTo(0.45, 10);
  });

  it("refuses to promote a challenger that loses to the trivial predictor", () => {
    // The spreader problem: macro-F1 clears the margin by a mile, accuracy does not clear
    // always-guessing-the-commonest-outcome. Ranking on macro-F1 alone would crown it.
    const days = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`2026-07-${10 + i}`, 0.9]));
    const primaryDays = Object.fromEntries(Object.keys(days).map((day) => [day, 0.1]));

    const challenger = standing("challenger", "COMPETITOR", 0.9, 400, days, /* trivialAccuracy */ 0.95);
    const primary = standing("primary", "PRIMARY", 0.1, 400, primaryDays, 0.05);

    const decision = decideCompetition([primary, challenger]);

    expect(decision.promotion).toBeNull();
    // Still visible as the leading challenger — it just cannot take the title.
    expect(decision.headToHead).toMatchObject({ challengerId: "challenger", winsInWindow: 7 });
    expect(decision.assignments).toContainEqual(
      expect.objectContaining({ modelVersionId: "primary", role: "PRIMARY" }));
  });

  it("does not crown a bootstrap champion that loses to the trivial predictor", () => {
    // No incumbent, but an empty title beats one held by something worse than guessing.
    const decision = decideCompetition([
      standing("a", "COMPETITOR", 0.6, 300, {}, 0.99),
      standing("b", "COMPETITOR", 0.5, 300, {}, 0.99),
    ]);

    expect(decision.promotion).toBeNull();
    expect(decision.assignments.every((assignment) => assignment.role === "COMPETITOR")).toBe(true);
  });

  it("stands down a champion that has gone silent, so the pool can re-crown", () => {
    // Every promotion condition compares against the champion, so a PRIMARY producing
    // nothing used to be unremovable: head-to-head had no common days and its sample count
    // could never reach the promotion floor. This project has already orphaned two
    // PRODUCTION models with a feature-schema bump.
    const silent = standing("silent", "PRIMARY", null, 0, {});
    const alive = standing("alive", "COMPETITOR", 0.5, 300, { "2026-07-10": 0.5 });

    const decision = decideCompetition([silent, alive]);

    expect(decision.demotedSilentPrimaryId).toBe("silent");
    expect(decision.promotion).toMatchObject({ newPrimaryId: "alive", previousPrimaryId: null });
    expect(decision.assignments).toContainEqual(
      expect.objectContaining({ modelVersionId: "alive", role: "PRIMARY" }));
    // Not archived — it stays in the pool and can win the title back once it predicts again.
    expect(decision.assignments).toContainEqual(
      expect.objectContaining({ modelVersionId: "silent", role: "COMPETITOR" }));
  });

  it("keeps a merely quiet champion, distinguishing low volume from silence", () => {
    // Below the ranking floor but still producing: that is handled by eligibility, not by
    // standing the champion down.
    const quiet = standing("quiet", "PRIMARY", 0.4, 10, { "2026-07-10": 0.4 });
    const decision = decideCompetition([quiet, standing("other", "COMPETITOR", 0.5, 300, {})]);

    expect(decision.demotedSilentPrimaryId).toBeNull();
    expect(decision.assignments).toContainEqual(
      expect.objectContaining({ modelVersionId: "quiet", role: "PRIMARY" }));
  });
});

import { describe, expect, it } from "vitest";
import {
  effectiveSampleSize,
  impliedPromotionMargin,
  intraclassCorrelation,
  MINIMUM_BOOTSTRAP_SESSIONS,
  pairedSessionBootstrap,
  sessionBlockBootstrap,
  toConfusionCounts,
  type ConfusionCount,
  type SettledRow,
} from "./effective-sample-size.js";

/**
 * Every fixture here is one whose answer can be derived by hand, because the live data cannot
 * validate this yet: on 2026-08-10 the whole volatility scheme had settled on a single session, so
 * an end-to-end run can only exercise the refusal paths. These tests are the correctness evidence.
 */

/** `correct` rows predict what happened; `wrong` rows predict something else. */
function rows(session: string, correct: number, wrong: number): SettledRow[] {
  const built: SettledRow[] = [];
  for (let index = 0; index < correct; index += 1) {
    built.push({ session, prediction: "EXPANSION", realizedLabel: "EXPANSION" });
  }
  for (let index = 0; index < wrong; index += 1) {
    built.push({ session, prediction: "EXPANSION", realizedLabel: "STABLE" });
  }
  return built;
}

/** Pooled accuracy, as the statistic under resampling. */
function accuracy(counts: readonly ConfusionCount[]): number | null {
  const total = counts.reduce((sum, cell) => sum + cell.count, 0);
  if (total === 0) return null;
  const hits = counts
    .filter((cell) => cell.prediction === cell.realizedLabel)
    .reduce((sum, cell) => sum + cell.count, 0);
  return hits / total;
}

describe("intraclassCorrelation", () => {
  it("reports rho 0 when every session has the same correctness rate", () => {
    // Ten sessions of four rows, each exactly half right. Between-session variance is zero, so
    // ANOVA returns a negative estimate (-1/3 here) which clamps to 0: evidence against
    // clustering, not evidence of anti-correlation.
    const sample = Array.from({ length: 10 }, (_, index) => rows(`d${index}`, 2, 2)).flat();

    const icc = intraclassCorrelation(sample);

    expect(icc.rho).toBe(0);
    expect(icc.clusters).toBe(10);
    expect(icc.rows).toBe(40);
    expect(icc.meanClusterSize).toBe(4);
  });

  it("reports rho 1 when correctness is decided entirely by the session", () => {
    // Five sessions all-right, five all-wrong, five rows each. Within-session variance is exactly
    // zero, so every row in a session carries the same information as its neighbours.
    const allRight = Array.from({ length: 5 }, (_, index) => rows(`r${index}`, 5, 0)).flat();
    const allWrong = Array.from({ length: 5 }, (_, index) => rows(`w${index}`, 0, 5)).flat();

    const icc = intraclassCorrelation([...allRight, ...allWrong]);

    expect(icc.rho).toBeCloseTo(1, 10);
    expect(icc.rows).toBe(50);
    expect(icc.clusters).toBe(10);
  });

  it("refuses fewer than two sessions instead of returning a number", () => {
    const icc = intraclassCorrelation(rows("only-day", 12, 8));

    expect(icc.rho).toBeNull();
    expect(icc.refusal).toMatch(/at least 2 sessions/);
  });

  it("refuses when every session holds one row, because there is no within-session variance", () => {
    const singles = Array.from({ length: 20 }, (_, index) => rows(`d${index}`, index % 2, 1 - (index % 2))).flat();

    const icc = intraclassCorrelation(singles);

    expect(icc.rho).toBeNull();
    expect(icc.refusal).toMatch(/single-instrument/);
  });

  it("refuses when correctness never varies at all", () => {
    const alwaysRight = Array.from({ length: 10 }, (_, index) => rows(`d${index}`, 5, 0)).flat();

    const icc = intraclassCorrelation(alwaysRight);

    expect(icc.rho).toBeNull();
    expect(icc.refusal).toMatch(/no variance exists/);
  });
});

describe("effectiveSampleSize", () => {
  it("leaves rows undiscounted when they are uncorrelated", () => {
    const sample = Array.from({ length: 10 }, (_, index) => rows(`d${index}`, 2, 2)).flat();

    const ess = effectiveSampleSize(sample);

    expect(ess.designEffect).toBeCloseTo(1, 10);
    expect(ess.effectiveSampleSize).toBeCloseTo(40, 10);
  });

  it("collapses a fully clustered pool to its session count", () => {
    // The headline case for the promotion margin: 50 rows across 10 sessions at rho = 1 are worth
    // 10 observations, not 50. A margin sized on the row count is then far too narrow.
    const allRight = Array.from({ length: 5 }, (_, index) => rows(`r${index}`, 5, 0)).flat();
    const allWrong = Array.from({ length: 5 }, (_, index) => rows(`w${index}`, 0, 5)).flat();

    const ess = effectiveSampleSize([...allRight, ...allWrong]);

    expect(ess.designEffect).toBeCloseTo(5, 10);
    expect(ess.effectiveSampleSize).toBeCloseTo(10, 10);
    expect(ess.effectiveSampleSize).toBe(ess.sessions);
  });

  it("never reports fewer effective observations than sessions", () => {
    const mixed = [
      ...rows("d0", 8, 0), ...rows("d1", 0, 8), ...rows("d2", 7, 1),
      ...rows("d3", 1, 7), ...rows("d4", 8, 0), ...rows("d5", 0, 8),
    ];

    const ess = effectiveSampleSize(mixed);

    expect(ess.effectiveSampleSize).toBeGreaterThanOrEqual(ess.sessions);
  });
});

describe("sessionBlockBootstrap", () => {
  const varied = Array.from({ length: 12 }, (_, index) => rows(`d${index}`, index, 12 - index)).flat();

  it("is reproducible from its seed", () => {
    const first = sessionBlockBootstrap(varied, accuracy, { resamples: 300, seed: 42 });
    const second = sessionBlockBootstrap(varied, accuracy, { resamples: 300, seed: 42 });

    expect(first.standardError).toBe(second.standardError);
    expect(first.percentile025).toBe(second.percentile025);
  });

  it("gives a different answer for a different seed, so the seed is doing something", () => {
    const first = sessionBlockBootstrap(varied, accuracy, { resamples: 300, seed: 1 });
    const second = sessionBlockBootstrap(varied, accuracy, { resamples: 300, seed: 2 });

    expect(first.standardError).not.toBe(second.standardError);
  });

  it("is invariant to the order rows arrive in", () => {
    const shuffled = [...varied].reverse();

    const forward = sessionBlockBootstrap(varied, accuracy, { resamples: 300, seed: 7 });
    const backward = sessionBlockBootstrap(shuffled, accuracy, { resamples: 300, seed: 7 });

    expect(forward.standardError).toBeCloseTo(backward.standardError!, 12);
  });

  it("brackets the sample statistic inside its own percentile interval", () => {
    const result = sessionBlockBootstrap(varied, accuracy, { resamples: 500, seed: 3 });
    const observed = accuracy(toConfusionCounts(varied))!;

    expect(result.percentile025!).toBeLessThanOrEqual(observed);
    expect(result.percentile975!).toBeGreaterThanOrEqual(observed);
  });

  it("refuses below the session floor rather than reporting false precision", () => {
    const thin = Array.from({ length: 4 }, (_, index) => rows(`d${index}`, 3, 1)).flat();

    const result = sessionBlockBootstrap(thin, accuracy);

    expect(result.standardError).toBeNull();
    expect(result.resamples).toBe(0);
    expect(result.refusal).toMatch(new RegExp(`at least ${MINIMUM_BOOTSTRAP_SESSIONS} scored sessions`));
  });
});

describe("pairedSessionBootstrap", () => {
  /*
   * The point of pairing. Both models score the same sessions, and the difference between them is
   * constant at 0.1 on every session by construction -- model B gets exactly one fewer row right
   * out of ten. Pooled over any resample of sessions the difference is still exactly 0.1, so the
   * paired standard error is zero, while each model's *own* accuracy varies with which sessions
   * were drawn and has a clearly positive standard error.
   *
   * Composing the two individual errors as `sqrt(2) * SE`, which is what the original 0.088
   * derivation did, would report substantial uncertainty about a quantity that never moves.
   */
  const sessionIds = Array.from({ length: 12 }, (_, index) => `d${index}`);
  const modelA = sessionIds.flatMap((id, index) => rows(id, index % 9 + 1, 10 - (index % 9 + 1)));
  const modelB = sessionIds.flatMap((id, index) => rows(id, index % 9, 10 - (index % 9)));

  it("measures a constant difference as having no uncertainty", () => {
    const paired = pairedSessionBootstrap(modelA, modelB, accuracy, { resamples: 400, seed: 11 });

    expect(paired.standardError).toBeCloseTo(0, 12);
    expect(paired.commonSessions).toBe(12);
    expect(paired.droppedSessions).toBe(0);
  });

  it("is far tighter than composing the two models' individual standard errors", () => {
    const paired = pairedSessionBootstrap(modelA, modelB, accuracy, { resamples: 400, seed: 11 });
    const soloA = sessionBlockBootstrap(modelA, accuracy, { resamples: 400, seed: 11 });
    const naive = Math.SQRT2 * soloA.standardError!;

    expect(soloA.standardError!).toBeGreaterThan(0.01);
    expect(paired.standardError!).toBeLessThan(naive);
  });

  it("uses only sessions both models scored, and says how many it dropped", () => {
    const shortB = modelB.filter((row) => row.session !== "d11" && row.session !== "d10");

    const paired = pairedSessionBootstrap(modelA, shortB, accuracy, { resamples: 200, seed: 5 });

    expect(paired.commonSessions).toBe(10);
    expect(paired.droppedSessions).toBe(2);
  });

  it("refuses when the models barely overlap", () => {
    const disjoint = rows("other-day", 5, 5);

    const paired = pairedSessionBootstrap(modelA, disjoint, accuracy, { seed: 5 });

    expect(paired.standardError).toBeNull();
    expect(paired.refusal).toMatch(/both models\s+scored/);
  });
});

describe("impliedPromotionMargin", () => {
  it("is two standard errors, rounded up so it is never weaker than the measurement", () => {
    expect(impliedPromotionMargin(0.044)).toBe(0.088);
    // 2 * 0.0301 = 0.0602 -> 0.061, not 0.060.
    expect(impliedPromotionMargin(0.0301)).toBe(0.061);
  });

  it("reproduces the configured 0.088 from the standard error it was derived from", () => {
    // sqrt(2) * sqrt(0.25 / 250) = 0.04472..., the figure the volatility rules cite.
    const derived = Math.SQRT2 * Math.sqrt(0.25 / 250);
    expect(impliedPromotionMargin(derived)).toBeCloseTo(0.09, 2);
  });

  it("refuses a negative standard error", () => {
    expect(() => impliedPromotionMargin(-0.1)).toThrow(/non-negative/);
  });
});

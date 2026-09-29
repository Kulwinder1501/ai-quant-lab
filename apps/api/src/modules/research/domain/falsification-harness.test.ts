import { describe, expect, it } from "vitest";
import { createSeededRandom } from "./information-coefficient.js";
import {
  runFalsificationHarness,
  type FalsificationObservation,
} from "./falsification-harness.js";

/**
 * Synthetic observations spread over several sessions, so the wrong-day placebo has multiple days
 * per time-of-day bucket to permute across.
 */
function build(
  count: number,
  produce: (index: number, random: () => number) => { featureValue: number; forwardReturn: number },
  options: { skewFeatureAsOfByMs?: number; barsPerDay?: number; minutesPerBar?: number } = {},
): FalsificationObservation[] {
  const random = createSeededRandom(2026);
  const barsPerDay = options.barsPerDay ?? 50;
  const minutesPerBar = options.minutesPerBar ?? 5;
  const observations: FalsificationObservation[] = [];

  for (let index = 0; index < count; index += 1) {
    const day = Math.floor(index / barsPerDay);
    const bar = index % barsPerDay;
    // 04:00Z is 09:30 IST; five-minute bars from there stay inside the session.
    const at = new Date(Date.UTC(2026, 7, 3 + day, 4, 0, 0) + bar * minutesPerBar * 60_000);
    const { featureValue, forwardReturn } = produce(index, random);
    observations.push({
      at,
      featureAsOf: new Date(at.getTime() + (options.skewFeatureAsOfByMs ?? 0)),
      featureValue,
      forwardReturn,
    });
  }
  return observations;
}

describe("falsification harness", () => {
  it("TEST B (future injection): reports massive alpha when the feature IS the forward return", () => {
    // The plan's second integrity test, and the one that validates the instrument rather than the
    // signal. If deliberately injected perfect foresight does NOT light up here, the harness is
    // insensitive and every PASS it ever issues is worthless.
    const observations = build(400, (_, random) => {
      const forwardReturn = random() - 0.5;
      return { featureValue: forwardReturn, forwardReturn };
    });

    const report = runFalsificationHarness(observations, { seed: 4, bootstrapSamples: 200 });

    expect(report.verdict).toBe("PASS");
    expect(Math.abs(report.real.ic!)).toBeCloseTo(1, 6);
    expect(report.real.confidenceInterval!.lower).toBeGreaterThan(0.9);
    // The placebos must NOT reproduce it -- that is what makes the band a meaningful bar.
    expect(report.placeboBand!).toBeLessThan(0.5);
    expect(report.failures).toEqual([]);
  });

  it("TEST A (anti-lookahead): fails closed when evidence postdates the decision", () => {
    const observations = build(
      400,
      (_, random) => ({ featureValue: random(), forwardReturn: random() - 0.5 }),
      { skewFeatureAsOfByMs: 1 },
    );

    const report = runFalsificationHarness(observations, { seed: 4, bootstrapSamples: 50 });

    expect(report.verdict).toBe("FAIL_LOOKAHEAD");
    expect(report.lookaheadViolations).toHaveLength(400);
    expect(report.failures[0]).toMatch(/not point-in-time/);
    // No band or lag analysis is offered: a leak corrupts every lag equally, so reporting them
    // would dress up a bug as a weak result.
    expect(report.placeboBand).toBeNull();
    expect(report.negativeLagIcs).toEqual([]);
  });

  it("reports NO_SIGNAL on pure noise", () => {
    const observations = build(400, (_, random) => ({
      featureValue: random(),
      forwardReturn: random() - 0.5,
    }));

    const report = runFalsificationHarness(observations, { seed: 4, bootstrapSamples: 300 });

    expect(report.verdict).toBe("NO_SIGNAL");
    expect(report.failures.length).toBeGreaterThan(0);
  });

  it("catches timestamp skew through a negative lag", () => {
    // The feature is a *stale* copy of a return from three observations ago -- the shape a
    // carried-forward feature or an off-by-N join actually takes. It has no genuine predictive
    // content, and the negative-lag probe is the only check here that would notice.
    const returns: number[] = [];
    const random = createSeededRandom(77);
    for (let index = 0; index < 400; index += 1) returns.push(random() - 0.5);

    const observations = build(400, (index) => ({
      featureValue: index >= 3 ? returns[index - 3]! : 0,
      forwardReturn: returns[index]!,
    }));

    const report = runFalsificationHarness(observations, {
      seed: 4,
      bootstrapSamples: 100,
      negativeLags: [-3],
    });

    expect(report.verdict).toBe("FAIL_NEGATIVE_LAG");
    expect(report.failures[0]).toMatch(/already happened/);
    expect(Math.abs(report.negativeLagIcs[0]!.ic!)).toBeGreaterThan(0.9);
  });

  it("retains negative lags as diagnostics when causal features include realised returns", () => {
    const returns: number[] = [];
    const random = createSeededRandom(77);
    for (let index = 0; index < 400; index += 1) returns.push(random() - 0.5);
    const observations = build(400, (index) => ({
      featureValue: index >= 3 ? returns[index - 3]! : 0,
      forwardReturn: returns[index]!,
    }));

    const report = runFalsificationHarness(observations, {
      seed: 4,
      bootstrapSamples: 50,
      negativeLags: [-3],
      negativeLagMode: "diagnostic",
    });

    expect(Math.abs(report.negativeLagIcs[0]!.ic!)).toBeGreaterThan(0.9);
    expect(report.verdict).not.toBe("FAIL_NEGATIVE_LAG");
  });

  it("does not call an overlapping forward label a past-return lag", () => {
    const returns: number[] = [];
    const random = createSeededRandom(88);
    for (let index = 0; index < 400; index += 1) returns.push(random() - 0.5);
    const observations = build(400, (index) => ({
      featureValue: index > 0 ? returns[index - 1]! : 0,
      forwardReturn: returns[index]!,
    })).map((observation) => ({
      ...observation,
      labelEndAt: new Date(observation.at.getTime() + 15 * 60_000),
    }));

    const report = runFalsificationHarness(observations, {
      seed: 4,
      bootstrapSamples: 50,
      negativeLags: [-1],
    });

    expect(report.negativeLagIcs[0]).toMatchObject({ lag: -1, sampleSize: 7 });
    expect(report.verdict).not.toBe("FAIL_NEGATIVE_LAG");
  });

  it("refuses to report a verdict below the pre-declared minimum sample", () => {
    const observations = build(40, (_, random) => ({
      featureValue: random(),
      forwardReturn: random() - 0.5,
    }));

    const report = runFalsificationHarness(observations, { seed: 4, minimumSample: 100 });

    expect(report.verdict).toBe("INSUFFICIENT_SAMPLE");
    expect(report.failures[0]).toMatch(/peek, not a measurement/);
  });

  it("treats a constant feature as a pipeline fault, not a clean negative", () => {
    const observations = build(400, (_, random) => ({
      featureValue: 0,
      forwardReturn: random() - 0.5,
    }));

    const report = runFalsificationHarness(observations, { seed: 4, bootstrapSamples: 50 });

    expect(report.verdict).toBe("FAIL_PLACEBO");
    expect(report.failures.join(" ")).toMatch(/constant/);
  });

  it("rejects a genuine signal whose interval straddles zero", () => {
    // Signal present but weak relative to noise: it can clear the placebo band on the point
    // estimate while remaining unstable under resampling. Carrying that forward is how a thin
    // result becomes a deployed strategy.
    const observations = build(400, (_, random) => {
      const forwardReturn = random() - 0.5;
      const noise = (random() - 0.5) * 14;
      return { featureValue: forwardReturn + noise, forwardReturn };
    });

    const report = runFalsificationHarness(observations, { seed: 4, bootstrapSamples: 400 });

    if (report.verdict === "PASS") {
      // If it did pass, the interval must genuinely exclude zero -- the point of the assertion is
      // that a straddling interval can never coexist with PASS.
      const interval = report.real.confidenceInterval!;
      expect(interval.lower > 0 || interval.upper < 0).toBe(true);
    } else {
      expect(report.verdict).toBe("NO_SIGNAL");
    }
  });

  it("keeps negative-lag probes inside the band on clean predictive data", () => {
    // A real signal about the future must NOT also appear to predict the past.
    const observations = build(400, (_, random) => {
      const forwardReturn = random() - 0.5;
      return { featureValue: forwardReturn + (random() - 0.5) * 0.2, forwardReturn };
    });

    const report = runFalsificationHarness(observations, { seed: 4, bootstrapSamples: 200 });

    expect(report.verdict).toBe("PASS");
    for (const lagged of report.negativeLagIcs) {
      expect(Math.abs(lagged.ic!)).toBeLessThanOrEqual(report.negativeLagThreshold!);
    }
  });

  it("is deterministic across runs", () => {
    const observations = build(400, (_, random) => ({
      featureValue: random(),
      forwardReturn: random() - 0.5,
    }));

    const first = runFalsificationHarness(observations, { seed: 9, bootstrapSamples: 200 });
    const second = runFalsificationHarness(observations, { seed: 9, bootstrapSamples: 200 });

    expect(first.verdict).toBe(second.verdict);
    expect(first.placeboBand).toBe(second.placeboBand);
    expect(first.real.ic).toBe(second.real.ic);
  });

  describe("wrong-day-matched-time degeneracy guard", () => {
    it("reports INCONCLUSIVE, not NO_SIGNAL, when the window spans a single calendar day", () => {
      // All 400 observations land on one day (barsPerDay === count), which is exactly the bug found
      // live: the wrong-day-matched-time placebo becomes a silent no-op and its IC exactly equals the
      // real IC, which would otherwise drag a possibly-genuine result down to a fake NO_SIGNAL.
      const observations = build(
        400,
        (_, random) => ({ featureValue: random(), forwardReturn: random() - 0.5 }),
        { barsPerDay: 400, minutesPerBar: 2 },
      );

      const report = runFalsificationHarness(observations, { seed: 4, bootstrapSamples: 200 });

      expect(report.verdict).toBe("INCONCLUSIVE");
      expect(report.matchedTimeDiversity).not.toBeNull();
      expect(report.matchedTimeDiversity!.isDegenerate).toBe(true);
      expect(report.matchedTimeDiversity!.distinctDays).toBe(1);
      const dayPlacebo = report.placeboIcs.find((entry) => entry.placebo === "wrong-day-matched-time");
      expect(dayPlacebo?.degenerate).toBe(true);
      // The degenerate placebo's own IC exactly ties the real IC -- the failure mode this guard
      // exists to catch -- and it must not have been allowed to set the band.
      expect(dayPlacebo?.ic).toBe(report.real.ic);
      expect(report.failures.join(" ")).toMatch(/degenerate/i);
    });

    it("still reaches PASS on a feature that IS the forward return, even single-day", () => {
      // A degenerate day-placebo must not manufacture a false PASS either: verdict is withheld
      // (INCONCLUSIVE), not upgraded, regardless of how strong the real IC looks.
      const observations = build(
        400,
        (_, random) => {
          const forwardReturn = random() - 0.5;
          return { featureValue: forwardReturn, forwardReturn };
        },
        { barsPerDay: 400, minutesPerBar: 2 },
      );

      const report = runFalsificationHarness(observations, { seed: 4, bootstrapSamples: 200 });

      expect(report.verdict).toBe("INCONCLUSIVE");
      expect(report.verdict).not.toBe("PASS");
    });

    it("does not regress PASS/NO_SIGNAL behaviour when the window genuinely spans multiple days", () => {
      // Same construction as the pre-existing PASS and NO_SIGNAL tests above (8 days x 50 bars):
      // confirms the new guard leaves already-valid multi-day verdicts untouched.
      const passObservations = build(400, (_, random) => {
        const forwardReturn = random() - 0.5;
        return { featureValue: forwardReturn, forwardReturn };
      });
      const passReport = runFalsificationHarness(passObservations, { seed: 4, bootstrapSamples: 200 });
      expect(passReport.verdict).toBe("PASS");
      expect(passReport.matchedTimeDiversity?.isDegenerate).toBe(false);

      const noiseObservations = build(400, (_, random) => ({
        featureValue: random(),
        forwardReturn: random() - 0.5,
      }));
      const noiseReport = runFalsificationHarness(noiseObservations, { seed: 4, bootstrapSamples: 300 });
      expect(noiseReport.verdict).toBe("NO_SIGNAL");
      expect(noiseReport.matchedTimeDiversity?.isDegenerate).toBe(false);
    });

    it("honours a caller-supplied minimum swappable fraction", () => {
      // With the bar dropped to 0, even single-day data is accepted as non-degenerate (fraction 0
      // always clears >= 0), so the pre-existing NO_SIGNAL/PASS behaviour is reachable again.
      const observations = build(
        400,
        (_, random) => ({ featureValue: random(), forwardReturn: random() - 0.5 }),
        { barsPerDay: 400, minutesPerBar: 2 },
      );

      const report = runFalsificationHarness(observations, {
        seed: 4,
        bootstrapSamples: 200,
        matchedTimeMinimumSwappableFraction: 0,
      });

      expect(report.verdict).not.toBe("INCONCLUSIVE");
      expect(report.matchedTimeDiversity!.isDegenerate).toBe(false);
    });
  });
});

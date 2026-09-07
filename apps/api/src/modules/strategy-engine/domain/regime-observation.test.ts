import { describe, expect, it } from "vitest";
import { buildRegimeObservation } from "./regime-observation.js";

const observedAt = new Date("2026-08-18T05:00:00.000Z");

function base() {
  return {
    instrumentId: "11111111-1111-1111-1111-111111111111",
    timeframe: "5m",
    sourceCandleId: "22222222-2222-2222-2222-222222222222",
    observedAt,
    modelLabelScheme: "volatility-expansion-v1",
  };
}

describe("buildRegimeObservation", () => {
  it("records both readings and stamps the source constants that define them", () => {
    const observation = buildRegimeObservation({
      ...base(),
      volatility: { regime: "HIGH_VOL", valueRatio: 1.25 },
      model: { prediction: "EXPANSION", confidence: 0.61, evidenceCutoffAt: observedAt },
    });

    expect(observation).toMatchObject({
      volatilityRegime: "HIGH_VOL",
      volatilityValueRatio: 1.25,
      modelRegime: "EXPANSION",
      modelConfidence: 0.61,
      completeness: "BOTH",
    });
    // The label alone is not the reading: HIGH_VOL means "ratio above 1.0 against SMA(20) of
    // INDIAVIX under ta-v1", and a later change to any of those makes the stored label mean
    // something else. The row has to carry enough to notice that.
    expect(observation.provenance).toEqual({
      volatilitySourceSymbol: "INDIAVIX",
      volatilityIndicatorCode: "SMA",
      volatilityIndicatorPeriod: 20,
      volatilityIndicatorAlgorithmVersion: "ta-v1",
      volatilityStalenessBars: 5,
      modelLabelScheme: "volatility-expansion-v1",
    });
  });

  it("keeps the value ratio, so a later threshold change stays auditable", () => {
    // 1.0 is the current HIGH_VOL boundary. Storing only the label would make every reading
    // near it indistinguishable from one far from it, and re-deriving is what this record exists
    // to avoid.
    const observation = buildRegimeObservation({
      ...base(),
      volatility: { regime: "LOW_VOL", valueRatio: 0.999 },
    });
    expect(observation.volatilityValueRatio).toBeCloseTo(0.999, 6);
    expect(observation.volatilityRegime).toBe("LOW_VOL");
  });

  it("distinguishes an unclassifiable market from a partly classified one", () => {
    expect(buildRegimeObservation({ ...base() }).completeness).toBe("NEITHER");
    expect(buildRegimeObservation({
      ...base(),
      volatility: { regime: "LOW_VOL", valueRatio: 0.9 },
    }).completeness).toBe("VOLATILITY_ONLY");
    expect(buildRegimeObservation({
      ...base(),
      model: { prediction: "STABLE", confidence: 0.4, evidenceCutoffAt: observedAt },
    }).completeness).toBe("MODEL_ONLY");
  });

  it("treats an explicit null reading the same as an absent one", () => {
    // `deriveVolatilityRegime` and `findVolatilityRegime` both return null for "unknown", so the
    // two spellings must not produce different rows.
    const explicitlyNull = buildRegimeObservation({ ...base(), volatility: null, model: null });
    expect(explicitlyNull).toMatchObject({
      volatilityRegime: null,
      volatilityValueRatio: null,
      modelRegime: null,
      modelConfidence: null,
      modelEvidenceCutoffAt: null,
      completeness: "NEITHER",
    });
  });

  it("discards a model reading whose evidence postdates the observation", () => {
    // A reading from the future recorded as visible is worse than no reading: every later
    // analysis would trust it, and nothing in the row would show the clock was wrong.
    const observation = buildRegimeObservation({
      ...base(),
      model: {
        prediction: "EXPANSION",
        confidence: 0.9,
        evidenceCutoffAt: new Date(observedAt.getTime() + 1),
      },
    });
    expect(observation.modelRegime).toBeNull();
    expect(observation.modelEvidenceCutoffAt).toBeNull();
    expect(observation.completeness).toBe("NEITHER");
  });

  it("accepts a model reading whose evidence lands exactly on the observation", () => {
    // The boundary is inclusive, matching the repository's `evidence_cutoff_at <= asOf`. An
    // exclusive boundary here would silently drop the freshest legitimate reading.
    const observation = buildRegimeObservation({
      ...base(),
      model: { prediction: "CONTRACTION", confidence: 0.5, evidenceCutoffAt: observedAt },
    });
    expect(observation.modelRegime).toBe("CONTRACTION");
  });

  it("drops a model reading carrying an unusable confidence", () => {
    const observation = buildRegimeObservation({
      ...base(),
      model: { prediction: "STABLE", confidence: Number.NaN, evidenceCutoffAt: observedAt },
    });
    expect(observation.modelRegime).toBeNull();
  });

  it("keeps the caller's observation time rather than substituting a fresh clock", () => {
    const observation = buildRegimeObservation({ ...base() });
    expect(observation.observedAt.toISOString()).toBe("2026-08-18T05:00:00.000Z");
  });

  it("allows an observation not taken on a bar", () => {
    const observation = buildRegimeObservation({ ...base(), sourceCandleId: null });
    expect(observation.sourceCandleId).toBeNull();
  });

  it("refuses an unusable observation time or timeframe", () => {
    expect(() => buildRegimeObservation({ ...base(), observedAt: new Date("nope") }))
      .toThrow(/valid observation time/);
    expect(() => buildRegimeObservation({ ...base(), timeframe: "  " }))
      .toThrow(/needs a timeframe/);
  });
});

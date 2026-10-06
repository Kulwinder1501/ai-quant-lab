import { describe, expect, it, vi } from "vitest";
import { PostgresRegimeObservationRepository } from "./postgres-regime-observation-repository.js";
import { buildRegimeObservation } from "../../../modules/strategy-engine/domain/regime-observation.js";
import type { DatabaseQueryable } from "../database.js";

/**
 * The schema's own guards -- the completeness cross-check, the point-in-time check on model
 * evidence, and first-writer-wins on the bar -- are verified against a live database rather than
 * here, because a fake client cannot enforce a CHECK constraint and asserting that it "would have"
 * is theatre. What these cover is the code either side of those guards: that a conflict resolves to
 * the row already stored rather than to silence, and that a row missing its provenance is rejected
 * instead of read as complete.
 */

const observedAt = new Date("2026-08-18T05:00:00.000Z");

const PROVENANCE = {
  volatilitySourceSymbol: "INDIAVIX",
  volatilityIndicatorCode: "SMA",
  volatilityIndicatorPeriod: 20,
  volatilityIndicatorAlgorithmVersion: "ta-v1",
  volatilityStalenessBars: 5,
  modelLabelScheme: "volatility-expansion-v1",
};

function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "observation-1",
    instrument_id: "instrument-1",
    timeframe: "5m",
    source_candle_id: "candle-1",
    observed_at: observedAt,
    volatility_regime: "HIGH_VOL",
    volatility_value_ratio: "1.250000",
    model_regime: null,
    model_confidence: null,
    model_evidence_cutoff_at: null,
    completeness: "VOLATILITY_ONLY",
    provenance: PROVENANCE,
    ...overrides,
  };
}

function harness(responses: { insertRows?: unknown[]; selectRows?: unknown[] }) {
  const statements: string[] = [];
  const parameters: unknown[][] = [];
  const database = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      statements.push(text.replace(/\s+/g, " ").trim());
      parameters.push(values ?? []);
      if (text.includes("INSERT INTO regime_observations")) {
        return { rows: responses.insertRows ?? [] };
      }
      return { rows: responses.selectRows ?? [] };
    }),
  } as unknown as DatabaseQueryable;
  return { statements, parameters, repository: new PostgresRegimeObservationRepository(database) };
}

const OBSERVATION = buildRegimeObservation({
  instrumentId: "instrument-1",
  timeframe: "5m",
  sourceCandleId: "candle-1",
  observedAt,
  volatility: { regime: "HIGH_VOL", valueRatio: 1.25 },
  modelLabelScheme: "volatility-expansion-v1",
});

describe("PostgresRegimeObservationRepository", () => {
  it("returns the inserted observation without a second query", async () => {
    const { statements, repository } = harness({ insertRows: [storedRow()] });
    const stored = await repository.record(OBSERVATION);

    expect(stored.id).toBe("observation-1");
    expect(stored.volatilityValueRatio).toBe(1.25);
    expect(statements).toHaveLength(1);
  });

  it("falls back to the observation already held for the bar when the insert is a no-op", async () => {
    // The repeat is the normal case, not an error: successive bot cycles inside one five-minute bar
    // re-read the same completed bar. The caller still needs an id to stamp on the trade.
    const { statements, repository } = harness({
      insertRows: [],
      selectRows: [storedRow({ id: "observation-first" })],
    });
    const stored = await repository.record(OBSERVATION);

    expect(stored.id).toBe("observation-first");
    expect(statements[0]).toContain("INSERT INTO regime_observations");
    expect(statements[1]).toContain("FROM regime_observations");
  });

  it("does not overwrite the reading already stored for the bar", async () => {
    // First-writer-wins is the whole point: the reading that matters is the one in hand when the bar
    // was first acted on. DO UPDATE here would silently replace it with a later cycle's reading and
    // make the record non-reproducible.
    const { statements, repository } = harness({ insertRows: [storedRow()] });
    await repository.record(OBSERVATION);

    expect(statements[0]).toContain("DO NOTHING");
    expect(statements[0]).not.toContain("DO UPDATE");
  });

  it("carries the source constants into the row it writes", async () => {
    const { parameters, repository } = harness({ insertRows: [storedRow()] });
    await repository.record(OBSERVATION);

    expect(JSON.parse(String(parameters[0]![10]))).toEqual(PROVENANCE);
  });

  it("refuses a stored row whose provenance is missing, rather than reading it as complete", async () => {
    // A label without the constants that produced it is not an observation. Casting the JSONB would
    // hand back an object with undefined fields that still satisfies the type.
    const { repository } = harness({
      insertRows: [storedRow({ provenance: { volatilitySourceSymbol: "INDIAVIX" } })],
    });
    await expect(repository.record(OBSERVATION)).rejects.toThrow(/missing the provenance/);
  });

  it("reports an unclassifiable reading as null rather than zero", async () => {
    const { repository } = harness({
      insertRows: [storedRow({
        volatility_regime: null, volatility_value_ratio: null, completeness: "NEITHER",
      })],
    });
    const stored = await repository.record(OBSERVATION);

    expect(stored.volatilityRegime).toBeNull();
    expect(stored.volatilityValueRatio).toBeNull();
    expect(stored.completeness).toBe("NEITHER");
  });

  it("does not query for a bar that does not exist", async () => {
    // A null candle id has no natural key, so a lookup by it would match unrelated barless
    // observations. Returning null without a query says so.
    const { statements, repository } = harness({ selectRows: [storedRow()] });
    const found = await repository.findByBar({
      instrumentId: "instrument-1", timeframe: "5m", sourceCandleId: null,
    });

    expect(found).toBeNull();
    expect(statements).toHaveLength(0);
  });

  it("fails loudly when a conflict resolves to no row at all", async () => {
    // Unreachable while the unique index exists. If it ever is reached, the index is gone and the
    // table is no longer one-observation-per-bar; returning null would hide that.
    const { repository } = harness({ insertRows: [], selectRows: [] });
    await expect(repository.record(OBSERVATION))
      .rejects.toThrow(/neither inserted a row nor found the conflicting one/);
  });

  it("scopes the bar lookup to the series, not just the candle", async () => {
    const { statements, parameters, repository } = harness({ selectRows: [storedRow()] });
    await repository.findByBar({
      instrumentId: "instrument-1", timeframe: "5m", sourceCandleId: "candle-1",
    });

    expect(statements[0]).toContain("instrument_id = $1");
    expect(statements[0]).toContain("timeframe = $2");
    expect(statements[0]).toContain("source_candle_id = $3");
    expect(parameters[0]).toEqual(["instrument-1", "5m", "candle-1"]);
  });
});

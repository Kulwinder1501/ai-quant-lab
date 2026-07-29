import type { DatabaseQueryable } from "../database.js";
import { describe, expect, it, vi } from "vitest";
import { PostgresModelPredictionQueryRepository } from "./postgres-model-prediction-query-repository.js";

interface QueryCall {
  text: string;
  values: unknown[] | undefined;
}

function baseRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    prediction_id: "8ce74e6e-4e5b-4ed5-99d7-373cb4a21eb7",
    prediction: "BULLISH",
    confidence: "0.7234",
    prediction_created_at: new Date("2026-07-01T12:00:00.000Z"),
    evidence_cutoff_at: new Date("2026-07-01T11:45:00.000Z"),
    instrument_id: "instrument-1",
    instrument_exchange: "NSE",
    instrument_symbol: "NIFTY50",
    instrument_display_name: "NIFTY 50",
    source_candle_id: "candle-1",
    source_timeframe: "1d",
    source_open_time: new Date("2026-06-30T03:45:00.000Z"),
    source_close_time: new Date("2026-07-01T03:45:00.000Z"),
    source_open: "25000.25",
    source_high: "25100.5",
    source_low: "24950.25",
    source_close: "25075.75",
    source_volume: "1000000",
    model_version_id: "model-version-1",
    model_key: "nifty50-1d-classifier",
    model_version: "2",
    model_algorithm: "sklearn-logistic-regression-v1",
    model_current_stage: "PRODUCTION",
    model_artifact_checksum: "sha256:local-artifact-checksum",
    model_training_rows: "420",
    model_validation_metrics: { macroF1: 0.61 },
    model_trained_at: new Date("2026-06-29T12:00:00.000Z"),
    model_promoted_at: new Date("2026-06-30T12:00:00.000Z"),
    ...overrides,
  };
}

function fakeDatabase(rows: unknown[]): { database: DatabaseQueryable; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  return {
    database: {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        return { rows };
      }),
    } as unknown as DatabaseQueryable,
    calls,
  };
}

describe("PostgresModelPredictionQueryRepository", () => {
  it("lists a deterministic, read-only research projection with bound filters and a keyset cursor", async () => {
    const { database, calls } = fakeDatabase([baseRow()]);
    const cursor = { createdAt: new Date("2026-07-02T12:00:00.000Z"), id: "9dbb9bd3-4d1a-4f8d-80a9-6be441bfcc4e" };

    await expect(new PostgresModelPredictionQueryRepository(database).list({
      instrumentSymbol: "NIFTY50",
      modelKey: "nifty50-1d-classifier",
      timeframe: "1d",
      prediction: "BULLISH",
      cursor,
      limit: 21,
    })).resolves.toEqual([{
      researchOnly: true,
      id: "8ce74e6e-4e5b-4ed5-99d7-373cb4a21eb7",
      prediction: "BULLISH",
      confidence: 0.7234,
      createdAt: new Date("2026-07-01T12:00:00.000Z"),
      evidenceCutoffAt: new Date("2026-07-01T11:45:00.000Z"),
      instrument: { id: "instrument-1", exchange: "NSE", symbol: "NIFTY50", displayName: "NIFTY 50" },
      sourceCandle: {
        id: "candle-1",
        timeframe: "1d",
        openTime: new Date("2026-06-30T03:45:00.000Z"),
        closeTime: new Date("2026-07-01T03:45:00.000Z"),
        open: 25000.25,
        high: 25100.5,
        low: 24950.25,
        close: 25075.75,
        volume: 1_000_000,
      },
      model: {
        id: "model-version-1",
        key: "nifty50-1d-classifier",
        version: 2,
        algorithm: "sklearn-logistic-regression-v1",
        currentStage: "PRODUCTION",
        artifactChecksum: "sha256:local-artifact-checksum",
        trainingRows: 420,
        validationMetrics: { macroF1: 0.61 },
        trainedAt: new Date("2026-06-29T12:00:00.000Z"),
        promotedAt: new Date("2026-06-30T12:00:00.000Z"),
      },
    }]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("SELECT");
    expect(calls[0]?.text).toContain("ORDER BY date_trunc('milliseconds', mp.created_at) DESC, mp.id DESC");
    expect(calls[0]?.text).toContain("date_trunc('milliseconds', mp.created_at) < $5");
    expect(calls[0]?.text).toContain("date_trunc('milliseconds', mp.created_at) = $5 AND mp.id < $6::uuid");
    expect(calls[0]?.text).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    expect(calls[0]?.text).not.toContain("artifact_uri");
    expect(calls[0]?.values).toEqual([
      "NIFTY50",
      "nifty50-1d-classifier",
      "1d",
      "BULLISH",
      cursor.createdAt,
      cursor.id,
      21,
    ]);
  });

  it("returns detail evidence and model lineage without exposing an artifact location", async () => {
    const { database, calls } = fakeDatabase([baseRow({
      model_feature_schema: [{ name: "rsi14", category: "indicator" }],
      model_training_window_start: new Date("2025-01-01T00:00:00.000Z"),
      model_training_window_end: new Date("2026-06-01T00:00:00.000Z"),
      feature_contributions: [{ feature: "rsi14", contribution: 0.11 }],
      explanation: [{ type: "MODEL_LIMITATION", text: "Research-only prediction." }],
    })]);

    const detail = await new PostgresModelPredictionQueryRepository(database)
      .findById("8ce74e6e-4e5b-4ed5-99d7-373cb4a21eb7");

    expect(detail?.researchOnly).toBe(true);
    expect(detail?.model.featureSchema).toEqual([{ name: "rsi14", category: "indicator" }]);
    expect(detail?.model.trainingWindow).toEqual({
      start: new Date("2025-01-01T00:00:00.000Z"),
      end: new Date("2026-06-01T00:00:00.000Z"),
    });
    expect(detail?.featureContributions).toEqual([{ feature: "rsi14", contribution: 0.11 }]);
    expect(detail?.explanation).toEqual([{ type: "MODEL_LIMITATION", text: "Research-only prediction." }]);
    expect(calls[0]?.text).toContain("mp.feature_contributions");
    expect(calls[0]?.text).toContain("mv.feature_schema AS model_feature_schema");
    expect(calls[0]?.text).not.toContain("artifact_uri");
    expect(calls[0]?.text).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  });

  it("uses the same millisecond key for cursor comparison and ordering when stored timestamps differ by microseconds", async () => {
    const { database, calls } = fakeDatabase([
      baseRow({
        prediction_id: "8ce74e6e-4e5b-4ed5-99d7-373cb4a21eb7",
        prediction_created_at: "2026-07-01T12:00:00.123999Z",
      }),
      baseRow({
        prediction_id: "19101f7c-6543-4a31-8d68-20d36732556b",
        prediction_created_at: "2026-07-01T12:00:00.123001Z",
      }),
    ]);

    const records = await new PostgresModelPredictionQueryRepository(database).list({ limit: 2 });

    // JavaScript exposes millisecond dates, so both records must use a SQL
    // ordering key with the same precision before the id tie-breaker is used.
    expect(records.map((record) => record.createdAt.toISOString())).toEqual([
      "2026-07-01T12:00:00.123Z",
      "2026-07-01T12:00:00.123Z",
    ]);
    expect(calls[0]?.text).toMatch(/date_trunc\('milliseconds', mp\.created_at\) < \$5/);
    expect(calls[0]?.text).toMatch(/ORDER BY date_trunc\('milliseconds', mp\.created_at\) DESC, mp\.id DESC/);
  });

  it("rejects invalid persisted confidence and positive model lineage fields", async () => {
    const invalidConfidence = fakeDatabase([baseRow({ confidence: "1.0001" })]);
    await expect(new PostgresModelPredictionQueryRepository(invalidConfidence.database).list({ limit: 1 }))
      .rejects.toThrow("invalid prediction confidence");

    const invalidVersion = fakeDatabase([baseRow({ model_version: "0" })]);
    await expect(new PostgresModelPredictionQueryRepository(invalidVersion.database).list({ limit: 1 }))
      .rejects.toThrow("invalid model version");

    const invalidTrainingRows = fakeDatabase([baseRow({ model_training_rows: "0" })]);
    await expect(new PostgresModelPredictionQueryRepository(invalidTrainingRows.database).list({ limit: 1 }))
      .rejects.toThrow("invalid model training rows");
  });
});

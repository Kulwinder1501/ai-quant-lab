import type { AddressInfo } from "node:net";
import type { DatabaseQueryable } from "../../infrastructure/database/database.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";

interface QueryCall {
  text: string;
  values: unknown[] | undefined;
}

const predictionId = "8ce74e6e-4e5b-4ed5-99d7-373cb4a21eb7";

function predictionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    prediction_id: predictionId,
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

function predictionDatabase(): { database: DatabaseQueryable; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  return {
    database: {
      query: vi.fn(async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        if (text.includes("WHERE mp.id = $1::uuid")) {
          return {
            rows: [predictionRow({
              model_feature_schema: [{ name: "rsi14" }],
              model_training_window_start: new Date("2025-01-01T00:00:00.000Z"),
              model_training_window_end: new Date("2026-06-01T00:00:00.000Z"),
              feature_contributions: [{ feature: "rsi14", contribution: 0.11 }],
              explanation: [{ type: "MODEL_LIMITATION", text: "Research-only prediction." }],
            })],
          };
        }
        return {
          rows: [
            predictionRow(),
            predictionRow({
              prediction_id: "19101f7c-6543-4a31-8d68-20d36732556b",
              prediction_created_at: new Date("2026-06-30T12:00:00.000Z"),
            }),
          ],
        };
      }),
    } as unknown as DatabaseQueryable,
    calls,
  };
}

async function getJson(app: ReturnType<typeof createApp>, path: string, method = "GET"): Promise<{
  status: number;
  body: unknown;
}> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("model prediction HTTP routes", () => {
  it("lists bounded, filterable research records with a descending createdAt/id cursor", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { database, calls } = predictionDatabase();
    const response = await getJson(
      createApp({ database }),
      "/api/v1/model-predictions?instrument=nifty50&prediction=bullish&limit=1",
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      data: [{
        researchOnly: true,
        id: predictionId,
        prediction: "BULLISH",
        instrument: { symbol: "NIFTY50", displayName: "NIFTY 50" },
        sourceCandle: { timeframe: "1d", close: 25075.75 },
        model: { key: "nifty50-1d-classifier", currentStage: "PRODUCTION" },
      }],
      page: {
        limit: 1,
        nextCursor: { createdAt: "2026-07-01T12:00:00.000Z", id: predictionId },
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.values).toEqual(["NIFTY50", null, null, "BULLISH", null, null, 2]);
  });

  it("returns stored explanation detail only for a valid prediction id", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { database, calls } = predictionDatabase();
    const response = await getJson(createApp({ database }), `/api/v1/model-predictions/${predictionId}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      data: {
        researchOnly: true,
        id: predictionId,
        featureContributions: [{ feature: "rsi14", contribution: 0.11 }],
        explanation: [{ type: "MODEL_LIMITATION", text: "Research-only prediction." }],
        model: { featureSchema: [{ name: "rsi14" }], trainingWindow: { start: "2025-01-01T00:00:00.000Z" } },
      },
    });
    expect(calls[0]?.values).toEqual([predictionId]);
  });

  it("rejects malformed query/input and exposes no mutation route", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { database, calls } = predictionDatabase();
    const app = createApp({ database });

    const invalidLimit = await getJson(app, "/api/v1/model-predictions?limit=1.5");
    const invalidId = await getJson(app, "/api/v1/model-predictions/not-a-uuid");
    const mutationAttempt = await getJson(app, "/api/v1/model-predictions", "POST");

    expect(invalidLimit).toEqual({ status: 400, body: { error: "limit must be a whole number." } });
    expect(invalidId).toEqual({ status: 400, body: { error: "predictionId must be a UUID." } });
    expect(mutationAttempt).toEqual({ status: 404, body: { error: "Route not found" } });
    expect(calls).toHaveLength(0);
  });

  it("keeps Stock Intelligence HTTP off until the Gate 7 flag is enabled", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { database } = predictionDatabase();
    const response = await getJson(createApp({ database }), "/api/v1/stock-intelligence/outlook?query=RELIANCE");
    expect(response).toEqual({ status: 404, body: { error: "Route not found" } });
  });
});

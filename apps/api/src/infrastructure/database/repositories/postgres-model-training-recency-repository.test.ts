import type { DatabaseQueryable } from "../database.js";
import { describe, expect, it, vi } from "vitest";
import { PostgresModelTrainingRecencyRepository } from "./postgres-model-training-recency-repository.js";

describe("PostgresModelTrainingRecencyRepository", () => {
  it("maps each model key to its latest trained timestamp", async () => {
    const query = vi.fn(async (_text: string) => ({
      rows: [
        { model_key: "model-a", latest_trained_at: "2026-08-01T10:00:00.000Z" },
        { model_key: "model-b", latest_trained_at: new Date("2026-08-02T10:00:00.000Z") },
      ],
    }));
    const repository = new PostgresModelTrainingRecencyRepository(
      { query } as unknown as DatabaseQueryable,
    );

    const result = await repository.getLatestTrainedAtByModelKey();

    expect(result).toEqual(new Map([
      ["model-a", new Date("2026-08-01T10:00:00.000Z")],
      ["model-b", new Date("2026-08-02T10:00:00.000Z")],
    ]));
    expect(query.mock.calls[0]?.[0]).toContain("MAX(trained_at)");
  });

  it("returns only live PRIMARY keys below the dual trivial baseline after enough evidence", async () => {
    const query = vi.fn(async (_text: string) => ({
      rows: [
        { model_key: "volatility-xgboost--refit-20260801" },
        { model_key: "volatility-lightgbm--refit-20260801" },
      ],
    }));
    const repository = new PostgresModelTrainingRecencyRepository(
      { query } as unknown as DatabaseQueryable,
    );

    await expect(repository.getDegradedVolatilityModelKeys()).resolves.toEqual(new Set([
      "volatility-xgboost--refit-20260801",
      "volatility-lightgbm--refit-20260801",
    ]));

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("vcs.role = 'PRIMARY'");
    expect(sql).toContain("t.sample_count >= 60");
    expect(sql).toContain("t.scored_days >= 15");
    expect(sql).toContain("m.macro_f1 <=");
    expect(sql).toContain("INTERVAL '30 days'");
  });
});

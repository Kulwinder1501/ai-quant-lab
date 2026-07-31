import { describe, expect, it } from "vitest";
import {
  SettleModelPredictions,
  type DailyScoreUpsert,
  type ModelPredictionSettlementRepository,
} from "./settle-model-predictions.js";

describe("SettleModelPredictions", () => {
  it("skips models without a persisted target definition and recomputes touched days", async () => {
    const upserts: DailyScoreUpsert[] = [];
    const repository: ModelPredictionSettlementRepository = {
      listModelsWithUnsettledPredictions: async () => [
        { modelVersionId: "legacy", modelKey: "old-key", horizonBars: null, neutralThresholdBps: null, unsettledCount: 3 },
        { modelVersionId: "m1", modelKey: "new-key", horizonBars: 5, neutralThresholdBps: 50, unsettledCount: 4 },
      ],
      settlePredictionsForModel: async (input) => {
        expect(input).toEqual({ modelVersionId: "m1", horizonBars: 5, neutralThresholdBps: 50 });
        // Two predictions matured on the 29th, two on the 30th.
        return ["2026-07-29", "2026-07-29", "2026-07-30", "2026-07-30"];
      },
      settledConfusionByDate: async (modelVersionId, scoreDates) => {
        expect(modelVersionId).toBe("m1");
        expect(scoreDates).toEqual(["2026-07-29", "2026-07-30"]);
        return [
          { scoreDate: "2026-07-29", cell: { prediction: "BULLISH", realizedLabel: "BULLISH", count: 2 } },
          { scoreDate: "2026-07-30", cell: { prediction: "BULLISH", realizedLabel: "BEARISH", count: 1 } },
          { scoreDate: "2026-07-30", cell: { prediction: "NEUTRAL", realizedLabel: "NEUTRAL", count: 1 } },
        ];
      },
      upsertDailyScore: async (input) => {
        upserts.push(input);
      },
    };

    const result = await new SettleModelPredictions(repository).execute();

    expect(result).toEqual({
      modelsExamined: 2,
      modelsSettled: 1,
      modelsSkippedWithoutProtocol: 1,
      predictionsSettled: 4,
      dailyScoresUpserted: 2,
    });
    expect(upserts).toHaveLength(2);
    expect(upserts[0]).toMatchObject({
      modelVersionId: "m1",
      scoreDate: "2026-07-29",
      predictionsSettled: 2,
      predictionsCorrect: 2,
      accuracy: 1,
    });
    expect(upserts[1]).toMatchObject({
      modelVersionId: "m1",
      scoreDate: "2026-07-30",
      predictionsSettled: 2,
      predictionsCorrect: 1,
      accuracy: 0.5,
    });
  });
});

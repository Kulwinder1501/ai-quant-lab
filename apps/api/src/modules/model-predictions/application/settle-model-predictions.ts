import {
  computeSettledMetrics,
  type ConfusionCell,
} from "../domain/model-competition.js";

/**
 * A model with unsettled predictions and the labelling parameters its
 * predictions must be judged by. Horizon and neutral band come from the
 * model's own persisted validation protocol so live settlement uses exactly
 * the target definition the model was trained against.
 */
export interface SettleableModel {
  modelVersionId: string;
  modelKey: string;
  horizonBars: number | null;
  neutralThresholdBps: number | null;
  unsettledCount: number;
}

export interface DailyConfusionRow {
  scoreDate: string;
  cell: ConfusionCell;
}

export interface DailyScoreUpsert {
  modelVersionId: string;
  scoreDate: string;
  predictionsSettled: number;
  predictionsCorrect: number;
  accuracy: number | null;
  macroF1: number | null;
  directionalHitRate: number | null;
  baselineAccuracy: number | null;
}

export interface ModelPredictionSettlementRepository {
  listModelsWithUnsettledPredictions(): Promise<SettleableModel[]>;
  /**
   * Settle every matured prediction for one model against completed candles
   * and return the IST score dates the batch touched.
   */
  settlePredictionsForModel(input: {
    modelVersionId: string;
    horizonBars: number;
    neutralThresholdBps: number;
  }): Promise<string[]>;
  /** Confusion counts of all settled predictions on the given IST dates. */
  settledConfusionByDate(modelVersionId: string, scoreDates: string[]): Promise<DailyConfusionRow[]>;
  upsertDailyScore(input: DailyScoreUpsert): Promise<void>;
}

export interface SettleModelPredictionsResult {
  modelsExamined: number;
  modelsSettled: number;
  modelsSkippedWithoutProtocol: number;
  predictionsSettled: number;
  dailyScoresUpserted: number;
}

/**
 * Settles matured model predictions against realized candles and maintains
 * per-model daily scores — the live scoreboard the daily competition ranks on.
 * Idempotent: a day's aggregate is always recomputed from all of that day's
 * settled predictions, so settling in multiple batches cannot double-count.
 */
export class SettleModelPredictions {
  constructor(private readonly repository: ModelPredictionSettlementRepository) {}

  async execute(): Promise<SettleModelPredictionsResult> {
    const models = await this.repository.listModelsWithUnsettledPredictions();
    let modelsSettled = 0;
    let modelsSkippedWithoutProtocol = 0;
    let predictionsSettled = 0;
    let dailyScoresUpserted = 0;

    for (const model of models) {
      if (
        model.horizonBars === null
        || !Number.isInteger(model.horizonBars)
        || model.horizonBars <= 0
        || model.neutralThresholdBps === null
        || !Number.isFinite(model.neutralThresholdBps)
        || model.neutralThresholdBps < 0
      ) {
        // A prediction without a persisted target definition cannot be judged;
        // inventing a horizon would grade the model against a test it never sat.
        modelsSkippedWithoutProtocol += 1;
        continue;
      }

      const touchedDates = await this.repository.settlePredictionsForModel({
        modelVersionId: model.modelVersionId,
        horizonBars: model.horizonBars,
        neutralThresholdBps: model.neutralThresholdBps,
      });
      if (touchedDates.length === 0) continue;

      modelsSettled += 1;
      predictionsSettled += touchedDates.length;

      const distinctDates = [...new Set(touchedDates)].sort();
      const confusion = await this.repository.settledConfusionByDate(model.modelVersionId, distinctDates);
      const cellsByDate = new Map<string, ConfusionCell[]>();
      for (const row of confusion) {
        const cells = cellsByDate.get(row.scoreDate) ?? [];
        cells.push(row.cell);
        cellsByDate.set(row.scoreDate, cells);
      }

      for (const [scoreDate, cells] of cellsByDate) {
        const metrics = computeSettledMetrics(cells);
        await this.repository.upsertDailyScore({
          modelVersionId: model.modelVersionId,
          scoreDate,
          predictionsSettled: metrics.sampleCount,
          predictionsCorrect: metrics.correctCount,
          accuracy: metrics.accuracy,
          macroF1: metrics.macroF1,
          directionalHitRate: metrics.directionalHitRate,
          baselineAccuracy: metrics.trivialAccuracy,
        });
        dailyScoresUpserted += 1;
      }
    }

    return {
      modelsExamined: models.length,
      modelsSettled,
      modelsSkippedWithoutProtocol,
      predictionsSettled,
      dailyScoresUpserted,
    };
  }
}

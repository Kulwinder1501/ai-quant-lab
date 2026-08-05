import {
  gradeVolatilityOutcome,
  isVolatilityLabel,
  type RangeBar,
  type VolatilityLabel,
} from "../domain/volatility-expansion-label.js";

/**
 * Settlement for non-directional predictions.
 *
 * `auxiliary_model_predictions` was write-only, so a volatility model could predict
 * forever and never accumulate a single graded outcome. That made "shadow before
 * primary" unsatisfiable for the only target measured to beat the trivial predictor on
 * both macro-F1 and accuracy, which meant the architecture guaranteed the one thing
 * that works could never be used.
 *
 * Kept entirely separate from `SettleModelPredictions` rather than generalised. The two
 * label alphabets are disjoint by design, and the directional path's grading reads a
 * neutral band in basis points that means nothing here. Sharing a code path would put
 * the burden on remembering which branch applies, which is the mistake migration 011
 * chose a separate table to make impossible.
 */

/** A matured, ungraded prediction plus the rule its own model was trained under. */
export interface SettleableAuxiliaryPrediction {
  predictionId: string;
  modelVersionId: string;
  modelKey: string;
  instrumentId: string;
  timeframe: string;
  prediction: string;
  sourceCandleCloseTime: Date;
  /** From the model's persisted `validationProtocol`, never a default. */
  horizonBars: number | null;
  expansionBand: number | null;
}

export interface AuxiliarySettlementOutcome {
  predictionId: string;
  realizedLabel: VolatilityLabel;
  rangeRatio: number;
  forwardRange: number;
  trailingRange: number;
  labelAvailableAt: Date;
}

export interface AuxiliaryPredictionSettlementRepository {
  /** Matured but ungraded rows for the volatility scheme, oldest first. */
  listSettleableVolatilityPredictions(limit: number): Promise<SettleableAuxiliaryPrediction[]>;
  /**
   * The `horizonBars` completed bars ending at `closeTime`, then the
   * `horizonBars` completed bars strictly after it. Fewer forward bars than
   * requested means the prediction has not matured unless `forwardWindowClosed`
   * proves an intraday session ended before the horizon could complete.
   */
  loadRangeWindows(input: {
    instrumentId: string;
    timeframe: string;
    closeTime: Date;
    horizonBars: number;
  }): Promise<{
    trailing: RangeBar[];
    forward: RangeBar[];
    forwardCloseTime: Date | null;
    forwardWindowClosed: boolean;
  }>;
  recordSettlement(outcome: AuxiliarySettlementOutcome): Promise<void>;
  /**
   * Records why a matured prediction could not be graded. Never written as a
   * STABLE outcome: a flat trailing window and an unchanged range are different
   * facts, and conflating them would manufacture agreement.
   */
  recordUnsettleable(predictionId: string, reason: string): Promise<void>;
}

export interface SettleAuxiliaryPredictionsResult {
  examined: number;
  settled: number;
  notYetMatured: number;
  unsettleable: number;
  skippedWithoutProtocol: number;
  skippedWithForeignAlphabet: number;
  byRealizedLabel: Record<string, number>;
}

const DEFAULT_BATCH_LIMIT = 5_000;

export class SettleAuxiliaryPredictions {
  constructor(private readonly repository: AuxiliaryPredictionSettlementRepository) {}

  async execute(options: { limit?: number } = {}): Promise<SettleAuxiliaryPredictionsResult> {
    const limit = options.limit ?? DEFAULT_BATCH_LIMIT;
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error("The settlement batch limit must be a positive integer.");
    }

    const pending = await this.repository.listSettleableVolatilityPredictions(limit);
    const result: SettleAuxiliaryPredictionsResult = {
      examined: pending.length,
      settled: 0,
      notYetMatured: 0,
      unsettleable: 0,
      skippedWithoutProtocol: 0,
      skippedWithForeignAlphabet: 0,
      byRealizedLabel: {},
    };

    for (const item of pending) {
      // A model whose protocol does not record the rule cannot be graded under it.
      // Guessing a band would score a model against a target it never learned.
      if (
        item.horizonBars === null || !Number.isInteger(item.horizonBars) || item.horizonBars <= 0
        || item.expansionBand === null || !Number.isFinite(item.expansionBand) || item.expansionBand <= 0
      ) {
        result.skippedWithoutProtocol += 1;
        continue;
      }
      // Defence in depth: the table is not value-constrained because it serves every
      // non-directional scheme, so a directional label reaching here would mean the
      // alphabets had crossed.
      if (!isVolatilityLabel(item.prediction)) {
        result.skippedWithForeignAlphabet += 1;
        continue;
      }

      const windows = await this.repository.loadRangeWindows({
        instrumentId: item.instrumentId,
        timeframe: item.timeframe,
        closeTime: item.sourceCandleCloseTime,
        horizonBars: item.horizonBars,
      });

      const grade = gradeVolatilityOutcome({
        trailingBars: windows.trailing,
        forwardBars: windows.forward,
        horizonBars: item.horizonBars,
        band: item.expansionBand,
      });

      if (!grade.measurable) {
        // An incomplete forward window is simply not ready; anything else is a
        // permanent property of the data and is recorded so it stops being retried.
        if (windows.forward.length < item.horizonBars) {
          if (windows.forwardWindowClosed) {
            await this.repository.recordUnsettleable(
              item.predictionId,
              "INTRADAY_SESSION_ENDED_BEFORE_HORIZON",
            );
            result.unsettleable += 1;
            continue;
          }
          result.notYetMatured += 1;
          continue;
        }
        await this.repository.recordUnsettleable(item.predictionId, grade.reason);
        result.unsettleable += 1;
        continue;
      }

      if (windows.forwardCloseTime === null) {
        result.notYetMatured += 1;
        continue;
      }

      await this.repository.recordSettlement({
        predictionId: item.predictionId,
        realizedLabel: grade.label,
        rangeRatio: grade.rangeRatio,
        forwardRange: grade.forwardRange,
        trailingRange: grade.trailingRange,
        labelAvailableAt: windows.forwardCloseTime,
      });
      result.settled += 1;
      result.byRealizedLabel[grade.label] = (result.byRealizedLabel[grade.label] ?? 0) + 1;
    }

    return result;
  }
}

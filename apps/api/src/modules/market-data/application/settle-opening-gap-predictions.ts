import { istInstant } from "../../platform/calendar/trading-session.js";
import { gradeOpeningGapOutcome } from "../domain/opening-gap-prediction.js";
import type { GapExpectation, OpeningGapClassifierInstrument } from "../domain/opening-gap-classifier.js";

/** NSE's regular session opens at 09:15 IST, i.e. minute 555 of the IST day. */
const SESSION_OPEN_IST_MINUTE = 9 * 60 + 15;

/**
 * A session older than this with still no previous close or session-open candle is treated as
 * permanently ungradeable (a holiday the calendar didn't know about, a dead feed that day) rather
 * than retried forever -- mirrors `markAnchorlessVolatilityPredictionsUnsettleable`'s reasoning:
 * a pending queue must not silently hold work nothing will ever pick up.
 */
const STALE_AFTER_DAYS = 5;

export interface SettleableOpeningGapPrediction {
  id: string;
  instrumentSymbol: OpeningGapClassifierInstrument;
  sessionDate: string;
  expectation: GapExpectation;
}

export interface OpeningGapSettlementRepository {
  listPendingSettlement(limit: number): Promise<SettleableOpeningGapPrediction[]>;
  findPreviousClose(symbol: string, sessionDate: string): Promise<number | null>;
  findSessionOpen(symbol: string, sessionOpenInstant: Date): Promise<number | null>;
  recordSettlement(
    id: string,
    outcome: {
      previousClose: number;
      actualOpen: number;
      actualGapPct: number;
      actualExpectation: GapExpectation;
      wasCorrect: boolean;
    },
  ): Promise<void>;
  recordUnsettleable(id: string, reason: string): Promise<void>;
}

export interface SettleOpeningGapPredictionsResult {
  examined: number;
  settled: number;
  notYetMatured: number;
  unsettleable: number;
}

const DEFAULT_LIMIT = 500;

export class SettleOpeningGapPredictions {
  constructor(
    private readonly repository: OpeningGapSettlementRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(options: { limit?: number } = {}): Promise<SettleOpeningGapPredictionsResult> {
    const limit = options.limit ?? DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error("The settlement batch limit must be a positive integer.");
    }

    const pending = await this.repository.listPendingSettlement(limit);
    const result: SettleOpeningGapPredictionsResult = {
      examined: pending.length,
      settled: 0,
      notYetMatured: 0,
      unsettleable: 0,
    };

    for (const prediction of pending) {
      const sessionOpenInstant = istInstant(prediction.sessionDate, SESSION_OPEN_IST_MINUTE);
      const [previousClose, actualOpen] = await Promise.all([
        this.repository.findPreviousClose(prediction.instrumentSymbol, prediction.sessionDate),
        this.repository.findSessionOpen(prediction.instrumentSymbol, sessionOpenInstant),
      ]);

      if (previousClose === null || actualOpen === null) {
        const ageDays = Math.floor(
          (this.now().getTime() - Date.parse(`${prediction.sessionDate}T00:00:00.000Z`)) / 86_400_000,
        );
        if (ageDays > STALE_AFTER_DAYS) {
          await this.repository.recordUnsettleable(
            prediction.id,
            previousClose === null ? "NO_PREVIOUS_CLOSE" : "NO_SESSION_OPEN_CANDLE",
          );
          result.unsettleable += 1;
        } else {
          result.notYetMatured += 1;
        }
        continue;
      }

      const grade = gradeOpeningGapOutcome({
        instrumentSymbol: prediction.instrumentSymbol,
        predictedExpectation: prediction.expectation,
        previousClose,
        actualOpen,
      });

      await this.repository.recordSettlement(prediction.id, {
        previousClose,
        actualOpen,
        actualGapPct: grade.actualGapPct,
        actualExpectation: grade.actualExpectation,
        wasCorrect: grade.wasCorrect,
      });
      result.settled += 1;
    }

    return result;
  }
}

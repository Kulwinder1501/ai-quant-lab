import {
  classifyOpeningGap,
  OPENING_GAP_THRESHOLD_PCT,
  type GapExpectation,
  type OpeningGapClassifierInstrument,
} from "./opening-gap-classifier.js";

/** A persisted opening-gap prediction, before or after settlement. */
export interface OpeningGapPrediction {
  id: string;
  instrumentSymbol: OpeningGapClassifierInstrument;
  /** IST calendar date the prediction is for, `YYYY-MM-DD`. */
  sessionDate: string;
  predictedAt: Date;
  driverSymbol: string;
  driverChangePct: number;
  thresholdPct: number;
  expectation: GapExpectation;
  /** Raw readings not used in the classification rule, kept for future evaluation. */
  supplementaryCues: Record<string, number | null>;
}

export interface NewOpeningGapPrediction {
  instrumentSymbol: OpeningGapClassifierInstrument;
  sessionDate: string;
  driverSymbol: string;
  driverChangePct: number;
  supplementaryCues: Record<string, number | null>;
}

/** The fields a store needs to persist a fresh (unsettled) prediction. */
export type OpeningGapPredictionDraft = Omit<OpeningGapPrediction, "id" | "predictedAt">;

export function buildOpeningGapPrediction(input: NewOpeningGapPrediction): OpeningGapPredictionDraft {
  const thresholdPct = OPENING_GAP_THRESHOLD_PCT[input.instrumentSymbol];
  return {
    instrumentSymbol: input.instrumentSymbol,
    sessionDate: input.sessionDate,
    driverSymbol: input.driverSymbol,
    driverChangePct: input.driverChangePct,
    thresholdPct,
    expectation: classifyOpeningGap(input.driverChangePct, thresholdPct),
    supplementaryCues: input.supplementaryCues,
  };
}

export interface OpeningGapSettlementGrade {
  actualGapPct: number;
  actualExpectation: GapExpectation;
  wasCorrect: boolean;
}

/**
 * Grades a prediction against the real session open. "Correct" means the three-way
 * classification matches exactly -- GAP_UP predicted and realized as FLAT is not a partial credit.
 */
export function gradeOpeningGapOutcome(input: {
  instrumentSymbol: OpeningGapClassifierInstrument;
  predictedExpectation: GapExpectation;
  previousClose: number;
  actualOpen: number;
}): OpeningGapSettlementGrade {
  if (!(input.previousClose > 0)) {
    throw new Error(`previousClose must be positive; got ${input.previousClose}.`);
  }
  if (!(input.actualOpen > 0)) {
    throw new Error(`actualOpen must be positive; got ${input.actualOpen}.`);
  }

  const actualGapPct = Number((((input.actualOpen - input.previousClose) / input.previousClose) * 100).toFixed(4));
  const thresholdPct = OPENING_GAP_THRESHOLD_PCT[input.instrumentSymbol];
  const actualExpectation = classifyOpeningGap(actualGapPct, thresholdPct);

  return {
    actualGapPct,
    actualExpectation,
    wasCorrect: actualExpectation === input.predictedExpectation,
  };
}

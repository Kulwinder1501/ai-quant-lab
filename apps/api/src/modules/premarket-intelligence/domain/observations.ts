import type { ValidatedAssessment } from "./assessment-contract.js";
import type { LevelObservation, ScoredObservation } from "./scoring.js";
import type { LevelTouch } from "./session-outcome.js";
import type { BaselineName, DeterministicBaselines } from "./snapshot.js";
import { PREMARKET_INSTRUMENTS, toMeasuredOutcome, type MeasuredOutcome, type PremarketInstrument, type PremarketTarget } from "./targets.js";

export interface StoredBiasRow {
  assessmentDate: string;
  runSlot: string;
  llmStatus: "VALIDATED" | "NOT_CONFIGURED" | "FAILED";
  assessments: ValidatedAssessment[] | null;
  baselines: DeterministicBaselines;
}

export interface StoredOutcome {
  instrument: PremarketInstrument;
  sessionDate: string;
  gapOutcome: MeasuredOutcome | null;
  first60Outcome: MeasuredOutcome | null;
  fullSessionOutcome: MeasuredOutcome | null;
  levelTouches: LevelTouch[];
}

function actualFor(outcome: StoredOutcome, target: PremarketTarget): MeasuredOutcome | null {
  return target === "OPENING_GAP" ? outcome.gapOutcome : target === "FIRST_60_MINUTES" ? outcome.first60Outcome : outcome.fullSessionOutcome;
}

function modelCall(assessment: ValidatedAssessment, target: PremarketTarget): MeasuredOutcome | null {
  const word = target === "OPENING_GAP"
    ? assessment.opening_context.expectation
    : target === "FIRST_60_MINUTES"
      ? assessment.intraday_context.expected_direction
      : assessment.full_session_context.expected_direction;
  return toMeasuredOutcome(word);
}

/**
 * Joins stored model assessments to measured outcomes into the rows the scorer consumes.
 *
 * Only rows whose model output validated are scored as model observations; a snapshot where the
 * model failed or was not configured says nothing about the model, and counting it as an abstention
 * would inflate coverage. A target with no measured outcome is skipped for the same reason.
 */
export function buildObservations(
  bias: readonly StoredBiasRow[],
  outcomes: readonly StoredOutcome[],
): { observations: ScoredObservation[]; levels: LevelObservation[] } {
  const outcomeKey = (instrument: string, date: string): string => `${instrument}|${date}`;
  const outcomeByKey = new Map(outcomes.map((o) => [outcomeKey(o.instrument, o.sessionDate), o]));
  const observations: ScoredObservation[] = [];
  const levels: LevelObservation[] = [];

  for (const row of bias) {
    if (row.llmStatus !== "VALIDATED" || !row.assessments) continue;
    for (const assessment of row.assessments) {
      const outcome = outcomeByKey.get(outcomeKey(assessment.instrument, row.assessmentDate));
      if (!outcome) continue;
      for (const target of ["OPENING_GAP", "FIRST_60_MINUTES", "FULL_SESSION"] as const) {
        const actual = actualFor(outcome, target);
        if (actual === null) continue;
        observations.push({
          sessionDate: row.assessmentDate,
          runSlot: row.runSlot,
          instrument: assessment.instrument,
          target,
          llmCall: modelCall(assessment, target),
          baselines: row.baselines[assessment.instrument]?.[target] ?? {},
          actual,
        });
      }
      const selected = new Set(assessment.key_levels.map((level) => level.levelRef));
      for (const touch of outcome.levelTouches) {
        levels.push({ instrument: assessment.instrument, selectedByModel: selected.has(touch.levelRef), touched: touch.touched });
      }
    }
  }
  return { observations, levels };
}

export interface BaselineAccuracyRow {
  target: PremarketTarget;
  instrument: PremarketInstrument | "ALL";
  baseline: BaselineName;
  sessions: number;
  accuracy: number;
}

/**
 * Baseline accuracy over EVERY stored snapshot with a measured outcome, whether or not a model ran.
 * This is the benchmark population: it accrues from the first day, before any API key exists.
 */
export function baselineAccuracy(bias: readonly StoredBiasRow[], outcomes: readonly StoredOutcome[]): BaselineAccuracyRow[] {
  const outcomeByKey = new Map(outcomes.map((o) => [`${o.instrument}|${o.sessionDate}`, o]));
  const tally = new Map<string, { target: PremarketTarget; instrument: PremarketInstrument | "ALL"; baseline: BaselineName; n: number; hit: number }>();
  const add = (target: PremarketTarget, instrument: PremarketInstrument | "ALL", baseline: BaselineName, hit: boolean): void => {
    const key = `${target}|${instrument}|${baseline}`;
    const entry = tally.get(key) ?? { target, instrument, baseline, n: 0, hit: 0 };
    entry.n += 1;
    if (hit) entry.hit += 1;
    tally.set(key, entry);
  };

  for (const row of bias) {
    for (const instrument of PREMARKET_INSTRUMENTS) {
      const outcome = outcomeByKey.get(`${instrument}|${row.assessmentDate}`);
      if (!outcome) continue;
      for (const target of ["OPENING_GAP", "FIRST_60_MINUTES", "FULL_SESSION"] as const) {
        const actual = actualFor(outcome, target);
        if (actual === null) continue;
        for (const [name, call] of Object.entries(row.baselines[instrument]?.[target] ?? {})) {
          if (call === null || call === undefined) continue;
          add(target, instrument, name as BaselineName, call === actual);
          add(target, "ALL", name as BaselineName, call === actual);
        }
      }
    }
  }
  return [...tally.values()].map((e) => ({ target: e.target, instrument: e.instrument, baseline: e.baseline, sessions: e.n, accuracy: e.hit / e.n }));
}

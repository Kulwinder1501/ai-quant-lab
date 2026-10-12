import { istInstant, istSessionDate } from "../../platform/calendar/trading-session.js";
import { measureSession, type SessionOutcome } from "../domain/session-outcome.js";
import type { CandidateLevel } from "../domain/snapshot.js";
import { PREMARKET_INSTRUMENTS, SESSION_CLOSE_MINUTE, type MinuteBar, type PremarketInstrument } from "../domain/targets.js";

/** Bars for the closing minutes land a little after 15:30; measuring earlier would see a half-written window. */
export const SETTLEMENT_BUFFER_MINUTES = 15;

export interface SessionNeedingOutcome {
  sessionDate: string;
  candidateLevels: CandidateLevel[];
}

export interface SessionOutcomeStore {
  /** Sessions with a stored snapshot whose outcome is missing or has unmeasurable targets still worth retrying. */
  listSessionsNeedingOutcome(limit: number): Promise<SessionNeedingOutcome[]>;
  loadMeasurementInputs(instrument: PremarketInstrument, sessionDate: string): Promise<{ previousClose: number | null; bars: MinuteBar[] }>;
  saveOutcome(outcome: SessionOutcome): Promise<void>;
}

export interface SettleSessionOutcomesResult {
  examined: number;
  measured: number;
  /** Sessions whose close (plus buffer) has not passed yet. */
  notYetClosed: number;
  /** Outcomes written with at least one target unmeasurable, by reason, so a gap is attributable. */
  unmeasurableReasons: Record<string, number>;
}

/**
 * Computes the measured session outcomes that stored snapshots are scored against.
 *
 * Idempotent: a session with every target measured is not listed again, and one with a gap is
 * re-measured on later runs in case the missing bars have since been backfilled.
 */
export class SettleSessionOutcomes {
  constructor(
    private readonly store: SessionOutcomeStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(options: { limit?: number } = {}): Promise<SettleSessionOutcomesResult> {
    const limit = options.limit ?? 60;
    if (!Number.isInteger(limit) || limit <= 0) throw new Error("The settlement batch limit must be a positive integer.");

    const sessions = await this.store.listSessionsNeedingOutcome(limit);
    const result: SettleSessionOutcomesResult = { examined: sessions.length, measured: 0, notYetClosed: 0, unmeasurableReasons: {} };
    const nowMs = this.now().getTime();

    for (const session of sessions) {
      const closedAt = istInstant(session.sessionDate, SESSION_CLOSE_MINUTE + SETTLEMENT_BUFFER_MINUTES).getTime();
      if (nowMs < closedAt || session.sessionDate > istSessionDate(this.now())) {
        result.notYetClosed += 1;
        continue;
      }
      for (const instrument of PREMARKET_INSTRUMENTS) {
        const inputs = await this.store.loadMeasurementInputs(instrument, session.sessionDate);
        const outcome = measureSession({
          instrument,
          sessionDate: session.sessionDate,
          previousClose: inputs.previousClose,
          bars: inputs.bars,
          candidateLevels: session.candidateLevels,
        });
        await this.store.saveOutcome(outcome);
        for (const reason of Object.values(outcome.unmeasurable)) {
          result.unmeasurableReasons[reason] = (result.unmeasurableReasons[reason] ?? 0) + 1;
        }
      }
      result.measured += 1;
    }
    return result;
  }
}

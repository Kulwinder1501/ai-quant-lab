import type { DatabaseQueryable } from "../database.js";
import type { PremarketBiasStore, TerminalSnapshotRow, AttemptStatus } from "../../../modules/premarket-intelligence/application/run-premarket-bias.js";
import type { SessionNeedingOutcome, SessionOutcomeStore } from "../../../modules/premarket-intelligence/application/settle-session-outcomes.js";
import type { StoredBiasRow, StoredOutcome } from "../../../modules/premarket-intelligence/domain/observations.js";
import type { DailyBar } from "../../../modules/premarket-intelligence/domain/levels.js";
import type { SessionOutcome } from "../../../modules/premarket-intelligence/domain/session-outcome.js";
import type { CandidateLevel } from "../../../modules/premarket-intelligence/domain/snapshot.js";
import { istInstant } from "../../../modules/platform/calendar/trading-session.js";
import { SESSION_CLOSE_MINUTE, SESSION_OPEN_MINUTE, type MeasuredOutcome, type MinuteBar, type PremarketInstrument } from "../../../modules/premarket-intelligence/domain/targets.js";

/*
 * Every DATE is read as `::text` and written through `$n::date`. node-pg otherwise returns a DATE
 * as a Date at *local* midnight, which on an IST host reads back as the previous calendar day --
 * the defect that graded two opening-gap rows against the wrong session on 2026-10-10.
 */

const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

export class PostgresPremarketBiasRepository implements PremarketBiasStore {
  constructor(private readonly database: DatabaseQueryable) {}

  async hasTerminal(logicalRunKey: string): Promise<boolean> {
    const result = await this.database.query("SELECT 1 FROM daily_market_bias WHERE logical_run_key = $1", [logicalRunKey]);
    return result.rows.length > 0;
  }

  async recordAttempt(input: { runSlot: string; status: AttemptStatus; errorDetails: Record<string, unknown> }): Promise<void> {
    await this.database.query(
      "INSERT INTO daily_market_bias_attempts (run_slot, status, error_details) VALUES ($1, $2, $3::jsonb)",
      [input.runSlot, input.status, JSON.stringify(input.errorDetails)],
    );
  }

  async insertTerminal(row: TerminalSnapshotRow): Promise<boolean> {
    const result = await this.database.query(
      `INSERT INTO daily_market_bias (
         logical_run_key, assessment_date, run_slot, status, llm_status,
         assessments, deterministic_baselines, evidence_manifest, model_metadata
       ) VALUES ($1, $2::date, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb)
       ON CONFLICT (logical_run_key) DO NOTHING
       RETURNING id`,
      [
        row.logicalRunKey, row.assessmentDate, row.runSlot, row.status, row.llmStatus,
        row.assessments === null ? null : JSON.stringify(row.assessments),
        JSON.stringify(row.deterministicBaselines), JSON.stringify(row.evidenceManifest), JSON.stringify(row.modelMetadata),
      ],
    );
    return result.rows.length > 0;
  }

  async listBiasRows(): Promise<StoredBiasRow[]> {
    const result = await this.database.query<{
      assessment_date: string; run_slot: string; llm_status: StoredBiasRow["llmStatus"];
      assessments: StoredBiasRow["assessments"]; deterministic_baselines: StoredBiasRow["baselines"];
    }>(
      `SELECT assessment_date::text AS assessment_date, run_slot, llm_status, assessments, deterministic_baselines
       FROM daily_market_bias WHERE status = 'VALID' ORDER BY assessment_date, run_slot`,
    );
    return result.rows.map((r) => ({
      assessmentDate: r.assessment_date, runSlot: r.run_slot, llmStatus: r.llm_status,
      assessments: r.assessments, baselines: r.deterministic_baselines,
    }));
  }

  async listOutcomes(): Promise<StoredOutcome[]> {
    const result = await this.database.query<{
      instrument_symbol: PremarketInstrument; session_date: string; gap_outcome: MeasuredOutcome | null;
      first60_outcome: MeasuredOutcome | null; full_session_outcome: MeasuredOutcome | null; level_touches: StoredOutcome["levelTouches"];
    }>(
      `SELECT instrument_symbol, session_date::text AS session_date, gap_outcome, first60_outcome, full_session_outcome, level_touches
       FROM market_session_outcomes`,
    );
    return result.rows.map((r) => ({
      instrument: r.instrument_symbol, sessionDate: r.session_date, gapOutcome: r.gap_outcome,
      first60Outcome: r.first60_outcome, fullSessionOutcome: r.full_session_outcome, levelTouches: r.level_touches,
    }));
  }

  /** Completed daily bars strictly before `beforeDate`, oldest first. */
  async dailyBars(instrument: PremarketInstrument, beforeDate: string, count: number): Promise<DailyBar[]> {
    const result = await this.database.query<{ high: string; low: string; close: string }>(
      `SELECT c.high, c.low, c.close
       FROM candles c JOIN instruments i ON i.id = c.instrument_id
       WHERE i.symbol = $1 AND c.timeframe = '1d' AND c.is_complete = TRUE AND c.open_time < $2::date
       ORDER BY c.open_time DESC LIMIT $3`,
      [instrument, beforeDate, count],
    );
    return result.rows.reverse().map((r) => ({ high: Number(r.high), low: Number(r.low), close: Number(r.close) }));
  }
}

export class PostgresSessionOutcomeRepository implements SessionOutcomeStore {
  constructor(private readonly database: DatabaseQueryable) {}

  async listSessionsNeedingOutcome(limit: number): Promise<SessionNeedingOutcome[]> {
    // Complete sessions are skipped. One with an unmeasurable target is retried for ten days in case
    // the missing bars are backfilled, then left as recorded rather than retried for ever.
    const result = await this.database.query<{ session_date: string; levels: CandidateLevel[] | null }>(
      `SELECT DISTINCT ON (b.assessment_date)
         b.assessment_date::text AS session_date, b.evidence_manifest->'candidateLevels' AS levels
       FROM daily_market_bias b
       WHERE b.status = 'VALID' AND (
         (SELECT count(*) FROM market_session_outcomes o WHERE o.session_date = b.assessment_date) < 2
         OR (b.assessment_date >= CURRENT_DATE - 10 AND EXISTS (
              SELECT 1 FROM market_session_outcomes o
              WHERE o.session_date = b.assessment_date AND o.unmeasurable <> '{}'::jsonb))
       )
       ORDER BY b.assessment_date, b.generated_at ASC
       LIMIT $1`,
      [limit],
    );
    return result.rows.map((r) => ({ sessionDate: r.session_date, candidateLevels: r.levels ?? [] }));
  }

  async loadMeasurementInputs(instrument: PremarketInstrument, sessionDate: string): Promise<{ previousClose: number | null; bars: MinuteBar[] }> {
    const previous = await this.database.query<{ close: string }>(
      `SELECT c.close FROM candles c JOIN instruments i ON i.id = c.instrument_id
       WHERE i.symbol = $1 AND c.timeframe = '1d' AND c.is_complete = TRUE AND c.open_time < $2::date
       ORDER BY c.open_time DESC LIMIT 1`,
      [instrument, sessionDate],
    );
    const bars = await this.database.query<{ open_time: Date; open: string; high: string; low: string; close: string; volume: string | null }>(
      `SELECT c.open_time, c.open, c.high, c.low, c.close, c.volume
       FROM candles c JOIN instruments i ON i.id = c.instrument_id
       WHERE i.symbol = $1 AND c.timeframe = '1m' AND c.is_complete = TRUE AND c.open_time >= $2 AND c.open_time < $3
       ORDER BY c.open_time`,
      [instrument, istInstant(sessionDate, SESSION_OPEN_MINUTE), istInstant(sessionDate, SESSION_CLOSE_MINUTE)],
    );
    return {
      previousClose: previous.rows[0] ? Number(previous.rows[0].close) : null,
      bars: bars.rows.map((r) => ({ openTime: r.open_time, open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: num(r.volume) })),
    };
  }

  async saveOutcome(o: SessionOutcome): Promise<void> {
    await this.database.query(
      `INSERT INTO market_session_outcomes (
         instrument_symbol, session_date, previous_close, open_0915, price_1015, closing_vwap,
         gap_return_pct, first60_return_pct, full_session_return_pct,
         gap_outcome, first60_outcome, full_session_outcome, level_touches, unmeasurable
       ) VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb)
       ON CONFLICT (instrument_symbol, session_date) DO UPDATE SET
         previous_close = EXCLUDED.previous_close, open_0915 = EXCLUDED.open_0915, price_1015 = EXCLUDED.price_1015,
         closing_vwap = EXCLUDED.closing_vwap, gap_return_pct = EXCLUDED.gap_return_pct,
         first60_return_pct = EXCLUDED.first60_return_pct, full_session_return_pct = EXCLUDED.full_session_return_pct,
         gap_outcome = EXCLUDED.gap_outcome, first60_outcome = EXCLUDED.first60_outcome,
         full_session_outcome = EXCLUDED.full_session_outcome, level_touches = EXCLUDED.level_touches,
         unmeasurable = EXCLUDED.unmeasurable, computed_at = NOW()
       WHERE market_session_outcomes.unmeasurable <> '{}'::jsonb`,
      [
        o.instrument, o.sessionDate, o.previousClose, o.open0915, o.price1015, o.closingVwap,
        o.gapReturnPct, o.first60ReturnPct, o.fullSessionReturnPct,
        o.gapOutcome, o.first60Outcome, o.fullSessionOutcome,
        JSON.stringify(o.levelTouches), JSON.stringify(o.unmeasurable),
      ],
    );
  }
}

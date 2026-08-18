import type { QueryResultRow } from "pg";
import type { CandidateSettlement } from "../../../modules/paper-trading/domain/candidate-settlement.js";
import type { CompletedPriceCandle } from "../../../modules/paper-trading/domain/paper-trade-exit-policy.js";
import type { TradeSide } from "../../../modules/strategy-engine/domain/strategy.js";
import type { DatabaseQueryable } from "../database.js";

export interface UnsettledCandidate {
  readonly tradeIdeaId: string;
  readonly instrumentId: string;
  readonly timeframe: string;
  readonly side: TradeSide;
  readonly entryPrice: number;
  readonly stopLoss: number;
  readonly targetPrice: number;
  readonly horizonEnd: Date;
  /** Close of the bar the signal was raised on. Forward bars are those closing strictly after it. */
  readonly signalBarCloseTime: Date;
}

export interface CandidateDecisionInput {
  readonly tradeIdeaId: string;
  readonly accountId: string;
  readonly decidedAt: Date;
  readonly decision: "EXECUTED" | "REFUSED";
  readonly reason: string;
  readonly explanation?: string;
  readonly paperTradeId?: string | null;
  readonly regimeObservationId?: string | null;
}

interface CandidateRow extends QueryResultRow {
  id: string;
  instrument_id: string;
  timeframe: string;
  side: TradeSide;
  entry_price: string;
  stop_loss: string;
  target_price: string;
  expires_at: Date;
  signal_bar_close_time: Date;
}

interface BarRow extends QueryResultRow {
  id: string;
  open_time: Date;
  close_time: Date;
  open: string;
  high: string;
  low: string;
  close: string;
}

function toNumber(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Database returned an invalid numeric ${field}.`);
  return parsed;
}

/**
 * Append-only writer and reader for the candidate ledger.
 *
 * No update and no delete on either table. The point of recording what was decided and what the
 * candidate then did is that the record stays what it was; a method that could revise one would
 * defeat it.
 */
export class PostgresCandidateLedgerRepository {
  constructor(private readonly database: DatabaseQueryable) {}

  /**
   * Records one account's decision about one candidate.
   *
   * Not deduplicated. The bot re-evaluates a live candidate every cycle, so one idea legitimately
   * draws several decisions, and "refused nine times for the same reason" says the signal persisted --
   * which collapsing the rows would erase.
   */
  async recordDecision(input: CandidateDecisionInput): Promise<void> {
    await this.database.query(`
      INSERT INTO candidate_decisions (
        trade_idea_id, account_id, decided_at, decision, reason, explanation,
        paper_trade_id, regime_observation_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      input.tradeIdeaId, input.accountId, input.decidedAt, input.decision, input.reason,
      input.explanation ?? "", input.paperTradeId ?? null, input.regimeObservationId ?? null,
    ]);
  }

  /**
   * Records a settlement, or leaves the existing one alone.
   *
   * First-writer-wins on the candidate. A re-run of the sweep must not overwrite a verdict reached
   * when the series was in a different state -- particularly not replace a settled outcome with
   * UNSETTLEABLE after a series is pruned, which would erase a measurement rather than record one.
   * Returns whether a row was written, so a sweep can report how much was genuinely new.
   */
  async recordSettlement(tradeIdeaId: string, settlement: CandidateSettlement): Promise<boolean> {
    const result = await this.database.query<{ id: string }>(`
      INSERT INTO candidate_settlements (
        trade_idea_id, outcome, r_multiple, bars_to_resolution, mae_r, mfe_r,
        horizon_end, resolved_timeframe, bars_available, resolver_version
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (trade_idea_id) DO NOTHING
      RETURNING id
    `, [
      tradeIdeaId, settlement.outcome, settlement.rMultiple, settlement.barsToResolution,
      settlement.maeR, settlement.mfeR, settlement.horizonEnd, settlement.resolvedTimeframe,
      settlement.barsAvailable, settlement.resolverVersion,
    ]);
    return result.rows.length > 0;
  }

  /**
   * Candidates whose horizon has fully elapsed and which carry no settlement yet.
   *
   * Ordered by series so a caller can load each instrument-and-timeframe's bars once instead of once
   * per candidate. Over a backfill that is the difference between one query per series and one per
   * idea.
   *
   * An idea without an `expires_at` or without a source candle is skipped rather than settled: the
   * horizon and the anchor bar are both required, and inventing either would produce a verdict about
   * a window nobody chose.
   */
  async listUnsettledCandidates(input: { settledBefore: Date; limit: number }): Promise<UnsettledCandidate[]> {
    const result = await this.database.query<CandidateRow>(`
      SELECT
        trade_ideas.id,
        trade_ideas.instrument_id,
        candles.timeframe,
        trade_ideas.side,
        trade_ideas.entry_price,
        trade_ideas.stop_loss,
        trade_ideas.target_price,
        trade_ideas.expires_at,
        candles.close_time AS signal_bar_close_time
      FROM trade_ideas
      INNER JOIN candles ON candles.id = trade_ideas.source_candle_id
      LEFT JOIN candidate_settlements ON candidate_settlements.trade_idea_id = trade_ideas.id
      WHERE candidate_settlements.id IS NULL
        AND trade_ideas.expires_at IS NOT NULL
        AND trade_ideas.expires_at <= $1
      ORDER BY trade_ideas.instrument_id, candles.timeframe, trade_ideas.expires_at
      LIMIT $2
    `, [input.settledBefore, Math.max(1, Math.floor(input.limit))]);

    return result.rows.map((row) => ({
      tradeIdeaId: row.id,
      instrumentId: row.instrument_id,
      timeframe: row.timeframe,
      side: row.side,
      entryPrice: toNumber(row.entry_price, "candidate entry price"),
      stopLoss: toNumber(row.stop_loss, "candidate stop loss"),
      targetPrice: toNumber(row.target_price, "candidate target price"),
      horizonEnd: row.expires_at,
      signalBarCloseTime: row.signal_bar_close_time,
    }));
  }

  /**
   * Completed bars for one series inside a window, chronological.
   *
   * `close_time <= CURRENT_TIMESTAMP` matches the rule the strategy context reader uses: Yahoo
   * imports mark the still-forming session bar complete, so `is_complete` alone would hand back a bar
   * whose close has not happened yet.
   */
  async listForwardBars(input: {
    instrumentId: string;
    timeframe: string;
    after: Date;
    through: Date;
  }): Promise<CompletedPriceCandle[]> {
    const result = await this.database.query<BarRow>(`
      SELECT id, open_time, close_time, open, high, low, close
      FROM candles
      WHERE instrument_id = $1
        AND timeframe = $2
        AND is_complete = TRUE
        AND close_time <= CURRENT_TIMESTAMP
        AND close_time > $3
        AND close_time <= $4
      ORDER BY close_time ASC
    `, [input.instrumentId, input.timeframe, input.after, input.through]);

    return result.rows.map((row) => ({
      id: row.id,
      openTime: row.open_time,
      closeTime: row.close_time,
      open: toNumber(row.open, "bar open"),
      high: toNumber(row.high, "bar high"),
      low: toNumber(row.low, "bar low"),
      close: toNumber(row.close, "bar close"),
    }));
  }
}

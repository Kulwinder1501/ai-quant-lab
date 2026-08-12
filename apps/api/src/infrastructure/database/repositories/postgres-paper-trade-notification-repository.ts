import type { QueryResultRow } from "pg";
import type { DatabaseQueryable } from "../database.js";

export type AutomatedTradeSource = "PAPER_BOT" | "AUTONOMOUS_AGENT" | "VOLATILITY_BOT";

export interface AutomatedTradeOpenedNotification {
  eventId: string;
  paperTradeId: string;
  source: AutomatedTradeSource;
  accountId: string;
  accountName: string;
  instrumentSymbol: string;
  timeframe: string | null;
  side: "LONG" | "SHORT";
  quantity: number;
  entryPrice: number;
  stopLoss: number;
  targetPrice: number;
  occurredAt: string;
  optionStrike: number | null;
  optionExpiry: string | null;
  optionType: "CE" | "PE" | null;
  underlyingSymbol: string | null;
}

interface AutomatedTradeOpenedRow extends QueryResultRow {
  event_id: string;
  paper_trade_id: string;
  source: AutomatedTradeSource;
  account_id: string;
  account_name: string;
  instrument_symbol: string;
  timeframe: string | null;
  side: "LONG" | "SHORT";
  quantity: string | number;
  entry_price: string | number;
  stop_loss: string | number;
  target_price: string | number;
  occurred_at: Date | string;
  option_strike: string | number | null;
  option_expiry: Date | string | null;
  option_type: "CE" | "PE" | null;
  underlying_symbol: string | null;
}

function finiteNumber(value: string | number, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${field} in automated trade event.`);
  return parsed;
}

function optionalNumber(value: string | number | null, field: string): number | null {
  return value === null ? null : finiteNumber(value, field);
}

function isoTimestamp(value: Date | string, field: string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid ${field} in automated trade event.`);
  return parsed.toISOString();
}

/**
 * Read-side projection for UI notifications.
 *
 * The bot, autonomous agent, and volatility structure runner already commit an OPENED event in
 * the same transaction as every position. Polling that immutable ledger keeps delivery out of
 * the execution path: a closed browser or failed SSE connection can never delay or roll back a
 * trade. Source is derived from the existing account/note conventions until paper trades gain a
 * first-class execution-source column.
 */
export class PostgresPaperTradeNotificationRepository {
  constructor(private readonly database: DatabaseQueryable) {}

  async listRecentAutomatedOpens(limit = 50): Promise<AutomatedTradeOpenedNotification[]> {
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const result = await this.database.query<AutomatedTradeOpenedRow>(`
      SELECT
        event.id AS event_id,
        event.paper_trade_id,
        CASE
          WHEN account.name = 'AutoBot' OR trade.notes LIKE 'Opened by AutoBot %' THEN 'PAPER_BOT'
          WHEN trade.notes LIKE 'AI Autonomous Execution (%' THEN 'AUTONOMOUS_AGENT'
          WHEN trade.notes LIKE 'Atomic volatility straddle %' THEN 'VOLATILITY_BOT'
        END AS source,
        account.id AS account_id,
        account.name AS account_name,
        instrument.symbol AS instrument_symbol,
        source_candle.timeframe,
        trade.side,
        event.quantity,
        event.price AS entry_price,
        trade.stop_loss,
        trade.target_price,
        event.occurred_at,
        trade.option_strike,
        trade.option_expiry,
        trade.option_type,
        trade.underlying_symbol
      FROM paper_trade_events event
      INNER JOIN paper_trades trade ON trade.id = event.paper_trade_id
      INNER JOIN paper_accounts account ON account.id = trade.account_id
      INNER JOIN instruments instrument ON instrument.id = trade.instrument_id
      LEFT JOIN trade_ideas idea ON idea.id = trade.trade_idea_id
      LEFT JOIN candles source_candle ON source_candle.id = idea.source_candle_id
      WHERE event.event_type = 'OPENED'
        AND (
          account.name = 'AutoBot'
          OR trade.notes LIKE 'Opened by AutoBot %'
          OR trade.notes LIKE 'AI Autonomous Execution (%'
          OR trade.notes LIKE 'Atomic volatility straddle %'
        )
      ORDER BY event.occurred_at DESC, event.id DESC
      LIMIT $1
    `, [boundedLimit]);

    return result.rows.map((row) => ({
      eventId: row.event_id,
      paperTradeId: row.paper_trade_id,
      source: row.source,
      accountId: row.account_id,
      accountName: row.account_name,
      instrumentSymbol: row.instrument_symbol,
      timeframe: row.timeframe,
      side: row.side,
      quantity: finiteNumber(row.quantity, "quantity"),
      entryPrice: finiteNumber(row.entry_price, "entry price"),
      stopLoss: finiteNumber(row.stop_loss, "stop loss"),
      targetPrice: finiteNumber(row.target_price, "target price"),
      occurredAt: isoTimestamp(row.occurred_at, "occurred-at timestamp"),
      optionStrike: optionalNumber(row.option_strike, "option strike"),
      optionExpiry: row.option_expiry === null
        ? null
        : isoTimestamp(row.option_expiry, "option expiry"),
      optionType: row.option_type,
      underlyingSymbol: row.underlying_symbol,
    }));
  }
}

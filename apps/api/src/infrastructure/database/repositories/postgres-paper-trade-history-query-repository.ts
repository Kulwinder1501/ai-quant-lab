import type { QueryResultRow } from "pg";
import {
  deriveTradeOutcome,
  type ListPaperTradeHistoryInput,
  type PaperTradeHistoryQueryRepository,
  type PaperTradeHistoryRecord,
} from "../../../modules/paper-trading/domain/paper-trade-history.js";
import type { PaperTradeExitReason, PaperTradeStatus } from "../../../modules/paper-trading/domain/paper-trading.js";
import type { TradeSide } from "../../../modules/strategy-engine/domain/strategy.js";
import type { DatabaseQueryable } from "../database.js";

interface TradeHistoryRow extends QueryResultRow {
  id: string;
  account_id: string;
  account_name: string;
  instrument_id: string;
  instrument_symbol: string;
  instrument_name: string;
  timeframe: string | null;
  trade_idea_id: string | null;
  side: TradeSide;
  status: PaperTradeStatus;
  quantity: string | number;
  entry_price: string | number;
  stop_loss: string | number;
  target_price: string | number;
  opened_at: Date | string;
  closed_at: Date | string | null;
  exit_price: string | number | null;
  exit_reason: PaperTradeExitReason | null;
  realized_pnl: string | number | null;
  fees: string | number;
  slippage: string | number;
  notes: string | null;
  option_type: "CE" | "PE" | null;
  option_strike: string | number | null;
  underlying_symbol: string | null;
}

function asFiniteNumber(value: string | number, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Database returned an invalid ${field}.`);
  }
  return parsed;
}

function asOptionalNumber(value: string | number | null, field: string): number | null {
  return value === null ? null : asFiniteNumber(value, field);
}

function asDate(value: Date | string, field: string): Date {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Database returned an invalid ${field}.`);
  }
  return parsed;
}

function toRecord(row: TradeHistoryRow): PaperTradeHistoryRecord {
  const quantity = asFiniteNumber(row.quantity, "paper trade quantity");
  const entryPrice = asFiniteNumber(row.entry_price, "paper trade entry price");
  const stopLoss = asFiniteNumber(row.stop_loss, "paper trade stop loss");
  const realizedPnl = asOptionalNumber(row.realized_pnl, "paper trade realized P&L");
  const openedAt = asDate(row.opened_at, "paper trade opened at");
  const closedAt = row.closed_at === null ? null : asDate(row.closed_at, "paper trade closed at");

  // The derived figures live in the domain so their semantics are unit-tested
  // independently of any database row.
  const outcome = deriveTradeOutcome({ entryPrice, stopLoss, quantity, realizedPnl, openedAt, closedAt });

  return {
    simulatedOnly: true,
    id: row.id,
    accountId: row.account_id,
    accountName: row.account_name,
    instrumentId: row.instrument_id,
    instrumentSymbol: row.instrument_symbol,
    instrumentName: row.instrument_name,
    timeframe: row.timeframe,
    tradeIdeaId: row.trade_idea_id,
    side: row.side,
    status: row.status,
    quantity,
    entryPrice,
    stopLoss,
    targetPrice: asFiniteNumber(row.target_price, "paper trade target price"),
    openedAt,
    closedAt,
    exitPrice: asOptionalNumber(row.exit_price, "paper trade exit price"),
    exitReason: row.exit_reason,
    realizedPnl,
    returnPercent: outcome.returnPercent,
    rewardMultiple: outcome.rewardMultiple,
    holdingMinutes: outcome.holdingMinutes,
    fees: asFiniteNumber(row.fees, "paper trade fees"),
    slippage: asFiniteNumber(row.slippage, "paper trade slippage"),
    notes: row.notes ?? "",
    optionType: row.option_type,
    optionStrike: asOptionalNumber(row.option_strike, "paper trade option strike"),
    underlyingSymbol: row.underlying_symbol,
  };
}

/**
 * Query-only access to the simulated-trade ledger.
 *
 * Every statement here is a SELECT. This repository has no insert, update, or
 * delete path, so the Trade History view cannot alter paper activity.
 */
export class PostgresPaperTradeHistoryQueryRepository implements PaperTradeHistoryQueryRepository {
  constructor(private readonly database: DatabaseQueryable) {}

  async list(input: ListPaperTradeHistoryInput): Promise<PaperTradeHistoryRecord[]> {
    const conditions: string[] = [];
    const parameters: unknown[] = [];

    if (input.accountId !== undefined) {
      parameters.push(input.accountId);
      conditions.push(`pt.account_id = $${parameters.length}`);
    }
    if (input.instrumentSymbol !== undefined) {
      parameters.push(input.instrumentSymbol);
      conditions.push(`i.symbol = $${parameters.length}`);
    }
    if (input.status !== undefined) {
      parameters.push(input.status);
      conditions.push(`pt.status = $${parameters.length}`);
    }
    if (input.side !== undefined) {
      parameters.push(input.side);
      conditions.push(`pt.side = $${parameters.length}`);
    }
    if (input.exitReason !== undefined) {
      parameters.push(input.exitReason);
      conditions.push(`pt.exit_reason = $${parameters.length}`);
    }
    if (input.openedFrom !== undefined) {
      parameters.push(input.openedFrom);
      conditions.push(`pt.opened_at >= $${parameters.length}`);
    }
    if (input.openedTo !== undefined) {
      parameters.push(input.openedTo);
      conditions.push(`pt.opened_at <= $${parameters.length}`);
    }
    if (input.activityFrom !== undefined && input.activityToExclusive !== undefined) {
      parameters.push(input.activityFrom, input.activityToExclusive);
      const fromParameter = parameters.length - 1;
      const toParameter = parameters.length;
      conditions.push(`(
        (pt.opened_at >= $${fromParameter} AND pt.opened_at < $${toParameter})
        OR (pt.closed_at >= $${fromParameter} AND pt.closed_at < $${toParameter})
      )`);
    }
    if (input.outcome === "WIN") {
      conditions.push("pt.realized_pnl > 0");
    } else if (input.outcome === "LOSS") {
      conditions.push("pt.realized_pnl < 0");
    } else if (input.outcome === "BREAK_EVEN") {
      conditions.push("pt.realized_pnl = 0");
    }
    parameters.push(input.limit);

    const result = await this.database.query<TradeHistoryRow>(`
      SELECT
        pt.id,
        pt.account_id,
        pa.name AS account_name,
        pt.instrument_id,
        i.symbol AS instrument_symbol,
        i.display_name AS instrument_name,
        COALESCE(c.timeframe, CASE WHEN ti.evidence->>'strategy' = 'momentum-scalp' THEN '1m' ELSE '1d' END) AS timeframe,
        pt.trade_idea_id,
        pt.side,
        pt.status,
        pt.quantity,
        pt.entry_price,
        pt.stop_loss,
        pt.target_price,
        pt.opened_at,
        pt.closed_at,
        pt.exit_price,
        pt.exit_reason,
        pt.realized_pnl,
        pt.fees,
        pt.slippage,
        pt.notes,
        -- The contract, not just the instrument. Every option position is booked side=LONG
        -- because the bot only ever buys, so the ledger's side column cannot separate a call
        -- from a put and a reader cannot tell which trade a row describes.
        pt.option_type,
        pt.option_strike,
        pt.underlying_symbol
      FROM paper_trades pt
      INNER JOIN paper_accounts pa ON pa.id = pt.account_id
      INNER JOIN instruments i ON i.id = pt.instrument_id
      LEFT JOIN trade_ideas ti ON ti.id = pt.trade_idea_id
      LEFT JOIN candles c ON c.id = ti.source_candle_id
      ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY pt.opened_at DESC, pt.id DESC
      LIMIT $${parameters.length}
    `, parameters);

    return result.rows.map(toRecord);
  }

  async listAccountNames(): Promise<Array<{ id: string; name: string }>> {
    const result = await this.database.query<QueryResultRow>(`
      SELECT id, name
      FROM paper_accounts
      ORDER BY name ASC
    `);
    return result.rows.map((row) => ({ id: String(row.id), name: String(row.name) }));
  }
}

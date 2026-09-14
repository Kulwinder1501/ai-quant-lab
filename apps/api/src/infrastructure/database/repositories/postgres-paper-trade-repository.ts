import type { QueryResultRow } from "pg";
import type {
  ClosePaperTradeInput,
  OpenPaperTradeInput,
  PaperAccount,
  PaperAccountPerformanceData,
  PaperTrade,
  PaperTradeEventType,
  PaperTradeExitReason,
  PaperTradeRepository,
} from "../../../modules/paper-trading/domain/paper-trading.js";
import { validateQuantity } from "../../../modules/paper-trading/domain/lot-size-validator.js";
import { decideDailyTradeCap, istTradingDayWindow } from "../../../modules/paper-trading/domain/daily-trade-cap.js";
import {
  DailyTradeCapReachedError,
  TradeIdeaAlreadyTakenError,
  TradeIdeaExpiredError,
  TradeIdeaUnavailableError,
} from "../../../modules/paper-trading/domain/paper-trade-open-errors.js";
import type { TradeSide } from "../../../modules/strategy-engine/domain/strategy.js";
import type { DatabaseClient, DatabasePool } from "../database.js";

interface PaperAccountRow extends QueryResultRow {
  id: string;
  name: string;
  opening_balance: string;
  currency: "INR";
  is_active: boolean;
}

interface LockedTradeIdeaRow extends QueryResultRow {
  id: string;
  instrument_id: string;
  side: TradeSide;
  entry_price: string;
  stop_loss: string;
  target_price: string;
  expires_at: Date | null;
}

interface PaperTradeRow extends QueryResultRow {
  id: string;
  account_id: string;
  trade_idea_id: string | null;
  instrument_id: string;
  timeframe: string | null;
  strategy_key: string | null;
  side: TradeSide;
  status: PaperTrade["status"];
  quantity: string;
  remaining_quantity?: string | null;
  entry_price: string;
  stop_loss: string;
  stop_loss_effective_at: Date;
  target_price: string;
  opened_at: Date;
  closed_at: Date | null;
  exit_price: string | null;
  exit_reason: PaperTradeExitReason | null;
  realized_pnl: string | null;
  fees: string;
  fee_breakdown: Record<string, unknown> | null;
  slippage: string;
  notes: string;
  instrument_symbol?: string;
  option_strike: string | null;
  option_expiry: Date | null;
  option_type: "CE" | "PE" | null;
  underlying_symbol: string | null;
  underlying_entry_price: string | null;
  underlying_exit_price: string | null;
  entry_iv: string | null;
  regime_observation_id: string | null;
}

interface CapitalRow extends QueryResultRow {
  available_capital: string;
}

interface ClosedTradeUpdateRow extends QueryResultRow {
  id: string;
  realized_pnl: string;
  fees: string;
  slippage: string;
}

export interface OpenManualOptionTradeInput extends Omit<OpenPaperTradeInput, "tradeIdeaId"> {
  instrumentId: string;
}

// Re-exported so existing importers keep working; the definitions moved to the domain, because
// whether a failure is ordinary or a fault decides whether a bot cycle continues and is not a
// database detail.
export {
  DailyTradeCapReachedError,
  TradeIdeaAlreadyTakenError,
  TradeIdeaExpiredError,
  TradeIdeaUnavailableError,
};

const accountColumns = "id, name, opening_balance, currency, is_active";
const tradeColumns = `
  paper_trades.id,
  paper_trades.account_id,
  paper_trades.trade_idea_id,
  paper_trades.instrument_id,
  source_candle.timeframe,
  -- The strategy that actually produced this trade.
  --
  -- Selected because the dashboard was inventing it: active-positions-table.tsx rendered
  -- trade.timeframe === "1m" ? "momentum-scalp" : "trend-breakout", so every non-1m position was
  -- labelled trend-breakout -- a strategy that is TERMINAL_UNOWNED and traded by no bot. A live 5m
  -- Sniper position from momentum-scalp-pattern displayed as trend-breakout, which is an
  -- attribution the data never made.
  strategies.strategy_key,
  paper_trades.side,
  paper_trades.status,
  paper_trades.quantity,
  paper_trades.remaining_quantity,
  paper_trades.entry_price,
  paper_trades.stop_loss,
  paper_trades.stop_loss_effective_at,
  paper_trades.target_price,
  paper_trades.opened_at,
  paper_trades.closed_at,
  paper_trades.exit_price,
  paper_trades.exit_reason,
  paper_trades.realized_pnl,
  paper_trades.fees,
  paper_trades.fee_breakdown,
  paper_trades.slippage,
  paper_trades.notes,
  paper_trades.option_strike,
  paper_trades.option_expiry,
  paper_trades.option_type,
  paper_trades.underlying_symbol,
  paper_trades.underlying_entry_price,
  paper_trades.underlying_exit_price,
  paper_trades.entry_iv,
  paper_trades.regime_observation_id
`;

function toNumber(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Database returned an invalid numeric ${field}.`);
  }
  return parsed;
}

function toPaperAccount(row: PaperAccountRow): PaperAccount {
  return {
    id: row.id,
    name: row.name,
    openingBalance: toNumber(row.opening_balance, "opening balance"),
    currency: row.currency,
    isActive: row.is_active,
  };
}

function toPaperTrade(row: PaperTradeRow): PaperTrade {
  return {
    id: row.id,
    accountId: row.account_id,
    tradeIdeaId: row.trade_idea_id,
    instrumentId: row.instrument_id,
    instrumentSymbol: row.instrument_symbol,
    timeframe: row.timeframe,
    strategyKey: row.strategy_key,
    side: row.side,
    status: row.status,
    quantity: toNumber(row.quantity, "trade quantity"),
    remainingQuantity: row.remaining_quantity !== null && row.remaining_quantity !== undefined
      ? toNumber(row.remaining_quantity, "trade remaining quantity")
      : toNumber(row.quantity, "trade quantity"),
    entryPrice: toNumber(row.entry_price, "trade entry price"),
    stopLoss: toNumber(row.stop_loss, "trade stop loss"),
    stopLossEffectiveAt: row.stop_loss_effective_at,
    targetPrice: toNumber(row.target_price, "trade target price"),
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    exitPrice: row.exit_price === null ? null : toNumber(row.exit_price, "trade exit price"),
    exitReason: row.exit_reason,
    realizedPnl: row.realized_pnl === null ? null : toNumber(row.realized_pnl, "realized P/L"),
    fees: toNumber(row.fees, "trade fees"),
    feeBreakdown: row.fee_breakdown && typeof row.fee_breakdown === "object" ? row.fee_breakdown : {},
    slippage: toNumber(row.slippage, "trade slippage"),
    notes: row.notes,
    optionStrike: row.option_strike === null || row.option_strike === undefined
      ? null
      : toNumber(row.option_strike, "option strike"),
    optionExpiry: row.option_expiry ?? null,
    optionType: row.option_type ?? null,
    underlyingSymbol: row.underlying_symbol ?? null,
    underlyingEntryPrice: row.underlying_entry_price === null || row.underlying_entry_price === undefined
      ? null
      : toNumber(row.underlying_entry_price, "underlying entry price"),
    underlyingExitPrice: row.underlying_exit_price === null || row.underlying_exit_price === undefined
      ? null
      : toNumber(row.underlying_exit_price, "underlying exit price"),
    entryIv: row.entry_iv === null || row.entry_iv === undefined
      ? null
      : toNumber(row.entry_iv, "entry IV"),
    regimeObservationId: row.regime_observation_id ?? null,
  };
}

function assertPositiveFinite(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a positive finite number.`);
  }
}

function assertNonNegativeFinite(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative finite number.`);
  }
}

function assertDate(value: Date, field: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`${field} must be a valid date.`);
  }
}

function hasGeometryForFill(side: TradeSide, fillPrice: number, stopLoss: number, targetPrice: number): boolean {
  return side === "LONG"
    ? stopLoss < fillPrice && fillPrice < targetPrice
    : targetPrice < fillPrice && fillPrice < stopLoss;
}

function exitEventType(reason: PaperTradeExitReason): PaperTradeEventType {
  switch (reason) {
    case "STOP_LOSS":
      return "STOP_LOSS_HIT";
    case "TARGET":
    case "T1_TARGET":
    case "T2_TARGET":
      return "TARGET_HIT";
    case "MANUAL":
    case "MOMENTUM_STALL":
    case "RUNNER_TRAIL":
    // A rule closed it, not a barrier. Grouping it with the barrier hits would inflate the
    // measured stop and target rates with exits the market never reached.
    case "SESSION_CLOSE":
      return "MANUALLY_CLOSED";
    case "CANCELLED":
      return "CANCELLED";
    case "EXPIRED":
      return "EXPIRED";
    case "TRAP_DETECTED":
      return "TRAP_DETECTED";
  }
}

async function findPaperTradeById(database: DatabaseClient, id: string): Promise<PaperTrade | null> {
  const result = await database.query<PaperTradeRow>(`
    SELECT ${tradeColumns}
    FROM paper_trades
    LEFT JOIN trade_ideas ON trade_ideas.id = paper_trades.trade_idea_id
    LEFT JOIN candles AS source_candle ON source_candle.id = trade_ideas.source_candle_id
    LEFT JOIN strategy_versions ON strategy_versions.id = trade_ideas.strategy_version_id
    LEFT JOIN strategies ON strategies.id = strategy_versions.strategy_id
    WHERE paper_trades.id = $1
  `, [id]);
  return result.rows[0] ? toPaperTrade(result.rows[0]) : null;
}

/**
 * Records only local paper-trade state. The account row lock serialises fills
 * so available capital cannot be over-committed by concurrent acceptances.
 */
export class PostgresPaperTradeRepository implements PaperTradeRepository {
  constructor(private readonly database: DatabasePool) {}

  async openFromTradeIdea(input: OpenPaperTradeInput): Promise<PaperTrade> {
    const client = await this.database.connect();
    let transactionStarted = false;
    try {
      await client.query("BEGIN");
      transactionStarted = true;
      const trade = await this.openFromTradeIdeaWithinTransaction(client, input);
      await client.query("COMMIT");
      transactionStarted = false;
      return trade;
    } catch (error) {
      if (transactionStarted) {
        if (error instanceof TradeIdeaExpiredError) {
          await client.query("COMMIT");
        } else {
          await client.query("ROLLBACK");
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Opens both legs of a paper structure in one database transaction.
   *
   * If either idea, capital check, contract constraint, or insert fails, neither leg exists.
   * This is intentionally concrete-repository functionality: the generic paper-trade domain
   * does not claim every pair of trades is a structure.
   */
  async openPairFromTradeIdeas(
    inputs: readonly [OpenPaperTradeInput, OpenPaperTradeInput],
  ): Promise<readonly [PaperTrade, PaperTrade]> {
    if (inputs[0].accountId !== inputs[1].accountId) {
      throw new Error("Atomic option-pair legs must use the same paper account.");
    }
    const client = await this.database.connect();
    let transactionStarted = false;
    try {
      await client.query("BEGIN");
      transactionStarted = true;
      const first = await this.openFromTradeIdeaWithinTransaction(client, inputs[0]);
      const second = await this.openFromTradeIdeaWithinTransaction(client, inputs[1]);
      await client.query("COMMIT");
      transactionStarted = false;
      return [first, second];
    } catch (error) {
      if (transactionStarted) await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Creates the synthetic idea and opens its trade in one database transaction. */
  async openManualOption(input: OpenManualOptionTradeInput): Promise<PaperTrade> {
    const client = await this.database.connect();
    let transactionStarted = false;
    try {
      await client.query("BEGIN");
      transactionStarted = true;
      const ideaResult = await client.query<{ id: string }>(`
        INSERT INTO trade_ideas (
          instrument_id, strategy_version_id, source_candle_id, side, status,
          entry_price, stop_loss, target_price, risk_reward, confidence,
          reasoning, evidence, expires_at
        ) VALUES (
          $1, NULL, NULL, 'LONG', 'PROPOSED', $2, $3, $4, 2.0, 1.0,
          '["Manual options chain trade"]'::jsonb, '{}'::jsonb, NOW() + INTERVAL '1 day'
        ) RETURNING id
      `, [input.instrumentId, input.fillPrice, input.fillPrice * 0.5, input.fillPrice * 2]);
      const tradeIdeaId = ideaResult.rows[0]?.id;
      if (!tradeIdeaId) {
        throw new Error("Manual trade idea creation returned no id.");
      }
      const trade = await this.openFromTradeIdeaWithinTransaction(client, { ...input, tradeIdeaId });
      await client.query("COMMIT");
      transactionStarted = false;
      return trade;
    } catch (error) {
      if (transactionStarted) {
        await client.query("ROLLBACK");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async openFromTradeIdeaWithinTransaction(
    client: DatabaseClient,
    input: OpenPaperTradeInput,
  ): Promise<PaperTrade> {
    assertPositiveFinite(input.quantity, "Quantity");
    assertPositiveFinite(input.fillPrice, "Fill price");
    assertNonNegativeFinite(input.entryFees, "Entry fees");
    assertNonNegativeFinite(input.entrySlippage, "Entry slippage");
    assertDate(input.openedAt, "Opened at");

    const accountResult = await client.query<PaperAccountRow & { daily_trade_cap: number | null }>(`
      SELECT ${accountColumns}, daily_trade_cap
      FROM paper_accounts
      WHERE id = $1 AND is_active = TRUE
      FOR UPDATE
    `, [input.accountId]);
    const account = accountResult.rows[0];
    if (!account) {
      throw new Error("Paper account was not found or is inactive.");
    }

    /*
     * Daily throughput cap.
     *
     * Placed here because the `FOR UPDATE` above already holds the account row for the rest of the
     * transaction, which serialises every open on this account: two concurrent bot cycles cannot
     * both read the same count and both insert. No advisory lock or capacity table is needed -- the
     * lock that makes this safe was already in the right place, and the count stays derived from
     * `paper_trades` so it cannot drift from the trades it describes.
     *
     * Every row in the window counts, whatever its status and whether or not it is excluded from
     * evidence. The cap bounds actions taken; `excluded_from_evidence` governs whether a trade
     * informs P&L evidence, not whether it happened. Counting only OPEN rows would make the cap
     * evadable by the churn it exists to bound.
     *
     * For a two-leg structure this reads the transaction's own uncommitted first leg, so a straddle
     * that would cross the cap on its second leg rolls back whole. Both legs or neither is the only
     * correct outcome for a straddle.
     */
    const dailyTradeCap = account.daily_trade_cap === null || account.daily_trade_cap === undefined
      ? null
      : Number(account.daily_trade_cap);
    if (dailyTradeCap !== null) {
      const tradingDay = istTradingDayWindow(input.openedAt);
      const openedTodayResult = await client.query<{ opened_today: string }>(`
        SELECT COUNT(*) AS opened_today
        FROM paper_trades
        WHERE account_id = $1
          AND opened_at >= $2
          AND opened_at < $3
      `, [input.accountId, tradingDay.start, tradingDay.end]);
      const openedToday = Number(openedTodayResult.rows[0]?.opened_today ?? 0);
      const capDecision = decideDailyTradeCap({ openedToday, cap: dailyTradeCap });
      if (!capDecision.allowed) {
        throw new DailyTradeCapReachedError(
          `Account ${account.name} has opened ${openedToday} trade(s) on ${tradingDay.istDate}, `
          + `reaching its daily cap of ${dailyTradeCap}.`,
        );
      }
    }

    /*
     * ACCEPTED is admitted, so a second account can act on a signal a first account already took.
     *
     * This read `status = 'PROPOSED'` only until 2026-08-18, which made one idea one position
     * *globally* rather than per account. That silently broke the experiment the two bots exist for:
     * whichever bot was iterated first consumed every shared signal, so the other's sample of the
     * shared strategy was exactly the ideas the first had declined -- usually because it was at its
     * concurrent-position limit. Measured: no idea had ever produced more than one trade.
     *
     * `ACCEPTED` was carrying two meanings. "Some account has acted on this" has real readers: the
     * generator's upsert is `DO UPDATE ... WHERE trade_ideas.status = 'PROPOSED'`, so an accepted
     * idea's stop and target can no longer be rewritten under the account holding it, and
     * `trade_ideas_open_idx` already counts ACCEPTED as an open idea. "This idea is spent" had no
     * reader anywhere except this gate. Only the first meaning survives.
     *
     * `FOR UPDATE OF trade_ideas` does the serialising: a second account blocks here until the first
     * commits, then reads the ACCEPTED row rather than an empty result. EXPIRED and REJECTED stay
     * excluded, so the expiry check below is still a real bound on how long a signal is actionable --
     * and every idea in the last day carried one, from two minutes to four hours.
     */
    const ideaResult = await client.query<LockedTradeIdeaRow & { lot_size: number }>(`
      SELECT
        trade_ideas.id, trade_ideas.instrument_id, trade_ideas.side,
        trade_ideas.entry_price, trade_ideas.stop_loss, trade_ideas.target_price,
        trade_ideas.expires_at, instruments.lot_size
      FROM trade_ideas
      INNER JOIN instruments ON instruments.id = trade_ideas.instrument_id
      WHERE trade_ideas.id = $1 AND trade_ideas.status IN ('PROPOSED', 'ACCEPTED')
      FOR UPDATE OF trade_ideas
    `, [input.tradeIdeaId]);
    const idea = ideaResult.rows[0];
    if (!idea) {
      throw new TradeIdeaUnavailableError(
        "Trade idea was not found, or has expired or been rejected.",
      );
    }
    validateQuantity(input.quantity, Number(idea.lot_size));
    if (idea.expires_at && idea.expires_at.getTime() <= input.openedAt.getTime()) {
      // Scoped to PROPOSED deliberately. An idea that already produced a position must not be
      // relabelled EXPIRED: that would record a signal nobody acted on, and the position pointing at
      // it would contradict its own idea.
      await client.query(`UPDATE trade_ideas SET status = 'EXPIRED' WHERE id = $1 AND status = 'PROPOSED'`, [idea.id]);
      throw new TradeIdeaExpiredError("Trade idea expired before the simulated opening time.");
    }

    // One position per idea *per account*, which is what `paper_trades_one_per_idea_per_account_idx`
    // has always said. This check is not decoration: the status gate above was doing this job by
    // accident, and admitting ACCEPTED removes that. The bot re-reads the same completed bar every
    // cycle and the generator hands back the same idea row, so without this an account would
    // re-attempt an idea it already traded on every cycle until the bar rolled -- reaching the unique
    // index and surfacing as a raw constraint violation, which reads as a fault rather than a repeat.
    //
    // Race-safe because the account row is already held `FOR UPDATE` from the capacity gate above, so
    // two concurrent opens on one account serialise here; two different accounts never contend.
    const existingForAccount = await client.query<{ id: string }>(`
      SELECT id FROM paper_trades WHERE account_id = $1 AND trade_idea_id = $2 LIMIT 1
    `, [input.accountId, idea.id]);
    if (existingForAccount.rows[0]) {
      throw new TradeIdeaAlreadyTakenError(
        `Account ${account.name} already holds a position opened from this trade idea.`,
      );
    }

    const stopLoss = input.stopLossOverride ?? toNumber(idea.stop_loss, "trade idea stop loss");
    const targetPrice = input.targetPriceOverride ?? toNumber(idea.target_price, "trade idea target price");
    const side = input.sideOverride ?? idea.side;
    if (!hasGeometryForFill(side, input.fillPrice, stopLoss, targetPrice)) {
      throw new Error("The explicit fill price invalidates the referenced trade idea's stop/target geometry.");
    }

    const capitalResult = await client.query<CapitalRow>(`
      SELECT
        paper_accounts.opening_balance
        + COALESCE(SUM(paper_trades.realized_pnl) FILTER (WHERE paper_trades.status = 'CLOSED' AND paper_trades.excluded_from_evidence = false), 0)
        - COALESCE(SUM(paper_trades.quantity * paper_trades.entry_price) FILTER (WHERE paper_trades.status = 'OPEN' AND paper_trades.excluded_from_evidence = false), 0)
        - COALESCE(SUM(paper_trades.fees + paper_trades.slippage) FILTER (WHERE paper_trades.status = 'OPEN' AND paper_trades.excluded_from_evidence = false), 0)
        AS available_capital
      FROM paper_accounts
      LEFT JOIN paper_trades ON paper_trades.account_id = paper_accounts.id
      WHERE paper_accounts.id = $1
      GROUP BY paper_accounts.id, paper_accounts.opening_balance
    `, [input.accountId]);
    const availableCapital = capitalResult.rows[0]
      ? toNumber(capitalResult.rows[0].available_capital, "available capital")
      : null;
    if (availableCapital === null) {
      throw new Error("Unable to calculate available paper-account capital.");
    }
    const requiredCapital = input.quantity * input.fillPrice + input.entryFees + input.entrySlippage;
    if (requiredCapital > availableCapital + 1e-9) {
      throw new Error("Insufficient available capital for this simulated fill.");
    }

    const status = input.status ?? "OPEN";
    const feeBreakdown = input.feeBreakdown ?? { entry: { total: input.entryFees } };
    const contract = input.optionContract;
    const inserted = await client.query<{ id: string }>(`
      INSERT INTO paper_trades (
        account_id, trade_idea_id, instrument_id, side, status, quantity, remaining_quantity,
        entry_price, stop_loss, stop_loss_effective_at, target_price, opened_at,
        fees, fee_breakdown, slippage, notes,
        option_strike, option_expiry, option_type, underlying_symbol, underlying_entry_price, entry_iv,
        regime_observation_id
      ) VALUES (
        $1, $2, $3, $4, $14, $5, $5, $6, $7, $9, $8, $9, $10, $13::jsonb, $11, $12,
        $15, $16, $17, $18, $19, $20, $21
      ) RETURNING id
    `, [
      input.accountId, idea.id, idea.instrument_id, side, input.quantity,
      input.fillPrice, stopLoss, targetPrice, input.openedAt, input.entryFees,
      input.entrySlippage, input.notes, JSON.stringify(feeBreakdown), status,
      contract?.optionStrike ?? null, contract?.optionExpiry ?? null,
      contract?.optionType ?? null, contract?.underlyingSymbol ?? null,
      contract?.underlyingEntryPrice ?? null, contract?.entryIv ?? null,
      input.regimeObservationId ?? null,
    ]);
    const paperTradeId = inserted.rows[0]?.id;
    if (!paperTradeId) {
      throw new Error("Opening a paper trade did not return a row.");
    }

    const eventType = status === "PENDING" ? "PENDING_PLACED" : "OPENED";
    await client.query(`
      INSERT INTO paper_trade_events (paper_trade_id, event_type, price, quantity, details, occurred_at)
      VALUES ($1, $6, $2, $3, $4::jsonb, $5)
    `, [paperTradeId, input.fillPrice, input.quantity, JSON.stringify({
      fillPolicy: status === "PENDING" ? "LIMIT_STOP_PENDING" : "MANUAL_EXPLICIT",
      tradeIdeaId: idea.id,
      referenceEntryPrice: toNumber(idea.entry_price, "trade idea entry price"),
      stopLoss,
      targetPrice,
      openedAt: input.openedAt.toISOString(),
      entryFees: input.entryFees,
      entrySlippage: input.entrySlippage,
      notes: input.notes,
    }), input.openedAt, eventType]);

    // Idempotent: the second account to act on a signal finds the idea already ACCEPTED, which is
    // now the ordinary path rather than an error. Scoped to PROPOSED it would have thrown here after
    // the INSERT had already run, rolling back a legitimate position at the very last statement.
    const accepted = await client.query<{ id: string }>(`
      UPDATE trade_ideas SET status = 'ACCEPTED'
      WHERE id = $1 AND status IN ('PROPOSED', 'ACCEPTED')
      RETURNING id
    `, [idea.id]);
    if (!accepted.rows[0]) {
      // Unreachable while the row lock taken above is held for the whole transaction. Kept as an
      // assertion: it fires only if some future writer changes the status without the lock.
      throw new Error("Trade idea could not be marked as accepted.");
    }

    const trade = await findPaperTradeById(client, paperTradeId);
    if (!trade) {
      throw new Error("Unable to resolve the newly opened paper trade.");
    }
    return trade;
  }

  async findOpenById(id: string): Promise<PaperTrade | null> {
    const result = await this.database.query<PaperTradeRow>(`
      SELECT ${tradeColumns}
      FROM paper_trades
      LEFT JOIN trade_ideas ON trade_ideas.id = paper_trades.trade_idea_id
      LEFT JOIN candles AS source_candle ON source_candle.id = trade_ideas.source_candle_id
      LEFT JOIN strategy_versions ON strategy_versions.id = trade_ideas.strategy_version_id
      LEFT JOIN strategies ON strategies.id = strategy_versions.strategy_id
      WHERE paper_trades.id = $1 AND paper_trades.status = 'OPEN'
    `, [id]);
    return result.rows[0] ? toPaperTrade(result.rows[0]) : null;
  }

  async listOpenByAccount(accountId: string): Promise<PaperTrade[]> {
    const result = await this.database.query<PaperTradeRow>(`
      SELECT ${tradeColumns}, instruments.symbol AS instrument_symbol
      FROM paper_trades
      LEFT JOIN trade_ideas ON trade_ideas.id = paper_trades.trade_idea_id
      LEFT JOIN candles AS source_candle ON source_candle.id = trade_ideas.source_candle_id
      LEFT JOIN strategy_versions ON strategy_versions.id = trade_ideas.strategy_version_id
      LEFT JOIN strategies ON strategies.id = strategy_versions.strategy_id
      LEFT JOIN instruments ON instruments.id = paper_trades.instrument_id
      WHERE paper_trades.account_id = $1 AND paper_trades.status = 'OPEN'
      ORDER BY paper_trades.opened_at DESC, paper_trades.id ASC
    `, [accountId]);
    return result.rows.map(toPaperTrade);
  }

  async listPendingByAccount(accountId: string): Promise<PaperTrade[]> {
    const result = await this.database.query<PaperTradeRow>(`
      SELECT ${tradeColumns}, instruments.symbol AS instrument_symbol
      FROM paper_trades
      LEFT JOIN trade_ideas ON trade_ideas.id = paper_trades.trade_idea_id
      LEFT JOIN candles AS source_candle ON source_candle.id = trade_ideas.source_candle_id
      LEFT JOIN strategy_versions ON strategy_versions.id = trade_ideas.strategy_version_id
      LEFT JOIN strategies ON strategies.id = strategy_versions.strategy_id
      LEFT JOIN instruments ON instruments.id = paper_trades.instrument_id
      WHERE paper_trades.account_id = $1 AND paper_trades.status = 'PENDING'
      ORDER BY paper_trades.opened_at DESC, paper_trades.id ASC
    `, [accountId]);
    return result.rows.map(toPaperTrade);
  }

  async fillPendingTrade(input: { paperTradeId: string; fillPrice: number; filledAt: Date }): Promise<PaperTrade> {
    const client = await this.database.connect();
    let transactionStarted = false;
    try {
      await client.query("BEGIN");
      transactionStarted = true;

      const tradeResult = await client.query(`
        SELECT id FROM paper_trades WHERE id = $1 AND status = 'PENDING' FOR UPDATE
      `, [input.paperTradeId]);
      if (!tradeResult.rows[0]) {
        throw new Error("Trade is not pending or does not exist.");
      }

      await client.query(`
        UPDATE paper_trades
        SET status = 'OPEN', entry_price = $2, opened_at = $3, stop_loss_effective_at = $3
        WHERE id = $1
      `, [input.paperTradeId, input.fillPrice, input.filledAt]);

      await client.query(`
        INSERT INTO paper_trade_events (paper_trade_id, event_type, price, quantity, details, occurred_at)
        VALUES ($1, 'OPENED', $2, NULL, $3::jsonb, $4)
      `, [input.paperTradeId, input.fillPrice, JSON.stringify({ fillPolicy: "LIMIT_STOP_TRIGGERED" }), input.filledAt]);

      await client.query("COMMIT");
      transactionStarted = false;

      const updated = await findPaperTradeById(client, input.paperTradeId);
      if (!updated) throw new Error("Unable to resolve filled trade.");
      return updated;
    } catch (err) {
      if (transactionStarted) await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async executeExitSlice(input: import("../../../modules/paper-trading/domain/paper-trading.js").ExecuteExitSliceInput): Promise<PaperTrade> {
    assertPositiveFinite(input.quantity, "Quantity");
    assertNonNegativeFinite(input.exitPrice, "Exit price");
    assertNonNegativeFinite(input.exitFees, "Exit fees");
    assertDate(input.exitedAt, "Exited at");

    const client = await this.database.connect();
    let transactionStarted = false;
    try {
      await client.query("BEGIN");
      transactionStarted = true;

      const tradeRes = await client.query<PaperTradeRow>(`
        SELECT ${tradeColumns}
        FROM paper_trades
        LEFT JOIN trade_ideas ON trade_ideas.id = paper_trades.trade_idea_id
        LEFT JOIN candles AS source_candle ON source_candle.id = trade_ideas.source_candle_id
        LEFT JOIN strategy_versions ON strategy_versions.id = trade_ideas.strategy_version_id
        LEFT JOIN strategies ON strategies.id = strategy_versions.strategy_id
        WHERE paper_trades.id = $1 AND paper_trades.status = 'OPEN'
        FOR UPDATE OF paper_trades
      `, [input.paperTradeId]);

      const tradeRow = tradeRes.rows[0];
      if (!tradeRow) {
        throw new Error("Paper trade was not found, or is already closed/cancelled.");
      }
      const trade = toPaperTrade(tradeRow);

      if (input.quantity > trade.remainingQuantity + 1e-9) {
        throw new Error(`Exit quantity (${input.quantity}) exceeds remaining trade quantity (${trade.remainingQuantity}).`);
      }

      if (input.idempotencyKey) {
        const existingSlice = await client.query(`
          SELECT id FROM paper_trade_partial_exits WHERE idempotency_key = $1
        `, [input.idempotencyKey]);
        if (existingSlice.rows.length > 0) {
          await client.query("COMMIT");
          transactionStarted = false;
          return trade;
        }
      }

      const directionSign = trade.side === "LONG" ? 1 : -1;
      const sliceGrossPnl = (input.exitPrice - trade.entryPrice) * input.quantity * directionSign;
      const sliceNetPnl = sliceGrossPnl - input.exitFees - (input.exitSlippage ?? 0);

      await client.query(`
        INSERT INTO paper_trade_partial_exits (
          paper_trade_id, exit_price, quantity, exit_reason, exit_fees, realized_pnl, exited_at, idempotency_key, notes
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [
        trade.id,
        input.exitPrice,
        input.quantity,
        input.exitReason,
        input.exitFees,
        sliceNetPnl,
        input.exitedAt,
        input.idempotencyKey ?? null,
        input.notes ?? null,
      ]);

      const newRemaining = Math.max(0, trade.remainingQuantity - input.quantity);
      const isFullyClosed = newRemaining < 1e-6;

      await client.query(`
        SELECT id FROM paper_accounts WHERE id = $1 FOR UPDATE
      `, [trade.accountId]);

      if (isFullyClosed) {
        await client.query(`
          UPDATE paper_trades
          SET
            status = 'CLOSED',
            remaining_quantity = 0,
            closed_at = $2,
            exit_price = $3,
            exit_reason = $4,
            fees = fees + $5,
            slippage = slippage + $6,
            fee_breakdown = COALESCE(paper_trades.fee_breakdown, '{}'::jsonb)
              || jsonb_build_object(
                'exit',
                COALESCE($7::jsonb, jsonb_build_object('total', $5))
              ),
            realized_pnl = (
              SELECT COALESCE(SUM(realized_pnl), 0)
              FROM paper_trade_partial_exits
              WHERE paper_trade_id = $1
            ) - COALESCE((fee_breakdown->'entry'->>'total')::numeric, 0)
          WHERE id = $1
        `, [
          trade.id,
          input.exitedAt,
          input.exitPrice,
          input.exitReason,
          input.exitFees,
          input.exitSlippage ?? 0,
          JSON.stringify(input.feeBreakdown ?? { total: input.exitFees }),
        ]);
      } else {
        await client.query(`
          UPDATE paper_trades
          SET
            remaining_quantity = $2,
            fees = fees + $3,
            slippage = slippage + $4
          WHERE id = $1
        `, [
          trade.id,
          newRemaining,
          input.exitFees,
          input.exitSlippage ?? 0,
        ]);
      }

      await client.query(`
        INSERT INTO paper_trade_events (paper_trade_id, event_type, price, quantity, details, occurred_at)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6)
      `, [
        trade.id,
        isFullyClosed ? exitEventType(input.exitReason) : "PARTIAL_EXIT",
        input.exitPrice,
        input.quantity,
        JSON.stringify({
          ...input.details,
          exitReason: input.exitReason,
          exitFees: input.exitFees,
          sliceNetPnl,
          remainingQuantity: newRemaining,
        }),
        input.exitedAt,
      ]);

      await client.query("COMMIT");
      transactionStarted = false;

      const updated = await findPaperTradeById(client, trade.id);
      if (!updated) throw new Error("Unable to resolve updated paper trade.");
      return updated;
    } catch (error) {
      if (transactionStarted) await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listPartialExitsByTradeId(paperTradeId: string): Promise<import("../../../modules/paper-trading/domain/paper-trading.js").PaperTradePartialExit[]> {
    const result = await this.database.query<{
      id: string;
      paper_trade_id: string;
      exit_price: string;
      quantity: string;
      exit_reason: PaperTradeExitReason;
      exit_fees: string;
      realized_pnl: string;
      exited_at: Date;
      idempotency_key: string | null;
      notes: string | null;
      created_at: Date;
    }>(`
      SELECT id, paper_trade_id, exit_price, quantity, exit_reason, exit_fees, realized_pnl, exited_at, idempotency_key, notes, created_at
      FROM paper_trade_partial_exits
      WHERE paper_trade_id = $1
      ORDER BY exited_at ASC, created_at ASC
    `, [paperTradeId]);

    return result.rows.map((row) => ({
      id: row.id,
      paperTradeId: row.paper_trade_id,
      exitPrice: toNumber(row.exit_price, "exit price"),
      quantity: toNumber(row.quantity, "quantity"),
      exitReason: row.exit_reason,
      exitFees: toNumber(row.exit_fees, "exit fees"),
      realizedPnl: toNumber(row.realized_pnl, "realized P/L"),
      exitedAt: row.exited_at,
      idempotencyKey: row.idempotency_key,
      notes: row.notes,
      createdAt: row.created_at,
    }));
  }

  async close(input: ClosePaperTradeInput): Promise<PaperTrade> {
    assertNonNegativeFinite(input.exitPrice, "Exit price");
    assertNonNegativeFinite(input.exitFees, "Exit fees");
    assertNonNegativeFinite(input.exitSlippage, "Exit slippage");
    assertDate(input.closedAt, "Closed at");

    const client = await this.database.connect();
    let transactionStarted = false;
    try {
      await client.query("BEGIN");
      transactionStarted = true;

      const openTrade = await client.query<PaperTradeRow>(`
        SELECT ${tradeColumns}
        FROM paper_trades
        LEFT JOIN trade_ideas ON trade_ideas.id = paper_trades.trade_idea_id
        LEFT JOIN candles AS source_candle ON source_candle.id = trade_ideas.source_candle_id
        LEFT JOIN strategy_versions ON strategy_versions.id = trade_ideas.strategy_version_id
        LEFT JOIN strategies ON strategies.id = strategy_versions.strategy_id
        WHERE paper_trades.id = $1 AND paper_trades.status IN ('OPEN', 'PENDING')
        FOR UPDATE OF paper_trades
      `, [input.paperTradeId]);
      const existing = openTrade.rows[0];
      if (!existing) {
        throw new Error("Paper trade was not found, or is already closed/cancelled.");
      }

      if (existing.status === 'PENDING' || input.exitReason === 'CANCELLED') {
        await client.query(`
          UPDATE paper_trades
          SET status = 'CANCELLED', closed_at = $2, exit_reason = 'CANCELLED'
          WHERE id = $1
        `, [existing.id, input.closedAt]);

        await client.query(`
          INSERT INTO paper_trade_events (paper_trade_id, event_type, price, quantity, details, occurred_at)
          VALUES ($1, 'CANCELLED', $2, $3, $4::jsonb, $5)
        `, [existing.id, input.exitPrice, toNumber(existing.quantity, "trade quantity"), JSON.stringify(input.details), input.closedAt]);

        await client.query("COMMIT");
        transactionStarted = false;
        const cancelledTrade = await findPaperTradeById(client, existing.id);
        return cancelledTrade!;
      }
      if (input.closedAt.getTime() < existing.opened_at.getTime()) {
        throw new Error("Closed at cannot be before the paper trade was opened.");
      }

      await client.query(`
        SELECT id
        FROM paper_accounts
        WHERE id = $1
        FOR UPDATE
      `, [existing.account_id]);

      const trade = toPaperTrade(existing);
      const remainingQty = trade.remainingQuantity;

      // Delegate the actual closing exit slice to unified exit slice accounting
      const directionSign = trade.side === "LONG" ? 1 : -1;
      const sliceGrossPnl = (input.exitPrice - trade.entryPrice) * remainingQty * directionSign;
      const sliceNetPnl = sliceGrossPnl - input.exitFees - input.exitSlippage;

      await client.query(`
        INSERT INTO paper_trade_partial_exits (
          paper_trade_id, exit_price, quantity, exit_reason, exit_fees, realized_pnl, exited_at, notes
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [
        trade.id,
        input.exitPrice,
        remainingQty,
        input.exitReason,
        input.exitFees,
        sliceNetPnl,
        input.closedAt,
        "Full / final exit",
      ]);

      const closed = await client.query<ClosedTradeUpdateRow>(`
        UPDATE paper_trades
        SET
          status = 'CLOSED',
          remaining_quantity = 0,
          closed_at = $2,
          exit_price = $3,
          exit_reason = $4,
          fees = paper_trades.fees + $5,
          slippage = paper_trades.slippage + $6,
          fee_breakdown = COALESCE(paper_trades.fee_breakdown, '{}'::jsonb)
            || jsonb_build_object(
              'exit',
              COALESCE($7::jsonb, jsonb_build_object('total', $5))
            ),
          -- Migration 089. Assigned before realized_pnl deliberately: the convention test extracts
          -- the realized_pnl expression up to this UPDATE's WHERE and requires it to be identical to
          -- executeExitSlice's, so nothing may be appended after it.
          underlying_exit_price = $8,
          realized_pnl = (
            SELECT COALESCE(SUM(realized_pnl), 0)
            FROM paper_trade_partial_exits
            WHERE paper_trade_id = $1
          ) - COALESCE((fee_breakdown->'entry'->>'total')::numeric, 0)
        WHERE paper_trades.id = $1 AND paper_trades.status = 'OPEN'
        RETURNING id, realized_pnl, fees, slippage
      `, [
        input.paperTradeId,
        input.closedAt,
        input.exitPrice,
        input.exitReason,
        input.exitFees,
        input.exitSlippage,
        JSON.stringify(input.feeBreakdown ?? { total: input.exitFees }),
        input.underlyingExitPrice ?? null,
      ]);
      if (!closed.rows[0]) {
        throw new Error("Paper trade could not be closed because it is no longer open.");
      }
      const closedTrade = closed.rows[0];

      await client.query(`
        INSERT INTO paper_trade_events (paper_trade_id, event_type, price, quantity, details, occurred_at)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6)
      `, [
        input.paperTradeId,
        exitEventType(input.exitReason),
        input.exitPrice,
        remainingQty,
        JSON.stringify({
          ...input.details,
          exitFees: input.exitFees,
          exitSlippage: input.exitSlippage,
          totalFees: toNumber(closedTrade.fees, "total trade fees"),
          totalSlippage: toNumber(closedTrade.slippage, "total trade slippage"),
          realizedPnl: toNumber(closedTrade.realized_pnl, "realized P/L"),
        }),
        input.closedAt,
      ]);

      const resultTrade = await findPaperTradeById(client, input.paperTradeId);
      if (!resultTrade) {
        throw new Error("Unable to resolve the closed paper trade.");
      }

      await client.query("COMMIT");
      transactionStarted = false;
      return resultTrade;
    } catch (error) {
      if (transactionStarted) {
        await client.query("ROLLBACK");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async findAccountPerformanceData(accountId: string): Promise<PaperAccountPerformanceData | null> {
    const accountResult = await this.database.query<PaperAccountRow>(`
      SELECT ${accountColumns}
      FROM paper_accounts
      WHERE id = $1
    `, [accountId]);
    const account = accountResult.rows[0];
    if (!account) {
      return null;
    }

    const [trades, capital] = await Promise.all([
      this.database.query<PaperTradeRow>(`
        SELECT ${tradeColumns}
        FROM paper_trades
        LEFT JOIN trade_ideas ON trade_ideas.id = paper_trades.trade_idea_id
        LEFT JOIN candles AS source_candle ON source_candle.id = trade_ideas.source_candle_id
        LEFT JOIN strategy_versions ON strategy_versions.id = trade_ideas.strategy_version_id
        LEFT JOIN strategies ON strategies.id = strategy_versions.strategy_id
        WHERE paper_trades.account_id = $1
          AND paper_trades.status IN ('OPEN', 'CLOSED')
          AND paper_trades.excluded_from_evidence = false
        ORDER BY paper_trades.closed_at ASC NULLS LAST, paper_trades.opened_at ASC, paper_trades.id ASC
      `, [accountId]),
      this.database.query<CapitalRow>(`
        SELECT
          paper_accounts.opening_balance
          + COALESCE(SUM(paper_trades.realized_pnl) FILTER (WHERE paper_trades.status = 'CLOSED' AND paper_trades.excluded_from_evidence = false), 0)
          - COALESCE(SUM(paper_trades.quantity * paper_trades.entry_price) FILTER (WHERE paper_trades.status = 'OPEN' AND paper_trades.excluded_from_evidence = false), 0)
          - COALESCE(SUM(paper_trades.fees + paper_trades.slippage) FILTER (WHERE paper_trades.status = 'OPEN' AND paper_trades.excluded_from_evidence = false), 0)
          AS available_capital
        FROM paper_accounts
        LEFT JOIN paper_trades ON paper_trades.account_id = paper_accounts.id
        WHERE paper_accounts.id = $1
        GROUP BY paper_accounts.id, paper_accounts.opening_balance
      `, [accountId]),
    ]);
    const availableCapital = capital.rows[0]
      ? toNumber(capital.rows[0].available_capital, "available capital")
      : null;
    if (availableCapital === null) {
      throw new Error("Unable to calculate available paper-account capital.");
    }

    const persistedTrades = trades.rows.map(toPaperTrade);
    return {
      account: toPaperAccount(account),
      closedTrades: persistedTrades.filter((trade) => trade.status === "CLOSED"),
      openTrades: persistedTrades.filter((trade) => trade.status === "OPEN"),
      availableCapital,
    };
  }

  async updateStopLoss(id: string, newStopLoss: number, reason?: string): Promise<void> {
    assertPositiveFinite(newStopLoss, "New stop loss");
    await this.database.query(`
      UPDATE paper_trades
      SET stop_loss = $2,
          stop_loss_effective_at = CURRENT_TIMESTAMP,
          notes = CONCAT(notes, ' [', COALESCE($3, 'SL Adjusted'), ' to ₹', $2::text, ']')
      WHERE id = $1 AND status = 'OPEN'
    `, [id, newStopLoss, reason || "Dynamic Stop-Loss Tightening"]);
  }
}

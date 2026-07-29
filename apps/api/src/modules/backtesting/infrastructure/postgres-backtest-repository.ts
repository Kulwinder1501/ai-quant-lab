import type { QueryResultRow } from "pg";
import type {
  BacktestMonthlyPerformance,
  BacktestMetrics,
  BacktestRepository,
  BacktestRun,
  BacktestRunStatus,
  BacktestTrade,
  StartBacktestRunInput,
} from "../domain/backtesting.js";
import type { DatabasePool } from "../../../infrastructure/database/database.js";

interface BacktestRunRow extends QueryResultRow {
  id: string;
  strategy_version_id: string;
  status: BacktestRunStatus;
}

interface BacktestRunStatusRow extends QueryResultRow {
  id: string;
  status: BacktestRunStatus;
}

function assertValidDate(value: Date, field: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`${field} must be a valid date.`);
  }
}

function assertNonBlank(value: string, field: string): void {
  if (!value.trim()) {
    throw new Error(`${field} must not be blank.`);
  }
}

function serializeObject(value: object, field: string): string {
  const serialized = JSON.stringify(value);
  if (!serialized || !serialized.startsWith("{")) {
    throw new Error(`${field} must be a JSON object.`);
  }
  return serialized;
}

function serializeReasoning(reasoning: string[]): string {
  const serialized = JSON.stringify(reasoning);
  if (!serialized || !serialized.startsWith("[")) {
    throw new Error("Backtest trade reasoning must be a JSON array.");
  }
  return serialized;
}

function toMonthStartDate(value: Date): string {
  assertValidDate(value, "Month start");
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function validateStartInput(input: StartBacktestRunInput): void {
  assertNonBlank(input.strategyVersionId, "Strategy version id");
  assertNonBlank(input.instrumentId, "Instrument id");
  assertNonBlank(input.timeframe, "Timeframe");
  assertNonBlank(input.engineVersion, "Engine version");
  assertValidDate(input.dataWindowStart, "Data window start");
  assertValidDate(input.dataWindowEnd, "Data window end");
  assertValidDate(input.dataCutoffAt, "Data cutoff");
  if (input.dataWindowEnd.getTime() <= input.dataWindowStart.getTime()) {
    throw new Error("Data window end must be after data window start.");
  }
  serializeObject(input.configuration, "Backtest configuration");
}

/** Persists local backtest provenance and results; it never sends orders anywhere. */
export class PostgresBacktestRepository implements BacktestRepository {
  constructor(private readonly database: DatabasePool) {}

  async start(input: StartBacktestRunInput): Promise<BacktestRun> {
    validateStartInput(input);
    const configuration = serializeObject(input.configuration, "Backtest configuration");
    const client = await this.database.connect();
    let transactionStarted = false;

    try {
      await client.query("BEGIN");
      transactionStarted = true;

      const result = await client.query<BacktestRunRow>(`
        INSERT INTO backtest_runs (
          strategy_version_id,
          status,
          timeframe,
          started_at,
          data_window_start,
          data_window_end,
          data_cutoff_at,
          engine_version,
          configuration
        ) VALUES ($1, 'RUNNING', $2, CURRENT_TIMESTAMP, $3, $4, $5, $6, $7::jsonb)
        RETURNING id, strategy_version_id, status
      `, [
        input.strategyVersionId,
        input.timeframe,
        input.dataWindowStart,
        input.dataWindowEnd,
        input.dataCutoffAt,
        input.engineVersion,
        configuration,
      ]);
      const run = result.rows[0];
      if (!run) {
        throw new Error("Starting the backtest did not return a run.");
      }

      await client.query(`
        INSERT INTO backtest_run_instruments (backtest_run_id, instrument_id)
        VALUES ($1, $2)
      `, [run.id, input.instrumentId]);

      await client.query("COMMIT");
      transactionStarted = false;
      return {
        id: run.id,
        strategyVersionId: run.strategy_version_id,
        status: run.status,
      };
    } catch (error) {
      if (transactionStarted) {
        await client.query("ROLLBACK");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async complete(input: {
    runId: string;
    metrics: BacktestMetrics;
    trades: BacktestTrade[];
    monthlyPerformance: BacktestMonthlyPerformance[];
  }): Promise<void> {
    assertNonBlank(input.runId, "Backtest run id");
    const metrics = serializeObject(input.metrics, "Backtest metrics");
    const client = await this.database.connect();
    let transactionStarted = false;

    try {
      await client.query("BEGIN");
      transactionStarted = true;

      const lockedRun = await client.query<BacktestRunStatusRow>(`
        SELECT id, status
        FROM backtest_runs
        WHERE id = $1
        FOR UPDATE
      `, [input.runId]);
      const run = lockedRun.rows[0];
      if (!run) {
        throw new Error("Backtest run was not found.");
      }
      if (run.status !== "RUNNING") {
        throw new Error(`Backtest run cannot be completed from status ${run.status}.`);
      }

      for (const trade of input.trades) {
        assertValidDate(trade.entryTime, "Backtest trade entry time");
        assertValidDate(trade.exitTime, "Backtest trade exit time");
        if (trade.exitTime.getTime() < trade.entryTime.getTime()) {
          throw new Error("Backtest trade exit time cannot be before entry time.");
        }
        await client.query(`
          INSERT INTO backtest_trades (
            backtest_run_id,
            instrument_id,
            side,
            entry_time,
            exit_time,
            entry_price,
            exit_price,
            quantity,
            pnl,
            return_pct,
            exit_reason,
            reasoning
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
        `, [
          input.runId,
          trade.instrumentId,
          trade.side,
          trade.entryTime,
          trade.exitTime,
          trade.entryPrice,
          trade.exitPrice,
          trade.quantity,
          trade.pnl,
          trade.returnPercent,
          trade.exitReason,
          serializeReasoning(trade.reasoning),
        ]);
      }

      for (const performance of input.monthlyPerformance) {
        await client.query(`
          INSERT INTO backtest_monthly_performance (
            backtest_run_id,
            month_start,
            trade_count,
            winning_trade_count,
            gross_profit,
            gross_loss,
            net_pnl,
            max_drawdown_pct
          ) VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8)
        `, [
          input.runId,
          toMonthStartDate(performance.monthStart),
          performance.tradeCount,
          performance.winningTradeCount,
          performance.grossProfit,
          performance.grossLoss,
          performance.netPnl,
          performance.maxDrawdownPercent,
        ]);
      }

      const completed = await client.query<{ id: string }>(`
        UPDATE backtest_runs
        SET
          status = 'COMPLETED',
          completed_at = CURRENT_TIMESTAMP,
          metrics = $2::jsonb,
          error_message = NULL
        WHERE id = $1 AND status = 'RUNNING'
        RETURNING id
      `, [input.runId, metrics]);
      if (!completed.rows[0]) {
        throw new Error("Backtest run could not be marked complete.");
      }

      await client.query("COMMIT");
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        await client.query("ROLLBACK");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async fail(runId: string, errorMessage: string): Promise<void> {
    assertNonBlank(runId, "Backtest run id");
    await this.database.query(`
      UPDATE backtest_runs
      SET
        status = 'FAILED',
        completed_at = CURRENT_TIMESTAMP,
        error_message = $2
      WHERE id = $1 AND status IN ('QUEUED', 'RUNNING')
    `, [runId, errorMessage]);
  }
}

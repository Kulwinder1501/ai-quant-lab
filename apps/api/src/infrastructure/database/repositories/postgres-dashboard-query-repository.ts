import type { QueryResultRow } from "pg";
import type { DatabaseQueryable } from "../database.js";

export interface DashboardPaperAccountSummary {
  id: string;
  name: string;
  openingBalance: number;
  currency: string;
  isActive: boolean;
}

export interface DashboardTradeIdeaRow {
  id: string;
  instrumentId: string;
  instrumentSymbol: string;
  instrumentName: string;
  strategyVersionId: string | null;
  candleTimeframe: string | null;
  candleCloseTime: Date | null;
  side: string;
  status: string;
  entryPrice: number;
  stopLoss: number;
  targetPrice: number;
  riskReward: number;
  confidence: number;
  reasoning: unknown;
  evidence: unknown;
  expiresAt: Date | null;
}

export interface DashboardBacktestRunRow {
  id: string;
  strategyVersionId: string;
  instrumentSymbol: string | null;
  status: string;
  timeframe: string;
  startedAt: Date;
  completedAt: Date | null;
  dataWindowStart: Date;
  dataWindowEnd: Date;
  metrics: unknown | null;
  errorMessage: string | null;
}

export interface DashboardBacktestRunDetails {
  run: DashboardBacktestRunRow;
  trades: Array<{
    id: string;
    instrumentId: string;
    side: string;
    entryTime: Date;
    exitTime: Date;
    entryPrice: number;
    exitPrice: number;
    quantity: number;
    pnl: number;
    returnPercent: number;
    exitReason: string;
    reasoning: unknown;
  }>;
  monthlyPerformance: Array<{
    monthStart: string;
    tradeCount: number;
    winningTradeCount: number;
    grossProfit: number;
    grossLoss: number;
    netPnl: number;
    maxDrawdownPercent: number;
  }>;
}

export interface DashboardCandleWithOverlays {
  id: string;
  timeframe: string;
  openTime: Date;
  closeTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  indicators: Record<string, unknown>;
  patterns: Array<{
    code: string;
    name: string;
    direction: string;
    confidence: number;
  }>;
}

function toNumber(value: string | number | null | undefined, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

export class PostgresDashboardQueryRepository {
  constructor(private readonly database: DatabaseQueryable) {}

  async listPaperAccounts(): Promise<DashboardPaperAccountSummary[]> {
    const result = await this.database.query<QueryResultRow>(`
      SELECT id, name, opening_balance, currency, is_active
      FROM paper_accounts
      ORDER BY name ASC
    `);
    return result.rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      openingBalance: toNumber(row.opening_balance),
      currency: String(row.currency || "INR"),
      isActive: Boolean(row.is_active),
    }));
  }

  async getPaperAccountFullSummary(accountId: string, metrics: unknown): Promise<{
    account: DashboardPaperAccountSummary | null;
    metrics: unknown;
    openTrades: Record<string, unknown>[];
    pendingTrades: Record<string, unknown>[];
    closedTrades: Record<string, unknown>[];
  }> {
    const accResult = await this.database.query<QueryResultRow>(`
      SELECT id, name, opening_balance, currency, is_active
      FROM paper_accounts
      WHERE id = $1
    `, [accountId]);
    const accRow = accResult.rows[0];
    const account = accRow ? {
      id: String(accRow.id),
      name: String(accRow.name),
      openingBalance: toNumber(accRow.opening_balance),
      currency: String(accRow.currency || "INR"),
      isActive: Boolean(accRow.is_active),
    } : null;

    const tradesResult = await this.database.query<QueryResultRow>(`
      SELECT
        pt.id, pt.account_id, pt.instrument_id, pt.trade_idea_id, COALESCE(c.timeframe, '1d') AS timeframe, pt.side, pt.status,
        pt.quantity, pt.entry_price, pt.stop_loss, pt.target_price, pt.opened_at, pt.closed_at,
        pt.exit_price, pt.exit_reason, pt.realized_pnl, pt.fees, pt.slippage, pt.notes,
        COALESCE(i.symbol, 'NIFTY50') AS instrument_symbol,
        COALESCE(i.display_name, 'NIFTY 50 Index') AS instrument_name
      FROM paper_trades pt
      LEFT JOIN instruments i ON i.id = pt.instrument_id
      LEFT JOIN trade_ideas ti ON ti.id = pt.trade_idea_id
      LEFT JOIN candles c ON c.id = ti.source_candle_id
      WHERE pt.account_id = $1
      ORDER BY pt.opened_at DESC
    `, [accountId]);

    const formattedTrades = tradesResult.rows.map((row) => {
      const entryPrice = toNumber(row.entry_price);
      const exitPrice = row.exit_price !== null ? toNumber(row.exit_price) : null;
      const quantity = toNumber(row.quantity);
      const realizedPnl = row.realized_pnl !== null ? toNumber(row.realized_pnl) : null;
      let returnPercent: number | null = null;
      if (realizedPnl !== null && entryPrice > 0 && quantity > 0) {
        returnPercent = (realizedPnl / (entryPrice * quantity)) * 100;
      }

      return {
        id: String(row.id),
        accountId: String(row.account_id),
        instrumentId: String(row.instrument_id),
        instrumentSymbol: String(row.instrument_symbol),
        instrumentName: String(row.instrument_name),
        timeframe: row.timeframe ? String(row.timeframe) : "1d",
        tradeIdeaId: row.trade_idea_id ? String(row.trade_idea_id) : null,
        side: String(row.side) === "LONG" || String(row.side) === "BUY" ? "BUY" : "SELL",
        status: String(row.status),
        quantity,
        fillPrice: entryPrice,
        entryPrice,
        openedAt: row.opened_at instanceof Date ? row.opened_at.toISOString() : String(row.opened_at),
        entryFees: toNumber(row.fees),
        entrySlippage: toNumber(row.slippage),
        exitPrice,
        closedAt: row.closed_at instanceof Date ? row.closed_at.toISOString() : row.closed_at ? String(row.closed_at) : null,
        exitFees: 0,
        exitSlippage: 0,
        exitReason: row.exit_reason ? String(row.exit_reason) : null,
        realizedPnl,
        returnPercent,
        notes: row.notes ? String(row.notes) : "",
      };
    });

    return {
      account,
      metrics,
      openTrades: formattedTrades.filter((t) => t.status === "OPEN"),
      pendingTrades: formattedTrades.filter((t) => t.status === "PENDING"),
      closedTrades: formattedTrades.filter((t) => t.status === "CLOSED"),
    };
  }

  async listTradeIdeas(limit = 50, dateStr?: string): Promise<DashboardTradeIdeaRow[]> {
    let query = `
      SELECT
        ti.id,
        ti.instrument_id,
        ti.strategy_version_id,
        ti.source_candle_id,
        ti.side,
        ti.status,
        ti.entry_price,
        ti.stop_loss,
        ti.target_price,
        ti.risk_reward,
        ti.confidence,
        ti.expires_at,
        ti.reasoning,
        ti.evidence,
        COALESCE(i.symbol, 'UNKNOWN') AS instrument_symbol,
        COALESCE(i.display_name, 'Unknown Instrument') AS instrument_name,
        c.timeframe AS candle_timeframe,
        c.close_time AS candle_close_time
      FROM trade_ideas ti
      LEFT JOIN instruments i ON i.id = ti.instrument_id
      LEFT JOIN candles c ON c.id = ti.source_candle_id
    `;
    
    const params: any[] = [limit];
    if (dateStr) {
      query += ` WHERE DATE(c.close_time AT TIME ZONE 'Asia/Kolkata') = $2 `;
      params.push(dateStr);
    }
    
    query += ` ORDER BY ti.generated_at DESC, ti.id DESC LIMIT $1`;

    const result = await this.database.query<QueryResultRow>(query, params);

    return result.rows.map((row) => ({
      id: String(row.id),
      instrumentId: String(row.instrument_id),
      instrumentSymbol: String(row.instrument_symbol),
      instrumentName: String(row.instrument_name),
      strategyVersionId: row.strategy_version_id ? String(row.strategy_version_id) : null,
      candleTimeframe: row.candle_timeframe ? String(row.candle_timeframe) : null,
      candleCloseTime: row.candle_close_time instanceof Date ? row.candle_close_time : null,
      side: String(row.side),
      status: String(row.status),
      entryPrice: toNumber(row.entry_price),
      stopLoss: toNumber(row.stop_loss),
      targetPrice: toNumber(row.target_price),
      riskReward: toNumber(row.risk_reward),
      confidence: toNumber(row.confidence),
      reasoning: row.reasoning || [],
      evidence: row.evidence || {},
      expiresAt: row.expires_at instanceof Date ? row.expires_at : null,
    }));
  }

  async listBacktestRuns(limit = 50): Promise<DashboardBacktestRunRow[]> {
    const result = await this.database.query<QueryResultRow>(`
      SELECT
        br.id,
        br.strategy_version_id,
        br.status,
        br.timeframe,
        br.started_at,
        br.completed_at,
        br.data_window_start,
        br.data_window_end,
        br.metrics,
        br.error_message,
        (
          SELECT i.symbol
          FROM backtest_run_instruments bri
          LEFT JOIN instruments i ON i.id = bri.instrument_id
          WHERE bri.backtest_run_id = br.id
          LIMIT 1
        ) AS instrument_symbol
      FROM backtest_runs br
      ORDER BY br.started_at DESC, br.id DESC
      LIMIT $1
    `, [limit]);

    return result.rows.map((row) => ({
      id: String(row.id),
      strategyVersionId: String(row.strategy_version_id),
      instrumentSymbol: row.instrument_symbol ? String(row.instrument_symbol) : null,
      status: String(row.status),
      timeframe: String(row.timeframe),
      startedAt: new Date(row.started_at as string | number | Date),
      completedAt: row.completed_at ? new Date(row.completed_at as string | number | Date) : null,
      dataWindowStart: new Date(row.data_window_start as string | number | Date),
      dataWindowEnd: new Date(row.data_window_end as string | number | Date),
      metrics: row.metrics || null,
      errorMessage: row.error_message ? String(row.error_message) : null,
    }));
  }

  async getBacktestRunDetails(runId: string): Promise<DashboardBacktestRunDetails | null> {
    const runs = await this.database.query<QueryResultRow>(`
      SELECT
        br.id,
        br.strategy_version_id,
        br.status,
        br.timeframe,
        br.started_at,
        br.completed_at,
        br.data_window_start,
        br.data_window_end,
        br.metrics,
        br.error_message,
        (
          SELECT i.symbol
          FROM backtest_run_instruments bri
          LEFT JOIN instruments i ON i.id = bri.instrument_id
          WHERE bri.backtest_run_id = br.id
          LIMIT 1
        ) AS instrument_symbol
      FROM backtest_runs br
      WHERE br.id = $1
    `, [runId]);

    const runRow = runs.rows[0];
    if (!runRow) return null;

    const run: DashboardBacktestRunRow = {
      id: String(runRow.id),
      strategyVersionId: String(runRow.strategy_version_id),
      instrumentSymbol: runRow.instrument_symbol ? String(runRow.instrument_symbol) : null,
      status: String(runRow.status),
      timeframe: String(runRow.timeframe),
      startedAt: new Date(runRow.started_at as string | number | Date),
      completedAt: runRow.completed_at ? new Date(runRow.completed_at as string | number | Date) : null,
      dataWindowStart: new Date(runRow.data_window_start as string | number | Date),
      dataWindowEnd: new Date(runRow.data_window_end as string | number | Date),
      metrics: runRow.metrics || null,
      errorMessage: runRow.error_message ? String(runRow.error_message) : null,
    };

    const [tradesResult, monthlyResult] = await Promise.all([
      this.database.query<QueryResultRow>(`
        SELECT id, instrument_id, side, entry_time, exit_time, entry_price, exit_price, quantity, pnl, return_pct, exit_reason, reasoning
        FROM backtest_trades
        WHERE backtest_run_id = $1
        ORDER BY entry_time ASC, id ASC
      `, [runId]),
      this.database.query<QueryResultRow>(`
        SELECT month_start, trade_count, winning_trade_count, gross_profit, gross_loss, net_pnl, max_drawdown_pct
        FROM backtest_monthly_performance
        WHERE backtest_run_id = $1
        ORDER BY month_start ASC
      `, [runId]),
    ]);

    const trades = tradesResult.rows.map((row) => ({
      id: String(row.id),
      instrumentId: String(row.instrument_id),
      side: String(row.side),
      entryTime: new Date(row.entry_time as string | number | Date),
      exitTime: new Date(row.exit_time as string | number | Date),
      entryPrice: toNumber(row.entry_price),
      exitPrice: toNumber(row.exit_price),
      quantity: toNumber(row.quantity),
      pnl: toNumber(row.pnl),
      returnPercent: toNumber(row.return_pct),
      exitReason: String(row.exit_reason),
      reasoning: row.reasoning || [],
    }));

    const monthlyPerformance = monthlyResult.rows.map((row) => ({
      monthStart: String(row.month_start).split("T")[0] || "",
      tradeCount: toNumber(row.trade_count),
      winningTradeCount: toNumber(row.winning_trade_count),
      grossProfit: toNumber(row.gross_profit),
      grossLoss: toNumber(row.gross_loss),
      netPnl: toNumber(row.net_pnl),
      maxDrawdownPercent: toNumber(row.max_drawdown_pct),
    }));

    return { run, trades, monthlyPerformance };
  }

  async listCandlesWithOverlays(symbol: string, timeframe = "1d", limit = 100): Promise<DashboardCandleWithOverlays[]> {
    const candlesResult = await this.database.query<QueryResultRow>(`
      SELECT c.id, c.timeframe, c.open_time, c.close_time, c.open, c.high, c.low, c.close, c.volume
      FROM candles c
      JOIN instruments i ON i.id = c.instrument_id
      WHERE i.symbol = $1 AND c.timeframe = $2 AND c.is_complete = TRUE
      ORDER BY c.open_time DESC
      LIMIT $3
    `, [symbol.toUpperCase(), timeframe, limit]);

    if (candlesResult.rows.length === 0) return [];

    // Sort chronologically ascending for charting
    const rows = candlesResult.rows.slice().reverse();
    const candleIds = rows.map((r) => String(r.id));

    const [indicatorsResult, patternsResult] = await Promise.all([
      this.database.query<QueryResultRow>(`
        SELECT isnp.candle_id, idf.indicator_code AS indicator_code, isnp.values
        FROM indicator_snapshots isnp
        JOIN indicator_definitions idf ON idf.id = isnp.indicator_definition_id
        WHERE isnp.candle_id = ANY($1::uuid[])
      `, [candleIds]),
      this.database.query<QueryResultRow>(`
        SELECT pd.candle_id, pdf.pattern_code AS pattern_code, pdf.pattern_code AS display_name, pd.direction, pd.confidence
        FROM pattern_detections pd
        JOIN pattern_definitions pdf ON pdf.id = pd.pattern_definition_id
        WHERE pd.candle_id = ANY($1::uuid[])
      `, [candleIds]),
    ]);

    const indicatorsByCandle = new Map<string, Record<string, unknown>>();
    for (const row of indicatorsResult.rows) {
      const cid = String(row.candle_id);
      const code = String(row.indicator_code);
      const vals = row.values as Record<string, unknown> || {};
      const existing = indicatorsByCandle.get(cid) || {};
      existing[code] = vals;
      indicatorsByCandle.set(cid, existing);
    }

    const patternsByCandle = new Map<string, Array<{ code: string; name: string; direction: string; confidence: number }>>();
    for (const row of patternsResult.rows) {
      const cid = String(row.candle_id);
      const list = patternsByCandle.get(cid) || [];
      list.push({
        code: String(row.pattern_code),
        name: String(row.display_name),
        direction: String(row.direction),
        confidence: toNumber(row.confidence),
      });
      patternsByCandle.set(cid, list);
    }

    return rows.map((row) => {
      const cid = String(row.id);
      return {
        id: cid,
        timeframe: String(row.timeframe),
        openTime: new Date(row.open_time as string | number | Date),
        closeTime: new Date(row.close_time as string | number | Date),
        open: toNumber(row.open),
        high: toNumber(row.high),
        low: toNumber(row.low),
        close: toNumber(row.close),
        volume: toNumber(row.volume),
        indicators: indicatorsByCandle.get(cid) || {},
        patterns: patternsByCandle.get(cid) || [],
      };
    });
  }
}

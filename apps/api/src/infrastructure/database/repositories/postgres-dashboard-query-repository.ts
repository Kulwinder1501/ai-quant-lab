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
  strategyKey: string | null;
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
        pt.id, pt.account_id, pt.instrument_id, pt.trade_idea_id, COALESCE(c.timeframe, CASE WHEN ti.evidence->>'strategy' = 'momentum-scalp' THEN '1m' ELSE '1d' END) AS timeframe, pt.side, pt.status,
        pt.quantity, pt.entry_price, pt.stop_loss, pt.target_price, pt.opened_at, pt.closed_at,
        pt.exit_price, pt.exit_reason, pt.realized_pnl, pt.fees, pt.fee_breakdown, pt.slippage, pt.notes,
        pt.option_strike, pt.option_expiry, pt.option_type, pt.underlying_symbol, pt.entry_iv,
        COALESCE(i.symbol, 'NIFTY50') AS instrument_symbol,
        COALESCE(i.display_name, 'NIFTY 50 Index') AS instrument_name
      FROM paper_trades pt
      LEFT JOIN instruments i ON i.id = pt.instrument_id
      LEFT JOIN trade_ideas ti ON ti.id = pt.trade_idea_id
      LEFT JOIN candles c ON c.id = ti.source_candle_id
      WHERE pt.account_id = $1 AND pt.excluded_from_evidence = false
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
        side: String(row.side),
        status: String(row.status),
        quantity,
        fillPrice: entryPrice,
        entryPrice,
        stopLoss: toNumber(row.stop_loss),
        targetPrice: toNumber(row.target_price),
        openedAt: row.opened_at instanceof Date ? row.opened_at.toISOString() : String(row.opened_at),
        entryFees: toNumber(row.fees),
        entrySlippage: toNumber(row.slippage),
        feeBreakdown: row.fee_breakdown && typeof row.fee_breakdown === "object" ? row.fee_breakdown : {},
        exitPrice,
        closedAt: row.closed_at instanceof Date ? row.closed_at.toISOString() : row.closed_at ? String(row.closed_at) : null,
        exitFees: 0,
        exitSlippage: 0,
        exitReason: row.exit_reason ? String(row.exit_reason) : null,
        realizedPnl,
        returnPercent,
        notes: row.notes ? String(row.notes) : "",
        optionStrike: row.option_strike === null || row.option_strike === undefined
          ? null
          : toNumber(row.option_strike),
        optionExpiry: row.option_expiry instanceof Date
          ? row.option_expiry.toISOString()
          : row.option_expiry ? String(row.option_expiry) : null,
        optionType: row.option_type ? String(row.option_type) : null,
        underlyingSymbol: row.underlying_symbol ? String(row.underlying_symbol) : null,
        entryIv: row.entry_iv === null || row.entry_iv === undefined ? null : toNumber(row.entry_iv),
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

  /**
   * Newest proposal first, where "newest" is the close of the candle the proposal
   * was made on — not `generated_at`. `generated_at` is re-stamped every time a
   * proposal is re-upserted, so a historical re-scan rewrites it for every row and
   * the resulting order reflects the order the backfill happened to write in rather
   * than which signal is most recent.
   *
   * `strategyKey` filters in SQL on purpose. Filtering in the browser instead applies
   * `limit` across every strategy first, so the strategy whose rows were written last
   * fills the whole page and the others vanish from the list entirely.
   *
   * Expired proposals are hidden by default. A lookback scan persists every historical
   * hit, and without this filter the Strategy page fills with June/July setups that
   * already passed `expires_at` and drown out anything still actionable today.
   */
  async listTradeIdeas(
    limit = 50,
    dateStr?: string,
    strategyKey?: string,
    includeExpired = false,
  ): Promise<DashboardTradeIdeaRow[]> {
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
        c.close_time AS candle_close_time,
        s.strategy_key AS strategy_key
      FROM trade_ideas ti
      LEFT JOIN instruments i ON i.id = ti.instrument_id
      LEFT JOIN candles c ON c.id = ti.source_candle_id
      LEFT JOIN strategy_versions sv ON sv.id = ti.strategy_version_id
      LEFT JOIN strategies s ON s.id = sv.strategy_id
    `;
    
    const params: any[] = [limit];
    const conditions: string[] = [];
    if (!includeExpired) {
      // NULL expiry is treated as still live (agent/manual rows without a clock).
      conditions.push(`(ti.expires_at IS NULL OR ti.expires_at > CURRENT_TIMESTAMP)`);
      // Hide proposals whose source bar is still forming. Yahoo/agent paths can
      // attach an idea to today's open session; that is not a settled close.
      conditions.push(`(c.id IS NULL OR (c.is_complete = TRUE AND c.close_time <= CURRENT_TIMESTAMP))`);
    }
    if (dateStr) {
      params.push(dateStr);
      // Yahoo daily bars stamp open_time at the NSE session open (≈09:15 IST). That
      // is the trading-day label; close_time often falls on the next calendar date.
      conditions.push(`DATE(c.open_time AT TIME ZONE 'Asia/Kolkata') = $${params.length}`);
    }
    if (strategyKey) {
      // Filter on the registered strategy key, not on evidence JSON. Seeded
      // scalp rows used to stamp evidence.strategy = 'momentum-scalp'; real
      // proposals from GenerateTradeIdeas do not, so the evidence path silently
      // hid every genuine idea from the Strategy / Scalp dashboards.
      //
      // One key or a comma-separated list, because the scalp tab is four registered
      // strategies rather than one: `momentum-scalp` is the 1m engine, while the 5m
      // ideas that actually trade carry `momentum-scalp-index` and
      // `momentum-scalp-pattern`. A single-key filter therefore shows the wrong
      // cohort. Equality against the joined value was worse -- no row can hold
      // "a,b,c", so a dashboard sending the list rendered an empty tab rather than a
      // partial one, which reads as "no scalp ideas exist" when 1,408 of them do.
      //
      // A list that parses to nothing (`strategy=,,`) falls through unfiltered, which
      // is what the route already does with `strategy=` via `strategy || undefined`.
      const strategyKeys = strategyKey.split(",").map((key) => key.trim()).filter((key) => key.length > 0);
      if (strategyKeys.length > 0) {
        params.push(strategyKeys);
        conditions.push(`s.strategy_key = ANY($${params.length}::text[])`);
      }
    }
    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(" AND ")} `;
    }

    // NULLS LAST keeps proposals with no source candle from sorting above real signals.
    query += ` ORDER BY c.close_time DESC NULLS LAST, ti.generated_at DESC, ti.id DESC LIMIT $1`;

    const result = await this.database.query<QueryResultRow>(query, params);

    return result.rows.map((row) => ({
      id: String(row.id),
      instrumentId: String(row.instrument_id),
      instrumentSymbol: String(row.instrument_symbol),
      instrumentName: String(row.instrument_name),
      strategyVersionId: row.strategy_version_id ? String(row.strategy_version_id) : null,
      strategyKey: row.strategy_key ? String(row.strategy_key) : null,
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
          AND (
            (
              idf.indicator_code IN ('FVG', 'BOS', 'CHOCH', 'LIQUIDITY_SWEEP', 'ORDER_BLOCK', 'EQUILIBRIUM_ZONE')
              AND idf.algorithm_version = 'smc-v2'
            )
            OR (
              idf.indicator_code NOT IN ('FVG', 'BOS', 'CHOCH', 'LIQUIDITY_SWEEP', 'ORDER_BLOCK', 'EQUILIBRIUM_ZONE')
              AND idf.algorithm_version = 'ta-v1'
            )
          )
      `, [candleIds]),
      this.database.query<QueryResultRow>(`
        SELECT pd.candle_id, pdf.pattern_code AS pattern_code, pdf.pattern_code AS display_name, pd.direction, pd.confidence
        FROM pattern_detections pd
        JOIN pattern_definitions pdf ON pdf.id = pd.pattern_definition_id
        WHERE pd.candle_id = ANY($1::uuid[])
          AND pdf.algorithm_version = 'candlestick-v1'
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

import type { DatabasePool } from "../database.js";

/**
 * Raw measurements for the data-readiness audit.
 *
 * Measurement only — every judgement (state assignment, thresholds) lives in
 * `modules/market-data/domain/data-readiness.ts` where it is testable without a
 * database. Sessions are IST calendar dates, because an NSE trading session is
 * an IST concept and a UTC date splits the 09:15–15:30 window across two days
 * for nothing.
 */

export interface SeriesAggregateRow {
  symbol: string;
  exchange: string;
  instrumentType: string;
  isActive: boolean;
  timeframe: string;
  sources: string[];
  barCount: number;
  provisionalBars: number;
  expiredProvisionalBars: number;
  duplicateOpenTimes: number;
  invalidOhlcBars: number;
  negativeVolumeBars: number;
  zeroVolumeBars: number;
  medianVolume: number;
  firstOpenTime: Date;
  lastOpenTime: Date;
  lastCloseTime: Date;
}

export interface SeriesSessionRow {
  symbol: string;
  timeframe: string;
  sessionDate: string;
  bars: number;
}

export interface IndicatorCoverageRow {
  symbol: string;
  timeframe: string;
  indicatorCode: string;
  coveredBars: number;
}

export interface InstitutionalFlowContext {
  sessionCount: number;
  firstDate: string | null;
  lastDate: string | null;
  lastPublishedAt: string | null;
  provisionalRows: number;
}

export class PostgresDataReadinessRepository {
  constructor(private readonly database: DatabasePool) {}

  async listSeriesAggregates(): Promise<SeriesAggregateRow[]> {
    const result = await this.database.query(
      `SELECT
         i.symbol,
         i.exchange,
         i.instrument_type,
         i.is_active,
         c.timeframe,
         array_agg(DISTINCT c.source) AS sources,
         count(*)::int AS bar_count,
         count(*) FILTER (WHERE NOT c.is_complete)::int AS provisional_bars,
         -- A provisional bar whose window closed over an hour ago was never
         -- finalised; the current forming bar is normal and excluded by the grace.
         count(*) FILTER (WHERE NOT c.is_complete AND c.close_time < now() - interval '1 hour')::int
           AS expired_provisional_bars,
         (count(*) - count(DISTINCT c.open_time))::int AS duplicate_open_times,
         count(*) FILTER (
           WHERE c.high < c.open OR c.high < c.close OR c.high < c.low
              OR c.low > c.open OR c.low > c.close
         )::int AS invalid_ohlc_bars,
         count(*) FILTER (WHERE c.volume < 0)::int AS negative_volume_bars,
         count(*) FILTER (WHERE c.volume = 0)::int AS zero_volume_bars,
         COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY c.volume), 0) AS median_volume,
         min(c.open_time) AS first_open_time,
         max(c.open_time) AS last_open_time,
         max(c.close_time) AS last_close_time
       FROM candles c
       JOIN instruments i ON i.id = c.instrument_id
       GROUP BY i.symbol, i.exchange, i.instrument_type, i.is_active, c.timeframe
       ORDER BY i.symbol, c.timeframe`,
    );
    return result.rows.map((row) => ({
      symbol: String(row.symbol),
      exchange: String(row.exchange),
      instrumentType: String(row.instrument_type),
      isActive: Boolean(row.is_active),
      timeframe: String(row.timeframe),
      sources: (row.sources as string[]).map(String).sort(),
      barCount: Number(row.bar_count),
      provisionalBars: Number(row.provisional_bars),
      expiredProvisionalBars: Number(row.expired_provisional_bars),
      duplicateOpenTimes: Number(row.duplicate_open_times),
      invalidOhlcBars: Number(row.invalid_ohlc_bars),
      negativeVolumeBars: Number(row.negative_volume_bars),
      zeroVolumeBars: Number(row.zero_volume_bars),
      medianVolume: Number(row.median_volume),
      firstOpenTime: new Date(row.first_open_time as string),
      lastOpenTime: new Date(row.last_open_time as string),
      lastCloseTime: new Date(row.last_close_time as string),
    }));
  }

  async listSessionCounts(): Promise<SeriesSessionRow[]> {
    const result = await this.database.query(
      `SELECT
         i.symbol,
         c.timeframe,
         to_char((c.open_time AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS session_date,
         count(*)::int AS bars
       FROM candles c
       JOIN instruments i ON i.id = c.instrument_id
       GROUP BY i.symbol, c.timeframe, (c.open_time AT TIME ZONE 'Asia/Kolkata')::date
       ORDER BY i.symbol, c.timeframe, session_date`,
    );
    return result.rows.map((row) => ({
      symbol: String(row.symbol),
      timeframe: String(row.timeframe),
      sessionDate: String(row.session_date),
      bars: Number(row.bars),
    }));
  }

  async listIndicatorCoverage(algorithmVersion: string): Promise<IndicatorCoverageRow[]> {
    // DISTINCT candle id because one code can have several definitions per bar
    // (EMA 9 and EMA 20); a bar counts as covered when any of them exists.
    const result = await this.database.query(
      `SELECT
         i.symbol,
         c.timeframe,
         d.indicator_code,
         count(DISTINCT c.id)::int AS covered_bars
       FROM candles c
       JOIN instruments i ON i.id = c.instrument_id
       JOIN indicator_snapshots s ON s.candle_id = c.id
       JOIN indicator_definitions d
         ON d.id = s.indicator_definition_id
        AND d.algorithm_version = $1
       GROUP BY i.symbol, c.timeframe, d.indicator_code`,
      [algorithmVersion],
    );
    return result.rows.map((row) => ({
      symbol: String(row.symbol),
      timeframe: String(row.timeframe),
      indicatorCode: String(row.indicator_code),
      coveredBars: Number(row.covered_bars),
    }));
  }

  async listInstrumentsWithoutBars(): Promise<string[]> {
    const result = await this.database.query(
      `SELECT i.symbol
       FROM instruments i
       LEFT JOIN candles c ON c.instrument_id = i.id
       WHERE c.id IS NULL
       GROUP BY i.symbol
       ORDER BY i.symbol`,
    );
    return result.rows.map((row) => String(row.symbol));
  }

  async institutionalFlowContext(): Promise<InstitutionalFlowContext> {
    const result = await this.database.query(
      `SELECT
         count(*)::int AS session_count,
         to_char(min(date), 'YYYY-MM-DD') AS first_date,
         to_char(max(date), 'YYYY-MM-DD') AS last_date,
         max(published_at) AS last_published_at,
         count(*) FILTER (WHERE is_provisional)::int AS provisional_rows
       FROM institutional_flows`,
    );
    const row = result.rows[0] ?? {};
    return {
      sessionCount: Number(row.session_count ?? 0),
      firstDate: row.first_date === null || row.first_date === undefined ? null : String(row.first_date),
      lastDate: row.last_date === null || row.last_date === undefined ? null : String(row.last_date),
      lastPublishedAt:
        row.last_published_at === null || row.last_published_at === undefined
          ? null
          : new Date(row.last_published_at as string).toISOString(),
      provisionalRows: Number(row.provisional_rows ?? 0),
    };
  }

  async saveReport(reportHash: string, report: object): Promise<{ id: string; createdAt: string }> {
    const result = await this.database.query(
      `INSERT INTO data_readiness_reports (report_hash, report)
       VALUES ($1, $2::jsonb)
       RETURNING id, created_at`,
      [reportHash, JSON.stringify(report)],
    );
    const row = result.rows[0]!;
    return { id: String(row.id), createdAt: new Date(row.created_at as string).toISOString() };
  }
}

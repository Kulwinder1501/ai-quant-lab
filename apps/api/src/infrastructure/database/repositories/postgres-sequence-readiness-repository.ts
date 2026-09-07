import type { DatabasePool } from "../database.js";
import type { SeriesState } from "../../../modules/market-data/domain/data-readiness.js";

export interface SequenceSeriesSourceRow {
  symbol: string;
  exchange: string;
  instrumentType: string;
  metadataPurpose: string | null;
  timeframe: string;
  sources: string[];
  barCount: number;
  sessionCount: number;
  zeroVolumeFraction: number;
  completeness: number | null;
  firstOpenTime: string | null;
  lastOpenTime: string | null;
  seriesState: SeriesState | null;
}

export class PostgresSequenceReadinessRepository {
  constructor(private readonly database: DatabasePool) {}

  /**
   * Join the latest Workstream A report's per-series state with live bar
   * aggregates and instrument metadata. The gate is only meaningful against a
   * series the A-audit has already measured.
   */
  async listCandidateSeries(
    symbols: string[],
    timeframes: string[],
  ): Promise<SequenceSeriesSourceRow[]> {
    const result = await this.database.query(
      `WITH latest_report AS (
         SELECT report
         FROM data_readiness_reports
         ORDER BY created_at DESC
         LIMIT 1
       ),
       report_series AS (
         SELECT
           upper(entry->>'symbol') AS symbol,
           entry->>'timeframe' AS timeframe,
           entry->>'state' AS state,
           (entry->>'barCount')::int AS bar_count,
           (entry->>'sessionCount')::int AS session_count,
           (entry->>'zeroVolumeFraction')::float8 AS zero_volume_fraction,
           CASE
             WHEN entry->>'completeness' IS NULL OR entry->>'completeness' = 'null'
             THEN NULL
             ELSE (entry->>'completeness')::float8
           END AS completeness,
           entry->>'firstOpenTime' AS first_open_time,
           entry->>'lastOpenTime' AS last_open_time,
           COALESCE(
             ARRAY(SELECT jsonb_array_elements_text(COALESCE(entry->'providers', '[]'::jsonb))),
             ARRAY[]::text[]
           ) AS sources
         FROM latest_report,
              LATERAL jsonb_array_elements(report->'series') AS entry
         WHERE upper(entry->>'symbol') = ANY($1::text[])
           AND entry->>'timeframe' = ANY($2::text[])
       )
       SELECT
         i.symbol,
         i.exchange,
         i.instrument_type,
         i.metadata->>'purpose' AS metadata_purpose,
         rs.timeframe,
         rs.sources,
         rs.bar_count,
         rs.session_count,
         rs.zero_volume_fraction,
         rs.completeness,
         rs.first_open_time,
         rs.last_open_time,
         rs.state AS series_state
       FROM report_series rs
       JOIN instruments i
         ON upper(i.symbol) = rs.symbol
       ORDER BY i.symbol, rs.timeframe`,
      [symbols.map((s) => s.toUpperCase()), timeframes],
    );

    return result.rows.map((row) => ({
      symbol: String(row.symbol),
      exchange: String(row.exchange),
      instrumentType: String(row.instrument_type),
      metadataPurpose: row.metadata_purpose == null ? null : String(row.metadata_purpose),
      timeframe: String(row.timeframe),
      sources: Array.isArray(row.sources) ? row.sources.map(String) : [],
      barCount: Number(row.bar_count),
      sessionCount: Number(row.session_count),
      zeroVolumeFraction: Number(row.zero_volume_fraction),
      completeness: row.completeness == null ? null : Number(row.completeness),
      firstOpenTime: row.first_open_time == null ? null : String(row.first_open_time),
      lastOpenTime: row.last_open_time == null ? null : String(row.last_open_time),
      seriesState: row.series_state == null ? null : (String(row.series_state) as SeriesState),
    }));
  }

  async saveReport(reportHash: string, report: object): Promise<{ id: string; createdAt: string }> {
    const result = await this.database.query(
      `INSERT INTO sequence_readiness_reports (report_hash, report)
       VALUES ($1, $2::jsonb)
       RETURNING id, created_at`,
      [reportHash, JSON.stringify(report)],
    );
    const row = result.rows[0]!;
    return { id: String(row.id), createdAt: new Date(row.created_at as string).toISOString() };
  }
}

import type { Pool } from "pg";
import type { PriceBarRecord, PriceBarRevisionRecord } from "../../domain/types.js";

export type DatabaseQueryable = Pick<Pool, "query">;

export interface PriceBarInput {
  stockId: string;
  barDate: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number; // Raw close only
  volume: number;
  source?: string;
  rawRecordId?: string | null;
  seriesVersion?: number;
}

export class PostgresEquityPriceBarRepository {
  constructor(private readonly db: DatabaseQueryable) {}

  async saveBars(
    bars: PriceBarInput[],
    options?: { seriesVersion?: number },
  ): Promise<{ inserted: number; revisions: number; unchanged: number; restatedDates: string[] }> {
    if (!bars || bars.length === 0) {
      return { inserted: 0, revisions: 0, unchanged: 0, restatedDates: [] };
    }

    const seriesVersion = options?.seriesVersion ?? 1;

    // 1. Fetch existing bars for all affected stocks in a single query
    const stockIds = Array.from(new Set(bars.map((b) => b.stockId)));
    const existing = await this.db.query<{
      stock_id: string;
      bar_date: string;
      open: string;
      high: string;
      low: string;
      close: string;
      volume: string;
      series_version: number;
    }>(
      `
      SELECT stock_id, bar_date::text AS bar_date, open, high, low, close, volume, series_version
      FROM equity_research.price_bar
      WHERE stock_id = ANY($1)
      `,
      [stockIds],
    );

    const existingMap = new Map<
      string,
      { open: number; high: number; low: number; close: number; volume: number; series_version: number }
    >();
    for (const row of existing.rows) {
      const key = `${row.stock_id}:${row.bar_date.split("T")[0]}`;
      existingMap.set(key, {
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.volume),
        series_version: Number(row.series_version ?? 1),
      });
    }

    // Fetch prior revisions to deduplicate and prevent duplicate revision records
    const priorRevsResult = await this.db.query<{
      stock_id: string;
      bar_date: string;
      new_values: { open: number; high: number; low: number; close: number; volume: number };
    }>(
      `
      SELECT stock_id, bar_date::text AS bar_date, new_values
      FROM equity_research.price_bar_revision
      WHERE stock_id = ANY($1)
      `,
      [stockIds],
    );

    const existingRevisionsMap = new Map<
      string,
      Array<{ open: number; high: number; low: number; close: number; volume: number }>
    >();
    for (const row of priorRevsResult.rows) {
      const key = `${row.stock_id}:${row.bar_date.split("T")[0]}`;
      const revs = existingRevisionsMap.get(key) ?? [];
      const nv = typeof row.new_values === "string" ? JSON.parse(row.new_values) : row.new_values;
      revs.push({
        open: Number(nv.open),
        high: Number(nv.high),
        low: Number(nv.low),
        close: Number(nv.close),
        volume: Number(nv.volume),
      });
      existingRevisionsMap.set(key, revs);
    }

    const newBars: (PriceBarInput & { seriesVersion: number })[] = [];
    const barsToUpdate: (PriceBarInput & { seriesVersion: number })[] = [];
    const newRevisions: {
      stockId: string;
      barDate: string;
      prevValues: Record<string, number>;
      newValues: Record<string, number>;
      rawRecordId?: string | null;
    }[] = [];
    const restatedDates: string[] = [];

    let unchanged = 0;

    for (const bar of bars) {
      const cleanDate = bar.barDate.split("T")[0];
      const key = `${bar.stockId}:${cleanDate}`;
      const current = existingMap.get(key);

      if (!current) {
        newBars.push({ ...bar, barDate: cleanDate, seriesVersion: options?.seriesVersion ?? bar.seriesVersion ?? 1 });
        // Prevent duplicates within the same input batch
        existingMap.set(key, {
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: bar.volume,
          series_version: seriesVersion,
        });
      } else {
        const isDiff =
          Math.abs(current.open - bar.open) > 0.0001 ||
          Math.abs(current.high - bar.high) > 0.0001 ||
          Math.abs(current.low - bar.low) > 0.0001 ||
          Math.abs(current.close - bar.close) > 0.0001 ||
          current.volume !== bar.volume;

        if (isDiff) {
          restatedDates.push(cleanDate);
          barsToUpdate.push({
            ...bar,
            barDate: cleanDate,
            seriesVersion: options?.seriesVersion ?? current.series_version ?? 1,
          });

          // Check if this exact new value was already recorded in revisions (Deduplication)
          const priorRevs = existingRevisionsMap.get(key) ?? [];
          const alreadyRecorded = priorRevs.some(
            (pr) =>
              Math.abs(pr.open - bar.open) < 0.0001 &&
              Math.abs(pr.high - bar.high) < 0.0001 &&
              Math.abs(pr.low - bar.low) < 0.0001 &&
              Math.abs(pr.close - bar.close) < 0.0001 &&
              pr.volume === bar.volume,
          );

          if (!alreadyRecorded) {
            newRevisions.push({
              stockId: bar.stockId,
              barDate: cleanDate,
              prevValues: {
                open: current.open,
                high: current.high,
                low: current.low,
                close: current.close,
                volume: current.volume,
              },
              newValues: {
                open: bar.open,
                high: bar.high,
                low: bar.low,
                close: bar.close,
                volume: bar.volume,
              },
              rawRecordId: bar.rawRecordId ?? null,
            });
            priorRevs.push({
              open: bar.open,
              high: bar.high,
              low: bar.low,
              close: bar.close,
              volume: bar.volume,
            });
            existingRevisionsMap.set(key, priorRevs);
          }

          // Update existingMap with the new values
          existingMap.set(key, {
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
            volume: bar.volume,
            series_version: options?.seriesVersion ?? current.series_version ?? 1,
          });
        } else {
          unchanged++;
        }
      }
    }

    // 2. Batch insert new bars in chunks of 500
    const BATCH_SIZE = 500;
    for (let i = 0; i < newBars.length; i += BATCH_SIZE) {
      const chunk = newBars.slice(i, i + BATCH_SIZE);
      const values: unknown[] = [];
      const placeholders: string[] = [];

      for (let j = 0; j < chunk.length; j++) {
        const b = chunk[j];
        const offset = j * 10;
        placeholders.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10})`,
        );
        values.push(
          b.stockId,
          b.barDate,
          b.open,
          b.high,
          b.low,
          b.close,
          b.volume,
          b.source ?? "YAHOO",
          b.rawRecordId ?? null,
          b.seriesVersion,
        );
      }

      await this.db.query(
        `
        INSERT INTO equity_research.price_bar (
          stock_id, bar_date, open, high, low, close, volume, source, raw_record_id, series_version
        )
        VALUES ${placeholders.join(", ")}
        ON CONFLICT (stock_id, bar_date) DO NOTHING
        `,
        values,
      );
    }

    // 3. Batch update restated price_bar rows (keeps price_bar consistent; preserves old values in revisions)
    for (let i = 0; i < barsToUpdate.length; i += BATCH_SIZE) {
      const chunk = barsToUpdate.slice(i, i + BATCH_SIZE);
      const values: unknown[] = [];
      const placeholders: string[] = [];

      for (let j = 0; j < chunk.length; j++) {
        const b = chunk[j];
        const offset = j * 9;
        placeholders.push(
          `($${offset + 1}::uuid, $${offset + 2}::date, $${offset + 3}::numeric, $${offset + 4}::numeric, $${offset + 5}::numeric, $${offset + 6}::numeric, $${offset + 7}::bigint, $${offset + 8}::uuid, $${offset + 9}::integer)`,
        );
        values.push(
          b.stockId,
          b.barDate,
          b.open,
          b.high,
          b.low,
          b.close,
          b.volume,
          b.rawRecordId ?? null,
          b.seriesVersion,
        );
      }

      await this.db.query(
        `
        UPDATE equity_research.price_bar AS p
        SET open = v.open,
            high = v.high,
            low = v.low,
            close = v.close,
            volume = v.volume,
            raw_record_id = v.raw_record_id,
            series_version = v.series_version
        FROM (VALUES ${placeholders.join(", ")}) AS v(stock_id, bar_date, open, high, low, close, volume, raw_record_id, series_version)
        WHERE p.stock_id = v.stock_id AND p.bar_date = v.bar_date
        `,
        values,
      );
    }

    // 4. Batch insert new revisions in chunks of 500
    for (let i = 0; i < newRevisions.length; i += BATCH_SIZE) {
      const chunk = newRevisions.slice(i, i + BATCH_SIZE);
      const values: unknown[] = [];
      const placeholders: string[] = [];

      for (let j = 0; j < chunk.length; j++) {
        const r = chunk[j];
        const offset = j * 5;
        placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`);
        values.push(
          r.stockId,
          r.barDate,
          JSON.stringify(r.prevValues),
          JSON.stringify(r.newValues),
          r.rawRecordId ?? null,
        );
      }

      await this.db.query(
        `
        INSERT INTO equity_research.price_bar_revision (
          stock_id, bar_date, previous_values, new_values, raw_record_id
        )
        VALUES ${placeholders.join(", ")}
        `,
        values,
      );
    }

    // 5. If a target seriesVersion was specified, ensure all bars for the stocks are stamped with this version
    if (options?.seriesVersion) {
      await this.db.query(
        `
        UPDATE equity_research.price_bar
        SET series_version = $2
        WHERE stock_id = ANY($1)
        `,
        [stockIds, options.seriesVersion],
      );
    }

    return {
      inserted: newBars.length,
      revisions: newRevisions.length,
      unchanged,
      restatedDates,
    };
  }


  async getBarsByStockId(
    stockId: string,
    optionsOrLimit?: { range?: string; limit?: number } | number,
  ): Promise<PriceBarRecord[]> {
    let range: string | undefined;
    let limit: number | undefined;

    if (typeof optionsOrLimit === "number") {
      limit = optionsOrLimit;
    } else if (optionsOrLimit) {
      range = optionsOrLimit.range;
      limit = optionsOrLimit.limit;
    }

    let whereDateClause = "";
    if (range === "1mo") {
      whereDateClause = "AND bar_date >= (CURRENT_DATE - INTERVAL '30 days')";
    } else if (range === "3mo") {
      whereDateClause = "AND bar_date >= (CURRENT_DATE - INTERVAL '90 days')";
    } else if (range === "6mo") {
      whereDateClause = "AND bar_date >= (CURRENT_DATE - INTERVAL '180 days')";
    } else if (range === "1y") {
      whereDateClause = "AND bar_date >= (CURRENT_DATE - INTERVAL '365 days')";
    } else if (range === "2y") {
      whereDateClause = "AND bar_date >= (CURRENT_DATE - INTERVAL '730 days')";
    } else if (range === "5y") {
      whereDateClause = "AND bar_date >= (CURRENT_DATE - INTERVAL '1825 days')";
    }

    const limitClause = limit ? `LIMIT ${limit}` : "";
    const result = await this.db.query<PriceBarRecord>(
      `
      SELECT id, stock_id, bar_date::text AS bar_date, open, high, low, close, volume, source, raw_record_id, first_seen_at
      FROM equity_research.price_bar
      WHERE stock_id = $1 ${whereDateClause}
      ORDER BY bar_date ASC
      ${limitClause}
      `,
      [stockId],
    );
    return result.rows;
  }

  async getRevisionsByStockId(stockId: string): Promise<PriceBarRevisionRecord[]> {
    const result = await this.db.query<PriceBarRevisionRecord>(
      `
      SELECT id, stock_id, bar_date::text AS bar_date, previous_values, new_values, seen_at, raw_record_id
      FROM equity_research.price_bar_revision
      WHERE stock_id = $1
      ORDER BY bar_date ASC, seen_at ASC
      `,
      [stockId],
    );
    return result.rows;
  }

  async hasBars(stockId: string): Promise<boolean> {
    const result = await this.db.query<{ exists: boolean }>(
      `
      SELECT EXISTS (
        SELECT 1 FROM equity_research.price_bar WHERE stock_id = $1
      ) AS exists
      `,
      [stockId],
    );
    return Boolean(result.rows[0]?.exists);
  }

  async deleteDerivedRows(stockId: string): Promise<void> {
    await this.db.query(`DELETE FROM equity_research.price_bar WHERE stock_id = $1`, [stockId]);
    await this.db.query(`DELETE FROM equity_research.price_bar_revision WHERE stock_id = $1`, [stockId]);
  }

  async getPriceBarSummary(stockId: string): Promise<{
    totalBars: number;
    firstBarDate: string | null;
    lastBarDate: string | null;
    latestClose: number | null;
    previousClose: number | null;
    hasDataGap: boolean;
  }> {
    const statsResult = await this.db.query<{
      total_bars: string;
      first_bar_date: string | null;
      last_bar_date: string | null;
    }>(
      `
      SELECT
        count(*)::text AS total_bars,
        min(bar_date)::text AS first_bar_date,
        max(bar_date)::text AS last_bar_date
      FROM equity_research.price_bar
      WHERE stock_id = $1
      `,
      [stockId],
    );

    const latestBarsResult = await this.db.query<{
      close: string;
      bar_date: string;
    }>(
      `
      SELECT close::text, bar_date::text
      FROM equity_research.price_bar
      WHERE stock_id = $1
      ORDER BY bar_date DESC
      LIMIT 2
      `,
      [stockId],
    );

    const gapResult = await this.db.query<{ has_gap: boolean }>(
      `
      WITH date_lags AS (
        SELECT
          bar_date,
          lag(bar_date) OVER (ORDER BY bar_date ASC) AS prev_bar_date
        FROM equity_research.price_bar
        WHERE stock_id = $1 AND bar_date >= (CURRENT_DATE - INTERVAL '365 days')
      )
      SELECT EXISTS (
        SELECT 1
        FROM date_lags
        WHERE prev_bar_date IS NOT NULL AND (bar_date - prev_bar_date) > 10
      ) AS has_gap
      `,
      [stockId],
    );

    const totalBars = Number(statsResult.rows[0]?.total_bars ?? 0);
    const firstBarDate = statsResult.rows[0]?.first_bar_date ?? null;
    const lastBarDate = statsResult.rows[0]?.last_bar_date ?? null;
    const latestClose = latestBarsResult.rows[0] ? Number(latestBarsResult.rows[0].close) : null;
    const previousClose = latestBarsResult.rows[1] ? Number(latestBarsResult.rows[1].close) : null;
    const hasDataGap = Boolean(gapResult.rows[0]?.has_gap);

    return {
      totalBars,
      firstBarDate,
      lastBarDate,
      latestClose,
      previousClose,
      hasDataGap,
    };
  }
}

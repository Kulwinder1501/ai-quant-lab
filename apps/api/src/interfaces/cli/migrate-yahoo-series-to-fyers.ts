import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { FyersHistoricalDataProvider } from "../../infrastructure/market-data/fyers-historical-data-provider.js";
import { FyersTokenService } from "../../infrastructure/market-data/fyers-token-service.js";
import type {
  HistoricalMarketCandle,
  HistoricalTimeframe,
} from "../../modules/market-data/domain/historical-data-provider.js";

interface YahooSeries {
  instrument_id: string;
  symbol: string;
  timeframe: HistoricalTimeframe;
  first_open: Date;
  last_open: Date;
  old_count: string;
}

interface PreparedSeries extends YahooSeries {
  candles: HistoricalMarketCandle[];
}

const DAY_MS = 24 * 60 * 60_000;

function dateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function assertCoverage(series: YahooSeries, candles: HistoricalMarketCandle[]): void {
  if (candles.length === 0) throw new Error(`${series.symbol} ${series.timeframe}: Fyers returned no bars.`);
  const ordered = [...candles].sort((a, b) => a.openTime.getTime() - b.openTime.getTime());
  const first = ordered[0]!.openTime;
  const last = ordered[ordered.length - 1]!.openTime;
  if (first.getTime() > series.first_open.getTime() + 7 * DAY_MS) {
    throw new Error(
      `${series.symbol} ${series.timeframe}: Fyers begins ${dateKey(first)}, `
      + `but Yahoo begins ${dateKey(series.first_open)}.`,
    );
  }
  if (last.getTime() < series.last_open.getTime() - 7 * DAY_MS) {
    throw new Error(
      `${series.symbol} ${series.timeframe}: Fyers ends ${dateKey(last)}, `
      + `but Yahoo ends ${dateKey(series.last_open)}.`,
    );
  }
  const unique = new Set(candles.map((candle) => candle.openTime.toISOString()));
  if (unique.size !== candles.length) {
    throw new Error(`${series.symbol} ${series.timeframe}: Fyers returned duplicate open times.`);
  }
}

async function main(): Promise<void> {
  const apply = process.argv.slice(2).includes("--apply");
  const environment = loadEnvironment();
  const appId = environment.FYERS_APP_ID;
  const appSecret = environment.FYERS_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error("Yahoo-to-Fyers migration requires FYERS_APP_ID and FYERS_APP_SECRET.");
  }

  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const rows = await database.query<YahooSeries>(`
      SELECT p.instrument_id, i.symbol, p.timeframe,
             min(c.open_time) AS first_open, max(c.open_time) AS last_open,
             count(c)::text AS old_count
      FROM candle_series_provenance p
      JOIN instruments i ON i.id = p.instrument_id
      JOIN candles c ON c.instrument_id = p.instrument_id AND c.timeframe = p.timeframe
      WHERE p.source = 'yahoo' AND i.exchange IN ('NSE', 'BSE')
      GROUP BY p.instrument_id, i.symbol, p.timeframe
      ORDER BY i.symbol, p.timeframe
    `);
    if (rows.rows.length === 0) {
      console.info(JSON.stringify({ message: "No Yahoo-owned Indian candle series remain." }));
      return;
    }

    const tokenService = new FyersTokenService({
      pool: database,
      appId,
      appSecret,
      pin: environment.FYERS_PIN ?? "",
    });
    const provider = new FyersHistoricalDataProvider({ tokenService, appId });
    const prepared: PreparedSeries[] = [];
    for (const [index, series] of rows.rows.entries()) {
      const from = new Date(series.first_open.getTime() - 2 * DAY_MS);
      const candles = await provider.fetchCandles({
        providerInstrumentId: series.symbol,
        timeframe: series.timeframe,
        from,
        to: new Date(),
      });
      assertCoverage(series, candles);
      prepared.push({ ...series, candles });
      console.info(JSON.stringify({
        phase: "validated",
        series: `${index + 1}/${rows.rows.length}`,
        symbol: series.symbol,
        timeframe: series.timeframe,
        yahooBars: Number(series.old_count),
        fyersBars: candles.length,
      }));
    }

    const summary = {
      series: prepared.length,
      yahooBars: prepared.reduce((sum, row) => sum + Number(row.old_count), 0),
      fyersBars: prepared.reduce((sum, row) => sum + row.candles.length, 0),
    };
    if (!apply) {
      console.info(JSON.stringify({ mode: "dry-run", ...summary }, null, 2));
      return;
    }

    const client = await database.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        CREATE TEMP TABLE fyers_series_stage (
          instrument_id UUID NOT NULL,
          timeframe TEXT NOT NULL,
          open_time TIMESTAMPTZ NOT NULL,
          close_time TIMESTAMPTZ NOT NULL,
          open NUMERIC(20, 6) NOT NULL,
          high NUMERIC(20, 6) NOT NULL,
          low NUMERIC(20, 6) NOT NULL,
          close NUMERIC(20, 6) NOT NULL,
          volume NUMERIC(24, 4) NOT NULL,
          PRIMARY KEY (instrument_id, timeframe, open_time)
        ) ON COMMIT DROP
      `);

      for (const series of prepared) {
        for (let offset = 0; offset < series.candles.length; offset += 500) {
          const batch = series.candles.slice(offset, offset + 500);
          await client.query(`
            INSERT INTO fyers_series_stage
              (instrument_id, timeframe, open_time, close_time, open, high, low, close, volume)
            SELECT $1::uuid, $2::text, *
            FROM unnest(
              $3::timestamptz[], $4::timestamptz[], $5::numeric[], $6::numeric[],
              $7::numeric[], $8::numeric[], $9::numeric[]
            )
          `, [
            series.instrument_id,
            series.timeframe,
            batch.map((row) => row.openTime),
            batch.map((row) => row.closeTime),
            batch.map((row) => row.open),
            batch.map((row) => row.high),
            batch.map((row) => row.low),
            batch.map((row) => row.close),
            batch.map((row) => row.volume),
          ]);
        }
      }

      // Deleting the old source rows is deliberate: downstream evidence was computed
      // from Yahoo OHLC and must not retain its candle identity after the source changes.
      const deleted = await client.query(`
        DELETE FROM candles c
        USING candle_series_provenance p
        WHERE c.instrument_id = p.instrument_id
          AND c.timeframe = p.timeframe
          AND p.source = 'yahoo'
          AND EXISTS (
            SELECT 1 FROM fyers_series_stage s
            WHERE s.instrument_id = p.instrument_id AND s.timeframe = p.timeframe
          )
      `);
      await client.query(`
        UPDATE candle_series_provenance
        SET source = 'fyers-api-v3', declared_at = CURRENT_TIMESTAMP
        WHERE source = 'yahoo'
          AND EXISTS (
            SELECT 1 FROM fyers_series_stage s
            WHERE s.instrument_id = candle_series_provenance.instrument_id
              AND s.timeframe = candle_series_provenance.timeframe
          )
      `);
      const inserted = await client.query(`
        INSERT INTO candles (
          instrument_id, timeframe, open_time, close_time, open, high, low, close,
          volume, is_complete, source, source_metadata, received_at
        )
        SELECT instrument_id, timeframe, open_time, close_time, open, high, low, close,
               volume, TRUE, 'fyers-api-v3',
               jsonb_build_object('migration', 'yahoo-to-fyers', 'migratedAt', CURRENT_TIMESTAMP),
               CURRENT_TIMESTAMP
        FROM fyers_series_stage
        ORDER BY instrument_id, timeframe, open_time
      `);
      if (inserted.rowCount !== summary.fyersBars) {
        throw new Error(`Expected to insert ${summary.fyersBars} Fyers bars, inserted ${inserted.rowCount}.`);
      }
      await client.query("COMMIT");
      console.info(JSON.stringify({
        mode: "applied",
        ...summary,
        deletedYahooBars: deleted.rowCount,
        insertedFyersBars: inserted.rowCount,
      }, null, 2));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await database.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

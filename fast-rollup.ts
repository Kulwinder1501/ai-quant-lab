import { createDatabasePool } from "./apps/api/src/infrastructure/database/database.js";
import { PostgresInstrumentRepository } from "./apps/api/src/infrastructure/database/repositories/postgres-instrument-repository.js";
import { aggregateOhlcBars, computeSyntheticDxyBar, type TimestampedOhlc } from "./apps/api/src/modules/market-data/domain/synthetic-dxy.js";
import { randomUUID } from "crypto";

const db = createDatabasePool("postgresql://ai_quant_lab:2a33c5b07e01286c245ebf92710f8997208e4ff0237126ff06f2a4fcde47e0c8@localhost:5433/ai_quant_lab");
const instRepo = new PostgresInstrumentRepository(db);

const SYMBOLS = ["XAU_USD", "EUR_USD", "USD_JPY", "GBP_USD", "USD_CAD", "USD_SEK", "USD_CHF"];
const COMPONENT_SYMBOLS = ["EUR_USD", "USD_JPY", "GBP_USD", "USD_CAD", "USD_SEK", "USD_CHF"];
const TIMEFRAMES = [5, 15, 30, 60, 1440];

async function loadOneMinuteSeries(instrumentId: string, from: Date, to: Date) {
  const result = await db.query(
    `SELECT open_time, close_time, open, high, low, close
     FROM candles
     WHERE instrument_id = $1 AND timeframe = '1m' AND is_complete = TRUE
       AND open_time >= $2 AND open_time < $3
     ORDER BY open_time ASC`,
    [instrumentId, from, to],
  );
  return result.rows.map((row: any) => ({
    openTime: row.open_time,
    closeTime: row.close_time,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
  }));
}

async function bulkInsert(candles: any[], instrumentId: string, tfLabel: string, source: string) {
  if (candles.length === 0) return 0;
  
  let totalInserted = 0;
  for (let i = 0; i < candles.length; i += 2000) {
    const slice = candles.slice(i, i + 2000);
    const values: any[] = [];
    const params: any[] = [];
    let paramIdx = 1;
    
    for (const c of slice) {
      const id = randomUUID();
      values.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, 0, true, $${paramIdx++})`);
      params.push(
        id, instrumentId, tfLabel, source,
        c.openTime, c.closeTime,
        c.open.toFixed(6), c.high.toFixed(6), c.low.toFixed(6), c.close.toFixed(6),
        JSON.stringify({ derivedFrom: "1m", aggregationRule: "local-rollup-v1" })
      );
    }
    
    const query = `
      INSERT INTO candles (id, instrument_id, timeframe, source, open_time, close_time, open, high, low, close, volume, is_complete, source_metadata)
      VALUES ${values.join(", ")}
      ON CONFLICT (instrument_id, timeframe, open_time) DO UPDATE SET
        close_time = EXCLUDED.close_time,
        open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close,
        is_complete = EXCLUDED.is_complete, source_metadata = EXCLUDED.source_metadata
    `;
    
    await db.query(query, params);
    totalInserted += slice.length;
  }
  return totalInserted;
}

async function fetchDxyInstrumentId() {
  const result = await db.query(
    `SELECT id FROM instruments WHERE exchange = 'OANDA' AND symbol = 'DXY'`
  );
  return result.rows[0]?.id;
}

async function main() {
  // 1. Rollup existing symbols
  for (const sym of SYMBOLS) {
    console.log(`\n=== Rolling up ${sym} ===`);
    const instrument = await instRepo.findByExchangeAndSymbol("OANDA", sym);
    if (!instrument) {
      console.log(`Instrument not found: ${sym}`);
      continue;
    }
    
    // Chunk by 1 year
    let currentStart = new Date("2020-01-01T00:00:00Z").getTime();
    const endMs = new Date("2026-11-01T00:00:00Z").getTime();
    const oneYearMs = 365 * 24 * 60 * 60 * 1000;
    
    while (currentStart < endMs) {
      const chunkEndMs = Math.min(currentStart + oneYearMs, endMs);
      
      const bars = await loadOneMinuteSeries(instrument.id, new Date(currentStart), new Date(chunkEndMs));
      console.log(`Loaded ${bars.length} 1m candles for ${sym} from ${new Date(currentStart).toISOString()} to ${new Date(chunkEndMs).toISOString()}`);
      
      for (const tf of TIMEFRAMES) {
        const aggregated = aggregateOhlcBars(bars, tf);
        const inserted = await bulkInsert(aggregated, instrument.id, `${tf}m`, "oanda");
        console.log(`  -> Inserted ${inserted} ${tf}m candles`);
      }
      
      currentStart = chunkEndMs;
    }
  }

  // 2. Build DXY and its rollups
  console.log(`\n=== Computing Synthetic DXY ===`);
  const dxyId = await fetchDxyInstrumentId();
  if (!dxyId) {
    console.log("DXY instrument not found.");
    return;
  }
  
  const componentIds = await Promise.all(
    COMPONENT_SYMBOLS.map(async sym => {
      const result = await db.query(`SELECT id FROM instruments WHERE exchange = 'OANDA' AND symbol = $1`, [sym]);
      return result.rows[0].id;
    })
  );

  let currentStart = new Date("2020-01-01T00:00:00Z").getTime();
  const endMs = new Date("2026-11-01T00:00:00Z").getTime();
  const oneYearMs = 365 * 24 * 60 * 60 * 1000;
  
  while (currentStart < endMs) {
    const chunkEndMs = Math.min(currentStart + oneYearMs, endMs);
    console.log(`Processing DXY from ${new Date(currentStart).toISOString()} to ${new Date(chunkEndMs).toISOString()}`);
    
    const seriesBySymbol = new Map<string, Map<number, any>>();
    for (let i = 0; i < COMPONENT_SYMBOLS.length; i++) {
      const bars = await loadOneMinuteSeries(componentIds[i], new Date(currentStart), new Date(chunkEndMs));
      const m = new Map<number, any>();
      for (const b of bars) {
        m.set(b.openTime.getTime(), b);
      }
      seriesBySymbol.set(COMPONENT_SYMBOLS[i], m);
    }
    
    const allTimestamps = new Set<number>();
    for (const series of seriesBySymbol.values()) {
      for (const timestamp of series.keys()) allTimestamps.add(timestamp);
    }
    
    const dxy1mBars: TimestampedOhlc[] = [];
    let missingAnyLeg = 0;
    
    for (const timestamp of [...allTimestamps].sort((a, b) => a - b)) {
      const rows = COMPONENT_SYMBOLS.map((symbol) => seriesBySymbol.get(symbol)!.get(timestamp));
      if (rows.some((row) => row === undefined)) {
        missingAnyLeg += 1;
        continue;
      }
      const [eurUsd, usdJpy, gbpUsd, usdCad, usdSek, usdChf] = rows as any[];
      const bar = computeSyntheticDxyBar({
        eurUsd, usdJpy, gbpUsd, usdCad, usdSek, usdChf
      });
      dxy1mBars.push({
        openTime: new Date(timestamp),
        closeTime: eurUsd.closeTime,
        ...bar,
      });
    }
    
    console.log(`  -> Built ${dxy1mBars.length} 1m DXY candles (skipped ${missingAnyLeg} due to missing legs)`);
    const inserted1m = await bulkInsert(dxy1mBars, dxyId, "1m", "synthetic");
    console.log(`  -> Inserted ${inserted1m} 1m DXY candles`);
    
    for (const tf of TIMEFRAMES) {
      const aggregated = aggregateOhlcBars(dxy1mBars, tf);
      const inserted = await bulkInsert(aggregated, dxyId, `${tf}m`, "synthetic");
      console.log(`  -> Inserted ${inserted} ${tf}m DXY candles`);
    }
    
    currentStart = chunkEndMs;
  }
}

main().catch(console.error).finally(() => db.end());

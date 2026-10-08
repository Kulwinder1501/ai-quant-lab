import { createDatabasePool } from "./apps/api/src/infrastructure/database/database.js";
import { PostgresInstrumentRepository } from "./apps/api/src/infrastructure/database/repositories/postgres-instrument-repository.js";
import { OandaHistoricalDataProvider } from "./apps/api/src/infrastructure/market-data/oanda-historical-data-provider.js";
import { randomUUID } from "crypto";

const db = createDatabasePool("postgresql://ai_quant_lab:2a33c5b07e01286c245ebf92710f8997208e4ff0237126ff06f2a4fcde47e0c8@localhost:5433/ai_quant_lab");
const instRepo = new PostgresInstrumentRepository(db);

const provider = new OandaHistoricalDataProvider({ baseUrl: "https://api-fxpractice.oanda.com", accessToken: "12c98f9d99857239738300a59493e147-024e390f598c460af78cc44fccd1e97e" });

const SYMBOLS = ["XAU_USD", "EUR_USD", "USD_JPY", "GBP_USD", "USD_CAD", "USD_SEK", "USD_CHF"];

async function bulkInsert(candles: any[], instrumentId: string) {
  if (candles.length === 0) return;
  const values: any[] = [];
  const params: any[] = [];
  let paramIdx = 1;
  
  for (const c of candles) {
    const id = randomUUID();
    values.push(`($${paramIdx++}, $${paramIdx++}, '1m', 'oanda', $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, true)`);
    params.push(
      id, instrumentId,
      c.openTime, c.closeTime,
      c.open, c.high, c.low, c.close,
      c.volume
    );
  }
  
  const query = `
    INSERT INTO candles (id, instrument_id, timeframe, source, open_time, close_time, open, high, low, close, volume, is_complete)
    VALUES ${values.join(", ")}
    ON CONFLICT (instrument_id, timeframe, open_time) DO UPDATE SET
      close_time = EXCLUDED.close_time,
      open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close,
      volume = EXCLUDED.volume, is_complete = EXCLUDED.is_complete
  `;
  
  await db.query(query, params);
}

async function main() {
  for (const sym of SYMBOLS) {
    console.log(`\n=== Starting fast backfill for ${sym} ===`);
    const instrument = await instRepo.findByExchangeAndSymbol("OANDA", sym);
    if (!instrument) {
      console.log(`Instrument not found: ${sym}`);
      continue;
    }
    
    // Chunk by 6 months to avoid memory/query-size limits
    let currentStart = new Date("2020-01-01T00:00:00Z").getTime();
    const endMs = new Date().getTime();
    const sixMonthsMs = 180 * 24 * 60 * 60 * 1000;
    
    let totalInserted = 0;
    while (currentStart < endMs) {
      const chunkEndMs = Math.min(currentStart + sixMonthsMs, endMs);
      
      const candles = await provider.fetchCandles({
        instrument,
        providerInstrumentId: sym,
        timeframe: "1m",
        from: new Date(currentStart),
        to: new Date(chunkEndMs)
      });
      
      // bulk insert in chunks of 2000
      let inserted = 0;
      for (let i = 0; i < candles.length; i += 2000) {
        const slice = candles.slice(i, i + 2000);
        await bulkInsert(slice, instrument.id);
        inserted += slice.length;
      }
      
      totalInserted += inserted;
      console.log(`  -> Inserted ${inserted} candles from ${new Date(currentStart).toISOString()} to ${new Date(chunkEndMs).toISOString()}`);
      
      currentStart = chunkEndMs;
    }
    console.log(`Finished ${sym}. Total: ${totalInserted}`);
  }
}

main().catch(console.error).finally(() => db.end());

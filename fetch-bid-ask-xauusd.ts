import { createDatabasePool } from "./apps/api/src/infrastructure/database/database.js";
import { OandaHistoricalDataProvider } from "./apps/api/src/infrastructure/market-data/oanda-historical-data-provider.js";

const db = createDatabasePool("postgresql://ai_quant_lab:2a33c5b07e01286c245ebf92710f8997208e4ff0237126ff06f2a4fcde47e0c8@localhost:5433/ai_quant_lab");

const provider = new OandaHistoricalDataProvider({ 
  baseUrl: "https://api-fxpractice.oanda.com", 
  accessToken: "12c98f9d99857239738300a59493e147-024e390f598c460af78cc44fccd1e97e" 
});

async function bulkInsertBidAsk(candles: any[]) {
  if (candles.length === 0) return;
  const values: string[] = [];
  const params: any[] = [];
  let paramIdx = 1;
  
  for (const c of candles) {
    if (!c.bid || !c.ask) continue;
    
    values.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
    
    params.push(
      "XAU_USD", "1m", c.openTime,
      c.bid.open, c.bid.high, c.bid.low, c.bid.close,
      c.ask.open, c.ask.high, c.ask.low, c.ask.close,
      parseInt(c.volume, 10), c.complete ?? true,
      "OANDA", "v3"
    );
  }

  if (values.length === 0) return;
  
  const query = `
    INSERT INTO oanda_bid_ask_candles (
      instrument, granularity, time,
      bid_open, bid_high, bid_low, bid_close,
      ask_open, ask_high, ask_low, ask_close,
      volume, complete, source, provider_version
    )
    VALUES ${values.join(", ")}
    ON CONFLICT (instrument, granularity, time, source) DO NOTHING
  `;
  
  await db.query(query, params);
  return values.length;
}

async function main() {
  console.log(`\n=== Starting fast backfill for XAU_USD M1 Bid/Ask ===`);
  
  // Phase 0 backtest period
  let currentStart = new Date("2021-01-01T00:00:00Z").getTime();
  const endMs = new Date("2024-01-01T00:00:00Z").getTime();
  const sixMonthsMs = 180 * 24 * 60 * 60 * 1000;
  
  let totalInserted = 0;
  while (currentStart < endMs) {
    const chunkEndMs = Math.min(currentStart + sixMonthsMs, endMs);
    
    console.log(`Fetching from ${new Date(currentStart).toISOString()} to ${new Date(chunkEndMs).toISOString()}`);
    
    const candles = await provider.fetchCandles({
      providerInstrumentId: "XAU_USD",
      timeframe: "1m",
      from: new Date(currentStart),
      to: new Date(chunkEndMs)
    });
    
    let inserted = 0;
    for (let i = 0; i < candles.length; i += 2000) {
      const slice = candles.slice(i, i + 2000);
      const num = await bulkInsertBidAsk(slice);
      if (num) inserted += num;
    }
    
    totalInserted += inserted;
    console.log(`  -> Inserted ${inserted} bid/ask candles (Total: ${totalInserted})`);
    
    currentStart = chunkEndMs;
  }
  console.log(`Finished XAU_USD. Total Bid/Ask candles inserted: ${totalInserted}`);
}

main().catch(console.error).finally(() => db.end());

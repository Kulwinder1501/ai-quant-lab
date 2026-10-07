import { Pool } from "pg";

async function main() {
  console.log("Starting stale shadow trade resolution sweep...");

  const db = new Pool({
    connectionString: process.env.DATABASE_URL || "postgresql://ai_quant_lab:2a33c5b07e01286c245ebf92710f8997208e4ff0237126ff06f2a4fcde47e0c8@localhost:5433/ai_quant_lab",
  });

  try {
    // 1. Fetch all UNRESOLVED settlements
    const { rows: unresolvedTrades } = await db.query(`
      SELECT 
        cs.id as settlement_id,
        ti.id as trade_idea_id,
        ti.generated_at,
        ti.side,
        CAST(ti.entry_price AS FLOAT) as entry_price,
        CAST(ti.target_price AS FLOAT) as target_price,
        CAST(ti.stop_loss AS FLOAT) as stop_loss,
        CAST(ti.risk_reward AS FLOAT) as risk_reward
      FROM candidate_settlements cs
      JOIN trade_ideas ti ON cs.trade_idea_id = ti.id
      WHERE cs.outcome = 'UNRESOLVED'
      ORDER BY ti.generated_at ASC
    `);

    if (unresolvedTrades.length === 0) {
      console.log("No unresolved shadow trades found. Sweep complete.");
      return;
    }

    console.log(`Found ${unresolvedTrades.length} unresolved trades. Simulating resolution...`);

    // Get the XAU_USD instrument_id
    const { rows: insts } = await db.query(`SELECT id FROM instruments WHERE symbol = 'XAU_USD' AND exchange = 'TWELVEDATA' LIMIT 1`);
    if (insts.length === 0) {
      console.error("Could not find XAU_USD instrument. Exiting.");
      return;
    }
    const xauId = insts[0].id;

    // Get the minimum generated_at time to bound our candle fetch
    const minTime = unresolvedTrades[0].generated_at;

    console.log(`Fetching 1m XAU_USD candles since ${minTime}...`);
    const { rows: candles } = await db.query(`
      SELECT open_time, CAST(high AS FLOAT) as high, CAST(low AS FLOAT) as low
      FROM candles
      WHERE instrument_id = $1
        AND timeframe = '1m'
        AND open_time >= $2
      ORDER BY open_time ASC
    `, [xauId, minTime]);

    if (candles.length === 0) {
      console.error("No candles available in the database to resolve these trades.");
      return;
    }

    let resolvedCount = 0;

    for (const t of unresolvedTrades) {
      let outcome = '';
      let pnl = 0;
      let barsToResolution = 0;
      let resolved = false;

      // Filter candles to those occurring after the trade idea was generated
      const futureCandles = candles.filter((c: any) => new Date(c.open_time) >= new Date(t.generated_at));

      for (let i = 0; i < futureCandles.length; i++) {
        const c = futureCandles[i];
        if (t.side === 'LONG') {
          // Check Stop Loss first
          if (c.low <= t.stop_loss) {
            outcome = 'STOP';
            pnl = -1;
            barsToResolution = i + 1;
            resolved = true;
            break;
          }
          // Check Target
          if (c.high >= t.target_price) {
            outcome = 'TARGET';
            pnl = t.risk_reward;
            barsToResolution = i + 1;
            resolved = true;
            break;
          }
        } else { // SHORT
          // Check Stop Loss first
          if (c.high >= t.stop_loss) {
            outcome = 'STOP';
            pnl = -1;
            barsToResolution = i + 1;
            resolved = true;
            break;
          }
          // Check Target
          if (c.low <= t.target_price) {
            outcome = 'TARGET';
            pnl = t.risk_reward;
            barsToResolution = i + 1;
            resolved = true;
            break;
          }
        }
      }

      if (resolved) {
        await db.query(`
          UPDATE candidate_settlements 
          SET outcome = $1, r_multiple = $2, bars_to_resolution = $3, settled_at = NOW()
          WHERE id = $4
        `, [outcome, pnl, barsToResolution, t.settlement_id]);
        
        console.log(`Resolved trade ${t.trade_idea_id} (${t.side} Entry: ${t.entry_price}) -> ${outcome} (${pnl}R)`);
        resolvedCount++;
      }
    }

    console.log(`Sweep complete. Successfully resolved ${resolvedCount} out of ${unresolvedTrades.length} trades.`);

  } catch (error) {
    console.error("Error during shadow trade sweep:", error);
  } finally {
    // Only close the pool if this script is run standalone, not if imported
    if (import.meta.url.endsWith(process.argv[1])) {
      await db.end();
    }
  }
}

void main().catch((err) => {
  console.error("Fatal error in resolution sweep:", err);
  process.exitCode = 1;
});

export { main as sweepUnresolvedShadowTrades };

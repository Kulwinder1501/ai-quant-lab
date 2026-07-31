import type { DatabasePool } from "../../../infrastructure/database/database.js";
import { resolveYahooSymbol } from "../../market-data/domain/yahoo-symbol-resolver.js";
import { simpleRsi } from "../domain/simple-rsi.js";
import { upsertSeedCandle } from "./upsert-seed-candle.js";

export async function seedMarketData(database: DatabasePool): Promise<void> {
  const client = await database.connect();
  try {
    await client.query("BEGIN");

    // 1. Ensure strategy & version exist
    const stratRes = await client.query<{ id: string }>(`
      INSERT INTO strategies (strategy_key, name, description, is_archived)
      VALUES ('trend-breakout', 'Trend Breakout Strategy', 'Momentum breakout trading strategy', FALSE)
      ON CONFLICT (strategy_key) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `);
    const strategyId = stratRes.rows[0]?.id;
    if (!strategyId) throw new Error("Failed to insert/resolve strategy");

    const verRes = await client.query<{ id: string }>(`
      INSERT INTO strategy_versions (strategy_id, version, configuration, is_active)
      VALUES ($1, 1, '{"lookback": 20, "stopLossPct": 1.5, "targetPct": 3.0}'::jsonb, TRUE)
      ON CONFLICT (strategy_id, version) DO UPDATE SET is_active = TRUE
      RETURNING id
    `, [strategyId]);
    if (!verRes.rows[0]?.id) throw new Error("Failed to insert/resolve strategy version");

    // 2. Ensure indicator definitions exist
    await client.query(`
      INSERT INTO indicator_definitions (indicator_code, algorithm_version, parameters, parameters_hash, output_schema)
      VALUES 
        ('SMA', 'v1', '{"period": 20}'::jsonb, 'sma_20', '{}'::jsonb),
        ('BOLLINGER_BANDS', 'v1', '{"period": 20, "stdDev": 2}'::jsonb, 'bb_20_2', '{}'::jsonb),
        ('RSI', 'v1', '{"period": 14}'::jsonb, 'rsi_14', '{}'::jsonb)
      ON CONFLICT DO NOTHING
    `);

    // 3. Ensure pattern definitions exist
    await client.query(`
      INSERT INTO pattern_definitions (pattern_code, category, algorithm_version, description)
      VALUES 
        ('BULLISH_ENGULFING', 'CANDLESTICK', 'v1', 'Bullish Engulfing reversal pattern'),
        ('BEARISH_ENGULFING', 'CANDLESTICK', 'v1', 'Bearish Engulfing reversal pattern'),
        ('DOJI', 'CANDLESTICK', 'v1', 'Doji indecision pattern')
      ON CONFLICT DO NOTHING
    `);

    const indMapRes = await client.query<{ id: string; indicator_code: string }>("SELECT id, indicator_code FROM indicator_definitions");
    const indMap = new Map<string, string>();
    indMapRes.rows.forEach((r) => indMap.set(r.indicator_code, r.id));

    const patMapRes = await client.query<{ id: string; pattern_code: string }>("SELECT id, pattern_code FROM pattern_definitions");
    const patMap = new Map<string, string>();
    patMapRes.rows.forEach((r) => patMap.set(r.pattern_code, r.id));

    const smaId = indMap.get("SMA");
    const bbId = indMap.get("BOLLINGER_BANDS");
    const rsiId = indMap.get("RSI");

    // 4. Seed candles for NIFTY50 & BANKNIFTY across 1d, 1h, 15m, 5m, 1m timeframes
    const instRes = await client.query<{ id: string; symbol: string }>("SELECT id, symbol FROM instruments WHERE symbol IN ('NIFTY50', 'BANKNIFTY')");
    for (const inst of instRes.rows) {
        const yfSymbol = resolveYahooSymbol(inst.symbol);

        const timeframes = [
          { tf: "1d", count: 100, intervalMs: 24 * 3600 * 1000 },
          { tf: "1h", count: 100, intervalMs: 3600 * 1000 },
          { tf: "15m", count: 100, intervalMs: 15 * 60 * 1000 },
          { tf: "5m", count: 100, intervalMs: 5 * 60 * 1000 },
          { tf: "1m", count: 100, intervalMs: 60 * 1000 },
        ];

        const now = new Date();
        for (const { tf, count, intervalMs } of timeframes) {
          console.info(`Seeding ${inst.symbol} ${tf}... fetching real data`);

          const timeWindow = count * intervalMs * 1.5; 
          const period1 = new Date(now.getTime() - timeWindow);

          let quotes: any[] = [];
          try {
            const YahooFinance = (await import('yahoo-finance2')).default;
            const yf = new (YahooFinance as any)();
            const result = await yf.chart(yfSymbol, {
              period1: period1,
              interval: tf as any,
            });
            
            quotes = result.quotes || [];
            if (quotes.length > count) {
              quotes = quotes.slice(quotes.length - count);
            }
          } catch (e: any) {
            console.error(`Failed to fetch real data for ${yfSymbol} ${tf}: ${e.message}`);
            continue; 
          }

          if (quotes.length === 0) {
            console.warn(`No real data returned for ${yfSymbol} ${tf}`);
            continue;
          }

          let lastRsiValue = 50;

          let prices: number[] = [];
          
          for (let i = 0; i < quotes.length; i++) {
            const q = quotes[i];
            const date = new Date(q.date);
            const open = Number((q.open ?? q.close ?? 0).toFixed(2));
            const close = Number((q.close ?? 0).toFixed(2));
            // Rounding each leg on its own can push the extremes inside the body —
            // a high of 24175.599 rounds to 24175.60 while its open stays 24175.599609 —
            // and the candles_check1/check2 invariants then reject the row. Widening to
            // the rounded body keeps the bar consistent with what is actually stored.
            const high = Math.max(Number((q.high ?? Math.max(open, close)).toFixed(2)), open, close);
            const low = Math.min(Number((q.low ?? Math.min(open, close)).toFixed(2)), open, close);
            const volume = q.volume ?? 0;

            if (close === 0) continue;

            prices.push(close);
            if (prices.length > 20) prices.shift();

            const candleId = await upsertSeedCandle(client, {
              instrumentId: inst.id,
              timeframe: tf,
              openTime: date,
              closeTime: new Date(date.getTime() + intervalMs - 1),
              open,
              high,
              low,
              close,
              volume,
            });

            let sma = close;
            let bbMiddle = close;
            let bbUpper = close * 1.01;
            let bbLower = close * 0.99;

            if (prices.length === 20) {
              sma = prices.reduce((a, b) => a + b, 0) / 20;
              bbMiddle = sma;
              const variance = prices.reduce((a, b) => a + Math.pow(b - sma, 2), 0) / 20;
              const stdDev = Math.sqrt(variance);
              bbUpper = bbMiddle + (stdDev * 2);
              bbLower = bbMiddle - (stdDev * 2);
            }

            if (smaId) {
              await client.query(`
                INSERT INTO indicator_snapshots (candle_id, indicator_definition_id, values, calculated_at)
                VALUES ($1, $2, $3::jsonb, $4)
                ON CONFLICT (candle_id, indicator_definition_id) DO UPDATE SET values = EXCLUDED.values
              `, [candleId, smaId, JSON.stringify({ value: Number(sma.toFixed(2)) }), date]);
            }

            if (bbId) {
              await client.query(`
                INSERT INTO indicator_snapshots (candle_id, indicator_definition_id, values, calculated_at)
                VALUES ($1, $2, $3::jsonb, $4)
                ON CONFLICT (candle_id, indicator_definition_id) DO UPDATE SET values = EXCLUDED.values
              `, [candleId, bbId, JSON.stringify({ 
                upper: Number(bbUpper.toFixed(2)), 
                middle: Number(bbMiddle.toFixed(2)), 
                lower: Number(bbLower.toFixed(2)) 
              }), date]);
            }

            const rsiValue = simpleRsi(prices);
            if (rsiId && rsiValue !== null) {
              lastRsiValue = rsiValue;
              await client.query(`
                INSERT INTO indicator_snapshots (candle_id, indicator_definition_id, values, calculated_at)
                VALUES ($1, $2, $3::jsonb, $4)
                ON CONFLICT (candle_id, indicator_definition_id) DO UPDATE SET values = EXCLUDED.values
              `, [candleId, rsiId, JSON.stringify({ value: Number(rsiValue.toFixed(2)) }), date]);
            }

            // No seeded pattern_detections row.
            //
            // This wrote BULLISH_ENGULFING with `confidence = 0.85 + random() * 0.1`
            // and a description of "Test Pattern on Real Data" whenever a candle
            // merely closed up. A bullish engulfing is a two-candle relationship, so
            // the detection was wrong independently of its invented confidence, and
            // it landed in the same table the real detector writes to.
            //
            // Real detections come from `npm run analysis:detect-patterns`, which
            // uses the tested candlestick-pattern-engine.

            // No market_context_embeddings row is written. This used to invent an
            // RSI (`Math.floor(40 + Math.random() * 30)`), describe it in a string,
            // and store a hash of that string as a 384-d "embedding" -- a fabricated
            // number wrapped in a fabricated vector.
          }

        // No seeded trade_ideas row.
        //
        // This previously inserted a LONG proposal from `lastCandleClose` with a
        // hard-coded 1.5% stop / 3% target and the reasoning string
        // "Seeded breakout momentum proposal ready for paper simulation". That row
        // lived in the same table real strategy evaluation writes to, so the
        // Strategy dashboard could not tell a demo placeholder from a rule-scored
        // idea. Real proposals come from `analysis:generate-trade-ideas` (or the
        // Generate Proposals button), which runs TrendBreakoutStrategy over real
        // indicator/pattern evidence.
      }
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

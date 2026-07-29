import type { DatabasePool } from "../../../infrastructure/database/database.js";
import { generatePseudoEmbedding } from "../../strategy-engine/application/ai-autonomous-agent.js";
import { resolveYahooSymbol } from "../../market-data/domain/yahoo-symbol-resolver.js";

export async function seedScalpData(database: DatabasePool): Promise<void> {
  const client = await database.connect();
  try {
    await client.query("BEGIN");

    const stratRes = await client.query<{ id: string }>(`
      INSERT INTO strategies (strategy_key, name, description, is_archived)
      VALUES ('momentum-scalp', 'Momentum Scalp', 'Fast EMA crossover with VWAP and RSI', FALSE)
      ON CONFLICT (strategy_key) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `);
    const strategyId = stratRes.rows[0]?.id;
    if (!strategyId) throw new Error("Failed to insert/resolve strategy");

    const verRes = await client.query<{ id: string }>(`
      INSERT INTO strategy_versions (strategy_id, version, configuration, is_active)
      VALUES ($1, 1, '{"expiryCandles": 5}'::jsonb, TRUE)
      ON CONFLICT (strategy_id, version) DO UPDATE SET is_active = TRUE
      RETURNING id
    `, [strategyId]);
    const strategyVersionId = verRes.rows[0]?.id;
    if (!strategyVersionId) throw new Error("Failed to insert/resolve strategy version");

    await client.query(`
      INSERT INTO indicator_definitions (indicator_code, algorithm_version, parameters, parameters_hash, output_schema)
      VALUES 
        ('EMA', 'v1', '{"period": 9}'::jsonb, 'ema_9', '{}'::jsonb),
        ('EMA', 'v1', '{"period": 20}'::jsonb, 'ema_20', '{}'::jsonb),
        ('VWAP', 'v1', '{}'::jsonb, 'vwap', '{}'::jsonb),
        ('RSI', 'v1', '{"period": 14}'::jsonb, 'rsi_14', '{}'::jsonb)
      ON CONFLICT DO NOTHING
    `);

    const indMapRes = await client.query<{ id: string; indicator_code: string; parameters_hash: string }>("SELECT id, indicator_code, parameters_hash FROM indicator_definitions");
    const indMap = new Map<string, string>();
    indMapRes.rows.forEach((r) => indMap.set(r.parameters_hash, r.id));

    const ema9Id = indMap.get("ema_9");
    const ema20Id = indMap.get("ema_20");
    const vwapId = indMap.get("vwap");
    const rsiId = indMap.get("rsi_14");

    const instRes = await client.query<{ id: string; symbol: string }>("SELECT id, symbol FROM instruments WHERE symbol IN ('NIFTY50', 'BANKNIFTY')");
    for (const inst of instRes.rows) {
        const yfSymbol = resolveYahooSymbol(inst.symbol);

        const timeframes = [
          { tf: "1m", count: 7 * 375, intervalMs: 60 * 1000 },
        ];

        const now = new Date();
        for (const { tf, count, intervalMs } of timeframes) {
          console.info(`Seeding scalp ${inst.symbol} ${tf}... fetching real data`);

          const period1 = new Date(now.getTime() - (7 * 24 * 3600 * 1000));

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

          let lastCandleId: string | null = null;
          let lastCandleClose: number = 0;
          let prices: number[] = [];
          
          let sessionKey = "";
          let cumulativePriceVolume = 0;
          let cumulativeVolume = 0;

          for (let i = 0; i < quotes.length; i++) {
            const q = quotes[i];
            const date = new Date(q.date);
            const open = Number((q.open ?? q.close ?? 0).toFixed(2));
            const close = Number((q.close ?? 0).toFixed(2));
            const high = Number((q.high ?? Math.max(open, close)).toFixed(2));
            const low = Number((q.low ?? Math.min(open, close)).toFixed(2));
            const volume = q.volume ?? 0;
            
            if (close === 0) continue;

            prices.push(close);
            if (prices.length > 20) prices.shift();

            const candRes = await client.query<{ id: string }>(`
              INSERT INTO candles (instrument_id, timeframe, open_time, close_time, open, high, low, close, volume, is_complete, source)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, 'seed')
              ON CONFLICT (instrument_id, timeframe, open_time) DO UPDATE
              SET close = EXCLUDED.close, high = EXCLUDED.high, low = EXCLUDED.low, volume = EXCLUDED.volume
              RETURNING id
            `, [inst.id, tf, date, new Date(date.getTime() + intervalMs - 1), open, high, low, close, volume]);

            const candleId = candRes.rows[0].id;
            lastCandleId = candleId;
            lastCandleClose = close;

            let ema9 = close;
            let ema20 = close;

            if (prices.length === 20) {
              ema9 = prices.slice(11).reduce((a, b) => a + b, 0) / 9;
              ema20 = prices.reduce((a, b) => a + b, 0) / 20;
            }

            const localSessionKey = new Date(date.getTime() + 5.5 * 60 * 60_000).toISOString().slice(0, 10);
            if (localSessionKey !== sessionKey) {
              sessionKey = localSessionKey;
              cumulativePriceVolume = 0;
              cumulativeVolume = 0;
            }
            if (volume > 0) {
              const typicalPrice = (high + low + close) / 3;
              cumulativePriceVolume += typicalPrice * volume;
              cumulativeVolume += volume;
            }
            const vwap = cumulativeVolume > 0 ? (cumulativePriceVolume / cumulativeVolume) : close;

            if (ema9Id) {
              await client.query(`
                INSERT INTO indicator_snapshots (candle_id, indicator_definition_id, values, calculated_at)
                VALUES ($1, $2, $3::jsonb, $4)
                ON CONFLICT (candle_id, indicator_definition_id) DO UPDATE SET values = EXCLUDED.values
              `, [candleId, ema9Id, JSON.stringify({ value: Number(ema9.toFixed(2)) }), date]);
            }

            if (ema20Id) {
              await client.query(`
                INSERT INTO indicator_snapshots (candle_id, indicator_definition_id, values, calculated_at)
                VALUES ($1, $2, $3::jsonb, $4)
                ON CONFLICT (candle_id, indicator_definition_id) DO UPDATE SET values = EXCLUDED.values
              `, [candleId, ema20Id, JSON.stringify({ value: Number(ema20.toFixed(2)) }), date]);
            }

            if (vwapId) {
                await client.query(`
                  INSERT INTO indicator_snapshots (candle_id, indicator_definition_id, values, calculated_at)
                  VALUES ($1, $2, $3::jsonb, $4)
                  ON CONFLICT (candle_id, indicator_definition_id) DO UPDATE SET values = EXCLUDED.values
                `, [candleId, vwapId, JSON.stringify({ value: Number(vwap.toFixed(2)) }), date]);
            }

            if (rsiId) {
              const lastRsiValue = Math.floor(40 + Math.random() * 30);
              await client.query(`
                INSERT INTO indicator_snapshots (candle_id, indicator_definition_id, values, calculated_at)
                VALUES ($1, $2, $3::jsonb, $4)
                ON CONFLICT (candle_id, indicator_definition_id) DO UPDATE SET values = EXCLUDED.values
              `, [candleId, rsiId, JSON.stringify({ value: lastRsiValue }), date]);
            }
          }

        if (lastCandleId) {
          const entryPrice = lastCandleClose;
          const stopLoss = Number((lastCandleClose * 0.999).toFixed(2));
          const targetPrice = Number((lastCandleClose * 1.002).toFixed(2));

          await client.query(`
            INSERT INTO trade_ideas (
              instrument_id, strategy_version_id, source_candle_id, side, status,
              entry_price, stop_loss, target_price, risk_reward, confidence, reasoning, evidence
            ) VALUES (
              $1, $2, $3, 'LONG', 'PROPOSED', $4, $5, $6, 2.0, 0.82,
              '["Seeded momentum scalp proposal ready for paper simulation"]'::jsonb,
              '{"strategy": "momentum-scalp", "vwap": 58}'::jsonb
            )
            ON CONFLICT (strategy_version_id, source_candle_id, side)
            WHERE strategy_version_id IS NOT NULL AND source_candle_id IS NOT NULL
            DO UPDATE SET status = 'PROPOSED', entry_price = EXCLUDED.entry_price, stop_loss = EXCLUDED.stop_loss, target_price = EXCLUDED.target_price
          `, [inst.id, strategyVersionId, lastCandleId, entryPrice, stopLoss, targetPrice]);
        }
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

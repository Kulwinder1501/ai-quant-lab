import type { DatabasePool } from "../../../infrastructure/database/database.js";
import { resolveYahooSymbol } from "../../market-data/domain/yahoo-symbol-resolver.js";
import { simpleRsi } from "../domain/simple-rsi.js";
import { upsertSeedCandle } from "./upsert-seed-candle.js";
import {
  defaultMomentumScalpStrategyConfiguration,
  momentumScalpStrategyRegistration,
  momentumScalpStrategyVersion,
} from "../../strategy-engine/domain/momentum-scalp-strategy.js";

export async function seedScalpData(database: DatabasePool): Promise<void> {
  const client = await database.connect();
  try {
    await client.query("BEGIN");

    const stratRes = await client.query<{ id: string }>(`
      INSERT INTO strategies (strategy_key, name, description, is_archived)
      VALUES ('momentum-scalp', $1, $2, FALSE)
      ON CONFLICT (strategy_key) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `, [momentumScalpStrategyRegistration.name, momentumScalpStrategyRegistration.description]);
    const strategyId = stratRes.rows[0]?.id;
    if (!strategyId) throw new Error("Failed to insert/resolve strategy");

    // Register the same version and full configuration the strategy code declares,
    // rather than a `{"expiryCandles": 5}` stub that the momentum-scalp parser
    // rejects. An is_active strategy version whose configuration cannot be parsed
    // is a latent trap: anything that loads and parses the active version throws,
    // and it drifts from the version the generator's `ensure` actually creates.
    // Matching the registration keeps the seed and the code on one version, and
    // the config is jsonb-equal to what `ensure` writes, so it will not trip the
    // immutable-configuration guard.
    const verRes = await client.query<{ id: string }>(`
      INSERT INTO strategy_versions (strategy_id, version, configuration, is_active)
      VALUES ($1, $2, $3::jsonb, TRUE)
      ON CONFLICT (strategy_id, version) DO UPDATE SET is_active = TRUE
      RETURNING id
    `, [strategyId, momentumScalpStrategyVersion, JSON.stringify(defaultMomentumScalpStrategyConfiguration)]);
    if (!verRes.rows[0]?.id) throw new Error("Failed to insert/resolve strategy version");

    // These demo indicators are deliberately registered under 'v1', NOT the real
    // 'ta-v1' contract, and that separation is intentional — do not "align" them.
    // Every value here is now computed from real closes (the RSI used to be
    // `Math.floor(40 + Math.random() * 30)`), but they are still approximations of
    // the production algorithms: the EMAs are simple means over a 20-close window
    // rather than exponential, and the RSI is the plain textbook average rather than
    // Wilder-smoothed. momentum-scalp resolves indicators by (code, algorithmVersion,
    // params) and `findIndicator` checks only the config's parameter keys, so
    // promoting these to 'ta-v1' would let the strategy match an approximation
    // against its {period:14} rule and resolve trades from it. Real scalp ideas come
    // from `analysis:calculate-indicators` (which now includes the EMA-9 fast leg)
    // writing genuine 'ta-v1' snapshots; these seed rows only keep the demo candles
    // from being bare before that runs.
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

            // Was `Math.floor(40 + Math.random() * 30)` -- a random number stored as a
            // measured indicator, and the source of every fabricated RSI row in the
            // database. Now computed from the same closes the EMAs above use.
            const rsiValue = rsiId ? simpleRsi(prices) : null;
            if (rsiId && rsiValue !== null) {
              await client.query(`
                INSERT INTO indicator_snapshots (candle_id, indicator_definition_id, values, calculated_at)
                VALUES ($1, $2, $3::jsonb, $4)
                ON CONFLICT (candle_id, indicator_definition_id) DO UPDATE SET values = EXCLUDED.values
              `, [candleId, rsiId, JSON.stringify({ value: Number(rsiValue.toFixed(2)) }), date]);
            }
          }

        // No seeded trade_ideas row.
        //
        // This previously inserted BOTH a LONG and a SHORT from the same
        // `lastCandleClose`, with ±0.1%/±0.2% fabricated geometry. That is
        // physically impossible under MomentumScalpStrategy: LONG requires price
        // above VWAP with fast EMA above slow, SHORT requires the opposite, so a
        // single bar can never satisfy both. The unique key
        // (strategy_version_id, source_candle_id, side) let both rows coexist, and
        // the Strategy dashboard then showed a LONG and a SHORT sharing one entry
        // price and one candle close time as if the engine had flipped a coin.
        //
        // Real proposals come from `analysis:generate-trade-ideas` (use --lookback
        // to scan history) or the Generate Proposals button, which runs the actual
        // rule set and returns at most one side per candle.
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

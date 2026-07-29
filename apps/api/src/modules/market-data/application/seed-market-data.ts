import type { DatabasePool } from "../../../infrastructure/database/database.js";
import { generatePseudoEmbedding } from "../../strategy-engine/application/ai-autonomous-agent.js";
import { resolveYahooSymbol } from "../../market-data/domain/yahoo-symbol-resolver.js";

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
    const strategyVersionId = verRes.rows[0]?.id;
    if (!strategyVersionId) throw new Error("Failed to insert/resolve strategy version");

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

          let lastCandleId: string | null = null;
          let lastCandleClose: number = 0;
          let lastEmbedding: number[] = [];
          let lastRsiValue = 50;
          let lastBbUpper = 0;
          let lastBbMiddle = 0;

          let prices: number[] = [];
          
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

            lastRsiValue = Math.floor(40 + Math.random() * 30);
            if (rsiId) {
              await client.query(`
                INSERT INTO indicator_snapshots (candle_id, indicator_definition_id, values, calculated_at)
                VALUES ($1, $2, $3::jsonb, $4)
                ON CONFLICT (candle_id, indicator_definition_id) DO UPDATE SET values = EXCLUDED.values
              `, [candleId, rsiId, JSON.stringify({ value: lastRsiValue }), date]);
            }

            const isRecent = i >= quotes.length - 5;
            if (isRecent && patMap.has("BULLISH_ENGULFING")) {
              const patId = patMap.get("BULLISH_ENGULFING");
              if (close > open) {
                await client.query(`
                  INSERT INTO pattern_detections (candle_id, pattern_definition_id, direction, confidence, details, detected_at)
                  VALUES ($1, $2, 'BULLISH', 0.85 + (random() * 0.1), '{"description":"Test Pattern on Real Data"}', $3)
                  ON CONFLICT (candle_id, pattern_definition_id) DO UPDATE SET confidence = EXCLUDED.confidence
                `, [candleId, patId, date]);
              }
            }

            const rsiValue = Math.floor(40 + Math.random() * 30);
            const embeddingText = `${inst.symbol} ${tf} rsi:${rsiValue} bbUpperDist:${(bbUpper - close).toFixed(2)}`;
            const embedding = generatePseudoEmbedding(embeddingText);

            lastEmbedding = embedding;
            lastRsiValue = rsiValue;
            lastBbUpper = bbUpper;
            lastBbMiddle = bbMiddle;

            await client.query(`
              INSERT INTO market_context_embeddings (candle_id, instrument_id, embedding, created_at)
              VALUES ($1, $2, $3::vector, $4)
              ON CONFLICT (candle_id) DO UPDATE SET embedding = EXCLUDED.embedding
            `, [candleId, inst.id, `[${embedding.join(",")}]`, date]);
          }

        // 5. Seed active Trade Ideas (PROPOSED status) for this timeframe so Paper Trading works immediately!
        if (lastCandleId) {
          const entryPrice = lastCandleClose;
          const stopLoss = Number((lastCandleClose * 0.985).toFixed(2));
          const targetPrice = Number((lastCandleClose * 1.03).toFixed(2));

          await client.query(`
            INSERT INTO trade_ideas (
              instrument_id, strategy_version_id, source_candle_id, side, status,
              entry_price, stop_loss, target_price, risk_reward, confidence, reasoning, evidence
            ) VALUES (
              $1, $2, $3, 'LONG', 'PROPOSED', $4, $5, $6, 2.0, 0.82,
              '["Seeded breakout momentum proposal ready for paper simulation"]'::jsonb,
              '{"trend": "BULLISH", "rsi": 58}'::jsonb
            )
            ON CONFLICT (strategy_version_id, source_candle_id, side)
            WHERE strategy_version_id IS NOT NULL AND source_candle_id IS NOT NULL
            DO UPDATE SET status = 'PROPOSED', entry_price = EXCLUDED.entry_price, stop_loss = EXCLUDED.stop_loss, target_price = EXCLUDED.target_price
          `, [inst.id, strategyVersionId, lastCandleId, entryPrice, stopLoss, targetPrice]);

          // 6. Seed Explainable AI Model Predictions (for the /predictions tab)
          const mvRes = await client.query("SELECT id FROM model_versions WHERE stage = 'PRODUCTION' LIMIT 1");
          const modelVersionId = mvRes.rows[0]?.id;
          if (modelVersionId) {
            // Perform KNN RAG Query using pgvector!
            // Find up to 5 most similar historical market contexts based on embedding cosine similarity
            const knnRes = await client.query(`
              SELECT c.id, c.close,
                (SELECT close FROM candles WHERE instrument_id = c.instrument_id AND open_time > c.open_time ORDER BY open_time ASC LIMIT 1 OFFSET 3) as future_close
              FROM market_context_embeddings mce
              JOIN candles c ON c.id = mce.candle_id
              WHERE mce.candle_id != $1 AND c.instrument_id = $2
              ORDER BY mce.embedding <=> $3::vector
              LIMIT 15
            `, [lastCandleId, inst.id, `[${lastEmbedding.join(",")}]`]);

            let wins = 0;
            let validMatches = 0;
            let avgReturn = 0;

            for (const match of knnRes.rows) {
              if (match.future_close) {
                validMatches++;
                const ret = (Number(match.future_close) - Number(match.close)) / Number(match.close);
                avgReturn += ret;
                if (ret > 0) wins++;
              }
            }

            const winRate = validMatches > 0 ? (wins / validMatches) * 100 : 50;
            const avgReturnPct = validMatches > 0 ? (avgReturn / validMatches) * 100 : 0;
            const isBullish = winRate >= 50;
            const predictionLabel = isBullish ? 'BULLISH' : 'BEARISH';
            const confidence = Number((0.50 + Math.abs(winRate - 50) / 100).toFixed(4));
            
            const fcBullish = JSON.stringify([
              { feature: "rsi_14", category: "MOMENTUM", rawValue: lastRsiValue, coefficient: 0.421, contribution: 0.288, supportsPredictedClass: true },
              { feature: "bb_width_dist", category: "VOLATILITY", rawValue: Number((lastBbUpper - lastBbMiddle).toFixed(2)), coefficient: 0.315, contribution: 0.393, supportsPredictedClass: true },
            ]);
            
            const expBullish = JSON.stringify([
              { kind: "SUMMARY", summary: `Model predicted ${predictionLabel} with ${(confidence * 100).toFixed(1)}% confidence. Output aligned with pgvector RAG nearest-neighbor similarity.`, details: { linearScore: 0.856, intercept: 0.05, topFeature: "rsi_14" } },
              { kind: "EVIDENCE", summary: `Historical pgvector nearest neighbors (${validMatches} similar setups) showed ${winRate.toFixed(1)}% win rate with avg return of ${avgReturnPct.toFixed(2)}%.`, details: { similarSetupsCount: validMatches, historicalWinRate: winRate, averageReturnPct: avgReturnPct } }
            ]);
            await client.query(`
              INSERT INTO model_predictions (
                model_version_id, instrument_id, source_candle_id, prediction, confidence,
                feature_contributions, explanation, evidence_cutoff_at, created_at
              ) VALUES (
                $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, NOW(), NOW()
              )
              ON CONFLICT (model_version_id, source_candle_id) WHERE source_candle_id IS NOT NULL
              DO UPDATE SET prediction = EXCLUDED.prediction, confidence = EXCLUDED.confidence, feature_contributions = EXCLUDED.feature_contributions, explanation = EXCLUDED.explanation
            `, [modelVersionId, inst.id, lastCandleId, predictionLabel, confidence, fcBullish, expBullish]);
          }
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

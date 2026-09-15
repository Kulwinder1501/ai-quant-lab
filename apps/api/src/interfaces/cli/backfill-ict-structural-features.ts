import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresInstrumentRepository } from "../../infrastructure/database/repositories/postgres-instrument-repository.js";
import { PostgresCandleRepository } from "../../infrastructure/database/repositories/postgres-candle-repository.js";
import { computeIctSnapshotsForContexts } from "../../modules/technical-analysis/domain/ict/replay-builder.js";
import { extractIctStructuralFeatures } from "../../modules/technical-analysis/domain/ict/feature-extraction.js";
import type { StrategyMarketContext } from "../../modules/strategy-engine/domain/strategy.js";
import { getOption, requireOption } from "./arguments.js";

/**
 * Backfills `ict_structural_features` from `candles`, computing the ICT engine and the structural
 * feature extraction fresh from raw history rather than reading the (now-truncated)
 * `ict_state_snapshots` cache -- this is the recompute path that cache is supposed to warm, run
 * explicitly and in bulk for the ml-feature-v-ict experiment rather than one bar at a time on demand.
 *
 * One instrument+timeframe per invocation, computed as a SINGLE continuous replay (no chunking):
 * chunking was measured to distort ICT results materially (see
 * ict-implementation-vs-source-doctrine memory, "chunking was materially distorting results") because
 * every chunk boundary restarts structure/bias/zone state from cold, so this accepts the memory cost
 * of a long, unchunked replay rather than repeat that mistake for a feature-only backfill.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const symbol = requireOption(args, "symbol");
  const timeframe = requireOption(args, "timeframe");
  const batchSize = Number(getOption(args, "batch-size") ?? "2000");

  const database = createDatabasePool(loadEnvironment().DATABASE_URL);
  try {
    const instrumentRepository = new PostgresInstrumentRepository(database);
    const candleRepository = new PostgresCandleRepository(database);

    const instrument = await instrumentRepository.findByExchangeAndSymbol("NSE", symbol);
    if (!instrument) throw new Error(`Unknown instrument: NSE:${symbol}`);

    const candles = await candleRepository.listCompleted(instrument.id, timeframe);
    if (candles.length === 0) {
      console.info(JSON.stringify({ level: "info", message: "No completed candles found", symbol, timeframe }));
      return;
    }

    const contexts: StrategyMarketContext[] = candles.map((c) => ({
      candle: {
        id: c.id,
        instrumentId: c.instrumentId,
        timeframe: c.timeframe,
        openTime: c.openTime,
        closeTime: c.closeTime,
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume),
        tickSize: Number(instrument.tickSize),
      },
      indicators: [],
      patterns: [],
      priceActionEvents: [],
    }));

    console.info(
      JSON.stringify({ level: "info", message: "Computing ICT snapshots", symbol, timeframe, bars: contexts.length })
    );
    const snapshots = computeIctSnapshotsForContexts(contexts);

    let written = 0;
    for (let start = 0; start < contexts.length; start += batchSize) {
      const end = Math.min(start + batchSize, contexts.length);
      const values: unknown[] = [];
      const rowPlaceholders: string[] = [];
      for (let i = start; i < end; i += 1) {
        const context = contexts[i];
        const snapshot = snapshots[i];
        const features = extractIctStructuralFeatures(snapshot, context.candle.close);
        const base = values.length;
        values.push(
          context.candle.id,
          instrument.id,
          timeframe,
          context.candle.openTime,
          snapshot.engineVersion,
          snapshot.configHash,
          features.htfBias,
          features.premiumDiscountZone,
          features.distanceToNearestOrderBlock,
          features.nearestOrderBlockSide,
          features.hasBosLevel,
          features.hasChochLevel,
          features.distanceToBosLevel,
          features.distanceToChochLevel
        );
        rowPlaceholders.push(
          `(${Array.from({ length: 14 }, (_, j) => `$${base + j + 1}`).join(", ")})`
        );
      }

      await database.query(
        `
          INSERT INTO ict_structural_features (
            candle_id, instrument_id, timeframe, bar_time, engine_version, config_hash,
            htf_bias, premium_discount_zone, distance_to_nearest_order_block, nearest_order_block_side,
            has_bos_level, has_choch_level, distance_to_bos_level, distance_to_choch_level
          ) VALUES ${rowPlaceholders.join(", ")}
          ON CONFLICT (candle_id) DO UPDATE SET
            instrument_id = EXCLUDED.instrument_id,
            timeframe = EXCLUDED.timeframe,
            bar_time = EXCLUDED.bar_time,
            engine_version = EXCLUDED.engine_version,
            config_hash = EXCLUDED.config_hash,
            htf_bias = EXCLUDED.htf_bias,
            premium_discount_zone = EXCLUDED.premium_discount_zone,
            distance_to_nearest_order_block = EXCLUDED.distance_to_nearest_order_block,
            nearest_order_block_side = EXCLUDED.nearest_order_block_side,
            has_bos_level = EXCLUDED.has_bos_level,
            has_choch_level = EXCLUDED.has_choch_level,
            distance_to_bos_level = EXCLUDED.distance_to_bos_level,
            distance_to_choch_level = EXCLUDED.distance_to_choch_level
        `,
        values
      );
      written += end - start;
      console.info(
        JSON.stringify({ level: "info", message: "Backfill progress", symbol, timeframe, written, total: contexts.length })
      );
    }

    console.info(JSON.stringify({ level: "info", message: "ICT structural feature backfill complete", symbol, timeframe, written }));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

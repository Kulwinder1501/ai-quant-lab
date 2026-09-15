import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresInstrumentRepository } from "../../infrastructure/database/repositories/postgres-instrument-repository.js";
import { PostgresCandleRepository } from "../../infrastructure/database/repositories/postgres-candle-repository.js";
import type { PersistedCandle } from "../../modules/market-data/domain/candle.js";
import { computeIctSnapshotsForContexts } from "../../modules/technical-analysis/domain/ict/replay-builder.js";
import { extractIctStructuralFeatures } from "../../modules/technical-analysis/domain/ict/feature-extraction.js";
import { alignHtfSnapshotsToLtf, type HtfSnapshotWithCloseTime } from "../../modules/technical-analysis/domain/ict/refined-order-block.js";
import type { IctStateCompositeSnapshot } from "../../modules/technical-analysis/domain/ict/config.js";
import type { Instrument } from "../../modules/market-data/domain/instrument.js";
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
 *
 * `--htf-timeframe` is optional. When supplied, this also replays a second, real higher-timeframe
 * candle series (not a synthetic session bucket -- the doctrine's examples use real 4H/1H/30m bars),
 * aligns it onto the LTF timeline anti-lookahead (`alignHtfSnapshotsToLtf`), and extracts the
 * cross-timeframe "Refined Order Block" fields alongside the naive, same-timeframe ones.
 */
function toContexts(candles: readonly PersistedCandle[], instrument: Instrument): StrategyMarketContext[] {
  return candles.map((c) => ({
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
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const symbol = requireOption(args, "symbol");
  const timeframe = requireOption(args, "timeframe");
  const htfTimeframe = getOption(args, "htf-timeframe") ?? null;
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
    const contexts = toContexts(candles, instrument);

    console.info(
      JSON.stringify({ level: "info", message: "Computing LTF ICT snapshots", symbol, timeframe, bars: contexts.length })
    );
    const snapshots = computeIctSnapshotsForContexts(contexts);

    let alignedHtfSnapshots: (IctStateCompositeSnapshot | null)[] = contexts.map(() => null);
    if (htfTimeframe) {
      const htfCandles = await candleRepository.listCompleted(instrument.id, htfTimeframe);
      if (htfCandles.length === 0) {
        throw new Error(`--htf-timeframe ${htfTimeframe} requested but no completed candles exist for it.`);
      }
      const htfContexts = toContexts(htfCandles, instrument);
      console.info(
        JSON.stringify({ level: "info", message: "Computing HTF ICT snapshots", symbol, htfTimeframe, bars: htfContexts.length })
      );
      const htfSnapshots = computeIctSnapshotsForContexts(htfContexts);
      const htfBars: HtfSnapshotWithCloseTime[] = htfContexts.map((c, i) => ({
        closeTime: c.candle.closeTime,
        snapshot: htfSnapshots[i],
      }));
      alignedHtfSnapshots = alignHtfSnapshotsToLtf(
        htfBars,
        contexts.map((c) => c.candle.closeTime)
      );
    }

    let written = 0;
    for (let start = 0; start < contexts.length; start += batchSize) {
      const end = Math.min(start + batchSize, contexts.length);
      const values: unknown[] = [];
      const rowPlaceholders: string[] = [];
      for (let i = start; i < end; i += 1) {
        const context = contexts[i];
        const snapshot = snapshots[i];
        const features = extractIctStructuralFeatures(snapshot, context.candle.close, alignedHtfSnapshots[i]);
        const refined = features.refinedOrderBlock;
        const ote = features.ote;
        const swing = features.swingHierarchy;
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
          features.distanceToChochLevel,
          htfTimeframe,
          refined?.htfOrderBlockSide ?? null,
          refined?.htfOrderBlockDistance ?? null,
          refined?.refinedOrderBlockDistance ?? null,
          refined?.stopCompressionRatio ?? null,
          ote?.side ?? null,
          ote?.isWithinOte ?? null,
          ote?.oteBandLow ?? null,
          ote?.oteBandHigh ?? null,
          ote?.distanceToOteBand ?? null,
          swing.distanceToIntermediateTermHigh,
          swing.distanceToIntermediateTermLow,
          swing.distanceToShortTermHigh,
          swing.distanceToShortTermLow,
          swing.protectedSide,
          swing.protectedLevelBreached
        );
        rowPlaceholders.push(
          `(${Array.from({ length: 30 }, (_, j) => `$${base + j + 1}`).join(", ")})`
        );
      }

      await database.query(
        `
          INSERT INTO ict_structural_features (
            candle_id, instrument_id, timeframe, bar_time, engine_version, config_hash,
            htf_bias, premium_discount_zone, distance_to_nearest_order_block, nearest_order_block_side,
            has_bos_level, has_choch_level, distance_to_bos_level, distance_to_choch_level,
            htf_timeframe, htf_order_block_side, htf_order_block_distance,
            refined_order_block_distance, stop_compression_ratio,
            ote_side, ote_is_within, ote_band_low, ote_band_high, ote_distance_to_band,
            swing_distance_to_ith, swing_distance_to_itl, swing_distance_to_sth, swing_distance_to_stl,
            swing_protected_side, swing_protected_breached
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
            distance_to_choch_level = EXCLUDED.distance_to_choch_level,
            htf_timeframe = EXCLUDED.htf_timeframe,
            htf_order_block_side = EXCLUDED.htf_order_block_side,
            htf_order_block_distance = EXCLUDED.htf_order_block_distance,
            refined_order_block_distance = EXCLUDED.refined_order_block_distance,
            stop_compression_ratio = EXCLUDED.stop_compression_ratio,
            ote_side = EXCLUDED.ote_side,
            ote_is_within = EXCLUDED.ote_is_within,
            ote_band_low = EXCLUDED.ote_band_low,
            ote_band_high = EXCLUDED.ote_band_high,
            ote_distance_to_band = EXCLUDED.ote_distance_to_band,
            swing_distance_to_ith = EXCLUDED.swing_distance_to_ith,
            swing_distance_to_itl = EXCLUDED.swing_distance_to_itl,
            swing_distance_to_sth = EXCLUDED.swing_distance_to_sth,
            swing_distance_to_stl = EXCLUDED.swing_distance_to_stl,
            swing_protected_side = EXCLUDED.swing_protected_side,
            swing_protected_breached = EXCLUDED.swing_protected_breached
        `,
        values
      );
      written += end - start;
      console.info(
        JSON.stringify({ level: "info", message: "Backfill progress", symbol, timeframe, written, total: contexts.length })
      );
    }

    console.info(JSON.stringify({ level: "info", message: "ICT structural feature backfill complete", symbol, timeframe, htfTimeframe, written }));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

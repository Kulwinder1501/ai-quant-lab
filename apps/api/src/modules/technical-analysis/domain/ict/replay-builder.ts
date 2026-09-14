import type { StrategyMarketContext } from "../../../strategy-engine/domain/strategy.js";
import { istSessionDate } from "../../../platform/calendar/trading-session.js";
import type { CausalCandle } from "./causal-pivot.js";
import { IctCompositeEngine } from "./composite-engine.js";
import { defaultIctEngineConfig, type IctEngineConfig, type IctStateCompositeSnapshot } from "./config.js";
import type { IctBiasDirection } from "./bias.js";

/**
 * Replay-side ICT snapshot builder.
 *
 * The strategy context carries only a single completed candle, so the ICT state
 * machines (which need the whole causal series) cannot run inside a strategy
 * instance. This module owns that state instead: it walks a chronological run of
 * contexts once, drives one `IctCompositeEngine` bar by bar, and attaches an
 * immutable composite snapshot to each context. That matches the invariant that
 * state lives in the replay/snapshot builder, never in strategy-local memory.
 *
 * The higher-timeframe (fractal) pillar is derived here too, from a
 * session-anchored aggregation of the same base series. A 60m bucket's bias is
 * only visible to a base bar once the bucket has closed (`closeTime <= the base
 * bar's closeTime`); an incomplete bucket is discarded rather than emitted as a
 * shorter synthetic bar, so a partial session-end bucket never leaks.
 */

/** Base bars that make up one 60m higher-timeframe bucket, by base timeframe. */
const BARS_PER_60M_BUCKET: Readonly<Record<string, number>> = {
  "1m": 60,
  "3m": 20,
  "5m": 12,
  "10m": 6,
  "15m": 4,
  "30m": 2,
};

export interface DecorateIctOptions {
  readonly config?: IctEngineConfig;
  /**
   * Base bars per 60m HTF bucket. Defaults to the value implied by the run's
   * base timeframe; when the base timeframe has no 60m mapping (e.g. `60m`,
   * `1d`) the HTF pillar is left uncovered and the four-pillar gate fails closed.
   */
  readonly htfBarsPerBucket?: number;
}

function contextToCausalCandle(context: StrategyMarketContext): CausalCandle {
  const c = context.candle;
  return {
    id: c.id,
    openTime: c.openTime,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  };
}

interface HtfBucket {
  readonly candle: CausalCandle;
  readonly closeTime: Date;
}

/**
 * Aggregates the base contexts into complete, session-contained HTF buckets.
 *
 * A bucket accumulates base bars of one IST session until it reaches
 * `barsPerBucket`, at which point it is emitted. A bucket that is still partial
 * when the session changes is discarded — never emitted as a short bar — so no
 * bucket straddles an overnight gap and no incomplete bucket is ever visible.
 */
function aggregateSessionHtfBuckets(
  contexts: readonly StrategyMarketContext[],
  barsPerBucket: number,
): HtfBucket[] {
  const buckets: HtfBucket[] = [];
  let acc:
    | { sessionDate: string; open: number; high: number; low: number; close: number; openTime: Date; closeTime: Date; count: number; firstId: string }
    | null = null;

  const flushIfComplete = () => {
    if (acc && acc.count === barsPerBucket) {
      buckets.push({
        candle: {
          id: `htf-${acc.firstId}`,
          openTime: acc.openTime,
          open: acc.open,
          high: acc.high,
          low: acc.low,
          close: acc.close,
          volume: 0,
        },
        closeTime: acc.closeTime,
      });
      acc = null;
    }
  };

  for (const context of contexts) {
    const c = context.candle;
    const sessionDate = istSessionDate(c.openTime);

    if (acc && acc.sessionDate !== sessionDate) {
      // The session changed before the bucket filled: the partial bucket is
      // incomplete and is dropped rather than emitted as a short synthetic bar.
      acc = null;
    }

    if (!acc) {
      acc = {
        sessionDate,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        openTime: c.openTime,
        closeTime: c.closeTime,
        count: 1,
        firstId: c.id,
      };
    } else {
      acc.high = Math.max(acc.high, c.high);
      acc.low = Math.min(acc.low, c.low);
      acc.close = c.close;
      acc.closeTime = c.closeTime;
      acc.count += 1;
    }

    flushIfComplete();
  }

  return buckets;
}

/**
 * The HTF bias visible to each base bar, or `undefined` when none has closed yet.
 *
 * Bias is computed once per HTF bucket (in bucket order) and then assigned to a
 * base bar only if the bucket closed at or before that bar's close, enforcing
 * the anti-lookahead rule: a bucket closing at the same instant is visible, a
 * later one is not.
 */
export function deriveHtfBiasSeries(
  contexts: readonly StrategyMarketContext[],
  barsPerBucket: number,
  config: IctEngineConfig = defaultIctEngineConfig,
): (IctBiasDirection | undefined)[] {
  const buckets = aggregateSessionHtfBuckets(contexts, barsPerBucket);
  const htfEngine = new IctCompositeEngine(config);
  const htfCandles = buckets.map((b) => b.candle);
  const bucketBias: { closeTime: Date; bias: IctBiasDirection }[] = buckets.map((bucket, i) => {
    const snap = htfEngine.processCandle(htfCandles, i);
    return { closeTime: bucket.closeTime, bias: snap.bias.bias };
  });

  // Two ordered pointers: buckets are chronological and so are contexts, so the
  // latest visible bucket only ever moves forward.
  const series: (IctBiasDirection | undefined)[] = new Array(contexts.length).fill(undefined);
  let bucketIdx = 0;
  let latest: IctBiasDirection | undefined;
  for (let i = 0; i < contexts.length; i += 1) {
    const barClose = contexts[i].candle.closeTime.getTime();
    while (bucketIdx < bucketBias.length && bucketBias[bucketIdx].closeTime.getTime() <= barClose) {
      latest = bucketBias[bucketIdx].bias;
      bucketIdx += 1;
    }
    series[i] = latest;
  }
  return series;
}

function resolveBarsPerBucket(contexts: readonly StrategyMarketContext[], options: DecorateIctOptions): number | null {
  if (options.htfBarsPerBucket !== undefined) return options.htfBarsPerBucket;
  const timeframe = contexts[0]?.candle.timeframe;
  if (!timeframe) return null;
  return BARS_PER_60M_BUCKET[timeframe] ?? null;
}

/**
 * Computes the composite ICT snapshot for every context, in order.
 *
 * Returns an array parallel to `contexts`. Prefix-invariant by construction: the
 * snapshot at index `i` is a function of contexts `0..i` only.
 */
export function computeIctSnapshotsForContexts(
  contexts: readonly StrategyMarketContext[],
  options: DecorateIctOptions = {},
): IctStateCompositeSnapshot[] {
  const config = options.config ?? defaultIctEngineConfig;
  const barsPerBucket = resolveBarsPerBucket(contexts, options);
  const htfBiasSeries = barsPerBucket === null
    ? new Array<IctBiasDirection | undefined>(contexts.length).fill(undefined)
    : deriveHtfBiasSeries(contexts, barsPerBucket, config);

  const engine = new IctCompositeEngine(config);
  const causalCandles = contexts.map(contextToCausalCandle);
  const snapshots: IctStateCompositeSnapshot[] = [];
  for (let i = 0; i < contexts.length; i += 1) {
    snapshots.push(engine.processCandle(causalCandles, i, htfBiasSeries[i]));
  }
  return snapshots;
}

/**
 * Returns copies of the contexts with the causal ICT snapshot attached.
 *
 * The base contexts are not mutated; each returned context is a shallow copy with
 * `ictSnapshot` set, so incumbent strategies reading the same array are unaffected.
 */
export function decorateContextsWithIct(
  contexts: readonly StrategyMarketContext[],
  options: DecorateIctOptions = {},
): StrategyMarketContext[] {
  const snapshots = computeIctSnapshotsForContexts(contexts, options);
  return contexts.map((context, i) => ({ ...context, ictSnapshot: snapshots[i] }));
}

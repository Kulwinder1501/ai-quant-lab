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

export interface DecorateIctOptions {
  readonly config?: IctEngineConfig;
  /*
   * There is no bucket-size knob any more, deliberately.
   *
   * The higher timeframe is the DAILY session, because that is what the doctrine anchors on:
   * lecture 9 works monthly -> weekly -> daily, and lecture 11 names the daily timeframe 226 times
   * against 3 mentions of one-hour. The previous default was a 60m bucket, and the backtest
   * repository passed 3 bars for a 5m base -- a 15m bucket -- so two callers disagreed about what
   * "higher timeframe" even meant, and neither matched the source material.
   */
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
 * the session boundary, at which point it is emitted. A bucket that is still partial
 * when the session changes is discarded — never emitted as a short bar — so no
 * bucket straddles an overnight gap and no incomplete bucket is ever visible.
 */
/**
 * One HTF candle per COMPLETED IST session.
 *
 * A session is only complete once a bar from the next session arrives, so the trailing session is
 * never emitted -- the current, still-forming day can never become visible to a bar inside it. That
 * is the same anti-lookahead property the count-based bucketing had, obtained here for free from the
 * session boundary rather than from a bar count that had to be tuned per timeframe.
 */
function aggregateSessionHtfBuckets(
  contexts: readonly StrategyMarketContext[],
): HtfBucket[] {
  const buckets: HtfBucket[] = [];
  let acc:
    | { sessionDate: string; open: number; high: number; low: number; close: number; openTime: Date; closeTime: Date; count: number; firstId: string }
    | null = null;

  const flush = () => {
    if (acc) {
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
      // The session changed, so the accumulated session is complete: emit it as the daily candle.
      flush();
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

  }

  // No trailing flush: the final session is still forming and must never be emitted.
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
  config: IctEngineConfig = defaultIctEngineConfig,
): (IctBiasDirection | undefined)[] {
  const buckets = aggregateSessionHtfBuckets(contexts);
  /*
   * The HTF engine sits at the top of this chain, so it reads its bias from its own swing sequence.
   * Left on the default it would demand a bias from a level above it, find none, resolve UNKNOWN,
   * and starve every base bar of the bias pillar -- measured as UNKNOWN on 2,325 of 2,325 bars.
   */
  const htfEngine = new IctCompositeEngine({ ...config, biasSource: "OWN_STRUCTURE" });
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
  /*
   * Always daily. A run whose window holds fewer than two sessions produces no complete daily
   * bucket, so every bar gets `undefined`, `coverage.htf` is NOT_COVERED and the four-pillar gate
   * fails closed -- which is the honest outcome for a window too short to carry a daily bias.
   */
  const htfBiasSeries = deriveHtfBiasSeries(contexts, config);

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

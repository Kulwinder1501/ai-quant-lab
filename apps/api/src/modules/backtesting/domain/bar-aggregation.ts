import type { CompletedPriceCandle } from "../../paper-trading/domain/paper-trade-exit-policy.js";

/**
 * Builds an N-minute series from 1-minute bars, anchored to the session open.
 *
 * Experiment A compares 1m, 3m and 5m architectures, and only 1m and 5m exist in storage. Rather than
 * mix a stored 5m series with a derived 3m one -- which would make provenance an uncontrolled
 * difference between the arms -- every arm is derived from the same audited 1m bars by this function.
 *
 * ## Two rules that decide whether the result is honest
 *
 * **A bucket may never straddle a session.** An overnight gap is not three minutes of trade, and a
 * bucket spanning one would carry the gap into its range, inflating every ATR and high/low that reads
 * it. Buckets restart at each session.
 *
 * **A partial bucket at the end of a session is discarded, not published.** A 3-minute bucket holding
 * one minute of trade has a narrower range than a real one, and publishing it would feed the strategy
 * a bar that never existed. NSE's 375-minute session divides evenly by 1, 3 and 5, so in practice this
 * only fires on a short or truncated session -- which is exactly when it matters.
 *
 * The aggregation itself is the ordinary one: open of the first bar, close of the last, high and low
 * over the bucket. `openTime` comes from the first bar and `closeTime` from the last, so a consumer
 * reading `closeTime <= asOf` still sees a bar that had genuinely finished.
 */

function sessionKey(bar: CompletedPriceCandle): string {
  // The IST session date. NSE trades 09:15-15:30 IST, so a session never crosses midnight IST and the
  // UTC date would split it in two.
  return new Date(bar.closeTime.getTime() + (5 * 60 + 30) * 60_000).toISOString().slice(0, 10);
}

export function aggregateBars(
  bars: readonly CompletedPriceCandle[],
  barsPerBucket: number,
): CompletedPriceCandle[] {
  if (!Number.isInteger(barsPerBucket) || barsPerBucket < 1) {
    throw new Error("barsPerBucket must be a positive integer.");
  }
  if (barsPerBucket === 1) return [...bars];

  for (let index = 1; index < bars.length; index += 1) {
    if (bars[index]!.closeTime.getTime() <= bars[index - 1]!.closeTime.getTime()) {
      throw new Error("Bars to aggregate must be in strictly increasing chronological order.");
    }
  }

  const aggregated: CompletedPriceCandle[] = [];
  let bucket: CompletedPriceCandle[] = [];
  let currentSession = "";

  const flush = (): void => {
    // Only complete buckets are published; see the header.
    if (bucket.length !== barsPerBucket) {
      bucket = [];
      return;
    }
    const first = bucket[0]!;
    const last = bucket[bucket.length - 1]!;
    aggregated.push({
      // The bucket's identity is its closing bar, which is the instant it became knowable.
      id: last.id,
      openTime: first.openTime,
      closeTime: last.closeTime,
      open: first.open,
      high: Math.max(...bucket.map((bar) => bar.high)),
      low: Math.min(...bucket.map((bar) => bar.low)),
      close: last.close,
    });
    bucket = [];
  };

  for (const bar of bars) {
    const session = sessionKey(bar);
    if (session !== currentSession) {
      flush();
      currentSession = session;
    }
    bucket.push(bar);
    if (bucket.length === barsPerBucket) flush();
  }
  flush();

  return aggregated;
}

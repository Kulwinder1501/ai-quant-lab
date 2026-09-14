/**
 * What a stored volume of zero actually means, and why nothing volume-derived may treat it as zero
 * activity.
 *
 * ## The defect this closes
 *
 * `candles.volume` is `NOT NULL`, so a bar whose volume was never populated is stored as a literal
 * `0` — indistinguishable from a bar on which no trading occurred. Coverage measured against the
 * live database (volume-positive rows out of total):
 *
 * ```
 * BANKNIFTY  1m   59,730 / 60,000
 * BANKNIFTY  5m   11,602 / 11,729
 * BANKNIFTY 15m    7,127 / 22,501     <- ~68% zero
 * BANKNIFTY 30m    3,693 / 14,907
 * BANKNIFTY  1d      285 /  1,151
 * NIFTY50   15m    7,127 / 22,502
 * INDIAVIX   all        0             <- zero throughout
 * ```
 *
 * The zeros are not scattered — they cluster on one side of the 2025/2026 index volume break, where
 * the feed began carrying index volume at all. A rolling 20-bar window that straddles that break
 * mixes real volumes with literal zeros. Such a window has a large, entirely meaningless standard
 * deviation, so it does *not* trip the `stddev === 0` guard in `calculateZScore`; it produces an
 * enormous z-score that passes every threshold in `EffortResultEngine` and is emitted as a
 * `BUYING_CLIMAX`, `SELLING_CLIMAX` or `HIGH_EFFORT_LOW_RESULT`. The observation is not noisy — it is
 * an artefact of a schema change, recorded as if it were a market event and frozen into
 * `observationHash`.
 *
 * The rule below is therefore *not* "drop zero-volume bars from the window". Dropping them would
 * silently compute a 20-bar statistic from 6 bars and still emit a number. Volume on such a bar is
 * unknown, and a window containing an unknown yields an unknown: the whole window must be
 * volume-positive or the statistic is `null`.
 *
 * ## Index "volume" is a constituent aggregate, not auction volume
 *
 * This caveat survives the zero-handling fix and constrains how any volume-derived family may be
 * read. An index has no order book and no trades of its own. The volume stamped on a NIFTY50 or
 * BANKNIFTY candle is an aggregate of constituent cash activity — measured correlation 0.877 with
 * summed constituent cash volume, and, tellingly, with no expiry-day spike of the kind a genuine
 * derivatives tape shows.
 *
 * So a "buying climax" detected on an index tape is a statement about market-wide constituent
 * turnover, not about absorption at a price level by a counterparty. Wyckoff effort/result semantics
 * assume the second. That is why the V1.0.1 Implementation Errata (Section 1) marks `EFFORT_RESULT`
 * **BLOCKED (PARTIAL)** pending exchange-traded futures volume, and why `AUCTION_PROFILE` is blocked
 * outright: neither can be evaluated honestly against a constituent aggregate.
 *
 * ## INDIAVIX needs no guard here
 *
 * It is excluded by construction rather than by a runtime check: `ObservationSource.underlying`
 * admits only `NIFTY50` and `BANKNIFTY`, so an INDIAVIX observation is unrepresentable and a filter
 * for it would be unreachable code. Recorded because the exclusion is load-bearing — INDIAVIX carries
 * zero volume on 100% of rows, so every volume-derived statistic on it would be `null` in any case.
 */

/**
 * Whether a single stored volume can be read as a measurement at all.
 *
 * Zero is rejected because the schema cannot distinguish "no trades" from "never populated", and the
 * populated case is overwhelmingly the one that matters: a genuinely zero-volume bar on a liquid
 * index tape does not occur.
 */
export function isUsableVolume(volume: number): boolean {
  return Number.isFinite(volume) && volume > 0;
}

/** Whether every bar in a window carries usable volume, so a window statistic may be computed. */
export function isVolumeWindowUsable(volumes: readonly number[]): boolean {
  return volumes.length > 0 && volumes.every(isUsableVolume);
}

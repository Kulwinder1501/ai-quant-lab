/**
 * How a futures session's traded volume is spread over the day, against what the same time of day usually trades. Pure.
 *
 * Unlike the volume profile, **this is observed**: the bar volume Fyers reports, summed by clock bucket. Nothing is spread or
 * estimated. What it does have is a coverage question and a comparison question, and both are kept explicit:
 *
 * - **Unknown is not zero.** A bucket holds `barsPresent` of `expectedBars` one-minute bars. A minute with no stored bar is
 *   unknown; a minute whose bar says volume 0 is a genuine no-trade minute. A bucket that does not have all its bars is
 *   `complete: false`, its volume is a lower bound, and it is left out of every baseline and ratio.
 * - **The baseline is robust and only complete.** For each bucket the baseline is the median of that bucket over the previous
 *   sessions of the same contract in which the bucket was complete, with the count shown. A median, not a mean, so one
 *   expiry-day or event session does not drag it; the mean is reported beside it.
 * - **Relative volume** is the bucket's volume over its baseline median. It is null unless the bucket is complete and the
 *   baseline exists and is positive. It is a ratio of two observed numbers, not a forecast.
 * - **Cumulative volume** is compared with the median cumulative volume at the same time over previous sessions that were
 *   complete from the open to that time (not the sum of bucket medians).
 *
 * What it cannot say: volume migrates from the front month to the next month in the days before expiry, so a lower figure in
 * an expiry week can be migration rather than a quieter market. The route reports days to expiry so the screen can say so.
 */
import {
  EXPECTED_SESSION_MINUTES,
  SESSION_OPEN_MINUTE_IST,
  type FuturesBar,
} from "./session-volume-profile.js";

export const BUCKET_MINUTE_CHOICES = [5, 15, 30] as const;
/** Previous sessions offered as the baseline. */
export const BASELINE_DAY_CHOICES = [5, 10, 20] as const;

const IST_OFFSET_MS = 330 * 60_000;

export interface VolumeBucket {
  /** Minutes since midnight IST of the bucket's first minute and of the first minute after it. */
  startMinute: number;
  endMinute: number;
  /** Sum of the reported volume of the bars present, or null when no bar is present (unknown, not zero). */
  volume: number | null;
  barsPresent: number;
  expectedBars: number;
  /** Every minute of the bucket has a bar. */
  complete: boolean;
}

function minuteOfDay(instant: Date): number {
  const shifted = new Date(instant.getTime() + IST_OFFSET_MS);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

/**
 * The session's volume by clock bucket, from 09:15 in steps of `bucketMinutes` (the last bucket is shorter when the size does
 * not divide the 375 minutes). Expects regular-session bars of one day.
 * A repeated minute is counted once (the first), so a duplicated row cannot inflate a bucket.
 */
export function bucketSessionVolume(regular: readonly FuturesBar[], bucketMinutes: number): VolumeBucket[] {
  if (!Number.isInteger(bucketMinutes) || bucketMinutes <= 0) throw new Error("bucketMinutes must be a positive whole number.");
  // 375 minutes do not divide by every size (30 leaves a last bucket of 15): the last bucket is as long as what is left.
  const count = Math.ceil(EXPECTED_SESSION_MINUTES / bucketMinutes);
  const seen = new Set<number>();
  const volume: Array<number | null> = new Array<number | null>(count).fill(null);
  const present = new Array<number>(count).fill(0);
  for (const bar of regular) {
    const minute = minuteOfDay(bar.openTime);
    const index = Math.floor((minute - SESSION_OPEN_MINUTE_IST) / bucketMinutes);
    if (index < 0 || index >= count || seen.has(minute)) continue;
    seen.add(minute);
    present[index]! += 1;
    volume[index] = (volume[index] ?? 0) + (Number.isFinite(bar.volume) ? bar.volume : 0);
  }
  return Array.from({ length: count }, (_, index) => {
    const expectedBars = Math.min(bucketMinutes, EXPECTED_SESSION_MINUTES - index * bucketMinutes);
    return {
      startMinute: SESSION_OPEN_MINUTE_IST + index * bucketMinutes,
      endMinute: SESSION_OPEN_MINUTE_IST + index * bucketMinutes + expectedBars,
      volume: volume[index] ?? null,
      barsPresent: present[index]!,
      expectedBars,
      complete: present[index] === expectedBars,
    };
  });
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export interface BucketComparison extends VolumeBucket {
  /** Median of this bucket over the baseline sessions in which it was complete; null with none. */
  baselineMedian: number | null;
  baselineMean: number | null;
  /** How many baseline sessions the figures above stand on. */
  baselineSessions: number;
  /** This bucket's volume over `baselineMedian`; null unless this bucket is complete and the median is positive. */
  relative: number | null;
  /** Volume from the open through this bucket, as far as it is known: null from the first incomplete bucket on. */
  cumulative: number | null;
  /** Median cumulative volume at this time over baseline sessions complete from the open to here. */
  baselineCumulativeMedian: number | null;
  baselineCumulativeSessions: number;
  /** `cumulative` over `baselineCumulativeMedian`, same rules as `relative`. */
  cumulativeRelative: number | null;
}

/**
 * The day's buckets compared with the same buckets of the baseline sessions. `today` and every baseline session must be
 * bucketed with the same `bucketMinutes`.
 */
export function compareWithBaseline(today: readonly VolumeBucket[], baseline: ReadonlyArray<readonly VolumeBucket[]>): BucketComparison[] {
  // Cumulative volume of a session through each bucket, valid only while every bucket so far is complete.
  const cumulativeOf = (buckets: readonly VolumeBucket[]): Array<number | null> => {
    let running = 0;
    let valid = true;
    return buckets.map((bucket) => {
      if (!bucket.complete || bucket.volume === null) valid = false;
      if (valid) running += bucket.volume ?? 0;
      return valid ? running : null;
    });
  };
  const todayCumulative = cumulativeOf(today);
  const baselineCumulative = baseline.map(cumulativeOf);

  return today.map((bucket, index) => {
    const values = baseline
      .map((session) => session[index])
      .filter((other): other is VolumeBucket => other !== undefined && other.complete && other.volume !== null)
      .map((other) => other.volume!);
    const cumulativeValues = baselineCumulative.map((session) => session[index]).filter((value): value is number => value !== null && value !== undefined);
    const baselineMedian = median(values);
    const baselineCumulativeMedian = median(cumulativeValues);
    const cumulative = todayCumulative[index] ?? null;
    return {
      ...bucket,
      baselineMedian,
      baselineMean: mean(values),
      baselineSessions: values.length,
      relative: bucket.complete && bucket.volume !== null && baselineMedian !== null && baselineMedian > 0 ? bucket.volume / baselineMedian : null,
      cumulative,
      baselineCumulativeMedian,
      baselineCumulativeSessions: cumulativeValues.length,
      cumulativeRelative: cumulative !== null && baselineCumulativeMedian !== null && baselineCumulativeMedian > 0 ? cumulative / baselineCumulativeMedian : null,
    };
  });
}

/** A session's total over its buckets, or null unless every bucket is complete (a total with holes is not the day's total). */
export function completeSessionTotal(buckets: readonly VolumeBucket[]): number | null {
  if (buckets.length === 0 || buckets.some((bucket) => !bucket.complete || bucket.volume === null)) return null;
  return buckets.reduce((sum, bucket) => sum + (bucket.volume ?? 0), 0);
}

export const VOLUME_BY_TIME_DEFINITIONS = {
  observed: "Observed, not estimated: the 1-minute bar volume Fyers reports (units = contracts x lot size), summed by clock bucket. Nothing is spread across prices.",
  unknown: "A minute with no stored bar is unknown, not zero; a minute whose bar says volume 0 is a real no-trade minute. A bucket missing any minute is incomplete: its volume is a lower bound and it is left out of every baseline and ratio.",
  baseline: "For each bucket, the median of that bucket over the previous sessions of the same contract in which the bucket was complete (the count is shown). The mean is shown beside it. A roll is not crossed.",
  relative: "Relative volume: the bucket's volume over its baseline median. A ratio of two observed numbers, not a forecast.",
  cumulative: "Cumulative volume from the open, compared with the median cumulative volume at the same time over baseline sessions that were complete from the open to that time (not the sum of bucket medians).",
  migration: "Volume moves from the front month to the next month in the days before expiry, so a lower figure in an expiry week can be migration, not a quieter market.",
  notSignal: "Heavier or lighter than usual describes the past; it does not say what price does next.",
} as const;

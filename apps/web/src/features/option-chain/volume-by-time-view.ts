/**
 * Types and pure drawing and wording rules for volume by time of day. No React.
 *
 * `/api/v1/volume-by-time` returns the reported 1-minute bar volume of one futures session summed by clock bucket, next to
 * the median of the same bucket over previous sessions of the same contract. This is OBSERVED volume (unlike the volume
 * profile, nothing is spread or estimated), and this module keeps four promises:
 *
 * - **Unknown is not zero.** A bucket with no stored minute draws nothing; one with some minutes missing is outlined and
 *   called a lower bound; cumulative volume stops at the first incomplete bucket instead of carrying on as if it were whole.
 * - **The comparison says what it stands on.** Every ratio carries the number of sessions behind the median, and a baseline
 *   shorter than asked, or ended by a contract roll, is said in words.
 * - **A ratio is of observed numbers, not a forecast.** "Heavier than usual" is a statement about the past.
 * - **Expiry week is flagged.** Volume migrates to the next month before expiry, so lighter-than-usual near expiry may be
 *   migration; the screen says so when the contract is within a week of expiry.
 */

export interface VolumeBucketView {
  from: string;
  to: string;
  startMinute: number;
  endMinute: number;
  /** Null when no bar is stored for any minute of the bucket (unknown, not zero). */
  volume: number | null;
  barsPresent: number;
  expectedBars: number;
  complete: boolean;
  baselineMedian: number | null;
  baselineMean: number | null;
  baselineSessions: number;
  relative: number | null;
  cumulative: number | null;
  baselineCumulativeMedian: number | null;
  baselineCumulativeSessions: number;
  cumulativeRelative: number | null;
}

export interface VolumeByTimeAvailable {
  available: true;
  underlying: string;
  contract: { symbol: string; providerSymbol: string; expiryDate: string; lotSize: number; daysToExpiry: number };
  sessionDate: string;
  inProgress: boolean;
  bucketMinutes: number;
  bucketMinuteChoices: number[];
  baselineDayChoices: number[];
  observed: true;
  volumeUnit: string;
  baseline: {
    requestedSessions: number;
    sessions: number;
    dates: string[];
    stoppedAtRoll: boolean;
    perSession: Array<{ sessionDate: string; total: number | null; complete: boolean }>;
  };
  buckets: VolumeBucketView[];
  day: {
    total: number | null;
    volumeSoFar: number;
    complete: boolean;
    baselineMedianTotal: number | null;
    baselineSessionsWithTotal: number;
    relative: number | null;
  };
  availableSessions: Array<{ sessionDate: string; symbol: string; complete: boolean; firstAt: string; lastAt: string }>;
  definitions: Record<string, string>;
  source: string;
}

export interface VolumeByTimeUnavailable {
  available: false;
  underlying: string;
  sessionDate?: string;
  reason: string;
  availableSessions?: VolumeByTimeAvailable["availableSessions"];
}

export type VolumeByTimePayload = VolumeByTimeAvailable | VolumeByTimeUnavailable;

export function volumeByTimeQuery(input: {
  underlying: string;
  sessionDate: string;
  bucketMinutes: number | null;
  baselineDays: number | null;
}): string {
  const params = new URLSearchParams({ underlying: input.underlying });
  if (input.sessionDate) params.set("date", input.sessionDate);
  if (input.bucketMinutes !== null) params.set("bucket", String(input.bucketMinutes));
  if (input.baselineDays !== null) params.set("days", String(input.baselineDays));
  return params.toString();
}

/** Contracts within this many calendar days of expiry get the migration caution. */
export const EXPIRY_WEEK_DAYS = 7;

/** A step for axis ticks: 1, 2 or 5 times a power of ten that gives about `target` intervals up to `max`. */
export function niceStep(max: number, target = 4): number {
  if (!(max > 0)) return 1;
  const rough = max / target;
  const power = 10 ** Math.floor(Math.log10(rough));
  const fraction = rough / power;
  return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power;
}

/** The top of the axis: the next multiple of the step at or above `max`, and the ticks up to it. */
export function niceAxis(max: number): { top: number; ticks: number[] } {
  const step = niceStep(max);
  const top = Math.max(step, Math.ceil(max / step - 1e-9) * step);
  const ticks: number[] = [];
  for (let value = 0; value <= top + step / 2; value += step) ticks.push(Math.round(value));
  return { top, ticks };
}

/** Volume in lakh/crore-free plain units with Indian grouping, as the other screens print it. */
export function formatUnits(value: number): string {
  return Math.round(value).toLocaleString("en-IN");
}

/** Axis labels: 1.5L style would mix conventions with the units elsewhere, so plain k/M. */
export function formatAxisUnits(value: number): string {
  if (value >= 1e6) return `${+(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${+(value / 1e3).toFixed(1)}k`;
  return String(Math.round(value));
}

export interface DrawnBucket {
  /** Left and right edge as fractions 0-1 of the session clock (09:15 to 15:30). */
  x0: number;
  x1: number;
  /** Bar height as a fraction of the volume axis; 0 for unknown. */
  height: number;
  /** Baseline median as a fraction of the volume axis, or null. */
  baselineHeight: number | null;
  known: boolean;
  complete: boolean;
  relative: number | null;
  index: number;
}

export interface TimeChartGeometry {
  volumeAxis: { top: number; ticks: number[] };
  cumulativeAxis: { top: number; ticks: number[] };
  buckets: DrawnBucket[];
  /**
   * Cumulative lines as runs of points (x fraction of the session, y fraction of the cumulative axis, 0 at the bottom).
   * A run ends where the value is unknown, so a gap in the data is a gap in the line.
   */
  cumulativeToday: Array<Array<{ x: number; y: number }>>;
  cumulativeBaseline: Array<Array<{ x: number; y: number }>>;
}

const SESSION_MINUTES = 375;
const SESSION_OPEN_MINUTE = 9 * 60 + 15;

function runs(points: Array<{ x: number; y: number | null }>): Array<Array<{ x: number; y: number }>> {
  const result: Array<Array<{ x: number; y: number }>> = [];
  let current: Array<{ x: number; y: number }> = [];
  for (const point of points) {
    if (point.y === null) {
      if (current.length > 0) result.push(current);
      current = [];
    } else {
      current.push({ x: point.x, y: point.y });
    }
  }
  if (current.length > 0) result.push(current);
  return result;
}

/** The drawing: bars with their baseline marks, and the two cumulative lines, on shared axes. */
export function buildTimeChart(payload: VolumeByTimeAvailable): TimeChartGeometry {
  const { buckets } = payload;
  const volumeMax = Math.max(1, ...buckets.flatMap((bucket) => [bucket.volume ?? 0, bucket.baselineMedian ?? 0]));
  const cumulativeMax = Math.max(1, ...buckets.flatMap((bucket) => [bucket.cumulative ?? 0, bucket.baselineCumulativeMedian ?? 0]));
  const volumeAxis = niceAxis(volumeMax);
  const cumulativeAxis = niceAxis(cumulativeMax);

  const drawn: DrawnBucket[] = buckets.map((bucket, index) => ({
    x0: (bucket.startMinute - SESSION_OPEN_MINUTE) / SESSION_MINUTES,
    x1: (bucket.endMinute - SESSION_OPEN_MINUTE) / SESSION_MINUTES,
    height: bucket.volume === null ? 0 : bucket.volume / volumeAxis.top,
    baselineHeight: bucket.baselineMedian === null ? null : bucket.baselineMedian / volumeAxis.top,
    known: bucket.volume !== null,
    complete: bucket.complete,
    relative: bucket.relative,
    index,
  }));

  // A cumulative point sits at the end of its bucket, where the volume through it has been reached.
  const at = (bucket: VolumeBucketView) => (bucket.endMinute - SESSION_OPEN_MINUTE) / SESSION_MINUTES;
  return {
    volumeAxis,
    cumulativeAxis,
    buckets: drawn,
    cumulativeToday: runs([
      { x: 0, y: 0 },
      ...buckets.map((bucket) => ({ x: at(bucket), y: bucket.cumulative === null ? null : bucket.cumulative / cumulativeAxis.top })),
    ]),
    cumulativeBaseline: runs([
      { x: 0, y: 0 },
      ...buckets.map((bucket) => ({ x: at(bucket), y: bucket.baselineCumulativeMedian === null ? null : bucket.baselineCumulativeMedian / cumulativeAxis.top })),
    ]),
  };
}

/** The bucket under a horizontal position (fraction of the session clock), or null outside it. */
export function bucketAtFraction(buckets: readonly DrawnBucket[], fraction: number): DrawnBucket | null {
  if (fraction < 0 || fraction >= 1) return null;
  return buckets.find((bucket) => fraction >= bucket.x0 && fraction < bucket.x1) ?? null;
}

function times(ratio: number): string {
  return `${ratio >= 10 ? ratio.toFixed(0) : ratio.toFixed(2)}×`;
}

/** One bucket in a sentence for the hover line: what traded, against what, on how many sessions, and what is not known. */
export function describeBucket(bucket: VolumeBucketView): string {
  const head = `${bucket.from}–${bucket.to}`;
  if (bucket.volume === null) return `${head}: no stored bar for any minute of it (unknown, not zero).`;
  const parts: string[] = [];
  if (!bucket.complete) {
    parts.push(`${head}: at least ${formatUnits(bucket.volume)} units (${bucket.barsPresent} of ${bucket.expectedBars} minutes stored, so a lower bound)`);
  } else {
    parts.push(`${head}: ${formatUnits(bucket.volume)} units`);
  }
  if (bucket.baselineMedian !== null) {
    const sessions = `${bucket.baselineSessions} session${bucket.baselineSessions === 1 ? "" : "s"}`;
    parts.push(
      bucket.relative !== null
        ? `${times(bucket.relative)} the usual (median ${formatUnits(bucket.baselineMedian)} over ${sessions})`
        : `usual ${formatUnits(bucket.baselineMedian)} (median over ${sessions}); no ratio for a bucket that is not complete`,
    );
  } else {
    parts.push("no earlier session to compare with");
  }
  if (bucket.cumulative !== null) {
    parts.push(
      bucket.cumulativeRelative !== null && bucket.baselineCumulativeMedian !== null
        ? `since the open ${formatUnits(bucket.cumulative)} vs ${formatUnits(bucket.baselineCumulativeMedian)} (${times(bucket.cumulativeRelative)}, ${bucket.baselineCumulativeSessions} sessions)`
        : `since the open ${formatUnits(bucket.cumulative)}`,
    );
  }
  return `${parts.join("; ")}.`;
}

export interface TimeNote {
  tone: "info" | "warn";
  text: string;
}

/** What the picture stands on, in words. */
export function volumeByTimeNotes(payload: VolumeByTimeAvailable): TimeNote[] {
  const notes: TimeNote[] = [];
  const { baseline, contract, buckets } = payload;
  if (baseline.sessions === 0) {
    notes.push({ tone: "warn", text: "No earlier session of this contract is stored, so there is nothing to compare today with: only the observed volume is shown." });
  } else if (baseline.sessions < baseline.requestedSessions) {
    notes.push({
      tone: "warn",
      text: baseline.stoppedAtRoll
        ? `The baseline has ${baseline.sessions} of the ${baseline.requestedSessions} sessions asked for: the next older stored session is another contract, and a roll is not crossed.`
        : `The baseline has ${baseline.sessions} of the ${baseline.requestedSessions} sessions asked for; that is all that is stored for this contract.`,
    });
  }
  const incomplete = buckets.filter((bucket) => bucket.volume !== null && !bucket.complete).length;
  const unknown = buckets.filter((bucket) => bucket.volume === null).length;
  if (payload.inProgress && unknown > 0) {
    notes.push({ tone: "info", text: "Session in progress: buckets that have not happened yet are blank and are refetched every minute." });
  } else if (unknown > 0) {
    notes.push({ tone: "warn", text: `${unknown} bucket${unknown === 1 ? " has" : "s have"} no stored bar at all, and ${unknown === 1 ? "is" : "are"} left blank, not drawn as zero. Cumulative volume stops at the first gap.` });
  }
  if (incomplete > 0) {
    notes.push({ tone: "warn", text: `${incomplete} bucket${incomplete === 1 ? " is" : "s are"} missing minutes (outlined): its volume is a lower bound, and it has no ratio.` });
  }
  if (contract.daysToExpiry >= 0 && contract.daysToExpiry <= EXPIRY_WEEK_DAYS) {
    notes.push({
      tone: "info",
      text: `This contract expires in ${contract.daysToExpiry} day${contract.daysToExpiry === 1 ? "" : "s"}. Volume moves to the next month before expiry, so lighter than usual may be migration, not a quieter market.`,
    });
  }
  return notes;
}

/** The whole day against the usual day, or null when there is nothing to say. */
export function dayVolumeSentence(payload: VolumeByTimeAvailable): string | null {
  const { day, baseline } = payload;
  if (day.baselineMedianTotal === null) return null;
  const usual = `${formatUnits(day.baselineMedianTotal)} units (median of ${day.baselineSessionsWithTotal} complete session${day.baselineSessionsWithTotal === 1 ? "" : "s"} of the ${baseline.sessions} compared)`;
  if (day.total !== null && day.relative !== null) return `Whole day ${formatUnits(day.total)} units, ${times(day.relative)} the usual day of ${usual}.`;
  return `So far ${formatUnits(day.volumeSoFar)} units (a lower bound: the day is not complete). The usual whole day is ${usual}.`;
}

/**
 * Types and pure wording rules for the data-coverage view. No React.
 *
 * `/api/v1/data-coverage` reports, for each recent weekday, what is stored from each of the three sources behind the terminal:
 * 1-minute futures bars, option-chain snapshots and depth frames. Counts and times only; this module turns them into labels and
 * sentences and keeps three promises:
 *
 * - **A status is a stated threshold, not a verdict.** The thresholds are printed on the page (the API's definitions).
 * - **A holiday is an inference and is said to be one.** A weekday with no futures bars and no whole collector day is "probable
 *   holiday", never three red failures; the collectors have no holiday calendar and write stray rows on holidays.
 * - **A gap is a gap.** A day the market traded with a source that has nothing is called out by name, with the dates.
 */

export type CoverageStatus = "complete" | "partial" | "none";

export interface FuturesCoverageView {
  symbol: string | null;
  bars: number;
  barsWithVolume: number;
  firstAt: string | null;
  lastAt: string | null;
  status: CoverageStatus;
}

export interface SnapshotCoverageView {
  inSessionMinutes: number;
  preOpenMinutes: number;
  postCloseMinutes: number;
  firstAt: string | null;
  lastAt: string | null;
  typicalMinutes: number | null;
  status: CoverageStatus;
}

export interface DepthCoverageView {
  symbol: string | null;
  framesCapped: number;
  capReached: boolean;
  firstAt: string | null;
  lastAt: string | null;
  status: CoverageStatus;
}

export interface CoverageRowView {
  date: string;
  futures: FuturesCoverageView;
  snapshots: SnapshotCoverageView;
  depth: DepthCoverageView;
  inProgress: boolean;
  probableHoliday: boolean;
  gapInSource: boolean;
}

export interface DataCoverageAvailable {
  underlying: string;
  asOf: string;
  days: number;
  dayChoices: number[];
  rows: CoverageRowView[];
  /** Sources with nothing in the whole window: not collected for this index, or down throughout. */
  sourcesNotCollected: Array<"futures" | "snapshots" | "depth">;
  latest: { futuresBarAt: string | null; snapshotAt: string | null; depthFrameAt: string | null };
  summary: {
    futures: Partial<Record<CoverageStatus, number>>;
    snapshots: Partial<Record<CoverageStatus, number>>;
    depth: Partial<Record<CoverageStatus, number>>;
    probableHolidays: number;
    daysWithAGap: number;
  };
  typicalSnapshotMinutes: number | null;
  definitions: Record<string, string>;
  source: string;
}

export function dataCoverageQuery(input: { underlying: string; days: number | null }): string {
  const params = new URLSearchParams({ underlying: input.underlying });
  if (input.days !== null) params.set("days", String(input.days));
  return params.toString();
}

/** A UTC ISO time as `HH:MM` IST, or an en dash when absent. */
export function istClock(iso: string | null): string {
  if (iso === null) return "–";
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });
}

/** `first–last` IST, or an en dash when either is absent. */
export function istSpan(first: string | null, last: string | null): string {
  return first === null || last === null ? "–" : `${istClock(first)}–${istClock(last)}`;
}

export const STATUS_LABEL: Record<CoverageStatus, string> = { complete: "complete", partial: "partial", none: "none" };

/**
 * How a cell's status is shown. A missing source on a probable holiday, or one that is not collected at all for this index, is
 * neutral: it is not a failure.
 */
export function cellTone(status: CoverageStatus, probableHoliday: boolean, notCollected = false): "good" | "warn" | "bad" | "neutral" {
  if (status === "complete") return "good";
  if (status === "partial") return "warn";
  return probableHoliday || notCollected ? "neutral" : "bad";
}

const SOURCE_LABEL = { futures: "futures bars", snapshots: "chain snapshots", depth: "depth frames" } as const;

/** The depth frame count: a capped count is "at least", never presented as the whole day's. */
export function depthFramesText(depth: DepthCoverageView): string {
  if (depth.framesCapped <= 0) return "0";
  const text = depth.framesCapped.toLocaleString("en-IN");
  return depth.capReached ? `≥ ${text}` : text;
}

/** The snapshot count against the typical day, e.g. `24 of a typical 24`. */
export function snapshotCountText(snapshots: SnapshotCoverageView): string {
  if (snapshots.inSessionMinutes <= 0) return "0";
  return snapshots.typicalMinutes === null
    ? String(snapshots.inSessionMinutes)
    : `${snapshots.inSessionMinutes} of a typical ${Number.isInteger(snapshots.typicalMinutes) ? snapshots.typicalMinutes : snapshots.typicalMinutes.toFixed(1)}`;
}

/** Age of a timestamp as words, against `nowMs`. */
export function ageText(iso: string | null, nowMs: number): string {
  if (iso === null) return "never";
  const seconds = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
  if (seconds < 90) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export interface CoverageNote {
  tone: "info" | "warn";
  text: string;
}

function dayList(rows: readonly CoverageRowView[]): string {
  return rows.map((row) => row.date).join(", ");
}

/** What the table says in words: the gap days by name and what the probable holidays are. */
export function coverageNotes(data: Pick<DataCoverageAvailable, "rows"> & { sourcesNotCollected?: DataCoverageAvailable["sourcesNotCollected"] }): CoverageNote[] {
  const notes: CoverageNote[] = [];
  for (const name of data.sourcesNotCollected ?? []) {
    notes.push({
      tone: "info",
      text: `No ${SOURCE_LABEL[name]} are stored for any day in this window: they are not collected for this index${name === "depth" ? " (the depth collector follows one symbol at a time)" : ""}, or the collector was down throughout. It is shown once here, not as a gap on every day.`,
    });
  }
  const gaps = data.rows.filter((row) => row.gapInSource && !row.inProgress);
  const notCollected = data.sourcesNotCollected ?? [];
  for (const row of gaps) {
    const missing = [
      row.futures.status === "none" && !notCollected.includes("futures") ? "futures bars" : null,
      row.snapshots.status === "none" && !notCollected.includes("snapshots") ? "chain snapshots" : null,
      row.depth.status === "none" && !notCollected.includes("depth") ? "depth frames" : null,
    ].filter((name): name is string => name !== null);
    notes.push({ tone: "warn", text: `${row.date}: no ${missing.join(" and no ")} stored on a day the market traded.` });
  }
  const holidays = data.rows.filter((row) => row.probableHoliday);
  if (holidays.length > 0) {
    notes.push({
      tone: "info",
      text: `${holidays.length === 1 ? "1 weekday is" : `${holidays.length} weekdays are`} a probable exchange holiday (${dayList(holidays)}): no futures bars and no whole collector day. This is an inference; the holiday calendar is not stored here, and the collectors may still have written stray rows.`,
    });
  }
  const sparse = data.rows.filter((row) => !row.gapInSource && !row.probableHoliday && !row.inProgress
    && [row.futures.status, row.snapshots.status, row.depth.status].includes("partial"));
  if (sparse.length > 0) {
    notes.push({ tone: "info", text: `${sparse.length} traded day${sparse.length === 1 ? " has" : "s have"} a partial source (amber): ${dayList(sparse)}.` });
  }
  return notes;
}

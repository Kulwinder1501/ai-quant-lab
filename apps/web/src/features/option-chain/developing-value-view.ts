/**
 * Types and pure drawing and wording rules for developing value. No React.
 *
 * `/api/v1/volume-profile/developing` rebuilds the session's volume profile at each checkpoint (the bars that opened before it).
 * It is the same ESTIMATE as the volume profile, and this module keeps its promises:
 *
 * - **It says "estimated".** On the screen, not only in a footnote.
 * - **A thin checkpoint says so.** The first half hour is a few minutes of bars; its POC and value area are what those minutes
 *   did. Checkpoints with fewer than `THIN_BARS` bars are drawn hollow and named in a note.
 * - **A move inside the resolution is not a move.** The profile cannot place the POC better than about two rows, so a shift of
 *   that size or less between checkpoints is called within the resolution.
 * - **A checkpoint with no new bar is blank**, and cuts the line: a session in progress, or a hole in the stored bars, must
 *   not read as a market that stood still.
 * - **A path is not a forecast.** Where value developed describes the session so far; it is not support or resistance.
 */

export interface DevelopingPointView {
  at: string;
  atMinute: number;
  barsUsed: number;
  expectedBars: number;
  newBars: number;
  totalVolume: number | null;
  poc: number | null;
  vah: number | null;
  val: number | null;
  vwap: number | null;
  lastClose: number | null;
  complete: boolean;
}

export interface DevelopingAvailable {
  available: true;
  underlying: string;
  contract: { symbol: string; providerSymbol: string; expiryDate: string; lotSize: number };
  sessionDate: string;
  inProgress: boolean;
  rowPoints: number;
  rowPointsChoices: number[];
  stepMinutes: number;
  stepChoices: number[];
  estimated: true;
  volumeUnit: string;
  session: { open: number; high: number; low: number; close: number; firstBarAt: string; lastBarAt: string } | null;
  quality: { expectedMinutes: number; barsUsed: number; missingMinutes: number; complete: boolean };
  points: DevelopingPointView[];
  /** `[epochMs, close]` for each regular-session minute. */
  closes: Array<[number, number]>;
  availableSessions: Array<{ sessionDate: string; symbol: string; complete: boolean; firstAt: string; lastAt: string }>;
  definitions: Record<string, string>;
  source: string;
}

export interface DevelopingUnavailable {
  available: false;
  underlying: string;
  sessionDate?: string;
  reason: string;
  availableSessions?: DevelopingAvailable["availableSessions"];
}

export type DevelopingPayload = DevelopingAvailable | DevelopingUnavailable;

export function developingQuery(input: { underlying: string; sessionDate: string; rowPoints: number | null; stepMinutes: number | null }): string {
  const params = new URLSearchParams({ underlying: input.underlying });
  if (input.sessionDate) params.set("date", input.sessionDate);
  if (input.rowPoints !== null) params.set("rowPoints", String(input.rowPoints));
  if (input.stepMinutes !== null) params.set("step", String(input.stepMinutes));
  return params.toString();
}

/** A checkpoint built from fewer bars than this is thin: its levels are what a few minutes did. */
export const THIN_BARS = 30;
/** A shift of this many rows or fewer is within the profile's resolution. */
export const RESOLUTION_ROWS = 2;

const SESSION_OPEN_MINUTE = 9 * 60 + 15;
const SESSION_MINUTES = 375;
const IST_OFFSET_MS = 330 * 60_000;

export interface DrawnCheckpoint {
  index: number;
  /** Fraction 0-1 of the session clock at the checkpoint. */
  x: number;
  /** Fractions 0-1 of the price range, 0 at the top. */
  poc: number;
  vah: number;
  val: number;
  vwap: number | null;
  thin: boolean;
}

export interface DevelopingGeometry {
  priceLow: number;
  priceHigh: number;
  /** Checkpoints that have levels and a new bar; the others are not drawn. */
  checkpoints: DrawnCheckpoint[];
  /** The checkpoints in unbroken runs: a run ends where a checkpoint is blank. */
  runs: DrawnCheckpoint[][];
  closeLine: Array<{ x: number; y: number }>;
}

/** The drawing: the closes, and the POC, value area and VWAP at each checkpoint that has something new to say. */
export function buildDevelopingChart(payload: DevelopingAvailable): DevelopingGeometry {
  const levels = payload.points.flatMap((point) => (point.newBars > 0 ? [point.poc, point.vah, point.val, point.vwap] : []));
  const values = [...payload.closes.map(([, close]) => close), ...levels.filter((level): level is number => level !== null)];
  if (values.length === 0) return { priceLow: 0, priceHigh: 0, checkpoints: [], runs: [], closeLine: [] };
  const low = Math.min(...values);
  const high = Math.max(...values);
  // A little room so the extreme levels do not sit on the frame.
  const pad = Math.max(payload.rowPoints, (high - low) * 0.04);
  const priceLow = low - pad;
  const priceHigh = high + pad;
  const span = priceHigh - priceLow;
  const y = (price: number) => (priceHigh - price) / span;

  const checkpoints: DrawnCheckpoint[] = [];
  const runs: DrawnCheckpoint[][] = [];
  let current: DrawnCheckpoint[] = [];
  payload.points.forEach((point, index) => {
    if (point.newBars === 0 || point.poc === null || point.vah === null || point.val === null) {
      if (current.length > 0) runs.push(current);
      current = [];
      return;
    }
    const drawn: DrawnCheckpoint = {
      index,
      x: (point.atMinute - SESSION_OPEN_MINUTE) / SESSION_MINUTES,
      poc: y(point.poc),
      vah: y(point.vah),
      val: y(point.val),
      vwap: point.vwap === null ? null : y(point.vwap),
      thin: point.barsUsed < THIN_BARS,
    };
    checkpoints.push(drawn);
    current.push(drawn);
  });
  if (current.length > 0) runs.push(current);

  const closeLine = payload.closes.map(([at, close]) => {
    const minuteOfDay = Math.floor((at + IST_OFFSET_MS) / 60_000) % (24 * 60);
    return { x: Math.min(1, Math.max(0, (minuteOfDay - SESSION_OPEN_MINUTE) / SESSION_MINUTES)), y: y(close) };
  });
  return { priceLow, priceHigh, checkpoints, runs, closeLine };
}

/** The checkpoint nearest a horizontal position (fraction of the session clock), or null when none is drawn or it is far from all. */
export function checkpointNearFraction(checkpoints: readonly DrawnCheckpoint[], fraction: number, maxDistance = 0.04): DrawnCheckpoint | null {
  let best: DrawnCheckpoint | null = null;
  for (const checkpoint of checkpoints) {
    if (best === null || Math.abs(checkpoint.x - fraction) < Math.abs(best.x - fraction)) best = checkpoint;
  }
  return best !== null && Math.abs(best.x - fraction) <= maxDistance ? best : null;
}

function plain(value: number): string {
  return value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function signedPoints(points: number): string {
  const rounded = Math.round(points);
  return rounded === 0 ? "unchanged" : `${rounded > 0 ? "+" : "−"}${Math.abs(rounded)} pts`;
}

/** The POC shift from the previous checkpoint that has levels, in points, or null when there is none. */
export function pocShift(points: readonly DevelopingPointView[], index: number): number | null {
  const point = points[index];
  if (!point || point.poc === null) return null;
  for (let before = index - 1; before >= 0; before -= 1) {
    const earlier = points[before]!;
    if (earlier.newBars === 0) return null;     // a gap in the data: the shift across it is not a measured one
    if (earlier.poc !== null) return point.poc - earlier.poc;
  }
  return null;
}

/** One checkpoint in a sentence: the levels, the move since the last checkpoint against the resolution, and what it stands on. */
export function describePoint(points: readonly DevelopingPointView[], index: number, rowPoints: number): string {
  const point = points[index]!;
  if (point.newBars === 0) return `${point.at}: no new bar since the previous checkpoint (${point.barsUsed} of ${point.expectedBars} minutes stored), so nothing new to show.`;
  if (point.poc === null || point.vah === null || point.val === null) return `${point.at}: nothing had traded by then (estimated profile unavailable).`;
  const shift = pocShift(points, index);
  const resolution = RESOLUTION_ROWS * rowPoints;
  const move = shift === null
    ? ""
    : Math.abs(shift) <= resolution
      ? `, POC ${signedPoints(shift)} since the previous checkpoint (within the ~${resolution} pt resolution)`
      : `, POC ${signedPoints(shift)} since the previous checkpoint (beyond the ~${resolution} pt resolution)`;
  const standing = `${point.barsUsed} bar${point.barsUsed === 1 ? "" : "s"}${point.totalVolume === null ? "" : `, ${Math.round(point.totalVolume).toLocaleString("en-IN")} units`}`;
  const caveats = [
    point.barsUsed < THIN_BARS ? "thin: few minutes of bars" : null,
    point.complete ? null : `${point.expectedBars - point.barsUsed} minute${point.expectedBars - point.barsUsed === 1 ? "" : "s"} missing`,
  ].filter((entry): entry is string => entry !== null);
  return `${point.at}: POC ${plain(point.poc)}${move}; value area ${plain(point.val)}–${plain(point.vah)}`
    + `${point.vwap === null ? "" : `, VWAP ${plain(point.vwap)}`}; estimated from ${standing}${caveats.length > 0 ? ` (${caveats.join("; ")})` : ""}.`;
}

export interface DevelopingNote {
  tone: "info" | "warn";
  text: string;
}

/** What the picture stands on, in words. */
export function developingNotes(payload: DevelopingAvailable): DevelopingNote[] {
  const notes: DevelopingNote[] = [];
  const drawn = payload.points.filter((point) => point.newBars > 0 && point.poc !== null);
  const thin = drawn.filter((point) => point.barsUsed < THIN_BARS);
  if (thin.length > 0) {
    notes.push({
      tone: "info",
      text: `${thin.length === 1 ? "The first checkpoint is" : `The first ${thin.length} checkpoints are`} thin (hollow, under ${THIN_BARS} bars): they show what those few minutes did, not where the day's volume will sit.`,
    });
  }
  if (payload.inProgress) {
    notes.push({ tone: "info", text: "Session in progress: later checkpoints are blank until their bars arrive, and the page refetches every minute." });
  } else {
    const blank = payload.points.filter((point) => point.newBars === 0).length;
    if (blank > 0) {
      notes.push({ tone: "warn", text: `${blank} checkpoint${blank === 1 ? " has" : "s have"} no new bar since the one before and ${blank === 1 ? "is" : "are"} left blank: the stored bars have a hole or end early.` });
    }
  }
  if (!payload.quality.complete && !payload.inProgress) {
    notes.push({ tone: "warn", text: `Partial session: ${payload.quality.barsUsed} of ${payload.quality.expectedMinutes} regular minutes are stored.` });
  }
  return notes;
}

/** Rows for the table under the chart: the levels at each checkpoint with the POC shift. Blank checkpoints are listed as such. */
export interface DevelopingRow {
  at: string;
  poc: number | null;
  valueArea: string | null;
  vwap: number | null;
  close: number | null;
  shift: number | null;
  withinResolution: boolean | null;
  barsUsed: number;
  thin: boolean;
  blank: boolean;
}

export function developingRows(payload: DevelopingAvailable): DevelopingRow[] {
  const resolution = RESOLUTION_ROWS * payload.rowPoints;
  return payload.points.map((point, index) => {
    const blank = point.newBars === 0 || point.poc === null;
    const shift = blank ? null : pocShift(payload.points, index);
    return {
      at: point.at,
      poc: blank ? null : point.poc,
      valueArea: blank || point.val === null || point.vah === null ? null : `${plain(point.val)}–${plain(point.vah)}`,
      vwap: blank ? null : point.vwap,
      close: blank ? null : point.lastClose,
      shift,
      withinResolution: shift === null ? null : Math.abs(shift) <= resolution,
      barsUsed: point.barsUsed,
      thin: point.barsUsed < THIN_BARS,
      blank,
    };
  });
}

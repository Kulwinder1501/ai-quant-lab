/**
 * Types and pure drawing and wording rules for the volume profile. No React.
 *
 * The API (`/api/v1/volume-profile`) builds an ESTIMATED profile from 1-minute futures bars: each bar's volume is spread
 * evenly over its high-low range, so where inside a minute the volume traded is assumed, not observed. This module turns
 * that into coordinates and sentences, and keeps four promises:
 *
 * - **It says "estimated".** The word is on the screen wherever the profile is, not only in a footnote.
 * - **The resolution check is shown, not buried.** The same session rebuilt from 5-minute bars tells how far the POC and
 *   the value-area edges move; a level that moves a lot is called not well resolved, in words.
 * - **A partial or patchy session says so.** Missing minutes, zero-volume minutes and set-aside post-close bars are counted
 *   beside the picture.
 * - **A profile is not a forecast.** A POC or value-area edge describes where volume was estimated to trade; the text does
 *   not call any of them support, resistance or a target.
 */

export interface ProfileRowView {
  low: number;
  high: number;
  volume: number;
  inValueArea: boolean;
  isPoc: boolean;
}

export interface ProfileLevels {
  poc: number;
  vah: number;
  val: number;
}

export interface SensitivityView {
  comparedWithBarMinutes: number;
  agreement: number;
  pocShiftPoints: number;
  vahShiftPoints: number;
  valShiftPoints: number;
}

export interface QualityView {
  expectedMinutes: number;
  barsUsed: number;
  barsWithVolume: number;
  zeroVolumeBars: number;
  missingMinutes: number;
  outsideSessionBarsExcluded: number;
  complete: boolean;
}

export interface PreviousSessionView extends ProfileLevels {
  sessionDate: string;
  symbol: string;
  high: number;
  low: number;
  close: number;
  totalVolume: number;
  complete: boolean;
}

export interface ProfileSessionListing {
  sessionDate: string;
  symbol: string;
  bars: number;
  barsWithVolume: number;
  firstAt: string;
  lastAt: string;
  complete: boolean;
}

export interface RangeView {
  fromMinute: number;
  toMinute: number;
  fromLabel: string;
  toLabel: string;
  /** The window is the whole 09:15-15:30 session. */
  isFullSession: boolean;
  stepMinutes: number;
  minMinutes: number;
  /** The window's own open, high, low, close and first/last bar. */
  summary: { open: number; high: number; low: number; close: number; firstBarAt: string; lastBarAt: string } | null;
}

export interface VolumeProfileAvailable {
  available: true;
  underlying: string;
  contract: { symbol: string; providerSymbol: string; expiryDate: string; lotSize: number };
  sessionDate: string;
  inProgress: boolean;
  rowPoints: number;
  rowPointsChoices: number[];
  estimated: true;
  volumeUnit: string;
  session: { open: number; high: number; low: number; close: number; firstBarAt: string; lastBarAt: string } | null;
  range: RangeView;
  profile: ProfileLevels & {
    rowPoints: number;
    rows: ProfileRowView[];
    totalVolume: number;
    valueAreaShare: number;
    vwap: number | null;
  };
  quality: QualityView;
  sensitivity: SensitivityView | null;
  previousSession: PreviousSessionView | null;
  /** `[epochMs, close]` for each regular-session minute. */
  closes: Array<[number, number]>;
  availableSessions: ProfileSessionListing[];
  definitions: Record<string, string>;
  source: string;
}

export interface VolumeProfileUnavailable {
  available: false;
  underlying: string;
  sessionDate?: string;
  frontMonth?: string;
  reason: string;
  availableSessions?: ProfileSessionListing[];
}

export type VolumeProfilePayload = VolumeProfileAvailable | VolumeProfileUnavailable;

export function volumeProfileQuery(input: {
  underlying: string;
  sessionDate: string;
  rowPoints: number | null;
  /** `HH:MM` IST edges of a window of the session; empty is the session's own edge. */
  from?: string;
  to?: string;
}): string {
  const params = new URLSearchParams({ underlying: input.underlying });
  if (input.sessionDate) params.set("date", input.sessionDate);
  if (input.rowPoints !== null) params.set("rowPoints", String(input.rowPoints));
  if (input.from) params.set("from", input.from);
  if (input.to) params.set("to", input.to);
  return params.toString();
}

const SESSION_OPEN_MINUTE = 9 * 60 + 15;
const SESSION_CLOSE_MINUTE = 15 * 60 + 30;
/** Edges offered in the window drop-downs: every quarter hour from the open to the close, all on 5-minute marks. */
export const RANGE_EDGE_STEP_MINUTES = 15;
const MIN_WINDOW_MINUTES = 15;

export function clockLabel(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

/** Every offered edge, 09:15, 09:30 ... 15:30, as `HH:MM`. */
export const RANGE_EDGES: readonly string[] = Array.from(
  { length: Math.floor((SESSION_CLOSE_MINUTE - SESSION_OPEN_MINUTE) / RANGE_EDGE_STEP_MINUTES) + 1 },
  (_, index) => clockLabel(SESSION_OPEN_MINUTE + index * RANGE_EDGE_STEP_MINUTES),
);

function edgeMinute(label: string): number {
  const [hours, minutes] = label.split(":").map(Number);
  return hours! * 60 + minutes!;
}

/**
 * Whether an edge may be chosen given the other: a window must be at least 15 minutes long. `""` (the session's own
 * edge) is always allowed as a value, but the edge it stands for is checked too.
 */
export function edgeAllowed(side: "from" | "to", edge: string, other: string): boolean {
  const minute = edgeMinute(edge);
  if (side === "from") {
    const to = other ? edgeMinute(other) : SESSION_CLOSE_MINUTE;
    return minute <= to - MIN_WINDOW_MINUTES;
  }
  const from = other ? edgeMinute(other) : SESSION_OPEN_MINUTE;
  return minute >= from + MIN_WINDOW_MINUTES;
}

export interface RangePreset {
  label: string;
  from: string;
  to: string;
}

/** Common windows. An empty edge is the session's own. */
export const RANGE_PRESETS: readonly RangePreset[] = [
  { label: "Whole session", from: "", to: "" },
  { label: "First hour", from: "", to: "10:15" },
  { label: "Morning", from: "", to: "12:00" },
  { label: "Afternoon", from: "12:00", to: "" },
  { label: "Last hour", from: "14:30", to: "" },
];

/** The window as a phrase for the page: "the whole session" or "09:15–10:15 IST". */
export function describeRange(range: RangeView): string {
  return range.isFullSession ? "the whole session" : `${range.fromLabel}–${range.toLabel} IST`;
}

export interface DrawnRow {
  /** Top edge and height as fractions of the price range (0 at the top). */
  y: number;
  height: number;
  /** Bar length as a fraction of the largest row, 0-1. */
  width: number;
  volume: number;
  share: number;
  low: number;
  high: number;
  inValueArea: boolean;
  isPoc: boolean;
}

export interface ProfileGeometry {
  /** The price span of the drawing: the profile's rows from lowest bottom edge to highest top edge. */
  priceLow: number;
  priceHigh: number;
  rows: DrawnRow[];
  /** The closes as a line: x is the fraction of the 09:15-15:30 session, y the fraction of the price range. */
  closeLine: Array<{ x: number; y: number }>;
  /** The window on the session clock, as fractions 0-1. Spans the whole session unless a window was chosen. */
  rangeX: { from: number; to: number };
}

const SESSION_START_MINUTE_IST = 9 * 60 + 15;
const SESSION_MINUTES = 375;
const IST_OFFSET_MS = 330 * 60_000;

/** The price span and the rows' bars, and the closes as a line over the session clock. Empty when there are no rows. */
export function buildProfileGeometry(payload: VolumeProfileAvailable): ProfileGeometry {
  const rows = payload.profile.rows;
  const rangeX = {
    from: (payload.range.fromMinute - SESSION_START_MINUTE_IST) / SESSION_MINUTES,
    to: (payload.range.toMinute - SESSION_START_MINUTE_IST) / SESSION_MINUTES,
  };
  if (rows.length === 0) return { priceLow: 0, priceHigh: 0, rows: [], closeLine: [], rangeX };
  const priceLow = rows[0]!.low;
  const priceHigh = rows[rows.length - 1]!.high;
  const span = priceHigh - priceLow;
  const largest = Math.max(...rows.map((row) => row.volume));
  const total = payload.profile.totalVolume;

  const drawn: DrawnRow[] = rows.map((row) => ({
    y: (priceHigh - row.high) / span,
    height: (row.high - row.low) / span,
    width: largest > 0 ? row.volume / largest : 0,
    volume: row.volume,
    share: total > 0 ? row.volume / total : 0,
    low: row.low,
    high: row.high,
    inValueArea: row.inValueArea,
    isPoc: row.isPoc,
  }));

  const closeLine = payload.closes.map(([at, close]) => {
    const minuteOfDay = Math.floor((at + IST_OFFSET_MS) / 60_000) % (24 * 60);
    return {
      x: Math.min(1, Math.max(0, (minuteOfDay - SESSION_START_MINUTE_IST) / SESSION_MINUTES)),
      y: (priceHigh - close) / span,
    };
  });
  return { priceLow, priceHigh, rows: drawn, closeLine, rangeX };
}

/** Vertical position (fraction of the range, 0 at the top) of a price, or null when it falls outside the drawing. */
export function priceFraction(geometry: Pick<ProfileGeometry, "priceLow" | "priceHigh">, price: number): number | null {
  const span = geometry.priceHigh - geometry.priceLow;
  if (!(span > 0) || price < geometry.priceLow || price > geometry.priceHigh) return null;
  return (geometry.priceHigh - price) / span;
}

/** The row under a vertical position (fraction of the range, 0 at the top), or null outside it. */
export function rowAtFraction(rows: readonly DrawnRow[], fraction: number): DrawnRow | null {
  if (fraction < 0 || fraction >= 1) return null;
  return rows.find((row) => fraction >= row.y && fraction < row.y + row.height) ?? null;
}

function units(value: number): string {
  return Math.round(value).toLocaleString("en-IN");
}

export function describeRow(row: DrawnRow, isFullSession = true): string {
  const tags = [row.isPoc ? "point of control" : null, row.inValueArea ? "inside the value area" : null].filter(Boolean);
  return `${row.low}–${row.high}: ${units(row.volume)} units, ${(row.share * 100).toFixed(1)}% of ${isFullSession ? "the session" : "the window"} (estimated)`
    + `${tags.length > 0 ? `, ${tags.join(", ")}` : ""}.`;
}

export interface ResolutionNote {
  text: string;
  /** `warn` when the levels move a lot between bar sizes. */
  tone: "ok" | "warn";
}

function signed(points: number): string {
  const rounded = Math.round(points);
  return rounded === 0 ? "does not move" : `moves ${rounded > 0 ? "+" : "−"}${Math.abs(rounded)} pts`;
}

/**
 * How well the data resolves the levels: the session rebuilt from coarser bars, in words. A level that moves by more than
 * two rows between bar sizes (or a profile that agrees on under 80% of the volume) is called not well resolved.
 */
export function describeResolution(sensitivity: SensitivityView | null, rowPoints: number): ResolutionNote | null {
  if (sensitivity === null) return null;
  const limit = 2 * rowPoints;
  const loose = [
    Math.abs(sensitivity.pocShiftPoints) > limit ? "POC" : null,
    Math.abs(sensitivity.vahShiftPoints) > limit ? "VAH" : null,
    Math.abs(sensitivity.valShiftPoints) > limit ? "VAL" : null,
  ].filter((name): name is string => name !== null);
  const text = `Rebuilt from ${sensitivity.comparedWithBarMinutes}-minute bars, ${(sensitivity.agreement * 100).toFixed(0)}% of the volume lands in the same rows; `
    + `the POC ${signed(sensitivity.pocShiftPoints)}, VAH ${signed(sensitivity.vahShiftPoints)}, VAL ${signed(sensitivity.valShiftPoints)}.`
    + `${loose.length > 0 ? ` ${loose.join(" and ")} ${loose.length > 1 ? "are" : "is"} not well resolved by 1-minute bars: read ${loose.length > 1 ? "them" : "it"} as a zone, not a price.` : ""}`;
  return { text, tone: loose.length > 0 || sensitivity.agreement < 0.8 ? "warn" : "ok" };
}

export interface ProfileNote {
  tone: "info" | "warn";
  text: string;
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });
}

/** What the picture stands on, in words. Quiet for a clean, complete session. */
export function qualityNotes(payload: VolumeProfileAvailable): ProfileNote[] {
  const { quality, range } = payload;
  const session = range.summary;
  const notes: ProfileNote[] = [];
  const whole = range.isFullSession;
  if (!quality.complete) {
    notes.push({
      tone: "warn",
      text: `${whole ? "Partial session" : `Partial window (${range.fromLabel}–${range.toLabel} IST)`}: ${quality.barsUsed} of ${quality.expectedMinutes} ${whole ? "regular " : ""}minutes are stored`
        + `${session ? ` (last bar ${clock(session.lastBarAt)} IST)` : ""}. The profile covers only those minutes`
        + `${payload.inProgress ? " and will change as the session continues" : ""}.`,
    });
  } else if (quality.missingMinutes > 0) {
    notes.push({
      tone: "info",
      text: quality.missingMinutes === 1
        ? `1 ${whole ? "regular " : ""}minute has no bar and adds nothing to the profile.`
        : `${quality.missingMinutes} ${whole ? "regular " : ""}minutes have no bar and add nothing to the profile.`,
    });
  }
  if (quality.zeroVolumeBars > 0) {
    notes.push({
      tone: "info",
      text: quality.zeroVolumeBars === 1
        ? "1 minute traded nothing (flat, zero volume) and adds nothing."
        : `${quality.zeroVolumeBars} minutes traded nothing (flat, zero volume) and add nothing.`,
    });
  }
  if (quality.outsideSessionBarsExcluded > 0) {
    notes.push({ tone: "info", text: `${quality.outsideSessionBarsExcluded} bars outside 09:15–15:30 IST (the post-close minutes) were set aside.` });
  }
  return notes;
}

/** The previous session's levels as a sentence, or null. Says whether that day was complete. */
export function previousSessionSentence(previous: PreviousSessionView | null, windowChosen = false): string | null {
  if (previous === null) return null;
  return `Previous session ${previous.sessionDate} (${previous.symbol.replace(/FUT$/, " future")}): POC ${previous.poc.toLocaleString("en-IN")}, `
    + `value area ${previous.val.toLocaleString("en-IN")}–${previous.vah.toLocaleString("en-IN")}, `
    + `range ${previous.low.toLocaleString("en-IN")}–${previous.high.toLocaleString("en-IN")}`
    + `${previous.complete ? "" : " (partial day)"}. Same row height; also estimated.`
    + `${windowChosen ? " These are the whole previous session, not the chosen window." : ""}`;
}

export function profileSessionLabel(session: ProfileSessionListing): string {
  return `${session.sessionDate} · ${clock(session.firstAt)}–${clock(session.lastAt)} IST${session.complete ? "" : " · partial"}`;
}
